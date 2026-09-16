import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';

// Proves the migration chain still works from nothing.
//
// Every long-lived database has been migrated incrementally, so it can pass
// while the chain itself is broken for a new environment — a fresh CI database,
// a new Docker volume, a replacement Neon project. This creates an empty
// disposable schema, runs every declared migration into it, replays them, and
// asserts the declared tables actually exist.
//
// It refuses to run anywhere but a disposable schema: the name is generated
// here and `dropDisposableSchema` only ever drops `lr_test_*`.
const schema = `lr_test_fresh_${randomUUID().replaceAll('-', '')}`;
const db = createDatabase({ ...serverConfig(), schema });

const folder = new URL('../migrations/', import.meta.url);
const files = (await readdir(folder)).filter(f => /^\d+.*\.sql$/.test(f)).sort();
const declared = new Map();
for (const file of files) {
  const sql = await readFile(new URL(file, folder), 'utf8');
  declared.set(file, [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/gi)].map(m => m[1].toLowerCase()));
}

const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };

try {
  console.log(`Fresh migration test — ${files.length} declared migrations into an empty schema.`);

  await migrate(db);
  const applied = new Set((await db.transaction(tx => tx.query('SELECT name FROM schema_migrations'))).rows.map(r => r.name));
  const present = new Set((await db.transaction(tx =>
    tx.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1', [schema]))).rows.map(r => r.table_name));

  for (const file of files) {
    check(applied.has(file), `${file} was not recorded as applied`);
    const absent = declared.get(file).filter(t => !present.has(t));
    check(absent.length === 0, `${file} declares ${absent.length} table(s) that do not exist: ${absent.join(', ')}`);
  }
  check(applied.size === files.length, `schema_migrations holds ${applied.size} rows for ${files.length} migrations`);

  // A second run must change nothing: forward-only migrations are re-run on
  // every deploy, and a chain that is not idempotent breaks the next one.
  // `migrate` returns the declared count either way, so idempotency is proven
  // by the rows themselves — an applied_at that moved means a re-execution.
  const stamps = tx => tx.query('SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name');
  const before = (await db.transaction(stamps)).rows;
  await migrate(db);
  const after = (await db.transaction(stamps)).rows;
  check(after.length === before.length, `replaying the chain changed the migration count ${before.length} → ${after.length}`);
  const moved = after.filter((row, i) => String(row.applied_at) !== String(before[i]?.applied_at)).map(r => r.name);
  check(moved.length === 0, `replaying re-executed ${moved.length} migration(s): ${moved.join(', ')}`);

  // Checksums are what stop an edited migration from silently diverging.
  check(after.every(r => typeof r.checksum === 'string' && r.checksum.length >= 32), 'a migration is recorded without a usable checksum');
  const drifted = after.filter((row, i) => row.checksum !== before[i]?.checksum).map(r => r.name);
  check(drifted.length === 0, `checksums changed across a replay: ${drifted.join(', ')}`);

  console.log(`  ${applied.size}/${files.length} applied, ${present.size} tables created, replay is a no-op.`);
} catch (error) {
  problems.push(`migration chain failed: ${error.message}`);
} finally {
  try { await dropDisposableSchema(db); } catch (error) { problems.push(`could not drop the disposable schema: ${error.message}`); }
  await db.close();
}

if (problems.length) {
  console.error(`Fresh migration test FAILED:\n  - ${problems.join('\n  - ')}`);
  process.exitCode = 1;
} else {
  console.log('Fresh migration test passed.');
}
