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
      // Opaque session tokens. A provider token always carries dots, so this is
      // the one unambiguous test, and both kinds live in the same table: the
      // development login's, which is only honoured where that login exists, and
      // a guest purchaser's, which is honoured everywhere because buying without
      // an account is a product path and not a development convenience.
      //
      // Whether the identity is still ACTIVE is deliberately left to
      // activeIdentity below rather than filtered here. A suspended account has
      // to be told it is suspended; resolving its session to nothing instead
      // reported "your session is invalid", which sends somebody to sign in again
      // for a problem signing in cannot fix.
      if(!token.includes('.')) {
        return db.transaction(async tx=>{
          const row=(await tx.query(`SELECT u.id FROM api_sessions s JOIN users u ON u.id=s.user_id
            WHERE s.token_hash=$1 AND s.expires_at>now()
              AND (s.kind='guest' OR ($2::boolean AND u.is_demo=true))`,[hash(token),config.demoLogin===true])).rows[0];
          invariant(row,'UNAUTHORIZED','Session is invalid or expired.',401);
          return activeIdentity(tx,row.id);
        });
      }
      const claims=await verify(token);
      // WHAT THIS SIGN-IN IS FOR, and the purchase behind it.
      //
      // `/me` is where a LeRoutier account comes into being, so a rule about
      // opening one has to be enforced here. The rule is about PASSENGER
      // accounts: a traveller's account is opened with a first ticket, so the
      // door that offers one says so and must present the purchase the account
      // is being created for.
      //
      // WHICH DOOR IS WHICH, and why the default is not "passenger". The
      // account screen, the professional page and operator onboarding are
      // reached by people who are not buying anything — a driver, a company,
      // their staff — and are the same screen for both. Treating an unstated
      // intent as a traveller's would lock providers out of their own signup,
      // which is exactly what must not happen. Only the ticket surface claims
      // to be opening a traveller's account, and it is the only one refused
      // without a purchase. Nothing is weakened by the default: an identity
      // created without one is not a passenger account, cannot buy as one, and
      // cannot hold a ticket — which is what a passenger account is.
      //
      // Both headers are bounded before they are read, and neither is trusted
      // for anything except this one decision: the guest token is checked
      // against its stored hash and its paid bookings in the database.
      const intent=request.headers.get('x-signup-intent')==='passenger'?'passenger':'provider';
      const raw=request.headers.get('x-guest-token');
      const guestToken=typeof raw==='string' && raw.length>=20 && raw.length<=200 ? raw : null;
      return mapIdentity(db,{...claims,intent,guestToken});
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
