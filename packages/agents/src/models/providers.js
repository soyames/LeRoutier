// Model providers, behind one interface.
//
// The rest of packages/agents knows only `complete({ system, input, schema })`
// and `health()`. It does not know which provider answered, and must keep
// working when none does — model assistance improves LeRoutier's operations, it
// is never a dependency of booking, payment, boarding, parcels or GPS.
//
// Everything here is server-side. No key, header or raw provider payload is
// ever returned to a caller or written to a log.

import { ModelUnavailable, MODEL_REASONS } from './errors.js';
import { createGoogleTokenSource } from './google-oauth.js';

// Re-exported so every caller keeps one import for "the model layer".
export { ModelUnavailable, MODEL_REASONS };

/**
 * Pulls the JSON object out of a completion.
 *
 * Reasoning models routinely narrate before answering, and some wrap the answer
 * in a code fence. Asking them not to is a request, not a guarantee — so the
 * first balanced object in the text is extracted rather than assuming the whole
 * string parses. Scanning for balance (rather than a greedy regex) is what
 * makes a brace inside a string value survive.
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* narration around it, most likely */ }

  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/** HTTP status → a reason code that says something useful without the body. */
function reasonForStatus(status) {
  if (status === 401 || status === 403) return MODEL_REASONS.unauthorized;
  if (status === 404) return MODEL_REASONS.modelUnavailable;
  if (status === 429) return MODEL_REASONS.rateLimited;
  return MODEL_REASONS.providerError;
}

/**
 * Both shipped providers speak the OpenAI chat-completions shape, so the
 * transport is written once. OpenRouter is that API with two extra attribution
 * headers; a local MiniCPM server is that API with no auth.
 */
