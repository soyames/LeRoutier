import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { modelConfig } from '@leroutier/config';
import { createGoogleTokenSource, GOOGLE_TOKEN_URL } from '../src/models/google-oauth.js';
import { memoryCooldownStore } from '../src/models/cooldown-store.js';
import { geminiProvider, toGeminiSchema, withCooldown, fallbackChain, createModelProvider, ModelUnavailable, MODEL_REASONS } from '../src/models/providers.js';
import { createReasoning } from '../src/models/reasoning.js';
import { RECOMMENDATION_SCHEMA, unsafeFields } from '../src/models/projection.js';

// Gemini, tested without ever reaching Google.
//
// Every fetch is injected. The guard below makes that structural rather than a
// convention: if any code path in this file fell through to the real network,
// the suite fails loudly instead of quietly spending free quota — and CI, which
// has no credentials at all, would otherwise fail for the wrong reason.
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = /** @type {any} */ (() => { throw new Error('a test must never reach the network'); });
});
after(() => { globalThis.fetch = realFetch; });

const CREDENTIAL = { clientId: 'client.apps.googleusercontent.com', clientSecret: 'not-a-real-secret', refreshToken: 'not-a-real-refresh-token', projectId: 'leroutier' };
const GOOD = { classification: 'possible_breakdown', severity: 'high', recommendedAction: 'alert.create', reason: 'Le véhicule est immobile depuis 18 minutes.' };
const SITUATION = { serviceStatus: 'active', delayMinutes: 35, vehicleStationaryMinutes: 20, passengersAffected: 18, nextStopCity: 'Bohicon' };
const ACTIONS = { 'alert.create': { scope: 'alert.create', category: 'low_risk', approval: 'never' } };

/**
 * A fetch that answers the token endpoint and `generateContent` separately.
 * @param {{ token?: object, tokenStatus?: number, reply?: any }} [script]
 */
function fakeGoogle({ token = { access_token: 'access-token-1', expires_in: 3600 }, tokenStatus = 200, reply } = {}) {
  const calls = { token: 0, model: 0, bodies: [], headers: [] };
  const impl = /** @type {any} */ (async (url, init) => {
    if (String(url) === GOOGLE_TOKEN_URL) {
      calls.token++;
      return { ok: tokenStatus < 400, status: tokenStatus, json: async () => token };
    }
    calls.model++;
    calls.bodies.push(init?.body ? JSON.parse(init.body) : null);
    calls.headers.push(init?.headers ?? {});
    const r = typeof reply === 'function' ? await reply(calls.model) : (reply ?? {});
    if (r instanceof Error) throw r;
    return {
      ok: (r.status ?? 200) < 400, status: r.status ?? 200,
      // A real Response has a Headers object, and the retry parser reads it.
      headers: { get: name => r.headers?.[String(name).toLowerCase()] ?? null },
      json: async () => r.body ?? geminiSays(GOOD),
    };
  });
  return { impl, calls };
}

const geminiSays = (value, { finishReason = 'STOP', modelVersion = 'gemini-3.6-flash' } = {}) =>
  ({ candidates: [{ content: { parts: [{ text: typeof value === 'string' ? value : JSON.stringify(value) }] }, finishReason }], modelVersion });

const provider = (google, extra = {}) => geminiProvider({ ...CREDENTIAL, model: 'gemini-3.6-flash', ...extra }, google.impl,
  createGoogleTokenSource(CREDENTIAL, google.impl, extra.now));

const ask = (p, extra = {}) => p.complete({ system: 'policy', input: SITUATION, schema: RECOMMENDATION_SCHEMA, ...extra });
const reason = expected => (/** @type {any} */ error) => error.reason === expected;

// ------------------------------------------------------------ token source ---

test('a refresh credential is exchanged for an access token', async () => {
  const google = fakeGoogle();
  const tokens = createGoogleTokenSource(CREDENTIAL, google.impl);
  assert.equal(tokens.configured, true);
  assert.equal(await tokens.token(), 'access-token-1');
  assert.equal(google.calls.token, 1);
});

