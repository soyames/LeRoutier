// Synthetic data only. Both source and restore databases must be loopback.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {serverConfig} from '../packages/config/src/index.js';
import {createDatabase} from '../packages/database/src/index.js';
import {migrate} from '../packages/database/src/migrations.js';
import {seed,demo,demoId} from '../packages/database/src/seed.js';
import {dropDisposableSchema} from '../packages/database/src/guards.js';
import {transport} from '../packages/database/src/transport.js';
import {parcels} from '../packages/database/src/parcels.js';
import {tickets} from '../packages/database/src/tickets.js';
import {createApi} from '../services/api/src/app.js';
import {notificationPolicies} from '../packages/database/src/notifications.js';
import {notificationDelivery} from '../packages/database/src/notification-delivery.js';
import {bootstrap} from '../packages/agents/src/principals.js';

const config=serverConfig(),url=new URL(config.databaseUrl);
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Drill requires loopback PostgreSQL');
assert.notEqual(process.env.NODE_ENV,'production');
const schema='lr_test_'+randomUUID().replaceAll('-','');
const db=createDatabase({...config,schema});
const report={generatedAt:new Date().toISOString(),environment:'disposable local PostgreSQL',workloads:[],plans:{},restore:null};
const passenger={id:demo.passenger,role:'passenger'},ops={id:demo.ops,role:'ops',operator_id:demo.operator};
const query=(sql,args=[])=>db.transaction(tx=>tx.query(sql,args));
const d=transport(db),parcel=parcels(db);
let restored,restoreDb,container;
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const pg=args=>docker(['exec',container,...args]);
const percentile=(values,p)=>values[Math.min(values.length-1,Math.ceil(values.length*p)-1)];
async function bench(name,fn,{n=40,concurrency=5,expected=[]}={}) {
 const times=[];let errors=0,expectedRejections=0,next=0,peakWaiting=0,peakConnections=0;
 const sampler=setInterval(()=>{const s=db.poolStats();peakWaiting=Math.max(peakWaiting,s.waiting);peakConnections=Math.max(peakConnections,s.total);},5);
 await Promise.all(Array.from({length:concurrency},async()=>{
  while(next<n){const i=next++,start=performance.now();try {const result=await fn(i);if(result instanceof Response && !result.ok){if(expected.includes(result.status))expectedRejections++;else errors++;}}
   catch(e){if(expected.includes(e.code))expectedRejections++;else errors++;}times.push(performance.now()-start);}
 }));
 clearInterval(sampler);
 const lockSamples=Number((await query("SELECT count(*) FROM pg_locks WHERE NOT granted")).rows[0].count);
 times.sort((a,b)=>a-b);
 report.workloads.push({name,requests:n,concurrency,p50Ms:percentile(times,.5),p95Ms:percentile(times,.95),p99Ms:percentile(times,.99),errors,errorRate:errors/n,expectedRejections,peakConnections,peakWaiting,ungrantedLocksAfter:lockSamples});
 assert.equal(errors,0,`${name} unexpected errors`);
}
async function snapshot(database) {
 return database.transaction(async tx=>{
  const tables=(await tx.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[schema])).rows;
  const result={};
  for(const {tablename} of tables){assert.match(tablename,/^[a-z_]+$/);const records=(await tx.query(`SELECT to_jsonb(t)::text AS data FROM "${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
   result[tablename]={count:records.length,sha256:createHash('sha256').update(JSON.stringify(records)).digest('hex')};}
  return result;
 });
}
try {
 report.migrations=await migrate(db);await seed(db,{capacity:100});
 const booking=await d.hold(passenger,{serviceId:demo.service,origin:0,destination:1},randomUUID());
 await d.recordPayment(ops,booking.id,{amountMinor:booking.amount_minor,currency:'XOF',reference:'DRILL-SYNTHETIC',provider:'demo'},randomUUID());
 await d.transition(passenger,booking.id,'confirm');
 const ticket=await tickets(db).issue(passenger,booking.id);
 const p=await parcel.create(passenger,{senderName:'Synthetic sender',senderPhone:'+22961000001',receiverName:'Synthetic receiver',receiverPhone:'+22961000002',originStopId:demoId(200),destinationStopId:demoId(201),category:'documents'},randomUUID());
 await parcel.accept(ops,p.id);
 await bootstrap(db,{name:'drill',token:'lragt_'+randomBytes(32).toString('base64url'),scopes:['service.read']});
 await query("INSERT INTO agent_model_cooldowns(provider,until_at,reason) VALUES('gemini',now()+interval '1 hour','quota_exhausted')");
 const api=createApi(db,{...config,schema,demoLogin:true,model:{provider:'none'}});
 const req=(path,method='GET',body=undefined,token=undefined)=>api(new Request('http://localhost/api/v1'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),'idempotency-key':randomUUID()},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 const sessions={};for(const role of ['passenger','driver','ops']){sessions[role]=(await (await req('/auth/demo','POST',{role})).json()).data.token;}
 await bench('trip search',()=>req(`/services?originStopId=${demoId(200)}&destinationStopId=${demoId(201)}`));
 await bench('availability',()=>req(`/services/${demo.service}/availability?origin=0&destination=1`));
 await bench('booking create',()=>req('/bookings','POST',{serviceId:demo.service,origin:0,destination:1},sessions.passenger),{n:20});
 await bench('ticket lookup',()=>req('/tickets/verify','POST',{serviceId:demo.service,stopSequence:0,code:ticket.manualCode},sessions.driver),{n:20});
 await bench('parcel tracking',()=>req('/public/parcel-tracking/'+p.trackingNumber));
 await bench('GPS ingestion',i=>req(`/services/${demo.service}/positions`,'POST',{latitude:6.36,longitude:2.43,accuracyM:10,observedAt:new Date(Date.now()-250000+i*6000).toISOString()},sessions.driver),{n:30,expected:[409,429]});
 const notify=notificationPolicies(db);
 const events=(await query('SELECT * FROM outbox')).rows;
 await bench('notification duplicate burst',()=>db.transaction(tx=>notify.dispatchEvent(tx,events[0])),{n:30});
 await notificationDelivery(db).tick();
 await bench('Ops service list',()=>req('/ops/fleet','GET',undefined,sessions.ops),{n:20});
 // Fill all but one seat, then race twenty requests for that final seat.
 for(let i=0;i<78;i++)await d.hold(passenger,{serviceId:demo.service,origin:0,destination:1},randomUUID());
 await bench('last seat concurrency',()=>d.hold(passenger,{serviceId:demo.service,origin:0,destination:1},randomUUID()),{n:20,concurrency:20,expected:['SOLD_OUT']});
 assert.equal(Number((await query('SELECT count(*) FROM booking_segments WHERE service_id=$1 AND sequence=0',[demo.service])).rows[0].count),100);
 const statements={
  service_search:["SELECT id FROM services WHERE status IN ('scheduled','active') ORDER BY departure_at LIMIT 50",[]],
  segment_availability:['SELECT * FROM booking_segments WHERE service_id=$1 AND sequence=0',[demo.service]],
  booking_lookup:['SELECT * FROM bookings WHERE id=$1',[booking.id]],
  operator_services:['SELECT id FROM services WHERE operator_id=$1 ORDER BY departure_at DESC LIMIT 100',[demo.operator]],
  parcel_tracking:['SELECT id FROM parcels WHERE tracking_number=$1',[p.trackingNumber]],
  latest_gps:['SELECT latitude,longitude FROM vehicle_positions WHERE service_id=$1 ORDER BY observed_at DESC LIMIT 1',[demo.service]],
  notifications:['SELECT id FROM notifications WHERE user_id=$1 AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 50',[passenger.id]],
  agent_queue:["SELECT id FROM workflow_runs WHERE status='running' ORDER BY created_at LIMIT 50",[]],
 };
 for(const [name,[sql,args]] of Object.entries(statements))report.plans[name]=(await query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+sql,args)).rows[0]['QUERY PLAN'];
 const before=await snapshot(db);
 for(const name of ['users','operators','routes','services','bookings','payments','parcels','vehicle_positions','agent_principals'])assert.ok(before[name].count>0,`${name} restore fixture is populated`);
 const restoreStart=performance.now();
 container=docker(['ps','--filter','ancestor=postgres:18-alpine','--format','{{.ID}}']).split('\n')[0];assert.match(container,/^[a-f0-9]+$/);
 restoreDb='lr_test_restore_'+randomUUID().replaceAll('-','');
 const sourceDb=url.pathname.slice(1),user=decodeURIComponent(url.username),dump='/tmp/'+restoreDb+'.dump';
 pg(['pg_dump','-U',user,'-d',sourceDb,'-n',schema,'-Fc','-f',dump]);
 pg(['createdb','-U',user,restoreDb]);
 pg(['pg_restore','-U',user,'--exit-on-error','-d',restoreDb,dump]);
 const restoredUrl=new URL(url);restoredUrl.pathname='/'+restoreDb;
 restored=createDatabase({...config,databaseUrl:restoredUrl.toString(),schema});
 assert.deepEqual(await snapshot(restored),before,'Every table restored exactly');
 assert.equal(await migrate(restored),report.migrations);assert.deepEqual(await snapshot(restored),before,'Migration replay changes no data');
 report.restore={tables:Object.keys(before).length,nonemptyTables:Object.values(before).filter(t=>t.count>0).length,verifiedTables:before,elapsedMs:performance.now()-restoreStart,integrity:'all table counts and SHA256 row digests equal; constraints restored; migrations replayed'};
 pg(['rm',dump]);
 mkdirSync('.tmp',{recursive:true});writeFileSync('.tmp/operational-drill.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({migrations:report.migrations,workloads:report.workloads,restore:{...report.restore,verifiedTables:undefined},report:'.tmp/operational-drill.json'},null,2));
} finally {
 if(restored)await restored.close();
 if(restoreDb && /^lr_test_restore_[a-f0-9]{32}$/.test(restoreDb))pg(['dropdb','-U',decodeURIComponent(url.username),'--if-exists',restoreDb]);
 try{await dropDisposableSchema(db);}finally{await db.close();}
}
