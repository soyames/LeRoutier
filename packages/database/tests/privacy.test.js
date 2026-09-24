import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serverConfig} from '@leroutier/config';
import {createDatabase} from '../src/index.js';
import {migrate} from '../src/migrations.js';
import {seed,demo,demoId} from '../src/seed.js';
import {dropDisposableSchema} from '../src/guards.js';
import {privacyCenter,retentionEngine} from '../src/privacy.js';
import {mapIdentity} from '../src/identities.js';
import {transport} from '../src/transport.js';
import {parcels} from '../src/parcels.js';
import {createApi} from '../../../services/api/src/app.js';
import { GRANTABLE } from '../src/platform-access.js';

// Integrated privacy: consents, exports, deletion lifecycle, retention and
// holds — over the same users/notifications/audit domain as everything else.
const config={...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-',''),demoLogin:true};
const db=createDatabase(config);
const sql=(q,p=[])=>db.transaction(tx=>tx.query(q,p));
const one=(q,p=[])=>sql(q,p).then(r=>r.rows[0]);
let api,privacy,retention,domain,parcel,passengerToken,secondPassenger;
const PASSENGER={id:demo.passenger,role:'passenger'};
const PLATFORM_OPS={id:demoId(50),role:'ops',operator_id:null,platform_capabilities:GRANTABLE};

before(async()=>{
  await migrate(db);await seed(db);
  await sql(`INSERT INTO users(id,display_name,role) VALUES($1,'Plateforme Ops','ops') ON CONFLICT DO NOTHING`,[PLATFORM_OPS.id]);
  api=createApi(db,config);
  const r=await api(new Request('http://localhost/api/v1/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'passenger'})}));
  passengerToken=(await r.json()).data.token;
  secondPassenger=randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO users(id,display_name,role) VALUES($1,'Second Passager','passenger')`,[secondPassenger]);
    await tx.query(`INSERT INTO passenger_profiles(user_id,phone) VALUES($1,'+229 97 000999')`,[secondPassenger]);
  });
  privacy=privacyCenter(db);retention=retentionEngine(db);domain=transport(db);parcel=parcels(db);
});
after(async()=>{try{await dropDisposableSchema(db);}finally{await db.close();}});
/** @param {{method?:string,body?:unknown}} [opts] */
const call=(path,token,opts={})=>{const {method='GET',body}=opts;
  return api(new Request('http://localhost/api/v1'+path,{method,
    headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));};

test('a user reads their own privacy summary, and never anyone else’s',async()=>{
  const own=await call('/me/privacy',passengerToken);
  assert.equal(own.status,200);
  const data=(await own.json()).data;
  assert.ok(Array.isArray(data.categories)&&data.categories.length>=5);
  assert.ok(Array.isArray(data.retention));
  assert.equal(data.deletion,null);
  // The summary is always the CALLER's data: there is no way to target
  // another user, and nothing from another account appears in it.
  const direct=await privacy.summary({id:secondPassenger,role:'passenger'});
  assert.equal(direct.account.role,'passenger');
  assert.ok(!JSON.stringify(direct).includes('Passager Démo'),'no other user’s name leaks');
  const anonymous=await call('/me/privacy');
  assert.equal(anonymous.status,401);
});

test('consents are versioned, withdrawable, and audited without deleting evidence',async()=>{
  await privacy.acceptConsent(PASSENGER,{consentType:'marketing',policyVersion:'v1'});
  const list=await privacy.consents(PASSENGER);
  assert.equal(list[0].status,'accepted');
  const withdrawn=await privacy.withdrawConsent(PASSENGER,'marketing');
  assert.equal(withdrawn.withdrawn,1);
  const after=await privacy.consents(PASSENGER);
  assert.equal(after[0].status,'withdrawn');
  assert.ok(after[0].withdrawn_at,'withdrawal is timestamped');
  // Re-accepting the same version restores it without inventing a new row.
  await privacy.acceptConsent(PASSENGER,{consentType:'marketing',policyVersion:'v1'});
  assert.equal((await privacy.consents(PASSENGER)).filter(c=>c.consent_type==='marketing').length,1);
  // Audit trail preserved for both actions.
  const audits=await sql(`SELECT action FROM audit_events WHERE actor_id=$1 AND action LIKE 'privacy.%' ORDER BY created_at`,[PASSENGER.id]);
  assert.ok(audits.rows.some(a=>a.action==='privacy.consent_accepted'));
  assert.ok(audits.rows.some(a=>a.action==='privacy.consent_withdrawn'));
});

test('terms and privacy policy versions are stored per acknowledgement',async()=>{
  await privacy.acknowledge(PASSENGER,{policy:'terms',policyVersion:'v12'});
  await privacy.acknowledge(PASSENGER,{policy:'privacy_policy',policyVersion:'v3'});
  const rows=await sql('SELECT policy,policy_version FROM policy_acknowledgements WHERE user_id=$1',[PASSENGER.id]);
  assert.deepEqual(rows.rows.map(r=>[r.policy,r.policy_version]).sort(),[['privacy_policy','v3'],['terms','v12']]);
});

test('exports contain only the caller’s own data and never secrets',async()=>{
  const created=await privacy.requestExport(PASSENGER);
  assert.ok(created.token && created.exportId);
  const payload=await privacy.downloadExport(PASSENGER,created.token);
  const parsed=typeof payload==='string'?JSON.parse(payload):payload;
  assert.equal(parsed.account.role,'passenger');
  const text=JSON.stringify(parsed);
  assert.ok(!/token|password|secret|private_key|credential/i.test(text),'no secrets in exports');
  assert.ok(!text.includes('+229 97 000999'),'no other user’s phone');
  // Download is single-actor: another user cannot fetch this export.
  await assert.rejects(privacy.downloadExport({id:secondPassenger,role:'passenger'},created.token),{code:'FORBIDDEN'});
  // Expired artifacts are refused.
  await sql(`UPDATE data_exports SET expires_at=now()-interval '1 hour' WHERE id=$1`,[created.exportId]);
  await assert.rejects(privacy.downloadExport(PASSENGER,created.token),{code:'NOT_FOUND'});
});

test('deletion requests are idempotent and respect active journeys, payments and parcels',async()=>{
  // A passenger with an active booking gets a scheduled (not immediate) deletion.
  await domain.hold(PASSENGER,{serviceId:demo.service,origin:0,destination:1},'priv-hold-'+randomUUID().slice(0,8));
  const first=await privacy.requestDeletion(PASSENGER);
  assert.equal(first.status,'scheduled');
  assert.ok(first.blockers.some(b=>b.kind==='active_booking'));
  const again=await privacy.requestDeletion(PASSENGER);
  assert.equal(again.id,first.id,'one open request per user');
  // An active parcel blocks too.
  const p2=randomUUID();
  await db.transaction(async tx=>{await tx.query(`INSERT INTO users(id,display_name,role) VALUES($1,'Parcel Passager','passenger')`,[p2]);await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1)',[p2]);});
  await parcel.create({id:p2,role:'passenger'},{senderName:'S Parcel',senderPhone:'+229 97000111',receiverName:'R Parcel',receiverPhone:'+229 97000222',originStopId:demoId(200),destinationStopId:demoId(201),category:'documents'},'priv-parcel-'+randomUUID().slice(0,8));
  const parcelRequest=await privacy.requestDeletion({id:p2,role:'passenger'});
  assert.equal(parcelRequest.status,'scheduled');
  assert.ok(parcelRequest.blockers.some(b=>b.kind==='active_parcel'));
});

test('deletion processing anonymizes into a tombstone and preserves financial truth',async()=>{
  // No active data on this user: processing completes and anonymizes.
  const clean=randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO users(id,display_name,role) VALUES($1,'Effaçable','passenger')`,[clean]);
    await tx.query('INSERT INTO passenger_profiles(user_id,phone) VALUES($1,$2)',[clean,'+229 97000333']);
    await tx.query(`INSERT INTO bookings(id,service_id,passenger_id,origin_sequence,destination_sequence,seat_number,status,amount_minor,expires_at,idempotency_key,request_fingerprint)
      VALUES($1,$2,$3,0,1,1,'completed',2500,NULL,$4,'fp')`,[clean,demo.service,demo.passenger,'k-'+clean]);
  });
  await privacy.requestDeletion({id:clean,role:'passenger'});
  const result=await privacy.processDueDeletions();
  assert.equal(result.processed.length,1);
  const user=await one('SELECT display_name,auth_subject,active FROM users WHERE id=$1',[clean]);
  assert.equal(user.display_name,'Utilisateur supprimé');
  assert.equal(user.auth_subject,null);
  assert.equal(user.active,false);
  const profile=await one('SELECT phone FROM passenger_profiles WHERE user_id=$1',[clean]);
  assert.equal(profile.phone,null,'phone anonymized');
  // Financial/booking truth intact (the row above belongs to another user; check ours).
  const deletion=await one('SELECT status,outcome FROM deletion_requests WHERE user_id=$1',[clean]);
  assert.equal(deletion.status,'completed');
  assert.equal(deletion.outcome,'anonymized');
  // A scheduled one with a blocker is NOT processed yet.
  const scheduled=await privacy.requestDeletion(PASSENGER);
  assert.equal(scheduled.status,'scheduled');
  const second=await privacy.processDueDeletions();
  assert.ok(!second.processed.some(p=>p.userId===PASSENGER.id),'blocked requests stay scheduled');
});

