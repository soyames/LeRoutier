import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader, decodeJwt } from 'jose';
import { authConfig, publicAuthConfig } from '../packages/config/src/index.js';

// Proves a production OIDC configuration before anyone tries to sign in.
//
// Two parts, both read-only:
//
//   1. Discovery — fetches the provider's own metadata and checks the
//      configured issuer and JWKS against it. Endpoint paths are never guessed:
//      if discovery disagrees with configuration, configuration is wrong.
//
//   2. Token — optionally verifies one real access token end to end and reports
//      its claims. This is the only way to answer "does aud actually match?",
//      which cannot be settled by reading documentation.
//
// The token is read from stdin or LEROUTIER_ACCESS_TOKEN and is NEVER printed,
// logged, or written anywhere. Claim values are printed; the token is not.
//
//   node scripts/verify-oidc.mjs --env-file=<reviewed env file>
//   echo "<token>" | node scripts/verify-oidc.mjs
//
// Exits non-zero if anything required is missing or inconsistent.

// The identity slice only: this tool has no use for a database URL, and
// requiring one would make it awkward to run exactly when it is most needed.
const config = authConfig();
const problems = [];
const notes = [];
const ok = [];
const check = (condition, pass, fail) => (condition ? ok.push(pass) : problems.push(fail));

// --------------------------------------------------------------- 1. config --
console.log('LeRoutier OIDC verification\n');
console.log('Configuration');
const required = {
  AUTH_ISSUER: config.issuer, AUTH_JWKS_URL: config.jwksUrl, AUTH_AUDIENCE: config.audience,
  OIDC_CLIENT_ID: config.oidcClientId, OIDC_REDIRECT_URIS: config.oidcRedirectUris?.join(','),
};
for (const [name, value] of Object.entries(required)) {
  // Issuer, JWKS and redirect URIs are configuration, not secrets, and seeing
  // them is the whole point. A client id is a public identifier by design.
  console.log(`  ${value ? 'set  ' : 'MISSING'} ${name}${value ? ` = ${value}` : ''}`);
  if (!value) problems.push(`${name} is not set`);
}
console.log(`  ${config.oidcScope ? 'set  ' : '-    '} OIDC_SCOPE = ${config.oidcScope ?? '(default: openid profile)'}`);
console.log(`  ${config.oidcResource ? 'set  ' : '-    '} OIDC_RESOURCE = ${config.oidcResource ?? '(unset)'}`);

// The same gate the API applies, so this script and production agree.
const published = publicAuthConfig(config);
check(published.oidc !== null,
  '/api/v1/auth/config would publish a usable OIDC configuration',
  '/api/v1/auth/config would still return oidc:null — sign-in stays unavailable');
check(published.demoLogin === false, 'demo login is off', 'demo login is ENABLED — it must never be on in production');

// ------------------------------------------------------------ 2. discovery --
if (config.issuer) {
  const url = `${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  console.log(`\nDiscovery\n  GET ${url}`);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    check(response.ok, `  reachable (${response.status})`, `  discovery returned ${response.status}`);
    if (response.ok) {
      const discovery = await response.json();
      // An issuer that does not match its own metadata breaks every token.
      check(discovery.issuer === config.issuer,
        `  issuer matches metadata: ${discovery.issuer}`,
        `  AUTH_ISSUER (${config.issuer}) does not match the provider's own issuer (${discovery.issuer})`);
      check(discovery.jwks_uri === config.jwksUrl,
        `  JWKS matches metadata: ${discovery.jwks_uri}`,
        `  AUTH_JWKS_URL (${config.jwksUrl}) does not match discovery jwks_uri (${discovery.jwks_uri})`);

      const algorithms = discovery.id_token_signing_alg_values_supported ?? [];
      check(algorithms.some(alg => ['RS256', 'ES256'].includes(alg)),
        `  signing algorithms include one LeRoutier accepts: ${algorithms.join(', ')}`,
        `  provider advertises no RS256/ES256 support: ${algorithms.join(', ') || 'none advertised'}`);

      const pkce = discovery.code_challenge_methods_supported ?? [];
      check(pkce.includes('S256'), '  PKCE S256 supported', `  provider does not advertise PKCE S256: ${pkce.join(', ') || 'none'}`);
      console.log(`  authorization_endpoint: ${discovery.authorization_endpoint ?? '(absent)'}`);
      console.log(`  token_endpoint:         ${discovery.token_endpoint ?? '(absent)'}`);
      if (discovery.end_session_endpoint) console.log(`  end_session_endpoint:   ${discovery.end_session_endpoint}`);
      else notes.push('the provider advertises no end_session_endpoint; provider-side logout will be skipped by the client');
    }
  } catch (error) {
    problems.push(`  discovery could not be fetched: ${error.message}`);
  }
}

