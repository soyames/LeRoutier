import { createHash } from 'node:crypto';
import { invariant, uuid, idempotencyKey } from '@leroutier/domain';
import { audit, activeIdentity } from './identities.js';

// Onboarding & membership: one canonical operator model differentiated by
// type. A transport company onboards as an operator with an admin Ops
// identity; an independent owner-driver onboards as ONE identity that is
// simultaneously the operator owner and the driver. No second business-
// account concept, no shared staff accounts, no self-promotion.
const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');

export function onboarding(db) {
  async function eligible(tx, actor) {
    const user = await activeIdentity(tx, actor.id);
    invariant(user.role === 'passenger' && !user.is_demo, 'FORBIDDEN', 'This account already has an operational role.', 403);
    invariant(!user.needs_profile, 'PROFILE_REQUIRED', 'Complete your passenger profile first.', 409);
    return user;
  }
  async function operatorView(tx, actor) {
    const operator = await one(tx, 'SELECT * FROM operators WHERE id=$1', [actor.operator_id ?? null]);
    return operator ?? null;
  }
  return {
    // The authenticated identity's current onboarding/membership state.
    async state(actor) {
      return db.transaction(async tx => {
        const user = await activeIdentity(tx, actor.id);
        const operator = await operatorView(tx, user);
        let membership = null;
        if (operator) {
          membership = {
            operatorId: operator.id, operatorName: operator.name, operatorType: operator.type,
            verificationStatus: operator.verification_status, payoutReady: operator.payout_ready,
            role: user.role, isOwner: operator.owner_user_id === user.id, isAdmin: operator.admin_user_id === user.id,
          };
        }
        return { role: user.role, displayName: user.display_name, needsProfile: user.needs_profile, membership };
      });
    },
    // Company onboarding: creates a company operator and promotes this
    // identity to its admin Ops user. Verification happens afterwards via
    // the platform verification transition — never self-granted.
    async startCompany(actor, input, key) {
      invariant(actor?.role === 'passenger', 'FORBIDDEN', 'Passenger access required.', 403);
      idempotencyKey(key);
      invariant(input && Object.keys(input).every(k => ['displayName', 'contactPhone', 'country', 'registrationRef'].includes(k)),
        'INVALID_ONBOARDING', 'Unexpected onboarding fields.');
      invariant(typeof input.displayName === 'string' && input.displayName.trim().length >= 2 && input.displayName.length <= 200,
        'INVALID_ONBOARDING', 'A company display name is required.');
      invariant(typeof input.contactPhone === 'string' && /^\+?[0-9 ()-]{6,25}$/.test(input.contactPhone),
        'INVALID_ONBOARDING', 'A valid contact phone is required.');
      invariant(typeof input.country === 'string' && /^[a-z]{2}$/i.test(input.country), 'INVALID_ONBOARDING', 'Country is invalid.');
      const registrationRef = input.registrationRef === undefined || input.registrationRef === null ? null : String(input.registrationRef);
      invariant(registrationRef === null || (registrationRef.trim().length >= 2 && registrationRef.length <= 200),
        'INVALID_ONBOARDING', 'Registration reference is invalid.');
      void digest;
      return db.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['onboarding:' + actor.id + ':' + key]);
        // Idempotent replay is checked first: after onboarding the actor no
        // longer has a passenger role, so eligibility cannot be re-asserted.
        const prior = await one(tx, "SELECT * FROM audit_events WHERE actor_id=$1 AND action='operator.onboarded' AND details->>'key'=$2", [actor.id, key]);
        if (prior) {
          const existing = await one(tx, 'SELECT * FROM operators WHERE admin_user_id=$1', [actor.id]);
          if (existing) return { operatorId: existing.id, status: existing.verification_status, role: 'ops', alreadyOnboarded: true };
        }
        const user = await eligible(tx, actor);
        const operator = await one(tx, `INSERT INTO operators(name,type,admin_user_id,verification_status,contact_phone,country,registration_ref)
          VALUES($1,'company',$2,'pending_verification',$3,$4,$5) RETURNING *`,
        [input.displayName.trim(), actor.id, input.contactPhone.trim(), input.country.toLowerCase(), registrationRef === null ? null : registrationRef.trim()]);
        await tx.query(`UPDATE users SET role='ops',operator_id=$2,display_name=$3,profile_completed_at=now(),updated_at=now() WHERE id=$1`, [actor.id, operator.id, user.display_name || input.displayName.trim()]);
        await audit(tx, actor.id, 'operator.onboarded', operator.id, operator.id, { key, type: 'company' });
        await audit(tx, actor.id, 'identity.role_assigned', actor.id, operator.id, { role: 'ops', via: 'company_onboarding' });
        await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)',
          ['operator.onboarded', operator.id, JSON.stringify({ operatorId: operator.id, type: 'company' })]);
        return { operatorId: operator.id, status: operator.verification_status, role: 'ops' };
      });
    },
    // Independent owner-driver onboarding: ONE identity becomes the owner of
    // a type=independent operator and the driver of that same operator.
    async startIndependent(actor, input, key) {
      invariant(actor?.role === 'passenger', 'FORBIDDEN', 'Passenger access required.', 403);
      idempotencyKey(key);
      invariant(input && Object.keys(input).every(k => ['displayName', 'phone', 'country', 'licenseReference', 'vehicleRegistration', 'vehicleCapacity'].includes(k)),
        'INVALID_ONBOARDING', 'Unexpected onboarding fields.');
      invariant(typeof input.displayName === 'string' && input.displayName.trim().length >= 2 && input.displayName.length <= 200,
        'INVALID_ONBOARDING', 'A name is required.');
      invariant(typeof input.phone === 'string' && /^\+?[0-9 ()-]{6,25}$/.test(input.phone), 'INVALID_ONBOARDING', 'A valid phone is required.');
      invariant(typeof input.country === 'string' && /^[a-z]{2}$/i.test(input.country), 'INVALID_ONBOARDING', 'Country is invalid.');
      invariant(typeof input.licenseReference === 'string' && input.licenseReference.trim().length >= 2 && input.licenseReference.length <= 100,
        'INVALID_ONBOARDING', 'A licence reference is required.');
      const registration = input.vehicleRegistration === undefined || input.vehicleRegistration === null ? null : String(input.vehicleRegistration);
      invariant(registration === null || (registration.trim().length >= 2 && registration.length <= 50),
        'INVALID_ONBOARDING', 'Vehicle registration is invalid.');
      const capacity = input.vehicleCapacity === undefined || input.vehicleCapacity === null ? null : Number(input.vehicleCapacity);
      invariant(capacity === null || (Number.isInteger(capacity) && capacity >= 1 && capacity <= 100), 'INVALID_ONBOARDING', 'Vehicle capacity is invalid.');
      return db.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['onboarding:' + actor.id + ':' + key]);
        // Idempotent replay is checked first: after onboarding the actor no
        // longer has a passenger role, so eligibility cannot be re-asserted.
        const prior = await one(tx, "SELECT * FROM audit_events WHERE actor_id=$1 AND action='operator.onboarded' AND details->>'key'=$2", [actor.id, key]);
        if (prior) {
          const existing = await one(tx, 'SELECT * FROM operators WHERE owner_user_id=$1', [actor.id]);
          if (existing) return { operatorId: existing.id, status: existing.verification_status, role: 'driver', alreadyOnboarded: true };
        }
        await eligible(tx, actor);
        const operator = await one(tx, `INSERT INTO operators(name,type,owner_user_id,admin_user_id,verification_status,contact_phone,country)
          VALUES($1,'independent',$2,$2,'pending_verification',$3,$4) RETURNING *`,
        [input.displayName.trim(), actor.id, input.phone.trim(), input.country.toLowerCase()]);
        await tx.query(`UPDATE users SET role='driver',operator_id=$2,display_name=$3,profile_completed_at=now(),updated_at=now() WHERE id=$1`, [actor.id, operator.id, input.displayName.trim()]);
        await tx.query(`INSERT INTO driver_profiles(user_id,operator_id,license_reference,active) VALUES($1,$2,$3,true)
          ON CONFLICT(user_id) DO UPDATE SET license_reference=EXCLUDED.license_reference,active=true`, [actor.id, operator.id, input.licenseReference.trim()]);
        let vehicleId = null;
        if (registration !== null && capacity !== null) {
          const vehicle = await one(tx, `INSERT INTO vehicles(operator_id,registration,capacity,status) VALUES($1,$2,$3,'active')
            ON CONFLICT(registration) DO NOTHING RETURNING id`, [operator.id, registration.trim(), capacity]);
          vehicleId = vehicle?.id ?? (await one(tx, 'SELECT id FROM vehicles WHERE registration=$1', [registration.trim()])).id;
        }
        await audit(tx, actor.id, 'operator.onboarded', operator.id, operator.id, { key, type: 'independent', vehicleId });
        await audit(tx, actor.id, 'identity.role_assigned', actor.id, operator.id, { role: 'driver', via: 'independent_onboarding' });
        await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)',
          ['operator.onboarded', operator.id, JSON.stringify({ operatorId: operator.id, type: 'independent' })]);
        return { operatorId: operator.id, status: operator.verification_status, role: 'driver', vehicleId };
      });
    },
    async updateProfile(actor, input) {
      invariant(input && Object.keys(input).every(k => ['contactPhone', 'country', 'registrationRef', 'displayName'].includes(k)),
        'INVALID_PROFILE', 'Unexpected profile fields.');
      return db.transaction(async tx => {
        const user = await activeIdentity(tx, actor.id);
        const operator = await operatorView(tx, user);
        invariant(operator, 'NOT_FOUND', 'No operator membership found.', 404);
        invariant(operator.admin_user_id === user.id || operator.owner_user_id === user.id, 'FORBIDDEN', 'Only the operator owner or admin can edit the profile.', 403);
        const sets = [], args = [operator.id];
        if (input.contactPhone !== undefined) {
          invariant(typeof input.contactPhone === 'string' && /^\+?[0-9 ()-]{6,25}$/.test(input.contactPhone), 'INVALID_PROFILE', 'Contact phone is invalid.');
          sets.push(`contact_phone=$${args.push(input.contactPhone.trim())}`);
        }
        if (input.country !== undefined) {
          invariant(typeof input.country === 'string' && /^[a-z]{2}$/i.test(input.country), 'INVALID_PROFILE', 'Country is invalid.');
          sets.push(`country=$${args.push(input.country.toLowerCase())}`);
        }
        if (input.registrationRef !== undefined) {
          const ref = input.registrationRef === null ? null : String(input.registrationRef);
          invariant(ref === null || (ref.trim().length >= 2 && ref.length <= 200), 'INVALID_PROFILE', 'Registration reference is invalid.');
          sets.push(`registration_ref=$${args.push(ref === null ? null : ref.trim())}`);
        }
        if (input.displayName !== undefined) {
          invariant(typeof input.displayName === 'string' && input.displayName.trim().length >= 2 && input.displayName.length <= 200, 'INVALID_PROFILE', 'Name is invalid.');
          sets.push(`name=$${args.push(input.displayName.trim())}`);
        }
        if (!sets.length) return operator;
        const row = await one(tx, `UPDATE operators SET ${sets.join(',')} WHERE id=$1 RETURNING *`, args);
        await audit(tx, actor.id, 'operator.profile_updated', operator.id, operator.id);
        return row;
      });
    },
    // Platform verification transition: platform-scoped Ops only. Local
    // company admins can never verify themselves.
    async verification(actor, operatorId, decision) {
      invariant(actor?.role === 'ops' && !actor.operator_id, 'FORBIDDEN', 'Only platform operations can change verification.', 403);
      invariant(['verified', 'rejected', 'suspended'].includes(decision), 'INVALID_DECISION', 'Decision must be verified, rejected or suspended.');
      return db.transaction(async tx => {
        const operator = await one(tx, 'SELECT * FROM operators WHERE id=$1 FOR UPDATE', [uuid(operatorId)]);
        invariant(operator, 'NOT_FOUND', 'Operator not found.', 404);
        const row = await one(tx, 'UPDATE operators SET verification_status=$2 WHERE id=$1 RETURNING *', [operator.id, decision]);
        await audit(tx, actor.id, 'operator.verification_changed', operator.id, null, { from: operator.verification_status, to: decision });
        await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)',
          ['operator.verification_changed', operator.id, JSON.stringify({ operatorId: operator.id, status: decision })]);
        return { operatorId: row.id, verificationStatus: row.verification_status };
      });
    },
    // Membership listing for an operator (company admin/ops or platform ops).
    async members(actor, operatorId) {
      const id = uuid(operatorId);
      return db.transaction(async tx => {
        const user = await activeIdentity(tx, actor.id);
        if (user.operator_id) invariant(user.operator_id === id, 'FORBIDDEN', 'Operation is not permitted.', 403);
        return (await tx.query(`SELECT u.id,u.display_name,u.role,u.active,u.operator_id,d.license_reference,d.active AS driver_active,c.active AS convoyeur_active,
          o.type AS operator_type,o.verification_status,o.owner_user_id,o.admin_user_id FROM users u
          JOIN operators o ON o.id=u.operator_id
          LEFT JOIN driver_profiles d ON d.user_id=u.id LEFT JOIN convoyeur_profiles c ON c.user_id=u.id
          WHERE u.operator_id=$1 AND u.role IN ('ops','driver','convoyeur') ORDER BY u.display_name`, [id])).rows;
      });
    },
    async listOperators(actor) {
      invariant(actor?.role === 'ops' && !actor.operator_id, 'FORBIDDEN', 'Only platform operations can list operators.', 403);
      return db.transaction(async tx => (await tx.query(`SELECT id,name,type,verification_status,contact_phone,country,active,owner_user_id,admin_user_id,created_at
        FROM operators ORDER BY created_at DESC LIMIT 200`)).rows);
    },
  };
}