function openAiCompatible({ name, baseUrl, apiKey, model, timeoutMs, headers = {}, fetchImpl = fetch }) {
  const configured = Boolean(baseUrl && model && (name === 'local' || apiKey));

  async function call(body, { timeout = timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      // An abort is a timeout; anything else is the network. Neither message is
      // propagated, because a fetch error can carry the URL and its headers.
      throw new ModelUnavailable(error?.name === 'AbortError' ? MODEL_REASONS.timeout : MODEL_REASONS.providerError);
    } finally { clearTimeout(timer); }

    if (!response.ok) throw new ModelUnavailable(reasonForStatus(response.status), `provider responded ${response.status}`);
    try { return await response.json(); }
    catch { throw new ModelUnavailable(MODEL_REASONS.malformedOutput, 'provider response was not JSON'); }
  }

  return {
    name,
    model,
    configured,

    /**
     * One structured completion.
     * @param {{ system: string, input: unknown, schema?: object|null,
     *   maxTokens?: number, temperature?: number }} request
     * @returns {Promise<{ data: object, actualModel: string|null, latencyMs: number }>}
     */
    async complete({ system, input, schema = null, maxTokens = 1200, temperature = 0 }) {
      if (!configured) throw new ModelUnavailable(MODEL_REASONS.notConfigured);
      const started = Date.now();
      const base = {
        model,
        temperature,
        // Generous, because a free router may serve a *reasoning* model that
        // narrates before answering. Too small a budget truncates the answer
        // mid-object and looks exactly like a malformed model.
        max_tokens: maxTokens,
        // Ask for as little chain-of-thought as possible, and to be spared it
        // in the response. Both are requests the provider may ignore, which is
        // why extractJson exists rather than this being the whole answer.
        reasoning: { effort: 'low', exclude: true },
        // The task input travels as JSON in a user message, never interpolated
        // into the system prompt: system policy and untrusted content stay in
        // separate turns so content cannot rewrite policy.
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(input) },
        ],
      };

      // A ladder, not a single attempt. "openrouter/free" routes to a different
      // model per request, and they do not agree on what they support: strict
      // schemas draw an empty 200 from some, a plain JSON hint works on others,
      // and a few only behave with no format constraint at all. Verified
      // against the live free tier rather than assumed.
      const formats = schema
        ? [{ type: 'json_schema', json_schema: { name: 'recommendation', strict: true, schema } }, { type: 'json_object' }, null]
        : [{ type: 'json_object' }, null];

      // One deadline for the whole operation, not one per attempt. A three-rung
      // ladder with a 20 s timeout each is a 60 s call, and measured free-tier
      // latency runs from 2 s to 49 s — enough to outlive any serverless
      // budget. The caller waits `timeoutMs`, whatever the ladder does inside.
      const deadline = started + timeoutMs;
      const remaining = () => deadline - Date.now();

      let lastReason = MODEL_REASONS.malformedOutput;
      for (const responseFormat of formats) {
        if (remaining() <= 0) throw new ModelUnavailable(MODEL_REASONS.timeout, 'deadline reached before a usable answer');
        let result;
        try {
          result = await call(responseFormat ? { ...base, response_format: responseFormat } : base, { timeout: remaining() });
        } catch (error) {
          lastReason = error instanceof ModelUnavailable ? error.reason : MODEL_REASONS.providerError;
          // A refusal of *this request shape* is worth retrying differently; a
          // bad key, a rate limit or a timeout is not.
          if ([MODEL_REASONS.unauthorized, MODEL_REASONS.rateLimited, MODEL_REASONS.timeout].includes(lastReason)) throw error;
          continue;
        }
        const data = extractJson(result?.choices?.[0]?.message?.content);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          // Free routing may substitute a model. An evaluation that does not
          // know which model answered is worth very little, so it is captured.
          return { data, actualModel: typeof result?.model === 'string' ? result.model : null, latencyMs: Date.now() - started };
        }
        lastReason = MODEL_REASONS.malformedOutput;
      }
      throw new ModelUnavailable(lastReason, 'no usable structured output');
    },

    /**
     * Is the provider configured, reachable and accepting our credentials?
     * Deliberately minimal — it costs one tiny completion.
     */
    async health() {
      const base = { provider: name, configured, requestedModel: model ?? null };
      if (!configured) return { ...base, reachable: false, status: MODEL_REASONS.notConfigured };
      try {
        const started = Date.now();
        const result = await call({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }, { timeout: Math.min(timeoutMs, 10_000) });
        return { ...base, reachable: true, status: 'ok', actualModel: typeof result?.model === 'string' ? result.model : null, latencyMs: Date.now() - started };
      } catch (error) {
        // Reachable but refusing is different from unreachable, and Ops needs
        // to be able to tell an expired key from an outage.
        const refused = [MODEL_REASONS.unauthorized, MODEL_REASONS.rateLimited, MODEL_REASONS.modelUnavailable].includes(error.reason);
        return { ...base, reachable: refused, status: error.reason ?? MODEL_REASONS.providerError };
      }
    },
  };
}

/** OpenRouter: OpenAI-compatible, with the attribution headers it asks for. */
export const openRouterProvider = (config, fetchImpl) => openAiCompatible({
  name: 'openrouter',
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  model: config.model,
  timeoutMs: config.timeoutMs,
  headers: {
    // Required by OpenRouter for attribution. Neither carries a secret.
    'http-referer': config.appUrl,
    'x-title': config.appName,
  },
  fetchImpl,
});

/**
 * A locally-run MiniCPM (or any OpenAI-compatible local server).
 * Kept because a local model is the only way to evaluate a task on data that
 * must not leave the machine — and because a remote provider going away should
 * never be the end of the capability.
 */
export const localProvider = (config, fetchImpl) => openAiCompatible({
  name: 'local',
  baseUrl: config.baseUrl,
  apiKey: null,
  model: config.model,
  timeoutMs: config.timeoutMs,
  fetchImpl,
});

/** A provider that is honestly absent, so callers need no null checks. */
export const noProvider = () => ({
  name: 'none', model: null, configured: false,
  async complete() { throw new ModelUnavailable(MODEL_REASONS.notConfigured); },
  async health() { return { provider: 'none', configured: false, reachable: false, requestedModel: null, status: MODEL_REASONS.notConfigured }; },
});

