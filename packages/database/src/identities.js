import { createHash } from 'node:crypto';
import { invariant } from '@leroutier/domain';
import { assertRegistrationOpen } from './registration.js';
import { platformCapabilities } from './platform-access.js';

const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
/** Session tokens are stored hashed, exactly as the development login stores them. */
const tokenHash = token => createHash('sha256').update(token).digest('hex');

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
  // totp_enabled rides along on the identity every authenticated request
  // already loads. Reading it here rather than in a second query keeps the
  // second factor free for the many identities that never enable one — and
  // only a CONFIRMED enrolment counts, so an abandoned one gates nothing.
  const user=(await tx.query(`SELECT u.id,u.auth_subject,u.auth_issuer,u.display_name,u.role,u.operator_id,u.active,u.is_demo,u.profile_completed_at,u.passenger_activated_at,p.phone,
    d.active AS driver_active,c.active AS convoyeur_active,o.active AS operator_active,o.type AS operator_type,o.verification_status,
    o.owner_user_id,o.name AS operator_name,t.confirmed_at AS totp_confirmed_at FROM users u
    LEFT JOIN passenger_profiles p ON p.user_id=u.id LEFT JOIN driver_profiles d ON d.user_id=u.id
    LEFT JOIN convoyeur_profiles c ON c.user_id=u.id
    LEFT JOIN user_totp t ON t.user_id=u.id
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
    has_second_factor:user.totp_confirmed_at!==null,
    // Whether this identity may buy as a passenger.
    //
    // A guest identity has no account to activate — buying is how a guest comes
    // to exist, and the seats it buys are adopted by an account afterwards. A
    // demo identity is seed data for exercising the product. For everybody else
    // an account becomes a passenger account by having bought something, which
    // is the rule this flag exists to enforce, on every request, rather than in
    // a screen that a direct call to the API would bypass.
    passenger_activated:user.auth_subject===null || user.is_demo || user.passenger_activated_at!==null,
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

/**
 * Move a proven guest purchase onto an account, inside the caller's transaction.
 *
 * Split out of `claimGuestPurchase` so the SAME move can happen at the moment
 * an account is created, rather than only after it. There is exactly one
 * implementation of "the tickets change hands" because there is exactly one
 * way that is allowed to happen.
 *
 * @param {any} tx an open transaction
 * @param {string} accountId the account taking the tickets
 * @param {string} guestToken the raw token, exactly as issued
 * @returns {Promise<{guestId:string,tickets:number}>}
 */
async function adoptGuestPurchase(tx,accountId,guestToken) {
  const session=await one(tx,`SELECT s.user_id FROM api_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.kind='guest' AND s.expires_at>now() AND u.active AND u.auth_subject IS NULL`,
  [tokenHash(guestToken)]);
  invariant(session,'CLAIM_INVALID','Ce lien de récupération n’est plus valide. Demandez-en un nouveau depuis votre billet.',401);
  const guestId=session.user_id;
  // Holding the token says who they are. It does not say they paid, so the
  // purchase is what is checked before anything moves.
  const paid=await one(tx,`SELECT count(*)::integer AS n FROM bookings
    WHERE passenger_id=$1 AND status IN ('confirmed','boarded','completed')`,[guestId]);
  invariant(paid.n>0,'CLAIM_NOTHING_TO_KEEP','Aucun billet payé n’est rattaché à ce lien.',409);
  // The account needs a passenger profile before tickets can point at it: the
  // booking table references one, exactly as it does for every other passenger.
  await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING',[accountId]);
  await tx.query('UPDATE bookings SET passenger_id=$2,updated_at=now() WHERE passenger_id=$1',[guestId,accountId]);
  await tx.query('UPDATE booking_passengers SET passenger_id=$2 WHERE passenger_id=$1',[guestId,accountId]);
  await tx.query('UPDATE booking_groups SET purchaser_id=$2,updated_at=now() WHERE purchaser_id=$1',[guestId,accountId]);
  // The purchase is what makes this a passenger account.
  await tx.query('UPDATE users SET passenger_activated_at=coalesce(passenger_activated_at,now()),updated_at=now() WHERE id=$1',[accountId]);
  await tx.query('DELETE FROM api_sessions WHERE user_id=$1',[guestId]);
  await tx.query('UPDATE users SET active=false,updated_at=now() WHERE id=$1 AND auth_subject IS NULL',[guestId]);
  return {guestId,tickets:paid.n};
}

/**
 * @param {object} input the verified identity claims, plus how it is arriving
 * @param {'passenger'|'provider'} [input.intent] what this sign-in is for
 * @param {string|null} [input.guestToken] the purchase, when there is one
 */
export async function mapIdentity(db,{subject,issuer,notificationEmail=null,emailVerified=false,signInProvider=null,
  intent='passenger',guestToken=null}) {
  invariant(typeof subject==='string' && subject.length>0 && subject.length<=255,'UNAUTHORIZED','Invalid identity.',401);
  // The verified-email gate. A password identity whose address has not been
  // confirmed is not a LeRoutier account yet: /me must refuse it, or the
  // "provision on first sign-in" model would create a row for an address
  // nobody has proven they control. Google verifies its own addresses and
  // keeps sign_in_provider='google.com', custom-token identities are
  // provisioned through reviewed paths, and demo identities never reach this
  // function — so the gate is exactly one claim pair, and nothing else.
  invariant(!(signInProvider==='password' && emailVerified!==true),
    'EMAIL_NOT_VERIFIED','Confirm your email address before signing in.',403);
  return db.transaction(async tx=>{
    // An identity that already exists always signs in: registration capacity
    // never locks anybody out of an account they already have. Only the
    // creation of a NEW identity is gated, and the gate is measured inside
    // this transaction under an advisory lock so concurrent first sign-ins
    // cannot each read the same "still under threshold" and overshoot it.
    const known=(await tx.query('SELECT id FROM users WHERE auth_subject=$1',[subject])).rows[0];
    if(!known) {
      await assertRegistrationOpen(tx);
      // A PASSENGER ACCOUNT BEGINS WITH A TICKET, and this is where that is
      // enforced rather than on the screen that offered it. Signing in is the
      // only moment a LeRoutier account comes into being, so a rule about
      // opening one has to live here or it lives nowhere.
      //
      // WHAT IS ASKED FOR IS THE PURCHASE ITSELF, not a promise of one: the
      // token issued with a booking that was actually paid for, checked below
      // against its stored hash and its confirmed bookings. Hiding the button
      // would leave the rule resting on a screen; this is the call the screen
      // eventually makes, and it is refused without one.
      //
      // ONLY THE TRAVELLER'S DOOR ASKS THIS QUESTION. `intent` is 'provider'
      // for an account being created for professional use — onboarding, a
      // driver, a company, their staff — and every one of those people is not
      // buying anything and is let through exactly as before. That is also the
      // default, so no caller is asked for a ticket unless it claimed to be
      // opening a traveller's account. Nothing is loosened by it: an identity
      // created either way is not a passenger account until a purchase has
      // been adopted into it, which is the next thing that happens below.
      invariant(intent!=='passenger' || (typeof guestToken==='string' && guestToken.length>=20 && guestToken.length<=200),
        'PASSENGER_SIGNUP_REQUIRES_PURCHASE',
        'Un compte voyageur s’ouvre avec un premier billet. Achetez votre billet sans compte : votre achat vous permettra ensuite de créer ce compte, et vos billets vous y suivront.',403);
    }
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
      // The purchase the account was created for changes hands in THIS
      // transaction. Doing it later, as a separate call, is what left a window
      // in which a brand new account existed holding nothing — and a failed
      // second call left it that way for good.
      if(intent!=='provider') {
        const adopted=await adoptGuestPurchase(tx,user.id,guestToken);
        await audit(tx,user.id,'identity.purchase_claimed',user.id,null,{guestId:adopted.guestId,tickets:adopted.tickets});
      }
    }
    return activeIdentity(tx,user.id);
  });
}

/**
 * Give a guest's tickets to the account that just proved it bought them.
 *
 * HOW OWNERSHIP IS PROVEN, and what is deliberately not accepted. The guest
 * access token is a 32-byte secret issued once, at the moment of purchase, and
 * stored only as a hash — so holding it is evidence of the purchase in the same
 * way holding a boarding pass is evidence of the journey. A purchase reference,
 * a phone number or an email address are all either guessable or enumerable, and
 * none of them is asked for or accepted here. Nothing is adopted on the strength
 * of an identifier alone.
 *
 * WHAT ACTIVATES AN ACCOUNT, and the two moments it can happen. `mapIdentity`
 * adopts the purchase while creating the account it was bought for, which is
 * the ordinary path now; this function is the same move made later, for an
 * account that already existed when the purchase was made — a passenger
 * signing in again, or a guest who bought on a device where they were already
 * registered. Both go through `adoptGuestPurchase`, so both are the same
 * transaction and the same rule: a CONFIRMED purchase, or nothing moves.
 *
 * The token is spent in the same transaction: the guest's sessions are deleted
 * and the identity is deactivated, so a replay finds nothing and the row that
 * carried the purchase cannot be signed into afterwards.
 *
 * @param {{transaction:(fn:(tx:any)=>Promise<any>)=>Promise<any>}} db
 * @param {{id:string,role?:string,auth_subject?:string|null}} actor
 * @param {string} guestToken the raw token, exactly as issued
 */
export async function claimGuestPurchase(db,actor,guestToken) {
  invariant(typeof guestToken==='string' && guestToken.length>=20 && guestToken.length<=200,
    'CLAIM_INVALID','Ce lien de récupération n’est pas valide. Demandez-en un nouveau depuis votre billet.',401);
  invariant(actor?.id && actor.auth_subject,'FORBIDDEN','Connectez-vous pour conserver vos billets.',403);
  // Only a passenger account can hold passenger tickets. A driver or an operator
  // who bought as a guest keeps the guest link instead: moving the seats onto an
  // account that cannot open them would lose them for both.
  invariant(actor.role==='passenger','FORBIDDEN','Seul un compte voyageur peut rattacher ces billets.',403);
  return db.transaction(async tx=>{
    const adopted=await adoptGuestPurchase(tx,actor.id,guestToken);
    await audit(tx,actor.id,'identity.purchase_claimed',actor.id,null,{guestId:adopted.guestId,tickets:adopted.tickets});
    return {activated:true,tickets:adopted.tickets};
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
