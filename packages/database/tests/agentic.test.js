import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { transport } from '../src/transport.js';
import { payments } from '../src/payments.js';
import { earnings, payouts } from '../src/payouts.js';
import { recovery } from '../src/recovery.js';
import { recordIncident } from '../src/driver-actions.js';
import { bootstrap, authenticate, createActions, createWorkflowEngine } from '@leroutier/agents';
import { createApi } from '../../../services/api/src/app.js';

const config={...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-',''),demoLogin:true};
const db=createDatabase(config),domain=transport(db);
const passenger={id:demo.passenger,role:'passenger'},driver={id:demo.driver,role:'driver'},ops={id:demo.ops,role:'ops',operator_id:demo.operator};
const pay=payments(db),payout=payouts(db,null,{payoutApprovalRequired:true}),earn=earnings(db);
const actions=createActions({db,domain,payments:pay,payouts:payout,recovery:recovery(db)});
const engine=createWorkflowEngine({db,actions});
const token=()=>'lragt_'+randomBytes(32).toString('base64url');
const tokens={};
let platform,bound,readonly,api;
const one=async(sql,args=[])=>(await db.transaction(async tx=>(await tx.query(sql,args)).rows[0]));
before(async()=>{
  await migrate(db);await seed(db);
  platform=await bootstrap(db,{name:'platform-agent',token:tokens.platform=token(),scopes:['service.read','incident.read','incident.manage','notification.send','payment.reconcile','payout.review','alert.create','workflow.run']});
  bound=await bootstrap(db,{name:'bound-agent',token:tokens.bound=token(),scopes:['service.read'],operatorId:demo.operator});
  readonly=await bootstrap(db,{name:'readonly-agent',token:tokens.readonly=token(),scopes:['service.read']});
  api=createApi(db,config);
});
beforeEach(async()=>{
  await db.transaction(async tx=>{await tx.query('DELETE FROM booking_segments');await tx.query("UPDATE bookings SET status='cancelled'");await tx.query('DELETE FROM payment_events');await tx.query('DELETE FROM payments');await tx.query('DELETE FROM payout_events');await tx.query('DELETE FROM driver_earnings');await tx.query('DELETE FROM payout_requests');await tx.query('DELETE FROM payout_destinations');await tx.query('DELETE FROM agent_action_receipts');await tx.query('DELETE FROM workflow_approvals');await tx.query('DELETE FROM workflow_runs');await tx.query('DELETE FROM outbox');await tx.query("UPDATE services SET current_sequence=0,status='active'");});
});
after(async()=>{try{await dropDisposableSchema(db);}finally{await db.close();}});
const agentRequest=(agentToken,path,method='GET',body=undefined,key=undefined)=>{
  const headers={'content-type':'application/json',authorization:'Bearer '+agentToken};
  if(key)headers['idempotency-key']=key;
  return new Request('http://localhost/api/v1'+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
};

test('agent principals authenticate through their own token namespace',async()=>{
  const auth=await authenticate(db,new Request('http://localhost',{headers:{authorization:'Bearer '+tokens.platform}}));
  assert.equal(auth.agent.name,'platform-agent');
  assert.equal(auth.agent.scopes.includes('service.read'),true);
  assert.equal(bound.operatorId,demo.operator,'operator-bound principals carry their binding');
  assert.equal(readonly.scopes.length,1);
  assert.equal(await authenticate(db,new Request('http://localhost',{headers:{authorization:'Bearer lragt_'+'A'.repeat(40)}})),null);
});

test('unauthorized agent action rejected; scoped agent action succeeds',async()=>{
  const run=await api(agentRequest(tokens.readonly,'/agent/actions/payment.reconcile/run','POST',{paymentId:randomUUID()}));
  assert.equal(run.status,403);
  const ok=await api(agentRequest(tokens.platform,'/agent/actions/service.inspect/run','POST',{operatorId:null}));
  assert.equal(ok.status,200);
  const data=(await ok.json()).data;
  assert.equal(data.status,'completed');
  assert.ok(Array.isArray(data.result));
  assert.ok(data.result.every(s=>'route_name' in s));
});

test('agent cannot bypass operator boundary',async()=>{
  const outside=await api(agentRequest(tokens.bound,'/agent/actions/service.inspect/run','POST',{operatorId:randomUUID()}));
  assert.equal(outside.status,403);
  const own=await api(agentRequest(tokens.bound,'/agent/actions/service.inspect/run','POST',{operatorId:null}));
  const data=(await own.json()).data;
  assert.equal(data.status,'completed');
  assert.ok(data.result.every(s=>s.operator_id===demo.operator));
});

test('financial action requires approval and surfaces execution failure',async()=>{
  const b=await domain.hold(passenger,{serviceId:demo.service,origin:0,destination:1},randomUUID());
  const p=await domain.recordPayment(ops,b.id,{provider:'cash',reference:'CASH-1',amountMinor:2500,currency:'XOF'},randomUUID());
  const before=await one('SELECT status FROM payments WHERE id=$1',[p.id]);
  assert.equal(before.status,'succeeded');
  const run=await engine.runAction(platform,'payment.reconcile',{paymentId:p.id},'agent-reconcile-1');
  assert.equal(run.status,'awaiting_approval');
  assert.equal(run.pendingApproval,true);
  const approvals=await engine.listApprovals(ops);
  assert.equal(approvals.length,1);
  assert.equal(approvals[0].action,'payment.reconcile');
  // The payment is untouched while the approval is pending.
  assert.equal((await one('SELECT status FROM payments WHERE id=$1',[p.id])).status,'succeeded');
  const approved=await engine.approve(ops,approvals[0].id,'approved');
  assert.equal(approved.status,'failed','execution fails because no provider adapter is configured');
  const failed=(await one("SELECT * FROM workflow_runs WHERE id=$1",[approved.id]));
  assert.equal(failed.attempts,1);
  const retried=await engine.retry(ops,approved.id);
  assert.equal(retried.status,'failed');
});

test('human approval releases a pending action exactly once',async()=>{
  await recordIncident(db,driver,{serviceId:demo.service,kind:'breakdown',severity:'high',description:'Agentic recovery test'});
  await engine.processOutbox();
  const approvals=await engine.listApprovals(ops);
  const approval=approvals.find(a=>a.action==='recovery.assign');
  assert.ok(approval,'recovery approval was created by the workflow');
  const completed=await engine.approve(ops,approval.id,'approved',{driverId:demo.driver});
  assert.equal(completed.status,'completed');
  await assert.rejects(engine.approve(ops,approval.id,'approved'),{code:'APPROVAL_DECIDED'});
  const assignment=await one('SELECT a.id FROM service_assignments a JOIN vehicles v ON v.id=a.vehicle_id WHERE a.service_id=$1 AND a.ended_at IS NULL',[demo.service]);
  assert.ok(assignment);
});

test('duplicated workflow events create exactly one run',async()=>{
  const incident=await recordIncident(db,driver,{serviceId:demo.service,kind:'delay',severity:'medium',description:'Duplicate delivery test'});
  const outbox=await one("SELECT * FROM outbox WHERE event_type='incident.created' AND aggregate_id=$1",[incident.id]);
  // Simulate a second delivery of the same event.
  await db.transaction(async tx=>tx.query("INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)",[outbox.event_type,outbox.aggregate_id,outbox.payload]));
  await engine.processOutbox();
  const count=(await one("SELECT count(*)::integer AS n FROM workflow_runs WHERE workflow='breakdown-recovery'")).n;
  assert.equal(count,1);
});

test('retry does not duplicate mutation and receipts replay idempotently',async()=>{
  const key='notify-key-1';
  const first=await engine.runAction(platform,'notification.send',{recipients:[demo.passenger],template:'test',data:{}},key);
  assert.equal(first.status,'completed');
  assert.equal(first.result.queued,1);
  const replay=await engine.runAction(platform,'notification.send',{recipients:[demo.passenger],template:'test',data:{}},key);
  assert.equal(replay.replayed,true);
  const queued=(await one("SELECT count(*)::integer AS n FROM outbox WHERE event_type='notification.send'")).n;
  assert.equal(queued,1);
});

test('audit events record the agent principal behind mutations',async()=>{
  await engine.runAction(platform,'alert.create',{kind:'other',message:'Audit probe',serviceId:null});
  const audit=await one("SELECT * FROM audit_events WHERE principal_id=$1 AND action='agent.action.requested' ORDER BY created_at DESC",[platform.id]);
  assert.ok(audit,'agent action request was audited with the principal id');
  assert.equal(audit.action,'agent.action.requested');
});

test('a webhook anomaly event triggers the reconciliation workflow',async()=>{
  const paymentId=randomUUID();
  await db.transaction(async tx=>tx.query("INSERT INTO outbox(event_type,aggregate_id,payload) VALUES('payment.anomaly',$1,$2)",[paymentId,JSON.stringify({paymentId})]));
  await engine.processOutbox();
  const run=(await one("SELECT * FROM workflow_runs WHERE workflow='payment-reconciliation' ORDER BY created_at DESC"));
  assert.ok(run,'anomaly triggered a workflow run');
  assert.equal(run.status,'awaiting_approval');
});

test('payout workflow validates reservations and failures release them',async()=>{
  await earn.credit({driverId:demo.driver,source:'fixture',reference:'agentic-trip',grossMinor:5000});
  const destination=await payout.addDestination(driver,{country:'BJ',phoneNumber:'61234567'});
  const request=await payout.request(driver,{destinationId:destination.id,amountMinor:3000},randomUUID());
  await engine.processOutbox();
  const approval=(await engine.listApprovals(ops)).find(a=>a.action==='payout.execute');
  assert.ok(approval,'payout workflow paused on the approval gate');
  const run=await engine.approve(ops,approval.id,'approved');
  assert.equal(run.status,'failed','execution fails closed without a payout adapter');
  const summary=await earn.summary(driver);
  assert.equal(summary.available,5000,'reservation was released after failure');
  const status=(await one('SELECT status FROM payout_requests WHERE id=$1',[request.id])).status;
  assert.equal(status,'failed');
});

test('agent API endpoints enforce principal authentication',async()=>{
  assert.equal((await api(agentRequest('lragt_'+'B'.repeat(40),'/agent/me'))).status,401);
  const me=await api(agentRequest(tokens.platform,'/agent/me'));
  const body=(await me.json()).data;
  assert.equal(body.principal.name,'platform-agent');
  assert.ok(body.actions.some(a=>a.name==='service.inspect'));
  const tick=await api(agentRequest(tokens.platform,'/workflows/tick','POST'));
  assert.equal(tick.status,200);
  assert.equal((await api(agentRequest(tokens.readonly,'/workflows/tick','POST'))).status,403);
  assert.equal((await api(agentRequest(tokens.platform,'/ops/fleet'))).status,403);
});