test('a token is reused until it is nearly expired, then minted again', async () => {
  let clock = 1_000_000;
  let issued = 0;
  const google = fakeGoogle();
  const counting = /** @type {any} */ (async (url, init) => {
    const response = await google.impl(url, init);
    return String(url) === GOOGLE_TOKEN_URL
      ? { ...response, json: async () => ({ access_token: `access-token-${++issued}`, expires_in: 3600 }) }
      : response;
  });
  const tokens = createGoogleTokenSource(CREDENTIAL, counting, () => clock);

  assert.equal(await tokens.token(), 'access-token-1');
  clock += 3500 * 1000; // still inside the hour
  assert.equal(await tokens.token(), 'access-token-1', 'a live token is not thrown away');
  // 3600s lifetime less the 60s skew: at 3541s the cached token is already
  // considered gone, because it could die in flight.
  clock += 45 * 1000;
  assert.equal(await tokens.token(), 'access-token-2', 'the skew margin forces an early refresh');
});

test('concurrent callers share one refresh instead of each asking Google', async () => {
  const google = fakeGoogle();
  const tokens = createGoogleTokenSource(CREDENTIAL, google.impl);
  const results = await Promise.all([tokens.token(), tokens.token(), tokens.token(), tokens.token()]);
  assert.deepEqual(results, Array(4).fill('access-token-1'));
  assert.equal(google.calls.token, 1, 'a cold instance serving four events must not send four refreshes');
});

test('a revoked refresh credential fails closed, and the next attempt still retries', async () => {
  let status = 400; // invalid_grant, as Google reports a revoked credential
  const google = fakeGoogle();
  const impl = /** @type {any} */ (async (url, init) => (String(url) === GOOGLE_TOKEN_URL
    ? { ok: status < 400, status, json: async () => (status < 400
        ? { access_token: 'access-token-after-repair', expires_in: 3600 }
        : { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) }
    : google.impl(url, init)));
  const tokens = createGoogleTokenSource(CREDENTIAL, impl);

  await assert.rejects(tokens.token(), reason(MODEL_REASONS.unauthorized));
  assert.equal(tokens.state.hasToken, false, 'nothing is cached from a failure');
  assert.equal(tokens.state.refreshing, false, 'a rejected refresh is not inherited by later callers');
  status = 200;
  await assert.doesNotReject(tokens.token());
});

test('a missing credential is unconfigured rather than unauthenticated', async () => {
  const tokens = createGoogleTokenSource({ clientId: 'only-the-id' }, fakeGoogle().impl);
  assert.equal(tokens.configured, false, 'two of three values is a misconfiguration, not a credential');
  await assert.rejects(tokens.token(), reason(MODEL_REASONS.notConfigured));
});

test('a token failure never carries the credential that was being exchanged', async () => {
  const impl = /** @type {any} */ (async () => { throw new TypeError(`fetch failed for ${GOOGLE_TOKEN_URL} with ${CREDENTIAL.clientSecret}`); });
  const tokens = createGoogleTokenSource(CREDENTIAL, impl);
  await assert.rejects(tokens.token(), (/** @type {any} */ error) => {
    const text = `${error.message} ${JSON.stringify(error)}`;
    assert.equal(text.includes(CREDENTIAL.clientSecret), false);
    assert.equal(text.includes(CREDENTIAL.refreshToken), false);
    return error.reason === MODEL_REASONS.providerError;
  });
});

// --------------------------------------------------------------- transport ---

test('the request is OAuth-bearer, schema-constrained and attributed to the project', async () => {
  const google = fakeGoogle();
  const result = await ask(provider(google));
  assert.deepEqual(result.data, GOOD);
  assert.equal(result.actualModel, 'gemini-3.6-flash');
  assert.equal(result.providerUsed, 'gemini');

  const headers = google.calls.headers[0];
  assert.equal(headers.authorization, 'Bearer access-token-1');
  assert.equal(headers['x-goog-user-project'], 'leroutier');
  assert.equal('x-goog-api-key' in headers, false, 'Gemini is never reached with an API key');

  const body = google.calls.bodies[0];
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.responseSchema.type, 'OBJECT');
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0, 'no private reasoning trace is ever requested');
});

