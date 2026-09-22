import { invariant } from '@leroutier/domain';
import { assertRegistrationOpen } from './registration.js';
import { platformCapabilities } from './platform-access.js';

export async function audit(tx,actorId,action,entityId,operatorId=null,details={}) {
  await tx.query('INSERT INTO audit_events(actor_id,action,entity_id,operator_id,details) VALUES($1,$2,$3,$4,$5)',
    [actorId,action,entityId,operatorId,JSON.stringify(details)]);
  // The audit trail is also the domain event stream. Details travel with the
  // event so notification policies can match on them and render real content;
  // actorId/operatorId stay authoritative and are never overwritten by details.
  await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)',
    [action,entityId,JSON.stringify({...details,actorId,operatorId})]);
}

export async function activeIdentity(tx,id) {
  const user=(await tx.query(`SELECT u.id,u.auth_subject,u.auth_issuer,u.display_name,u.role,u.operator_id,u.active,u.is_demo,u.profile_completed_at,p.phone,
    d.active AS driver_active,c.active AS convoyeur_active,o.active AS operator_active,o.type AS operator_type,o.verification_status,
    o.owner_user_id,o.name AS operator_name FROM users u
    LEFT JOIN passenger_profiles p ON p.user_id=u.id LEFT JOIN driver_profiles d ON d.user_id=u.id
    LEFT JOIN convoyeur_profiles c ON c.user_id=u.id
    LEFT JOIN operators o ON o.id=u.operator_id WHERE u.id=$1`,[id])).rows[0];
  invariant(user && user.active && (!user.operator_id || user.operator_active) &&
    (user.role!=='driver' || user.driver_active) && (user.role!=='convoyeur' || user.convoyeur_active),
  'ACCOUNT_DISABLED','This account is inactive. Contact an administrator.',403);
  // Platform capabilities are resolved HERE, on every request, so revoking a
  // grant takes effect at the next call rather than at the next deployment or
  // the next sign-in. Empty for everybody who is not LeRoutier staff, which is
  // almost everybody — see platform-access.js.
  const platform_capabilities=await platformCapabilities(tx,user);
  return {...user,platform_capabilities,
    needs_profile:user.role==='passenger' && !user.profile_completed_at && !user.is_demo};
}

/**
 * Whether an identity runs an operator's own inventory.
 *
 * Two shapes qualify, and the second is the one that was missing everywhere:
 *
 *   role='ops'  — a company's operations staff, or Platform Ops.
 *   role='driver' AND owner of an INDEPENDENT operator — a one-person operator
 *   where the owner is also the driver, because a service assignment names a
 *   driver and they have to be one.
 *
 * Asking for role='ops' alone read as "is this person operations", and for an
 * independent owner the honest answer is yes: there is nobody else. Every
 * caller still scopes to a specific operator afterwards; this only decides
 * whether the identity manages any operator at all.
 *
 * @param {{role?:string,operator_type?:string,owner_user_id?:string,id?:string}} user
 */
export const managesOperator = user =>
  user?.role === 'ops' ||
  (user?.role === 'driver' && user?.operator_type === 'independent' && user?.owner_user_id === user?.id);

export async function mapIdentity(db,{subject,issuer,notificationEmail=null}) {
  invariant(typeof subject==='string' && subject.length>0 && subject.length<=255,'UNAUTHORIZED','Invalid identity.',401);
  return db.transaction(async tx=>{
    // An identity that already exists always signs in: registration capacity
    // never locks anybody out of an account they already have. Only the
    // creation of a NEW identity is gated, and the gate is measured inside
    // this transaction under an advisory lock so concurrent first sign-ins
    // cannot each read the same "still under threshold" and overshoot it.
    const known=(await tx.query('SELECT id FROM users WHERE auth_subject=$1',[subject])).rows[0];
    if(!known) await assertRegistrationOpen(tx);
    const inserted=(await tx.query(`INSERT INTO users(auth_subject,auth_issuer,display_name,role)
      VALUES($1,$2,'','passenger') ON CONFLICT(auth_subject) DO NOTHING RETURNING id`,[subject,issuer])).rows[0];
    const user=(await tx.query('SELECT id,auth_issuer FROM users WHERE auth_subject=$1',[subject])).rows[0];
    invariant(user && user.auth_issuer===issuer,'UNAUTHORIZED','Identity is not registered with this issuer.',401);
    await tx.query('UPDATE users SET notification_email=$2 WHERE id=$1 AND notification_email IS DISTINCT FROM $2',[user.id,notificationEmail]);
    // Last sign-in, refreshed at most once an hour. This runs on EVERY
    // authenticated request, so an unconditional write would add a row update
    // per API call to the same bounded allowance that registration capacity
    // exists to protect. An hour is precise enough to answer "is this account
    // still in use", which is the only question it is asked.
    await tx.query(`UPDATE users SET last_authenticated_at=now() WHERE id=$1
      AND (last_authenticated_at IS NULL OR last_authenticated_at < now()-interval '1 hour')`,[user.id]);
    if(inserted) {
      await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1)',[user.id]);
      await audit(tx,user.id,'identity.onboarded',user.id);
    }
    return activeIdentity(tx,user.id);
  });
}

export async function updateProfile(db,actor,input) {
  invariant(input && Object.keys(input).every(k=>['displayName','phone'].includes(k)),
    'INVALID_PROFILE','Only name and phone can be updated.');
  invariant(typeof input.displayName==='string' && input.displayName.trim().length>=2 && input.displayName.length<=100,
    'INVALID_PROFILE','Enter a name between 2 and 100 characters.');
  invariant(input.phone===undefined || input.phone===null || (typeof input.phone==='string' && /^\+?[0-9 ()-]{6,25}$/.test(input.phone)),
    'INVALID_PROFILE','Phone number is invalid.');
  return db.transaction(async tx=>{
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor.id]);
    const user=await activeIdentity(tx,actor.id);
    await tx.query('UPDATE users SET display_name=$2,profile_completed_at=now(),updated_at=now() WHERE id=$1',[user.id,input.displayName.trim()]);
    if(user.role==='passenger') await tx.query(`INSERT INTO passenger_profiles(user_id,phone) VALUES($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET phone=EXCLUDED.phone`,[user.id,input.phone===undefined?user.phone:input.phone]);
    await audit(tx,user.id,'identity.profile_updated',user.id,user.operator_id);
    return activeIdentity(tx,user.id);
  });
}
