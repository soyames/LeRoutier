export function serverConfig(env = process.env) {
  const schema = env.DATABASE_SCHEMA || 'leroutier';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid database schema configuration.');
  if (!env.DATABASE_URL) throw new Error('Database configuration is missing.');
  return {
    databaseUrl: env.DATABASE_URL, schema,
    production: env.NODE_ENV === 'production' || env.VERCEL === '1',
    demoLogin: env.ALLOW_DEMO_LOGIN === 'true' && !env.VERCEL && env.NODE_ENV !== 'production',
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    issuer: env.AUTH_ISSUER, audience: env.AUTH_AUDIENCE, jwksUrl: env.AUTH_JWKS_URL,
    oidcClientId: env.OIDC_CLIENT_ID,
    oidcScope: env.OIDC_SCOPE || 'openid profile',
    oidcResource: env.OIDC_RESOURCE,
    // Server-only payment configuration. FEDAPAY_ENVIRONMENT must be 'sandbox' or 'live';
    // production never falls back to sandbox. Payout credentials are modelled separately:
    // payouts stay unavailable when FEDAPAY_PAYOUT_SECRET_KEY is absent instead of reusing the
    // collection key. FEDAPAY_PUBLIC_KEY is only needed by client-side Checkout.js integrations
    // and is not required for the server-side redirect flow LeRoutier uses.
    paymentProvider:env.PAYMENT_PROVIDER,
    fedapay:{
      environment:env.FEDAPAY_ENVIRONMENT,
      secretKey:env.FEDAPAY_SECRET_KEY,
      payoutSecretKey:env.FEDAPAY_PAYOUT_SECRET_KEY,
      webhookSecret:env.FEDAPAY_WEBHOOK_SECRET,
      publicKey:env.FEDAPAY_PUBLIC_KEY,
      webhookUrl:env.FEDAPAY_WEBHOOK_URL,
    },
    // Driver payout withdrawals default to requiring Ops approval; set PAYOUT_APPROVAL_REQUIRED=false
    // only when a documented pre-approved policy exists.
    payoutApprovalRequired: env.PAYOUT_APPROVAL_REQUIRED !== 'false',
    payoutMinMinor: env.PAYOUT_MIN_MINOR !== undefined && env.PAYOUT_MIN_MINOR !== '' ? Number(env.PAYOUT_MIN_MINOR) : undefined,
    payoutMaxMinor: env.PAYOUT_MAX_MINOR !== undefined && env.PAYOUT_MAX_MINOR !== '' ? Number(env.PAYOUT_MAX_MINOR) : undefined,
    oidcRedirectUris: (env.OIDC_REDIRECT_URIS || '').split(',').map(s=>s.trim()).filter(Boolean),
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
