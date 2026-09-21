import { invariant, uuid, idempotencyKey } from '@leroutier/domain';
import { audit, activeIdentity } from './identities.js';

const one=(tx,sql,args=[])=>(tx.query(sql,args)).then(r=>r.rows[0]);
const optionalRef=(value,max=200)=>{
  if(value===undefined||value===null||value==='')return null;
  const text=String(value).trim();
  invariant(text.length>=2&&text.length<=max,'INVALID_ONBOARDING','Reference is invalid.');
  return text;
};
// Hosts that are never a legitimate place to keep a carte grise, and are the
// usual target when somebody wants another person's browser to reach an
// internal service.
const BLOCKED_HOSTS=['localhost','metadata','metadata.google.internal','instance-data'];
const BLOCKED_SUFFIXES=['.localhost','.local','.internal','.intranet','.home.arpa','.lan'];
/**
 * Validate an operator-supplied document or photo reference.
 *
 * LeRoutier never fetches these URLs server-side, so this is not an SSRF
 * sandbox — it protects the party that DOES load them: a Platform Ops
 * reviewer opening a proof, and every passenger's browser rendering a
 * verified driver's photo. Accordingly it accepts only a plain,
 * credential-free, port-free https URL on a real named host.
 *
 * `https://` alone is not enough: `https://user:token@…`, `https://10.0.0.5/`,
 * `https://169.254.169.254/latest/meta-data/` and `https://2130706433/` all
 * satisfy "must use HTTPS" and none of them is a document.
 */
const httpsUrl=(value,required=false)=>{
  if(value===undefined||value===null||value===''){invariant(!required,'INVALID_ONBOARDING','A secure document link is required.');return null;}
  const text=String(value).trim();
  invariant(text.length<=2000,'INVALID_ONBOARDING','Document URL is too long.');
  let parsed;try{parsed=new URL(text);}catch{invariant(false,'INVALID_ONBOARDING','Document URL is invalid.');}
  const refuse=()=>invariant(false,'INVALID_ONBOARDING','Document URL must be a public HTTPS address, without credentials or an internal host.');
  // https only: this is also what excludes javascript:, data:, blob: and file:.
  if(parsed.protocol!=='https:')refuse();
  // Embedded credentials become a leaked secret the moment the link is
  // rendered, copied or logged.
  if(parsed.username||parsed.password)refuse();
  // An explicit port on a document link is either a mistake or a service that
  // is not a document host.
  if(parsed.port)refuse();
  const host=parsed.hostname.toLowerCase();
  if(!host||host.length>253)refuse();
  // IPv6 literals ([::1], [fd00::1], …) are never a document host.
  if(host.startsWith('[')||host.includes(':'))refuse();
  if(BLOCKED_HOSTS.includes(host))refuse();
  if(BLOCKED_SUFFIXES.some(suffix=>host.endsWith(suffix)))refuse();
  // Any IP literal is refused, not merely the private ranges: a real document
  // host has a name, and refusing the whole shape removes every decimal,
  // octal and hexadecimal encoding trick at once.
  if(/^\d{1,3}(\.\d{1,3}){3}$/.test(host))refuse();
  // A dotted name with at least one label separator. This also rejects bare
  // numbers (https://2130706433/) and single labels (https://intranet/).
  if(!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host))refuse();
  if(/^\d+$/.test(host.replaceAll('.','')))refuse();
  return parsed.toString();
};
const addEvidence=(tx,operatorId,kind,{reference=null,fileUrl=null,subjectUserId=null,vehicleId=null}={})=>
  tx.query(`INSERT INTO verification_evidence(operator_id,subject_user_id,vehicle_id,kind,reference,file_url)
    VALUES($1,$2,$3,$4,$5,$6)`,[operatorId,subjectUserId,vehicleId,kind,reference,fileUrl]);
export const requiredEvidence=type=>type==='company'
  ? ['company_registration','tax_registration','legal_representative_identity','transport_authorization','registered_address']
  : ['identity','driving_license','vehicle_registration','insurance','roadworthiness','transport_authorization','driver_photo'];

