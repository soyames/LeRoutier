import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { invariant, DomainError } from '@leroutier/domain';

const hash = token => createHash('sha256').update(token).digest('hex');
export function authentication(db, config) {
  const jwks = config.jwksUrl ? createRemoteJWKSet(new URL(config.jwksUrl)) : null;
  return {
    async authenticate(request) {
      const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
      invariant(token && token.length < 8192, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      let subject;
      if (jwks && config.issuer && config.audience) {
        try {
          const { payload } = await jwtVerify(token,jwks,{issuer:config.issuer,audience:config.audience,algorithms:['RS256','ES256']});
          subject=payload.sub;
        } catch { /* Development sessions are checked separately, never in Vercel. */ }
      }
      const actor = await db.transaction(async tx => {
        if (subject) return (await tx.query('SELECT id,role,operator_id,display_name FROM users WHERE auth_subject=$1',[subject])).rows[0];
        if (config.demoLogin) return (await tx.query(`SELECT u.id,u.role,u.operator_id,u.display_name FROM api_sessions s JOIN users u ON u.id=s.user_id
          WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_demo=true`,[hash(token)])).rows[0];
      });
      if (!actor) throw new DomainError('UNAUTHORIZED','Session is invalid or expired.',401);
      return actor;
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
        return user;
      });
      return { token,user };
    },
  };
}