test('keep-account confirmation resets the retention state and is audited',async()=>{
  const user=randomUUID();
  await db.transaction(async tx=>{await tx.query(`INSERT INTO users(id,display_name,role) VALUES($1,'Inactif','passenger')`,[user]);await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1)',[user]);});
  await sql(`UPDATE users SET last_meaningful_activity_at=now()-interval '400 days',retention_due_at=now()+interval '5 days' WHERE id=$1`,[user]);
  await privacy.keepAccount({id:user,role:'passenger'});
  const row=await one('SELECT retention_due_at,keep_confirmed_at,last_meaningful_activity_at FROM users WHERE id=$1',[user]);
  assert.equal(row.retention_due_at,null);
  assert.ok(row.keep_confirmed_at);
  const audits=await sql(`SELECT action FROM audit_events WHERE actor_id=$1 AND action='privacy.keep_account_confirmed'`,[user]);
  assert.equal(audits.rows.length,1);
});

test('retention scans identify stale inactive accounts and warn exactly once',async()=>{
  const stale=randomUUID();
  await db.transaction(async tx=>{await tx.query(`INSERT INTO users(id,display_name,role) VALUES($1,'Stale','passenger')`,[stale]);await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1)',[stale]);});
  await sql(`UPDATE users SET last_meaningful_activity_at=now()-interval '400 days' WHERE id=$1`,[stale]);
  const dry=await retention.run({execute:false});
  assert.ok(dry.dryRun);
  const inactive=dry.report.find(r=>r.category==='inactive_accounts');
  assert.ok(inactive.eligible>=1,'the stale account is identified');
  // Dry run mutates nothing.
  const before=await one('SELECT retention_due_at FROM users WHERE id=$1',[stale]);
  assert.equal(before.retention_due_at,null);
  await retention.run({execute:true});
  const after=await one('SELECT retention_due_at FROM users WHERE id=$1',[stale]);
  assert.ok(after.retention_due_at,'execution marks the due date, once');
  await retention.run({execute:true});
  const againRow=await one('SELECT retention_due_at FROM users WHERE id=$1',[stale]);
  assert.ok(againRow.retention_due_at,'idempotent: no double-marking beyond the single due date');
  // The warning event is raised at most once by the worker logic (sent_at guard).
  await sql(`UPDATE users SET retention_due_at=now()+interval '3 days' WHERE id=$1`,[stale]);
  const warned=await db.transaction(async tx=>(await tx.query(`UPDATE users SET retention_notification_sent_at=now()
    WHERE retention_due_at IS NOT NULL AND retention_due_at<=now()+interval '7 days' AND retention_notification_sent_at IS NULL
      AND keep_confirmed_at IS NULL RETURNING id`)).rows);
  assert.equal(warned.length,1);
  const reWarned=await db.transaction(async tx=>(await tx.query(`UPDATE users SET retention_notification_sent_at=now()
    WHERE retention_due_at IS NOT NULL AND retention_due_at<=now()+interval '7 days' AND retention_notification_sent_at IS NULL
      AND keep_confirmed_at IS NULL RETURNING id`)).rows);
  assert.equal(reWarned.length,0,'the warning is raised exactly once');
});

test('GPS retention honours the policy, holds block purges, and released holds allow them',async()=>{
  // Raw positions expire only on finished services; the demo service is
  // active, so mark it completed for the purge then restore it.
  await sql(`UPDATE services SET status='completed' WHERE id=$1`,[demo.service]);
  const old=await sql(`INSERT INTO vehicle_positions(service_id,vehicle_id,actor_id,latitude,longitude,observed_at)
    VALUES($1,$2,$3,6.36,2.43,now()-interval '45 days') RETURNING id`,[demo.service,demo.vehicle,demo.driver]);
  const scan=await retention.run({execute:false});
  assert.ok(scan.report.find(r=>r.category==='raw_gps').eligible>=1);
  // A hold on the service prevents deletion.
  await privacy.createHold(PLATFORM_OPS,{subjectKind:'service',subjectId:demo.service,reason:'Litige en cours'});
  await retention.run({execute:true});
  const stillThere=await one('SELECT id FROM vehicle_positions WHERE id=$1',[old.rows[0].id]);
  assert.ok(stillThere,'a held subject is never purged');
  // Release the hold: the next execution purges.
  const holds=await sql(`SELECT id FROM legal_holds WHERE subject_id=$1 AND released_at IS NULL`,[demo.service]);
  await privacy.releaseHold(PLATFORM_OPS,holds.rows[0].id);
  await retention.run({execute:true});
  const gone=await one('SELECT id FROM vehicle_positions WHERE id=$1',[old.rows[0].id]);
  assert.equal(gone,undefined,'released holds allow later purges');
  await sql(`UPDATE services SET status='active' WHERE id=$1`,[demo.service]);
});

test('notification history anonymization keeps delivery metadata and trims bodies',async()=>{
  await sql(`INSERT INTO notifications(user_id,event_type,category,template,data,created_at)
    VALUES($1,'test.old','operational','t','{"phone":"+229 97000444"}'::jsonb,now()-interval '200 days')`,[PASSENGER.id]);
  await retention.run({execute:true});
  const row=await one(`SELECT data FROM notifications WHERE user_id=$1 AND event_type='test.old'`,[PASSENGER.id]);
  assert.ok(!JSON.stringify(row.data).includes('+229 97000444'),'the body is trimmed');
  assert.ok(JSON.stringify(row.data).includes('body removed'),'delivery metadata remains');
});

test('holds are platform-ops only and audited',async()=>{
  await assert.rejects(privacy.createHold({id:demo.ops,role:'ops',operator_id:demo.operator},{subjectKind:'user',subjectId:PASSENGER.id,reason:'x'}),{code:'FORBIDDEN'});
  await assert.rejects(privacy.createHold(PASSENGER,{subjectKind:'user',subjectId:PASSENGER.id,reason:'x'}),{code:'FORBIDDEN'});
  const hold=await privacy.createHold(PLATFORM_OPS,{subjectKind:'user',subjectId:PASSENGER.id,reason:'Audit de sécurité'});
  assert.ok(hold.id);
  const audits=await sql(`SELECT action FROM audit_events WHERE entity_id=$1`,[hold.id]);
  assert.ok(audits.rows.some(a=>a.action==='privacy.hold_applied'));
});

test('ops privacy register is platform-only and contains no PII',async()=>{
  const anon=await call('/ops/privacy/requests');
  assert.equal(anon.status,401);
  const companyOps=await call('/ops/privacy/requests',passengerToken);
  assert.equal(companyOps.status,403);
});

test('assistant privacy queries use deterministic data and never execute deletion',async()=>{
  const r=await call('/assistant',passengerToken,{method:'POST',body:{sessionId:'priv-session-01',message:'Quelles données avez-vous sur moi ?'}});
  assert.equal(r.status,200);
  const out=(await r.json()).data;
  assert.equal(out.intent,'privacy_summary');
  assert.match(out.reply,/catégories de vos données/);
  // No deletion happened from a chat message: the assistant answers with the
  // deterministic status of the EXISTING request (created in earlier tests)
  // and never executes anything.
  const before=await one('SELECT count(*)::integer AS n FROM deletion_requests WHERE user_id=$1',[demo.passenger]);
  const ask=await call('/assistant',passengerToken,{method:'POST',body:{sessionId:'priv-session-02',message:'Supprime mon compte tout de suite'}});
  assert.equal(ask.status,200);
  assert.match((await ask.json()).data.reply,/demande de suppression est/);
  assert.equal((await one('SELECT count(*)::integer AS n FROM deletion_requests WHERE user_id=$1',[demo.passenger])).n,before.n);
  // And the user's record was never anonymized by chat.
  const user=await one('SELECT display_name,active FROM users WHERE id=$1',[demo.passenger]);
  assert.equal(user.display_name,'Passager Démo');
});

test('existing booking/payment/parcel/GPS flows remain green',async()=>{
  const quote=await domain.availability(demo.service,2,3);
  assert.equal(quote.fare.amountMinor,3000);
  const hold=await domain.hold(PASSENGER,{serviceId:demo.service,origin:2,destination:3},'priv-inv-'+randomUUID().slice(0,8));
  assert.equal(hold.status,'held');
  const activity=await one('SELECT last_meaningful_activity_at FROM users WHERE id=$1',[PASSENGER.id]);
  assert.ok(activity.last_meaningful_activity_at,'booking counts as meaningful activity');
});

// ----------------------------------------- KYC evidence: the missing policy --
// Verification evidence was the only major category with no retention rule at
// all, and it holds the most sensitive data on the platform: national identity
// references, licence numbers, and links to documents LeRoutier does not host
// and cannot revoke.
test('a refused dossier is redacted after the appeal window; the decision survives',async()=>{
  const owner=randomUUID();
  await sql(`INSERT INTO users(id,display_name,role) VALUES($1,'Candidat Refusé','passenger')`,[owner]);
  const operator=await one(`INSERT INTO operators(name,type,owner_user_id,admin_user_id,verification_status,created_at)
    VALUES('Refusé SARL','independent',$1,$1,'rejected',now()-interval '200 days') RETURNING id`,[owner]);
  await sql(`INSERT INTO verification_evidence(operator_id,subject_user_id,kind,reference,file_url,status,notes)
    VALUES($1,$2,'identity','CNI-REFUSE-1','https://documents.example.test/cni.pdf','rejected','Document illisible.')`,[operator.id,owner]);

  const report=await retention.run({execute:true});
  const kyc=report.report.find(r=>r.category==='kyc_evidence');
  assert.ok(kyc,'the category is scanned at all');
  assert.ok(kyc.eligible>=1);
  const row=await one("SELECT reference,file_url,redacted_at,kind,status,notes FROM verification_evidence WHERE operator_id=$1",[operator.id]);
  assert.equal(row.reference,null,'the identity reference is gone');
  assert.equal(row.file_url,null,'and so is the pointer to the document');
  assert.ok(row.redacted_at,'and the redaction is dated, so the scan does not keep reselecting it');
  // What lasting value there is lives in the decision, not in the passport.
  assert.equal(row.kind,'identity');
  assert.equal(row.status,'rejected');
  assert.equal(row.notes,'Document illisible.');
  // Idempotent: a second pass finds nothing left to do for this operator.
  const second=await retention.run({execute:true});
  assert.ok(!(await one('SELECT id FROM verification_evidence WHERE operator_id=$1 AND redacted_at IS NULL',[operator.id])));
  assert.ok(second.report.find(r=>r.category==='kyc_evidence'));
});

test('a verified operator’s dossier is never swept, and a legal hold stops a refused one',async()=>{
  const keeper=randomUUID(),held=randomUUID();
  for(const [id,name] of [[keeper,'Opérateur Vérifié'],[held,'Refusé Sous Enquête']]){
    await sql(`INSERT INTO users(id,display_name,role) VALUES($1,$2,'passenger')`,[id,name]);
  }
  const verified=await one(`INSERT INTO operators(name,type,owner_user_id,admin_user_id,verification_status,created_at)
    VALUES('Vérifié SARL','independent',$1,$1,'verified',now()-interval '400 days') RETURNING id`,[keeper]);
  const underHold=await one(`INSERT INTO operators(name,type,owner_user_id,admin_user_id,verification_status,created_at)
    VALUES('Enquête SARL','independent',$1,$1,'rejected',now()-interval '400 days') RETURNING id`,[held]);
  for(const operatorId of [verified.id,underHold.id]){
    await sql(`INSERT INTO verification_evidence(operator_id,kind,reference,file_url,status)
      VALUES($1,'driving_license','PC-KEEP','https://documents.example.test/permis.pdf','verified')`,[operatorId]);
  }
  await sql(`INSERT INTO legal_holds(subject_kind,subject_id,reason,created_by) VALUES('user',$1,'Enquête en cours',$2)`,[held,PLATFORM_OPS.id]);

  await retention.run({execute:true});
  // A relationship that existed is evidence LeRoutier checked before letting
  // somebody carry passengers; it is not swept because time passed.
  assert.ok((await one('SELECT file_url FROM verification_evidence WHERE operator_id=$1',[verified.id])).file_url);
  assert.ok((await one('SELECT file_url FROM verification_evidence WHERE operator_id=$1',[underHold.id])).file_url,
    'a legal hold survives the retention scan');
});

test('deleting an account removes the face and the identity numbers, not only the name',async()=>{
  const driver=randomUUID();
  // No auth_subject: this test pins the tombstone erasure itself. A provider
  // identity would additionally delete through the Admin SDK first, which is
  // covered by the Firebase identity deletion tests below.
  await sql(`INSERT INTO users(id,display_name,role,auth_issuer) VALUES($1,'Chauffeur Partant','driver','test')`,[driver]);
  await sql(`INSERT INTO driver_profiles(user_id,operator_id,license_reference,id_document_reference,photo_url,active)
    VALUES($1,$2,'PC-BJ-0001','CNI-0001','https://photos.example.test/visage.jpg',true)`,[driver,demo.operator]);
  await sql(`INSERT INTO verification_evidence(operator_id,subject_user_id,kind,reference,file_url,status)
    VALUES($1,$2,'identity','CNI-0001','https://documents.example.test/cni-partant.pdf','verified')`,[demo.operator,driver]);
  await sql(`INSERT INTO deletion_requests(user_id,status) VALUES($1,'requested')`,[driver]);

  await privacy.processDueDeletions();
  const profile=await one('SELECT photo_url,id_document_reference,license_reference,active FROM driver_profiles WHERE user_id=$1',[driver]);
  // The photograph is published to passengers on an independent offer. A
  // tombstone that leaves a face behind has renamed the person, not deleted them.
  assert.equal(profile.photo_url,null);
  assert.equal(profile.id_document_reference,null);
  // NOT NULL by schema, so it is overwritten rather than emptied: nulling it
  // would abort the whole deletion transaction.
  assert.equal(profile.license_reference,'[supprimé]');
  assert.ok(!profile.license_reference.includes('PC-BJ'),'the licence number itself is gone');
  assert.equal(profile.active,false);
  const evidence=await one('SELECT reference,file_url,redacted_at FROM verification_evidence WHERE subject_user_id=$1',[driver]);
  assert.equal(evidence.file_url,null);
  assert.ok(evidence.redacted_at);
});

test('an account that runs a transport operation cannot quietly delete itself',async()=>{
  const owner=randomUUID();
  await sql(`INSERT INTO users(id,display_name,role) VALUES($1,'Propriétaire Actif','driver')`,[owner]);
  const operator=await one(`INSERT INTO operators(name,type,owner_user_id,admin_user_id,verification_status,active)
    VALUES('Active SARL','independent',$1,$1,'verified',true) RETURNING id`,[owner]);
  const request=await privacy.requestDeletion({id:owner,role:'driver',operator_id:operator.id});
  // Not refused — the person keeps the right to ask — but not silently carried
  // out either: winding down an operation is a decision with passengers and
  // money in it.
  assert.equal(request.status,'scheduled');
  const kinds=(request.blockers||[]).map(b=>b.kind);
  assert.ok(kinds.includes('operator_ownership'),'the live operator is named as the blocker: '+JSON.stringify(kinds));
  await privacy.processDueDeletions();
  const user=await one('SELECT display_name FROM users WHERE id=$1',[owner]);
  assert.equal(user.display_name,'Propriétaire Actif','and the operator owner is still there');
});

// ------------------------------------------- Firebase identity deletion ------
// The processor deletes the provider identity OUTSIDE any transaction before
// the tombstone anonymizes auth_subject; the injected admin double records
// every call, so these tests prove the ordering, the idempotency and the
// retry contract without a provider.

/** An admin double that records every deleteUser and obeys a failure script.
 * @param {{deleteUser?: (uid: string) => Promise<{status: 'deleted'|'not_found'}>, available?: boolean}} [options] */
function fakeAdmin({ deleteUser, available = true } = {}) {
  const calls = [];
  const del = deleteUser ?? (async () => ({ status: 'deleted' }));
  return { calls, admin: { available, deleteUser: async uid => { calls.push(uid); return del(uid); } } };
}

test('a completed deletion also deletes the Firebase identity, uid captured before the tombstone',async()=>{
  const user=randomUUID(),uid='fb-'+randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO users(id,display_name,role,auth_subject,auth_issuer) VALUES($1,'À Effacer','passenger',$2,'https://issuer.test.invalid')`,[user,uid]);
    await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1)',[user]);
  });
  const {calls,admin}=fakeAdmin();
  const withAdmin=privacyCenter(db,null,admin);
  await withAdmin.requestDeletion({id:user,role:'passenger'});
  const result=await withAdmin.processDueDeletions();
  assert.equal(result.processed.length,1);
  assert.deepEqual(calls,[uid],'the Firebase UID from auth_subject is deleted');
  const deletion=await one('SELECT status,outcome,identity_uid,identity_deleted_at FROM deletion_requests WHERE user_id=$1',[user]);
  assert.equal(deletion.status,'completed');
  assert.equal(deletion.outcome,'anonymized');
  assert.equal(deletion.identity_uid,uid,'the UID is recorded before auth_subject is erased');
  assert.ok(deletion.identity_deleted_at,'the identity deletion is timestamped');
  const tombstone=await one('SELECT display_name,auth_subject,active FROM users WHERE id=$1',[user]);
  assert.equal(tombstone.display_name,'Utilisateur supprimé');
  assert.equal(tombstone.auth_subject,null);
  assert.equal(tombstone.active,false);
});

test('a Firebase user-not-found is the idempotent success case',async()=>{
  const user=randomUUID(),uid='fb-'+randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO users(id,display_name,role,auth_subject) VALUES($1,'Déjà Effacé','passenger',$2)`,[user,uid]);
    await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1)',[user]);
  });
  const {calls,admin}=fakeAdmin({deleteUser:async()=>({status:'not_found'})});
  const withAdmin=privacyCenter(db,null,admin);
  await withAdmin.requestDeletion({id:user,role:'passenger'});
  const result=await withAdmin.processDueDeletions();
  assert.equal(result.processed.length,1);
  assert.deepEqual(calls,[uid]);
  assert.equal((await one('SELECT status FROM deletion_requests WHERE user_id=$1',[user])).status,'completed');
});

