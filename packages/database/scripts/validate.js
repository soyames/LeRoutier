import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
const db=createDatabase();
try {
  await migrate(db);
  await migrate(db);
  const result=await db.transaction(tx=>tx.query(`SELECT count(*)::integer AS invalid FROM bookings b WHERE
    (b.status IN ('held','confirmed','boarded') AND (SELECT count(*) FROM booking_segments bs WHERE bs.booking_id=b.id) <> b.destination_sequence-b.origin_sequence)
    OR (b.status IN ('completed','cancelled','expired') AND EXISTS(SELECT 1 FROM booking_segments bs WHERE bs.booking_id=b.id))`));
  if (result.rows[0].invalid) throw new Error('Occupation invariant failed.');
  console.log('Migration replay, checksums and occupation invariants passed.');
} catch { console.error('Migration validation failed.'); process.exitCode=1; }
finally { await db.close(); }
