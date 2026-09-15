import { journeyPlan, FIRST_MILE_POLICY } from '@leroutier/domain';

// Time-based journey reminders. These are the only notifications not triggered
// by a state change, so they are raised here as ordinary outbox events and then
// travel the same policy -> recipient -> channel path as everything else.
//
// Each reminder is emitted at most once per booking: the outbox itself is the
// ledger, checked by event type and aggregate, so repeated ticks are no-ops and
// a rescheduled service can legitimately raise a fresh, superseding reminder.
const rows = async (tx, sql, args = []) => (await tx.query(sql, args)).rows;

export function reminders(db, config = {}) {
  const policy = config.firstMile ?? FIRST_MILE_POLICY;
  return {
    async tick(now = new Date()) {
      return db.transaction(async tx => {
        const candidates = await rows(tx, `SELECT b.id,b.created_at,s.id AS service_id,s.departure_at,s.updated_at AS service_updated_at
          FROM bookings b JOIN services s ON s.id=b.service_id
          WHERE b.status IN ('confirmed','held') AND s.status IN ('scheduled','active','disrupted')
          AND s.departure_at > $1::timestamptz - interval '1 hour'
          AND s.departure_at < $1::timestamptz + interval '12 hours'
          ORDER BY s.departure_at LIMIT 500`, [now.toISOString()]);
        let raised = 0;
        for (const booking of candidates) {
          const plan = journeyPlan({ departureAt: booking.departure_at, policy });
          const due = [
            // Leave-home advice, computed from the service's current departure.
            { type: 'first_mile.leave_soon', at: plan.leaveBy, data: { bookingId: booking.id, serviceId: booking.service_id, leaveBy: plan.leaveBy, departureAt: plan.departureAt } },
            { type: 'boarding.starts_soon', at: plan.boardingOpensAt, data: { bookingId: booking.id, serviceId: booking.service_id, departureAt: plan.departureAt } },
          ];
          for (const reminder of due) {
            // Not yet time, or already in the past by more than the window.
            const at = new Date(reminder.at).getTime();
            if (at > now.getTime() || at < now.getTime() - 3600_000) continue;
            // Already raised for this booking at this computed time: a
            // rescheduled service changes the time and so may notify again.
            const already = await rows(tx, `SELECT 1 FROM outbox WHERE event_type=$1 AND aggregate_id=$2
              AND payload->>'leaveByKey'=$3 LIMIT 1`, [reminder.type, booking.id, reminder.at]);
            if (already.length) continue;
            await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)',
              [reminder.type, booking.id, JSON.stringify({ ...reminder.data, leaveByKey: reminder.at })]);
            raised++;
          }
        }
        return { raised, considered: candidates.length };
      });
    },
  };
}