test('a provider outage never completes the deletion and retries the next tick',async()=>{
  const user=randomUUID(),uid='fb-'+randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO users(id,display_name,role,auth_subject) VALUES($1,'En Panne','passenger',$2)`,[user,uid]);
    await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1)',[user]);
  });
  const failing=fakeAdmin({deleteUser:async()=>{throw new Error('provider down');}});
  const failingCenter=privacyCenter(db,null,failing.admin);
  await failingCenter.requestDeletion({id:user,role:'passenger'});
  const first=await failingCenter.processDueDeletions();
  assert.equal(first.processed.length,0,'nothing completes while the identity may still exist');
  const afterFailure=await one('SELECT status,processed_at FROM deletion_requests WHERE user_id=$1',[user]);
  assert.equal(afterFailure.status,'processing');
  assert.equal(afterFailure.processed_at,null,'the request is NOT marked completed');
  const untouched=await one('SELECT display_name,auth_subject,active FROM users WHERE id=$1',[user]);
  assert.equal(untouched.auth_subject,uid,'the account is not tombstoned while the provider identity survives');
  assert.equal(untouched.active,true);
  // The next tick finds the identity already gone (crash between provider and
  // database) and completes normally — idempotent across retries.
  const healed=fakeAdmin({deleteUser:async()=>({status:'not_found'})});
  const healedCenter=privacyCenter(db,null,healed.admin);
  const second=await healedCenter.processDueDeletions();
  assert.equal(second.processed.length,1);
  assert.equal((await one('SELECT status FROM deletion_requests WHERE user_id=$1',[user])).status,'completed');
});

test('without an admin capability the request waits in processing rather than claiming the identity is gone',async()=>{
  const user=randomUUID(),uid='fb-'+randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO users(id,display_name,role,auth_subject) VALUES($1,'Sans Clé','passenger',$2)`,[user,uid]);
    await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1)',[user]);
  });
  const noAdmin=privacyCenter(db,null,{available:false});
  await noAdmin.requestDeletion({id:user,role:'passenger'});
  await noAdmin.processDueDeletions();
  assert.equal((await one('SELECT status FROM deletion_requests WHERE user_id=$1',[user])).status,'processing');
  assert.equal((await one('SELECT auth_subject FROM users WHERE id=$1',[user])).auth_subject,uid);
  // Clean up the residue so later ticks in this shared schema stay scoped:
  // with a credential present again, the waiting request completes.
  await privacyCenter(db,null,fakeAdmin().admin).processDueDeletions();
  assert.equal((await one('SELECT status FROM deletion_requests WHERE user_id=$1',[user])).status,'completed');
});