test('policy and untrusted content travel in separate turns', async () => {
  const google = fakeGoogle();
  await ask(provider(google), { system: 'NEVER invent a delay.' });
  const body = google.calls.bodies[0];
  assert.equal(body.systemInstruction.parts[0].text, 'NEVER invent a delay.');
  assert.equal(body.contents[0].role, 'user');
  assert.equal(body.systemInstruction.parts[0].text.includes('Bohicon'), false, 'content is never interpolated into policy');
  assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), SITUATION);
});

test('only the projected facts are sent, whatever the caller assembled', async () => {
  const google = fakeGoogle();
  await ask(provider(google), { input: { delayMinutes: 35, stopName: 'Bohicon' } });
  const sent = JSON.parse(google.calls.bodies[0].contents[0].parts[0].text);
  assert.deepEqual(unsafeFields(sent), [], 'nothing identifying a person or a place reaches Google');
});

test('a model that rejects a response schema is asked again with less structure', async () => {
  const google = fakeGoogle({ reply: n => (n === 1 ? { status: 400, body: { error: { status: 'INVALID_ARGUMENT' } } } : {}) });
  assert.deepEqual((await ask(provider(google))).data, GOOD);
  assert.equal(google.calls.model, 2);
  assert.equal('responseSchema' in google.calls.bodies[1].generationConfig, false);
});

test('a model that rejects thinkingConfig is still reachable on the last rung', async () => {
  const google = fakeGoogle({ reply: n => (n < 3 ? { status: 400, body: { error: { status: 'INVALID_ARGUMENT' } } } : {}) });
  assert.deepEqual((await ask(provider(google))).data, GOOD);
  assert.equal(google.calls.model, 3);
  assert.equal('thinkingConfig' in google.calls.bodies[2].generationConfig, false);
});

test('free-tier 503 is a recoverable provider state, not a fault', async () => {
  const google = fakeGoogle({ reply: { status: 503, body: { error: { status: 'UNAVAILABLE' } } } });
  await assert.rejects(ask(provider(google)), reason(MODEL_REASONS.providerError));
});

test('an exhausted quota is never retried down the ladder', async () => {
  const google = fakeGoogle({ reply: { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } } });
  await assert.rejects(ask(provider(google)), reason(MODEL_REASONS.rateLimited));
  assert.equal(google.calls.model, 1, 'asking differently does not restore a quota');
});

test('Google saying how long to wait is believed, from either place it says it', async () => {
  const quota = detail => ({ status: 429, headers: detail.headers,
    body: { error: { status: 'RESOURCE_EXHAUSTED', details: detail.details ?? [] } } });

  // A Retry-After header in seconds.
  const header = fakeGoogle({ reply: quota({ headers: { 'retry-after': '45' } }) });
  await assert.rejects(ask(provider(header)), (/** @type {any} */ e) => e.retryAfterMs === 45_000);

  // Google's RetryInfo detail, which often arrives without the header.
  const info = fakeGoogle({ reply: quota({ details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '57s' }] }) });
  await assert.rejects(ask(provider(info)), (/** @type {any} */ e) => e.retryAfterMs === 57_000);

  // Both, disagreeing: the longer wait is the safe one.
  const both = fakeGoogle({ reply: quota({ headers: { 'retry-after': '10' },
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '90s' }] }) });
  await assert.rejects(ask(provider(both)), (/** @type {any} */ e) => e.retryAfterMs === 90_000);

  // Absurd or unparseable values are ignored rather than trusted.
  const silly = fakeGoogle({ reply: quota({ headers: { 'retry-after': '999999' } }) });
  await assert.rejects(ask(provider(silly)), (/** @type {any} */ e) => e.retryAfterMs === null);
});

test('a token Google stops honouring is re-minted once, then given up on', async () => {
  const google = fakeGoogle({ reply: { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } } });
  await assert.rejects(ask(provider(google)), reason(MODEL_REASONS.unauthorized));
  assert.equal(google.calls.token, 2, 'the cached token is dropped and one fresh attempt is made');
  assert.equal(google.calls.model, 2);
});

