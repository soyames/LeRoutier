// Model providers, behind one interface.
//
// The rest of packages/agents knows only `complete({ system, input, schema })`
// and `health()`. It does not know which provider answered, and must keep
// working when none does — model assistance improves LeRoutier's operations, it
// is never a dependency of booking, payment, boarding, parcels or GPS.
//
// Everything here is server-side. No key, header or raw provider payload is
// ever returned to a caller or written to a log.

/** A provider failure that is safe to surface and to store. */
export class ModelUnavailable extends Error {
  constructor(reason, detail = '') {
    super(detail || reason);
    this.name = 'ModelUnavailable';
    this.reason = reason;
  }
}

export const MODEL_REASONS = {
  notConfigured: 'not_configured',
  timeout: 'timeout',
  rateLimited: 'rate_limited',
  unauthorized: 'unauthorized',
  providerError: 'provider_error',
  malformedOutput: 'malformed_output',
  modelUnavailable: 'model_unavailable',
};

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

/**
 * Selects the provider named by configuration.
 * An unrecognised name yields no provider rather than a default: silently
 * choosing a remote model for someone who asked for a local one would be the
 * worst possible failure mode of this function.
 */
export function createModelProvider(config = {}, fetchImpl = fetch) {
  const model = config.model ?? {};
  if (model.provider === 'openrouter') return openRouterProvider(model.openrouter ?? {}, fetchImpl);
  if (model.provider === 'local') return localProvider(model.local ?? {}, fetchImpl);
  return noProvider();
}
