import {schemaStatus} from './migrations.js';
import {invariant} from '@leroutier/domain';
// One capacity measurement, shared with the gate that actually refuses new
// accounts. Two implementations would eventually disagree, and Platform Ops
// would be reading a number that is not the one enforcing anything.
import {registrationCapacity} from './registration.js';
import {requirePlatform, holds, isPlatformIdentity} from './platform-access.js';
// What a dossier must contain is a product rule, and it is decided in exactly
// one place. The review queue reports completeness computed from THAT rule, so
// a console can never enable "verify" for a dossier the server will refuse.
import {requiredEvidence} from './onboarding.js';

export function operationalHealth(db) {
  return {
    async record(signal) {
      if(!['api_error','webhook_rejected','gps_anomaly'].includes(signal))return;
      await db.transaction(async tx=>{
        await tx.query(`INSERT INTO operational_signals(signal) VALUES($1)
          ON CONFLICT(minute,signal) DO UPDATE SET count=operational_signals.count+1`,[signal]);
      }).catch(()=>{});
    },
    async read(actor) {
      // The platform dashboard is ASSEMBLED FROM WHAT THE CALLER MAY SEE, and
      // that is not cosmetic: kycQueue carries national identity references,
      // driving licence numbers and driver photographs. Returning it to
      // somebody granted only `finance` would hand them a dossier the console
      // simply declines to draw — the leak would be in the payload, which is
      // where leaks actually live.
      //
      // Each section is also SKIPPED rather than fetched and discarded, so an
      // unauthorized section costs no query at all.
      invariant(isPlatformIdentity(actor) && (actor.platform_capabilities ?? []).length,
        'FORBIDDEN','Platform Operations access required.',403);
      const can=capability=>holds(actor,capability);
      // Same comparison the readiness endpoint answers from.
      const schema=can('system')?await schemaStatus(db):null;
      return db.transaction(async tx=>{
        const counts=(await tx.query(`SELECT
          (SELECT count(*) FROM schema_migrations)::integer AS migrations,
          (SELECT count(*) FROM notification_deliveries WHERE status='failed')::integer AS notification_failed,
          (SELECT count(*) FROM notification_deliveries WHERE status='unavailable')::integer AS notification_unavailable,
          (SELECT count(*) FROM outbox WHERE dispatch_dead_at IS NOT NULL)::integer AS dispatch_dead,
          (SELECT count(*) FROM agent_model_cooldowns WHERE until_at>now())::integer AS model_cooldowns,
          (SELECT count(*) FROM agent_model_calls WHERE status='rejected' AND created_at>now()-interval '1 day')::integer AS model_rejected,
          (SELECT count(*) FROM route_geometry_failures WHERE created_at>now()-interval '1 day')::integer AS routing_failed,
          (SELECT count(*) FROM users)::integer AS users_total,
          (SELECT count(*) FROM users WHERE active=true)::integer AS users_active,
          (SELECT count(*) FROM users WHERE auth_subject IS NOT NULL)::integer AS users_authenticated,
          (SELECT count(*) FROM operators WHERE verification_status='pending_verification')::integer AS kyc_pending,
          (SELECT count(*) FROM payments WHERE status='failed')::integer AS payments_failed_total,
          (SELECT count(*) FROM payout_requests WHERE status IN ('failed','reversed'))::integer AS payouts_failed_total,
          (SELECT count(*) FROM incidents WHERE status<>'resolved')::integer AS incidents_open`)).rows[0];
        const signals=!can('system')?[]:(await tx.query("SELECT signal,sum(count)::integer AS count FROM operational_signals WHERE minute>now()-interval '15 minutes' GROUP BY signal")).rows;
        const capacity=can('system')?await registrationCapacity(tx):null;

        // The user register is NOT returned here. Six Platform Ops screens poll
        // this endpoint, and shipping hundreds of names, e-mails and phone
        // numbers to a screen showing database capacity is neither necessary
        // nor minimal. It has its own searched, paginated reader below.

        // Platform Ops gets a review projection, not a public projection. It
        // contains references and evidence URLs needed for manual KYC/KYB but
        // never authentication tokens/passwords. Company employees are not
        // individually KYC'd; independent owner-drivers are.
        const kycQueue=!can('verification')?[]:(await tx.query(`SELECT o.id,o.name,o.legal_name,o.type,o.verification_status,o.contact_phone,o.country,o.registration_ref,o.tax_reference,
          o.representative_name,o.representative_id_reference,o.transport_authorization_reference,o.registered_address,o.created_at,o.verified_at,
          owner.display_name AS owner_name,admin.display_name AS admin_name,
          d.id_document_type,d.id_document_reference,d.license_reference,d.photo_url AS driver_photo_url,d.insurance_reference,d.roadworthiness_reference,
          v.id AS vehicle_id,v.registration AS vehicle_registration,v.make AS vehicle_make,v.model AS vehicle_model,v.color AS vehicle_color,
          v.model_year AS vehicle_year,v.photo_url AS vehicle_photo_url,
          -- No document address. A review queue is a list; handing every
          -- reviewer a permanent URL for every proof in it puts those
          -- addresses in a JSON payload, in a browser tab, in devtools and in
          -- anything that copies a response. The console asks for one grant
          -- when somebody actually opens a document.
          COALESCE((SELECT json_agg(json_build_object('id',e.id,'kind',e.kind,'reference',e.reference,
            'hasDocument',(e.file_url IS NOT NULL OR e.storage_key IS NOT NULL),
            'storage',CASE WHEN e.storage_key IS NOT NULL THEN 'managed' WHEN e.file_url IS NOT NULL THEN 'operator_link' ELSE 'none' END,
            'status',e.status,'submittedAt',e.submitted_at,'reviewedAt',e.reviewed_at,'notes',e.notes) ORDER BY e.submitted_at,e.kind)
            FROM verification_evidence e WHERE e.operator_id=o.id),'[]'::json) AS evidence
          FROM operators o
          LEFT JOIN users owner ON owner.id=o.owner_user_id
          LEFT JOIN users admin ON admin.id=o.admin_user_id
          LEFT JOIN driver_profiles d ON d.user_id=o.owner_user_id AND o.type='independent'
          LEFT JOIN LATERAL (SELECT vv.* FROM vehicles vv WHERE vv.operator_id=o.id ORDER BY vv.created_at LIMIT 1) v ON true
          WHERE o.verification_status IN ('pending_verification','rejected','suspended')
          ORDER BY CASE o.verification_status WHEN 'pending_verification' THEN 0 ELSE 1 END,o.created_at DESC LIMIT 200`)).rows;
        // Completeness is computed from requiredEvidence(), the same rule the
        // verification transition enforces, so the console and the server
        // cannot disagree about whether a dossier is ready.
        for(const operator of kycQueue){
          const approved=new Set((operator.evidence||[]).filter(e=>e.status==='verified').map(e=>e.kind));
          const rejected=(operator.evidence||[]).filter(e=>e.status==='rejected').map(e=>e.kind);
          const required=requiredEvidence(operator.type);
          operator.evidenceRequired=required;
          operator.evidenceMissing=required.filter(kind=>!approved.has(kind));
          operator.evidenceRejected=rejected;
          operator.evidenceComplete=operator.evidenceMissing.length===0 && rejected.length===0;
        }

        const paymentAnomalies=!can('finance')?[]:(await tx.query(`SELECT p.id,p.status,p.amount_minor,p.currency,p.created_at,b.id AS booking_id,
          s.id AS service_id,o.id AS operator_id,o.name AS operator_name
          FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN services s ON s.id=b.service_id JOIN operators o ON o.id=s.operator_id
          WHERE p.status='failed' ORDER BY p.created_at DESC LIMIT 100`)).rows;
        const payoutAnomalies=!can('finance')?[]:(await tx.query(`SELECT r.id,r.status,r.amount_minor,r.currency,r.created_at,u.display_name AS beneficiary,
          dp.operator_id,o.name AS operator_name
          FROM payout_requests r JOIN users u ON u.id=r.driver_id LEFT JOIN driver_profiles dp ON dp.user_id=r.driver_id
          LEFT JOIN operators o ON o.id=dp.operator_id
          WHERE r.status IN ('failed','reversed') ORDER BY r.created_at DESC LIMIT 100`)).rows;
        const incidents=!can('incidents')?[]:(await tx.query(`SELECT i.id,i.kind,i.severity,i.status,i.description,i.created_at,s.id AS service_id,
          o.id AS operator_id,o.name AS operator_name
          FROM incidents i JOIN services s ON s.id=i.service_id JOIN operators o ON o.id=s.operator_id
          WHERE i.status<>'resolved' ORDER BY i.created_at DESC LIMIT 100`)).rows;

        // Counts are filtered the same way. A number is small, but "0 anomalies
        // financières" on the screen of somebody with no finance grant is still
        // a fact about the platform they were not given.
        const VISIBLE_COUNTS={users:['users_total','users_active','users_authenticated'],
          verification:['kyc_pending'],incidents:['incidents_open'],
          finance:['payments_failed_total','payouts_failed_total'],
          system:['migrations','notification_failed','notification_unavailable','dispatch_dead',
            'model_cooldowns','model_rejected','routing_failed']};
        const visibleCounts={};
        for(const [capability,fields] of Object.entries(VISIBLE_COUNTS))
          if(can(capability)) for(const field of fields) visibleCounts[field]=counts[field];

        return {database:'ok',
          // Platform Ops holding `system` sees the filenames too: they are the
          // people who would run the migration, and "1 pending" without a name
          // is a question rather than an answer.
          migrations:schema?{applied:schema.counts.applied,expected:schema.counts.declared,
            matched:schema.status==='current',status:schema.status,
            pending:schema.pending,drifted:schema.drifted,unknown:schema.unknown,
            missingTables:schema.missingTables}:null,
          signals,counts:visibleCounts,pool:can('system')?(db.poolStats?.()??null):null,
          alertTransport:'internal_ops_only',
          storage:capacity,
          capabilities:actor.platform_capabilities??[],
          kycQueue,paymentAnomalies,payoutAnomalies,incidents};
      });
    },

    /**
     * The Platform Ops user register: searched and paginated on the server.
     *
     * Previously this rode along on every /ops/health poll as a 500-row array
     * filtered in the browser, which meant two things a console must not do:
     * six screens shipped hundreds of personal records to display none of
     * them, and past 500 accounts the search box silently stopped finding
     * people — indistinguishable, to the operator, from the account not
     * existing.
     *
     * The driver licence number is deliberately absent. It is a government
     * identifier, it belongs to the reviewed dossier, and a directory listing
     * is not a reason to hand it out.
     */
    async users(actor,{q=null,limit=50,offset=0}={}) {
      requirePlatform(actor,'users');
      const search=typeof q==='string' && q.trim() ? q.trim().slice(0,100) : null;
      // A nonsense page size falls back to the default rather than to 1: a
      // negative number is a caller mistake, not a request for one row.
      const requested=Number(limit);
      const size=Number.isFinite(requested) && requested>=1 ? Math.min(Math.trunc(requested),100) : 50;
      const skipped=Number(offset);
      const from=Number.isFinite(skipped) && skipped>0 ? Math.trunc(skipped) : 0;
      return db.transaction(async tx=>{
        // One parameterized predicate, used for both the page and its count,
        // so the reported total can never describe a different filter.
        const where=`($1::text IS NULL OR u.display_name ILIKE '%'||$1||'%' OR u.notification_email ILIKE '%'||$1||'%'
          OR u.role ILIKE '%'||$1||'%' OR o.name ILIKE '%'||$1||'%' OR u.id::text=$1)`;
        const rows=(await tx.query(`SELECT u.id,u.display_name,u.role,u.active,u.is_demo,u.operator_id,u.notification_email,
          u.auth_subject IS NOT NULL AS authenticated,u.auth_issuer,u.created_at,u.updated_at,u.profile_completed_at,
          u.last_authenticated_at,u.last_meaningful_activity_at,
          o.name AS operator_name,o.type AS operator_type,o.verification_status,
          p.phone AS passenger_phone,d.active AS driver_active,c.active AS convoyeur_active,
          status_change.created_at AS status_changed_at,status_change.details->>'active' AS status_changed_to
          FROM users u
          LEFT JOIN operators o ON o.id=u.operator_id
          LEFT JOIN passenger_profiles p ON p.user_id=u.id
          LEFT JOIN driver_profiles d ON d.user_id=u.id
          LEFT JOIN convoyeur_profiles c ON c.user_id=u.id
          -- The most recent suspension or reactivation, from the audit trail
          -- rather than a second column that could disagree with it.
          LEFT JOIN LATERAL (SELECT a.created_at,a.details FROM audit_events a
            WHERE a.entity_id=u.id AND a.action='identity.activation_changed'
            ORDER BY a.created_at DESC LIMIT 1) status_change ON true
          WHERE ${where}
          ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`,[search,size,from])).rows;
        const total=(await tx.query(`SELECT count(*)::integer AS total FROM users u
          LEFT JOIN operators o ON o.id=u.operator_id WHERE ${where}`,[search])).rows[0].total;
        return {users:rows,total,limit:size,offset:from,query:search};
      });
    },
  };
}
