/**
 * Operator ratings.
 *
 * Two rules do most of the work here.
 *
 * A rating requires a completed journey, and the booking is the primary key,
 * so one journey leaves exactly one rating. That is the entire anti-abuse
 * design: there is no open review form to flood, and nobody can rate an
 * operator they never travelled with.
 *
 * An average is only published once enough journeys have been rated. A single
 * five-star rating displayed as "5,0" is not information, it is an accident
 * that reads like a recommendation — and the first operator to notice can
 * manufacture it. Below the floor the product says plainly that there are not
 * enough ratings yet, which is true and useful.
 */
import { invariant, uuid } from '@leroutier/domain';
import { audit } from './identities.js';

/** Below this many ratings, an average says more about luck than about service. */
export const RATING_PUBLIC_MINIMUM = 5;

const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];

/**
 * The public shape of an operator's reputation.
 * @param {{rating_total?:number,rating_count?:number}} operator
 */
export function publicRating(operator) {
  const count = Number(operator?.rating_count ?? 0);
  const total = Number(operator?.rating_total ?? 0);
  if (count < RATING_PUBLIC_MINIMUM) return { count, average: null, published: false };
  return { count, average: Math.round((total / count) * 10) / 10, published: true };
}

export function ratings(db) {
  return {
    /** What the passenger may do about this booking, and what they already did. */
    async forBooking(actor, bookingId) {
      invariant(actor?.role === 'passenger', 'FORBIDDEN', 'Passenger access required.', 403);
      return db.transaction(async tx => {
        const booking = await one(tx, `SELECT b.id,b.status,b.passenger_id,s.operator_id,o.name AS operator_name
          FROM bookings b JOIN services s ON s.id=b.service_id JOIN operators o ON o.id=s.operator_id
          WHERE b.id=$1`, [uuid(bookingId)]);
        invariant(booking, 'NOT_FOUND', 'Booking not found.', 404);
        invariant(booking.passenger_id === actor.id, 'FORBIDDEN', 'Booking is not yours.', 403);
        const existing = await one(tx, 'SELECT score,comment,created_at,updated_at FROM operator_ratings WHERE booking_id=$1', [booking.id]);
        return {
          bookingId: booking.id, operatorName: booking.operator_name,
          // Only a journey that actually happened can be rated.
          canRate: booking.status === 'completed',
          rating: existing ? { score: existing.score, comment: existing.comment ?? null, updatedAt: existing.updated_at } : null,
        };
      });
    },

    /**
     * Rate the operator that carried this booking. Re-rating the same booking
     * replaces the previous score rather than adding a second one, so a
     * passenger can correct themselves without inflating the count.
     */
    async rate(actor, bookingId, input) {
      invariant(actor?.role === 'passenger', 'FORBIDDEN', 'Passenger access required.', 403);
      invariant(input && Object.keys(input).every(k => ['score', 'comment'].includes(k)),
        'INVALID_RATING', 'Unexpected rating fields.');
      const score = Number(input.score);
      invariant(Number.isInteger(score) && score >= 1 && score <= 5, 'INVALID_RATING', 'La note doit être comprise entre 1 et 5.');
      const comment = input.comment === undefined || input.comment === null || String(input.comment).trim() === ''
        ? null : String(input.comment).trim();
      invariant(comment === null || comment.length <= 500, 'INVALID_RATING', 'Le commentaire est trop long.');
      return db.transaction(async tx => {
        const booking = await one(tx, `SELECT b.id,b.status,b.passenger_id,s.operator_id
          FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.id=$1 FOR UPDATE OF b`, [uuid(bookingId)]);
        invariant(booking, 'NOT_FOUND', 'Booking not found.', 404);
        invariant(booking.passenger_id === actor.id, 'FORBIDDEN', 'Booking is not yours.', 403);
        invariant(booking.status === 'completed', 'RATING_NOT_AVAILABLE',
          'Vous pourrez noter ce trajet une fois le voyage terminé.', 409);
        // Lock the operator row: the aggregate below is a read-modify-write and
        // two passengers rating the same operator at once must not lose one.
        await tx.query('SELECT id FROM operators WHERE id=$1 FOR UPDATE', [booking.operator_id]);
        const previous = await one(tx, 'SELECT score FROM operator_ratings WHERE booking_id=$1', [booking.id]);
        await tx.query(`INSERT INTO operator_ratings(booking_id,operator_id,passenger_id,score,comment)
          VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(booking_id) DO UPDATE SET score=EXCLUDED.score,comment=EXCLUDED.comment,updated_at=now()`,
        [booking.id, booking.operator_id, actor.id, score, comment]);
        // Maintained in the same transaction as the row it summarises, so the
        // published average can never drift from the ratings behind it.
        if (previous) {
          await tx.query('UPDATE operators SET rating_total=rating_total-$2+$3 WHERE id=$1',
            [booking.operator_id, previous.score, score]);
        } else {
          await tx.query('UPDATE operators SET rating_total=rating_total+$2,rating_count=rating_count+1 WHERE id=$1',
            [booking.operator_id, score]);
        }
        // The score is auditable; the comment is not copied into the event
        // stream, which feeds notification templates.
        await audit(tx, actor.id, 'booking.rated', booking.id, booking.operator_id, { score, amended: Boolean(previous) });
        const operator = await one(tx, 'SELECT rating_total,rating_count FROM operators WHERE id=$1', [booking.operator_id]);
        return { bookingId: booking.id, score, comment, operatorRating: publicRating(operator) };
      });
    },

    /** An operator reading its own reputation, including what was written. */
    async forOperator(actor, operatorId = null) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      // Naming another operator is refused, not quietly rewritten to your own:
      // answering a different question than the one asked is how a caller ends
      // up believing they audited somebody else's reputation.
      const requested = operatorId ? uuid(operatorId) : null;
      if (actor.operator_id) invariant(!requested || requested === actor.operator_id,
        'FORBIDDEN', 'Operation is not permitted.', 403);
      const id = requested ?? actor.operator_id;
      invariant(id, 'INVALID_INPUT', 'Operator is required.', 409);
      return db.transaction(async tx => {
        const operator = await one(tx, 'SELECT rating_total,rating_count FROM operators WHERE id=$1', [id]);
        invariant(operator, 'NOT_FOUND', 'Operator not found.', 404);
        // The passenger behind a comment is never returned, to the operator or
        // to anyone else: a rating must not become a reason to find somebody.
        const recent = (await tx.query(`SELECT score,comment,created_at FROM operator_ratings
          WHERE operator_id=$1 AND comment IS NOT NULL ORDER BY created_at DESC LIMIT 50`, [id])).rows;
        const spread = (await tx.query(`SELECT score,count(*)::integer AS count FROM operator_ratings
          WHERE operator_id=$1 GROUP BY score ORDER BY score DESC`, [id])).rows;
        return { ...publicRating(operator), minimumForPublication: RATING_PUBLIC_MINIMUM, spread, recent };
      });
    },
  };
}
