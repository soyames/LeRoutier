import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { assertDisposableSchema } from '../src/guards.js';
import { seedTestProfiles } from '../src/test-profiles.js';

const db=createDatabase();
try {
  assertDisposableSchema(db,{purpose:'TEST profiles'});
  await migrate(db);
  const result=await seedTestProfiles(db);
  console.log('Six local TEST profiles ready. Open /account and choose “Profils TEST”.');
  console.log('Parcel references:',result.shipments.join(', '));
} catch(error) { console.error('TEST profiles failed:',error.code ?? error.message);process.exitCode=1; }
finally { await db.close(); }
