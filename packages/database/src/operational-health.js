import {readdir} from 'node:fs/promises';
import {invariant} from '@leroutier/domain';
// One capacity measurement, shared with the gate that actually refuses new
// accounts. Two implementations would eventually disagree, and Platform Ops
// would be reading a number that is not the one enforcing anything.
import {registrationCapacity} from './registration.js';
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
      invariant(actor?.role==='ops' && !actor.operator_id,'FORBIDDEN','Platform Operations access required.',403);
      const expected=(await readdir(new URL('../migrations/',import.meta.url))).filter(f=>/^\d+.*\.sql$/.test(f)).length;
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
        const signals=(await tx.query("SELECT signal,sum(count)::integer AS count FROM operational_signals WHERE minute>now()-interval '15 minutes' GROUP BY signal")).rows;
        const capacity=await registrationCapacity(tx);

        const users=(await tx.query(`SELECT u.id,u.display_name,u.role,u.active,u.is_demo,u.operator_id,u.notification_email,
          u.auth_subject IS NOT NULL AS authenticated,u.auth_issuer,u.created_at,u.updated_at,u.profile_completed_at,
          o.name AS operator_name,o.type AS operator_type,o.verification_status,
          p.phone AS passenger_phone,d.license_reference,d.active AS driver_active,c.active AS convoyeur_active
          FROM users u
          LEFT JOIN operators o ON o.id=u.operator_id
          LEFT JOIN passenger_profiles p ON p.user_id=u.id
          LEFT JOIN driver_profiles d ON d.user_id=u.id
          LEFT JOIN convoyeur_profiles c ON c.user_id=u.id
          ORDER BY u.created_at DESC LIMIT 500`)).rows;

        // Platform Ops gets a review projection, not a public projection. It
        // contains references and evidence URLs needed for manual KYC/KYB but
        // never authentication tokens/passwords. Company employees are not
        // individually KYC'd; independent owner-drivers are.
        const kycQueue=(await tx.query(`SELECT o.id,o.name,o.legal_name,o.type,o.verification_status,o.contact_phone,o.country,o.registration_ref,o.tax_reference,
          o.representative_name,o.representative_id_reference,o.transport_authorization_reference,o.registered_address,o.created_at,o.verified_at,
          owner.display_name AS owner_name,admin.display_name AS admin_name,
          d.id_document_type,d.id_document_reference,d.license_reference,d.photo_url AS driver_photo_url,d.insurance_reference,d.roadworthiness_reference,
          v.id AS vehicle_id,v.registration AS vehicle_registration,v.make AS vehicle_make,v.model AS vehicle_model,v.color AS vehicle_color,
          v.model_year AS vehicle_year,v.photo_url AS vehicle_photo_url,
          COALESCE((SELECT json_agg(json_build_object('id',e.id,'kind',e.kind,'reference',e.reference,'fileUrl',e.file_url,'status',e.status,
            'submittedAt',e.submitted_at,'reviewedAt',e.reviewed_at,'notes',e.notes) ORDER BY e.submitted_at,e.kind)
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

        const paymentAnomalies=(await tx.query(`SELECT p.id,p.status,p.amount_minor,p.currency,p.created_at,b.id AS booking_id,
          s.id AS service_id,o.id AS operator_id,o.name AS operator_name
          FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN services s ON s.id=b.service_id JOIN operators o ON o.id=s.operator_id
          WHERE p.status='failed' ORDER BY p.created_at DESC LIMIT 100`)).rows;
        const payoutAnomalies=(await tx.query(`SELECT r.id,r.status,r.amount_minor,r.currency,r.created_at,u.display_name AS beneficiary,
          dp.operator_id,o.name AS operator_name
          FROM payout_requests r JOIN users u ON u.id=r.driver_id LEFT JOIN driver_profiles dp ON dp.user_id=r.driver_id
          LEFT JOIN operators o ON o.id=dp.operator_id
          WHERE r.status IN ('failed','reversed') ORDER BY r.created_at DESC LIMIT 100`)).rows;
        const incidents=(await tx.query(`SELECT i.id,i.kind,i.severity,i.status,i.description,i.created_at,s.id AS service_id,
          o.id AS operator_id,o.name AS operator_name
          FROM incidents i JOIN services s ON s.id=i.service_id JOIN operators o ON o.id=s.operator_id
          WHERE i.status<>'resolved' ORDER BY i.created_at DESC LIMIT 100`)).rows;

        return {database:'ok',migrations:{applied:counts.migrations,expected,matched:counts.migrations===expected},
          signals,counts,pool:db.poolStats?.()??null,alertTransport:'internal_ops_only',
          storage:capacity,
          users,kycQueue,paymentAnomalies,payoutAnomalies,incidents};
      });
    },
  };
}
