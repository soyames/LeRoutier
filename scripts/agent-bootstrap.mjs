// One-time agent principal bootstrap. Keep tokens in an ignored env file, e.g.:
//   AGENT_BOOTSTRAP_JSON='[{"name":"recovery-agent","scopes":["service.read","incident.read"],"token":"lragt_..."}]'
// Tokens are stored as SHA-256 digests only; this script never prints them.
import { createDatabase } from '@leroutier/database';
import { bootstrap } from '@leroutier/agents';

let entries;
try {
  entries = JSON.parse(process.env.AGENT_BOOTSTRAP_JSON || '[]');
} catch {
  console.error('AGENT_BOOTSTRAP_JSON is not valid JSON.');
  process.exitCode = 1;
}
if (!process.exitCode) {
  if (!Array.isArray(entries) || !entries.length) {
    console.error('AGENT_BOOTSTRAP_JSON must contain at least one principal entry.');
    process.exitCode = 1;
  } else {
    const db = createDatabase();
    try {
      for (const entry of entries) {
        const principal = await bootstrap(db, entry);
        console.log(`Agent principal "${principal.name}" provisioned with ${principal.scopes.length} scope(s).`);
      }
    } catch {
      console.error('Agent bootstrap failed.');
      process.exitCode = 1;
    } finally {
      await db.close();
    }
  }
}
