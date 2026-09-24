import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const folder = new URL('../migrations/', import.meta.url);
const checksumOf = sql => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

/**
 * Every migration this build of the code declares, with its checksum and the
 * schema objects it creates: tables, and columns it adds to existing tables.
 * Both are the artifacts whose absence means "the database is behind this
 * build" — an ALTER-based migration never creates a table, but a missing
 * column is exactly the undefined_column failure the readiness check exists
 * to catch (users.last_authenticated_at, 2026-09-22).
 *
 * Read from the deployed bundle, so it answers "what does the RUNNING code
 * expect" rather than "what is in the repository". That distinction is the
 * whole point: the outage this exists to catch was deployed code expecting a
 * schema the database did not have.
 */
export async function declaredMigrations() {
  const files = (await readdir(folder)).filter(f => /^\d+.*\.sql$/.test(f)).sort();
  return Promise.all(files.map(async name => {
    const sql = await readFile(new URL(name, folder), 'utf8');
    return {
      name,
      checksum: checksumOf(sql),
      tables: [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/gi)].map(m => m[1].toLowerCase()),
      columns: [...sql.matchAll(/ALTER TABLE\s+([a-z_]+)\s+ADD COLUMN(?: IF NOT EXISTS)?\s+([a-z_]+)/gi)]
        .map(m => ({ table: m[1].toLowerCase(), column: m[2].toLowerCase() })),
    };
  }));
}

export async function migrate(db) {
  const declared = await declaredMigrations();
  await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['leroutier-migrations-' + db.schema]);
    await tx.query(`CREATE SCHEMA IF NOT EXISTS "${db.schema}"`);
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const { name, checksum } of declared) {
      const { rows } = await tx.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (rows.length) {
        if (rows[0].checksum !== checksum) throw new Error('Applied migration checksum changed.');
        continue;
      }
      await tx.query(await readFile(new URL(name, folder), 'utf8'));
      await tx.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
    }
  });
  return declared.length;
}

/**
 * Whether the database this process is talking to matches the schema this
 * build of the code expects.
 *
 * ONE implementation, shared by the readiness endpoint, the Platform Ops
 * system screen and the status script. Two would eventually disagree, and the
 * disagreement would surface as "the dashboard said current" during the next
 * incident.
 *
 * The states, in the order they are decided:
 *
 *   unreachable  the database could not be queried at all
 *   drift        an applied migration's checksum no longer matches the file,
 *                or a declared table is absent. The schema is not what either
 *                side believes it is, and migrating will refuse.
 *   behind       migrations are declared that this database has not applied.
 *                This is the condition that produced the outage: the code
 *                queries a column that does not exist and every authenticated
 *                request fails while /health keeps answering 200.
 *   ahead        the database has migrations this build does not declare —
 *                normally a rollback. Usually harmless because migrations are
 *                additive, but never silent.
 *   current      applied and declared agree.
 *
 * Returns counts and names. Callers decide who may see the names: a count is
 * operational, a list of filenames describes unreleased work.
 */
export async function schemaStatus(db) {
  const declared = await declaredMigrations();
  try {
    const state = await db.transaction(async tx => {
      const present = new Set((await tx.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema=$1', [db.schema])).rows.map(r => r.table_name));
      const applied = present.has('schema_migrations')
        ? (await tx.query('SELECT name,checksum FROM schema_migrations')).rows
        : [];
      const columnRows = present.has('schema_migrations')
        ? (await tx.query('SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1', [db.schema])).rows
        : [];
      return { present, applied, columnRows };
    });

    const appliedByName = new Map(state.applied.map(r => [r.name, r.checksum]));
    const pending = declared.filter(m => !appliedByName.has(m.name)).map(m => m.name);
    const drifted = declared.filter(m => appliedByName.has(m.name) && appliedByName.get(m.name) !== m.checksum).map(m => m.name);
    const declaredNames = new Set(declared.map(m => m.name));
    const unknown = state.applied.map(r => r.name).filter(name => !declaredNames.has(name));
    const columns = new Map();
    for (const row of state.columnRows) {
      if (!columns.has(row.table_name)) columns.set(row.table_name, new Set());
      columns.get(row.table_name).add(row.column_name);
    }
    // Only migrations this database HAS applied are expected to have produced
    // their tables and columns. A pending migration's object being absent is
    // the pending migration, not separate damage.
    const missingTables = declared
      .filter(m => appliedByName.has(m.name))
      .flatMap(m => m.tables.filter(t => !state.present.has(t)));
    const missingColumns = declared
      .filter(m => appliedByName.has(m.name))
      .flatMap(m => m.columns.filter(c => !columns.get(c.table)?.has(c.column))
        .map(c => `${c.table}.${c.column}`));

    const status = drifted.length || missingTables.length || missingColumns.length ? 'drift'
      : pending.length ? 'behind'
        : unknown.length ? 'ahead'
          : 'current';

    return {
      status,
      reachable: true,
      counts: { declared: declared.length, applied: state.applied.length, pending: pending.length },
      pending, drifted, unknown, missingTables, missingColumns,
    };
  } catch {
    // Never the connection string, never the driver's message: this endpoint is
    // reachable without authentication.
    return {
      status: 'unreachable',
      reachable: false,
      counts: { declared: declared.length, applied: null, pending: null },
      pending: [], drifted: [], unknown: [], missingTables: [], missingColumns: [],
    };
  }
}
