/**
 * The identity slice, on its own.
 *
 * Extracted so a tool can inspect an auth configuration without also demanding
 * a database URL it has no use for — and so there is exactly one place that
 * turns these environment variables into configuration. Two parsers would
 * eventually disagree, and the one that disagreed would be the one deciding
 * whether sign-in works.
 */
/**
 * Google's public keys for Firebase ID tokens. Fixed by Firebase's design, the
 * same for every project on earth, and therefore a constant rather than a
 * setting — one fewer value anybody can mistype.
 */
export const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

export function authConfig(env = process.env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  return {
    demoLogin: env.ALLOW_DEMO_LOGIN === 'true' && !env.VERCEL && env.NODE_ENV !== 'production',
    firebaseProjectId: projectId,
    // Issuer, audience and key set are **derived** from the project id, never
    // entered by hand. Firebase fixes all three, and a mistyped issuer or
    // audience is exactly the mistake that makes a verifier accept another
    // project's tokens. One variable cannot disagree with itself.
    issuer: projectId ? `https://securetoken.google.com/${projectId}` : undefined,
    audience: projectId,
    jwksUrl: projectId ? FIREBASE_JWKS_URL : undefined,
    // The browser-facing Firebase identifiers. Public by design — they appear
    // in every Firebase web app's source — but served at runtime rather than
    // built in, so rotating them is an API change and not a rebuild.
    firebaseWeb: {
      apiKey: env.FIREBASE_API_KEY,
      authDomain: env.FIREBASE_AUTH_DOMAIN,
      projectId,
      appId: env.FIREBASE_APP_ID,
    },
  };
}

