import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader, decodeJwt } from 'jose';
import { authConfig, publicAuthConfig } from '../packages/config/src/index.js';

// Proves a production authentication configuration before anyone tries to
// sign in — and, given a real token, proves it afterwards too.
//
// Everything is read-only. The token is read from stdin or
// LEROUTIER_ID_TOKEN and is NEVER printed, logged or written anywhere. Claim
// values are printed; the token is not.
//
//   node --env-file=<reviewed env file> scripts/verify-auth.mjs
//   echo "<id token>" | node --env-file=<reviewed env file> scripts/verify-auth.mjs
//
// Exits non-zero if anything required is missing or inconsistent.

const config = authConfig();
const problems = [];
const notes = [];
const ok = [];
const check = (condition, pass, fail) => (condition ? ok.push(pass) : problems.push(fail));

console.log('LeRoutier authentication verification\n');

// ------------------------------------------------------------ 1. config ----
console.log('Configuration');
const required = {
  FIREBASE_PROJECT_ID: config.firebaseProjectId,
  FIREBASE_API_KEY: config.firebaseWeb.apiKey,
  FIREBASE_AUTH_DOMAIN: config.firebaseWeb.authDomain,
  FIREBASE_APP_ID: config.firebaseWeb.appId,
};
// None of these four is a secret — every Firebase web app ships all of them in
// its own source, and they are restricted by authorized domains rather than by
// being hidden. The key is still abbreviated here so a screenshot or a pasted
// terminal log carries less than it needs to.
const shown = (name, value) => (name === 'FIREBASE_API_KEY' ? `…${String(value).slice(-6)} (${value.length} chars)` : value);
for (const [name, value] of Object.entries(required)) {
  console.log(`  ${value ? 'set  ' : 'MISSING'} ${name}${value ? ` = ${shown(name, value)}` : ''}`);
  if (!value) problems.push(`${name} is not set`);
}

console.log('\nDerived from the project id — never entered by hand');
console.log(`  issuer  : ${config.issuer ?? '(unavailable)'}`);
console.log(`  audience: ${config.audience ?? '(unavailable)'}`);
console.log(`  jwks    : ${config.jwksUrl ?? '(unavailable)'}`);

const published = publicAuthConfig(config);
check(published.firebase !== null,
  '/api/v1/auth/config would publish a usable sign-in configuration',
  '/api/v1/auth/config would still return firebase:null — sign-in stays unavailable');
check(published.demoLogin === false, 'demo login is off', 'demo login is ENABLED — it must never be on in production');

// Anything server-side leaking into the browser payload is a finding.
const payload = JSON.stringify(published);
check(!/securetoken|jwks|googleapis|private|secret/i.test(payload),
  'the published payload carries no server-side value',
  'the published payload carries something that should stay on the server');

// --------------------------------------------------------------- 2. keys ---
if (config.jwksUrl) {
  console.log('\nGoogle signing keys');
  try {
    const response = await fetch(config.jwksUrl, { headers: { accept: 'application/json' } });
    check(response.ok, `  reachable (${response.status})`, `  key set returned ${response.status}`);
    if (response.ok) {
      const keys = (await response.json()).keys ?? [];
      check(keys.length > 0, `  ${keys.length} key(s) published`, '  the key set is empty');
      const algorithms = [...new Set(keys.map(k => k.alg))];
      check(algorithms.every(alg => ['RS256', 'ES256'].includes(alg)),
        `  algorithms: ${algorithms.join(', ')}`,
        `  key set offers an algorithm LeRoutier does not accept: ${algorithms.join(', ')}`);
    }
  } catch (error) {
    problems.push(`  the key set could not be fetched: ${error.message}`);
  }
}

// -------------------------------------------------------------- 3. token ---
const stdin = process.stdin.isTTY ? '' : await new Promise(resolve => {
  let data = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
});
const token = (process.env.LEROUTIER_ID_TOKEN ?? stdin).trim();

if (!token) {
  notes.push('no ID token supplied — sign in once and pipe the token in to verify a real one end to end');
} else {
  console.log('\nID token (claims only; the token itself is never printed)');
  const looksLikeJwt = token.split('.').length === 3;
  check(looksLikeJwt, '  format: JWT', '  format: not a JWT — a Firebase ID token is always a signed JWT');

  if (looksLikeJwt) {
    let header = null, claims = null;
    try { header = decodeProtectedHeader(token); claims = decodeJwt(token); }
    catch { problems.push('  the token could not be decoded'); }

    if (header && claims) {
      console.log(`  alg: ${header.alg}   kid: ${header.kid ?? '(none)'}`);
      console.log(`  iss: ${claims.iss}`);
      console.log(`  aud: ${JSON.stringify(claims.aud)}`);
      console.log(`  sub: present (${String(claims.sub ?? '').length} chars, not shown)`);
      console.log(`  claim names: ${Object.keys(claims).sort().join(', ')}`);

      check(claims.iss === config.issuer, '  iss matches this project',
        `  iss (${claims.iss}) is not this project — a token from ${String(claims.iss).split('/').pop()}`);
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      check(audiences.includes(config.audience), '  aud is this project',
        `  aud ${JSON.stringify(claims.aud)} is not ${config.audience}`);
      for (const claim of ['sub', 'iss', 'aud', 'exp', 'iat']) {
        check(claims[claim] !== undefined, `  required claim present: ${claim}`, `  required claim missing: ${claim}`);
      }
      if (claims.exp) {
        const seconds = claims.exp - Math.floor(Date.now() / 1000);
        console.log(`  expires in: ${seconds}s`);
        check(seconds > 0, '  not expired', '  the token is already expired');
      }
      // Claims that would be an escalation if LeRoutier trusted any of them.
      const privilege = Object.keys(claims).filter(k => /role|admin|operator|permission|claims/i.test(k));
      if (privilege.length) {
        notes.push(`the token carries ${privilege.join(', ')} — LeRoutier ignores these by design; roles come from its own database`);
      }
    }

    // The real thing: signature, issuer, audience and expiry, exactly as the
    // API does it, against Google's live key set.
    if (config.jwksUrl && config.issuer && config.audience) {
      try {
        const jwks = createRemoteJWKSet(new URL(config.jwksUrl));
        await jwtVerify(token, jwks, { issuer: config.issuer, audience: config.audience,
          algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat'], clockTolerance: 5 });
        ok.push('  full verification passed: signature, issuer, audience, expiry — identical to the API');
      } catch (error) {
        problems.push(`  full verification FAILED: ${error.code ?? error.message}`);
      }
    }
  }
}

// ------------------------------------------------------------- summary -----
console.log('\n' + '─'.repeat(72));
for (const line of ok) console.log(`  PASS ${line.trim()}`);
for (const note of notes) console.log(`  NOTE ${note}`);
for (const problem of problems) console.error(`  FAIL ${problem.trim()}`);
console.log('─'.repeat(72));
if (problems.length) {
  console.error(`\n${problems.length} problem(s). Production identity is NOT ready.`);
  process.exitCode = 1;
} else if (!token) {
  console.log('\nConfiguration and signing keys are consistent. Supply a real ID token to confirm end to end.');
  process.exitCode = 1;
} else {
  console.log('\nAuthentication verified end to end.');
}
