import { createDatabase } from '@leroutier/database';
import { transport } from '@leroutier/database/transport';
const db=createDatabase();
try {const result=await transport(db).expireHolds();console.log(`Hold expiry completed for ${result.servicesProcessed} services.`);}
catch {console.error('Hold expiry failed.');process.exitCode=1;}
finally {await db.close();}