// ------------------------------------------------------------------ gemini ---

/** JSON Schema type names → the OpenAPI subset `responseSchema` accepts. */
const GEMINI_TYPES = { object: 'OBJECT', string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN', array: 'ARRAY' };

/**
 * Rewrites a JSON Schema into Gemini's `responseSchema` dialect.
 *
 * It is a narrow subset: types are upper-case, and keywords it does not know —
 * `additionalProperties`, `maxLength` — are rejected outright rather than
 * ignored, which turns a harmless constraint into a 400. Dropping them costs
 * nothing, because validateRecommendation enforces length and shape again on
 * the way back in, where the guarantee actually has to hold.
 *
 * `propertyOrdering` is supplied because Google documents response quality as
 * sensitive to field order; without it the order is unspecified.
 */
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return null;
  const type = GEMINI_TYPES[schema.type];
  if (!type) return null;
  const out = { type };
  if (typeof schema.description === 'string') out.description = schema.description;
  if (Array.isArray(schema.enum) && schema.enum.length) out.enum = schema.enum.map(String);
  if (type === 'ARRAY') out.items = toGeminiSchema(schema.items) ?? { type: 'STRING' };
  if (type === 'OBJECT' && schema.properties && typeof schema.properties === 'object') {
    const properties = {};
    for (const [key, child] of Object.entries(schema.properties)) {
      const converted = toGeminiSchema(child);
      if (converted) properties[key] = converted;
    }
    out.properties = properties;
    const names = Object.keys(properties);
    if (names.length) out.propertyOrdering = names;
    const required = Array.isArray(schema.required) ? schema.required.filter(name => names.includes(name)) : [];
    if (required.length) out.required = required;
  }
  return out;
}

/** Pulls the text out of a `generateContent` response, whatever it is split into. */
const geminiText = payload => (payload?.candidates?.[0]?.content?.parts ?? [])
  .map(part => (typeof part?.text === 'string' ? part.text : '')).join('');

/**
 * Google Gemini, through the Developer API (`generativelanguage.googleapis.com`)
 * with an OAuth bearer token.
 *
 * Not Vertex AI, which is a different host and needs a billing account; not an
 * AI Studio API key, which is a permanent bearer secret. This host serves the
 * free tier of the Gemini Developer API on a project with billing disabled,
 * which is the only tier LeRoutier is permitted to use.
 */
