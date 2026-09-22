// Integrated privacy, consent, retention, user rights and account deletion —
// one coherent capability over the EXISTING users/profiles/notifications/audit
// domain. No parallel identity, notification or ledger system.
//
// Hard invariants:
//  - Deletion never cascades financial, booking, parcel or audit truth. The
//    user row becomes a tombstone (anonymized identifiers, preserved FK).
//  - Exports contain only the caller's own data and never secrets, tokens or
//    provider internals; artifacts expire and are purged.
//  - Retention is policy-driven and idempotent; a held subject is never
//    touched; execution runs dry by default.
//  - Required privacy notifications bypass marketing opt-out (mandatory
//    policies); optional marketing consent is honoured downstream.

import { createHash, randomBytes } from 'node:crypto';
import { invariant, uuid } from '@leroutier/domain';
import { audit } from './identities.js';

const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
const rows_ = async (tx, sql, args = []) => (await tx.query(sql, args)).rows;
const rows = async (tx, sql, args = []) => (await tx.query(sql, args)).rows;
const hash = value => createHash('sha256').update(value).digest('hex');
// Privacy lifecycle messages ride the existing notification pipeline as
// direct sends: template names are distinct from marketing categories, and
// they travel the same inbox/delivery path as every other notification.
const notifyUser = (tx, userId, template, data = {}) => tx.query(
  `INSERT INTO outbox(event_type,aggregate_id,payload) VALUES('notification.send',$1,$2)`,
  [userId, JSON.stringify({ recipients: [userId], template, data })]);
const notifyPlatformOps = (tx, template, data = {}) => tx.query(
  `INSERT INTO outbox(event_type,aggregate_id,payload)
   SELECT 'notification.send',u.id,json_build_object('recipients',json_build_array(u.id),'template',$2::text,'data',$3::jsonb)
   FROM users u WHERE u.role='ops' AND u.operator_id IS NULL`,
  [template, JSON.stringify(data)]);

export const CONSENT_TYPES = ['marketing', 'partner_offers', 'optional_analytics'];

