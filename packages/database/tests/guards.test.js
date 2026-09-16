import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDisposableSchema, dropDisposableSchema, environmentLabel,
  isProductionSchema, isTestSchema, isDevSchema } from '../src/guards.js';

// Production and development share one Neon instance, separated only by schema.
// These guards are the whole distance between a test run and live pilot data,
// so they are tested as carefully as the domain itself.
const dev = { schema: 'leroutier_dev' };
const testSchema = { schema: 'lr_test_abc123' };
const production = { schema: 'leroutier' };

test('the production schema is never disposable',()=>{
  assert.equal(isProductionSchema('leroutier'),true);
  assert.equal(isTestSchema('leroutier'),false);
  assert.equal(isDevSchema('leroutier'),false);
  assert.throws(()=>assertDisposableSchema(production,{env:{}}),/production schema/);
});

test('only *_dev and lr_test_* schemas are accepted',()=>{
  assert.equal(assertDisposableSchema(dev,{env:{}}),'leroutier_dev');
  assert.equal(assertDisposableSchema(testSchema,{env:{}}),'lr_test_abc123');
  // A plausible-looking name is not enough.
  for (const schema of ['leroutier_prod','public','leroutier2','lr_test','dev']) {
    assert.throws(()=>assertDisposableSchema({schema},{env:{}}),/disposable schema/,schema);
  }
});

test('a production runtime is refused even with a disposable schema',()=>{
  for (const env of [{NODE_ENV:'production'},{VERCEL:'1'},{VERCEL_ENV:'production'}]) {
    assert.throws(()=>assertDisposableSchema(testSchema,{env}),/production runtime/,JSON.stringify(env));
  }
  // The same schema is fine outside a production runtime.
  assert.doesNotThrow(()=>assertDisposableSchema(testSchema,{env:{NODE_ENV:'test'}}));
});

test('dropping a schema refuses anything that is not a test schema',async()=>{
  const dropped=[];
  const fake=schema=>({schema,transaction:async fn=>fn({query:async sql=>{dropped.push(sql);return {rows:[]};}})});
  await assert.rejects(dropDisposableSchema(fake('leroutier'),{env:{}}),/production schema/);
  // A development schema is long-lived and shared: never dropped automatically.
  await assert.rejects(dropDisposableSchema(fake('leroutier_dev'),{env:{}}),/only lr_test_\* schemas are disposable/);
  await assert.rejects(dropDisposableSchema(fake('public'),{env:{}}),/disposable schema/);
  assert.deepEqual(dropped,[],'nothing was dropped by a refused call');
  // The one accepted case really does drop.
  assert.equal(await dropDisposableSchema(fake('lr_test_ok'),{env:{}}),'lr_test_ok');
  assert.equal(dropped.length,1);
  assert.match(dropped[0],/DROP SCHEMA "lr_test_ok" CASCADE/);
});

test('the environment label is safe to print',()=>{
  assert.equal(environmentLabel('leroutier'),'production');
  assert.equal(environmentLabel('leroutier_dev'),'development');
  assert.equal(environmentLabel('lr_test_x'),'automated-test');
  assert.equal(environmentLabel('something'),'unrecognised');
  // It never carries a host, credential or connection string.
  for (const schema of ['leroutier','leroutier_dev','lr_test_x']) {
    assert.equal(/@|:\/\/|password/i.test(environmentLabel(schema)),false);
  }
});
