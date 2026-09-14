import pg from 'pg';
import { serverConfig } from '@leroutier/config';
import { DomainError } from '@leroutier/domain';

export function createDatabase(config = serverConfig()) {
  if(!/^[a-z][a-z0-9_]{0,62}$/.test(config.schema)) throw new Error('Invalid database schema configuration.');
  let connectionString;
  try {
    const url = new URL(config.databaseUrl);
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
    connectionString = url.toString();
  } catch { throw new Error('Invalid database configuration.'); }
  const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: true }, max: 5,
    connectionTimeoutMillis: 15_000, idleTimeoutMillis: 10_000 });
  // Never log raw driver errors: they can contain connection information.
  pool.on('error', () => {});
  return {
    schema: config.schema,
    async transaction(fn) {
      let client;
      try {
        client = await pool.connect();
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path TO "${config.schema}", public`);
        await client.query("SET LOCAL lock_timeout = '10s'");
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (error instanceof DomainError) throw error;
        const safe = new Error('Database operation failed.');
        Object.assign(safe, { code: /^[0-9A-Z]{5}$/.test(error?.code) ? error.code : 'DATABASE_ERROR' });
        throw safe;
      } finally { client?.release(); }
    },
    close: () => pool.end(),
  };
}
