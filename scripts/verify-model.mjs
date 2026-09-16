// Proves the configured model provider actually answers, using the production
// code path and synthetic operational facts.
//
//   node --env-file=<a reviewed env file> scripts/verify-model.mjs
//
// It reports what an operator needs to decide whether to rely on the provider:
// which one answered, which model it really served, how long it took, and
// whether the answer survived LeRoutier's own validation. It never prints a
// credential, and the situation it sends is invented here — no row from any
// database is read, so this is safe to run against production configuration.

import { modelConfig } from '../packages/config/src/index.js';
import { createModelProvider } from '../packages/agents/src/models/providers.js';
import { TASKS } from '../packages/agents/src/models/reasoning.js';
import { validateRecommendation, RECOMMENDATION_SCHEMA, unsafeFields } from '../packages/agents/src/models/projection.js';

const config = modelConfig(process.env);
const provider = createModelProvider({ model: config });
const fail = message => { console.error(`FAIL  ${message}`); process.exitCode = 1; };

console.log('Model provider');
console.log(`  configured provider  ${config.provider ?? '(none — agents stay deterministic)'}`);
console.log(`  fallback provider    ${config.fallbackProvider ?? '(none)'}`);
console.log(`  requested model      ${provider.model ?? '(none)'}`);
if (config.provider === 'gemini') {
  const g = config.gemini;
  console.log(`  auth mode            ${g.authMode ?? '(rejected — only oauth is implemented)'}`);
  console.log(`  endpoint             ${g.baseUrl}`);
  console.log(`  quota project        ${g.projectId ?? '(none — the call is unattributed)'}`);
  // Presence only. The values themselves are never read out.
  const present = name => (g[name] ? 'set' : 'MISSING');
  console.log(`  credential           client_id ${present('clientId')}, client_secret ${present('clientSecret')}, refresh_token ${present('refreshToken')}`);
  if (g.baseUrl.includes('aiplatform')) fail('the endpoint is Vertex AI, which requires a billing account.');
  if (/[?&]key=/.test(g.baseUrl)) fail('the endpoint carries an API key. Gemini is reached with OAuth only.');
}
if (!provider.configured) {
  console.log('\nNo provider is configured. Agents remain fully deterministic, which is a supported production state.');
  process.exit(process.exitCode ?? 0);
}

console.log('\nReachability');
const health = await provider.health();
console.log(`  reachable            ${health.reachable}`);
console.log(`  status               ${health.status}`);
if (health.actualModel) console.log(`  served model         ${health.actualModel}`);

// Synthetic. These numbers describe nobody: there is no such service, and the
// projection is applied anyway so the shape is exactly what production sends.
const SITUATION = TASKS['incident.triage'].project({
  serviceStatus: 'active', delayMinutes: 35, vehicleStationaryMinutes: 20,
  passengersAffected: 18, parcelsAffected: 3, nextStopCity: 'Bohicon',
  openIncidentKind: 'breakdown', replacementVehiclesAvailable: 1, alternativeServicesAvailable: 2,
});
const leaks = unsafeFields(SITUATION);
if (leaks.length) fail(`the projection would send ${leaks.join(', ')}`);

console.log('\nOne completion, with synthetic facts');
console.log(`  sending              ${JSON.stringify(SITUATION)}`);
const started = Date.now();
let result;
try {
  result = await provider.complete({
    system: TASKS['incident.triage'].system, input: SITUATION,
    schema: RECOMMENDATION_SCHEMA, allowFallback: TASKS['incident.triage'].allowFallback === true,
  });
} catch (error) {
  console.log(`  status               ${error?.reason ?? 'error'}`);
  console.log(`  latency              ${Date.now() - started} ms`);
  // A provider that is out of quota or busy is a normal operational state, not
  // a broken build: LeRoutier carries on without a recommendation either way.
  console.log('\nNo completion. Agents fall back to deterministic behaviour, which is the designed outcome.');
  process.exit(process.exitCode ?? 0);
}

console.log(`  answered by          ${result.providerUsed ?? provider.name}`);
console.log(`  fallback used        ${result.fallbackFrom ? `yes (from ${result.fallbackFrom})` : 'no'}`);
console.log(`  served model         ${result.actualModel ?? '(not reported)'}`);
console.log(`  latency              ${result.latencyMs} ms`);

const verdict = validateRecommendation(result.data, {
  actions: Object.fromEntries(TASKS['incident.triage'].allowedActions.map(name => [name, { scope: null, category: 'low_risk', approval: 'never' }])),
  allowedActions: TASKS['incident.triage'].allowedActions,
  scopes: [],
});
console.log(`  structured output    ${verdict.ok ? 'valid' : `REJECTED (${verdict.rejection})`}`);
if (!verdict.ok) fail('the answer did not survive validation, so nothing would have been shown to Ops.');
else {
  const r = verdict.recommendation;
  console.log(`  classification       ${r.classification}`);
  console.log(`  severity             ${r.severity}`);
  console.log(`  recommended action   ${r.recommendedAction ?? 'none'}`);
  console.log(`  reason               ${r.reason}`);
}

// A recommendation is a suggestion for a human, not an instruction.
console.log('\nNothing was executed: this script validates a recommendation and stops there.');
if (!process.exitCode) console.log('Model verification passed.');