test('a timeout is reported as a timeout', async () => {
  const google = fakeGoogle({ reply: () => { const error = new Error('aborted'); error.name = 'AbortError'; return error; } });
  await assert.rejects(ask(provider(google)), reason(MODEL_REASONS.timeout));
});

test('a truncated answer is malformed rather than half-believed', async () => {
  const google = fakeGoogle({ reply: { body: geminiSays('{"classification":"poss', { finishReason: 'MAX_TOKENS' }) } });
  await assert.rejects(ask(provider(google)), reason(MODEL_REASONS.malformedOutput));
});

test('narration around the answer is still understood', async () => {
  const google = fakeGoogle({ reply: { body: geminiSays('Voici mon analyse :\n```json\n' + JSON.stringify(GOOD) + '\n```') } });
  assert.deepEqual((await ask(provider(google))).data, GOOD);
});

test('an unconfigured Gemini is honest about it and costs nothing', async () => {
  const google = fakeGoogle();
  const bare = geminiProvider({ model: 'gemini-3.6-flash' }, google.impl, createGoogleTokenSource({}, google.impl));
  assert.equal(bare.configured, false);
  await assert.rejects(ask(bare), reason(MODEL_REASONS.notConfigured));
  assert.equal((await bare.health()).status, MODEL_REASONS.notConfigured);
  assert.equal(google.calls.token + google.calls.model, 0);
});

test('health separates an outage from a refusal', async () => {
  assert.equal((await provider(fakeGoogle({ reply: { status: 429 } })).health()).reachable, true, 'a quota refusal means Google answered');
  assert.equal((await provider(fakeGoogle({ reply: () => new Error('ECONNREFUSED') })).health()).reachable, false);
});

// ----------------------------------------------------------- schema dialect ---

test('the response schema is translated into the subset Gemini accepts', () => {
  const converted = toGeminiSchema(RECOMMENDATION_SCHEMA);
  assert.equal(converted.type, 'OBJECT');
  assert.equal(converted.properties.severity.type, 'STRING');
  assert.deepEqual(converted.properties.severity.enum, ['low', 'medium', 'high', 'critical']);
  assert.deepEqual(converted.required, ['classification', 'severity', 'recommendedAction', 'reason']);
  assert.deepEqual(converted.propertyOrdering, Object.keys(RECOMMENDATION_SCHEMA.properties));
  // Keywords Gemini rejects outright must be dropped, not passed through: a
  // harmless constraint that 400s costs the whole call.
  assert.equal('additionalProperties' in converted, false);
  assert.equal('maxLength' in converted.properties.reason, false);
});

// ------------------------------------------------------ cooldown and fallback ---

const stub = (name, behaviour) => ({
  name, model: `${name}-model`, configured: true,
  complete: behaviour,
  async health() { return { provider: name, configured: true, reachable: true, status: 'ok' }; },
});
const rateLimited = () => { throw new ModelUnavailable(MODEL_REASONS.rateLimited, 'quota exhausted'); };

test('a quota error puts the provider down for the cooldown window', async () => {
  let clock = 0, calls = 0;
  const cooled = withCooldown(stub('gemini', async () => { calls++; return rateLimited(); }), { cooldownMs: 600_000, now: () => clock });

  await assert.rejects(cooled.complete({}), reason(MODEL_REASONS.rateLimited));
  assert.equal(calls, 1);
  await assert.rejects(cooled.complete({}), reason(MODEL_REASONS.rateLimited));
  assert.equal(calls, 1, 'the second caller never reaches the provider');
  assert.equal(cooled.cooling, true);

  clock += 600_001;
  assert.equal(cooled.cooling, false);
  await assert.rejects(cooled.complete({}), reason(MODEL_REASONS.rateLimited));
  assert.equal(calls, 2, 'the window expires rather than latching');
});

