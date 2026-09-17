import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serverConfig} from '@leroutier/config';
import {createDatabase} from '../src/index.js';
import {migrate} from '../src/migrations.js';
import {seed,demo,demoId} from '../src/seed.js';
import {dropDisposableSchema} from '../src/guards.js';
import {fareIntelligence} from '../src/fare-intelligence.js';
import {commercial} from '../src/commercial.js';
import {payments} from '../src/payments.js';
import {parcels} from '../src/parcels.js';
import {transport} from '../src/transport.js';
import {createApi} from '../../../services/api/src/app.js';

// Fare Intelligence & commercial model: commission included in the final
// price, deterministic recommendations, history preserved, express fails
// closed, and tenant/commercial isolation enforced.
const config={...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-',''),demoLogin:true};
const db=createDatabase(config);
const sql=(q,p=[])=>db.transaction(tx=>tx.query(q,p));
const one=(q,p=[])=>sql(q,p).then(r=>r.rows[0]);
const SECOND_OPERATOR=demoId(40),SECOND_STOP_A=demoId(240),SECOND_STOP_B=demoId(241);
let api,driverToken,passengerToken,opsToken;
let fares;
const now=Date.now();
const days=n=>new Date(now-n*86_400_000).toISOString();

before(async()=>{
  await migrate(db);await seed(db);
  const secondOpsUser=demoId(41);
  await sql(`INSERT INTO users(id,display_name,role) VALUES($1,'Régulation Opérateur B','ops') ON CONFLICT DO NOTHING`,[secondOpsUser]);
  await sql(`INSERT INTO operators(id,name,type,verification_status,owner_user_id) VALUES($1,'Second Opérateur','independent','verified',$2) ON CONFLICT DO NOTHING`,[SECOND_OPERATOR,secondOpsUser]);
  await sql(`UPDATE users SET operator_id=$2 WHERE id=$1`,[secondOpsUser,SECOND_OPERATOR]);
  api=createApi(db,config);
  for(const role of ['driver','passenger','ops']){
    const r=await api(new Request('http://localhost/api/v1/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role})}));
    const token=(await r.json()).data.token;
    if(role==='driver')driverToken=token;
    if(role==='passenger')passengerToken=token;
    if(role==='ops')opsToken=token;
  }
  fares=fareIntelligence(db);
});
after(async()=>{try{await dropDisposableSchema(db);}finally{await db.close();}});
/** @param {{method?:string,body?:unknown,key?:string}} [opts] */
const call=(path,token,opts={})=>{const {method='GET',body,key}=opts;
  return api(new Request('http://localhost/api/v1'+path,{method,
    headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...(key?{'idempotency-key':key}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})}));};
const OD={originStopId:demoId(200),destinationStopId:demoId(201)}; // Cotonou → Bohicon

test('commission model: 5% is included in the final customer price, never added on top',async()=>{
  const {commissionMinor,netMinor,grossMinor}=await import('@leroutier/domain').then(m=>m.splitCommission(7500));
  assert.equal(commissionMinor,375);assert.equal(netMinor,7125);assert.equal(grossMinor,7500);
  // The fare the passenger pays is the published segment sum, unchanged.
  const t=transport(db);
  const quote=await t.availability(demo.service,0,1);
  assert.equal(quote.fare.amountMinor,2500,'published fare is what the passenger pays');
});

test('walk-up cash sale credits the operator gross minus commission and stays cash',async()=>{
  const beforeRows=(await sql('SELECT count(*)::integer AS n FROM operator_settlements')).rows[0].n;
  const r=await call('/driver/walk-up-bookings',driverToken,{method:'POST',key:randomUUID(),
    body:{serviceId:demo.service,origin:0,destination:1,passengerName:'Test Cash',passengerPhone:'+229 97 000000',amountMinor:2500,cashReference:'CASH-01'}});
  assert.equal(r.status,200);
  const row=await one("SELECT * FROM operator_settlements WHERE source='walk_up' ORDER BY earned_at DESC LIMIT 1");
  assert.equal(row.gross_minor,2500);
  assert.equal(row.deduction_minor,125,'5% commission out of the final price');
  assert.equal(row.net_minor,2375,'gross = commission + net');
  assert.equal(row.currency,'XOF');
  const payment=await one("SELECT provider FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE p.provider='cash' ORDER BY p.created_at DESC LIMIT 1");
  assert.equal(payment.provider,'cash','cash stays cash, never a fake online payment');
  assert.equal((await sql('SELECT count(*)::integer AS n FROM operator_settlements')).rows[0].n,beforeRows+1);
});

test('duplicate walk-up keys never double-credit the operator',async()=>{
  const key=randomUUID();
  const body={serviceId:demo.service,origin:0,destination:1,passengerName:'Test Cash 2',passengerPhone:'+229 97 000001',amountMinor:2500,cashReference:'CASH-02'};
  const first=await call('/driver/walk-up-bookings',driverToken,{method:'POST',key,body});
  assert.equal(first.status,200);
  const before=(await sql(`SELECT count(*)::integer AS n FROM operator_settlements WHERE source='walk_up'`)).rows[0].n;
  const replay=await call('/driver/walk-up-bookings',driverToken,{method:'POST',key,body});
  assert.equal(replay.status,200);
  assert.equal((await sql(`SELECT count(*)::integer AS n FROM operator_settlements WHERE source='walk_up'`)).rows[0].n,before);
});

test('online ticket payment credits the ledger once and records one transaction observation',async()=>{
  const t=transport(db);
  const booking=await t.hold({id:demo.passenger,role:'passenger'},{serviceId:demo.service,origin:0,destination:1},'fi-hold-'+randomUUID().slice(0,8));
  const stub={name:'fedapay',initiate:async({paymentId})=>({reference:'FEDA-'+paymentId.slice(0,8)})};
  const pay=payments(db,stub);
  const p=await pay.initiate({id:demo.passenger,role:'passenger'},booking.id,{},'fi-intent-'+randomUUID().slice(0,8));
  const stored=await one('SELECT provider_reference FROM payments WHERE id=$1',[p.id]);
  const event={kind:'payment',paymentId:p.id,eventId:'evt-'+randomUUID().slice(0,8),reference:stored.provider_reference,amountMinor:booking.amount_minor,currency:'XOF',status:'succeeded'};
  await pay.applyEvent(event);
  const settlement=await one("SELECT * FROM operator_settlements WHERE source='ticket_online' AND reference=$1",['payment:'+p.id]);
  assert.equal(settlement.gross_minor,booking.amount_minor);
  assert.equal(settlement.deduction_minor,Math.round(booking.amount_minor*0.05));
  assert.equal(settlement.net_minor,settlement.gross_minor-settlement.deduction_minor);
  const obs=await one("SELECT * FROM fare_observations WHERE source_type='leroutier_transaction' AND source_reference=$1",['payment:'+p.id]);
  assert.equal(obs.fare_type,'passenger');assert.equal(obs.price_minor,booking.amount_minor);assert.equal(obs.currency,'XOF');
  assert.equal(obs.origin_stop_id,demoId(200));assert.equal(obs.destination_stop_id,demoId(201));
  // Provider replay: same event identifier must change nothing.
  await pay.applyEvent(event);
  assert.equal((await sql('SELECT count(*)::integer AS n FROM operator_settlements WHERE reference=$1',['payment:'+p.id])).rows[0].n,1);
  assert.equal((await sql('SELECT count(*)::integer AS n FROM fare_observations WHERE source_reference=$1',['payment:'+p.id])).rows[0].n,1);
});

test('parcel cash payment credits parcel_cash with commission; bank transfer credits parcel_online',async()=>{
  const parcel=parcels(db);
  const before=(await sql("SELECT count(*)::integer AS n FROM operator_settlements WHERE source IN ('parcel_cash','parcel_online')")).rows[0].n;
  const created=await parcel.create({id:demo.passenger,role:'passenger'},{
    senderName:'Sender Fi',senderPhone:'+229 97 000002',receiverName:'Receiver Fi',receiverPhone:'+229 97 000003',
    originStopId:demoId(200),destinationStopId:demoId(201),category:'documents',paymentResponsibility:'cash'},'fi-parcel-'+randomUUID().slice(0,8));
  assert.equal(created.priceMinor,1000,'seeded rate rule applies');
  const opsActor={id:demo.ops,role:'ops',operator_id:demo.operator};
  const payment=await parcel.recordPayment(opsActor,created.id,{provider:'cash',reference:'PARCEL-CASH-01',amountMinor:created.priceMinor},'fi-pp-'+randomUUID().slice(0,8));
  const cashRow=await one("SELECT * FROM operator_settlements WHERE source='parcel_cash' ORDER BY earned_at DESC LIMIT 1");
  assert.equal(cashRow.gross_minor,1000);assert.equal(cashRow.deduction_minor,50);assert.equal(cashRow.net_minor,950);
  const obs=await one("SELECT * FROM fare_observations WHERE source_type='leroutier_transaction' AND source_reference=$1",['parcel-payment:'+payment.id]);
  assert.equal(obs.fare_type,'parcel_standard');
  assert.equal((await sql("SELECT count(*)::integer AS n FROM operator_settlements WHERE source IN ('parcel_cash','parcel_online')")).rows[0].n,before+1);
});

test('express parcel level: same-day feasibility is checked, never promised blindly',async()=>{
  const parcel=parcels(db);
  // An express rate rule exists for the corridor.
  await sql(`INSERT INTO parcel_rate_rules(operator_id,origin_stop_id,destination_stop_id,base_minor,per_kg_minor,declared_value_bp,service_level)
    VALUES($1,$2,$3,3000,0,0,'express')`,[demo.operator,demoId(200),demoId(201)]);
  // No arrival evidence and departure not today → express fails closed.
  await sql(`UPDATE services SET departure_at=$2,arrival_at=NULL WHERE id=$1`,[demo.service,new Date(now+2*86_400_000)]);
  let refusedCode=null,refusedMessage='';
  try{await parcel.quote({id:demo.passenger,role:'passenger'},{...OD,category:'documents',serviceLevel:'express'});}
  catch(e){refusedCode=e.code;refusedMessage=e.message;}
  assert.equal(refusedCode,'EXPRESS_UNAVAILABLE');
  assert.match(refusedMessage,/jour même/);
  // A departure and scheduled arrival later today → express is offered; when
  // the next hour crosses midnight Porto-Novo time, express must still fail
  // closed instead of promising same-day delivery it cannot keep.
  const beninDay=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Porto-Novo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
  const departure=new Date(now+3600_000),arrival=new Date(now+7200_000);
  await sql('UPDATE services SET departure_at=$2,arrival_at=$3 WHERE id=$1',[demo.service,departure,arrival]);
  if(beninDay(departure.getTime())===beninDay(now) && beninDay(arrival.getTime())===beninDay(now)){
    const quoted=await parcel.quote({id:demo.passenger,role:'passenger'},{...OD,category:'documents',serviceLevel:'express'});
    assert.equal(quoted.serviceLevel,'express');
    assert.equal(quoted.amountMinor,3000,'express rate rule applies');
  }else{
    let lateCode=null;
    try{await parcel.quote({id:demo.passenger,role:'passenger'},{...OD,category:'documents',serviceLevel:'express'});}catch(e){lateCode=e.code;}
    assert.equal(lateCode,'EXPRESS_UNAVAILABLE','no same-day promise across midnight');
  }
  // Standard level is unaffected by the express rule.
  const standard=await parcel.quote({id:demo.passenger,role:'passenger'},{...OD,category:'documents'});
  assert.equal(standard.serviceLevel,'standard');assert.equal(standard.amountMinor,1000);
});

test('a price change preserves history: the previous published fare is closed, not overwritten',async()=>{
  const before=(await sql('SELECT count(*)::integer AS n FROM fare_observations WHERE origin_stop_id=$1',[demoId(200)])).rows[0].n;
  await db.transaction(tx=>fares.recordPublished(tx,{operatorId:demo.operator,...OD,fareType:'passenger',priceMinor:2500,
    operatorType:'company',sourceType:'leroutier_published',sourceReference:'route:fi:0',effectiveFrom:days(2)}));
  await db.transaction(tx=>fares.recordPublished(tx,{operatorId:demo.operator,...OD,fareType:'passenger',priceMinor:2800,
    operatorType:'company',sourceType:'leroutier_published',sourceReference:'route:fi:1',effectiveFrom:days(1)}));
  const rows=(await sql('SELECT * FROM fare_observations WHERE source_reference IN ($1,$2) ORDER BY effective_from',['route:fi:0','route:fi:1'])).rows;
  assert.equal(rows.length,2,'both periods remain in history');
  assert.ok(rows[0].effective_to,'the older fare is closed');
  assert.equal(rows[1].effective_to,null,'the newer fare is current');
  assert.equal(rows[1].price_minor,2800);
  assert.equal((await sql('SELECT count(*)::integer AS n FROM fare_observations WHERE origin_stop_id=$1',[demoId(200)])).rows[0].n,before+2);
});

test('segment-level observations stay distinct OD pairs',async()=>{
  await db.transaction(tx=>fares.recordTransaction(tx,{operatorId:SECOND_OPERATOR,originStopId:demoId(200),destinationStopId:demoId(203),
    fareType:'passenger',priceMinor:7500,sourceReference:'tx:full:1',observedAt:days(0)}));
  await db.transaction(tx=>fares.recordTransaction(tx,{operatorId:SECOND_OPERATOR,originStopId:demoId(201),destinationStopId:demoId(203),
    fareType:'passenger',priceMinor:5500,sourceReference:'tx:full:2',observedAt:days(0)}));
  const cotParakou=await fares.marketStats({originStopId:demoId(200),destinationStopId:demoId(203),fareType:'passenger'});
  const bohParakou=await fares.marketStats({originStopId:demoId(201),destinationStopId:demoId(203),fareType:'passenger'});
  assert.equal(cotParakou.freshCount,1);assert.equal(bohParakou.freshCount,1);
  assert.notEqual(cotParakou.median,bohParakou.median);
});

test('external public observations are separated from operator history',async()=>{
  // A corridor with no operator rows: Dassa → Parakou.
  const extOD={originStopId:demoId(202),destinationStopId:demoId(203)};
  await db.transaction(tx=>fares.recordExternal(tx,{...extOD,fareType:'passenger',
    priceMinor:2200,sourceReference:'https://public.example/fares',observedAt:days(1)}));
  const row=await one("SELECT * FROM fare_observations WHERE source_type='external_public' ORDER BY recorded_at DESC LIMIT 1");
  assert.equal(row.operator_id,null,'external rows carry no operator');
  const stats=await fares.marketStats({...extOD,fareType:'passenger',ownOperatorId:demo.operator});
  assert.ok(stats.count>0,'external evidence feeds the market aggregate');
  assert.equal(stats.ownCount,0,'external evidence is never counted as the operator’s own history');
  assert.ok(!Object.values(stats).some(v=>Array.isArray(v)),'aggregates only — no per-row data leaves the service');
});

test('old observations lose importance; fresh evidence drives the recommendation',async()=>{
  await sql('DELETE FROM fare_observations WHERE origin_stop_id=$1 AND destination_stop_id=$2',[SECOND_STOP_A,SECOND_STOP_B]);
  await sql(`INSERT INTO stops(id,place_id,name,latitude,longitude) VALUES($1,$2,'A2',6.5,2.4),($3,$4,'B2',6.6,2.5) ON CONFLICT DO NOTHING`,[SECOND_STOP_A,demoId(100),SECOND_STOP_B,demoId(101)]);
  await db.transaction(tx=>fares.recordExternal(tx,{originStopId:SECOND_STOP_A,destinationStopId:SECOND_STOP_B,fareType:'passenger',priceMinor:9000,sourceReference:'https://public.example/old',observedAt:days(170)}));
  await db.transaction(tx=>fares.recordExternal(tx,{originStopId:SECOND_STOP_A,destinationStopId:SECOND_STOP_B,fareType:'passenger',priceMinor:3000,sourceReference:'https://public.example/new1',observedAt:days(1)}));
  await db.transaction(tx=>fares.recordExternal(tx,{originStopId:SECOND_STOP_A,destinationStopId:SECOND_STOP_B,fareType:'passenger',priceMinor:3200,sourceReference:'https://public.example/new2',observedAt:days(2)}));
  const stats=await fares.marketStats({originStopId:SECOND_STOP_A,destinationStopId:SECOND_STOP_B,fareType:'passenger'});
  assert.equal(stats.freshCount,2,'the 170-day observation is outside the fresh window');
  assert.ok(stats.weightedMedian<=3200 && stats.weightedMedian>=3000,'recency weighting keeps the centre near fresh evidence');
  // Entirely outside the observation window → invisible to today's stats.
  await db.transaction(tx=>fares.recordExternal(tx,{originStopId:SECOND_STOP_A,destinationStopId:SECOND_STOP_B,fareType:'passenger',priceMinor:9999,sourceReference:'https://public.example/ancient',observedAt:days(400)}));
  const stats2=await fares.marketStats({originStopId:SECOND_STOP_A,destinationStopId:SECOND_STOP_B,fareType:'passenger'});
  assert.equal(stats2.count,3,'the 400-day observation is outside the window');
});

test('a single outlier does not distort the typical range',async()=>{
  await sql('DELETE FROM fare_observations WHERE origin_stop_id=$1 AND destination_stop_id=$2',[SECOND_STOP_A,SECOND_STOP_B]);
  for(const [i,price] of [[0,5000],[1,5000],[2,5200],[3,60000]]) await db.transaction(tx=>fares.recordExternal(tx,
    {originStopId:SECOND_STOP_A,destinationStopId:SECOND_STOP_B,fareType:'passenger',priceMinor:price,sourceReference:`https://public.example/o${i}`,observedAt:days(1)}));
  const stats=await fares.marketStats({originStopId:SECOND_STOP_A,destinationStopId:SECOND_STOP_B,fareType:'passenger'});
  assert.equal(stats.median,5000,'median ignores the outlier');
  assert.equal(stats.lowerQuartile,5000);assert.equal(stats.upperQuartile,5200);
  assert.equal(stats.weightedMedian,5000,'weighted median stays with the cluster');
});

test('insufficient evidence gives no fake recommendation',async()=>{
  await sql('DELETE FROM fare_observations WHERE origin_stop_id=$1 AND destination_stop_id=$2',[SECOND_STOP_A,SECOND_STOP_B]);
  const rec=await fares.recommend({originStopId:SECOND_STOP_A,destinationStopId:SECOND_STOP_B,fareType:'passenger',ownOperatorId:demo.operator});
  assert.equal(rec.status,'insufficient_data');
  assert.equal(rec.suggestedPriceMinor,null);
  assert.match(rec.message,/Pas encore assez de données/);
});

test('recommend is advisory: it never writes, and the operator keeps their price',async()=>{
  const before=(await sql('SELECT count(*)::integer AS n FROM fare_observations')).rows[0].n;
  await fares.recommend({...OD,fareType:'parcel_standard',ownOperatorId:demo.operator});
  await fares.recommend({...OD,fareType:'parcel_standard',ownOperatorId:demo.operator});
  assert.equal((await sql('SELECT count(*)::integer AS n FROM fare_observations')).rows[0].n,before,'reading recommendations changes nothing');
});

test('operators can accept the suggested price through the standard rate-rule path',async()=>{
  // Seed enough fresh market evidence for a recommendation on the parcel corridor.
  for(const [i,price] of [[0,800],[1,1000],[2,1200]]) await db.transaction(tx=>fares.recordExternal(tx,
    {originStopId:demoId(200),destinationStopId:demoId(201),fareType:'parcel_standard',priceMinor:price,sourceReference:`https://public.example/p${i}`,observedAt:days(0)}));
  const r=await call(`/ops/fare-intelligence?originStopId=${demoId(200)}&destinationStopId=${demoId(201)}&fareType=parcel_standard`,opsToken);
  assert.equal(r.status,200);
  const rec=await r.json();
  assert.equal(rec.data.status,'recommended');
  const accept=await call('/ops/parcel-rate-rules',opsToken,{method:'POST',key:randomUUID(),
    body:{originStopId:demoId(200),destinationStopId:demoId(201),baseMinor:rec.data.suggestedPriceMinor,serviceLevel:'standard'}});
  assert.equal(accept.status,200);
  const published=await one("SELECT * FROM fare_observations WHERE source_reference LIKE 'parcel-rule:%' ORDER BY recorded_at DESC LIMIT 1");
  assert.equal(published.price_minor,rec.data.suggestedPriceMinor,'acceptance publishes a new historical fare');
  assert.equal(published.fare_type,'parcel_standard');
});

test('passengers cannot access Fare Intelligence; anonymous users get nothing',async()=>{
  const asPassenger=await call(`/ops/fare-intelligence?originStopId=${demoId(200)}&destinationStopId=${demoId(201)}`,passengerToken);
  assert.equal(asPassenger.status,403);
  const anonymous=await call(`/ops/fare-intelligence?originStopId=${demoId(200)}&destinationStopId=${demoId(201)}`);
  assert.equal(anonymous.status,401);
  const planAnon=await call('/ops/plan');
  assert.equal(planAnon.status,401);
});

test('cross-operator isolation: aggregates only, never another operator’s rows',async()=>{
  // Operator B has no own history on this corridor; operator A does.
  const rec=await fares.recommend({...OD,fareType:'passenger',ownOperatorId:SECOND_OPERATOR});
  assert.equal(rec.ownCount,0);
  assert.equal(rec.currentPriceMinor,null,'no open published fare for the other operator');
  assert.ok(!Object.keys(rec).some(k=>typeof rec[k]==='object' && Array.isArray(rec[k]) && rec[k].some(r=>r.operator_id)),
    'no observation rows or operator identities leak through the API');
});

test('company plan representation; independent drivers have no subscription at all',async()=>{
  const commerce=commercial(db);
  // The seeded demo company predates plan representation; give it its plan row.
  await sql(`INSERT INTO operator_plans(operator_id,plan,monthly_price_minor,billing_status) VALUES($1,'standard',NULL,'not_billed') ON CONFLICT DO NOTHING`,[demo.operator]);
  const companyPlan=await commerce.plan({id:demo.ops,role:'ops',operator_id:demo.operator});
  assert.equal(companyPlan.operatorType,'company');
  assert.equal(companyPlan.commissionBp,500);
  assert.equal(companyPlan.subscription.active,true);
  assert.equal(companyPlan.subscription.billingStatus,'not_billed');
  const independent=await commerce.plan({id:demo.ops,role:'ops',operator_id:SECOND_OPERATOR},SECOND_OPERATOR);
  assert.equal(independent.operatorType,'independent');
  assert.equal(independent.subscription.active,false);
  assert.equal(independent.subscription.monthlyPriceMinor,0,'no independent subscription charged');
  // The schema itself refuses a plan row for an independent driver.
  await assert.rejects(sql(`INSERT INTO operator_plans(operator_id,plan,monthly_price_minor) VALUES($1,'standard',5000)`,[SECOND_OPERATOR]),
    e=>{const err=/** @type {{code?:string,cause?:unknown,message?:string}} */(e);return err.code==='23514' || /no subscription plan/i.test(String(err.cause??err.message));});
});

test('platform ops can plan-view any operator; operator ops cannot cross the boundary',async()=>{
  const commerce=commercial(db);
  await assert.rejects(commerce.plan({id:demo.ops,role:'ops',operator_id:demo.operator},SECOND_OPERATOR),{code:'FORBIDDEN'});
});

test('external observations are recorded through the Ops endpoint with a safe https source',async()=>{
  const ok=await call('/ops/fare-observations',opsToken,{method:'POST',body:{...OD,fareType:'passenger',priceMinor:2400,sourceUrl:'https://market.example/fares/cotonou-bohicon'}});
  assert.equal(ok.status,200);
  const bad=await call('/ops/fare-observations',opsToken,{method:'POST',body:{...OD,fareType:'passenger',priceMinor:2400,sourceUrl:'javascript:alert(1)'}});
  assert.equal(bad.status,400);
  const row=await one("SELECT * FROM fare_observations WHERE source_type='external_public' ORDER BY recorded_at DESC LIMIT 1");
  assert.equal(row.source_reference,'https://market.example/fares/cotonou-bohicon');
});

test('existing booking and capacity invariants remain unchanged',async()=>{
  const t=transport(db);
  const quote=await t.availability(demo.service,1,2);
  assert.equal(quote.fare.amountMinor,2000);
  const hold=await t.hold({id:demo.passenger,role:'passenger'},{serviceId:demo.service,origin:1,destination:2},'fi-inv-'+randomUUID().slice(0,8));
  assert.equal(hold.amount_minor,2000,'the customer total is the published fare, commission never added on top');
  assert.equal(hold.status,'held');
});
