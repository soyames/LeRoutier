const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const stops=['Cotonou','Bohicon','Dassa-Zoumè','Parakou'].map((city,sequence)=>({id:id(200+sequence),stopId:id(200+sequence),stop_id:id(200+sequence),city,name:'Gare démo',sequence,latitude:6.3,longitude:2.4}));
// A departure tomorrow, so the fixture never drifts into the past and the
// arrival time / trip duration are exercised like a real service.
const tomorrow=new Date(Date.now()+86400_000).toISOString().slice(0,10);
export const DEPARTURE_AT=`${tomorrow}T07:30:00.000Z`, ARRIVAL_AT=`${tomorrow}T13:40:00.000Z`;
// A planned option for /journey-plan. It departs soon (today) because the
// planner's results screen filters to the selected day, and it mirrors the
// API's option shape exactly: service facts, fare, availability, miles.
const soon=new Date(Date.now()+3600_000);
export const JOURNEY_OPTION={serviceId:id(30),operatorName:'Opérateur démo',operatorType:'company',routeName:'DEMO Cotonou → Parakou',
  departureAt:soon.toISOString(),serviceStatus:'scheduled',originSequence:0,destinationSequence:3,
  pickupStop:{id:id(200),name:'Gare démo',city:'Cotonou'},dropoffStop:{id:id(203),name:'Gare démo',city:'Parakou'},
  fare:{amountMinor:7500,currency:'XOF'},available:12,feasible:true,firstMile:null,
  intercity:{durationS:22200,etaAt:new Date(soon.getTime()+22200_000).toISOString()},
  lastMile:null,totalDurationS:22200,etaAt:new Date(soon.getTime()+22200_000).toISOString()};
const service={id:id(30),route_name:'DEMO Cotonou → Parakou',operator_name:'Opérateur démo',registration:'DEMO-BUS-01',driver_name:'Conducteur Démo',status:'active',capacity:12,current_sequence:0,departure_at:DEPARTURE_AT,arrival_at:ARRIVAL_AT,departure_point_name:'Godomey – Carrefour',departure_point_landmark:'Au carrefour principal',departure_point_latitude:6.37,departure_point_longitude:2.39,arrival_point_name:'Parakou – Gare centrale',arrival_point_landmark:null,arrival_point_latitude:null,arrival_point_longitude:null,is_demo:true,stops,
  availability:{origin:0,destination:3,available:12,capacity:12,stops,fare:{amountMinor:7500,currency:'XOF'},segments:[0,1,2].map(sequence=>({sequence,available:12,occupied:0}))}};
// A stretch of RNIE 2 — Cotonou → Abomey-Calavi → Allada → Bohicon →
// Dassa-Zoumè → Savè → Parakou — as GeoJSON [longitude, latitude], the order a
// routing engine returns. Real Benin coordinates, so the fixture exercises the
// same projection maths as production rather than a synthetic square.
export const RNIE2=[[2.4183,6.3654],[2.3899,6.4102],[2.3556,6.4486],[2.2712,6.5521],[2.1511,6.6656],
  [2.1188,6.8402],[2.0876,7.0195],[2.0667,7.1783],[2.1004,7.3925],[2.1562,7.5688],[2.1833,7.7500],
  [2.3402,7.9011],[2.4833,8.0333],[2.5389,8.4127],[2.5901,8.7903],[2.6104,9.0512],[2.6300,9.3370]];

const TRACKED_STOPS=[['Cotonou',6.3654,2.4183,'passed'],['Bohicon',7.1783,2.0667,'passed'],
  ['Dassa-Zoumè',7.7500,2.1833,'next'],['Parakou',9.3370,2.6300,'upcoming']]
  .map(([city,latitude,longitude,state],sequence)=>({sequence,name:`Gare de ${city}`,city,state,latitude,longitude}));

