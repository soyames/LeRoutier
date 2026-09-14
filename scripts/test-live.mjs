import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { serverConfig } from '../packages/config/src/index.js';
import { createDatabase } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrations.js';
import { seed } from '../packages/database/src/seed.js';
import { createApi } from '../services/api/src/app.js';
import { nodeHandler } from '../services/api/src/node-handler.js';

const config={...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-',''),demoLogin:true};
const db=createDatabase(config),server=createServer(nodeHandler(createApi(db,config)));
try {
  await migrate(db);await seed(db);
  // The preview servers serve prebuilt bundles; rebuild with the local API URL baked in.
  const built=spawnSync('pnpm',['--filter','@leroutier/passenger-web','--filter','@leroutier/driver-web','--filter','@leroutier/ops-web','build'],
    {stdio:'inherit',shell:process.platform==='win32',env:{...process.env,VITE_API_URL:'http://127.0.0.1:4000'}});
  if(built.status!==0) throw new Error('Live e2e build failed.');
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(4000,resolve);});
  const code=await new Promise(resolve=>{
    const child=spawn('pnpm',['exec','playwright','test','--config','playwright.live.config.js'],{stdio:'inherit',shell:process.platform==='win32'});
    child.on('close',resolve);child.on('error',()=>resolve(1));
  });
  process.exitCode=Number(code || 0);
} catch {console.error('Live integration test setup failed. No connection details logged.');process.exitCode=1;}
finally {
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  try {if(db.schema.startsWith('lr_test_'))await db.transaction(tx=>tx.query(`DROP SCHEMA "${db.schema}" CASCADE`));}
  finally {await db.close();}
}