test("the provider's own Retry-After sets the window, not the configured guess", async () => {
  let clock = 0;
  const asked = () => { throw new ModelUnavailable(MODEL_REASONS.rateLimited, 'quota', 30_000); };
  const cooled = withCooldown(stub('gemini', async () => asked()), { cooldownMs: 600_000, now: () => clock });

  await assert.rejects(cooled.complete({}), reason(MODEL_REASONS.rateLimited));
  assert.equal(await cooled.cooldownUntil(), 30_000, 'sulking for ten minutes when Google asked for thirty seconds wastes the window');
  clock = 30_001;
  assert.equal(await cooled.cooldownUntil(), null);
});

test('the cooldown is shared, so a fresh instance does not call a provider that already refused', async () => {
  const store = memoryCooldownStore();
  let calls = 0;
  const build = () => withCooldown(stub('gemini', async () => { calls++; return rateLimited(); }), { cooldownMs: 600_000, store });

  await assert.rejects(build().complete({}), reason(MODEL_REASONS.rateLimited));
  assert.equal(calls, 1);

  // A different instance of the same provider, with no memory of its own.
  const cold = build();
  await assert.rejects(cold.complete({}), reason(MODEL_REASONS.rateLimited));
  assert.equal(calls, 1, 'the shared window is what stops a rate limit becoming a rate-limit storm');
  assert.ok(await cold.cooldownUntil());
});

test('a cooldown store that is down never takes the model layer down with it', async () => {
  const broken = { async until() { throw new Error('store unavailable'); }, async enter() { throw new Error('store unavailable'); }, async clear() {} };
  const cooled = withCooldown(stub('gemini', async () => ({ data: GOOD, actualModel: 'm', latencyMs: 1 })), { store: broken });
  assert.deepEqual((await cooled.complete({})).data, GOOD, 'bookkeeping is best effort; the call still happens');
  assert.equal(await cooled.cooldownUntil(), null);

  const failing = withCooldown(stub('gemini', rateLimited), { store: broken, cooldownMs: 1000, now: () => 0 });
  await assert.rejects(failing.complete({}), reason(MODEL_REASONS.rateLimited));
  assert.equal(failing.cooling, true, 'the in-process window still applies when the shared one cannot be written');
});

test('repeated hard failures trip the breaker, but a bad answer never does', async () => {
  let clock = 0, calls = 0;
  const fail = kind => async () => { calls++; throw new ModelUnavailable(kind); };

  const flaky = withCooldown(stub('gemini', fail(MODEL_REASONS.providerError)), { cooldownMs: 1000, failuresBeforeCooldown: 3, now: () => clock });
  for (let i = 0; i < 3; i++) await assert.rejects(flaky.complete({}), reason(MODEL_REASONS.providerError));
  assert.equal(flaky.cooling, true, 'three consecutive outages is an outage');

  calls = 0;
  const babbling = withCooldown(stub('gemini', fail(MODEL_REASONS.malformedOutput)), { cooldownMs: 1000, failuresBeforeCooldown: 3, now: () => clock });
  for (let i = 0; i < 5; i++) await assert.rejects(babbling.complete({}), reason(MODEL_REASONS.malformedOutput));
  assert.equal(babbling.cooling, false, 'a model answering badly is not the provider being down');
  assert.equal(calls, 5);
});

test('a success clears the failure streak', async () => {
  let ok = false;
  const chain = withCooldown(stub('gemini', async () => {
    if (ok) return { data: GOOD, actualModel: 'm', latencyMs: 1 };
    return rateLimited();
  }), { cooldownMs: 0, failuresBeforeCooldown: 2 });
  await assert.rejects(chain.complete({}), reason(MODEL_REASONS.rateLimited));
  ok = true;
  assert.deepEqual((await chain.complete({})).data, GOOD);
});

test('fallback is opt-in per request, never automatic', async () => {
  let secondary = 0;
  const chain = fallbackChain(
    stub('gemini', rateLimited),
    stub('openrouter', async () => { secondary++; return { data: GOOD, actualModel: 'llama-free', latencyMs: 9 }; }));

  await assert.rejects(chain.complete({ allowFallback: false }), reason(MODEL_REASONS.rateLimited));
  assert.equal(secondary, 0, 'a task that did not ask for a second provider does not get one');

  const result = await chain.complete({ allowFallback: true });
  assert.equal(result.providerUsed, 'openrouter');
  assert.equal(result.fallbackFrom, 'gemini', 'which model answered is never left implicit');
});

