import { createDatabase } from '../src/index.js';
import { seed, demo } from '../src/seed.js';
import { transport } from '../src/transport.js';
const db = createDatabase();
try {
  await seed(db);
  const api = transport(db);
  const passenger = {id:demo.passenger,role:'passenger'};
  const ops = {id:demo.ops,role:'ops',operator_id:demo.operator};
  const booking = await api.hold(passenger,{serviceId:demo.service,origin:0,destination:1},'development-seed-booking-v1');
  if (booking.status === 'held') {
    await api.recordPayment(ops,booking.id,{provider:'demo',reference:'development-seed-payment',amountMinor:booking.amount_minor,currency:'XOF'},'development-seed-payment-v1');
    await api.transition(passenger,booking.id,'confirm');
  }
  console.log('Development corridor and sample booking seeded.');
} catch (error) { console.error('Development seed failed.', error.code || 'SEED_ERROR'); process.exitCode=1; }
finally { await db.close(); }
