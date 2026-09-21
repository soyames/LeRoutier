import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '@leroutier/database';
import { migrate } from '@leroutier/database/migrations';
import { dropDisposableSchema } from '@leroutier/database/guards';
import { seedTestProfiles } from '@leroutier/database/test-profiles';
import { tickets } from '@leroutier/database/tickets';
import { parcels } from '@leroutier/database/parcels';
import { transport } from '@leroutier/database/transport';
import { confirmationEmail } from '@leroutier/notifications/content';
import { notificationProviders } from '@leroutier/database/notification-providers';
import { TEST } from '@leroutier/database/test-transport';
import { createApi } from '../src/app.js';

const config={...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-',''),demoLogin:true};
const db=createDatabase(config);
let seeded,passenger,driver,api,token;
before(async()=>{
  await migrate(db);seeded=await seedTestProfiles(db);api=createApi(db,config);
  const response=await api(new Request('http://localhost/api/v1/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({profile:'passenger'})}));
  const session=(await response.json()).data;passenger=session.user;token=session.token;
  driver=(await db.transaction(tx=>tx.query('SELECT * FROM users WHERE id=$1',[TEST.driver1]))).rows[0];
});
after(async()=>{try{await dropDisposableSchema(db);}finally{await db.close();}});
test('concurrent ticket previews preserve the same QR, code and financial projection',async()=>{
  const [first,second]=await Promise.all([tickets(db).issue(passenger,seeded.bookings[0]),tickets(db).issue(passenger,seeded.bookings[0])]);
  assert.equal(first.token,second.token);assert.equal(first.manualCode,second.manualCode);assert.ok(first.validForBoarding);
  assert.equal(first.document.paidMinor,first.document.amount_minor);assert.equal(first.document.refundedMinor,0);
  assert.equal(first.document.passenger_name,'TEST Passenger');
  const privateCall=await api(new Request(`http://localhost/api/v1/bookings/${seeded.bookings[0]}/ticket`,{method:'POST',body:'{}'}));
  assert.equal(privateCall.status,401);
  await assert.rejects(tickets(db).issue({...passenger,id:randomUUID()},seeded.bookings[0]),{code:'FORBIDDEN'});
  const authenticated=await api(new Request(`http://localhost/api/v1/bookings/${seeded.bookings[0]}/ticket`,{method:'POST',body:'{}',headers:{authorization:'Bearer '+token,'content-type':'application/json'}}));
  assert.equal(authenticated.status,200);assert.match(authenticated.headers.get('cache-control'),/no-store/);
});
test('boarded and completed tickets reopen as archives without a reusable boarding QR',async()=>{
  const domain=transport(db),id=seeded.bookings[0];
  await domain.transition(driver,id,'board',0);
  const boarded=await tickets(db).issue(passenger,id);
  assert.equal(boarded.document.status,'boarded');assert.equal(boarded.validForBoarding,false);assert.equal(boarded.token,null);
  const destination=boarded.document.destination_sequence;
  await db.transaction(tx=>tx.query('UPDATE services SET current_sequence=$2 WHERE id=$1',[TEST.service1,destination]));
  await domain.transition(driver,id,'alight',destination);
  assert.equal((await tickets(db).issue(passenger,id)).document.status,'completed');
});
test('cancellation document separates pending review from actual refunded payments',async()=>{
  const id=seeded.bookings[1];await transport(db).transition(passenger,id,'cancel');
  const cancelled=await tickets(db).issue(passenger,id);
  assert.equal(cancelled.document.status,'cancelled');assert.equal(cancelled.token,null);assert.equal(cancelled.document.refundedMinor,0);
  assert.ok(cancelled.document.paidMinor>0);
  await db.transaction(tx=>tx.query("UPDATE payments SET status='refunded' WHERE booking_id=$1",[id]));
  const refunded=await tickets(db).issue(passenger,id);
  assert.equal(refunded.document.refundedMinor,refunded.document.paidMinor);
});
test('intermediate boarding uses the booked stop and does not invent a timetable',async()=>{
  const domain=transport(db);
  const b=await domain.hold(passenger,{serviceId:TEST.service2,origin:1,destination:2},randomUUID());
  await domain.simulatedTestPayment(passenger,b.id,randomUUID());
  const result=await tickets(db).issue(passenger,b.id);
  const stop=(await db.transaction(tx=>tx.query('SELECT p.name,st.name AS point FROM service_stops ss JOIN stops st ON st.id=ss.stop_id JOIN places p ON p.id=st.place_id WHERE ss.service_id=$1 AND ss.sequence=1',[TEST.service2]))).rows[0];
  assert.equal(result.document.departure_city,stop.name);assert.equal(result.departure.name,stop.point);
  assert.equal(result.document.departure_at,null);assert.equal(result.document.arrival_at,null);
});
test('parcel label reopens with contacts, true payment status and stable QR; public tracking stays private',async()=>{
  const cargo=parcels(db),p=(await cargo.listMine(passenger))[0];
  const [a,b]=await Promise.all([cargo.label(passenger,p.id),cargo.label(passenger,p.id)]);
  assert.equal(a.token,b.token);assert.equal(a.version,b.version);assert.ok(a.parties.sender.phone);assert.ok(a.parties.receiver.name);
  assert.equal(a.paymentStatus,'unpaid');assert.equal(a.paidMinor,0);assert.match(a.trackingUrl,/^https:\/\/leroutier.app\/parcels\/track\?ref=LRP-/);
  const publicData=JSON.stringify(await cargo.publicTracking(a.trackingNumber));
  assert.ok(!publicData.includes(a.parties.sender.phone));assert.ok(!publicData.includes(a.token));
  const crew=(await db.transaction(tx=>tx.query("SELECT u.* FROM users u JOIN service_assignments sa ON sa.driver_id=u.id JOIN parcel_service_assignments p ON p.service_id=sa.service_id WHERE p.parcel_id=$1 AND sa.ended_at IS NULL",[p.id]))).rows[0];
  assert.equal((await cargo.lookupDriver(crew,a.trackingUrl)).id,p.id);
});
test('confirmation email escapes passenger input and links to the protected unified booking',async()=>{
  const b=(await tickets(db).issue(passenger,seeded.bookings[0])).document;
  const mail=confirmationEmail({...b,passenger_name:'<script>alert("x")</script>'});
  assert.ok(mail.html.includes('&lt;script&gt;'));assert.ok(!mail.html.includes('<script>'));
  assert.ok(mail.html.includes('https://leroutier.app/tickets/'+b.id));assert.ok(mail.text.includes(b.operator_name));
  assert.ok(!mail.html.includes('LRT1.'));assert.ok(mail.subject.includes('Voyage terminé'));
});
test('notification gateway requires HTTPS and accepts only provider acknowledgment with stable idempotency',async()=>{
  assert.deepEqual(notificationProviders(db,{notificationProviders:{email:{url:'http://invalid.test',key:'test'}}}),{});
  const calls=[];
  const providers=notificationProviders(db,{notificationProviders:{sms:{url:'https://gateway.example.invalid/send',key:'TEST-key'}}},async(url,options)=>{
    calls.push({url,options});return new Response(JSON.stringify({accepted:true}),{status:200});
  });
  const result=await providers.sms.send({notification:{contact:'+00000000000',template:'parcel_loaded',data:{trackingNumber:'LRP-12345678'}},idempotencyKey:'TEST-delivery'});
  assert.equal(result.accepted,true);assert.equal(calls[0].options.headers['idempotency-key'],'TEST-delivery');
  assert.ok(JSON.parse(calls[0].options.body).text.includes('Colis chargé'));
});