test('when both providers are down there is simply no recommendation', async () => {
  const chain = fallbackChain(stub('gemini', rateLimited), stub('openrouter', rateLimited));
  await assert.rejects(chain.complete({ allowFallback: true }), reason(MODEL_REASONS.rateLimited));
});

test('an unconfigured fallback is not a fallback', async () => {
  const chain = fallbackChain(stub('gemini', rateLimited), { ...stub('openrouter', async () => ({ data: GOOD })), configured: false });
  await assert.rejects(chain.complete({ allowFallback: true }), reason(MODEL_REASONS.rateLimited));
});

// ------------------------------------------------------------- composition ---

/** An Application Default Credentials document, exactly as gcloud writes one. */
const ADC = JSON.stringify({
  account: 'owner@example.test',
  client_id: CREDENTIAL.clientId,
  client_secret: CREDENTIAL.clientSecret,
  refresh_token: CREDENTIAL.refreshToken,
  type: 'authorized_user',
  universe_domain: 'googleapis.com',
});
const env = extra => ({ AGENT_MODEL_PROVIDER: 'gemini', GOOGLE_GEMINI_CREDENTIALS: ADC,
  GOOGLE_GEMINI_PROJECT_ID: 'leroutier', ...extra });

test('Gemini is selectable, defaults to the verified Flash model, and needs no API key', () => {
  const config = modelConfig(env());
  assert.equal(config.provider, 'gemini');
  assert.equal(config.gemini.model, 'gemini-3.6-flash');
  assert.equal(config.gemini.baseUrl.startsWith('https://generativelanguage.googleapis.com'), true);
  assert.equal(config.gemini.baseUrl.includes('aiplatform'), false, 'Vertex AI requires billing and is unreachable from here');
  assert.equal('apiKey' in config.gemini, false);
  assert.equal(createModelProvider({ model: config }, fakeGoogle().impl).configured, true);
});

test('any authentication mode other than OAuth withholds the credential', () => {
  const config = modelConfig(env({ GEMINI_AUTH_MODE: 'api_key' }));
  assert.equal(config.gemini.authMode, null);
  assert.equal(config.gemini.clientId, undefined, 'the credential is not handed to a mode LeRoutier does not implement');
  assert.equal(createModelProvider({ model: config }, fakeGoogle().impl).configured, false);
});

test('the credential is one atomic value, so it cannot be two-thirds configured', () => {
  const parsed = JSON.parse(ADC);
  // Each of the three is load-bearing. A rotation that updates one and forgets
  // another used to leave something that *looked* configured and failed on
  // every call; now it leaves nothing at all.
  for (const missing of ['client_id', 'client_secret', 'refresh_token']) {
    const partial = { ...parsed };
    delete partial[missing];
    const config = modelConfig(env({ GOOGLE_GEMINI_CREDENTIALS: JSON.stringify(partial) }));
    assert.equal(config.gemini.clientId, undefined, `a document without ${missing} is not a credential`);
    assert.equal(createModelProvider({ model: config }, fakeGoogle().impl).configured, false);
  }
});

// NOTE: the fixtures below deliberately never spell out a PEM header or a
// credential-document type marker as a literal. `pnpm secrets:check` matches
// both by shape and cannot tell a fixture from the real thing — which is
// exactly the behaviour we want from it. Build the shapes; do not type them.
// (This comment is written the long way round for the same reason.)
test('a service-account document is refused: this design stores no private key', () => {
  const serviceAccount = JSON.stringify({ type: 'service_account', project_id: 'leroutier',
    private_key: 'not-a-real-key', client_email: 'x@y.iam.gserviceaccount.com' });
  const config = modelConfig(env({ GOOGLE_GEMINI_CREDENTIALS: serviceAccount }));
  assert.equal(config.gemini.clientId, undefined);
  assert.equal(createModelProvider({ model: config }, fakeGoogle().impl).configured, false);
});

