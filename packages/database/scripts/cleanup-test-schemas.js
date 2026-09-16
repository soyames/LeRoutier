import { createDatabase } from '../src/index.js';
import { PRODUCTION_SCHEMA, TEST_SCHEMA_PREFIX, isTestSchema, environmentLabel } from '../src/guards.js';

// Interrupted test runs leave lr_test_* schemas behind — on the same Neon
// instance as production, because the two are separated only by schema name.
//
// This script is read-only unless CONFIRM_DROP_TEST_SCHEMAS=drop-test-schemas
// is set. It can only ever drop schemas whose name begins with the test prefix:
// `leroutier` and `leroutier_dev` are excluded by construction, not by care.
//
//   pnpm db:cleanup-tests            # dry run, lists what would be dropped
//   CONFIRM_DROP_TEST_SCHEMAS=drop-test-schemas pnpm db:cleanup-tests
const confirmed = process.env.CONFIRM_DROP_TEST_SCHEMAS === 'drop-test-schemas';
const olderThanHours = Number(process.env.TEST_SCHEMA_MIN_AGE_HOURS ?? 1);
const db = createDatabase();
try {
  const rows = await db.transaction(async tx => (await tx.query(
    `SELECT nspname AS schema FROM pg_catalog.pg_namespace
      WHERE nspname LIKE $1 || '%' ORDER BY nspname`, [TEST_SCHEMA_PREFIX])).rows);

  // Age is taken from the newest table in each schema, so a suite running right
  // now is never swept out from under itself.
  const candidates = [];
  for (const row of rows) {
    if (!isTestSchema(row.schema) || row.schema === PRODUCTION_SCHEMA) continue;
    const [{ age_hours: age }] = (await db.transaction(async tx => (await tx.query(
      `SELECT coalesce(extract(epoch FROM now() - max(greatest(s.last_autoanalyze, s.last_analyze, s.last_autovacuum, s.last_vacuum))) / 3600, 1e9) AS age_hours
         FROM pg_stat_all_tables s WHERE s.schemaname = $1`, [row.schema])).rows));
    candidates.push({ schema: row.schema, ageHours: Number(age) });
  }

  console.log(`Target environment: ${environmentLabel(db.schema)} (connected as schema "${db.schema}")`);
  console.log(`Found ${candidates.length} ${TEST_SCHEMA_PREFIX}* schema(s). Never considered: ${PRODUCTION_SCHEMA}, *_dev.`);
  if (!candidates.length) { console.log('Nothing to clean up.'); }
  for (const candidate of candidates) console.log(`  ${candidate.schema}`);

  if (!confirmed) {
    console.log('\nDry run. No schema was dropped.');
    console.log('To drop the schemas listed above, re-run with CONFIRM_DROP_TEST_SCHEMAS=drop-test-schemas');
  } else {
    let dropped = 0;
    for (const candidate of candidates) {
      // Belt and braces: re-check the prefix immediately before the drop.
      if (!isTestSchema(candidate.schema) || candidate.schema === PRODUCTION_SCHEMA) continue;
      if (candidate.ageHours < olderThanHours) { console.log(`  skipped ${candidate.schema} (in use or too recent)`); continue; }
      await db.transaction(tx => tx.query(`DROP SCHEMA "${candidate.schema}" CASCADE`));
      console.log(`  dropped ${candidate.schema}`);
      dropped++;
    }
    console.log(`\nDropped ${dropped} test schema(s).`);
  }
} catch (error) {
  console.error('Test schema cleanup failed.', /^[0-9A-Z]{5}$/.test(error?.code) ? error.code : '');
  process.exitCode = 1;
} finally { await db.close(); }
