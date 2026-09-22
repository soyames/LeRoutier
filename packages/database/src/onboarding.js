import { invariant, uuid, idempotencyKey } from '@leroutier/domain';
import { audit, activeIdentity } from './identities.js';
import { documentReference, evidenceStorageState, EVIDENCE_READ_TTL_SECONDS } from './evidence-storage.js';

const one=(tx,sql,args=[])=>(tx.query(sql,args)).then(r=>r.rows[0]);
const optionalRef=(value,max=200)=>{
  if(value===undefined||value===null||value==='')return null;
  const text=String(value).trim();
  invariant(text.length>=2&&text.length<=max,'INVALID_ONBOARDING','Reference is invalid.');
  return text;
};
// What a document reference may be, and the fact that LeRoutier does not hold
// the file, live in one module. See evidence-storage.js before changing how a
// proof is submitted, reviewed or displayed.
const httpsUrl=documentReference;
const addEvidence=(tx,operatorId,kind,{reference=null,fileUrl=null,subjectUserId=null,vehicleId=null}={})=>
  tx.query(`INSERT INTO verification_evidence(operator_id,subject_user_id,vehicle_id,kind,reference,file_url)
    VALUES($1,$2,$3,$4,$5,$6)`,[operatorId,subjectUserId,vehicleId,kind,reference,fileUrl]);
export const requiredEvidence=type=>type==='company'
  ? ['company_registration','tax_registration','legal_representative_identity','transport_authorization','registered_address']
  : ['identity','driving_license','vehicle_registration','insurance','roadworthiness','transport_authorization','driver_photo'];

/**
 * @param {any} db
 * @param {{name:string,put:Function,read:Function,remove:Function}|null} [store]
 *   Private object storage for KYC documents. Null keeps the operator-hosted
 *   link arrangement, which is a supported state rather than a degraded one.
 */