export function serverConfig(env = process.env) {
  const schema = env.DATABASE_SCHEMA || 'leroutier';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid database schema configuration.');
  if (!env.DATABASE_URL) throw new Error('Database configuration is missing.');
  return {
    databaseUrl: env.DATABASE_URL, schema,
    production: env.NODE_ENV === 'production' || env.VERCEL === '1',
    // Destructive retention execution is opt-in; the default scan is a dry run.
    retentionExecute: env.RETENTION_EXECUTE === 'true',
    // Synthetic TEST transport inventory. When false (production default),
    // test offers are only reachable by designated is_demo test identities.
    // Local development, CI and previews may set ALLOW_TEST_INVENTORY=true.
    allowTestInventory: env.ALLOW_TEST_INVENTORY === 'true' && env.NODE_ENV !== 'production' && env.VERCEL !== '1' && env.VERCEL_ENV !== 'production',
    ...authConfig(env),
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    // Server-only payment configuration. FEDAPAY_ENVIRONMENT must be 'sandbox' or 'live';
    // production never falls back to sandbox. Payout credentials are modelled separately:
    // payouts stay unavailable when FEDAPAY_PAYOUT_SECRET_KEY is absent instead of reusing the
    // collection key. FEDAPAY_PUBLIC_KEY is NOT required: LeRoutier uses the server-side
    // redirect flow (transaction + token), never the client-side Checkout.js integration.
    paymentProvider:env.PAYMENT_PROVIDER,
    fedapay:{
      environment:env.FEDAPAY_ENVIRONMENT,
      secretKey:env.FEDAPAY_SECRET_KEY,
      payoutSecretKey:env.FEDAPAY_PAYOUT_SECRET_KEY,
      webhookSecret:env.FEDAPAY_WEBHOOK_SECRET,
      webhookUrl:env.FEDAPAY_WEBHOOK_URL,
    },
    // Driver payout withdrawals default to requiring Ops approval; set PAYOUT_APPROVAL_REQUIRED=false
    // only when a documented pre-approved policy exists.
    payoutApprovalRequired: env.PAYOUT_APPROVAL_REQUIRED !== 'false',
    payoutMinMinor: env.PAYOUT_MIN_MINOR !== undefined && env.PAYOUT_MIN_MINOR !== '' ? Number(env.PAYOUT_MIN_MINOR) : undefined,
    payoutMaxMinor: env.PAYOUT_MAX_MINOR !== undefined && env.PAYOUT_MAX_MINOR !== '' ? Number(env.PAYOUT_MAX_MINOR) : undefined,
    // Outbound notification providers. None is invented: a channel is only
    // available when its real credentials are present, and stays unavailable
    // otherwise rather than silently dropping or faking a delivery.
    notificationProviders: {
      sms: env.SMS_PROVIDER_URL && env.SMS_PROVIDER_KEY ? {url:env.SMS_PROVIDER_URL.trim(),key:env.SMS_PROVIDER_KEY.trim()} : null,
      whatsapp: env.WHATSAPP_PROVIDER_URL && env.WHATSAPP_PROVIDER_KEY ? {url:env.WHATSAPP_PROVIDER_URL.trim(),key:env.WHATSAPP_PROVIDER_KEY.trim()} : null,
      email: env.EMAIL_PROVIDER_URL && env.EMAIL_PROVIDER_KEY ? {url:env.EMAIL_PROVIDER_URL.trim(),key:env.EMAIL_PROVIDER_KEY.trim()} : null,
      webPushPublicKey: env.WEB_PUSH_PUBLIC_KEY, webPushPrivateKey: env.WEB_PUSH_PRIVATE_KEY,
    },
    // First-mile timing policy: one configurable default, documented in
    // docs/product/FIRST_LAST_MILE.md, instead of buffers invented per screen.
    firstMile: firstMilePolicy(env),
    // How long a collectable parcel may wait before the receiver is reminded,
    // and then before the station is asked to act. Operators differ; neither
    // threshold is invented in code.
    parcelPickup: {
      reminderHours: positiveMinutes(env.PARCEL_UNCOLLECTED_REMINDER_HOURS, 24),
      escalationHours: positiveMinutes(env.PARCEL_UNCOLLECTED_ESCALATION_HOURS, 72),
    },
    // Per-workflow autonomy. Unfamiliar and high-risk workflows default to
    // recommending rather than acting; see AGENTIC_WORKFLOWS.md.
    agentAutonomy: agentAutonomy(env),
    // Model-assisted reasoning. Server-side only: none of these may ever be
    // prefixed VITE_ or reach a browser bundle. An unset provider means agents
    // stay entirely deterministic, which is a supported production state.
    model: modelConfig(env),
    // USSD channel. Server-side only. An unrecognised provider selects no
    // adapter rather than the sandbox one, so a typo cannot turn the webhook
    // into an unverified open endpoint.
    ussd: {
      provider: env.USSD_PROVIDER || null,
      apiKey: env.USSD_API_KEY,
      webhookSecret: env.USSD_WEBHOOK_SECRET,
      sessionTtlSeconds: positiveSeconds(env.USSD_SESSION_TTL_SECONDS, 180),
      defaultLocale: env.USSD_DEFAULT_LOCALE || 'fr',
      // Whether an MSISDN from a verified callback may be treated as the
      // caller's identity. Opt-in, because only the gateway's own terms can
      // justify it — and even then, USSD reuses an existing account and never
      // creates one. See docs/architecture/USSD.md.
      trustProviderMsisdn: env.USSD_TRUST_PROVIDER_MSISDN === 'true',
    },
    // Road routing engine. Unset means routes simply have no road geometry and
    // every surface says so — a straight line is never substituted. The public
    // OSRM/Valhalla demo servers forbid production use, so no default endpoint
    // ships: point ROUTING_URL at an engine you are entitled to use.
    routing: {
      url: env.ROUTING_URL, provider: env.ROUTING_PROVIDER || 'osrm',
      apiKey: env.ROUTING_API_KEY,
      timeoutMs: Number(env.ROUTING_TIMEOUT_MS) > 0 ? Number(env.ROUTING_TIMEOUT_MS) : 15_000,
    },
  };
}

function positiveMinutes(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 600 ? parsed : fallback;
}

/** A USSD session outlives a few screens, never a day. */
function positiveSeconds(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 30 && parsed <= 3600 ? parsed : fallback;
}

/**
 * Autonomy levels, in increasing order of what an agent may do without a human.
 *
 *   observe            — read and record what it would do; mutate nothing.
 *   recommend          — every mutating step becomes an approval request.
 *   auto_low_risk      — read and low-risk steps run; privileged and financial
 *                        steps still wait for a human.
 *   approval_required  — every step waits for a human, including reads.
 *
 * Deliberately not a single global switch: "turn autonomy on" is exactly the
 * decision that should never be made once, for everything, in one place.
 */
export const AUTONOMY_LEVELS = ['observe', 'recommend', 'auto_low_risk', 'approval_required'];

