import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notify, CHANNELS, CATEGORIES, channelAvailability, resolveChannels } from '@leroutier/notifications';

test('notification channels are typed and validated',async()=>{
  assert.deepEqual(CHANNELS,['in_app','web_push','sms','whatsapp','email']);
  assert.deepEqual(CATEGORIES,['critical','operational','marketing']);
  const calls=[];
  const tx={query:async(sql,args)=>{calls.push({sql,args});return {rows:[]};}};
  await notify(tx,{channel:'sms',to:'+22961000001',template:'parcel_ready',data:{trackingNumber:'LRP-12345678'}});
  assert.equal(calls.length,1);
  assert.equal(calls[0].sql.includes("event_type, aggregate_id, payload"),true);
  const payload=JSON.parse(calls[0].args[2]);
  assert.equal(payload.kind,'channel');
  assert.equal(payload.channel,'sms');
  assert.equal(payload.template,'parcel_ready');
  assert.equal(payload.data.trackingNumber,'LRP-12345678');
  await assert.rejects(notify(tx,{channel:'pigeon',to:'x',template:'t'}),/Unknown notification channel/);
  await assert.rejects(notify(tx,{channel:'sms',to:'',template:'t'}),/Invalid notification recipient/);
  await assert.rejects(notify(tx,{channel:'email',to:'x',template:''}),/Invalid notification template/);
});

test('unconfigured outbound providers stay unavailable instead of faking success',()=>{
  const availability=channelAvailability({});
  assert.equal(availability.in_app,true);
  for(const channel of ['web_push','sms','whatsapp','email']) assert.equal(availability[channel],false,channel);
  const resolved=resolveChannels({policyChannels:['sms','whatsapp'],availability,mandatory:true,category:'critical'});
  assert.deepEqual(resolved.map(r=>[r.channel,r.status]),[['sms','unavailable'],['whatsapp','unavailable'],['in_app','pending']]);
  // A missing provider must never be recorded as sent.
  assert.equal(resolved.some(r=>r.status==='sent'),false);
});

test('configured providers become available and in_app always terminates the order',()=>{
  const availability=channelAvailability({notificationProviders:{sms:{idempotent:true,send:async()=>({accepted:true})}}});
  assert.equal(availability.sms,true);
  assert.equal(availability.whatsapp,false);
  const resolved=resolveChannels({policyChannels:['sms','whatsapp'],availability,mandatory:true,category:'critical'});
  assert.deepEqual(resolved.map(r=>[r.channel,r.status]),[['sms','pending'],['whatsapp','unavailable'],['in_app','pending']]);
});

test('preferences suppress optional categories but never mandatory alerts',()=>{
  const availability=channelAvailability({notificationProviders:{sms:{idempotent:true,send:async()=>({accepted:true})}}});
  const preferences=[{category:'operational',channel:'sms',enabled:false},{category:'critical',channel:'sms',enabled:false}];
  const optional=resolveChannels({policyChannels:['sms'],availability,mandatory:false,category:'operational',preferences});
  assert.equal(optional.find(r=>r.channel==='sms').status,'suppressed');
  // In-app survives so the passenger can still find the message in the app.
  assert.equal(optional.find(r=>r.channel==='in_app').status,'pending');
  const mandatory=resolveChannels({policyChannels:['sms'],availability,mandatory:true,category:'critical',preferences});
  assert.equal(mandatory.find(r=>r.channel==='sms').status,'pending');
});
