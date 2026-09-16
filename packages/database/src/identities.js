import { invariant } from '@leroutier/domain';

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
  return {...user,needs_profile:user.role==='passenger' && !user.profile_completed_at && !user.is_demo};
}

export async function mapIdentity(db,{subject,issuer}) {
  invariant(typeof subject==='string' && subject.length>0 && subject.length<=255,'UNAUTHORIZED','Invalid identity.',401);
  return db.transaction(async tx=>{
    const inserted=(await tx.query(`INSERT INTO users(auth_subject,auth_issuer,display_name,role)
      VALUES($1,$2,'','passenger') ON CONFLICT(auth_subject) DO NOTHING RETURNING id`,[subject,issuer])).rows[0];
    const user=(await tx.query('SELECT id,auth_issuer FROM users WHERE auth_subject=$1',[subject])).rows[0];
    invariant(user && user.auth_issuer===issuer,'UNAUTHORIZED','Identity is not registered with this issuer.',401);
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
