import { createDatabase } from '../src/index.js';
import { cleanupTestTransport } from '../src/test-transport-cleanup.js';
const db = createDatabase();
try { console.log(`Removed ${await cleanupTestTransport(db)} TEST services; audit identities retained.`); }
catch (error) { console.error('TEST cleanup failed:', error.code ?? error.message); process.exitCode = 1; }
finally { await db.close(); }
