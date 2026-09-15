import { createDatabase } from '../src/index.js';
import { bootstrap } from '../src/provisioning.js';
// Run only with a reviewed environment file and the intended database selected.
let db;
try {
  if(process.env.BOOTSTRAP_CONFIRM!=='provision-first-operator')throw new Error('Explicit confirmation is required.');
  db=createDatabase();
  const e=process.env;
  await bootstrap(db,{issuer:e.AUTH_ISSUER,operatorKey:e.BOOTSTRAP_OPERATOR_KEY,operatorName:e.BOOTSTRAP_OPERATOR_NAME,
    opsSubject:e.BOOTSTRAP_OPS_SUBJECT,opsName:e.BOOTSTRAP_OPS_NAME,platformOps:e.BOOTSTRAP_PLATFORM_OPS==='true',
    ...(e.BOOTSTRAP_DRIVER_SUBJECT?{driver:{subject:e.BOOTSTRAP_DRIVER_SUBJECT,displayName:e.BOOTSTRAP_DRIVER_NAME,licenseReference:e.BOOTSTRAP_DRIVER_LICENSE}}:{})});
  console.log('Bootstrap completed or verified. Identifiers withheld.');
}catch{console.error('Bootstrap did not complete. Check required configuration and existing provisioning. No values logged.');process.exitCode=1;}
finally{await db?.close();}
