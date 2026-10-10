// Read-only projection shared by the passenger document and confirmation mail.
// Authorization belongs to the calling domain service. No credential, payment
// provider secret or invented tax/company detail enters this projection.
import { bookingMoney } from './transport.js';
export async function bookingDocument(tx, id) {
  const b = (await tx.query(`SELECT b.*,u.display_name AS passenger_name,o.name AS operator_name,
    r.name AS route_name,s.is_demo,s.status AS service_status,
    CASE WHEN b.origin_sequence=0 THEN s.departure_at END AS departure_at,
    CASE WHEN b.destination_sequence=(SELECT max(sequence) FROM service_stops WHERE service_id=s.id)
      THEN s.arrival_at END AS arrival_at,
    driver.display_name AS driver_name,v.registration,
    op.name AS departure_city,ap.name AS arrival_city,
    coalesce(bdp.name,os.name) AS departure_point_name,bdp.description AS departure_point_landmark,
    coalesce(bap.name,ds.name) AS arrival_point_name,bap.description AS arrival_point_landmark,
    coalesce(bdp.latitude,os.latitude) AS departure_point_latitude,coalesce(bdp.longitude,os.longitude) AS departure_point_longitude,
    coalesce(bap.latitude,ds.latitude) AS arrival_point_latitude,coalesce(bap.longitude,ds.longitude) AS arrival_point_longitude
    FROM bookings b JOIN users u ON u.id=b.passenger_id JOIN services s ON s.id=b.service_id
    JOIN operators o ON o.id=s.operator_id JOIN routes r ON r.id=s.route_id
    JOIN service_stops origin ON origin.service_id=s.id AND origin.sequence=b.origin_sequence
    JOIN service_stops destination ON destination.service_id=s.id AND destination.sequence=b.destination_sequence
    JOIN stops os ON os.id=origin.stop_id JOIN places op ON op.id=os.place_id
    JOIN stops ds ON ds.id=destination.stop_id JOIN places ap ON ap.id=ds.place_id
    LEFT JOIN boarding_points bdp ON bdp.id=s.departure_point_id AND bdp.place_id=os.place_id
    LEFT JOIN boarding_points bap ON bap.id=s.arrival_point_id AND bap.place_id=ds.place_id
    LEFT JOIN LATERAL (SELECT * FROM service_assignments WHERE service_id=s.id ORDER BY assigned_at DESC LIMIT 1) a ON true
    LEFT JOIN users driver ON driver.id=a.driver_id LEFT JOIN vehicles v ON v.id=a.vehicle_id
    WHERE b.id=$1`, [id])).rows[0];
  if (!b) return null;
  // A seat is paid for by its own payment or by its purchase's, so the document
  // shows both: the traveller's receipt is the money that actually settled their
  // seat, not only the rows addressed to it.
  const payments = (await tx.query(`SELECT id,amount_minor,fare_minor,service_fee_minor,provider_fee_minor,currency,status,created_at,group_id,refunded_minor FROM payments
    WHERE (booking_id=$1 OR ($2::uuid IS NOT NULL AND group_id=$2)) AND status IN ('succeeded','refunded')
    ORDER BY created_at,id`, [id, b.group_id ?? null])).rows;
  const money = await bookingMoney(tx, b);
  return { ...b, payments, seller:b.operator_name, settled:money.settled, fareMinor:payments[0]?.fare_minor??b.amount_minor, platformFeeMinor:payments.reduce((n,p)=>n+p.service_fee_minor,0),providerFeeMinor:payments.reduce((n,p)=>n+p.provider_fee_minor,0), paidMinor: money.paidMinor+payments.reduce((n,p)=>n+p.provider_fee_minor,0), refundedMinor: payments.reduce((n,p)=>n+p.refunded_minor,0), dueMinor: money.dueMinor };
}
