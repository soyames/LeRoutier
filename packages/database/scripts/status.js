import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '../src/index.js';

// Read-only inspection of whichever database the environment selects. Applies
// nothing and writes nothing: run it before a production migration to confirm
// the target, and after one to confirm the result. The connection string, host,
// database name and credentials are never printed — `target` is a stable hash
// so two runs can be compared without revealing either value.
const config = serverConfig();
const folder = new URL('../migrations/', import.meta.url);
const files = (await readdir(folder)).filter(f => /^\d+.*\.sql$/.test(f)).sort();
const declared = new Map();
for (const file of files) {
  const sql = await readFile(new URL(file, folder), 'utf8');
  declared.set(file, [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/gi)].map(m => m[1].toLowerCase()));
}
let target = 'unreadable';
try {
  const url = new URL(config.databaseUrl);
  target = createHash('sha256').update([url.username, url.host, url.pathname].join('|')).digest('hex').slice(0, 12);
} catch { /* createDatabase reports invalid configuration below. */ }

const db = createDatabase(config);
try {
  const state = await db.transaction(async tx => {
    const present = new Set((await tx.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema=$1', [config.schema])).rows.map(r => r.table_name));
    const applied = present.has('schema_migrations')
      ? new Set((await tx.query('SELECT name FROM schema_migrations')).rows.map(r => r.name)) : new Set();
    const demo = present.has('users')
      ? (await tx.query('SELECT count(*)::integer AS n FROM users WHERE is_demo=true')).rows[0].n : 0;
    return { present, applied, demo };
  });

  console.log(`Database status (read-only). target=${target} schema=${config.schema}`);
  let missingTables = 0;
  for (const file of files) {
    const absent = declared.get(file).filter(t => !state.present.has(t));
    missingTables += absent.length;
    const mark = state.applied.has(file) ? 'applied' : 'MISSING';
    const tables = declared.get(file).length ? ` tables ${declared.get(file).length - absent.length}/${declared.get(file).length}` : '';
    console.log(`  ${mark}  ${file}${tables}`);
  }
  const pending = files.filter(f => !state.applied.has(f));
  console.log(`Migrations: ${state.applied.size}/${files.length} applied; ${missingTables} declared table(s) absent.`);
  // Demo rows are the decisive signal that a target is the development database.
  console.log(state.demo > 0
    ? `Demo identities present (${state.demo}): this is a DEVELOPMENT database, never production.`
    : 'No demo identities: consistent with a production database.');
  if (pending.length) {
    console.log(`Pending: ${pending.join(', ')}`);
    process.exitCode = 1;
  } else if (missingTables) process.exitCode = 1;
} catch (error) {
  console.error('Database status failed.', /^[0-9A-Z]{5}$/.test(error?.code) ? error.code : '');
  process.exitCode = 1;
} finally { await db.close(); }
