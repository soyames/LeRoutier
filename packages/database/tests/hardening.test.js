import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo, demoId } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { transport } from '../src/transport.js';
import { payments } from '../src/payments.js';
import { earnings, payouts } from '../src/payouts.js';
import { recovery } from '../src/recovery.js';
import { parcels } from '../src/parcels.js';
import { bootstrap, authenticate, createActions, createWorkflowEngine } from '@leroutier/agents';
import { createApi } from '../../../services/api/src/app.js';
import { GRANTABLE } from '../src/platform-access.js';

const config={...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-',''),demoLogin:true};
const db=createDatabase(config),domain=transport(db);
const passenger={id:demo.passenger,role:'passenger'},driver={id:demo.driver,role:'driver'},ops={id:demo.ops,role:'ops',operator_id:demo.operator};
const pay=payments(db),payout=payouts(db,null,{payoutApprovalRequired:true}),earn=earnings(db),parcel=parcels(db);
const actions=createActions({db,domain,payments:pay,payouts:payout,recovery:recovery(db),parcels:parcel});
const engine=createWorkflowEngine({db,actions});
let api,sessions,platformToken,hardeningAgent;
const one=async(sql,args=[])=>(await db.transaction(async tx=>(await tx.query(sql,args)).rows[0]));
async function call(path,method='GET',body=undefined,role='passenger',key=randomUUID()){
  const r=await api(new Request('http://localhost/api/v1'+path,{method,headers:{authorization:'Bearer '+sessions[role],'content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return {status:r.status,...await r.json()};
}
before(async()=>{
  await migrate(db);await seed(db);
  api=createApi(db,config);
  sessions={};
  for(const role of ['passenger','driver','ops']){const r=await api(new Request('http://localhost/api/v1/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role})}));sessions[role]=(await r.json()).data.token;}
  platformToken='lragt_'+randomBytes(32).toString('base64url');
  hardeningAgent=await bootstrap(db,{name:'hardening-agent',token:platformToken,scopes:['payment.reconcile','parcel.read','parcel.manage','parcel.notify','alert.create','service.read','incident.read']});
});
beforeEach(async()=>{
  await db.transaction(async tx=>{await tx.query('DELETE FROM booking_segments');await tx.query("UPDATE bookings SET status='cancelled'");
    await tx.query('DELETE FROM payment_events');await tx.query('DELETE FROM payments');await tx.query('DELETE FROM payout_events');await tx.query('DELETE FROM driver_earnings');
    await tx.query('DELETE FROM payout_requests');await tx.query('DELETE FROM payout_destinations');await tx.query('DELETE FROM parcel_proof_of_delivery');
    await tx.query('DELETE FROM parcel_pickup_codes');await tx.query('DELETE FROM parcel_exceptions');await tx.query('DELETE FROM parcel_payments');
    await tx.query('DELETE FROM parcel_custody');await tx.query('DELETE FROM parcel_service_assignments');await tx.query('DELETE FROM parcel_events');
    await tx.query('DELETE FROM parcel_labels');await tx.query('DELETE FROM parcel_parties');await tx.query('DELETE FROM parcels');
    await tx.query('DELETE FROM agent_action_receipts');await tx.query('DELETE FROM workflow_approvals');await tx.query('DELETE FROM workflow_runs');
    await tx.query('DELETE FROM outbox');
    await tx.query("UPDATE services SET current_sequence=0,status='active'");await tx.query('UPDATE users SET active=true');
    await tx.query('DELETE FROM parcel_rate_rules');await tx.query('INSERT INTO parcel_rate_rules(operator_id,base_minor,per_kg_minor,declared_value_bp) VALUES($1,1000,500,0)',[demo.operator]);});
});
after(async()=>{try{await dropDisposableSchema(db);}finally{await db.close();}});
const agentRequest=(agentToken,path,method='GET',body=undefined)=>
  new Request('http://localhost/api/v1'+path,{method,headers:{'content-type':'application/json',authorization:'Bearer '+agentToken},...(body===undefined?{}:{body:JSON.stringify(body)})});

test('payout privilege escalation is rejected for drivers and passengers',async()=>{
  await earn.credit({driverId:demo.driver,source:'fixture',reference:'h1',grossMinor:5000});
  const destination=await payout.addDestination(driver,{country:'BJ',phoneNumber:'61234567'});
  const request=await payout.request(driver,{destinationId:destination.id,amountMinor:3000},randomUUID());
  await assert.rejects(payout.approve(driver,request.id),{code:'FORBIDDEN'});
  await assert.rejects(payout.approve(passenger,request.id),{code:'FORBIDDEN'});
  await assert.rejects(payout.list(passenger),{code:'FORBIDDEN'});
  await assert.rejects(payout.reconcile(passenger,request.id),{code:'FORBIDDEN'});
  assert.equal((await earn.summary(driver)).reserved,3000,'nothing was executed');
  const viaApi=await call(`/ops/payouts/${request.id}/approve`,'POST',{},'driver');
  assert.equal(viaApi.status,403);
});

test('workflow approvals cannot be bypassed or decided by non-Ops actors',async()=>{
  const run=await engine.runAction(hardeningAgent,'payment.reconcile',{paymentId:randomUUID()});
  const platformOps={...ops,operator_id:null,platform_capabilities:GRANTABLE};
  const approval=(await engine.listApprovals(platformOps))[0];
  assert.ok(approval);
  await assert.rejects(engine.approve(driver,approval.id,'approved'),{code:'FORBIDDEN'});
  await assert.rejects(engine.approve(passenger,approval.id,'approved'),{code:'FORBIDDEN'});
  await assert.rejects(engine.retry(driver,run.workflowRunId),{code:'FORBIDDEN'});
  const stillPending=(await engine.listApprovals(platformOps)).find(a=>a.id===approval.id);
  assert.equal(stillPending.status,'pending','approval remains untouched');
});

test('disabled principals and users lose access immediately',async()=>{
  await db.transaction(async tx=>tx.query('UPDATE agent_principals SET active=false WHERE name=$1',['hardening-agent']));
  assert.equal(await authenticate(db,new Request('http://localhost',{headers:{authorization:'Bearer '+platformToken}})),null);
  const r=await api(agentRequest(platformToken,'/agent/me'));
  assert.equal(r.status,401);
  await db.transaction(async tx=>tx.query('UPDATE agent_principals SET active=true WHERE name=$1',['hardening-agent']));
  await db.transaction(async tx=>tx.query('UPDATE users SET active=false WHERE id=$1',[demo.passenger]));
  const me=await call('/me');
  assert.equal(me.status,403);
  assert.equal(me.error.code,'ACCOUNT_DISABLED');
});

test('incident resolution and service status changes are audited',async()=>{
  const incident=await call('/incidents','POST',{serviceId:demo.service,kind:'breakdown',severity:'high',description:'Hardening audit probe'},'driver');
  await call(`/incidents/${incident.data.id}`,'PATCH',{status:'investigating'},'ops');
  const incidentAudit=await one("SELECT * FROM audit_events WHERE action='incident.status_changed' AND entity_id=$1",[incident.data.id]);
  assert.ok(incidentAudit);
  await call(`/services/${demo.service}/status`,'POST',{status:'disrupted'},'ops');
  const statusAudit=await one("SELECT * FROM audit_events WHERE action='service.status_changed' AND entity_id=$1",[demo.service]);
  assert.ok(statusAudit);
  assert.equal(statusAudit.details.to,'disrupted');
  await call(`/services/${demo.service}/status`,'POST',{status:'active'},'ops');
});

test('ops diagnostics require Ops auth and return machine-readable counts',async()=>{
  const denied=await call('/ops/diagnostics','GET',undefined,'passenger');
  assert.equal(denied.status,403);
  const r=await call('/ops/diagnostics','GET',undefined,'ops');
  assert.equal(r.status,200);
  const d=r.data;
  for(const key of ['database','fedapay','payments','payouts','incidents','services','workflows','parcels'])assert.ok(key in d,key);
  assert.equal(d.database,'ok');
  assert.ok(Array.isArray(d.workflows.failedRuns));
  assert.equal(typeof d.parcels.uncollected,'number');
});

test('payout anomalies surface an Ops alert through the workflow',async()=>{
  await db.transaction(async tx=>tx.query("INSERT INTO outbox(event_type,aggregate_id,payload) VALUES('payout.anomaly',$1,$2)",[randomUUID(),JSON.stringify({payoutRequestId:randomUUID()})]));
  await engine.processOutbox();
  const alert=await one("SELECT * FROM outbox WHERE event_type='alert.created' AND payload->>'kind'='payout'");
  assert.ok(alert,'payout anomaly raised an alert');
});

test('parcel exceptions notify the receiver and raise an Ops alert',async()=>{
  const p=await parcel.create(passenger,{senderName:'Awa Sender',senderPhone:'+229 61000001',receiverName:'Kofi Receiver',receiverPhone:'+229 61000002',originStopId:demoId(200),destinationStopId:demoId(201),category:'documents'},randomUUID());
  await parcel.accept(ops,p.id);
  await parcel.assign(ops,p.id,{serviceId:demo.service});
  await parcel.scan(driver,p.id,{kind:'loaded'},randomUUID());
  await parcel.exception(driver,p.id,{kind:'damaged',description:'Carton écrasé.'});
  await engine.processOutbox();
  const notified=await one("SELECT * FROM outbox WHERE event_type='notification.send' AND payload->>'kind'='parcel'");
  assert.ok(notified,'receiver notification queued');
  const alert=await one("SELECT * FROM outbox WHERE event_type='alert.created' AND payload->>'kind'='parcel'");
  assert.ok(alert,'parcel exception raised an alert');
});

test('delay detection notifies affected passengers through the outbox',async()=>{
  await domain.hold(passenger,{serviceId:demo.service,origin:0,destination:1},randomUUID());
  await db.transaction(async tx=>tx.query(`INSERT INTO incidents(service_id,reported_by,kind,severity,description) VALUES($1,$2,'delay','medium','Hardening delay')`,[demo.service,demo.driver]));
  await db.transaction(async tx=>tx.query("INSERT INTO outbox(event_type,aggregate_id,payload) VALUES('service.position',$1,$2)",[demo.service,JSON.stringify({serviceId:demo.service,observedAt:new Date().toISOString()})]));
  await engine.processOutbox();
  const notified=await one("SELECT * FROM outbox WHERE event_type='notification.send' AND payload->>'template'='service_delayed'");
  assert.ok(notified,'passengers on the delayed service were notified');
});
