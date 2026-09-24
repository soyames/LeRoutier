import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { invariant, DomainError } from '@leroutier/domain';
import { mapIdentity, activeIdentity } from '@leroutier/database/identities';

const hash = token => createHash('sha256').update(token).digest('hex');
export function jwtVerifier(config, keyResolver = undefined) {
  let jwks=keyResolver;
  if(!jwks && config.issuer && config.audience && config.jwksUrl) {
    try {const url=new URL(config.jwksUrl);if(url.protocol==='https:')jwks=createRemoteJWKSet(url);}
    catch { /* Invalid configuration fails closed without exposing values. */ }
  }
  return async token=>{
    invariant(jwks && config.issuer && config.audience,'AUTH_UNAVAILABLE','Sign-in is not configured.',503);
    try {
      const {payload}=await jwtVerify(token,jwks,{issuer:config.issuer,audience:config.audience,
        algorithms:config.firebaseProjectId?['RS256']:['RS256','ES256'],requiredClaims:['sub','iss','aud','exp','iat'],clockTolerance:5});
      invariant(Number.isFinite(payload.iat) && payload.iat<=Date.now()/1000+5,'UNAUTHORIZED','Invalid identity.',401);
      invariant(typeof payload.sub==='string' && payload.sub.length>0 && payload.sub.length<=255,'UNAUTHORIZED','Invalid identity.',401);
      // Custom role/operator/name claims are deliberately not used for authorization or provisioning.
      // The email claim travels in two shapes: `email` is the address itself
      // (the verification endpoint sends to it for unverified accounts), and
      // `notificationEmail` is the SAME address but only when the provider has
      // verified it — the sole thing allowed to populate users.notification_email.
      // `signInProvider` is how password identities are told apart from Google,
      // custom-token and demo identities, and is the claim the verification
      // gate reads.
      const email=typeof payload.email==='string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) && payload.email.length<=254 ? payload.email : null;
      // Firebase's own provider claim. Read defensively: a token without it
      // (custom-minted) is never treated as a password identity.
      const firebase=/** @type {{sign_in_provider?:unknown}|undefined} */ (payload.firebase);
      return {subject:payload.sub,issuer:payload.iss,
        email,
        notificationEmail:payload.email_verified === true ? email : null,
        emailVerified:payload.email_verified === true,
        signInProvider:typeof firebase?.sign_in_provider==='string' ? firebase.sign_in_provider : null};
    } catch {throw new DomainError('UNAUTHORIZED','Session is invalid or expired.',401);}
  };
}

export function authentication(db, config, keyResolver = undefined) {
  const verify=jwtVerifier(config,keyResolver);
  return {
    // The raw token verifier, for the few paths that must check a Firebase
    // identity WITHOUT establishing a LeRoutier session — the account
    // verification email endpoint being the one: an unverified account is
    // deliberately not a LeRoutier user yet, so /me refuses it.
    verifyToken: verify,
    async authenticate(request) {
      const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
      invariant(token && token.length < 8192, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      if(config.demoLogin && !token.includes('.')) {
        return db.transaction(async tx=>{
          const row=(await tx.query(`SELECT u.id FROM api_sessions s JOIN users u ON u.id=s.user_id
            WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_demo=true`,[hash(token)])).rows[0];
          invariant(row,'UNAUTHORIZED','Session is invalid or expired.',401);
          return activeIdentity(tx,row.id);
        });
      }
      return mapIdentity(db,await verify(token));
    },
    async demoSession(role, profile) {
      invariant(config.demoLogin, 'NOT_FOUND', 'Endpoint not found.', 404);
      const profiles = { passenger: 2, 'owner-driver': 20, 'company-driver': 28, convoyeur: 3, 'company-ops': 11, 'platform-ops': 1 };
      invariant(profile ? Object.hasOwn(profiles, profile) : ['passenger','driver','convoyeur','ops'].includes(role),'INVALID_ROLE','Choose a development role.');
      const profileId = profile ? `00000000-0000-4000-b00b-${String(profiles[profile]).padStart(12,'0')}` : null;
      const token=randomBytes(32).toString('base64url');
      const user=await db.transaction(async tx=>{
        const user=(await tx.query('SELECT id,role,operator_id,display_name FROM users WHERE is_demo=true AND (($2::uuid IS NOT NULL AND id=$2) OR ($2::uuid IS NULL AND role=$1)) ORDER BY id LIMIT 1',[role ?? null,profileId])).rows[0];
        invariant(user,'NOT_FOUND','Development seed is not available.',404);
        await tx.query('DELETE FROM api_sessions WHERE expires_at<=now()');
        await tx.query("INSERT INTO api_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hash(token),user.id]);
        return activeIdentity(tx,user.id);
      });
      return { token,user };
    },
  };
}