/** A tracking payload shaped exactly like the API's, with per-test overrides. */
export const trackingFixture=(overrides={})=>({
  serviceId:id(30),serviceStatus:'active',bookingId:id(40),boardingSequence:0,destinationSequence:3,
  route:{available:true,coordinates:RNIE2,distanceM:360_000,provider:'osrm',generatedAt:'2026-09-16T05:00:00Z'},
  position:{latitude:7.3925,longitude:2.1004,observedAt:'2026-09-16T09:00:00Z',accuracyM:12},
  signal:'live',signalAgeSeconds:30,
  progress:{distanceAlongM:130_000,remainingM:230_000,totalM:360_000,fraction:0.36},
  stops:TRACKED_STOPS,nextStop:{sequence:2,name:'Gare de Dassa-Zoumè',city:'Dassa-Zoumè'},
  offRoute:false,offRouteM:null,
  eta:{at:'2026-09-16T13:40:00Z',confidence:'live',speedMps:19.4,roundedToMinutes:5},
  ...overrides});

export async function mockApi(page) {
  const token=role=>`fixture-session-${role}`;
  // Map tiles are never fetched in tests: the suite must not depend on a tile
  // server being online, and a blocked tile is indistinguishable to Leaflet
  // from a slow one. The container, route line and markers still render.
  await page.route(/tile\.openstreetmap\.org|basemaps\.cartocdn\.com/,r=>r.fulfill({
    status:200,contentType:'image/png',
    body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64')}));
  await page.route('**/api/v1/auth/config',r=>r.fulfill({json:{data:{demoLogin:true}}}));
  await page.route('**/api/v1/auth/demo',r=>r.fulfill({json:{data:{token:token(r.request().postDataJSON().role),user:{id:id(2),role:r.request().postDataJSON().role,display_name:'Compte Démo'}}}}));
  await page.route('**/api/v1/me',r=>{const role=(r.request().headers()['authorization']||'').replace('Bearer ','').split('-').at(-1)||'passenger';
    return r.fulfill({json:{data:{id:id(2),role,display_name:'Compte Démo',operator_id:role==='passenger'?null:id(1)}}});});
  await page.route('**/api/v1/routes',r=>r.fulfill({json:{data:[{id:id(10),stops}]}}));
  await page.route('**/api/v1/stops',r=>r.fulfill({json:{data:stops}}));
  // Benin geography: the parcel city picker reads communes, independent of routes.
  await page.route('**/api/v1/places?type=commune',r=>r.fulfill({json:{data:stops.map((s,i)=>({id:id(300+i),name:s.city,kind:'city',parent_id:null,latitude:6.4,longitude:2.4}))}}));
  await page.route('**/api/v1/places?type=department',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/api/v1/services?*',r=>r.fulfill({json:{data:[service]}}));
  // The geography-backed journey planner answers with one feasible option;
  // specs that need the empty-catalogue state override this route.
  await page.route('**/api/v1/journey-plan*',r=>r.fulfill({json:{data:{
    options:[JOURNEY_OPTION],
    originResolved:{id:id(200),name:'Gare démo',city:'Cotonou',distanceM:600},
    destinationResolved:null,generatedAt:'2026-09-17T00:00:00Z'}}}));
  await page.route('**/api/v1/me/bookings',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/api/v1/driver/service',r=>r.fulfill({json:{data:service}}));
  await page.route('**/api/v1/services/*/manifest',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/api/v1/ops/fleet',r=>r.fulfill({json:{data:{services:[service],vehicles:[{id:id(20),registration:'DEMO-BUS-01',capacity:12,status:'active'}]}}}));
  await page.route('**/api/v1/ops/bookings',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/api/v1/ops/provisioning',r=>r.fulfill({json:{data:{operators:[],users:[],routes:[],vehicles:[],places:[],stops:[]}}}));
  await page.route('**/api/v1/incidents',r=>r.fulfill({json:{data:[]}}));
  // FedaPay / payouts / agentic Ops sections
  await page.route('**/api/v1/payments/config',r=>r.fulfill({json:{data:{available:true}}}));
  await page.route('**/api/v1/ops/payments*',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/api/v1/ops/payouts',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/api/v1/agent/approvals',r=>r.fulfill({json:{data:[]}}));
  // Driver earnings/payouts
  await page.route('**/api/v1/driver/earnings',r=>r.fulfill({json:{data:{summary:{available:0,reserved:0,paid:0,reversed:0,currency:'XOF'},entries:[]}}}));
  await page.route('**/api/v1/driver/payouts',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/api/v1/driver/payout-destinations',r=>r.fulfill({json:{data:[]}}));
  // Ops diagnostics
  await page.route('**/api/v1/ops/diagnostics',r=>r.fulfill({json:{data:{database:'ok',fedapay:{collections:true,payouts:true,environment:'live'},payments:{failed:0,anomalies7d:0},payouts:{failed:0,processing:0},incidents:{open:0},services:{staleTracking:0},workflows:{failed:0,awaitingApproval:0,failedRuns:[]},parcels:{openExceptions:0,uncollected:0,readyForPickup:0}}}}));
  // Onboarding & locations
  await page.route('**/api/v1/onboarding/me',r=>r.fulfill({json:{data:{role:'ops',displayName:'Compte Démo',needsProfile:false,membership:null}}}));
  await page.route('**/api/v1/boarding-points',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/api/v1/operators',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/api/v1/ops/operator-payouts',r=>r.fulfill({json:{data:[]}}));
  // Parcel logistics (API routes only — navigation URLs must never be mocked)
  await page.route('**/api/v1/me/parcels',r=>r.fulfill({json:{data:[{id:id(50),trackingNumber:'LRP-12345678',category:'documents',quantity:1,weightG:null,priceMinor:1000,status:'created',paymentResponsibility:'sender',createdAt:'2026-09-15T00:00:00Z',originStopId:id(200),destinationStopId:id(201)}]}}));
  await page.route('**/api/v1/parcels/quote*',r=>r.fulfill({json:{data:{amountMinor:1000,currency:'XOF',operatorName:'Opérateur démo'}}}));
  await page.route('**/api/v1/public/parcel-tracking/*',r=>r.fulfill({json:{data:{trackingNumber:'LRP-12345678',status:'in_transit',origin:{city:'Cotonou'},destination:{city:'Parakou'},lastMilestone:{kind:'departed',at:'2026-09-15T10:00:00Z'},pickupReady:false,eta:null,location:{latitude:7.18,longitude:2.11,observedAt:'2026-09-15T10:30:00Z',derivedFromVehicle:true},updatedAt:'2026-09-15T10:30:00Z'}}}));
  await page.route('**/api/v1/parcels',r=>r.fulfill({json:{data:{id:id(50),trackingNumber:'LRP-12345678',category:'documents',quantity:1,priceMinor:1000,status:'created',paymentResponsibility:'sender',createdAt:'2026-09-15T00:00:00Z'}}}));
  await page.route('**/api/v1/parcels/*/label',r=>r.fulfill({json:{data:{trackingNumber:'LRP-12345678',token:'LRP1.fixture',barcode:'LRP-12345678',version:1}}}));
  await page.route('**/api/v1/parcels/*/scan',r=>r.fulfill({json:{data:{id:id(50),trackingNumber:'LRP-12345678',status:'loaded'}}}));
  await page.route('**/api/v1/driver/parcels',r=>r.fulfill({json:{data:[{id:id(50),trackingNumber:'LRP-12345678',category:'documents',quantity:1,status:'manifested',originCity:'Cotonou',destinationCity:'Parakou',notes:null}]}}));
  await page.route('**/api/v1/ops/parcels*',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/api/v1/ops/parcel-rate-rules',r=>r.fulfill({json:{data:[]}}));
  // Notifications, first/last mile and journey timeline. The provider is an
  // external suggestion: the fixture mirrors the API's honest flags exactly.
  await page.route('**/api/v1/notifications/preferences',r=>r.fulfill({json:{data:{
    channels:[{channel:'in_app',available:true},{channel:'web_push',available:false},{channel:'sms',available:false},{channel:'whatsapp',available:false},{channel:'email',available:false}],
    categories:[
      {category:'critical',locked:true,channels:[{channel:'in_app',enabled:true},{channel:'sms',enabled:true}]},
      {category:'operational',locked:false,channels:[{channel:'in_app',enabled:true},{channel:'sms',enabled:true}]},
      {category:'marketing',locked:false,channels:[{channel:'in_app',enabled:true},{channel:'sms',enabled:true}]},
    ]}}}));
  await page.route('**/api/v1/notifications/*/read',r=>r.fulfill({json:{data:{id:id(60),read:true}}}));
  await page.route('**/api/v1/notifications*',r=>r.fulfill({json:{data:[
    {id:id(60),eventType:'service.rescheduled',category:'critical',severity:'warning',template:'service_delayed',
      data:{serviceId:id(30),departureAt:'2026-09-16T08:00:00Z'},entityType:'service',entityId:id(30),read:false,
      createdAt:'2026-09-15T12:00:00Z',channels:{in_app:'pending',sms:'unavailable'}},
    {id:id(61),eventType:'booking.held',category:'operational',severity:'info',template:'booking_created',
      data:{bookingId:id(40)},entityType:'booking',entityId:id(40),read:true,
      createdAt:'2026-09-15T11:00:00Z',channels:{in_app:'sent'}},
  ]}}));
  // Maps, routing geometry and live vehicle tracking. Declared here so no spec
  // reaches the network for them; tracking.spec.js overrides them per case.
  await page.route('**/api/v1/journeys/*/tracking',r=>r.fulfill({json:{data:trackingFixture()}}));
  await page.route('**/api/v1/services/*/tracking',r=>r.fulfill({json:{data:trackingFixture()}}));
  await page.route('**/api/v1/ops/fleet-tracking',r=>r.fulfill({json:{data:[trackingFixture()]}}));
  await page.route('**/api/v1/routes/*/geometry',r=>r.fulfill({json:{data:{available:true,coordinates:RNIE2,
    distanceM:360_000,provider:'osrm',generatedAt:'2026-09-16T05:00:00Z',stale:false}}}));
  await page.route('**/api/v1/services/*/positions',r=>r.fulfill({json:{data:{accepted:true}}}));
  await page.route('**/api/v1/mobility/providers*',r=>r.fulfill({json:{data:[{id:'gozem',name:'Gozem',country:'BJ',
    capabilities:['first_mile','last_mile'],integrationStatus:'suggested_external',handoff:'external_link',
    launchUrl:'https://gozem.co',booksRide:false,providesFareEstimate:false,providesEta:false}]}}));
  await page.route('**/api/v1/mobility/handoff',r=>r.fulfill({json:{data:{id:id(70),leg:'first_mile',kind:'handoff_clicked',recordedAt:'2026-09-15T12:00:00Z',rideCompleted:false}}}));
  const provider={id:'gozem',name:'Gozem',integrationStatus:'suggested_external',handoff:'external_link',
    launchUrl:'https://gozem.co',booksRide:false,providesFareEstimate:false,providesEta:false};
  const departurePoint={name:'Gare de Jonquet',city:'Cotonou',landmark:'En face du marché',latitude:6.3654,longitude:2.4183,
    directionsUrl:'https://www.openstreetmap.org/?mlat=6.3654&mlon=2.4183#map=17/6.3654/2.4183'};
  await page.route('**/api/v1/journeys/*/timeline*',r=>r.fulfill({json:{data:{
    bookingId:id(40),serviceId:id(30),status:'confirmed',serviceStatus:'scheduled',operatorName:'Opérateur démo',
    departurePoint,arrivalPoint:null,
    plan:{departureAt:'2026-09-16T07:30:00Z',arrivalAt:null,arrivalScheduled:false,boardingOpensAt:'2026-09-16T07:10:00Z',
      boardingClosesAt:'2026-09-16T07:25:00Z',beThereBy:'2026-09-16T07:15:00Z',leaveBy:'2026-09-16T06:40:00Z',
      travelMinutes:25,safetyBufferMinutes:10,travelSource:'policy_default',estimated:true},
    steps:[
      {key:'booking_created',state:'done',at:'2026-09-15T11:00:00Z'},
      {key:'payment',state:'done',at:null},
      {key:'ticket_ready',state:'done',at:null},
      {key:'leave_for_boarding_point',state:'advice',at:'2026-09-16T06:40:00Z',estimated:true},
      {key:'boarding_opens',state:'upcoming',at:'2026-09-16T07:10:00Z',estimated:true},
      {key:'departure',state:'upcoming',at:'2026-09-16T07:30:00Z'},
      {key:'arrival',state:'upcoming',at:null,scheduled:false},
    ],
    firstMile:{optional:true,boardingPoint:departurePoint,provider,directionsUrl:departurePoint.directionsUrl,
      leaveBy:'2026-09-16T06:40:00Z',travelMinutes:25,travelSource:'policy_default',estimated:true},
    lastMile:{optional:true,arrivalPoint:null,provider,directionsUrl:null,available:false},
  }}}));
}
