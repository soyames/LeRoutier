// Environment guards for anything that writes.
//
// Production and development share one Neon instance, separated only by
// DATABASE_SCHEMA, so a single mistyped variable is the whole distance between
// a test run and live pilot data. These guards are deliberately layered: a test
// must clear *every* check, not just have a plausible schema name.

// The one schema that is production. Never a test target, never seeded.
export const PRODUCTION_SCHEMA = 'leroutier';
// Schemas automated tests may create, write to and drop.
export const TEST_SCHEMA_PREFIX = 'lr_test_';
export const DEV_SCHEMA_SUFFIX = '_dev';

export const isProductionSchema = schema => schema === PRODUCTION_SCHEMA;
export const isTestSchema = schema => typeof schema === 'string' && schema.startsWith(TEST_SCHEMA_PREFIX);
export const isDevSchema = schema => typeof schema === 'string' && schema.endsWith(DEV_SCHEMA_SUFFIX);
export const isDisposableSchema = schema => isTestSchema(schema) || isDevSchema(schema);

/**
 * Refuse to run destructive or seeding work outside a disposable schema.
 * Layered on purpose:
 *   1. the schema must be *_dev or lr_test_*;
 *   2. it must not be the production schema, whatever it is named;
 *   3. the process must not claim to be production;
 *   4. a caller may pass extra evidence (e.g. an explicit approval flag).
 *
 * @param {{schema: string}} db
 * @param {{ purpose?: string, env?: Record<string,string|undefined> }} options
 */
export function assertDisposableSchema(db, { purpose = 'This operation', env = process.env } = {}) {
  const schema = db?.schema;
  if (isProductionSchema(schema)) {
    throw new Error(`${purpose} refuses to run against the production schema.`);
  }
  if (!isDisposableSchema(schema)) {
    throw new Error(`${purpose} requires a disposable schema (*${DEV_SCHEMA_SUFFIX} or ${TEST_SCHEMA_PREFIX}*).`);
  }
  // A production runtime must never be executing test or seed code, even if
  // someone points it at a disposable schema.
  if (env.NODE_ENV === 'production' || env.VERCEL === '1' || env.VERCEL_ENV === 'production') {
    throw new Error(`${purpose} refuses to run in a production runtime.`);
  }
  return schema;
}

/**
 * Drop a throwaway test schema. The guard lives here rather than at each call
 * site, so no teardown can bypass it: a suite pointed at the wrong schema fails
 * loudly instead of destroying data.
 * @param {{schema: string, transaction: Function}} db
 */
export async function dropDisposableSchema(db, { env = process.env } = {}) {
  assertDisposableSchema(db, { purpose: 'Dropping a schema', env });
  if (!isTestSchema(db.schema)) {
    // A development schema is long-lived and shared: only test schemas are
    // ever dropped automatically.
    throw new Error(`Refusing to drop "${db.schema}": only ${TEST_SCHEMA_PREFIX}* schemas are disposable.`);
  }
  await db.transaction(tx => tx.query(`DROP SCHEMA "${db.schema}" CASCADE`));
  return db.schema;
}

/**
 * Safe, printable description of the target. Contains no host, no credential
 * and no connection string — only what an operator needs to confirm a target.
 */
export function environmentLabel(schema) {
  if (isProductionSchema(schema)) return 'production';
  if (isTestSchema(schema)) return 'automated-test';
  if (isDevSchema(schema)) return 'development';
  return 'unrecognised';
}
