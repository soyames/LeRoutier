import { createHash } from 'node:crypto';
import { hashMsisdn } from './adapters.js';

// USSD session state.
//
// A session here is a *cursor*, not a cache. It remembers which screen the
// caller is on and what they have selected — never a fare, a seat count or a
// payment status. Those are re-read from the domain on every screen, because a
// remembered price is a price that can be wrong by the time it is confirmed,
// and a remembered capacity is an oversell waiting to happen.

export const DEFAULT_TTL_SECONDS = 180;

/** The same input at the same point in the same session is the same request. */
export const requestFingerprint = (sessionId, steps, input) =>
  createHash('sha256').update(`${sessionId}|${steps}|${input}`).digest('hex');

export function ussdSessions(db, { ttlSeconds = DEFAULT_TTL_SECONDS, defaultLocale = 'fr' } = {}) {
  const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];

  return {
    ttlSeconds,

    /**
     * Finds the live session for this provider session id, or starts one.
     *
     * An expired session is not resurrected: dialling again starts fresh. That
     * is deliberate — resuming a half-finished booking whose price, seat
     * availability and service status may all have moved is worse than asking
     * the caller to choose again.
     */
    async open(tx, { provider, sessionId, msisdn }) {
      const phoneHash = hashMsisdn(msisdn ?? '');
      const existing = await one(tx,
        `SELECT * FROM ussd_sessions WHERE provider=$1 AND provider_session_id=$2 FOR UPDATE`, [provider, sessionId]);

      if (existing) {
        const expired = new Date(existing.expires_at).getTime() <= Date.now() || existing.status !== 'active';
        if (!expired) return { session: existing, resumed: true };
        // Mark it, then start a new one under a distinct key so the unique
        // index still holds and the old transcript stays auditable.
        await tx.query(`UPDATE ussd_sessions SET status='expired', updated_at=now() WHERE id=$1 AND status='active'`, [existing.id]);
        await tx.query(`UPDATE ussd_sessions SET provider_session_id=$2 WHERE id=$1`,
          [existing.id, `${existing.provider_session_id}#${existing.id.slice(0, 8)}`]);
        return { session: null, resumed: false, expired: true, phoneHash };
      }
      return { session: null, resumed: false, phoneHash };
    },

    async create(tx, { provider, sessionId, msisdn, verified, locale = defaultLocale }) {
      return one(tx, `INSERT INTO ussd_sessions(provider,provider_session_id,phone_hash,msisdn_verified,locale,expires_at)
        VALUES($1,$2,$3,$4,$5, now() + make_interval(secs => $6::int)) RETURNING *`,
      [provider, sessionId, hashMsisdn(msisdn ?? ''), verified === true, locale, ttlSeconds]);
    },

    /** Advances the cursor and pushes the expiry out, in one statement. */
    async advance(tx, id, /** @type {{flow?:string|null, step?:string|null, state?:object|null, locale?:string|null, userId?:string|null}} */
      { flow = null, step = null, state = undefined, locale = null, userId = null } = {}) {
      return one(tx, `UPDATE ussd_sessions
        SET flow=coalesce($2,flow), step=coalesce($3,step), state=coalesce($4,state),
            locale=coalesce($5,locale), user_id=coalesce($6,user_id),
            steps=steps+1, updated_at=now(), expires_at=now() + make_interval(secs => $7::int)
        WHERE id=$1 RETURNING *`,
      [id, flow ?? null, step ?? null, state === undefined ? null : JSON.stringify(state), locale ?? null, userId ?? null, ttlSeconds]);
    },

    async close(tx, id, status = 'completed') {
      await tx.query(`UPDATE ussd_sessions SET status=$2, updated_at=now() WHERE id=$1 AND status='active'`, [id, status]);
    },

    /**
     * Replay protection. Gateways retry hard on timeout, and a retried
     * "confirm" must return the first answer rather than book a second seat.
     */
    async replayed(tx, sessionId, fingerprint) {
      return one(tx, 'SELECT response_text, continues FROM ussd_requests WHERE session_id=$1 AND request_hash=$2',
        [sessionId, fingerprint]);
    },

    async remember(tx, sessionId, fingerprint, { text, continues }) {
      await tx.query(`INSERT INTO ussd_requests(session_id,request_hash,response_text,continues)
        VALUES($1,$2,$3,$4) ON CONFLICT (session_id,request_hash) DO NOTHING`, [sessionId, fingerprint, text, continues]);
    },

    /**
     * Per-caller throttle, keyed on the phone hash so it never selects on a
     * number. Separate from the API's own limiter: a USSD gateway's retry
     * behaviour should not be able to lock a caller out of the web app.
     */
    async tooManySessions(tx, phoneHash, { perHour = 40 } = {}) {
      const row = await one(tx, `SELECT count(*)::integer AS n FROM ussd_sessions
        WHERE phone_hash=$1 AND created_at > now() - interval '1 hour'`, [phoneHash]);
      return row.n >= perHour;
    },

    /**
     * Binds the session to an identity that ALREADY exists, matched by phone.
     *
     * USSD never creates an identity. The caller's number arrives from a
     * gateway; even a verified callback proves the gateway sent it, not that
     * the person owns the account. So the rule is: reuse an account that was
     * created through the real sign-in path, or offer anonymous journeys only.
     */
    async bindKnownPassenger(tx, { session, msisdn }) {
      if (!session.msisdn_verified || !msisdn) return null;
      // Compare on digits so "+229 01 23 45 67" and "+22901234567" are one person.
      const digits = String(msisdn).replace(/\D/g, '');
      const row = await one(tx, `SELECT u.id FROM users u
        JOIN passenger_profiles p ON p.user_id=u.id
        WHERE u.active=true AND u.role='passenger'
          AND regexp_replace(coalesce(p.phone,''), '[^0-9]', '', 'g') = $1
        ORDER BY u.created_at LIMIT 1`, [digits]);
      if (!row) return null;
      await tx.query('UPDATE ussd_sessions SET user_id=$2, updated_at=now() WHERE id=$1', [session.id, row.id]);
      return row.id;
    },

    /** Expired sessions are closed and their transcripts dropped on a schedule. */
    async sweep(tx, { retainHours = 24 } = {}) {
      const closed = await tx.query(`UPDATE ussd_sessions SET status='expired', updated_at=now()
        WHERE status='active' AND expires_at <= now()`);
      const removed = await tx.query(`DELETE FROM ussd_sessions
        WHERE status <> 'active' AND updated_at < now() - make_interval(hours => $1::int)`, [retainHours]);
      return { expired: closed.rowCount ?? 0, deleted: removed.rowCount ?? 0 };
    },
  };
}