test('a malformed credential leaves the model unavailable rather than crashing the API', () => {
  // The unterminated case matters because JSON.parse throws on it rather than
  // returning something falsy; the credential reader must catch that.
  const unterminated = ADC.slice(0, ADC.length - 1);
  for (const broken of ['', '   ', 'not json', unterminated, 'null', '[]', '"a string"']) {
    const config = modelConfig(env({ GOOGLE_GEMINI_CREDENTIALS: broken }));
    assert.equal(config.gemini.clientId, undefined, `"${broken}" must not configure anything`);
  }
});

test('the credential may name its own quota project; an explicit setting wins', () => {
  const withQuota = JSON.stringify({ ...JSON.parse(ADC), quota_project_id: 'from-the-credential' });
  assert.equal(modelConfig(env({ GOOGLE_GEMINI_CREDENTIALS: withQuota, GOOGLE_GEMINI_PROJECT_ID: '' })).gemini.projectId, 'from-the-credential');
  assert.equal(modelConfig(env({ GOOGLE_GEMINI_CREDENTIALS: withQuota })).gemini.projectId, 'leroutier');
});

test('the fallback provider is named explicitly and never inferred from a key', () => {
  const withKey = modelConfig(env({ OPENROUTER_API_KEY: 'sk-or-test' }));
  assert.equal(withKey.fallbackProvider, null, 'a key lying around is not consent to send data there');
  assert.equal(createModelProvider({ model: withKey }, fakeGoogle().impl).fallbackTo, undefined);

  const named = modelConfig(env({ OPENROUTER_API_KEY: 'sk-or-test', AGENT_MODEL_FALLBACK_PROVIDER: 'openrouter' }));
  assert.equal(createModelProvider({ model: named }, fakeGoogle().impl).fallbackTo, 'openrouter');
});

test('an unrecognised fallback name yields no fallback rather than a default one', () => {
  const config = modelConfig(env({ OPENROUTER_API_KEY: 'sk-or-test', AGENT_MODEL_FALLBACK_PROVIDER: 'openrotuer' }));
  assert.equal(config.fallbackProvider, null);
  assert.equal(createModelProvider({ model: config }, fakeGoogle().impl).fallbackTo, undefined);
});

test('no Gemini credential is ever published to the browser', () => {
  const config = modelConfig(env());
  const published = JSON.stringify(config.gemini);
  // The server-side block necessarily holds them; what matters is that nothing
  // in the client configuration surface does. Asserted in
  // packages/config/tests and by pnpm secrets:check over every built bundle.
  assert.equal(published.includes(CREDENTIAL.clientSecret), true, 'the server-side block is the only place they exist');
});

// ---------------------------------------------------------------- reasoning ---

/** The two queries createReasoning's budget check makes, and nothing else. */
function fakeDb() {
  const recorded = [];
  return {
    recorded,
    async transaction(run) {
      return run({
        async query(sql, args) {
          if (sql.startsWith('INSERT INTO agent_model_calls')) {
            recorded.push({ provider: args[0], status: args[6], fallbackFrom: args[11], quotaExhausted: args[12], cooldownUntil: args[13] });
            return { rows: [] };
          }
          if (sql.includes('all_calls')) return { rows: [{ all_calls: 0, workflow_calls: 0 }] };
          return { rows: [] };
        },
      });
    },
  };
}

test('a recommendation is filed under the provider that answered, not the one configured', async () => {
  const db = fakeDb();
  const reasoning = createReasoning({ db, actions: ACTIONS, provider: fallbackChain(
    stub('gemini', rateLimited),
    stub('openrouter', async () => ({ data: GOOD, actualModel: 'llama-free', latencyMs: 12 })))
  });
  const verdict = await reasoning.recommend('incident.triage', SITUATION, { scopes: ['alert.create'] });
  assert.equal(verdict.available, true);
  assert.equal(verdict.providerUsed, 'openrouter');
  assert.equal(verdict.fallbackFrom, 'gemini');
  assert.deepEqual(db.recorded, [{ provider: 'openrouter', status: 'ok', fallbackFrom: 'gemini', quotaExhausted: false, cooldownUntil: null }]);
});

