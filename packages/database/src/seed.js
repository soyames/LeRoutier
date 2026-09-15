export const demoId = number => `00000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
export const demo = { operator:demoId(1), passenger:demoId(2), driver:demoId(3), ops:demoId(4),
  route:demoId(10), vehicle:demoId(20), replacement:demoId(21), service:demoId(30) };

export async function seed(db, { capacity = 12 } = {}) {
  if (!db.schema.endsWith('_dev') && !db.schema.startsWith('lr_test_')) throw new Error('Seed requires an isolated development or test schema.');
  await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['seed-' + db.schema]);
    if ((await tx.query('SELECT id FROM services WHERE id=$1', [demo.service])).rowCount) return;
    await tx.query("INSERT INTO operators(id,name,is_demo) VALUES($1,'DEMO - Corridor Benin',true) ON CONFLICT DO NOTHING", [demo.operator]);
    for (const [id, name, role] of [[demo.passenger,'Passager Démo','passenger'],[demo.driver,'Conducteur Démo','driver'],[demo.ops,'Régulation Démo','ops']]) {
      await tx.query('INSERT INTO users(id,display_name,role,operator_id,is_demo) VALUES($1,$2,$3,$4,true) ON CONFLICT DO NOTHING', [id,name,role,role==='passenger'?null:demo.operator]);
    }
    await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1) ON CONFLICT DO NOTHING', [demo.passenger]);
    await tx.query("INSERT INTO driver_profiles(user_id,operator_id,license_reference) VALUES($1,$2,'DEMO-NOT-A-LICENSE') ON CONFLICT DO NOTHING", [demo.driver,demo.operator]);
    const cities = [['Cotonou','Jonquet (démo)',6.36,2.43],['Bohicon','Zakpo (démo)',7.18,2.07],['Dassa-Zoumè','Relais (démo)',7.75,2.18],['Parakou','Gare centrale (démo)',9.34,2.63]];
    await tx.query("INSERT INTO routes(id,operator_id,name) VALUES($1,$2,'DEMO Cotonou → Bohicon → Dassa → Parakou') ON CONFLICT DO NOTHING", [demo.route,demo.operator]);
    for (const [i,[city,name,lat,lon]] of cities.entries()) {
      await tx.query('INSERT INTO places(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [demoId(100+i),city]);
      await tx.query('INSERT INTO stops(id,place_id,name,latitude,longitude) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [demoId(200+i),demoId(100+i),name,lat,lon]);
      await tx.query('INSERT INTO route_stops(route_id,sequence,stop_id,fare_to_next) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [demo.route,i,demoId(200+i),i<3?[2500,2000,3000][i]:0]);
    }
    for (const [id,reg] of [[demo.vehicle,'DEMO-BUS-01'],[demo.replacement,'DEMO-RESERVE-01']]) {
      await tx.query('INSERT INTO vehicles(id,operator_id,registration,capacity) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id,demo.operator,reg,capacity]);
    }
    await tx.query("INSERT INTO services(id,route_id,operator_id,departure_at,status,capacity,is_demo) VALUES($1,$2,$3,now()+interval '1 day','active',$4,true)", [demo.service,demo.route,demo.operator,capacity]);
    await tx.query('INSERT INTO service_assignments(service_id,vehicle_id,driver_id) VALUES($1,$2,$3)', [demo.service,demo.vehicle,demo.driver]);
    await tx.query('INSERT INTO service_stops(service_id,sequence,stop_id) SELECT $1,sequence,stop_id FROM route_stops WHERE route_id=$2', [demo.service,demo.route]);
    await tx.query('INSERT INTO service_segments(service_id,sequence,fare_minor) SELECT $1,sequence,fare_to_next FROM route_stops WHERE route_id=$2 AND sequence<3', [demo.service,demo.route]);
    await tx.query('INSERT INTO service_seats(service_id,seat_number) SELECT $1,generate_series(1,$2::integer)',[demo.service,capacity]);
    // Demo parcel pricing fixture: explicit operator-configured rate rule only.
    await tx.query('INSERT INTO parcel_rate_rules(operator_id,base_minor,per_kg_minor,declared_value_bp) VALUES($1,1000,500,0) ON CONFLICT DO NOTHING',[demo.operator]);
  });
  return demo;
}