// ---------------------------------------------------------------- 3. token --
const stdin = process.stdin.isTTY ? '' : await new Promise(resolve => {
  let data = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
});
const token = (process.env.LEROUTIER_ACCESS_TOKEN ?? stdin).trim();

if (!token) {
  notes.push('no access token supplied — run one real sign-in and pipe the access token in to verify aud/iss/alg end to end');
} else {
  console.log('\nAccess token (claims only; the token itself is never printed)');
  // The single most common production failure: an opaque token. It is not a
  // JWT, so it has no claims to check and the API will reject every request.
  const looksLikeJwt = token.split('.').length === 3;
  check(looksLikeJwt, '  format: JWT',
    '  format: OPAQUE — the provider is issuing a bearer token, not a JWT. LeRoutier validates a JWT access token.');

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

      check(['RS256', 'ES256'].includes(header.alg), `  algorithm accepted: ${header.alg}`,
        `  algorithm ${header.alg} is not one LeRoutier accepts (RS256, ES256)`);
      check(claims.iss === config.issuer, '  iss matches AUTH_ISSUER',
        `  iss (${claims.iss}) does not match AUTH_ISSUER (${config.issuer})`);

      // The question documentation cannot answer. jose matches by membership,
      // so a multi-valued aud is fine as long as the configured value is in it.
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      check(audiences.includes(config.audience),
        `  aud contains AUTH_AUDIENCE (${config.audience})`,
        `  aud ${JSON.stringify(claims.aud)} does not contain AUTH_AUDIENCE (${config.audience}) — set AUTH_AUDIENCE to one of the values above`);

      for (const claim of ['sub', 'iss', 'aud', 'exp', 'iat']) {
        check(claims[claim] !== undefined, `  required claim present: ${claim}`, `  required claim missing: ${claim}`);
      }
      if (claims.exp) {
        const seconds = claims.exp - Math.floor(Date.now() / 1000);
        console.log(`  expires in: ${seconds}s`);
        check(seconds > 0, '  not expired', '  the token is already expired');
      }
      // Claims that would be a privilege escalation if LeRoutier trusted them.
      const privilegeClaims = Object.keys(claims).filter(k => /role|admin|operator|scope|permission/i.test(k));
      if (privilegeClaims.length) {
        notes.push(`the token carries ${privilegeClaims.join(', ')} — LeRoutier ignores these by design; roles come from its own database`);
      }
    }

    // The real thing: signature, issuer, audience and expiry, exactly as the
    // API does it, against the live JWKS.
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

// ---------------------------------------------------------------- summary ---
console.log('\n' + '─'.repeat(72));
for (const line of ok) console.log(`  PASS ${line.trim()}`);
for (const note of notes) console.log(`  NOTE ${note}`);
for (const problem of problems) console.error(`  FAIL ${problem.trim()}`);
console.log('─'.repeat(72));
if (problems.length) {
  console.error(`\n${problems.length} problem(s). Production identity is NOT ready.`);
  process.exitCode = 1;
} else if (!token) {
  console.log('\nConfiguration and discovery are consistent. Supply a real access token to confirm aud end to end.');
  process.exitCode = 1;
} else {
  console.log('\nOIDC configuration verified end to end.');
}
