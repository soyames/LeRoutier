import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo, demoId } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { transport } from '../src/transport.js';
import { payments } from '../src/payments.js';
import { payouts } from '../src/payouts.js';
import { recovery } from '../src/recovery.js';
import { parcels } from '../src/parcels.js';
import { tickets } from '../src/tickets.js';
import { onboarding } from '../src/onboarding.js';
import { locations } from '../src/locations.js';
import { operatorSettlements } from '../src/operator-settlements.js';
import { walkUpBookings } from '../src/walkup.js';
import { provisioning } from '../src/provisioning.js';
import { bootstrap, createActions, createWorkflowEngine } from '@leroutier/agents';
import { createApi } from '../../../services/api/src/app.js';

const config={...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-',''),demoLogin:true,issuer:'https://issuer.test.invalid'};
const db=createDatabase(config),domain=transport(db);
const passenger={id:demo.passenger,role:'passenger'},driver={id:demo.driver,role:'driver'},ops={id:demo.ops,role:'ops',operator_id:demo.operator};
const onboard=onboarding(db),loc=locations(db),settle=operatorSettlements(db,null),walkUp=walkUpBookings(db),provision=provisioning(db,config),ticket=tickets(db),parcel=parcels(db);
const actions=createActions({db,domain,payments:payments(db),payouts:payouts(db),recovery:recovery(db),parcels:parcels(db)});
const engine=createWorkflowEngine({db,actions});
let api,sessions,platformOps,companyUser,independentUser,agentPrincipal;
const one=async(sql,args=[])=>(await db.transaction(async tx=>(await tx.query(sql,args)).rows[0]));
async function newUser(role='passenger',overrides={}){
  const id=randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO users(id,auth_subject,auth_issuer,display_name,role,profile_completed_at) VALUES($1,$2,'test',$3,$4,now())`,
      [id,'subject-'+id.slice(0,8),overrides.displayName??('User '+id.slice(0,4)),role]);
    if(role==='passenger')await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1)',[id]);
  });
  return id;
}
// Company operational fixtures: route + vehicle + driver for a company operator.
async function companyFixtures(operatorId){
  const routeId=randomUUID(),vehicleId=randomUUID(),driverId=await newUser('driver');
  await db.transaction(async tx=>{
    await tx.query('INSERT INTO routes(id,operator_id,name) VALUES($1,$2,$3)',[routeId,operatorId,'Compagnie Express']);
    await tx.query('INSERT INTO route_stops(route_id,sequence,stop_id,fare_to_next) VALUES($1,0,$2,0),($1,1,$3,0)',[routeId,demoId(200),demoId(201)]);
    await tx.query(`INSERT INTO vehicles(id,operator_id,registration,capacity) VALUES($1,$2,'CMP-BUS-01',12)`,[vehicleId,operatorId]);
    await tx.query('INSERT INTO driver_profiles(user_id,operator_id,license_reference) VALUES($1,$2,$3)',[driverId,operatorId,'LIC-CMP']);
    await tx.query('UPDATE users SET operator_id=$2 WHERE id=$1',[driverId,operatorId]);
  });
  return {routeId,vehicleId,driverId};
}
before(async()=>{
  await migrate(db);await seed(db);
  api=createApi(db,config);
  sessions={};
  for(const role of ['passenger','driver','ops']){const r=await api(new Request('http://localhost/api/v1/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role})}));sessions[role]=(await r.json()).data.token;}
  platformOps={id:randomUUID(),role:'ops'};
  await db.transaction(async tx=>{await tx.query("INSERT INTO users(id,display_name,role) VALUES($1,'Platform Ops','ops')",[platformOps.id]);});
  // Test identities (fixtures; production onboarding uses real OIDC subjects).
  companyUser=await newUser('passenger',{displayName:'Rep Compagnie'});
  independentUser=await newUser('passenger',{displayName:'Chauffeur Indépendant'});
  agentPrincipal=await bootstrap(db,{name:'onboarding-agent',token:'lragt_'+randomBytes(32).toString('base64url'),scopes:['operator.read','service.read','parcel.read','payment.reconcile']});
});
beforeEach(async()=>{
  await db.transaction(async tx=>{await tx.query('DELETE FROM booking_segments');await tx.query("UPDATE bookings SET status='cancelled'");
    await tx.query('DELETE FROM payment_events');await tx.query('DELETE FROM payments');await tx.query('DELETE FROM operator_payout_events');
    await tx.query('DELETE FROM operator_settlements');await tx.query('DELETE FROM operator_payout_requests');
    await tx.query('DELETE FROM operator_stations');
    await tx.query('DELETE FROM parcel_proof_of_delivery');await tx.query('DELETE FROM parcel_pickup_codes');await tx.query('DELETE FROM parcel_exceptions');
    await tx.query('DELETE FROM parcel_payments');await tx.query('DELETE FROM parcel_custody');await tx.query('DELETE FROM parcel_service_assignments');
    await tx.query('DELETE FROM parcel_events');await tx.query('DELETE FROM parcel_labels');await tx.query('DELETE FROM parcel_parties');await tx.query('DELETE FROM parcels');
    await tx.query("UPDATE services SET current_sequence=0,status='active',departure_point_id=NULL,arrival_point_id=NULL");
    await tx.query('DELETE FROM boarding_points');
    await tx.query('DELETE FROM agent_action_receipts');await tx.query('DELETE FROM workflow_approvals');await tx.query('DELETE FROM workflow_runs');await tx.query('DELETE FROM outbox');
    await tx.query("UPDATE service_assignments SET convoyeur_id=NULL WHERE service_id=$1",[demo.service]);
    await tx.query('DELETE FROM parcel_rate_rules');await tx.query('INSERT INTO parcel_rate_rules(operator_id,base_minor,per_kg_minor,declared_value_bp) VALUES($1,1000,500,0)',[demo.operator]);});
});
after(async()=>{try{await dropDisposableSchema(db);}finally{await db.close();}});

test('company onboarding creates a company operator and promotes the representative to admin Ops',async()=>{
  const key=randomUUID();
  const result=await onboard.startCompany({id:companyUser,role:'passenger'},{displayName:'Baobab Express',contactPhone:'+229 61000000',country:'BJ'},key);
  assert.equal(result.role,'ops');
  assert.equal(result.status,'pending_verification');
  const operator=await one('SELECT * FROM operators WHERE admin_user_id=$1',[companyUser]);
  assert.equal(operator.type,'company');
  assert.equal(operator.verification_status,'pending_verification');
  const user=await one('SELECT role,operator_id FROM users WHERE id=$1',[companyUser]);
  assert.equal(user.role,'ops');
  assert.equal(user.operator_id,operator.id);
  const replay=await onboard.startCompany({id:companyUser,role:'passenger'},{displayName:'Baobab Express',contactPhone:'+229 61000000',country:'BJ'},key);
  assert.equal(replay.alreadyOnboarded,true);
  assert.equal((await one('SELECT count(*)::integer AS n FROM operators WHERE admin_user_id=$1',[companyUser])).n,1);
  // Not yet verified: cannot run services, even with full fixtures.
  const fx=await companyFixtures(operator.id);
  const admin={id:companyUser,role:'ops',operator_id:operator.id};
  await assert.rejects(provision.service(admin,{routeId:fx.routeId,vehicleId:fx.vehicleId,driverId:fx.driverId,departureAt:new Date(Date.now()+3600_000).toISOString()},randomUUID()),{code:'OPERATOR_NOT_VERIFIED'});
  // Platform verification unlocks provisioning.
  await onboard.verification(platformOps,operator.id,'verified');
  const verified=await one('SELECT verification_status FROM operators WHERE id=$1',[operator.id]);
  assert.equal(verified.verification_status,'verified');
  const service=await provision.service(admin,{routeId:fx.routeId,vehicleId:fx.vehicleId,driverId:fx.driverId,departureAt:new Date(Date.now()+3600_000).toISOString()},randomUUID());
  assert.ok(service.id);
  await assert.rejects(provision.service(ops,{routeId:demo.route,vehicleId:demo.vehicle,driverId:demo.driver,departureAt:new Date(Date.now()+3600_000).toISOString(),departurePointId:randomUUID()},randomUUID()),{code:'INVALID_POINT'});
});

test('independent onboarding maps ONE identity to owner operator and driver profile',async()=>{
  const result=await onboard.startIndependent({id:independentUser,role:'passenger'},
    {displayName:'Chauffeur Indépendant',phone:'+229 61000001',country:'BJ',licenseReference:'LIC-IND-1',vehicleRegistration:'IND-BUS-01',vehicleCapacity:12},randomUUID());
  assert.equal(result.role,'driver');
  const operator=await one('SELECT * FROM operators WHERE owner_user_id=$1',[independentUser]);
  assert.equal(operator.type,'independent');
  assert.equal(operator.owner_user_id,operator.admin_user_id);
  const user=await one('SELECT role,operator_id FROM users WHERE id=$1',[independentUser]);
  assert.equal(user.role,'driver');
  assert.equal(user.operator_id,operator.id);
  const profile=await one('SELECT * FROM driver_profiles WHERE user_id=$1',[independentUser]);
  assert.equal(profile.operator_id,operator.id);
  const vehicle=await one("SELECT * FROM vehicles WHERE operator_id=$1 AND registration='IND-BUS-01'",[operator.id]);
  assert.ok(vehicle,'onboarding vehicle was created for the operator');
  // Owner-driver state is visible through the shared API.
  const state=await onboard.state({id:independentUser,role:'driver'});
  assert.equal(state.membership.isOwner,true);
  assert.equal(state.membership.operatorType,'independent');
});

test('staff provisioning binds unique identities to the right operator and rejects cross-operator assignment',async()=>{
  companyUser=await newUser('passenger',{displayName:'Rep Compagnie'});
  await onboard.startCompany({id:companyUser,role:'passenger'},{displayName:'Baobab Express',contactPhone:'+229 61000000',country:'BJ'},randomUUID());
  const operator=await one('SELECT * FROM operators WHERE admin_user_id=$1',[companyUser]);
  const admin={id:companyUser,role:'ops',operator_id:operator.id};
  const driverSubject='driver-'+randomUUID().slice(0,8);
  const convoyeurSubject='convoyeur-'+randomUUID().slice(0,8);
  await provision.driver(admin,{subject:driverSubject,displayName:'Mathieu',operatorId:operator.id,licenseReference:'LIC-M'},randomUUID());
  await provision.convoyeur(admin,{subject:convoyeurSubject,displayName:'Serge',operatorId:operator.id},randomUUID());
  const mathieu=await one("SELECT * FROM users WHERE auth_subject=$1",[driverSubject]);
  assert.equal(mathieu.role,'driver');
  assert.equal(mathieu.operator_id,operator.id);
  const serge=await one("SELECT * FROM users WHERE auth_subject=$1",[convoyeurSubject]);
  assert.equal(serge.role,'convoyeur');
  const convoyeurProfile=await one('SELECT * FROM convoyeur_profiles WHERE user_id=$1',[serge.id]);
  assert.equal(convoyeurProfile.operator_id,operator.id);
  // A second company cannot provision staff into the first operator.
  const otherAdminUser=await newUser('passenger',{displayName:'Autre Compagnie'});
  await onboard.startCompany({id:otherAdminUser,role:'passenger'},{displayName:'Autre Compagnie',contactPhone:'+229 61000002',country:'BJ'},randomUUID());
  const otherOp=await one('SELECT * FROM operators WHERE admin_user_id=$1',[otherAdminUser]);
  await assert.rejects(provision.driver({id:otherAdminUser,role:'ops',operator_id:otherOp.id},{subject:'intruder-'+randomUUID().slice(0,8),displayName:'Intruder',operatorId:operator.id,licenseReference:'X'},randomUUID()),{code:'FORBIDDEN'});
  // No self-promotion: a passenger cannot provision themselves.
  const plainPassenger=await newUser('passenger');
  await assert.rejects(provision.driver({id:plainPassenger,role:'ops',operator_id:otherOp.id},{subject:'subject-'+plainPassenger.slice(0,8),displayName:'Self',operatorId:otherOp.id,licenseReference:'X'},randomUUID()),{code:'FORBIDDEN'});
});

test('convoyeur has crew access only on assigned services',async()=>{
  const c=await newUser('convoyeur');
  await db.transaction(async tx=>{await tx.query('INSERT INTO convoyeur_profiles(user_id,operator_id) VALUES($1,$2)',[c,demo.operator]);});
  const convoyeurActor={id:c,role:'convoyeur',operator_id:demo.operator};
  await assert.rejects(domain.manifest(convoyeurActor,demo.service),{code:'FORBIDDEN'});
  await db.transaction(async tx=>tx.query('UPDATE service_assignments SET convoyeur_id=$1 WHERE service_id=$2',[c,demo.service]));
  const manifest=await domain.manifest(convoyeurActor,demo.service);
  assert.ok(Array.isArray(manifest));
});

test('walk-up cash sales confirm the booking, record cash and credit the operator ledger',async()=>{
  const b=await domain.hold(passenger,{serviceId:demo.service,origin:0,destination:1},randomUUID());
  await domain.transition(passenger,b.id,'cancel');
  const result=await walkUp(driver,{serviceId:demo.service,origin:0,destination:1,passengerName:'Passager Comptant',passengerPhone:'+229 61999999',amountMinor:2500,cashReference:'RECEIPT-1'},randomUUID());
  assert.equal(result.status,'confirmed');
  const booking=await one('SELECT * FROM bookings WHERE id=$1',[result.bookingId]);
  assert.equal(booking.status,'confirmed');
  const payment=await one("SELECT * FROM payments WHERE booking_id=$1 AND provider='cash'",[booking.id]);
  assert.equal(payment.status,'succeeded');
  const credit=await one("SELECT * FROM operator_settlements WHERE source='walk_up' AND reference=$1",['walkup:'+booking.id]);
  assert.equal(credit.gross_minor,2500);
  assert.equal(credit.deduction_minor,125,'the 5% commission comes out of the final cash price');
  assert.equal(credit.net_minor,2375);
  assert.equal(credit.operator_id,demo.operator);
  // Amount tampering is rejected; passengers can never sell cash seats.
  await assert.rejects(walkUp(driver,{serviceId:demo.service,origin:0,destination:1,passengerName:'X',passengerPhone:'+229 61999998',amountMinor:1,cashReference:'R-2'},randomUUID()),{code:'INVALID_WALKUP'});
  await assert.rejects(walkUp(passenger,{serviceId:demo.service,origin:0,destination:1,passengerName:'X',passengerPhone:'+229 61999998',amountMinor:2500,cashReference:'R-3'},randomUUID()),{code:'FORBIDDEN'});
  const summary=await settle.summary(ops);
  assert.equal(summary.available,2375,'available balance is the operator net, commission already deducted');
});

test('only independent owner-drivers can withdraw operator revenue',async()=>{
  independentUser=await newUser('passenger',{displayName:'Chauffeur Indépendant'});
  await onboard.startIndependent({id:independentUser,role:'passenger'},
    {displayName:'Chauffeur Indépendant',phone:'+229 61000001',country:'BJ',licenseReference:'LIC-IND-2'},randomUUID());
  const operator=await one('SELECT * FROM operators WHERE owner_user_id=$1',[independentUser]);
  await onboard.verification(platformOps,operator.id,'verified');
  await db.transaction(async tx=>{await tx.query(`INSERT INTO operator_settlements(operator_id,source,reference,gross_minor) VALUES($1,'walk_up','fixture',5000)`,[operator.id]);});
  const owner={id:independentUser,role:'driver',operator_id:operator.id};
  const companyDriverId=await newUser('driver');
  await db.transaction(async tx=>{await tx.query('INSERT INTO driver_profiles(user_id,operator_id,license_reference) VALUES($1,$2,$3)',[companyDriverId,demo.operator,'LIC-C']);});
  const companyDriver={id:companyDriverId,role:'driver',operator_id:demo.operator};
  await assert.rejects(settle.request(companyDriver,{amountMinor:1000,phoneNumber:'61234567',country:'BJ'},randomUUID()),{code:'FORBIDDEN'});
  const request=await settle.request(owner,{amountMinor:3000,phoneNumber:'61234567',country:'BJ'},randomUUID());
  assert.equal(request.status,'requested');
  assert.deepEqual((await settle.summary(owner)).available,2000);
  // Company ops of ANOTHER operator cannot approve.
  await assert.rejects(settle.approve({id:demo.ops,role:'ops',operator_id:demo.operator},request.id),{code:'FORBIDDEN'});
  // Platform approval executes through the provider abstraction; without an
  // adapter it fails closed and releases the reservation.
  await assert.rejects(settle.approve(platformOps,request.id),{code:'PAYOUT_UNAVAILABLE'});
  assert.equal((await settle.summary(owner)).available,5000,'reservation released on failure');
  const status=await one('SELECT status FROM operator_payout_requests WHERE id=$1',[request.id]);
  assert.equal(status.status,'failed');
  // Unverified operators cannot withdraw at all.
  const unverified=await newUser('passenger');
  await onboard.startIndependent({id:unverified,role:'passenger'},{displayName:'Non Vérifié',phone:'+229 61000003',country:'BJ',licenseReference:'L-UV'},randomUUID());
  const uvOperator=await one('SELECT * FROM operators WHERE owner_user_id=$1',[unverified]);
  await db.transaction(async tx=>{await tx.query(`INSERT INTO operator_settlements(operator_id,source,reference,gross_minor) VALUES($1,'walk_up','fixture',1000)`,[uvOperator.id]);});
  await assert.rejects(settle.request({id:unverified,role:'driver',operator_id:uvOperator.id},{amountMinor:500,phoneNumber:'61234567',country:'BJ'},randomUUID()),{code:'OPERATOR_NOT_VERIFIED'});
});

test('location proposals are moderated and duplicates are rejected',async()=>{
  const point=await loc.propose({id:independentUser,role:'passenger'},{name:'Godomey – Carrefour',placeId:demoId(100),type:'independent_boarding_point',description:'Au carrefour principal',purposes:['passenger_boarding']});
  assert.equal(point.status,'proposed');
  await assert.rejects(loc.propose({id:independentUser,role:'passenger'},{name:'godomey – carrefour',placeId:demoId(100),type:'independent_boarding_point',purposes:['passenger_boarding']}),{code:'DUPLICATE_POINT'});
  const search=await loc.search({id:independentUser,role:'passenger'},{q:'Godomey',includeProposed:true});
  assert.equal(search.length,1);
  await assert.rejects(loc.moderate({id:demo.ops,role:'ops',operator_id:demo.operator},point.id,'verified'),{code:'FORBIDDEN'});
  const verified=await loc.moderate(platformOps,point.id,'verified');
  assert.equal(verified.status,'verified');
  const publicSearch=await loc.search({id:independentUser,role:'passenger'},{q:'Godomey'});
  assert.equal(publicSearch.length,1);
});

test('company stations bind to verified points and services require verified points',async()=>{
  companyUser=await newUser('passenger',{displayName:'Rep Compagnie'});
  await onboard.startCompany({id:companyUser,role:'passenger'},{displayName:'Baobab Express',contactPhone:'+229 61000000',country:'BJ'},randomUUID());
  const operator=await one('SELECT * FROM operators WHERE admin_user_id=$1',[companyUser]);
  const admin={id:companyUser,role:'ops',operator_id:operator.id};
  const point=await loc.propose({id:companyUser,role:'passenger'},{name:'Gare Bohicon',placeId:demoId(100),type:'company_station',description:'Gare centrale',purposes:['passenger_boarding','parcel_consignment']});
  await loc.moderate(platformOps,point.id,'verified');
  const station=await loc.stationCreate(admin,{operatorId:operator.id,boardingPointId:point.id,name:'Baobab Express – Gare Bohicon',address:'Près de la mairie',purposes:['passenger_boarding']});
  assert.equal(station.operator_id,operator.id);
  const stations=await loc.stationList(admin,operator.id);
  assert.equal(stations.length,1);
  // Cross-operator station creation is rejected.
  const otherUser=await newUser('passenger');
  await onboard.startCompany({id:otherUser,role:'passenger'},{displayName:'Autre Cie',contactPhone:'+229 61000002',country:'BJ'},randomUUID());
  const otherOp=await one('SELECT * FROM operators WHERE admin_user_id=$1',[otherUser]);
  await assert.rejects(loc.stationCreate({id:otherUser,role:'ops',operator_id:otherOp.id},{operatorId:operator.id,boardingPointId:point.id,name:'Pirate Station',purposes:['passenger_boarding']}),{code:'FORBIDDEN'});
  // Services require verified points.
  await assert.rejects(provision.service(ops,{routeId:demo.route,vehicleId:demo.vehicle,driverId:demo.driver,departureAt:new Date(Date.now()+3600_000).toISOString(),departurePointId:randomUUID()},randomUUID()),{code:'INVALID_POINT'});
});

test('tickets state the exact boarding and arrival points',async()=>{
  const point=await loc.propose({id:companyUser,role:'passenger'},{name:'Jonquet Carrefour',placeId:demoId(100),type:'public_bus_park',description:'Sous le panneau',latitude:6.37,longitude:2.39,purposes:['passenger_boarding']});
  const arrival=await loc.propose({id:companyUser,role:'passenger'},{name:'Gare de Bohicon',placeId:demoId(101),type:'public_bus_park',latitude:7.18,longitude:2.11,purposes:['passenger_alighting']});
  await loc.moderate(platformOps,point.id,'verified');
  await loc.moderate(platformOps,arrival.id,'verified');
  await db.transaction(async tx=>{await tx.query('UPDATE services SET departure_point_id=$1,arrival_point_id=$2 WHERE id=$3',[point.id,arrival.id,demo.service]);});
  const b=await domain.hold(passenger,{serviceId:demo.service,origin:0,destination:1},randomUUID());
  await domain.recordPayment(ops,b.id,{provider:'cash',reference:'CASH-T',amountMinor:2500,currency:'XOF'},randomUUID());
  await domain.transition(passenger,b.id,'confirm');
  const issued=await ticket.issue(passenger,b.id);
  assert.equal(issued.departure.name,'Jonquet Carrefour');
  assert.equal(issued.arrival.name,'Gare de Bohicon');
  assert.equal(typeof issued.departure.latitude,'number');
  const bookings=await domain.passengerBookings(passenger);
  const enriched=bookings.find(x=>x.id===b.id);
  assert.equal(enriched.departure_point_name,'Jonquet Carrefour');
  assert.equal(enriched.arrival_point_name,'Gare de Bohicon');
});

test('parcel public tracking exposes only safe point information',async()=>{
  companyUser=await newUser('passenger',{displayName:'Rep Colis'});
  const point=await loc.propose({id:companyUser,role:'passenger'},{name:'Point Colis Dantokpa',placeId:demoId(100),type:'parcel_consignment_point',purposes:['parcel_consignment','parcel_pickup']});
  await loc.moderate(platformOps,point.id,'verified');
  const p=await parcel.create(passenger,{senderName:'Awa Sender',senderPhone:'+229 61000001',receiverName:'Kofi Receiver',receiverPhone:'+229 61000002',originStopId:demoId(200),destinationStopId:demoId(201),category:'documents',operatorId:demo.operator,consignmentPointId:point.id,pickupPointId:point.id},randomUUID());
  const tracking=await parcel.publicTracking(p.trackingNumber);
  assert.equal(tracking.consignmentPoint.name,'Point Colis Dantokpa');
  assert.equal(tracking.pickupPoint.name,'Point Colis Dantokpa');
  assert.equal(JSON.stringify(tracking).includes('+229'),false);
});

test('agent actions observe onboarding and location state through scoped reads',async()=>{
  companyUser=await newUser('passenger',{displayName:'Rep Compagnie'});
  await onboard.startCompany({id:companyUser,role:'passenger'},{displayName:'Baobab Express',contactPhone:'+229 61000000',country:'BJ'},randomUUID());
  const run=await engine.runAction(agentPrincipal,'operator.unverified_detect',{});
  assert.equal(run.status,'completed');
  assert.ok(run.result.some(o=>o.name==='Baobab Express'));
  const missing=await engine.runAction(agentPrincipal,'service.missing_point_detect',{});
  assert.ok(missing.result.some(s=>s.id===demo.service));
  const unscoped=await bootstrap(db,{name:'no-operator-scope',token:'lragt_'+randomBytes(32).toString('base64url'),scopes:['service.read']});
  await assert.rejects(engine.runAction(unscoped,'operator.unverified_detect',{}),{code:'FORBIDDEN'});
});
