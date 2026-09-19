import { assertDisposableSchema } from './guards.js';
import { cleanupTestServices } from './test-transport-cleanup.js';

// Synthetic TEST transport inventory for the passenger flow:
//   search → offers → map → selection → checkout → simulated payment.
//
// EVERY record here is structurally marked (is_demo=true) and visibly named
// with the word TEST — operators, users, vehicles, routes, services and the
// GPS feed. Nothing here may ever be mistaken for a real operator, driver,
// vehicle or transport offer, and TEST transactions never enter real
// financial settlement.
//
// The seed is idempotent: stable ids + ON CONFLICT, and departure times are
// refreshed on every run so the inventory stays useful (relative schedules).
// Cleanup: packages/database/scripts/cleanup-test-transport.js

// Stable test ids: deterministic, namespaced under b00b, never colliding
// with geography ids (b000...) or the demo seed (8000...).
const id = n => `00000000-0000-4000-b00b-${String(n).padStart(12, '0')}`;
export const TEST = {
  opsUser: id(1), passenger: id(2),
  company: id(10), companyOps: id(11),
  driver1: id(20), driver1Op: id(21),
  driver2: id(22), driver2Op: id(23),
  driver3: id(24), driver3Op: id(25),
  driver4: id(26), driver4Op: id(27),
  companyDriver: id(28), companyDriver2: id(29),
  vehicle1: id(30), vehicle2: id(31), vehicle3: id(32), vehicle4: id(33), vehicle5: id(34), vehicle6: id(35),
  expressRoute: id(40), corridorRoute: id(41), pnRoute: id(42), calaviRoute: id(43), soldOutRoute: id(44), natitingouRoute: id(45),
  cotonouStop: id(50), godomeyStop: id(51), calaviStop: id(52), bohiconStop: id(53),
  dassaStop: id(54), saveStop: id(55), parakouStop: id(56), portoNovoStop: id(57), natitingouStop: id(58),
  service1: id(60), service2: id(61), service3: id(62), service4: id(63), serviceSoldOut: id(64), service6: id(65),
  soldOutBooking: id(70),
};
// Canonical geography ids from the benin-geography migration.
const PLACE = {
  cotonou: '00000000-0000-4000-b000-000000000181', parakou: '00000000-0000-4000-b000-000000000145',
  bohicon: '00000000-0000-4000-b000-0000000001c3', dassa: '00000000-0000-4000-b000-000000000152',
  save: '00000000-0000-4000-b000-000000000156', calavi: '00000000-0000-4000-b000-000000000131',
  portoNovo: '00000000-0000-4000-b000-0000000001a8',
  natitingou: '00000000-0000-4000-b000-000000000126',
};
// Real Benin coordinates along RNIE 2 / RNIE 1, route order [lon, lat].
const COORDS = {
  cotonou: [2.4183, 6.3654], godomey: [2.3899, 6.4102], calavi: [2.3556, 6.4486], bohicon: [2.0667, 7.1783],
  dassa: [2.1833, 7.7500], save: [2.3402, 7.9011], parakou: [2.6300, 9.3370], portoNovo: [2.6104, 6.4969], natitingou: [1.379, 10.305],
};
const RNIE2_CORRIDOR = [[2.4183, 6.3654], [2.3899, 6.4102], [2.3556, 6.4486], [2.2712, 6.5521], [2.1511, 6.6656],
  [2.1188, 6.8402], [2.0876, 7.0195], [2.0667, 7.1783], [2.1004, 7.3925], [2.1562, 7.5688], [2.1833, 7.7500],
  [2.3402, 7.9011], [2.4833, 8.0333], [2.5389, 8.4127], [2.5901, 8.7903], [2.6104, 9.0512], [2.6300, 9.3370]];

const hours = h => `now()+interval '${h} hours'`;

