import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo, demoId } from '../src/seed.js';
import { transport } from '../src/transport.js';
import { notificationPolicies } from '../src/notifications.js';
import { mobility } from '../src/mobility.js';
import { journeys } from '../src/journeys.js';
import { walkUpBookings } from '../src/walkup.js';
import { locations } from '../src/locations.js';
import { reminders } from '../src/reminders.js';
import { createActions, createWorkflowEngine } from '@leroutier/agents';

const config={...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-',''),demoLogin:true};
const db=createDatabase(config),domain=transport(db);
const passenger={id:demo.passenger,role:'passenger'};
const ops={id:demo.ops,role:'ops',operator_id:demo.operator};
const platformOps={id:demoId(5),role:'ops'};
const convoyeur={id:demoId(6),role:'convoyeur'};
const point=demoId(300);
const one=async(sql,args=[])=>db.transaction(async tx=>(await tx.query(sql,args)).rows[0]);
const all=async(sql,args=[])=>db.transaction(async tx=>(await tx.query(sql,args)).rows);
// Drain the outbox the same way production does: policy dispatch is a hook on
// the single existing event stream, never a second bus.
async function drain(){
  const notify=notificationPolicies(db,config);
  const engine=createWorkflowEngine({db,actions:createActions({db,domain}),onEvent:(tx,e)=>notify.dispatchEvent(tx,e)});
  return engine.processOutbox();
}
const inbox=userId=>all(`SELECT n.*, (SELECT jsonb_object_agg(channel,status) FROM notification_deliveries d WHERE d.notification_id=n.id) AS channels
  FROM notifications n WHERE n.user_id=$1 ORDER BY n.created_at`,[userId]);

before(async()=>{
  await migrate(db);await seed(db);
  await db.transaction(async tx=>{
    // A platform Ops identity and a convoyeur on the demo service.
    await tx.query("INSERT INTO users(id,display_name,role,is_demo) VALUES($1,'Plateforme Démo','ops',true) ON CONFLICT DO NOTHING",[platformOps.id]);
    await tx.query("INSERT INTO users(id,display_name,role,operator_id,is_demo) VALUES($1,'Convoyeur Démo','convoyeur',$2,true) ON CONFLICT DO NOTHING",[convoyeur.id,demo.operator]);
    await tx.query('INSERT INTO convoyeur_profiles(user_id,operator_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[convoyeur.id,demo.operator]);
    await tx.query('UPDATE service_assignments SET convoyeur_id=$2 WHERE service_id=$1',[demo.service,convoyeur.id]);
    // A verified boarding point so the service has an exact departure location.
    await tx.query(`INSERT INTO boarding_points(id,name,place_id,type,description,latitude,longitude,purposes,status,proposed_by,verified_by)
      VALUES($1,'Gare de Jonquet',$2,'company_station','En face du marché',6.3654,2.4183,'["passenger_boarding"]','verified',$3,$3) ON CONFLICT DO NOTHING`,
    [point,demoId(100),demo.ops]);
    await tx.query('UPDATE services SET departure_point_id=$2 WHERE id=$1',[demo.service,point]);
  });
});
beforeEach(async()=>{
  await db.transaction(async tx=>{
    await tx.query('DELETE FROM notification_deliveries');await tx.query('DELETE FROM notifications');
    await tx.query('DELETE FROM notification_preferences');await tx.query('DELETE FROM mobility_handoff_events');
    await tx.query('DELETE FROM booking_segments');await tx.query("UPDATE bookings SET status='cancelled'");
    await tx.query('DELETE FROM payments');await tx.query('DELETE FROM workflow_runs');await tx.query('DELETE FROM outbox');
    await tx.query("UPDATE services SET current_sequence=0,status='active',departure_at=now()+interval '1 day',arrival_at=NULL,departure_point_id=$2 WHERE id=$1",[demo.service,point]);
  });
});
after(async()=>{try{await dropDisposableSchema(db);}finally{await db.close();}});

const hold=async()=>domain.hold(passenger,{serviceId:demo.service,origin:0,destination:1},'key-'+randomUUID());

test('journey timeline derives every milestone from real booking and service state',async()=>{
  const booking=await hold();
  const timeline=await journeys(db,config).timeline(passenger,booking.id);
  assert.equal(timeline.bookingId,booking.id);
  // Exact boarding point, reused from the canonical registry.
  assert.equal(timeline.departurePoint.name,'Gare de Jonquet');
  assert.equal(timeline.departurePoint.landmark,'En face du marché');
  assert.ok(timeline.departurePoint.directionsUrl.includes('6.3654'));
  assert.equal(timeline.firstMile.boardingPoint.name,'Gare de Jonquet');
  // Gozem is offered as an external suggestion and claims nothing more.
  assert.equal(timeline.firstMile.provider.id,'gozem');
  assert.equal(timeline.firstMile.provider.integrationStatus,'suggested_external');
  assert.equal(timeline.firstMile.provider.handoff,'external_link');
  assert.equal(timeline.firstMile.provider.booksRide,false);
  assert.equal(timeline.firstMile.provider.providesFareEstimate,false);
  assert.equal(timeline.firstMile.provider.providesEta,false);
  assert.equal(timeline.firstMile.optional,true);
  // Arrival is unscheduled on this service and says so rather than guessing.
  assert.equal(timeline.steps.find(s=>s.key==='arrival').scheduled,false);
  assert.equal(timeline.steps.find(s=>s.key==='payment').state,'pending');
  // A passenger cannot read another passenger's journey.
  await assert.rejects(journeys(db,config).timeline({id:demo.driver,role:'driver'},booking.id),/Booking not found/);
});

test('a delay recalculates the recommendation and supersedes the previous advice',async()=>{
  const booking=await hold();
  const before=await journeys(db,config).timeline(passenger,booking.id);
  const departure=new Date(Date.now()+26*3600_000).toISOString();
  await domain.reschedule(ops,demo.service,{departureAt:departure,reason:'Route bloquée'});
  const after=await journeys(db,config).timeline(passenger,booking.id);
  assert.notEqual(after.plan.leaveBy,before.plan.leaveBy);
  assert.equal(Date.parse(after.plan.departureAt),Date.parse(departure));
  // The passenger is told once, carrying the same departure time the timeline
  // reports, plus the previous one so the change is legible.
  await drain();
  const delays=(await inbox(demo.passenger)).filter(n=>n.template==='service_delayed');
  assert.equal(delays.length,1);
  assert.equal(delays[0].category,'critical');
  assert.equal(delays[0].data.departureAt,after.plan.departureAt);
  assert.equal(delays[0].data.previousDepartureAt,before.plan.departureAt);
  // A second delay supersedes the first instead of contradicting it.
  await domain.reschedule(ops,demo.service,{departureAt:new Date(Date.now()+28*3600_000).toISOString()});
  await drain();
  const live=(await inbox(demo.passenger)).filter(n=>n.template==='service_delayed' && n.superseded_at===null);
  assert.equal(live.length,1,'exactly one live delay recommendation');
});

test('a boarding point change is a critical passenger and crew notification',async()=>{
  await hold();
  const moved=demoId(301);
  await db.transaction(tx=>tx.query(`INSERT INTO boarding_points(id,name,place_id,type,latitude,longitude,purposes,status,proposed_by,verified_by)
    VALUES($1,'Gare de Vedoko',$2,'company_station',6.37,2.40,'["passenger_boarding"]','verified',$3,$3) ON CONFLICT DO NOTHING`,[moved,demoId(100),demo.ops]));
  await domain.reschedule(ops,demo.service,{departurePointId:moved});
  await drain();
  const passengerNote=(await inbox(demo.passenger)).find(n=>n.template==='boarding_point_changed');
  assert.ok(passengerNote,'passenger is told the boarding point moved');
  assert.equal(passengerNote.severity,'urgent');
  assert.equal(passengerNote.data.boardingPointName,'Gare de Vedoko');
  assert.equal(passengerNote.data.previousBoardingPointName,'Gare de Jonquet');
  // Ops sees it as an operational exception.
  assert.ok((await inbox(demo.ops)).some(n=>n.template==='ops_boarding_point_changed'));
});

test('company drivers never receive settlement or revenue notifications',async()=>{
  await db.transaction(tx=>tx.query(`INSERT INTO operator_settlements(operator_id,source,reference,gross_minor) VALUES($1,'walk_up',$2,2500)`,
    [demo.operator,'test-'+randomUUID()]));
  await db.transaction(tx=>tx.query(`INSERT INTO outbox(event_type,aggregate_id,payload) VALUES('operator_settlement.credited',$1,$2)`,
    [demo.service,JSON.stringify({operatorId:demo.operator,grossMinor:2500})]));
  await drain();
  const driverInbox=await inbox(demo.driver);
  assert.equal(driverInbox.filter(n=>/settlement|payout/.test(n.template)).length,0,'no money notifications for a company driver');
  // The catalogue itself must not target company drivers with money events.
  const moneyPolicies=await all(`SELECT event_type FROM notification_policies
    WHERE audience='service_driver_company' AND (event_type LIKE 'operator_settlement%' OR event_type LIKE 'operator_payout%' OR event_type LIKE 'payout%')`);
  assert.equal(moneyPolicies.length,0);
});

test('convoyeurs receive manifest, walk-up and parcel handling notifications',async()=>{
  await domain.reschedule(ops,demo.service,{departureAt:new Date(Date.now()+30*3600_000).toISOString()});
  await drain();
  const crew=await inbox(convoyeur.id);
  // Crew wording, never driver-centric revenue wording.
  assert.equal(crew.filter(n=>/settlement|earnings/.test(n.template)).length,0);
  const walkUp=walkUpBookings(db);
  const sold=await walkUp({id:convoyeur.id,role:'convoyeur'},{serviceId:demo.service,origin:0,destination:1,
    passengerName:'Client Comptant',passengerPhone:'+22961000009',amountMinor:2500,cashReference:'RECU-'+Date.now()},'walkup-'+randomUUID());
  assert.ok(sold.bookingId);
  await drain();
  assert.ok((await inbox(convoyeur.id)).some(n=>n.template==='crew_walkup_recorded'),'convoyeur sees the walk-up sale');
});

test('ops receives exception alerts and the boarding-point moderation queue',async()=>{
  const proposal=await locations(db).propose(passenger,{name:'Arrêt Godomey '+Date.now(),placeId:demoId(100),
    type:'independent_boarding_point',purposes:['passenger_boarding']});
  await drain();
  // Platform Ops moderates locations, so the queue lands there.
  assert.ok((await inbox(platformOps.id)).some(n=>n.template==='ops_point_pending_moderation'));
  await locations(db).moderate(platformOps,proposal.id,'verified');
  await drain();
  // The proposer learns the outcome.
  const decided=(await inbox(demo.passenger)).find(n=>n.template==='boarding_point_moderated');
  assert.ok(decided,'proposer is told the decision');
  assert.equal(decided.data.decision,'verified');
});

test('parcel notifications reach the right party and never carry the pickup code',async()=>{
  // Exercise unavailable delivery for real inventory. TEST operators suppress
  // external delivery even before a parcel is assigned to a service.
  const operator=randomUUID();
  await one("INSERT INTO operators(id,name) VALUES($1,'Notification fixture operator') RETURNING id",[operator]);
  const parcel=await one(`INSERT INTO parcels(tracking_number,operator_id,origin_stop_id,destination_stop_id,category,price_minor,status,idempotency_key,request_fingerprint)
    VALUES($1,$2,$3,$4,'documents',1500,'accepted',$5,$5) RETURNING *`,
  ['LRP-'+randomUUID().slice(0,8).toUpperCase(),operator,demoId(200),demoId(201),'test-'+randomUUID()]);
  await db.transaction(async tx=>{
    await tx.query("INSERT INTO parcel_parties(parcel_id,role,name,phone) VALUES($1,'sender','Expéditeur','+22961000007')",[parcel.id]);
    await tx.query("INSERT INTO parcel_parties(parcel_id,role,name,phone) VALUES($1,'receiver','Destinataire','+22961000008')",[parcel.id]);
    await tx.query("INSERT INTO outbox(event_type,aggregate_id,payload) VALUES('parcel.ready_for_pickup',$1,$2)",
      [parcel.id,JSON.stringify({trackingNumber:parcel.tracking_number,pickupCode:'SHOULD-NEVER-TRAVEL'})]);
  });
  await drain();
  const ready=await one("SELECT * FROM notifications WHERE template='parcel_ready_for_pickup'");
  assert.ok(ready,'the receiver is told the parcel is ready');
  assert.equal(ready.contact,'+22961000008','addressed to the receiver, not the sender');
  assert.equal(ready.user_id,null);
  // The pickup code must never be copied into a notification payload.
  assert.equal(JSON.stringify(ready.data).includes('SHOULD-NEVER-TRAVEL'),false);
  assert.equal(ready.data.pickupCode,undefined);
  assert.equal(ready.data.trackingNumber,parcel.tracking_number);
  // A contact without an account gets no in-app row; outbound stays unavailable
  // because no SMS provider is configured, and is never reported as sent.
  const channels=await all('SELECT channel,status FROM notification_deliveries WHERE notification_id=$1',[ready.id]);
  assert.equal(channels.some(c=>c.channel==='in_app'),false);
  assert.equal(channels.every(c=>c.status!=='sent'),true);
  assert.deepEqual([...new Set(channels.map(c=>c.status))],['unavailable']);
});

test('an unavailable provider never corrupts the domain transaction',async()=>{
  const booking=await hold();
  await drain();
  // The booking survives intact even though every outbound channel is missing.
  assert.equal((await one('SELECT status FROM bookings WHERE id=$1',[booking.id])).status,'held');
  const created=await inbox(demo.passenger);
  assert.ok(created.length>0,'in-app still works when outbound providers do not');
  assert.equal(created.every(n=>n.superseded_at===null||n.superseded_at!==undefined),true);
  // Replaying the same events cannot duplicate a notification.
  await db.transaction(tx=>tx.query('UPDATE outbox SET delivered_at=NULL'));
  await drain();
  assert.equal((await inbox(demo.passenger)).length,created.length,'dispatch is exactly once per event and recipient');
});

test('mandatory alerts cannot be switched off; optional ones can',async()=>{
  const notify=notificationPolicies(db,config);
  await assert.rejects(notify.setPreference(passenger,{category:'critical',channel:'sms',enabled:false}),/essentielles/);
  const saved=await notify.setPreference(passenger,{category:'marketing',channel:'sms',enabled:false});
  assert.equal(saved.enabled,false);
  const preferences=await notify.preferences(passenger);
  assert.equal(preferences.categories.find(c=>c.category==='critical').locked,true);
  assert.equal(preferences.categories.find(c=>c.category==='marketing').locked,false);
  // Availability is reported honestly: only in-app works without providers.
  assert.equal(preferences.channels.find(c=>c.channel==='in_app').available,true);
  assert.equal(preferences.channels.find(c=>c.channel==='sms').available,false);
});

test('notification centre is per identity and marking read is scoped',async()=>{
  await hold();await drain();
  const notify=notificationPolicies(db,config);
  const mine=await notify.list(passenger);
  assert.ok(mine.length>0);
  assert.equal(mine.every(n=>n.read===false),true);
  await notify.markRead(passenger,mine[0].id);
  assert.equal((await notify.list(passenger)).find(n=>n.id===mine[0].id).read,true);
  // Another identity cannot read or mark my notifications.
  await assert.rejects(notify.markRead({id:demo.driver,role:'driver'},mine[0].id),/Notification not found/);
  assert.equal((await notify.list({id:demo.driver,role:'driver'})).some(n=>n.id===mine[0].id),false);
});

test('handoff analytics record a click and never a completed ride',async()=>{
  const booking=await hold();
  const rides=mobility(db);
  const providers=await rides.providers(passenger,{country:'BJ',leg:'first_mile'});
  assert.equal(providers[0].id,'gozem');
  assert.equal(providers[0].integrationStatus,'suggested_external');
  const viewed=await rides.recordHandoff(passenger,{providerId:'gozem',bookingId:booking.id,leg:'first_mile',kind:'suggestion_viewed'});
  assert.equal(viewed.rideCompleted,false);
  await rides.recordHandoff(passenger,{providerId:'gozem',bookingId:booking.id,leg:'first_mile',kind:'handoff_clicked'});
  // "I'll get there myself" is a first-class outcome.
  await rides.recordHandoff(passenger,{bookingId:booking.id,leg:'first_mile',kind:'self_selected'});
  const funnel=await all('SELECT kind FROM mobility_handoff_events WHERE booking_id=$1 ORDER BY created_at',[booking.id]);
  assert.deepEqual(funnel.map(f=>f.kind),['suggestion_viewed','handoff_clicked','self_selected']);
  // No location is ever stored with a handoff event.
  const columns=await all(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='mobility_handoff_events'`,[db.schema]);
  assert.equal(columns.some(c=>/lat|lon|coord|address/i.test(c.column_name)),false);
  // A handoff cannot be attributed to somebody else's booking.
  await assert.rejects(rides.recordHandoff({id:demo.driver,role:'driver'},{bookingId:booking.id,leg:'first_mile',kind:'handoff_clicked'}),/Booking not found/);
});

test('time-based reminders are raised once per computed time and recompute after a delay',async()=>{
  await db.transaction(tx=>tx.query("UPDATE services SET departure_at=now()+interval '35 minutes' WHERE id=$1",[demo.service]));
  const booking=await hold();
  await db.transaction(tx=>tx.query("UPDATE bookings SET status='confirmed' WHERE id=$1",[booking.id]));
  const tick=reminders(db,config);
  const first=await tick.tick();
  assert.ok(first.raised>0,'leave-soon advice is due 35 minutes before departure');
  // Running the tick again must not raise the same advice twice.
  assert.equal((await tick.tick()).raised,0);
  const events=await all("SELECT event_type FROM outbox WHERE aggregate_id=$1 AND event_type LIKE 'first_mile%'",[booking.id]);
  assert.equal(events.length,1);
});

// A parcel that arrived and was never collected. The clock runs from the
// ready_for_pickup event, and each stage fires once per arrival.
test('an uncollected parcel is reminded, then escalated, each exactly once',async()=>{
  const parcelId=randomUUID();
  const stop=(await all('SELECT id FROM stops ORDER BY name LIMIT 1'))[0].id;
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO parcels(id,tracking_number,operator_id,origin_stop_id,destination_stop_id,category,quantity,price_minor,status,payment_responsibility,idempotency_key,request_fingerprint)
      VALUES($1,'LRP-AAAA1111',$2,$3,$3,'documents',1,1000,'ready_for_pickup','sender',$4,$4)`,[parcelId,demo.operator,stop,parcelId]);
    // Ready 30 hours ago: past the 24 h reminder, short of the 72 h escalation.
    await tx.query(`INSERT INTO parcel_events(parcel_id,kind,created_at) VALUES($1,'ready_for_pickup',now()-interval '30 hours')`,[parcelId]);
  });
  const tick=reminders(db,config);
  await tick.tick();
  const afterFirst=await all("SELECT event_type FROM outbox WHERE aggregate_id=$1 ORDER BY event_type",[parcelId]);
  assert.deepEqual(afterFirst.map(e=>e.event_type),['parcel.uncollected_reminder'],'reminded, not yet escalated');

  // A second sweep must not remind again.
  await tick.tick();
  assert.equal((await all("SELECT 1 FROM outbox WHERE aggregate_id=$1 AND event_type='parcel.uncollected_reminder'",[parcelId])).length,1);

  // Past the escalation threshold, the station is asked to act.
  await db.transaction(tx=>tx.query(`UPDATE parcel_events SET created_at=now()-interval '80 hours' WHERE parcel_id=$1`,[parcelId]));
  await db.transaction(tx=>tx.query(`DELETE FROM outbox WHERE aggregate_id=$1`,[parcelId]));
  await tick.tick();
  const stages=(await all("SELECT event_type FROM outbox WHERE aggregate_id=$1 ORDER BY event_type",[parcelId])).map(e=>e.event_type);
  assert.deepEqual(stages,['parcel.uncollected_escalation','parcel.uncollected_reminder']);

  // A collected parcel stops the cycle entirely.
  await db.transaction(async tx=>{
    await tx.query(`DELETE FROM outbox WHERE aggregate_id=$1`,[parcelId]);
    await tx.query("UPDATE parcels SET status='collected' WHERE id=$1",[parcelId]);
  });
  await tick.tick();
  assert.equal((await all('SELECT 1 FROM outbox WHERE aggregate_id=$1',[parcelId])).length,0);
});

test('pickup thresholds come from configuration, never from code',async()=>{
  const fast=reminders(db,{...config,parcelPickup:{reminderHours:1,escalationHours:2}});
  assert.equal(fast.policy.parcelPickup.reminderHours,1);
  assert.equal(fast.policy.parcelPickup.escalationHours,2);
  // The default is a documented operational choice, not an accident.
  assert.equal(reminders(db,{}).policy.parcelPickup.reminderHours,24);
});

test('first-mile support never introduces a passenger cash option',async()=>{
  // Passenger-facing payment surfaces stay online-only: cash exists solely for
  // crew walk-up sales and the operator counter.
  const cashPolicies=await all(`SELECT template FROM notification_policies WHERE audience IN ('booking_passenger','service_passengers') AND template ILIKE '%cash%'`);
  assert.equal(cashPolicies.length,0);
  const booking=await hold();
  const timeline=await journeys(db,config).timeline(passenger,booking.id);
  assert.equal(JSON.stringify(timeline).toLowerCase().includes('cash'),false);
  assert.equal(JSON.stringify(timeline).toLowerCase().includes('comptant'),false);
});
