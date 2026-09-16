/**
 * The identity slice, on its own.
 *
 * Extracted so a tool can inspect an auth configuration without also demanding
 * a database URL it has no use for — and so there is exactly one place that
 * turns these environment variables into configuration. Two parsers would
 * eventually disagree, and the one that disagreed would be the one deciding
 * whether sign-in works.
 */
export function authConfig(env = process.env) {
  return {
    demoLogin: env.ALLOW_DEMO_LOGIN === 'true' && !env.VERCEL && env.NODE_ENV !== 'production',
    issuer: env.AUTH_ISSUER, audience: env.AUTH_AUDIENCE, jwksUrl: env.AUTH_JWKS_URL,
    oidcClientId: env.OIDC_CLIENT_ID,
    oidcScope: env.OIDC_SCOPE || 'openid profile',
    oidcResource: env.OIDC_RESOURCE,
    oidcRedirectUris: (env.OIDC_REDIRECT_URIS || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

export function serverConfig(env = process.env) {
  const schema = env.DATABASE_SCHEMA || 'leroutier';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid database schema configuration.');
  if (!env.DATABASE_URL) throw new Error('Database configuration is missing.');
  return {
    databaseUrl: env.DATABASE_URL, schema,
    production: env.NODE_ENV === 'production' || env.VERCEL === '1',
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
 * Model provider configuration.
 *
 * `AGENT_MODEL_PROVIDER` selects; an unrecognised value selects nothing rather
 * than falling back to a remote provider. Sending a situation to a third party
 * because of a typo would be exactly the wrong default.
 */
export function modelConfig(env = process.env) {
  const provider = ['openrouter', 'local'].includes(env.AGENT_MODEL_PROVIDER) ? env.AGENT_MODEL_PROVIDER : null;
  // Bounds the whole completion, retry ladder included. Measured free-tier
  // latency runs from 2 s to 49 s, so this is the point at which LeRoutier
  // decides a recommendation is not coming and carries on without one.
  // Raise it only where the caller is a background worker, never a request.
  const timeoutMs = Number(env.AGENT_MODEL_TIMEOUT_MS) > 0 ? Number(env.AGENT_MODEL_TIMEOUT_MS) : 25_000;
  const positive = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  return {
    provider,
    openrouter: {
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      model: env.OPENROUTER_MODEL || 'openrouter/free',
      appName: env.OPENROUTER_APP_NAME || 'LeRoutier',
      appUrl: env.OPENROUTER_APP_URL || 'https://le-routier.vercel.app',
      timeoutMs,
    },
    local: {
      baseUrl: env.LOCAL_MODEL_BASE_URL || 'http://127.0.0.1:8000/v1',
      model: env.LOCAL_MODEL_NAME || 'minicpm',
      timeoutMs,
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

export function publicAuthConfig(config) {
  let oidc=null;
  try {
    if(config.issuer && config.jwksUrl && config.audience && config.oidcClientId && config.oidcRedirectUris?.length &&
      [config.issuer,config.jwksUrl,...config.oidcRedirectUris].every(value=>new URL(value).protocol==='https:')) {
      oidc={authority:config.issuer,clientId:config.oidcClientId,scope:config.oidcScope || 'openid profile',
        resource:config.oidcResource,redirectUris:config.oidcRedirectUris};
    }
  } catch { /* Incomplete or invalid production login configuration stays unavailable. */ }
  return {demoLogin:config.demoLogin,oidc};
}
