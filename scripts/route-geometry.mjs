// Offline routing preparation against an operator-controlled OSRM. Routes are
// existing domain records: this never invents a service or publishes demo data.
import {serverConfig} from '../packages/config/src/index.js';
import {createDatabase} from '../packages/database/src/index.js';
import {routeGeometry} from '../packages/database/src/route-geometry.js';
import {createRouter} from '../packages/routing/src/index.js';
import {activeIdentity} from '../packages/database/src/identities.js';
const config=serverConfig(),db=createDatabase(config),write=process.argv.includes('--write');
try {
 const routes=await db.transaction(async tx=>(await tx.query('SELECT id FROM routes ORDER BY id')).rows);
 console.log(JSON.stringify({routes:routes.length,mode:write?'generate':'inspect',configured:createRouter(config).configured}));
 if(write && routes.length) {
  const actor=await db.transaction(tx=>activeIdentity(tx,process.env.ROUTING_ACTOR_ID));
  const geometry=routeGeometry(db,createRouter(config));
  for(const route of routes){const result=await geometry.generate(actor,route.id);console.log(JSON.stringify(result));if(result.reason)process.exitCode=1;}
 }
} finally {await db.close();}
