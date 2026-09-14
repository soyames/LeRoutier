export function serverConfig(env = process.env) {
  const schema = env.DATABASE_SCHEMA || 'leroutier';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid database schema configuration.');
  if (!env.DATABASE_URL) throw new Error('Database configuration is missing.');
  return {
    databaseUrl: env.DATABASE_URL, schema,
    demoLogin: env.ALLOW_DEMO_LOGIN === 'true' && !env.VERCEL && env.NODE_ENV !== 'production',
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    issuer: env.AUTH_ISSUER, audience: env.AUTH_AUDIENCE, jwksUrl: env.AUTH_JWKS_URL,
  };
}
