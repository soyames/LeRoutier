import { assertDisposableSchema } from './guards.js';
import { seedTestTransport, TEST } from './test-transport.js';
import { activeIdentity } from './identities.js';
import { transport } from './transport.js';
import { parcels } from './parcels.js';
import { recordIncident } from './driver-actions.js';

export const TEST_CONVOYEUR = '00000000-0000-4000-b00b-000000000003';

// Long-lived, local-only inspection data. Repeating this preserves completed
// work; it never resets custody or bookings underneath a signed-in tester.
export async function seedTestProfiles(db) {
  assertDisposableSchema(db, { purpose: 'TEST profiles' });
  const exists = await db.transaction(tx=>tx.query('SELECT id FROM services WHERE id=$1 AND is_demo', [TEST.service2]));
  if (!exists.rowCount) await seedTestTransport(db);
  await db.transaction(async tx=>{
    const collision = await tx.query('SELECT id FROM users WHERE id=$1 AND NOT is_demo',[TEST_CONVOYEUR]);
    if (collision.rowCount) throw new Error('TEST profiles refuse an existing real identity.');
    await tx.query(`INSERT INTO users(id,display_name,role,operator_id,is_demo) VALUES($1,'TEST Convoyeur','convoyeur',$2,true) ON CONFLICT DO NOTHING`,[TEST_CONVOYEUR,TEST.company]);
    await tx.query('INSERT INTO convoyeur_profiles(user_id,operator_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[TEST_CONVOYEUR,TEST.company]);
    await tx.query('UPDATE service_assignments SET convoyeur_id=$2 WHERE service_id=$1 AND ended_at IS NULL',[TEST.service2,TEST_CONVOYEUR]);
    await tx.query(`UPDATE services SET status='active',departure_at=now()+interval '1 hour',arrival_at=now()+interval '7 hours'
      WHERE id=ANY($1::uuid[]) AND is_demo AND status='scheduled'`,[[TEST.service1,TEST.service2]]);
    for (const operator of [TEST.company,TEST.driver1Op]) {
      await tx.query(`INSERT INTO parcel_rate_rules(operator_id,base_minor,per_kg_minor,declared_value_bp)
        SELECT $1,1000,500,0 WHERE NOT EXISTS(SELECT 1 FROM parcel_rate_rules WHERE operator_id=$1)`,[operator]);
    }
  });
  const identity = id=>db.transaction(tx=>activeIdentity(tx,id));
  const passenger = await identity(TEST.passenger), platform = await identity(TEST.opsUser);
  const domain = transport(db), cargo = parcels(db);
  const bookings = [], shipments = [];
  for (const [serviceId,driverId,destination] of [[TEST.service1,TEST.driver1,1],[TEST.service2,TEST.companyDriver,4]]) {
    const driver = await identity(driverId);
    const booking = await domain.hold(passenger,{serviceId,origin:0,destination},'test-profile-booking-'+serviceId);
    if (booking.status==='held') await domain.simulatedTestPayment(passenger,booking.id,'test-profile-payment-'+serviceId);
    bookings.push(booking.id);
    const shipment = await cargo.create(passenger,{
      senderName:'TEST Expéditeur',senderPhone:'+00000000001',receiverName:'TEST Destinataire',receiverPhone:'+00000000002',
      originStopId:TEST.cotonouStop,destinationStopId:TEST.parakouStop,operatorId:driver.operator_id,category:'documents',
    },'test-profile-parcel-'+serviceId);
    if(shipment.status==='created') await cargo.accept(platform,shipment.id);
    if(['created','accepted'].includes(shipment.status)) await cargo.assign(platform,shipment.id,{serviceId});
    shipments.push(shipment.trackingNumber);
    const incident = await db.transaction(tx=>tx.query("SELECT id FROM incidents WHERE service_id=$1 AND description='TEST — ralentissement signalé, service maintenu.'",[serviceId]));
    if(!incident.rowCount) await recordIncident(db,driver,{serviceId,kind:'delay',severity:'low',description:'TEST — ralentissement signalé, service maintenu.'});
  }
  return {bookings,shipments};
}
