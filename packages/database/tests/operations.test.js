import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serverConfig} from '@leroutier/config';
import {createDatabase} from '../src/index.js';
import {migrate} from '../src/migrations.js';
import {seed,demo} from '../src/seed.js';
import {dropDisposableSchema} from '../src/guards.js';
import {gpsRetention} from '../src/retention.js';
import {notificationPolicies} from '../src/notifications.js';
import {notificationDelivery} from '../src/notification-delivery.js';
import {operationalHealth} from '../src/operational-health.js';
import {createWorkflowEngine} from '@leroutier/agents';
import {createApi} from '../../../services/api/src/app.js';
const config={...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-',''),demoLogin:true};
const db=createDatabase(config),sql=(q,p=[])=>db.transaction(tx=>tx.query(q,p));
let api,token;
before(async()=>{await migrate(db);await seed(db);api=createApi(db,config);
 const r=await api(new Request('http://localhost/api/v1/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'driver'})}));token=(await r.json()).data.token;});
after(async()=>{try{await dropDisposableSchema(db);}finally{await db.close();}});
const send=input=>api(new Request(`http://localhost/api/v1/services/${demo.service}/positions`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(input)}));
test('GPS rejects inaccurate, future, old, rapid and impossible fixes; concurrent duplicate is stored once',async()=>{
 const fix={latitude:6.36,longitude:2.43,accuracyM:10,observedAt:new Date(Date.now()-60000).toISOString()};
 assert.equal((await send({...fix,accuracyM:300})).status,422);
 assert.equal((await send({...fix,observedAt:new Date(Date.now()+60000).toISOString()})).status,400);
 assert.equal((await send({...fix,observedAt:new Date(Date.now()-600000).toISOString()})).status,400);
 const race=await Promise.all([send(fix),send(fix)]);assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
 assert.equal((await send({...fix,observedAt:new Date(Date.parse(fix.observedAt)+1000).toISOString()})).status,429);
 assert.equal((await send({...fix,latitude:9.34,observedAt:new Date().toISOString()})).status,422);
 assert.equal((await sql('SELECT count(*)::integer AS n FROM vehicle_positions')).rows[0].n,1);
});
test('retention defaults to preview and preserves active services, incidents and audit holds',async()=>{
 await sql("UPDATE vehicle_positions SET observed_at=now()-interval '40 days'");
 const retention=gpsRetention(db);
 assert.equal((await retention.run({dryRun:false})).deleted,0);
 await sql("UPDATE services SET status='completed',gps_retain_until=now()+interval '1 day'");
 assert.equal((await retention.run({dryRun:false})).deleted,0);
 await sql('UPDATE services SET gps_retain_until=NULL');
 await sql("INSERT INTO incidents(service_id,reported_by,kind,severity,description) VALUES($1,$2,'delay','low','Synthetic retention test')",[demo.service,demo.driver]);
 assert.equal((await retention.run({dryRun:false})).deleted,0);
 await sql("UPDATE incidents SET status='resolved'");
 assert.equal((await retention.run()).eligible,1);
 assert.equal((await retention.run()).deleted,0);
 assert.equal((await retention.run({dryRun:false})).deleted,1);
 assert.throws(()=>gpsRetention(db,{days:0}));
 await sql("UPDATE services SET status='active'");
});
test('notification replay is suppressed but a later real event is preserved; deliveries are audited',async()=>{
 const notify=notificationPolicies(db);
 const emit=async()=> (await sql("INSERT INTO outbox(event_type,aggregate_id,payload) VALUES('service.delayed',$1,'{}') RETURNING *",[demo.service])).rows[0];
 // Use a known platform policy without depending on a passenger booking.
 await sql("INSERT INTO notification_policies(event_type,audience,category,template) VALUES('test.notice','operator_ops','operational','test')");
 const event=await emit();event.event_type='test.notice';event.payload={operatorId:demo.operator};
 await db.transaction(tx=>notify.dispatchEvent(tx,event));await db.transaction(tx=>notify.dispatchEvent(tx,event));
 const later=await emit();later.event_type=event.event_type;later.payload=event.payload;
 await db.transaction(tx=>notify.dispatchEvent(tx,later));
 assert.equal((await sql("SELECT count(*)::integer AS n FROM notifications WHERE template='test'")).rows[0].n,2);
 await notificationDelivery(db).tick();
 assert.equal((await sql("SELECT count(*)::integer AS n FROM notification_delivery_attempts WHERE status='inbox_available'")).rows[0].n,2);
});
test('outbound failure retries to a dead letter and never reports sent',async()=>{
 const n=(await sql("SELECT id FROM notifications WHERE template='test' LIMIT 1")).rows[0];
 await sql("INSERT INTO notification_deliveries(notification_id,channel) VALUES($1,'email')",[n.id]);
 const sender=notificationDelivery(db,{email:{idempotent:true,send:async()=>{throw new Error('synthetic provider failure');}}});
 for(let i=0;i<5;i++){await sender.tick();await sql("UPDATE notification_deliveries SET next_attempt_at=now() WHERE channel='email'");}
 const result=(await sql("SELECT status,attempts,detail FROM notification_deliveries WHERE channel='email'")).rows[0];
 assert.deepEqual(result,{status:'failed',attempts:5,detail:'dead_letter'});
});
test('failed policy dispatch leaves an event retryable then dead, never delivered',async()=>{
 await sql('UPDATE outbox SET delivered_at=now()');
 const event=(await sql("INSERT INTO outbox(event_type,aggregate_id,payload) VALUES('test.failure',$1,'{}') RETURNING id",[demo.service])).rows[0];
 const engine=createWorkflowEngine({db,actions:{},onEvent:async()=>{throw new Error('fail');}});
 for(let i=0;i<5;i++){await engine.processOutbox();await sql('UPDATE outbox SET dispatch_retry_at=now() WHERE id=$1',[event.id]);}
 const row=(await sql('SELECT * FROM outbox WHERE id=$1',[event.id])).rows[0];assert.equal(row.delivered_at,null);assert.ok(row.dispatch_dead_at);assert.equal(row.dispatch_attempts,5);
});
test('workflow approval and retry are tenant isolated, including direct known IDs',async()=>{
 const run=(await sql("INSERT INTO workflow_runs(workflow,trigger_event,aggregate_id,operator_id,status) VALUES('test','test',$1,$2,'failed') RETURNING id",[demo.service,demo.operator])).rows[0];
 const approval=(await sql("INSERT INTO workflow_approvals(workflow_run_id,action,rationale) VALUES($1,'test','test') RETURNING id",[run.id])).rows[0];
 const other={id:demo.ops,role:'ops',operator_id:randomUUID()},engine=createWorkflowEngine({db,actions:{}});
 assert.deepEqual(await engine.listRuns(other),[]);assert.deepEqual(await engine.listApprovals(other),[]);
 await assert.rejects(engine.approve(other,approval.id,'rejected'),{code:'FORBIDDEN'});
 await assert.rejects(engine.retry(other,run.id),{code:'FORBIDDEN'});
});
test('operational health exposes aggregate signals only to Platform Ops',async()=>{
 const health=operationalHealth(db);await health.record('gps_anomaly');
 await assert.rejects(health.read({role:'ops',operator_id:demo.operator}),{code:'FORBIDDEN'});
 const result=await health.read({role:'ops'});assert.equal(result.migrations.matched,true);assert.ok(result.signals.some(s=>s.signal==='gps_anomaly'));
});
