import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
const db = createDatabase();
try { console.log(`Migrations validated: ${await migrate(db)}`); }
catch (error) { console.error('Migration failed.', /^[0-9A-Z]{5}$/.test(error.code) ? error.code : ''); process.exitCode = 1; }
finally { await db.close(); }