export function geminiProvider(config = {}, fetchImpl = fetch, tokenSource = null) {
  const baseUrl = (config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const model = config.model;
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 25_000;
  const tokens = tokenSource ?? createGoogleTokenSource(config, fetchImpl);
  const configured = Boolean(model && baseUrl && tokens.configured);

  async function call(body, { timeout }) {
    // Two attempts at most, and the second only for a token Google has stopped
    // honouring: revocation and key rotation both look like a 401 on a token
    // that was valid when it was minted.
    for (let attempt = 0; attempt < 2; attempt++) {
      const accessToken = await tokens.token();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${accessToken}`,
            // The documented quota-attribution header for a user OAuth
            // credential. Without it Google cannot tell which project's free
            // allowance this call belongs to.
            ...(config.projectId ? { 'x-goog-user-project': config.projectId } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        throw new ModelUnavailable(error?.name === 'AbortError' ? MODEL_REASONS.timeout : MODEL_REASONS.providerError);
      } finally { clearTimeout(timer); }

      if (response.status === 401 && attempt === 0) { tokens.forget(); continue; }
      if (!response.ok) {
        // 503 UNAVAILABLE is routine on the free tier — shared capacity, not a
        // fault — so it is a provider error the ladder and the fallback may act
        // on, never something that stops the product.
        throw new ModelUnavailable(reasonForStatus(response.status), `provider responded ${response.status}`);
      }
      try { return await response.json(); }
      catch { throw new ModelUnavailable(MODEL_REASONS.malformedOutput, 'provider response was not JSON'); }
    }
    throw new ModelUnavailable(MODEL_REASONS.unauthorized, 'Google refused a freshly minted token');
  }

  return {
    name: 'gemini',
    model: model ?? null,
    configured,

    async complete({ system, input, schema = null, maxTokens = 1200, temperature = 0 }) {
      if (!configured) throw new ModelUnavailable(MODEL_REASONS.notConfigured);
      const started = Date.now();
      const base = {
        // Policy and task data stay in separate turns: the system instruction
        // is never interpolated with content, so content cannot rewrite policy.
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
      };
      const generationConfig = { temperature, maxOutputTokens: maxTokens, responseMimeType: 'application/json' };
      // Thinking is switched off rather than hidden. LeRoutier must not receive
      // a private reasoning trace it is not allowed to store, and triage does
      // not need one — measured at 0 thought tokens and ~1.7 s on Flash.
      const noThinking = { thinkingConfig: { thinkingBudget: 0 } };
      const geminiSchema = schema ? toGeminiSchema(schema) : null;

      // A ladder, for reasons observed against the live free tier rather than
      // assumed: some models reject a response schema, and some reject
      // thinkingConfig outright with 400 INVALID_ARGUMENT. Each rung asks for
      // less, and the last rung is what every Flash model accepts.
      const rungs = [
        ...(geminiSchema ? [{ ...generationConfig, ...noThinking, responseSchema: geminiSchema }] : []),
        { ...generationConfig, ...noThinking },
        generationConfig,
      ];

      // One deadline for the whole operation, not one per rung.
      const deadline = started + timeoutMs;
      const remaining = () => deadline - Date.now();

      let lastReason = MODEL_REASONS.malformedOutput;
      for (const rung of rungs) {
        if (remaining() <= 0) throw new ModelUnavailable(MODEL_REASONS.timeout, 'deadline reached before a usable answer');
        let payload;
        try {
          payload = await call({ ...base, generationConfig: rung }, { timeout: remaining() });
        } catch (error) {
          lastReason = error instanceof ModelUnavailable ? error.reason : MODEL_REASONS.providerError;
          // A refusal of this request *shape* is worth asking differently. A
          // bad credential, an exhausted quota or a timeout is not.
          if ([MODEL_REASONS.unauthorized, MODEL_REASONS.rateLimited, MODEL_REASONS.timeout].includes(lastReason)) throw error;
          continue;
        }
        // A truncated answer parses as nothing useful and must not be retried
        // in the same shape: ask for less structure instead.
        const finish = payload?.candidates?.[0]?.finishReason;
        const data = finish === 'MAX_TOKENS' ? null : extractJson(geminiText(payload));
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          return {
            data,
            actualModel: typeof payload?.modelVersion === 'string' ? payload.modelVersion : null,
            latencyMs: Date.now() - started,
            providerUsed: 'gemini',
          };
        }
        lastReason = MODEL_REASONS.malformedOutput;
      }
      throw new ModelUnavailable(lastReason, 'no usable structured output');
    },

    async health() {
      const base = { provider: 'gemini', configured, requestedModel: model ?? null };
      if (!configured) return { ...base, reachable: false, status: MODEL_REASONS.notConfigured };
      const started = Date.now();
      try {
        const payload = await call({
          contents: [{ role: 'user', parts: [{ text: 'ok' }] }],
          generationConfig: { maxOutputTokens: 8, temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
        }, { timeout: Math.min(timeoutMs, 10_000) });
        return { ...base, reachable: true, status: 'ok', actualModel: payload?.modelVersion ?? null, latencyMs: Date.now() - started };
      } catch (error) {
        const refused = [MODEL_REASONS.unauthorized, MODEL_REASONS.rateLimited, MODEL_REASONS.modelUnavailable].includes(error.reason);
        return { ...base, reachable: refused, status: error.reason ?? MODEL_REASONS.providerError };
      }
    },
  };
}

// ------------------------------------------------- resilience and selection ---

/**
 * Stops asking a provider that has just said no.
 *
 * Free capacity is shared: a quota error means "not for a while", and retrying
 * into it burns the next window as well. Repeated hard failures get the same
 * treatment, because a provider that has failed three times in a row is having
 * an outage, not an unlucky request.
 *
 * The window lives in memory, so it is per serverless instance rather than
 * global. That is the honest limit of doing this without another shared store,
 * and it still removes the retry storm inside a single instance, which is where
 * one event fanning out to several workflows actually produces it.
 */
export function withCooldown(provider, { cooldownMs = 10 * 60_000, failuresBeforeCooldown = 3, now = Date.now } = {}) {
  let until = 0;
  let consecutiveFailures = 0;

  const enter = reason => {
    until = now() + cooldownMs;
    consecutiveFailures = 0;
    return reason;
  };

  return {
    ...provider,
    get cooling() { return now() < until; },
    async complete(request) {
      if (now() < until) throw new ModelUnavailable(MODEL_REASONS.rateLimited, 'provider is in cooldown after a quota or repeated failure');
      try {
        const result = await provider.complete(request);
        consecutiveFailures = 0;
        return result;
      } catch (error) {
        const reason = error instanceof ModelUnavailable ? error.reason : MODEL_REASONS.providerError;
        // A quota error is definitive; a malformed answer is the model's fault,
        // not the provider's, and must not take the provider offline.
        if (reason === MODEL_REASONS.rateLimited) enter(reason);
        else if (reason !== MODEL_REASONS.malformedOutput && ++consecutiveFailures >= failuresBeforeCooldown) enter(reason);
        throw error;
      }
    },
  };
}

/**
 * A primary provider with a named second chance.
 *
 * Fallback is **per request and opt-in**, never automatic. A caller asks for it
 * by passing `allowFallback: true`, and only tasks whose worst outcome is a
 * missing suggestion ever do. Nothing financial, nothing authoritative: the
 * point of a second provider is that Ops still gets a hint when the first one
 * is out of quota, not that a decision gets made by whoever answers.
 */
export function fallbackChain(primary, secondary) {
  return {
    name: primary.name,
    model: primary.model,
    configured: primary.configured || secondary.configured,
    fallbackTo: secondary.name,
    async complete(request) {
      try {
        return await primary.complete(request);
      } catch (error) {
        if (request?.allowFallback !== true || !secondary.configured) throw error;
        if (!(error instanceof ModelUnavailable)) throw error;
        const result = await secondary.complete(request);
        // Recorded, because a recommendation is worth less when it came from
        // the model nobody evaluated.
        return { ...result, providerUsed: secondary.name, fallbackFrom: primary.name };
      }
    },
    async health() {
      const [first, second] = await Promise.all([primary.health(), secondary.health()]);
      return { ...first, fallback: second };
    },
  };
}

/**
 * Selects the provider named by configuration.
 * An unrecognised name yields no provider rather than a default: silently
 * choosing a remote model for someone who asked for a local one would be the
 * worst possible failure mode of this function.
 */
export function createModelProvider(config = {}, fetchImpl = fetch) {
  const model = config.model ?? {};
  const build = name => {
    if (name === 'gemini') return withCooldown(geminiProvider(model.gemini ?? {}, fetchImpl), model.cooldown);
    if (name === 'openrouter') return withCooldown(openRouterProvider(model.openrouter ?? {}, fetchImpl), model.cooldown);
    // A local server is not a shared resource, so it gets no cooldown.
    if (name === 'local') return localProvider(model.local ?? {}, fetchImpl);
    return null;
  };
  const primary = build(model.provider);
  if (!primary) return noProvider();
  // The fallback is named explicitly and never inferred. Reaching for a second
  // third party because the first one was busy is a decision about where data
  // goes, and configuration is where that decision belongs.
  const secondary = model.fallbackProvider && model.fallbackProvider !== model.provider ? build(model.fallbackProvider) : null;
  return secondary?.configured ? fallbackChain(primary, secondary) : primary;
}