export async function seedTestTransport(db) {
  assertDisposableSchema(db, { purpose: 'TEST transport seed' });
  return db.transaction(async transaction => {
  await transaction.query("SELECT pg_advisory_xact_lock(hashtext('test-transport-seed'))");
  // Never convert a colliding real record to synthetic data.
  for (const table of ['users','operators','vehicles','routes','stops','services']) {
    const collision = await transaction.query(`SELECT id FROM ${table} WHERE id=ANY($1::uuid[]) AND NOT is_demo`, [Object.values(TEST)]);
    if (collision.rowCount) throw new Error('TEST seed refuses an existing real record.');
  }
  await cleanupTestServices(transaction);
  const step = async (_label, fn) => fn(transaction);

  // ---- identities & operators (all structurally is_demo, all TEST-named) ----
  // users.operator_id references operators, so users are created unlinked,
  // then the operators (which reference their owners), then the links.
  await step('identities', async t => {
    await t.query(`INSERT INTO users(id,display_name,role,operator_id,is_demo) VALUES
      ($1,'TEST Passenger','passenger',NULL,true),
      ($2,'TEST Chauffeur 01','driver',NULL,true),
      ($3,'TEST Chauffeur 02','driver',NULL,true),
      ($4,'TEST Chauffeur 03','driver',NULL,true),
      ($5,'TEST Chauffeur Soldout','driver',NULL,true),
      ($6,'TEST Chauffeur Compagnie','driver',NULL,true),
      ($9,'TEST Chauffeur Natitingou','driver',NULL,true),
      ($7,'TEST Company Ops','ops',NULL,true),
      ($8,'TEST Platform Ops','ops',NULL,true)
      ON CONFLICT(id) DO NOTHING`,
    [TEST.passenger, TEST.driver1, TEST.driver2, TEST.driver3, TEST.driver4, TEST.companyDriver, TEST.companyOps, TEST.opsUser, TEST.companyDriver2]);
    await t.query(`INSERT INTO passenger_profiles(user_id) VALUES($1) ON CONFLICT DO NOTHING`, [TEST.passenger]);
    await t.query(`INSERT INTO operators(id,name,type,owner_user_id,is_demo,verification_status) VALUES
      ($1,'TEST Compagnie LeRoutier','company',NULL,true,'verified'),
      ($2,'TEST Chauffeur 01','independent',$3,true,'verified'),
      ($4,'TEST Chauffeur 02','independent',$5,true,'verified'),
      ($6,'TEST Chauffeur 03','independent',$7,true,'verified'),
      ($8,'TEST Chauffeur Soldout','independent',$9,true,'verified')
      ON CONFLICT(id) DO NOTHING`,
    [TEST.company, TEST.driver1Op, TEST.driver1, TEST.driver2Op, TEST.driver2, TEST.driver3Op, TEST.driver3, TEST.driver4Op, TEST.driver4]);
    await t.query(`UPDATE users SET operator_id=$2 WHERE id=$1`, [TEST.driver1, TEST.driver1Op]);
    await t.query(`UPDATE users SET operator_id=$2 WHERE id=$1`, [TEST.driver2, TEST.driver2Op]);
    await t.query(`UPDATE users SET operator_id=$2 WHERE id=$1`, [TEST.driver3, TEST.driver3Op]);
    await t.query(`UPDATE users SET operator_id=$2 WHERE id=$1`, [TEST.driver4, TEST.driver4Op]);
    await t.query(`UPDATE users SET operator_id=$2 WHERE id=$1`, [TEST.companyDriver, TEST.company]);
    await t.query(`UPDATE users SET operator_id=$2 WHERE id=$1`, [TEST.companyDriver2, TEST.company]);
    await t.query(`UPDATE users SET operator_id=$2 WHERE id=$1`, [TEST.companyOps, TEST.company]);
    await t.query(`INSERT INTO driver_profiles(user_id,operator_id,license_reference) VALUES
     ($1,$2,'TEST-LIC-01'),($3,$4,'TEST-LIC-02'),($5,$6,'TEST-LIC-03'),($7,$8,'TEST-LIC-04'),($9,$10,'TEST-LIC-05'),($11,$12,'TEST-LIC-06')
      ON CONFLICT(user_id) DO NOTHING`,
    [TEST.driver1, TEST.driver1Op, TEST.driver2, TEST.driver2Op, TEST.driver3, TEST.driver3Op, TEST.driver4, TEST.driver4Op, TEST.companyDriver, TEST.company,
     TEST.companyDriver2, TEST.company]);
  });

  // ---- stops on the canonical geography ----
  await step('stops', async t => {
    const rows = [
      [TEST.cotonouStop, PLACE.cotonou, 'Gare de Cotonou', COORDS.cotonou],
      [TEST.godomeyStop, PLACE.cotonou, 'Godomey – Carrefour', COORDS.godomey],
      [TEST.calaviStop, PLACE.calavi, 'Calavi Centre', COORDS.calavi],
      [TEST.bohiconStop, PLACE.bohicon, 'Gare de Bohicon', COORDS.bohicon],
      [TEST.dassaStop, PLACE.dassa, 'Gare de Dassa-Zoumè', COORDS.dassa],
      [TEST.saveStop, PLACE.save, 'Gare de Savè', COORDS.save],
      [TEST.parakouStop, PLACE.parakou, 'Gare de Parakou', COORDS.parakou],
      [TEST.portoNovoStop, PLACE.portoNovo, 'Gare de Porto-Novo', COORDS.portoNovo],
      [TEST.natitingouStop, PLACE.natitingou, 'Gare de Natitingou', COORDS.natitingou],
    ];
    for (const [stopId, placeId, name, [lon, lat]] of rows) {
      await t.query(`INSERT INTO stops(id,place_id,name,latitude,longitude,is_demo) VALUES($1,$2,$3,$4,$5,true)
        ON CONFLICT(id) DO UPDATE SET latitude=$4,longitude=$5,is_demo=true`, [stopId, placeId, 'TEST ' + name, lat, lon]);
    }
  });

  // ---- vehicles: TEST registrations and models ----
  const vehicleRows = [
    [TEST.vehicle1, TEST.driver1Op, 'TEST-001', 3, 'TEST Toyota Hiace'],
    [TEST.vehicle2, TEST.company, 'TEST-002', 18, 'TEST Autocar'],
    [TEST.vehicle3, TEST.driver2Op, 'TEST-003', 4, 'TEST Toyota Hiace'],
    [TEST.vehicle4, TEST.driver3Op, 'TEST-004', 1, 'TEST Minibus'],
    [TEST.vehicle5, TEST.driver4Op, 'TEST-005', 1, 'TEST Minibus'],
    [TEST.vehicle6, TEST.company, 'TEST-006', 30, 'TEST Autocar'],
  ];
  await step('vehicles', async t => {
    for (const [vehicleId, operatorId, registration, capacity, model] of vehicleRows) {
      await t.query(`INSERT INTO vehicles(id,operator_id,registration,capacity,status,model,is_demo) VALUES($1,$2,$3,$4,'active',$5,true)
        ON CONFLICT(id) DO UPDATE SET registration=$3,capacity=$4,model=$5`,
      [vehicleId, operatorId, registration, capacity, model]);
    }
  });

  // ---- routes (route_stops mutate together: the order trigger is deferred
  //      to commit, so delete + insert must share one transaction) ----
  /** @type {Array<[string,string,string,Array<[string,number]>]>} */
  const routeRows = [
    [TEST.expressRoute, TEST.driver1Op, 'TEST Service Cotonou–Parakou', [[TEST.cotonouStop, 7500], [TEST.parakouStop, 0]]],
    [TEST.corridorRoute, TEST.company, 'TEST Corridor Cotonou–Parakou', [[TEST.cotonouStop, 2000], [TEST.bohiconStop, 2000], [TEST.dassaStop, 2000], [TEST.saveStop, 2000], [TEST.parakouStop, 0]]],
    [TEST.pnRoute, TEST.driver2Op, 'TEST Service Cotonou–Porto-Novo', [[TEST.cotonouStop, 2500], [TEST.portoNovoStop, 2000]]],
    [TEST.calaviRoute, TEST.driver3Op, 'TEST Service Calavi–Bohicon', [[TEST.calaviStop, 3000], [TEST.bohiconStop, 2000]]],
    [TEST.soldOutRoute, TEST.driver4Op, 'TEST Service Soldout Cotonou–Parakou', [[TEST.cotonouStop, 7500], [TEST.parakouStop, 0]]],
    [TEST.natitingouRoute, TEST.company, 'TEST Cotonou → Natitingou', [[TEST.cotonouStop, 10000], [TEST.natitingouStop, 0]]],
  ];
  await step('routes', async t => {
    for (const [routeId, operatorId, name, stops] of routeRows) {
      await t.query(`INSERT INTO routes(id,operator_id,name,active,is_demo) VALUES($1,$2,$3,true,true)
        ON CONFLICT(id) DO UPDATE SET name=$3,active=true`, [routeId, operatorId, name]);
      await t.query(`DELETE FROM route_stops WHERE route_id=$1`, [routeId]);
      for (const [sequence, [stopId, fare]] of stops.entries()) {
        await t.query(`INSERT INTO route_stops(route_id,sequence,stop_id,fare_to_next) VALUES($1,$2,$3,$4)`, [routeId, sequence, stopId, fare]);
      }
    }
    const geometryHash = 'TEST-' + Buffer.from(JSON.stringify(RNIE2_CORRIDOR)).toString('base64').slice(0, 60);
    await t.query(`INSERT INTO route_geometries(route_id,coordinates,distance_m,provider,input_hash,stop_count) VALUES
      ($1,$2::jsonb,345000,'test_fixture',$3,5),($4,$2::jsonb,345000,'test_fixture',$3,2)
      ON CONFLICT(route_id) DO UPDATE SET coordinates=$2::jsonb,input_hash=$3`,
    [TEST.corridorRoute, JSON.stringify(RNIE2_CORRIDOR), geometryHash, TEST.expressRoute]);
  });

  // ---- services with relative schedules, refreshed on every run ----
  /** @type {Array<[string,string,string,string,string,string,string,number]>} */
  const serviceRows = [
    // TEST Chauffeur 01 — express Cotonou → Parakou, 3 seats, departs in 1h.
    [TEST.service1, TEST.expressRoute, TEST.driver1Op, TEST.vehicle1, TEST.driver1, hours(1), hours(7), 3],
    // TEST Compagnie LeRoutier — multi-stop corridor, 18 seats, departs in 1.5h.
    [TEST.service2, TEST.corridorRoute, TEST.company, TEST.vehicle2, TEST.companyDriver, hours(1.5), hours(7.5), 18],
    // TEST Chauffeur 02 — Cotonou → Porto-Novo, 4 seats, departs in 3h.
    [TEST.service3, TEST.pnRoute, TEST.driver2Op, TEST.vehicle3, TEST.driver2, hours(3), hours(5), 4],
    // TEST Chauffeur 03 — Calavi → Bohicon, 1 seat left, tomorrow morning.
    [TEST.service4, TEST.calaviRoute, TEST.driver3Op, TEST.vehicle4, TEST.driver3, hours(20), hours(22), 1],
    // TEST sold-out: one seat, occupied by a confirmed TEST booking.
    [TEST.serviceSoldOut, TEST.soldOutRoute, TEST.driver4Op, TEST.vehicle5, TEST.driver4, hours(2), hours(8), 1],
    [TEST.service6, TEST.natitingouRoute, TEST.company, TEST.vehicle6, TEST.companyDriver2, hours(24), hours(33), 30],
  ];
  await step('services', async t => {
    for (const [serviceId, routeId, operatorId, vehicleId, driverId, departure, arrival, capacity] of serviceRows) {
      const stops = (await t.query(`SELECT stop_id FROM route_stops WHERE route_id=$1 ORDER BY sequence`, [routeId])).rows.map(r => r.stop_id);
      await t.query(`INSERT INTO services(id,route_id,operator_id,departure_at,arrival_at,status,capacity,is_demo,current_sequence)
        VALUES($1,$2,$3,${departure},${arrival},'scheduled',$4,true,0)
        ON CONFLICT(id) DO UPDATE SET departure_at=${departure},arrival_at=${arrival},status='scheduled',current_sequence=0`,
      [serviceId, routeId, operatorId, capacity]);
      for (const [sequence, stopId] of stops.entries()) await t.query(`INSERT INTO service_stops(service_id,sequence,stop_id) VALUES($1,$2,$3)`, [serviceId, sequence, stopId]);
      for (let sequence = 0; sequence < stops.length - 1; sequence++) {
        const fare = (await t.query(`SELECT fare_to_next FROM route_stops WHERE route_id=$1 AND sequence=$2`, [routeId, sequence])).rows[0].fare_to_next;
        await t.query(`INSERT INTO service_segments(service_id,sequence,fare_minor) VALUES($1,$2,$3)`, [serviceId, sequence, fare]);
      }
      for (let seat = 1; seat <= capacity; seat++) await t.query(`INSERT INTO service_seats(service_id,seat_number) VALUES($1,$2)`, [serviceId, seat]);
      await t.query(`INSERT INTO service_assignments(service_id,vehicle_id,driver_id) VALUES($1,$2,$3)`, [serviceId, vehicleId, driverId]);
    }
    // The sold-out state: a confirmed TEST booking occupies the only seat.
    const seq = (await t.query(`SELECT sequence FROM service_stops WHERE service_id=$1 ORDER BY sequence`, [TEST.serviceSoldOut])).rows.map(r => r.sequence);
    await t.query(`INSERT INTO bookings(id,service_id,passenger_id,origin_sequence,destination_sequence,seat_number,status,amount_minor,expires_at,idempotency_key,request_fingerprint)
      VALUES($1,$2,$3,$4,$5,1,'confirmed',7500,NULL,'test-soldout-seed','test-soldout-seed-fingerprint')
      ON CONFLICT(id) DO NOTHING`, [TEST.soldOutBooking, TEST.serviceSoldOut, TEST.passenger, seq[0], seq.at(-1)]);
    await t.query(`INSERT INTO booking_passengers(booking_id,passenger_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [TEST.soldOutBooking, TEST.passenger]);
    await t.query(`INSERT INTO booking_segments(booking_id,service_id,seat_number,sequence)
      SELECT $1,$2,1,generate_series($3::integer,$4::integer-1)
      WHERE NOT EXISTS (SELECT 1 FROM booking_segments WHERE booking_id=$1)`, [TEST.soldOutBooking, TEST.serviceSoldOut, seq[0], seq.at(-1)]);
  });

  // ---- synthetic GPS progression for the active TEST service ----
  // The real GPS/ETA pipeline consumes these rows; they are labelled TEST
  // because the service itself is structurally is_demo — never mixed with
  // real tracking data.
  await step('gps', async t => {
    await t.query(`DELETE FROM vehicle_positions WHERE service_id=$1`, [TEST.service1]);
    for (const [i, [lon, lat]] of RNIE2_CORRIDOR.filter((_, i) => i % 4 === 0).entries()) {
      await t.query(`INSERT INTO vehicle_positions(service_id,vehicle_id,actor_id,latitude,longitude,observed_at)
        VALUES($1,$2,$3,$4,$5,now()-interval '1 hour'+interval '${i * 6} minutes')`,
      [TEST.service1, TEST.vehicle1, TEST.driver1, lat, lon]);
    }
  });

  return TEST;
  });
}
