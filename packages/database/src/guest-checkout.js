import { createHash, randomBytes } from 'node:crypto';
import { idempotencyKey, invariant } from '@leroutier/domain';
import { transport } from './transport.js';
import { audit } from './identities.js';

const hash = token => createHash('sha256').update(token).digest('hex');
const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];

/**
 * How long a guest can come back to what they bought without an account.
 *
 * Long enough that a ticket bought in advance is still reachable on the day of
 * travel and for a while after it, which is the only thing the access is for.
 * The purchase itself does not expire with it.
 */
export const GUEST_ACCESS_DAYS = 90;

/**
 * Buying a ticket without having an account.
 *
 * This is the purchase the product starts from, and the guest identity it
 * creates is the least privileged principal in the schema: no authentication
 * subject, so it can never be signed into and can never be adopted by anybody
 * who merely knows its identifier; a passenger role, so it can do nothing else;
 * and a token that is issued once and stored only as a hash, exactly as the
 * opaque development sessions are.
 *
 * WHY THE IDENTITY IS CREATED IN THE SAME TRANSACTION AS THE SEATS. A failure
 * part-way through has to leave nothing at all. Creating the buyer first and the
 * seats afterwards would, on any error, leave an identity holding no purchase —
 * a row that exists only because something went wrong.
 *
 * WHAT THIS DELIBERATELY DOES NOT ASK FOR: a password, an email address, a
 * postal address, or the names of the other travellers. A name to address the
 * party by and a phone to reach them on are what a booking needs and all it
 * needs. The seats carry the purchaser's name on the manifest, and boarding is
 * by individual ticket and seat number.
 *
 * @param {{transaction:(fn:(tx:any)=>Promise<any>)=>Promise<any>}} db
 */
export function guestCheckout(db) {
  const domain = transport(db);
  /**
   * @param {{id:string,role:string}|null} actor the authenticated buyer, or null for a visitor
   * @param {object} input booking request; `passengerName`/`passengerPhone` are
   *   read only when there is no actor, and ignored when there is one
   * @param {string} key the request's Idempotency-Key
   */
  return async function begin(actor, input, key) {
    idempotencyKey(key);
    return db.transaction(async tx => {
      let purchaser = actor;
      let guestToken = null;
      if (!actor) {
        // A visitor buys with a name and a phone, and nothing else.
        invariant(typeof input.passengerName === 'string' && input.passengerName.trim().length >= 2 && input.passengerName.trim().length <= 100,
          'INVALID_CONTACT', 'Indiquez le nom du voyageur principal.', 400);
        invariant(typeof input.passengerPhone === 'string' && /^\+?[0-9 ()-]{6,25}$/.test(input.passengerPhone.trim()),
          'INVALID_CONTACT', 'Indiquez un numéro de téléphone joignable pour vous joindre.', 400);
        // The same shape the counter sale uses for a passenger who never signs
        // in: a row with no authentication subject, and a passenger profile.
        purchaser = await one(tx, `INSERT INTO users(display_name,role,profile_completed_at)
          VALUES($1,'passenger',now()) RETURNING *`, [input.passengerName.trim()]);
        await tx.query('INSERT INTO passenger_profiles(user_id,phone) VALUES($1,$2)', [purchaser.id, input.passengerPhone.trim()]);
        guestToken = randomBytes(32).toString('base64url');
        await tx.query(`INSERT INTO api_sessions(token_hash,user_id,expires_at,kind)
          VALUES($1,$2,now()+($3||' days')::interval,'guest')`, [hash(guestToken), purchaser.id, String(GUEST_ACCESS_DAYS)]);
        await audit(tx, purchaser.id, 'identity.guest_created', purchaser.id, null, { channel: 'checkout' });
      }
      const group = await domain.txHoldGroup(tx, { id: purchaser.id, role: 'passenger' }, input, key);
      // The token travels in the response body and nowhere else: never a query
      // string, never a log line, never a referrer.
      return { ...group, guestToken };
    });
  };
}
