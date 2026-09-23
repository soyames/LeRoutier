// Read-only check of the production Firebase project's OAuth configuration.
//
// Verifies the "Authorized domains" list that decides whether Google sign-in
// can run on a given origin, without opening the Firebase console. Everything
// here is a GET; nothing is written, and no token or key is ever printed.
//
//   node scripts/firebase-config-check.mjs <path-to-service-account.json>
//
// The service account JSON is a provider credential export; it lives in the
// owner's Downloads folder and is gitignored by its download pattern. Pass it
// as an argument — never move it into the repository.
import { SignJWT, importPKCS8 } from 'jose';
import { readFile } from 'node:fs/promises';

const saPath = process.argv[2];
if (!saPath) {
  console.error('Usage: node scripts/firebase-config-check.mjs <path-to-service-account.json>');
  process.exit(2);
}

const sa = JSON.parse(await readFile(saPath, 'utf8'));
const project = sa.project_id;
if (!project || !sa.client_email || !sa.private_key) {
  console.error('Not a service account export: project_id, client_email and private_key are required.');
  process.exit(2);
}

// Mint a short-lived OAuth2 access token for the identitytoolkit scope from
// the service account key. The token itself is never printed.
const token = await new SignJWT({ scope: 'https://www.googleapis.com/auth/identitytoolkit' })
  .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id })
  .setIssuer(sa.client_email)
  .setSubject(sa.client_email)
  .setAudience('https://oauth2.googleapis.com/token')
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(await importPKCS8(sa.private_key, 'RS256'));

const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: token,
  }),
});
if (!tokenResponse.ok) {
  console.error(`Could not obtain an access token: HTTP ${tokenResponse.status}`);
  process.exit(2);
}
const { access_token: accessToken } = await tokenResponse.json();

// v2 getConfig — read only. Returns authorizedDomains plus the Google
// provider block used for sign-in.
const configResponse = await fetch(
  `https://identitytoolkit.googleapis.com/v2/projects/${project}/config`,
  { headers: { authorization: `Bearer ${accessToken}` } },
);
if (!configResponse.ok) {
  console.error(`getConfig failed: HTTP ${configResponse.status}`);
  process.exit(2);
}
const config = await configResponse.json();

console.log(`Firebase project: ${project}`);
console.log('\nAuthorized domains (decides where Google sign-in may run):');
for (const domain of config.authorizedDomains ?? []) console.log(`  ${domain}`);
console.log('\nProvider block (Google client the Firebase flow uses):');
const google = config.signIn?.google;
console.log(`  enabled: ${google?.enabled ?? false}`);
if (google?.clientId) console.log(`  clientId: ${google.clientId} (public identifier)`);

// The origins LeRoutier serves from, per the current domain setup. Whether a
// domain is listed here is a fact about the Firebase project, not an opinion:
// report presence, and leave the fix to the owner.
const expected = ['leroutier.app', 'www.leroutier.app', 'leroutier-df848.firebaseapp.com', 'localhost'];
const domains = config.authorizedDomains ?? [];
for (const domain of expected) {
  console.log(`  ${domains.includes(domain) ? 'PRESENT' : 'MISSING'}  ${domain}`);
}
