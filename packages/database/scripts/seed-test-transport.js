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
} catch (error) { console.error('TEST seed failed:', error.code ?? error.message); process.exitCode = 1; }
finally { await db.close(); }