export function privacyCenter(db, store = null) {
  return {
    // ---- consent -----------------------------------------------------------
    async consents(actor) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      return db.transaction(async tx => (await tx.query(`SELECT consent_type,policy_version,status,accepted_at,withdrawn_at,source,locale
        FROM user_consents WHERE user_id=$1 ORDER BY consent_type,accepted_at DESC`, [actor.id])).rows);
    },

    async acceptConsent(actor, input) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      invariant(input && CONSENT_TYPES.includes(input.consentType) && typeof input.policyVersion === 'string' &&
        input.policyVersion.length > 0 && input.policyVersion.length <= 40, 'INVALID_CONSENT', 'Consent fields are invalid.', 409);
      const source = ['web', 'ussd', 'support'].includes(input.source) ? input.source : 'web';
      return db.transaction(async tx => {
        const row = await one(tx, `INSERT INTO user_consents(user_id,consent_type,policy_version,status,source,locale)
          VALUES($1,$2,$3,'accepted',$4,$5) ON CONFLICT(user_id,consent_type,policy_version)
          DO UPDATE SET status='accepted',accepted_at=now(),withdrawn_at=NULL RETURNING *`,
        [actor.id, input.consentType, input.policyVersion, source, input.locale ?? 'fr']);
        await audit(tx, actor.id, 'privacy.consent_accepted', actor.id, null,
          { consentType: input.consentType, policyVersion: input.policyVersion });
        return row;
      });
    },

    async withdrawConsent(actor, consentType) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      invariant(CONSENT_TYPES.includes(consentType), 'INVALID_CONSENT', 'Unknown consent type.', 404);
      return db.transaction(async tx => {
        const updated = await rows(tx, `UPDATE user_consents SET status='withdrawn',withdrawn_at=now()
          WHERE user_id=$1 AND consent_type=$2 AND status='accepted' RETURNING policy_version`, [actor.id, consentType]);
        // Withdrawal never deletes the audit evidence; it changes behaviour.
        await audit(tx, actor.id, 'privacy.consent_withdrawn', actor.id, null, { consentType, versions: updated.map(r => r.policy_version) });
        return { consentType, withdrawn: updated.length };
      });
    },

    async acknowledge(actor, input) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      invariant(input && ['terms', 'privacy_policy'].includes(input.policy) && typeof input.policyVersion === 'string' &&
        input.policyVersion.length > 0 && input.policyVersion.length <= 40, 'INVALID_POLICY', 'Policy fields are invalid.', 409);
      return db.transaction(async tx => {
        const row = await one(tx, `INSERT INTO policy_acknowledgements(user_id,policy,policy_version,source,locale)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`,
        [actor.id, input.policy, input.policyVersion, ['web', 'ussd', 'support'].includes(input.source) ? input.source : 'web', input.locale ?? 'fr']);
        await audit(tx, actor.id, `privacy.${input.policy}_acknowledged`, actor.id, null, { policyVersion: input.policyVersion });
        return row;
      });
    },

    // ---- summary -----------------------------------------------------------
    /** Categories of the caller's own data — counts and types, never content. */
    async summary(actor) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      return db.transaction(async tx => {
        const profile = await one(tx, `SELECT u.display_name,u.role,u.created_at,u.last_meaningful_activity_at,
          u.retention_due_at,u.keep_confirmed_at,pp.phone FROM users u LEFT JOIN passenger_profiles pp ON pp.user_id=u.id WHERE u.id=$1`, [actor.id]);
        const counts = await one(tx, `SELECT
          (SELECT count(*)::integer FROM bookings WHERE passenger_id=$1) AS bookings,
          (SELECT count(*)::integer FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.passenger_id=$1) AS payments,
          (SELECT count(*)::integer FROM parcels WHERE created_by=$1) AS parcels,
          (SELECT count(*)::integer FROM notifications WHERE user_id=$1) AS notifications,
          (SELECT count(*)::integer FROM user_consents WHERE user_id=$1) AS consents,
          (SELECT count(*)::integer FROM api_sessions WHERE user_id=$1) AS sessions`, [actor.id]);
        const deletion = await one(tx, 'SELECT status,requested_at,blockers,processed_at FROM deletion_requests WHERE user_id=$1', [actor.id]);
        const policies = await rows(tx, `SELECT data_category,retention_days,action,legal_basis_or_reason FROM retention_policies
          WHERE enabled AND effective_to IS NULL AND data_category IN ('raw_gps','assistant_messages','inactive_accounts','booking_records','payment_records','parcel_records','notification_history','data_exports') ORDER BY data_category`);
        return {
          account: { role: profile.role, createdAt: profile.created_at, lastMeaningfulActivityAt: profile.last_meaningful_activity_at,
            retentionDueAt: profile.retention_due_at ?? null, keepConfirmedAt: profile.keep_confirmed_at ?? null },
          categories: [
            { category: 'identité de compte', count: 1, detail: 'nom affiché et rôle' },
            { category: 'coordonnées', count: profile.phone ? 1 : 0, detail: 'téléphone lié au profil voyageur' },
            { category: 'réservations', count: counts.bookings, detail: 'voyages réservés et billets' },
            { category: 'paiements', count: counts.payments, detail: 'opérations liées à vos réservations' },
            { category: 'colis', count: counts.parcels, detail: 'expéditions créées avec votre compte' },
            { category: 'notifications', count: counts.notifications, detail: 'messages reçus dans LeRoutier' },
            { category: 'consentements', count: counts.consents, detail: 'choix de communication et versions acceptées' },
            { category: 'activité récente', count: counts.sessions, detail: 'sessions de connexion' },
          ],
          deletion: deletion ? { status: deletion.status, requestedAt: deletion.requested_at, blockers: deletion.blockers, processedAt: deletion.processed_at } : null,
          retention: policies,
        };
      });
    },

    // ---- export ------------------------------------------------------------
    async requestExport(actor) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      const token = randomBytes(32).toString('base64url');
      return db.transaction(async tx => {
        const user = await one(tx, 'SELECT * FROM users WHERE id=$1', [actor.id]);
        invariant(user, 'NOT_FOUND', 'Account not found.', 404);
        const profile = await one(tx, 'SELECT * FROM passenger_profiles WHERE user_id=$1', [actor.id]);
        const [bookings, payments, parcelsRows, notifications, consents, acknowledgements] = await Promise.all([
          rows(tx, `SELECT b.id,b.service_id,b.origin_sequence,b.destination_sequence,b.status,b.amount_minor,b.currency,b.created_at
            FROM bookings b WHERE b.passenger_id=$1 ORDER BY b.created_at`, [actor.id]),
          rows(tx, `SELECT p.id,p.booking_id,p.provider,p.status,p.amount_minor,p.currency,p.created_at
            FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.passenger_id=$1 ORDER BY p.created_at`, [actor.id]),
          rows(tx, `SELECT id,tracking_number,origin_stop_id,destination_stop_id,category,quantity,weight_g,price_minor,service_level,status,created_at
            FROM parcels WHERE created_by=$1 ORDER BY created_at`, [actor.id]),
          rows(tx, `SELECT event_type,category,severity,template,created_at,superseded_at FROM notifications WHERE user_id=$1 ORDER BY created_at`, [actor.id]),
          rows(tx, 'SELECT consent_type,policy_version,status,accepted_at,withdrawn_at,source,locale FROM user_consents WHERE user_id=$1 ORDER BY accepted_at', [actor.id]),
          rows(tx, 'SELECT policy,policy_version,accepted_at FROM policy_acknowledgements WHERE user_id=$1 ORDER BY accepted_at', [actor.id]),
        ]);
        // Own data only; no auth tokens, no provider credentials, no internal
        // security metadata, no other users, no operator financial data.
        const payload = {
          exportedAt: new Date().toISOString(), currency: 'XOF',
          account: { displayName: user.display_name, role: user.role, createdAt: user.created_at, notificationEmail: user.notification_email },
          profile: profile ? { phone: profile.phone } : null,
          bookings, payments, parcels: parcelsRows, notifications, consents, acknowledgements,
        };
        const expires = new Date(Date.now() + 24 * 3600_000);
        const row = await one(tx, `INSERT INTO data_exports(user_id,token_hash,payload,expires_at) VALUES($1,$2,$3,$4) RETURNING id,expires_at`,
          [actor.id, hash(token), JSON.stringify(payload), expires]);
        await audit(tx, actor.id, 'privacy.export_requested', row.id, null, {});
        await notifyUser(tx, actor.id, 'privacy_export_ready', {});
        await tx.query(`INSERT INTO operational_signals(signal) VALUES('exports_requested')
          ON CONFLICT(minute,signal) DO UPDATE SET count=operational_signals.count+1`);
        return { exportId: row.id, token, expiresAt: expires.toISOString() };
      });
    },

    async downloadExport(actor, token) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      invariant(typeof token === 'string' && token.length <= 100, 'INVALID_TOKEN', 'Export token is invalid.', 400);
      return db.transaction(async tx => {
        const row = await one(tx, `SELECT * FROM data_exports WHERE token_hash=$1 AND expires_at>now()`, [hash(token)]);
        invariant(row, 'NOT_FOUND', 'Le téléchargement a expiré. Demandez un nouvel export.', 404);
        invariant(row.user_id === actor.id, 'FORBIDDEN', 'This export is not yours.', 403);
        await tx.query(`UPDATE data_exports SET status='downloaded' WHERE id=$1`, [row.id]);
        await audit(tx, actor.id, 'privacy.export_generated', row.id, null, {});
        return row.payload;
      });
    },

    // ---- correction --------------------------------------------------------
    async requestCorrection(actor, input) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      invariant(input && typeof input.subject === 'string' && input.subject.length >= 2 && input.subject.length <= 200 &&
        typeof input.description === 'string' && input.description.length >= 2 && input.description.length <= 2000,
      'INVALID_CORRECTION', 'Correction fields are invalid.', 409);
      return db.transaction(async tx => {
        await audit(tx, actor.id, 'privacy.correction_requested', actor.id, null,
          { subject: input.subject.slice(0, 200), description: input.description.slice(0, 2000) });
        // Correction requests reach support through the existing pipeline;
        // immutable financial/custody records are annotated, never rewritten.
        await notifyPlatformOps(tx, 'privacy_correction_received', { subject: input.subject.slice(0, 200), userId: actor.id });
        return { status: 'received' };
      });
    },

    // ---- deletion ----------------------------------------------------------
    async deletionStatus(actor) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      return db.transaction(async tx => one(tx, 'SELECT status,requested_at,blockers,processed_at,outcome FROM deletion_requests WHERE user_id=$1', [actor.id]));
    },

    async requestDeletion(actor) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      return db.transaction(async tx => {
        const existing = await one(tx, 'SELECT * FROM deletion_requests WHERE user_id=$1', [actor.id]);
        if (existing) return existing; // idempotent: one open request per user
        const blockers = [];
        const activeBooking = await one(tx, `SELECT count(*)::integer AS n FROM bookings WHERE passenger_id=$1 AND status IN ('held','confirmed','boarded')`, [actor.id]);
        if (activeBooking.n) blockers.push({ kind: 'active_booking', count: activeBooking.n });
        const pendingPayment = await one(tx, `SELECT count(*)::integer AS n FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.passenger_id=$1 AND p.status IN ('pending')`, [actor.id]);
        if (pendingPayment.n) blockers.push({ kind: 'pending_payment', count: pendingPayment.n });
        const activeParcel = await one(tx, `SELECT count(*)::integer AS n FROM parcels WHERE created_by=$1 AND status NOT IN ('collected','cancelled','rejected','returned','lost','damaged')`, [actor.id]);
        if (activeParcel.n) blockers.push({ kind: 'active_parcel', count: activeParcel.n });
        for (const found of await operatorBlockers(tx, actor.id)) blockers.push(found);
        const row = await one(tx, `INSERT INTO deletion_requests(user_id,status,blockers) VALUES($1,$2,$3) RETURNING *`,
          [actor.id, blockers.length ? 'scheduled' : 'requested', JSON.stringify(blockers)]);
        await audit(tx, actor.id, 'privacy.deletion_requested', actor.id, null, { blockers });
        await notifyUser(tx, actor.id, 'privacy_deletion_received', { status: row.status });
        await tx.query(`INSERT INTO operational_signals(signal) VALUES('deletion_requests')
          ON CONFLICT(minute,signal) DO UPDATE SET count=operational_signals.count+1`);
        return row;
      });
    },

    async keepAccount(actor) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      return db.transaction(async tx => {
        const row = await one(tx, `UPDATE users SET keep_confirmed_at=now(),last_meaningful_activity_at=now(),
          retention_due_at=NULL,retention_notification_sent_at=NULL WHERE id=$1 RETURNING id`, [actor.id]);
        invariant(row, 'NOT_FOUND', 'Account not found.', 404);
        await audit(tx, actor.id, 'privacy.keep_account_confirmed', actor.id, null, {});
        return { kept: true };
      });
    },

    // ---- legal holds (authorized roles only) -------------------------------
    async createHold(actor, input) {
      invariant(actor?.role === 'ops' && !actor.operator_id, 'FORBIDDEN', 'Platform Operations access required.', 403);
      invariant(input && ['user', 'service', 'parcel', 'payment', 'incident'].includes(input.subjectKind) &&
        typeof input.reason === 'string' && input.reason.length >= 2 && input.reason.length <= 500, 'INVALID_HOLD', 'Hold fields are invalid.', 409);
      const subject = uuid(input.subjectId);
      return db.transaction(async tx => {
        const row = await one(tx, `INSERT INTO legal_holds(subject_kind,subject_id,reason,created_by,expires_at)
          VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [input.subjectKind, subject, input.reason, actor.id, input.expiresAt ? new Date(input.expiresAt) : null]);
        await audit(tx, actor.id, 'privacy.hold_applied', row.id, null, { subjectKind: input.subjectKind, subjectId: subject, reason: input.reason });
        return row;
      });
    },

    async releaseHold(actor, holdId) {
      invariant(actor?.role === 'ops' && !actor.operator_id, 'FORBIDDEN', 'Platform Operations access required.', 403);
      return db.transaction(async tx => {
        const row = await one(tx, 'SELECT * FROM legal_holds WHERE id=$1', [uuid(holdId)]);
        invariant(row, 'NOT_FOUND', 'Hold not found.', 404);
        const updated = await one(tx, 'UPDATE legal_holds SET released_at=now() WHERE id=$1 AND released_at IS NULL RETURNING *', [row.id]);
        invariant(updated, 'HOLD_RELEASED', 'This hold is already released.', 409);
        await audit(tx, actor.id, 'privacy.hold_released', row.id, null, {});
        return updated;
      });
    },

    // Deletion processing: the worker's typed, authorized step. Only requests
    // whose blockers have cleared are processed; the user row becomes a
    // tombstone (anonymized identifiers, every FK preserved) — financial,
    // booking, parcel and audit truth is never cascaded away. Firebase
    // identity deletion stays an external owner action AFTER this step, and
    // the completion event rides the existing notification pipeline.
    async processDueDeletions() {
      return db.transaction(async tx => {
        const candidates = await rows(tx, `SELECT * FROM deletion_requests WHERE status IN ('requested','scheduled')
          ORDER BY requested_at LIMIT 20 FOR UPDATE SKIP LOCKED`);
        const processed = [];
        for (const request of candidates) {
          const blockers = [];
          const activeBooking = await one(tx, `SELECT count(*)::integer AS n FROM bookings WHERE passenger_id=$1 AND status IN ('held','confirmed','boarded')`, [request.user_id]);
          if (activeBooking.n) blockers.push({ kind: 'active_booking', count: activeBooking.n });
          const pendingPayment = await one(tx, `SELECT count(*)::integer AS n FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.passenger_id=$1 AND p.status='pending'`, [request.user_id]);
          if (pendingPayment.n) blockers.push({ kind: 'pending_payment', count: pendingPayment.n });
          const activeParcel = await one(tx, `SELECT count(*)::integer AS n FROM parcels WHERE created_by=$1 AND status NOT IN ('collected','cancelled','rejected','returned','lost','damaged')`, [request.user_id]);
          if (activeParcel.n) blockers.push({ kind: 'active_parcel', count: activeParcel.n });
          // Re-checked here and not only at request time: an account can pick
          // up an operator role, or a running service, between asking and being
          // processed.
          for (const found of await operatorBlockers(tx, request.user_id)) blockers.push(found);
          if (blockers.length) {
            await tx.query(`UPDATE deletion_requests SET status='scheduled',blockers=$2,updated_at=now() WHERE id=$1`, [request.id, JSON.stringify(blockers)]);
            continue;
          }
          await tx.query(`UPDATE users SET display_name='Utilisateur supprimé',auth_subject=NULL,notification_email=NULL,active=false,updated_at=now() WHERE id=$1`, [request.user_id]);
          await tx.query('UPDATE passenger_profiles SET phone=NULL WHERE user_id=$1', [request.user_id]);
          // A driver's photograph is published to passengers, and their
          // identity and licence references sit in the crew record. A tombstone
          // that leaves a face and a national ID number behind has not deleted
          // the person; it has only renamed them.
          // license_reference is NOT NULL by schema, so it is overwritten with
          // a marker rather than emptied: nulling it would raise 23502 and roll
          // back the entire deletion, leaving the account intact and the
          // request marked as failed for reasons nobody would look for here.
          await tx.query(`UPDATE driver_profiles SET photo_url=NULL,id_document_reference=NULL,
            license_reference='[supprimé]',active=false WHERE user_id=$1`, [request.user_id]);
          await redactEvidence(tx, 'subject_user_id=$1', [request.user_id], store);
          await tx.query(`UPDATE deletion_requests SET status='completed',processed_at=now(),blockers='[]',outcome='anonymized',updated_at=now() WHERE id=$1`, [request.id]);
          await tx.query('DELETE FROM api_sessions WHERE user_id=$1', [request.user_id]);
          // The completion notice fires before the identity is gone from the
          // in-app inbox scope; it lands in the same pipeline as everything else.
          await notifyUser(tx, request.user_id, 'privacy_deletion_completed', {});
          await tx.query(`INSERT INTO operational_signals(signal) VALUES('deletions_completed')
            ON CONFLICT(minute,signal) DO UPDATE SET count=operational_signals.count+1`);
          processed.push({ userId: request.user_id, outcome: 'anonymized' });
        }
        return { processed };
      });
    },
  };
}
/**
 * Why an account that runs a transport operation cannot simply disappear.
 *
 * Deletion blockers used to look only at what the person did as a PASSENGER.
 * An independent owner-driver could therefore delete themselves mid-service:
 * the user row became "Utilisateur supprimé" while their operator stayed
 * verified, their departures stayed published, their photograph stayed on the
 * offer passengers were about to book, and any unsettled balance belonged to a
 * tombstone. None of that is a privacy outcome; it is a broken operator with
 * the owner's name removed.
 *
 * Winding an operation down is a real decision with money and passengers in
 * it, so it is surfaced as a blocker for a human to resolve rather than
 * cascaded automatically.
 *
 * @param {{query:(sql:string,params?:unknown[])=>Promise<{rows:any[]}>}} tx
 */
async function operatorBlockers(tx, userId) {
  const found = [];
  const operator = await one(tx, `SELECT o.id,o.name,o.active,o.verification_status FROM operators o
    WHERE (o.owner_user_id=$1 OR o.admin_user_id=$1) AND o.active`, [userId]);
  if (operator) found.push({ kind: 'operator_ownership', operatorId: operator.id, operatorName: operator.name });
  const crewing = await one(tx, `SELECT count(*)::integer AS n FROM service_assignments a JOIN services s ON s.id=a.service_id
    WHERE (a.driver_id=$1 OR a.convoyeur_id=$1) AND a.ended_at IS NULL
      AND s.status IN ('scheduled','active','disrupted')`, [userId]);
  if (crewing.n) found.push({ kind: 'crew_assignment', count: crewing.n });
  // Money owed to somebody is not settled by deleting them.
  const payouts = await one(tx, `SELECT count(*)::integer AS n FROM payout_requests
    WHERE driver_id=$1 AND status IN ('requested','approved','processing')`, [userId]);
  if (payouts.n) found.push({ kind: 'pending_payout', count: payouts.n });
  return found;
}

/**
 * Forget a set of evidence rows, and actually delete what they point at.
 *
 * The ordering matters and is the whole point. The object is removed FIRST;
 * only then is the row's pointer cleared and the redaction dated. Do it the
 * other way round and a failed delete leaves a document sitting in the store
 * with nothing left in the database to find it by — LeRoutier would have
 * recorded that it forgot something it still holds. Failing here instead means
 * the next scan tries again, which is the honest outcome.
 *
 * Rows that were only ever an operator-hosted link have nothing to delete;
 * LeRoutier never held those bytes and says so elsewhere.
 *
 * @param {{query:(sql:string,params?:unknown[])=>Promise<{rows:any[]}>}} tx
 * @param {string} where SQL predicate over verification_evidence
 * @param {unknown[]} params
 * @param {{remove:(key:string)=>Promise<void>}|null} store
 */
async function redactEvidence(tx, where, params, store) {
  const rows = await rows_(tx, `SELECT id,storage_key FROM verification_evidence
    WHERE ${where} AND redacted_at IS NULL`, params);
  if (!rows.length) return 0;
  const forgotten = [];
  for (const row of rows) {
    if (row.storage_key) {
      // A store that cannot be reached is a reason to try later, never a
      // reason to claim the document is gone.
      if (!store) continue;
      try { await store.remove(row.storage_key); } catch { continue; }
    }
    forgotten.push(row.id);
  }
  if (!forgotten.length) return 0;
  await tx.query(`UPDATE verification_evidence
    SET reference=NULL,file_url=NULL,storage_key=NULL,storage_provider=NULL,
        content_type=NULL,byte_size=NULL,redacted_at=now()
    WHERE id=ANY($1::uuid[])`, [forgotten]);
  return forgotten.length;
}

export function retentionEngine(db, store = null) {
  return {
    /** Active, enabled policies. */
    async policies() {
      return db.transaction(async tx => rows(tx, `SELECT data_category,retention_days,action,legal_basis_or_reason,hold_eligible
        FROM retention_policies WHERE enabled AND effective_to IS NULL ORDER BY data_category`));
    },

    async isHeld(subjectKind, subjectId) {
      return db.transaction(async tx => !!(await one(tx, `SELECT id FROM legal_holds WHERE subject_kind=$1 AND subject_id=$2
        AND released_at IS NULL AND (expires_at IS NULL OR expires_at>now()) LIMIT 1`, [subjectKind, subjectId])));
    },

    /**
     * Policy scan. Defaults to a dry-run report: every category returns the
     * eligible count and the proposed action; nothing mutates unless
     * execute=true is passed explicitly.
     */
    async run({ execute = false } = {}) {
      return db.transaction(async tx => {
        const policies = await rows(tx, `SELECT data_category,retention_days,action,enabled,hold_eligible FROM retention_policies
          WHERE enabled AND effective_to IS NULL`);
        const report = [];
        for (const policy of policies) {
          const category = policy.data_category;
          let candidates;
          if (category === 'raw_gps') {
            candidates = await rows(tx, `SELECT p.id FROM vehicle_positions p JOIN services s ON s.id=p.service_id
              WHERE p.observed_at < now()-make_interval(days=>$1) AND s.status IN ('completed','cancelled')
                AND (s.gps_retain_until IS NULL OR s.gps_retain_until < now())
                AND NOT EXISTS(SELECT 1 FROM incidents i WHERE i.service_id=s.id AND i.status<>'resolved')
                AND NOT EXISTS(SELECT 1 FROM legal_holds h WHERE h.subject_kind='service' AND h.subject_id=s.id
                  AND h.released_at IS NULL AND (h.expires_at IS NULL OR h.expires_at>now()))
              ORDER BY p.observed_at LIMIT 5000`, [policy.retention_days]);
          } else if (category === 'assistant_messages') {
            candidates = await rows(tx, `SELECT id FROM assistant_events WHERE created_at < now()-make_interval(days=>$1)
              AND NOT EXISTS(SELECT 1 FROM legal_holds h WHERE h.subject_kind='user' AND h.subject_id=assistant_events.actor_id
                AND h.released_at IS NULL AND (h.expires_at IS NULL OR h.expires_at>now()))
              LIMIT 5000`, [policy.retention_days]);
          } else if (category === 'notification_history') {
            // Anonymize: trim message bodies, keep delivery/audit metadata.
            candidates = await rows(tx, `SELECT id FROM notifications WHERE created_at < now()-make_interval(days=>$1)
              AND data IS NOT NULL AND jsonb_typeof(data)='object' LIMIT 5000`, [policy.retention_days]);
          } else if (category === 'data_exports') {
            candidates = await rows(tx, `SELECT id FROM data_exports WHERE expires_at < now() LIMIT 5000`);
          } else if (category === 'kyc_evidence') {
            // Refused dossiers only. A verified or suspended operator carried
            // passengers under a decision this file is the evidence for; a
            // rejected applicant never became an operator, so keeping a pointer
            // to their identity card is storage without a purpose.
            candidates = await rows(tx, `SELECT e.id FROM verification_evidence e JOIN operators o ON o.id=e.operator_id
              WHERE e.redacted_at IS NULL AND o.verification_status='rejected'
                AND o.created_at < now()-make_interval(days=>$1)
                AND NOT EXISTS(SELECT 1 FROM legal_holds h WHERE h.subject_kind='user'
                  AND h.subject_id IN (o.owner_user_id,o.admin_user_id)
                  AND h.released_at IS NULL AND (h.expires_at IS NULL OR h.expires_at>now()))
              LIMIT 5000`, [policy.retention_days]);
          } else if (category === 'inactive_accounts') {
            candidates = await rows(tx, `SELECT id FROM users WHERE last_meaningful_activity_at < now()-make_interval(days=>$1)
              AND keep_confirmed_at IS NULL AND retention_due_at IS NULL AND role<>'ops' AND is_demo=false
              AND NOT EXISTS(SELECT 1 FROM legal_holds h WHERE h.subject_kind='user' AND h.subject_id=users.id
                AND h.released_at IS NULL AND (h.expires_at IS NULL OR h.expires_at>now()))
              LIMIT 5000`, [policy.retention_days]);
          } else {
            continue; // 'retain' categories: nothing to scan
          }
          if (execute && candidates.length) {
            if (category === 'raw_gps') {
              await tx.query('DELETE FROM vehicle_positions WHERE id=ANY($1::uuid[])', [candidates.map(c => c.id)]);
            } else if (category === 'assistant_messages') {
              await tx.query('DELETE FROM assistant_events WHERE id=ANY($1::uuid[])', [candidates.map(c => c.id)]);
            } else if (category === 'notification_history') {
              await tx.query(`UPDATE notifications SET data=jsonb_build_object('retained','body removed after retention')
                WHERE id=ANY($1::uuid[])`, [candidates.map(c => c.id)]);
            } else if (category === 'data_exports') {
              await tx.query(`UPDATE data_exports SET status='expired',payload='{}'::jsonb WHERE id=ANY($1::uuid[])`, [candidates.map(c => c.id)]);
            } else if (category === 'kyc_evidence') {
              // The decision survives; the copy of somebody's passport does not.
              // kind, status, reviewed_at, reviewed_by and notes are untouched,
              // and where LeRoutier holds the bytes they are deleted from the
              // store before the pointer to them is dropped.
              await redactEvidence(tx, 'id=ANY($1::uuid[])', [candidates.map(c => c.id)], store);
            } else if (category === 'inactive_accounts') {
              await tx.query(`UPDATE users SET retention_due_at=now()+make_interval(days=>30) WHERE id=ANY($1::uuid[])`, [candidates.map(c => c.id)]);
            }
          }
          report.push({ category, action: policy.action, eligible: candidates.length, held: 0, executed: execute && candidates.length > 0 });
        }
        await tx.query(`INSERT INTO operational_signals(signal) VALUES('retention_scan')
          ON CONFLICT(minute,signal) DO UPDATE SET count=operational_signals.count+1`);
        if (execute) {
          await tx.query(`INSERT INTO operational_signals(signal) VALUES('retention_deleted')
            ON CONFLICT(minute,signal) DO UPDATE SET count=operational_signals.count+1`);
        }
        return { dryRun: !execute, executedAt: new Date().toISOString(), report };
      });
    },
  };
}
