import { createDatabase } from '../src/index.js';
import { authConfig } from '@leroutier/config';
import { bootstrap } from '../src/provisioning.js';
// Run only with a reviewed environment file and the intended database selected.
let db;
try {
  if(process.env.BOOTSTRAP_CONFIRM!=='provision-first-operator')throw new Error('Explicit confirmation is required.');
  db=createDatabase();
  const e=process.env;
  // The issuer is derived from FIREBASE_PROJECT_ID, exactly as the API derives
  // it. A first operator pinned to a hand-typed issuer would be pinned to an
  // issuer no real token ever carries.
  const {issuer}=authConfig(e);
  if(!issuer)throw new Error('FIREBASE_PROJECT_ID is required to pin the first identity.');
  await bootstrap(db,{issuer,operatorKey:e.BOOTSTRAP_OPERATOR_KEY,operatorName:e.BOOTSTRAP_OPERATOR_NAME,
    opsSubject:e.BOOTSTRAP_OPS_SUBJECT,opsName:e.BOOTSTRAP_OPS_NAME,platformOps:e.BOOTSTRAP_PLATFORM_OPS==='true',
    ...(e.BOOTSTRAP_DRIVER_SUBJECT?{driver:{subject:e.BOOTSTRAP_DRIVER_SUBJECT,displayName:e.BOOTSTRAP_DRIVER_NAME,licenseReference:e.BOOTSTRAP_DRIVER_LICENSE}}:{})});
  console.log('Bootstrap completed or verified. Identifiers withheld.');
}catch{console.error('Bootstrap did not complete. Check required configuration and existing provisioning. No values logged.');process.exitCode=1;}
finally{await db?.close();}