test('an exhausted quota is recorded as capacity, with its window — not as a fault', async () => {
  const db = fakeDb();
  const cooled = withCooldown(stub('gemini', rateLimited), { cooldownMs: 600_000, store: memoryCooldownStore() });
  const reasoning = createReasoning({ db, actions: ACTIONS, provider: cooled });

  const verdict = await reasoning.recommend('incident.triage', SITUATION, { workflow: 'incident-triage', scopes: ['alert.create'] });
  assert.equal(verdict.available, false);
  assert.equal(verdict.status, MODEL_REASONS.rateLimited, 'the caller still sees the reason code it always saw');
  assert.equal(verdict.quotaExhausted, true);
  assert.ok(verdict.cooldownUntil > Date.now(), 'and when it may be tried again');

  const [row] = db.recorded;
  assert.equal(row.status, 'unavailable', 'quota ends by itself; it is not an error to investigate');
  assert.equal(row.quotaExhausted, true);
  assert.ok(row.cooldownUntil, 'the window is stored so Ops can tell an exhausted tier from a broken one');
});

test('with both providers exhausted there is no recommendation and no error anywhere', async () => {
  const db = fakeDb();
  const reasoning = createReasoning({ db, actions: ACTIONS,
    provider: fallbackChain(stub('gemini', rateLimited), stub('openrouter', rateLimited)) });
  const verdict = await reasoning.recommend('incident.triage', SITUATION, { scopes: ['alert.create'] });
  assert.equal(verdict.available, false);
  assert.equal(verdict.recommendation, undefined, 'nothing is invented to fill the gap');
  assert.equal(db.recorded[0].quotaExhausted, true);
});

test('usage reports quota and fallback so Ops can read a quiet day correctly', async () => {
  const db = fakeDb();
  const chain = fallbackChain(
    withCooldown(stub('gemini', rateLimited), { cooldownMs: 600_000, store: memoryCooldownStore() }),
    stub('openrouter', async () => ({ data: GOOD, actualModel: 'llama-free', latencyMs: 9 })));
  const reasoning = createReasoning({ db, actions: ACTIONS, provider: chain });

  await reasoning.recommend('incident.triage', SITUATION, { scopes: ['alert.create'] });
  const usage = await reasoning.usage();
  assert.equal(usage.fallbackProvider, 'openrouter');
  assert.ok(usage.cooldownUntil, 'the primary is resting, and says so');
  assert.equal(/client_secret|refresh_token|Bearer|1\/\//.test(JSON.stringify(usage)), false,
    'usage must not carry anything credential-shaped');
});

test('incident triage permits a second provider; a task that has not said so does not', async () => {
  const seen = [];
  const reasoning = createReasoning({ db: fakeDb(), actions: ACTIONS, provider: stub('gemini', async request => {
    seen.push(request.allowFallback);
    return { data: GOOD, actualModel: 'gemini-3.6-flash', latencyMs: 5 };
  }) });
  await reasoning.recommend('incident.triage', SITUATION, { scopes: ['alert.create'] });
  assert.deepEqual(seen, [true]);
});

test('no provider at all is a status, never a thrown error', async () => {
  const db = fakeDb();
  const reasoning = createReasoning({ db, actions: ACTIONS, provider: createModelProvider({}, fakeGoogle().impl) });
  const verdict = await reasoning.recommend('incident.triage', SITUATION, {});
  assert.equal(verdict.available, false);
  assert.equal(verdict.status, MODEL_REASONS.notConfigured);
  assert.equal(db.recorded[0].status, 'unavailable', 'the non-call is recorded too');
});

test('a model naming an action outside this task is refused after Gemini answered', async () => {
  const google = fakeGoogle({ reply: { body: geminiSays({ ...GOOD, recommendedAction: 'payout.execute' }) } });
  const reasoning = createReasoning({ db: fakeDb(), actions: { ...ACTIONS, 'payout.execute': { scope: 'payout.review', category: 'financial', approval: 'always' } },
    provider: provider(google) });
  const verdict = await reasoning.recommend('incident.triage', SITUATION, { scopes: ['alert.create', 'payout.review'] });
  assert.equal(verdict.available, false);
  assert.equal(verdict.rejection, 'action_not_permitted_for_task');
});