export function agentAutonomy(env = process.env) {
  // An unrecognised level is treated as the safest one rather than ignored: a
  // typo in configuration must never widen what an agent may do.
  const level = value => (AUTONOMY_LEVELS.includes(value) ? value : null);
  const fallback = level(env.AGENT_AUTONOMY_DEFAULT) ?? 'auto_low_risk';
  let perWorkflow = {};
  try {
    const parsed = env.AGENT_AUTONOMY ? JSON.parse(env.AGENT_AUTONOMY) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [workflow, value] of Object.entries(parsed)) {
        // An unknown value pins that workflow to observe — the safest level —
        // rather than silently inheriting a permissive default.
        perWorkflow[workflow] = level(value) ?? 'observe';
      }
    }
  } catch { perWorkflow = {}; }
  return { default: fallback, workflows: perWorkflow };
}

/**
 * Every provider LeRoutier can be pointed at, in the order they are preferred
 * when someone has to choose one: Gemini Flash is the primary remote model,
 * OpenRouter is the second chance, a local server is for data that must not
 * leave the machine. None of them is required for the product to work.
 */
export const PROVIDERS = ['gemini', 'openrouter', 'local'];

/**
 * A Google Application Default Credentials document, as one value.
 *
 * The credential is stored whole rather than split into three variables. Three
 * parts can be two-thirds configured — a rotation that updates the secret and
 * forgets the refresh token leaves something that looks configured and fails on
 * every call. A single JSON value is atomic: it is either the credential or it
 * is nothing.
 *
 * Only `authorized_user` is accepted. A `service_account` document here would
 * mean a private key sitting in an environment variable, which is precisely the
 * shape this design exists to avoid.
 *
 * Never throws. It is called while the API is being constructed, where a
 * malformed value must leave the model unavailable, not stop the server.
 */
export function googleCredential(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || parsed.type !== 'authorized_user') return {};
  const { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken } = parsed;
  if (!clientId || !clientSecret || !refreshToken) return {};
  return { clientId, clientSecret, refreshToken, quotaProjectId: parsed.quota_project_id };
}

/**
 * Model provider configuration.
 *
 * `AGENT_MODEL_PROVIDER` selects; an unrecognised value selects nothing rather
 * than falling back to a remote provider. Sending a situation to a third party
 * because of a typo would be exactly the wrong default.
 */