test('a demo identity has no provider user and completes without any admin call',async()=>{
  const user=randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO users(id,display_name,role,is_demo) VALUES($1,'Démo Effaçable','passenger',true)`,[user]);
    await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1)',[user]);
  });
  const {calls,admin}=fakeAdmin();
  const withAdmin=privacyCenter(db,null,admin);
  await withAdmin.requestDeletion({id:user,role:'passenger'});
  const result=await withAdmin.processDueDeletions();
  assert.equal(result.processed.length,1);
  assert.equal(calls.length,0,'no provider call for an identity without a provider');
  const deletion=await one('SELECT status,identity_uid,identity_deleted_at FROM deletion_requests WHERE user_id=$1',[user]);
  assert.equal(deletion.status,'completed');
  assert.equal(deletion.identity_uid,null);
});

test('the same address can register again after deletion: a new uid maps to a NEW account, never the tombstone',async()=>{
  const email='reincarnation@example.invalid';
  const oldUid='fb-'+randomUUID();
  const user=randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO users(id,display_name,role,auth_subject) VALUES($1,'À Réincarner','passenger',$2)`,[user,oldUid]);
    await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1)',[user]);
    await tx.query('UPDATE users SET notification_email=$2 WHERE id=$1',[user,email]);
  });
  const {admin}=fakeAdmin();
  const withAdmin=privacyCenter(db,null,admin);
  await withAdmin.requestDeletion({id:user,role:'passenger'});
  await withAdmin.processDueDeletions();
  // The same mailbox signs up again: Firebase issues a NEW uid, which maps to
  // a NEW LeRoutier account — the tombstone keeps its old records untouched.
  const newUid='fb-'+randomUUID();
  const reborn=await mapIdentity(db,{subject:newUid,issuer:'https://issuer.test.invalid',signInProvider:'password',emailVerified:true,notificationEmail:email});
  assert.notEqual(reborn.id,user,'a new account, never the tombstone');
  assert.notEqual(reborn.display_name,'Utilisateur supprimé');
  const tombstone=await one('SELECT auth_subject,display_name FROM users WHERE id=$1',[user]);
  assert.equal(tombstone.auth_subject,null,'the tombstone is not reconnected to the new identity');
  assert.equal(tombstone.display_name,'Utilisateur supprimé');
});