export function onboarding(db,store=null){
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
          // The operator travels with the event. Audience resolution falls back
          // to walking the aggregate through services, parcels and incidents —
          // none of which an operator id matches — so a null here meant the
          // review decision could never reach the operator it was about.
          await audit(tx,actor.id,'operator.evidence_reviewed',id,id,{evidenceId:evidence.id,kind:evidence.kind,decision:decision.status});return row;
        });
      }
      // 'pending_verification' re-opens a file. Without it a rejected operator
      // could never be reconsidered — not by themselves, and not by the people
      // who rejected them — which turns a review decision into a permanent one
      // and makes the appeal the product promises impossible to honour.
      invariant(['verified','rejected','suspended','pending_verification'].includes(decision),
        'INVALID_DECISION','Decision must be verified, rejected, suspended or returned for review.');
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

    /**
     * Storage capability, for Platform Ops and for product copy.
     * No screen may promise managed custody while this says otherwise.
     */
    storage: () => evidenceStorageState(store),

    /**
     * A short-lived, authorized way to look at one proof.
     *
     * This replaces handing every reviewer a permanent document URL inside a
     * list payload. Two things change even where LeRoutier does not hold the
     * bytes: the address is fetched per document at the moment somebody opens
     * it rather than sitting in a JSON blob in a browser tab, and the request
     * is authorized and auditable.
     *
     * Where LeRoutier DOES hold the bytes the grant expires, which is the
     * property an operator-hosted link can never have.
     */
    async accessEvidence(actor,evidenceId){
      invariant(actor?.role==='ops'&&!actor.operator_id,'FORBIDDEN',
        'Only platform operations can open verification evidence.',403);
      const id=uuid(evidenceId);
      const row=await db.transaction(async tx=>{
        const found=await one(tx,'SELECT * FROM verification_evidence WHERE id=$1',[id]);
        invariant(found,'NOT_FOUND','Verification evidence not found.',404);
        // A redacted proof is gone on purpose. Saying "not found" here would
        // be misleading; saying it was deleted is the truth and is what a
        // reviewer needs in order to stop looking for it.
        invariant(!found.redacted_at,'EVIDENCE_REDACTED',
          'Ce justificatif a été supprimé conformément à la politique de conservation.',410);
        // Who opened which document, and when. The trail records the decision
        // to look, never the address that was handed out.
        await audit(tx,actor.id,'operator.evidence_opened',found.operator_id,found.operator_id,
          {evidenceId:found.id,kind:found.kind});
        return found;
      });
      if(row.storage_key){
        invariant(store,'EVIDENCE_STORAGE_UNAVAILABLE',
          'Le stockage des justificatifs est indisponible. Réessayez plus tard.',503);
        const grant=await store.read(row.storage_key,{ttlSeconds:EVIDENCE_READ_TTL_SECONDS});
        return {kind:row.kind,storage:'managed',contentType:row.content_type,byteSize:row.byte_size,
          url:grant.url,expiresAt:grant.expiresAt};
      }
      // The operator hosts this one. The address is still only handed out to an
      // authorized reviewer, but it does not expire and LeRoutier cannot revoke
      // it — said here so no console can imply otherwise.
      invariant(row.file_url,'NOT_FOUND','This proof has no document attached.',404);
      return {kind:row.kind,storage:'operator_link',contentType:null,byteSize:null,
        url:row.file_url,expiresAt:null};
    },

    /**
     * Replace a refused proof by uploading the document itself.
     *
     * The managed counterpart of resubmitEvidence: same authorization, same
     * rules about which proofs may be replaced and when, but LeRoutier takes
     * custody of the bytes instead of recording somebody else's link.
     *
     * The content type is read from the file's own first bytes, never from
     * what the uploader claimed — an SVG announced as image/png is still a
     * scripted page when a reviewer opens it.
     */
    async uploadEvidence(actor,evidenceId,bytes){
      invariant(store,'EVIDENCE_STORAGE_UNAVAILABLE',
        'L’envoi direct de documents n’est pas encore disponible. Fournissez un lien HTTPS.',503);
      const id=uuid(evidenceId);
      const evidence=await db.transaction(async tx=>{
        const user=await activeIdentity(tx,actor.id);
        const operator=await operatorView(tx,user);
        invariant(operator,'NOT_FOUND','No operator membership found.',404);
        invariant(operator.admin_user_id===user.id||operator.owner_user_id===user.id,
          'FORBIDDEN','Only the operator owner or admin can replace a proof.',403);
        invariant(operator.verification_status==='pending_verification','VERIFICATION_CLOSED',
          'Ce dossier n’est plus en cours d’examen. Contactez LeRoutier.',409);
        const found=await one(tx,'SELECT * FROM verification_evidence WHERE id=$1 AND operator_id=$2',[id,operator.id]);
        invariant(found,'NOT_FOUND','Verification evidence not found.',404);
        invariant(found.status==='rejected','EVIDENCE_NOT_REJECTED',
          'Seul un justificatif refusé peut être remplacé.',409);
        return {...found,operatorId:operator.id};
      });
      // Provider I/O outside the transaction: an upload can be slow, and a
      // database transaction held open across it is a lock held across it.
      const stored=await store.put({operatorId:evidence.operatorId,kind:evidence.kind,bytes});
      return db.transaction(async tx=>{
        const current=await one(tx,'SELECT storage_key FROM verification_evidence WHERE id=$1 FOR UPDATE',[id]);
        const row=await one(tx,`UPDATE verification_evidence
          SET storage_key=$2,storage_provider=$3,content_type=$4,byte_size=$5,file_url=NULL,
              status='pending',submitted_at=now(),reviewed_at=NULL,reviewed_by=NULL,notes=NULL
          WHERE id=$1 RETURNING id,kind,status,content_type,byte_size,submitted_at`,
        [id,stored.key,store.name,stored.contentType,stored.byteSize]);
        // The key never appears in the audit trail or the event stream: the
        // record is that a proof was replaced, not where the document lives.
        await audit(tx,actor.id,'operator.evidence_resubmitted',evidence.operatorId,evidence.operatorId,
          {evidenceId:id,kind:evidence.kind,storage:'managed'});
        // The document this one replaces is no longer referenced by anything,
        // so it is removed rather than left paid for and forgotten.
        if(current?.storage_key&&current.storage_key!==stored.key){
          await store.remove(current.storage_key).catch(()=>{});
        }
        return row;
      });
    },
    // The dossier a reviewer reads. Deliberately no file_url and no
    // storage_key: whether a document exists is list information, and where it
    // lives is not. Opening one goes through accessEvidence, which authorizes,
    // audits and — under managed storage — expires.
    async evidence(actor,operatorId){
      invariant(actor?.role==='ops'&&!actor.operator_id,'FORBIDDEN','Only platform operations can review verification evidence.',403);
      const id=uuid(operatorId);
      return db.transaction(async tx=>(await tx.query(`SELECT e.id,e.kind,e.reference,e.status,e.submitted_at,e.reviewed_at,e.notes,
        e.redacted_at,e.content_type,e.byte_size,
        (e.file_url IS NOT NULL OR e.storage_key IS NOT NULL) AS has_document,
        CASE WHEN e.storage_key IS NOT NULL THEN 'managed' WHEN e.file_url IS NOT NULL THEN 'operator_link' ELSE 'none' END AS storage,
        u.display_name AS subject_name,v.registration AS vehicle_registration
        FROM verification_evidence e LEFT JOIN users u ON u.id=e.subject_user_id LEFT JOIN vehicles v ON v.id=e.vehicle_id
        WHERE e.operator_id=$1 ORDER BY e.submitted_at,e.kind`,[id])).rows);},

    /**
     * The operator's own view of its verification file.
     *
     * Without this an operator could be rejected and never find out why: the
     * reviewer's notes existed only inside Platform Ops, and the only thing the
     * operator saw was a status that never changed. Nobody can correct a proof
     * they were never told was wrong.
     *
     * The reviewer's identity is NOT included. Who examined a dossier is
     * internal; what they decided and why is the operator's business.
     */
    async dossier(actor){
      return db.transaction(async tx=>{
        const user=await activeIdentity(tx,actor.id);
        const operator=await operatorView(tx,user);
        invariant(operator,'NOT_FOUND','No operator membership found.',404);
        invariant(operator.admin_user_id===user.id||operator.owner_user_id===user.id,
          'FORBIDDEN','Only the operator owner or admin can read the verification file.',403);
        const evidence=(await tx.query(`SELECT id,kind,reference,status,submitted_at,reviewed_at,notes,
          (file_url IS NOT NULL OR storage_key IS NOT NULL) AS has_document,
          CASE WHEN storage_key IS NOT NULL THEN 'managed' WHEN file_url IS NOT NULL THEN 'operator_link' ELSE 'none' END AS storage
          FROM verification_evidence WHERE operator_id=$1 ORDER BY kind`,[operator.id])).rows;
        const approved=new Set(evidence.filter(e=>e.status==='verified').map(e=>e.kind));
        const required=requiredEvidence(operator.type);
        return {
          operatorId:operator.id,operatorName:operator.name,operatorType:operator.type,
          verificationStatus:operator.verification_status,verifiedAt:operator.verified_at,
          required,
          missing:required.filter(kind=>!approved.has(kind)),
          // What the operator may act on right now. Computed here rather than
          // in the console, so the button and the server agree about it.
          correctable:operator.verification_status==='pending_verification'
            ? evidence.filter(e=>e.status==='rejected').map(e=>e.id) : [],
          evidence,
        };
      });
    },

    /**
     * Replace a proof a reviewer refused.
     *
     * Only a rejected proof, and only while the operator is still awaiting a
     * decision. An operator REJECTED as a whole is a platform judgement about
     * that operator, not about a blurry photograph: re-opening that file is
     * Platform Ops' decision (they can return it to pending_verification), and
     * letting the operator do it by re-uploading would make the decision
     * meaningless.
     *
     * The row is updated rather than duplicated: the dossier is the current
     * state of the file, and the audit trail carries the history.
     */
    async resubmitEvidence(actor,evidenceId,input){
      invariant(input&&Object.keys(input).every(k=>['reference','fileUrl'].includes(k)),
        'INVALID_ONBOARDING','Unexpected evidence fields.');
      const id=uuid(evidenceId);
      return db.transaction(async tx=>{
        const user=await activeIdentity(tx,actor.id);
        const operator=await operatorView(tx,user);
        invariant(operator,'NOT_FOUND','No operator membership found.',404);
        invariant(operator.admin_user_id===user.id||operator.owner_user_id===user.id,
          'FORBIDDEN','Only the operator owner or admin can replace a proof.',403);
        invariant(operator.verification_status==='pending_verification','VERIFICATION_CLOSED',
          'Ce dossier n’est plus en cours d’examen. Contactez LeRoutier.',409);
        // Scoped by operator_id in the WHERE clause, so naming another
        // operator's evidence id is a 404 and never a cross-tenant write.
        const evidence=await one(tx,'SELECT * FROM verification_evidence WHERE id=$1 AND operator_id=$2 FOR UPDATE',[id,operator.id]);
        invariant(evidence,'NOT_FOUND','Verification evidence not found.',404);
        invariant(evidence.status==='rejected','EVIDENCE_NOT_REJECTED',
          'Seul un justificatif refusé peut être remplacé.',409);
        const reference=optionalRef(input.reference,200)??evidence.reference;
        // A photo proof carries no reference, so the file is what must change;
        // everything else needs at least one of the two to be present.
        const fileUrl=input.fileUrl===undefined?evidence.file_url:httpsUrl(input.fileUrl,false);
        invariant(reference||fileUrl,'INVALID_ONBOARDING','A reference or a document link is required.');
        invariant(reference!==evidence.reference||fileUrl!==evidence.file_url,'INVALID_ONBOARDING',
          'Fournissez un justificatif différent de celui qui a été refusé.');
        const row=await one(tx,`UPDATE verification_evidence
          SET reference=$2,file_url=$3,status='pending',submitted_at=now(),reviewed_at=NULL,reviewed_by=NULL,notes=NULL
          WHERE id=$1 RETURNING id,kind,reference,file_url,status,submitted_at`,[evidence.id,reference,fileUrl]);
        // The refused document's address is not copied into the audit trail or
        // the event stream: the trail records that a proof was replaced, not
        // where the document lives.
        await audit(tx,actor.id,'operator.evidence_resubmitted',operator.id,operator.id,
          {evidenceId:evidence.id,kind:evidence.kind});
        return row;
      });
    },

    // A staff roster, with driving licence references, is operator-internal.
    // The guard is stated as a positive requirement rather than "refuse when
    // the caller belongs to another operator": a caller with NO operator —
    // every passenger on the platform — satisfies that negative form and used
    // to read any operator's crew list, licence numbers included. Only the
    // operator's own management and Platform Ops may read it.
    async members(actor,operatorId){const id=uuid(operatorId);return db.transaction(async tx=>{const user=await activeIdentity(tx,actor.id);invariant(user.role==='ops'&&(user.operator_id===id||!user.operator_id),'FORBIDDEN','Operation is not permitted.',403);return (await tx.query(`SELECT u.id,u.display_name,u.role,u.active,u.operator_id,d.license_reference,d.active AS driver_active,c.active AS convoyeur_active,o.type AS operator_type,o.verification_status,o.owner_user_id,o.admin_user_id FROM users u JOIN operators o ON o.id=u.operator_id LEFT JOIN driver_profiles d ON d.user_id=u.id LEFT JOIN convoyeur_profiles c ON c.user_id=u.id WHERE u.operator_id=$1 AND u.role IN ('ops','driver','convoyeur') ORDER BY u.display_name`,[id])).rows;});},
    async listOperators(actor){invariant(actor?.role==='ops'&&!actor.operator_id,'FORBIDDEN','Only platform operations can list operators.',403);return db.transaction(async tx=>(await tx.query(`SELECT id,name,legal_name,type,verification_status,contact_phone,country,active,owner_user_id,admin_user_id,registration_ref,tax_reference,representative_name,representative_id_reference,transport_authorization_reference,registered_address,verified_at,verified_by,created_at FROM operators ORDER BY created_at DESC LIMIT 200`)).rows);},
  };
}