export function onboarding(db){
  async function eligible(tx,actor){
    const user=await activeIdentity(tx,actor.id);
    invariant(user.role==='passenger'&&!user.is_demo,'FORBIDDEN','This account already has an operational role.',403);
    invariant(!user.needs_profile,'PROFILE_REQUIRED','Complete your passenger profile first.',409);
    return user;
  }
  async function operatorView(tx,actor){return (await one(tx,'SELECT * FROM operators WHERE id=$1',[actor.operator_id??null]))??null;}
  return {
    async state(actor){return db.transaction(async tx=>{
      const user=await activeIdentity(tx,actor.id),operator=await operatorView(tx,user);
      const membership=operator?{operatorId:operator.id,operatorName:operator.name,operatorType:operator.type,
        verificationStatus:operator.verification_status,payoutReady:operator.payout_ready,role:user.role,
        isOwner:operator.owner_user_id===user.id,isAdmin:operator.admin_user_id===user.id}:null;
      return {role:user.role,displayName:user.display_name,needsProfile:user.needs_profile,membership};
    });},

    // Company KYB is attached to the legal operator. Company-employed drivers
    // are provisioned under that verified company and are not asked by
    // LeRoutier to submit a personal ID as a condition of company activation.
    async startCompany(actor,input,key){
      invariant(actor?.role==='passenger','FORBIDDEN','Passenger access required.',403);idempotencyKey(key);
      const allowed=['displayName','legalName','contactPhone','country','registrationRef','registrationDocumentUrl','taxReference','taxDocumentUrl',
        'representativeName','representativeIdReference','representativeIdDocumentUrl','transportAuthorizationReference','transportAuthorizationDocumentUrl',
        'registeredAddress','addressProofUrl'];
      invariant(input&&Object.keys(input).every(k=>allowed.includes(k)),'INVALID_ONBOARDING','Unexpected onboarding fields.');
      invariant(typeof input.displayName==='string'&&input.displayName.trim().length>=2&&input.displayName.length<=200,'INVALID_ONBOARDING','A company display name is required.');
      invariant(typeof input.legalName==='string'&&input.legalName.trim().length>=2&&input.legalName.length<=200,'INVALID_ONBOARDING','The legal company name is required.');
      invariant(typeof input.contactPhone==='string'&&/^\+?[0-9 ()-]{6,25}$/.test(input.contactPhone),'INVALID_ONBOARDING','A valid contact phone is required.');
      invariant(typeof input.country==='string'&&/^[a-z]{2}$/i.test(input.country),'INVALID_ONBOARDING','Country is invalid.');
      invariant(typeof input.representativeName==='string'&&input.representativeName.trim().length>=2&&input.representativeName.length<=200,'INVALID_ONBOARDING','The legal representative is required.');
      invariant(typeof input.registeredAddress==='string'&&input.registeredAddress.trim().length>=4&&input.registeredAddress.length<=500,'INVALID_ONBOARDING','The registered address is required.');
      const registrationRef=optionalRef(input.registrationRef),taxReference=optionalRef(input.taxReference),
        representativeIdReference=optionalRef(input.representativeIdReference),transportAuthorizationReference=optionalRef(input.transportAuthorizationReference);
      invariant(registrationRef&&taxReference&&representativeIdReference&&transportAuthorizationReference,'INVALID_ONBOARDING','Company registration, tax, representative identity and transport authorization references are required.');
      // Proper KYB needs inspectable proofs, not references alone.
      const registrationDocumentUrl=httpsUrl(input.registrationDocumentUrl,true),taxDocumentUrl=httpsUrl(input.taxDocumentUrl,true),
        representativeIdDocumentUrl=httpsUrl(input.representativeIdDocumentUrl,true),transportAuthorizationDocumentUrl=httpsUrl(input.transportAuthorizationDocumentUrl,true),
        addressProofUrl=httpsUrl(input.addressProofUrl,true);
      return db.transaction(async tx=>{
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['onboarding:'+actor.id+':'+key]);
        const prior=await one(tx,"SELECT id FROM audit_events WHERE actor_id=$1 AND action='operator.onboarded' AND details->>'key'=$2",[actor.id,key]);
        if(prior){const existing=await one(tx,'SELECT * FROM operators WHERE admin_user_id=$1',[actor.id]);if(existing)return {operatorId:existing.id,status:existing.verification_status,role:'ops',alreadyOnboarded:true};}
        const user=await eligible(tx,actor);
        const operator=await one(tx,`INSERT INTO operators(name,legal_name,type,admin_user_id,verification_status,contact_phone,country,registration_ref,tax_reference,
          representative_name,representative_id_reference,transport_authorization_reference,registered_address)
          VALUES($1,$2,'company',$3,'pending_verification',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [input.displayName.trim(),input.legalName.trim(),actor.id,input.contactPhone.trim(),input.country.toLowerCase(),registrationRef,taxReference,
          input.representativeName.trim(),representativeIdReference,transportAuthorizationReference,input.registeredAddress.trim()]);
        await addEvidence(tx,operator.id,'company_registration',{reference:registrationRef,fileUrl:registrationDocumentUrl});
        await addEvidence(tx,operator.id,'tax_registration',{reference:taxReference,fileUrl:taxDocumentUrl});
        await addEvidence(tx,operator.id,'legal_representative_identity',{reference:representativeIdReference,fileUrl:representativeIdDocumentUrl});
        await addEvidence(tx,operator.id,'transport_authorization',{reference:transportAuthorizationReference,fileUrl:transportAuthorizationDocumentUrl});
        await addEvidence(tx,operator.id,'registered_address',{reference:input.registeredAddress.trim(),fileUrl:addressProofUrl});
        await tx.query(`INSERT INTO operator_plans(operator_id,plan,monthly_price_minor,billing_status,included_features)
          VALUES($1,'standard',NULL,'not_billed','["operational_management","fare_intelligence"]'::jsonb) ON CONFLICT DO NOTHING`,[operator.id]);
        await tx.query(`UPDATE users SET role='ops',operator_id=$2,display_name=$3,profile_completed_at=now(),updated_at=now() WHERE id=$1`,[actor.id,operator.id,user.display_name||input.displayName.trim()]);
        await audit(tx,actor.id,'operator.onboarded',operator.id,operator.id,{key,type:'company',verification:'kyb'});
        await audit(tx,actor.id,'identity.role_assigned',actor.id,operator.id,{role:'ops',via:'company_onboarding'});
        await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)',['operator.onboarded',operator.id,JSON.stringify({operatorId:operator.id,type:'company'})]);
        return {operatorId:operator.id,status:operator.verification_status,role:'ops'};
      });
    },

    // Independent owner-driver KYC: personal identity, driving authority and
    // vehicle proofs are reviewed because this person is the transport operator.
    async startIndependent(actor,input,key){
      invariant(actor?.role==='passenger','FORBIDDEN','Passenger access required.',403);idempotencyKey(key);
      const allowed=['displayName','phone','country','idDocumentType','idDocumentReference','idDocumentUrl','licenseReference','licenseDocumentUrl','driverPhotoUrl',
        'transportAuthorizationReference','transportAuthorizationDocumentUrl','insuranceReference','insuranceDocumentUrl','roadworthinessReference','roadworthinessDocumentUrl',
        'vehicleRegistration','vehicleRegistrationDocumentUrl','vehicleCapacity','vehicleMake','vehicleModel','vehicleColor','vehicleYear','vehiclePhotoUrl'];
      invariant(input&&Object.keys(input).every(k=>allowed.includes(k)),'INVALID_ONBOARDING','Unexpected onboarding fields.');
      invariant(typeof input.displayName==='string'&&input.displayName.trim().length>=2&&input.displayName.length<=200,'INVALID_ONBOARDING','A name is required.');
      invariant(typeof input.phone==='string'&&/^\+?[0-9 ()-]{6,25}$/.test(input.phone),'INVALID_ONBOARDING','A valid phone is required.');
      invariant(typeof input.country==='string'&&/^[a-z]{2}$/i.test(input.country),'INVALID_ONBOARDING','Country is invalid.');
      invariant(['national_id','passport','residence_permit','other'].includes(input.idDocumentType),'INVALID_ONBOARDING','Choose a valid identity document type.');
      const idDocumentReference=optionalRef(input.idDocumentReference,120),licenseReference=optionalRef(input.licenseReference,100),
        transportAuthorizationReference=optionalRef(input.transportAuthorizationReference,150),insuranceReference=optionalRef(input.insuranceReference,150),
        roadworthinessReference=optionalRef(input.roadworthinessReference,150),registration=optionalRef(input.vehicleRegistration,50);
      invariant(idDocumentReference&&licenseReference&&transportAuthorizationReference&&insuranceReference&&roadworthinessReference&&registration,'INVALID_ONBOARDING','Identity, licence, transport authorization, insurance, roadworthiness and vehicle registration references are required.');
      const capacity=Number(input.vehicleCapacity);invariant(Number.isInteger(capacity)&&capacity>=1&&capacity<=100,'INVALID_ONBOARDING','Vehicle capacity is invalid.');
      invariant(typeof input.vehicleMake==='string'&&input.vehicleMake.trim().length>=2&&input.vehicleMake.length<=80,'INVALID_ONBOARDING','Vehicle make is required.');
      invariant(typeof input.vehicleModel==='string'&&input.vehicleModel.trim().length>=1&&input.vehicleModel.length<=100,'INVALID_ONBOARDING','Vehicle model is required.');
      invariant(typeof input.vehicleColor==='string'&&input.vehicleColor.trim().length>=2&&input.vehicleColor.length<=50,'INVALID_ONBOARDING','Vehicle colour is required.');
      const vehicleYear=input.vehicleYear===undefined||input.vehicleYear===null||input.vehicleYear===''?null:Number(input.vehicleYear);
      invariant(vehicleYear===null||(Number.isInteger(vehicleYear)&&vehicleYear>=1980&&vehicleYear<=new Date().getFullYear()+1),'INVALID_ONBOARDING','Vehicle year is invalid.');
      const driverPhotoUrl=httpsUrl(input.driverPhotoUrl,true),idDocumentUrl=httpsUrl(input.idDocumentUrl,true),licenseDocumentUrl=httpsUrl(input.licenseDocumentUrl,true),
        transportAuthorizationDocumentUrl=httpsUrl(input.transportAuthorizationDocumentUrl,true),insuranceDocumentUrl=httpsUrl(input.insuranceDocumentUrl,true),
        roadworthinessDocumentUrl=httpsUrl(input.roadworthinessDocumentUrl,true),vehicleRegistrationDocumentUrl=httpsUrl(input.vehicleRegistrationDocumentUrl,true),
        vehiclePhotoUrl=httpsUrl(input.vehiclePhotoUrl,false);
      return db.transaction(async tx=>{
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['onboarding:'+actor.id+':'+key]);
        const prior=await one(tx,"SELECT id FROM audit_events WHERE actor_id=$1 AND action='operator.onboarded' AND details->>'key'=$2",[actor.id,key]);
        if(prior){const existing=await one(tx,'SELECT * FROM operators WHERE owner_user_id=$1',[actor.id]);if(existing)return {operatorId:existing.id,status:existing.verification_status,role:'driver',alreadyOnboarded:true};}
        await eligible(tx,actor);
        const operator=await one(tx,`INSERT INTO operators(name,type,owner_user_id,admin_user_id,verification_status,contact_phone,country,transport_authorization_reference)
          VALUES($1,'independent',$2,$2,'pending_verification',$3,$4,$5) RETURNING *`,[input.displayName.trim(),actor.id,input.phone.trim(),input.country.toLowerCase(),transportAuthorizationReference]);
        await tx.query(`UPDATE users SET role='driver',operator_id=$2,display_name=$3,profile_completed_at=now(),updated_at=now() WHERE id=$1`,[actor.id,operator.id,input.displayName.trim()]);
        await tx.query(`INSERT INTO driver_profiles(user_id,operator_id,license_reference,id_document_type,id_document_reference,photo_url,insurance_reference,roadworthiness_reference,transport_authorization_reference,active)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,[actor.id,operator.id,licenseReference,input.idDocumentType,idDocumentReference,driverPhotoUrl,insuranceReference,roadworthinessReference,transportAuthorizationReference]);
        const vehicle=await one(tx,`INSERT INTO vehicles(operator_id,registration,capacity,status,make,model,color,model_year,photo_url)
          VALUES($1,$2,$3,'active',$4,$5,$6,$7,$8) RETURNING id`,[operator.id,registration,capacity,input.vehicleMake.trim(),input.vehicleModel.trim(),input.vehicleColor.trim(),vehicleYear,vehiclePhotoUrl]);
        await addEvidence(tx,operator.id,'identity',{reference:idDocumentReference,fileUrl:idDocumentUrl,subjectUserId:actor.id});
        await addEvidence(tx,operator.id,'driving_license',{reference:licenseReference,fileUrl:licenseDocumentUrl,subjectUserId:actor.id});
        await addEvidence(tx,operator.id,'transport_authorization',{reference:transportAuthorizationReference,fileUrl:transportAuthorizationDocumentUrl,subjectUserId:actor.id});
        await addEvidence(tx,operator.id,'insurance',{reference:insuranceReference,fileUrl:insuranceDocumentUrl,subjectUserId:actor.id,vehicleId:vehicle.id});
        await addEvidence(tx,operator.id,'roadworthiness',{reference:roadworthinessReference,fileUrl:roadworthinessDocumentUrl,subjectUserId:actor.id,vehicleId:vehicle.id});
        await addEvidence(tx,operator.id,'vehicle_registration',{reference:registration,fileUrl:vehicleRegistrationDocumentUrl,subjectUserId:actor.id,vehicleId:vehicle.id});
        await addEvidence(tx,operator.id,'driver_photo',{fileUrl:driverPhotoUrl,subjectUserId:actor.id});
        if(vehiclePhotoUrl)await addEvidence(tx,operator.id,'vehicle_photo',{fileUrl:vehiclePhotoUrl,subjectUserId:actor.id,vehicleId:vehicle.id});
        await audit(tx,actor.id,'operator.onboarded',operator.id,operator.id,{key,type:'independent',vehicleId:vehicle.id,verification:'kyc'});
        await audit(tx,actor.id,'identity.role_assigned',actor.id,operator.id,{role:'driver',via:'independent_onboarding'});
        await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)',['operator.onboarded',operator.id,JSON.stringify({operatorId:operator.id,type:'independent'})]);
        return {operatorId:operator.id,status:operator.verification_status,role:'driver',vehicleId:vehicle.id};
      });
    },

    async updateProfile(actor,input){
      invariant(input&&Object.keys(input).every(k=>['contactPhone','country','registrationRef','displayName'].includes(k)),'INVALID_PROFILE','Unexpected profile fields.');
      return db.transaction(async tx=>{
        const user=await activeIdentity(tx,actor.id),operator=await operatorView(tx,user);
        invariant(operator,'NOT_FOUND','No operator membership found.',404);
        invariant(operator.admin_user_id===user.id||operator.owner_user_id===user.id,'FORBIDDEN','Only the operator owner or admin can edit the profile.',403);
        const sets=[],args=[operator.id];
        if(input.contactPhone!==undefined){invariant(typeof input.contactPhone==='string'&&/^\+?[0-9 ()-]{6,25}$/.test(input.contactPhone),'INVALID_PROFILE','Contact phone is invalid.');sets.push(`contact_phone=$${args.push(input.contactPhone.trim())}`);}
        if(input.country!==undefined){invariant(typeof input.country==='string'&&/^[a-z]{2}$/i.test(input.country),'INVALID_PROFILE','Country is invalid.');sets.push(`country=$${args.push(input.country.toLowerCase())}`);}
        if(input.registrationRef!==undefined){const ref=input.registrationRef===null?null:String(input.registrationRef);invariant(ref===null||(ref.trim().length>=2&&ref.length<=200),'INVALID_PROFILE','Registration reference is invalid.');sets.push(`registration_ref=$${args.push(ref===null?null:ref.trim())}`);}
        if(input.displayName!==undefined){invariant(typeof input.displayName==='string'&&input.displayName.trim().length>=2&&input.displayName.length<=200,'INVALID_PROFILE','Name is invalid.');sets.push(`name=$${args.push(input.displayName.trim())}`);}
        if(!sets.length)return operator;
        const row=await one(tx,`UPDATE operators SET ${sets.join(',')} WHERE id=$1 RETURNING *`,args);await audit(tx,actor.id,'operator.profile_updated',operator.id,operator.id);return row;
      });
    },

    // The existing operator verification endpoint also accepts a structured
    // evidence review command. This keeps one audited platform-only control
    // surface while allowing every proof to be reviewed before final approval.
    async verification(actor,operatorId,decision){
      invariant(actor?.role==='ops'&&!actor.operator_id,'FORBIDDEN','Only platform operations can change verification.',403);
      const id=uuid(operatorId);
      if(decision&&typeof decision==='object'){
        invariant(decision.type==='evidence','INVALID_DECISION','Unknown verification operation.');
        invariant(['verified','rejected'].includes(decision.status),'INVALID_DECISION','Evidence must be verified or rejected.');
        invariant(decision.notes===undefined||decision.notes===null||(typeof decision.notes==='string'&&decision.notes.length<=2000),'INVALID_DECISION','Review notes are invalid.');
        return db.transaction(async tx=>{
          const evidence=await one(tx,'SELECT * FROM verification_evidence WHERE id=$1 AND operator_id=$2 FOR UPDATE',[uuid(decision.evidenceId),id]);
          invariant(evidence,'NOT_FOUND','Verification evidence not found.',404);
          const row=await one(tx,`UPDATE verification_evidence SET status=$2,reviewed_at=now(),reviewed_by=$3,notes=$4 WHERE id=$1 RETURNING *`,
            [evidence.id,decision.status,actor.id,decision.notes??null]);
          await audit(tx,actor.id,'operator.evidence_reviewed',id,null,{evidenceId:evidence.id,kind:evidence.kind,decision:decision.status});return row;
        });
      }
      invariant(['verified','rejected','suspended'].includes(decision),'INVALID_DECISION','Decision must be verified, rejected or suspended.');
      return db.transaction(async tx=>{
        const operator=await one(tx,'SELECT * FROM operators WHERE id=$1 FOR UPDATE',[id]);invariant(operator,'NOT_FOUND','Operator not found.',404);
        if(decision==='verified'){
          const rows=(await tx.query('SELECT kind,status FROM verification_evidence WHERE operator_id=$1',[id])).rows;
          const approved=new Set(rows.filter(r=>r.status==='verified').map(r=>r.kind));
          const rejected=new Set(rows.filter(r=>r.status==='rejected').map(r=>r.kind));
          const required=requiredEvidence(operator.type),missing=required.filter(kind=>!approved.has(kind));
          invariant(!rejected.size,'VERIFICATION_INCOMPLETE','A rejected proof must be replaced before verification.',409);
          invariant(!missing.length,'VERIFICATION_INCOMPLETE',`Verification evidence is incomplete: ${missing.join(', ')}.`,409);
        }
        const row=await one(tx,`UPDATE operators SET verification_status=$2,verified_at=CASE WHEN $2='verified' THEN now() ELSE verified_at END,
          verified_by=CASE WHEN $2='verified' THEN $3 ELSE verified_by END WHERE id=$1 RETURNING *`,[id,decision,actor.id]);
        await audit(tx,actor.id,'operator.verification_changed',id,null,{from:operator.verification_status,to:decision});
        await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)',['operator.verification_changed',id,JSON.stringify({operatorId:id,status:decision})]);
        return {operatorId:row.id,verificationStatus:row.verification_status};
      });
    },

    async evidence(actor,operatorId){invariant(actor?.role==='ops'&&!actor.operator_id,'FORBIDDEN','Only platform operations can review verification evidence.',403);const id=uuid(operatorId);return db.transaction(async tx=>(await tx.query(`SELECT e.*,u.display_name AS subject_name,v.registration AS vehicle_registration FROM verification_evidence e LEFT JOIN users u ON u.id=e.subject_user_id LEFT JOIN vehicles v ON v.id=e.vehicle_id WHERE e.operator_id=$1 ORDER BY e.submitted_at,e.kind`,[id])).rows);},

    async members(actor,operatorId){const id=uuid(operatorId);return db.transaction(async tx=>{const user=await activeIdentity(tx,actor.id);if(user.operator_id)invariant(user.operator_id===id,'FORBIDDEN','Operation is not permitted.',403);return (await tx.query(`SELECT u.id,u.display_name,u.role,u.active,u.operator_id,d.license_reference,d.active AS driver_active,c.active AS convoyeur_active,o.type AS operator_type,o.verification_status,o.owner_user_id,o.admin_user_id FROM users u JOIN operators o ON o.id=u.operator_id LEFT JOIN driver_profiles d ON d.user_id=u.id LEFT JOIN convoyeur_profiles c ON c.user_id=u.id WHERE u.operator_id=$1 AND u.role IN ('ops','driver','convoyeur') ORDER BY u.display_name`,[id])).rows;});},
    async listOperators(actor){invariant(actor?.role==='ops'&&!actor.operator_id,'FORBIDDEN','Only platform operations can list operators.',403);return db.transaction(async tx=>(await tx.query(`SELECT id,name,legal_name,type,verification_status,contact_phone,country,active,owner_user_id,admin_user_id,registration_ref,tax_reference,representative_name,representative_id_reference,transport_authorization_reference,registered_address,verified_at,verified_by,created_at FROM operators ORDER BY created_at DESC LIMIT 200`)).rows);},
  };
}
