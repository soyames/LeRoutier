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
      return {subject:payload.sub,issuer:payload.iss};
    } catch {throw new DomainError('UNAUTHORIZED','Session is invalid or expired.',401);}
  };
}

export function authentication(db, config, keyResolver = undefined) {
  const verify=jwtVerifier(config,keyResolver);
  return {
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
    async demoSession(role) {
      invariant(config.demoLogin, 'NOT_FOUND', 'Endpoint not found.', 404);
      invariant(['passenger','driver','ops'].includes(role),'INVALID_ROLE','Choose a development role.');
      const token=randomBytes(32).toString('base64url');
      const user=await db.transaction(async tx=>{
        const user=(await tx.query('SELECT id,role,operator_id,display_name FROM users WHERE is_demo=true AND role=$1 ORDER BY id LIMIT 1',[role])).rows[0];
        invariant(user,'NOT_FOUND','Development seed is not available.',404);
        await tx.query('DELETE FROM api_sessions WHERE expires_at<=now()');
        await tx.query("INSERT INTO api_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hash(token),user.id]);
        return activeIdentity(tx,user.id);
      });
      return { token,user };
    },
  };
}
