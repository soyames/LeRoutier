import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function migrate(db) {
  const folder = new URL('../migrations/', import.meta.url);
  const files = (await readdir(folder)).filter(f => /^\d+.*\.sql$/.test(f)).sort();
  await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['leroutier-migrations-' + db.schema]);
    await tx.query(`CREATE SCHEMA IF NOT EXISTS "${db.schema}"`);
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files) {
      const sql = await readFile(new URL(file, folder), 'utf8');
      const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      const { rows } = await tx.query('SELECT checksum FROM schema_migrations WHERE name=$1', [file]);
      if (rows.length) {
        if (rows[0].checksum !== checksum) throw new Error('Applied migration checksum changed.');
        continue;
      }
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [file, checksum]);
    }
  });
  return files.length;
}
