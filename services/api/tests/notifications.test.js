import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notify, CHANNELS } from '@leroutier/notifications';

test('notification channels are typed and validated',async()=>{
  assert.deepEqual(CHANNELS,['in_app','sms','whatsapp','email']);
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
