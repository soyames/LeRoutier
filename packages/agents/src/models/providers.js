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
    async complete({ system, input, schema = null, maxTokens = 400, temperature = 0 }) {
      if (!configured) throw new ModelUnavailable(MODEL_REASONS.notConfigured);
      const started = Date.now();
      const payload = {
        model,
        temperature,
        max_tokens: maxTokens,
        // The task input travels as JSON in a user message, never interpolated
        // into the system prompt: system policy and untrusted content stay in
        // separate turns so content cannot rewrite policy.
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(input) },
        ],
        // Ask for JSON. Not every free model honours a strict schema, so the
        // output is validated afterwards regardless of what was requested.
        response_format: schema
          ? { type: 'json_schema', json_schema: { name: 'recommendation', strict: true, schema } }
          : { type: 'json_object' },
      };

      let result;
      try {
        result = await call(payload);
      } catch (error) {
        // A model that cannot do strict schemas rejects the request outright.
        // Retry once in plain JSON mode rather than losing the capability.
        if (schema && error instanceof ModelUnavailable
          && [MODEL_REASONS.providerError, MODEL_REASONS.modelUnavailable].includes(error.reason)) {
          result = await call({ ...payload, response_format: { type: 'json_object' } });
        } else throw error;
      }

      const latencyMs = Date.now() - started;
      const content = result?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new ModelUnavailable(MODEL_REASONS.malformedOutput, 'no completion content');
      let data;
      try { data = JSON.parse(content); }
      catch { throw new ModelUnavailable(MODEL_REASONS.malformedOutput, 'completion was not JSON'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ModelUnavailable(MODEL_REASONS.malformedOutput, 'completion was not an object');

      // Free routing may substitute a model. An evaluation that does not know
      // which model answered is worth very little, so it is captured.
      return { data, actualModel: typeof result?.model === 'string' ? result.model : null, latencyMs };
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
