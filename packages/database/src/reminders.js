import { journeyPlan, FIRST_MILE_POLICY } from '@leroutier/domain';

// Time-based journey reminders. These are the only notifications not triggered
// by a state change, so they are raised here as ordinary outbox events and then
// travel the same policy -> recipient -> channel path as everything else.
//
// Each reminder is emitted at most once per booking: the outbox itself is the
// ledger, checked by event type and aggregate, so repeated ticks are no-ops and
// a rescheduled service can legitimately raise a fresh, superseding reminder.
const rows = async (tx, sql, args = []) => (await tx.query(sql, args)).rows;

// How long a parcel may sit collectable before the receiver is reminded, and
// then before the station is asked to deal with it. Both are configuration, not
// a guess: an operator who keeps parcels for a week and one who clears the
// counter daily are both legitimate, and neither threshold belongs in code.
export const PARCEL_PICKUP_POLICY = { reminderHours: 24, escalationHours: 72 };

export function reminders(db, config = {}) {
  const policy = config.firstMile ?? FIRST_MILE_POLICY;
  const pickup = { ...PARCEL_PICKUP_POLICY, ...(config.parcelPickup ?? {}) };

  /**
   * Parcels that arrived and were never collected.
   *
   * The clock starts at the `ready_for_pickup` event rather than the parcel's
   * `updated_at`, which any later edit would reset — an uncollected parcel must
   * not become "fresh" because someone corrected a note.
   *
   * Each stage is emitted at most once per arrival: the outbox is the ledger,
   * keyed by the arrival instant, so repeated ticks are no-ops and a parcel
   * that is returned to the counter later legitimately starts a new cycle.
   */
  async function sweepUncollected(tx, now) {
    const stages = [
      { type: 'parcel.uncollected_reminder', hours: pickup.reminderHours },
      { type: 'parcel.uncollected_escalation', hours: pickup.escalationHours },
    ];
    let raised = 0;
    for (const stage of stages) {
      const due = await rows(tx, `SELECT p.id, p.tracking_number, p.operator_id, p.destination_stop_id, e.created_at AS ready_at
        FROM parcels p
        JOIN LATERAL (SELECT created_at FROM parcel_events
          WHERE parcel_id=p.id AND kind='ready_for_pickup' ORDER BY created_at DESC LIMIT 1) e ON true
        WHERE p.status='ready_for_pickup'
          AND e.created_at <= $1::timestamptz - make_interval(hours => $2::int)
          AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.event_type=$3 AND o.aggregate_id=p.id
            AND o.payload->>'readyKey' = to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ'))
        ORDER BY e.created_at LIMIT 200`, [now.toISOString(), stage.hours, stage.type]);
      for (const parcel of due) {
        await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)', [stage.type, parcel.id,
          JSON.stringify({
            parcelId: parcel.id, trackingNumber: parcel.tracking_number, operatorId: parcel.operator_id,
            stopId: parcel.destination_stop_id, waitingHours: stage.hours,
            readyKey: new Date(parcel.ready_at).toISOString(),
          })]);
        raised++;
      }
    }
    return raised;
  }

  return {
    policy: { firstMile: policy, parcelPickup: pickup },
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
        const parcelsRaised = await sweepUncollected(tx, now);
        return { raised: raised + parcelsRaised, considered: candidates.length, journeyReminders: raised, parcelReminders: parcelsRaised };
      });
    },
  };
}
