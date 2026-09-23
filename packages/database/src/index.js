import pg from 'pg';
import { serverConfig } from '@leroutier/config';
import { DomainError } from '@leroutier/domain';

export function createDatabase(config = serverConfig()) {
  if(!/^[a-z][a-z0-9_]{0,62}$/.test(config.schema)) throw new Error('Invalid database schema configuration.');
  let connectionString, loopback;
  // The try covers PARSING ONLY, and deliberately so. It used to wrap the
  // disposable-schema guard below as well, which meant that guard's message
  // was caught by this very catch and reported as "Invalid database
  // configuration" — sending whoever hit it to look at a connection string
  // that was perfectly fine. A refusal has to say which rule it is enforcing.
  try {
    const url = new URL(config.databaseUrl);
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
    connectionString = url.toString();
    // A database reached over a network is always TLS-verified. A container on
    // this machine, addressed by loopback, has no network segment to intercept
    // and does not speak TLS at all — so the local development database works
    // without weakening anything remote. The test is the host, not a flag, so
    // no environment variable can turn verification off for Neon.
    loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  } catch {
    throw new Error(config.databaseUrl
      ? 'Invalid database configuration: DATABASE_URL is not a valid connection URL.'
      : 'Invalid database configuration: DATABASE_URL is not set.');
  }
  // Names the schema it refused and what to do, because the fix is almost
  // always "you meant the other schema" rather than anything about the URL.
  if (/^(lr_test_)|_dev$/.test(config.schema) && !loopback) {
    throw new Error(`Refusing to use the disposable schema "${config.schema}" on a remote database. `
      + 'Schemas named lr_test_* or *_dev are for the local container only. '
      + 'Set DATABASE_SCHEMA to the real schema, or point DATABASE_URL at loopback PostgreSQL.');
  }
  const pool = new pg.Pool({ connectionString, ssl: loopback ? false : { rejectUnauthorized: true }, max: 5,
    connectionTimeoutMillis: 15_000, idleTimeoutMillis: 10_000 });
  // Never log raw driver errors: they can contain connection information.
  pool.on('error', () => {});
  return {
    schema: config.schema,
    poolStats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: 5 }),
    async transaction(fn) {
      let client;
      for (let attempt = 1; ; attempt++) {
        try {
          client = await pool.connect();
          await client.query('BEGIN');
          await client.query(`SET LOCAL search_path TO "${config.schema}", public`);
          await client.query("SET LOCAL lock_timeout = '10s'");
          await client.query("SET LOCAL statement_timeout = '30s'");
          const result = await fn(client);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          if (client) await client.query('ROLLBACK').catch(() => {});
          // Transient deadlocks are retried: every transaction in this system is
          // atomic and idempotent by design, so re-running is always safe.
          if (error?.code === '40P01' && attempt < 3) continue;
          if (error instanceof DomainError) throw error;
          const safe = new Error('Database operation failed.');
          Object.assign(safe, { code: /^[0-9A-Z]{5}$/.test(error?.code) ? error.code : 'DATABASE_ERROR' });
          throw safe;
        } finally { client?.release(); }
      }
    },
    close: () => pool.end(),
  };
}