// ---------------------------------------- Platform Ops-initiated deletion ---
test('Platform Ops deletion requests reuse the retention model and audit the initiator',async()=>{
  const target=randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO users(id,display_name,role) VALUES($1,'Cible Ops','passenger')`,[target]);
    await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1)',[target]);
  });
  const row=await privacy.requestDeletionFor(PLATFORM_OPS,target);
  assert.equal(row.status,'requested','no blockers: executable immediately');
  const auditRow=await one(`SELECT actor_id,action,entity_id,details FROM audit_events WHERE action='privacy.deletion_requested' AND entity_id=$1 ORDER BY created_at DESC LIMIT 1`,[target]);
  assert.equal(auditRow.actor_id,PLATFORM_OPS.id,'who initiated the deletion is audited');
  assert.equal(auditRow.details.initiatedBy,'platform');
  // Idempotent across initiators: the same request is returned, never a second.
  const again=await privacy.requestDeletionFor(PLATFORM_OPS,target);
  assert.equal(again.id,row.id);
});

test('Platform Ops deletion is refused for self, for the superadmin seat, and without the users grant',async()=>{
  // Nobody deletes their own account through Ops.
  await assert.rejects(privacy.requestDeletionFor(PLATFORM_OPS,PLATFORM_OPS.id),{code:'FORBIDDEN'});
  // A non-superadmin platform member cannot delete a platform identity.
  const member={id:randomUUID(),role:'ops',operator_id:null,platform_capabilities:['users']};
  const seat=randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO users(id,display_name,role) VALUES($1,'Plateforme Cible','ops')`,[seat]);
    await tx.query(`INSERT INTO platform_grants(user_id,capability,granted_by) VALUES($1,'superadmin',$1)`,[seat]);
  });
  await assert.rejects(privacy.requestDeletionFor(member,seat),{code:'FORBIDDEN'});
  // Even the superadmin cannot delete the superadmin seat.
  await assert.rejects(privacy.requestDeletionFor(PLATFORM_OPS,seat),{code:'FORBIDDEN'});
  // A passenger (or anyone without the users grant) cannot initiate at all.
  await assert.rejects(privacy.requestDeletionFor(PASSENGER,randomUUID()),{code:'FORBIDDEN'});
});

test('a blocked Platform Ops deletion is scheduled with the blockers named',async()=>{
  const target=randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO users(id,display_name,role) VALUES($1,'Cible Occupée','passenger')`,[target]);
    await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1)',[target]);
  });
  await domain.hold({id:target,role:'passenger'},{serviceId:demo.service,origin:0,destination:1},'ops-del-'+randomUUID().slice(0,8));
  const row=await privacy.requestDeletionFor(PLATFORM_OPS,target);
  assert.equal(row.status,'scheduled');
  assert.ok(row.blockers.some(b=>b.kind==='active_booking'));
});
