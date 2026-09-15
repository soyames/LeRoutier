export function serverConfig(env = process.env) {
  const schema = env.DATABASE_SCHEMA || 'leroutier';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid database schema configuration.');
  if (!env.DATABASE_URL) throw new Error('Database configuration is missing.');
  return {
    databaseUrl: env.DATABASE_URL, schema,
    demoLogin: env.ALLOW_DEMO_LOGIN === 'true' && !env.VERCEL && env.NODE_ENV !== 'production',
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    issuer: env.AUTH_ISSUER, audience: env.AUTH_AUDIENCE, jwksUrl: env.AUTH_JWKS_URL,
    oidcClientId: env.OIDC_CLIENT_ID,
    oidcScope: env.OIDC_SCOPE || 'openid profile',
    oidcResource: env.OIDC_RESOURCE,
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