export function modelConfig(env = process.env) {
  const named = name => (PROVIDERS.includes(name) ? name : null);
  const provider = named(env.AGENT_MODEL_PROVIDER);
  // A second chance for low-risk tasks only, and only when named. Falling back
  // to another third party because the first was busy is a decision about where
  // a situation is sent, so it is never inferred from a key being present.
  const fallbackProvider = named(env.AGENT_MODEL_FALLBACK_PROVIDER);
  const oauthGemini = !env.GEMINI_AUTH_MODE || env.GEMINI_AUTH_MODE === 'oauth';
  const adc = oauthGemini ? googleCredential(env.GOOGLE_GEMINI_CREDENTIALS) : {};
  // Bounds the whole completion, retry ladder included. Measured free-tier
  // latency runs from 2 s to 49 s, so this is the point at which LeRoutier
  // decides a recommendation is not coming and carries on without one.
  // Raise it only where the caller is a background worker, never a request.
  const timeoutMs = Number(env.AGENT_MODEL_TIMEOUT_MS) > 0 ? Number(env.AGENT_MODEL_TIMEOUT_MS) : 25_000;
  const positive = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  return {
    provider,
    fallbackProvider,
    // Google Gemini through the Developer API, authenticated with OAuth.
    //
    // There is deliberately no API-key path. `generativelanguage.googleapis.com`
    // serves the free tier on a project with billing disabled; Vertex AI is a
    // different host that requires a billing account and is not reachable from
    // this configuration at all.
    gemini: {
      // OAuth is the only authentication LeRoutier implements for Gemini, so
      // GEMINI_AUTH_MODE exists to be checked rather than to be chosen: any
      // other value withholds the credential and leaves the provider
      // unconfigured. Someone who sets it to `api_key` should get no model, not
      // a silently different trust model.
      clientId: adc.clientId,
      clientSecret: adc.clientSecret,
      refreshToken: adc.refreshToken,
      authMode: oauthGemini ? 'oauth' : null,
      // Quota attribution for a user OAuth credential. Google cannot tell which
      // project's free allowance a call belongs to without it. The credential
      // may name its own; an explicit setting wins.
      projectId: env.GOOGLE_GEMINI_PROJECT_ID || adc.quotaProjectId,
      baseUrl: env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
      // Verified against the free tier on 2026-09-16: available on every
      // attempt, ~1.7 s median, strict JSON every time, and the model Google's
      // own retirement notice for gemini-2.5-flash points to.
      model: env.GEMINI_MODEL || 'gemini-3.6-flash',
      timeoutMs,
    },
    openrouter: {
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      model: env.OPENROUTER_MODEL || 'openrouter/free',
      appName: env.OPENROUTER_APP_NAME || 'LeRoutier',
      appUrl: env.OPENROUTER_APP_URL || 'https://leroutier.app',
      timeoutMs,
    },
    local: {
      baseUrl: env.LOCAL_MODEL_BASE_URL || 'http://127.0.0.1:8000/v1',
      model: env.LOCAL_MODEL_NAME || 'minicpm',
      timeoutMs,
    },
    // The deterministic gate in front of the one workflow that asks a model
    // anything. "How late is late" is an operator's judgement, so it is
    // configuration; the defaults are a starting point for the pilot, not a
    // finding. Below these, an incident is handled deterministically and no
    // remote call is made at all.
    triage: {
      minDelayMinutes: positive(env.AGENT_TRIAGE_MIN_DELAY_MINUTES, 15),
      minStationaryMinutes: positive(env.AGENT_TRIAGE_MIN_STATIONARY_MINUTES, 10),
    },
    // How long a provider is left alone after it says no. A quota error means
    // "not for a while": retrying into it spends the next window too.
    cooldown: {
      cooldownMs: positive(env.AGENT_MODEL_COOLDOWN_MINUTES, 10) * 60_000,
      failuresBeforeCooldown: positive(env.AGENT_MODEL_FAILURES_BEFORE_COOLDOWN, 3),
    },
    // Free capacity is shared and exhaustible. These are hard ceilings, not
    // guidance: a runaway workflow must hit a wall, not a warning.
    budget: {
      dailyCalls: positive(env.AGENT_MODEL_DAILY_CALLS, 200),
      perWorkflowDailyCalls: positive(env.AGENT_MODEL_WORKFLOW_DAILY_CALLS, 50),
      suppressDuplicatesHours: positive(env.AGENT_MODEL_DEDUP_HOURS, 6),
    },
  };
}

export function firstMilePolicy(env = process.env) {
  return {
    boardingOpensMinutes: positiveMinutes(env.FIRST_MILE_BOARDING_OPENS_MINUTES, 20),
    recommendedArrivalMinutes: positiveMinutes(env.FIRST_MILE_ARRIVE_BY_MINUTES, 15),
    boardingClosesMinutes: positiveMinutes(env.FIRST_MILE_BOARDING_CLOSES_MINUTES, 5),
    safetyBufferMinutes: positiveMinutes(env.FIRST_MILE_SAFETY_BUFFER_MINUTES, 10),
    defaultLocalTravelMinutes: positiveMinutes(env.FIRST_MILE_DEFAULT_TRAVEL_MINUTES, 25),
  };
}

/**
 * What the browser is told about signing in.
 *
 * Only the four Firebase web identifiers, which are public by design, and the
 * providers that are actually offered. No server-side value, no key material,
 * and nothing derived from a service account has any business here.
 *
 * Incomplete configuration publishes `firebase: null` rather than something
 * half-working: a sign-in button that cannot finish is worse than no button,
 * because the user only discovers it after committing to the attempt.
 */
export function publicAuthConfig(config) {
  const web = config.firebaseWeb ?? {};
  const complete = Boolean(config.firebaseProjectId && web.apiKey && web.authDomain && web.appId);
  return {
    demoLogin: config.demoLogin,
    firebase: complete
      ? {
        apiKey: web.apiKey, authDomain: web.authDomain,
        projectId: web.projectId, appId: web.appId,
        // Identity and basic profile only. Nothing here asks for Gmail,
        // Drive, Calendar or Contacts, and the privacy policy says so.
        providers: ['google'],
      }
      : null,
  };
}
