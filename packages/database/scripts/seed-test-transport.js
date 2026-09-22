import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { assertDisposableSchema } from '../src/guards.js';
import { seedTestTransport } from '../src/test-transport.js';
const db = createDatabase();
try {
  assertDisposableSchema(db, { purpose: 'TEST transport seed' });
  await migrate(db);
  await seedTestTransport(db);
  console.log('TEST transport seeded: six relative departures; public visibility disabled.');
  // Code AND message: the code alone turns an actionable failure — "add this
  // table to the delete order" — into an unreadable one.
} catch (error) { console.error('TEST seed failed:', [error.code, error.message].filter(Boolean).join(' — ')); process.exitCode = 1; }
finally { await db.close(); }
