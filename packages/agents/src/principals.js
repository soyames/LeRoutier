import { createHash } from 'node:crypto';
import { invariant, uuid } from '@leroutier/domain';

// Service/agent principals are deliberately distinct from Passenger/Driver/Ops
// users. Tokens are opaque (`lragt_…`), stored only as SHA-256 digests.
export const SCOPES = ['service.read', 'incident.read', 'incident.manage', 'notification.send',
  'payment.reconcile', 'payout.review', 'alert.create', 'workflow.run',
  'parcel.read', 'parcel.manage', 'parcel.notify',
  'operator.read', 'location.manage'];

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// Bootstrap from an ignored environment (never from chat or committed files).
// { name, scopes:[], token, operatorId? } — operatorId scopes the principal to
// one operator; absent means platform scope (documented, audited).
export function bootstrap(db, { name, scopes, token, operatorId = null }) {
  invariant(typeof name === 'string' && /^[a-z0-9-]{2,60}$/.test(name), 'INVALID_AGENT', 'Agent name is invalid.');
  invariant(Array.isArray(scopes) && scopes.length > 0 && scopes.every(s => SCOPES.includes(s)), 'INVALID_AGENT', 'Agent scopes are invalid.');
  invariant(typeof token === 'string' && /^lragt_[A-Za-z0-9_-]{32,200}$/.test(token), 'INVALID_AGENT', 'Agent token format is invalid.');
  if (operatorId) uuid(operatorId);
  return db.transaction(async tx => {
    await tx.query(`INSERT INTO agent_principals(name,token_hash,active,operator_id) VALUES($1,$2,true,$3)
      ON CONFLICT(name) DO UPDATE SET token_hash=EXCLUDED.token_hash,active=true,operator_id=EXCLUDED.operator_id`, [name, hashToken(token), operatorId]);
    const principal = (await tx.query('SELECT * FROM agent_principals WHERE name=$1', [name])).rows[0];
    await tx.query('DELETE FROM agent_scopes WHERE principal_id=$1', [principal.id]);
    for (const scope of scopes) await tx.query('INSERT INTO agent_scopes(principal_id,scope) VALUES($1,$2)', [principal.id, scope]);
    return { id: principal.id, name, scopes, operatorId };
  });
}

export async function authenticate(db, request) {
  const token = request.headers.get('authorization')?.match(/^Bearer (lragt_[A-Za-z0-9_-]{32,200})$/)?.[1];
  if (!token) return null;
  return db.transaction(async tx => {
    const row = (await tx.query('SELECT * FROM agent_principals WHERE token_hash=$1 AND active=true', [hashToken(token)])).rows[0];
    if (!row) return null;
    const scopes = (await tx.query('SELECT scope FROM agent_scopes WHERE principal_id=$1 ORDER BY scope', [row.id])).rows.map(r => r.scope);
    return { agent: { id: row.id, name: row.name, scopes, operatorId: row.operator_id ?? null } };
  });
}

export function requireScope(agent, scope) {
  invariant(agent && agent.scopes.includes(scope), 'FORBIDDEN', `Agent scope ${scope} is required.`, 403);
}
