import { createHash } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '../src/index.js';
import { declaredMigrations, schemaStatus } from '../src/migrations.js';

// Read-only inspection of whichever database the environment selects. Applies
// nothing and writes nothing: run it before a production migration to confirm
// the target, and after one to confirm the result. The connection string, host,
// database name and credentials are never printed — `target` is a stable hash
// so two runs can be compared without revealing either value.
//
// The comparison itself lives in schemaStatus(), shared with the readiness
// endpoint and the Platform Ops system screen. A second copy here would
// eventually disagree with the one production answers from, and the
// disagreement would surface mid-incident.
const config = serverConfig();
let target = 'unreadable';
try {
  const url = new URL(config.databaseUrl);
  target = createHash('sha256').update([url.username, url.host, url.pathname].join('|')).digest('hex').slice(0, 12);
} catch { /* createDatabase reports invalid configuration below. */ }

const db = createDatabase(config);
try {
  const [declared, status] = await Promise.all([declaredMigrations(), schemaStatus(db)]);
  const demo = status.reachable
    ? await db.transaction(async tx => {
      const present = (await tx.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='users'", [config.schema])).rows.length;
      return present ? (await tx.query('SELECT count(*)::integer AS n FROM users WHERE is_demo=true')).rows[0].n : 0;
    }).catch(() => 0)
    : 0;

  console.log(`Database status (read-only). target=${target} schema=${config.schema}`);
  const pending = new Set(status.pending), drifted = new Set(status.drifted);
  const missing = new Set(status.missingTables);
  for (const migration of declared) {
    const absent = migration.tables.filter(t => missing.has(t));
    const mark = drifted.has(migration.name) ? 'DRIFTED' : pending.has(migration.name) ? 'MISSING' : 'applied';
    const tables = migration.tables.length
      ? ` tables ${migration.tables.length - absent.length}/${migration.tables.length}` : '';
    console.log(`  ${mark}  ${migration.name}${tables}`);
  }
  console.log(`Migrations: ${status.counts.applied}/${status.counts.declared} applied; `
    + `${status.missingTables.length} declared table(s) absent. Schema is ${status.status}.`);
  // Demo rows are the decisive signal that a target is the development database.
  console.log(demo > 0
    ? `Demo identities present (${demo}): this is a DEVELOPMENT database, never production.`
    : 'No demo identities: consistent with a production database.');
  if (status.unknown.length) console.log(`Applied but not declared by this build: ${status.unknown.join(', ')}`);
  if (status.pending.length) console.log(`Pending: ${status.pending.join(', ')}`);
  if (status.drifted.length) console.log(`Checksum drift: ${status.drifted.join(', ')}`);
  if (status.status !== 'current' && status.status !== 'ahead') process.exitCode = 1;
} catch (error) {
  console.error('Database status failed.', /^[0-9A-Z]{5}$/.test(error?.code) ? error.code : '');
  process.exitCode = 1;
} finally { await db.close(); }
