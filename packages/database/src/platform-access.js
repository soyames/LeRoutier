/**
 * What a member of LeRoutier's own staff may do.
 *
 * READ THIS BEFORE ADDING A PLATFORM SURFACE.
 *
 * "Platform Ops" used to be one total permission — `role='ops'` with no
 * operator_id — so every platform screen asked the same question and got the
 * same answer. Reviewing a carte grise and releasing a payout were the same
 * privilege. They are not the same privilege.
 *
 * A platform identity now holds named capabilities. Three rules keep that
 * meaningful:
 *
 *   DENY BY DEFAULT. No row, no access. A platform identity with no grants
 *   authenticates and sees nothing, rather than seeing everything because
 *   somebody forgot a check.
 *
 *   THE SERVER DECIDES. `platformCapabilities` is read from the database on
 *   every request as part of identity resolution. Navigation filtering in the
 *   browser is a convenience; typing a URL grants nothing, because the handler
 *   asks again.
 *
 *   ONE SUPERADMIN. Enforced by a unique index in migration 034, not here.
 *   Application code can be bypassed by the next caller; the index cannot.
 *
 * Operator staff are a different thing entirely and are NOT governed by this
 * module: `role='ops'` WITH an operator_id is a transport company's own
 * account, scoped by operator_id exactly as before.
 */
import { invariant } from '@leroutier/domain';

/** Everything a platform identity can be granted, superadmin aside. */
export const PLATFORM_CAPABILITIES = Object.freeze([
  'verification', 'users', 'finance', 'incidents', 'operations', 'system', 'provisioning',
]);

/** Implies every capability, and manages the grants themselves. Exactly one exists. */
export const SUPERADMIN = 'superadmin';

/** Everything that may appear in platform_grants.capability. */
export const GRANTABLE = Object.freeze([...PLATFORM_CAPABILITIES, SUPERADMIN]);

/** Human labels, for consoles and for refusal messages that name the missing grant. */
export const CAPABILITY_LABELS = Object.freeze({
  verification: 'Vérifications & KYC',
  users: 'Utilisateurs & comptes',
  finance: 'Finances & règlements',
  incidents: 'Incidents plateforme',
  operations: 'Services & colis',
  system: 'Système & capacité',
  provisioning: 'Opérateurs & personnel',
  superadmin: 'Super-administration',
});

/**
 * A platform identity is `role='ops'` with NO operator. An operator's own ops
 * account is never a platform identity however many grants somebody inserts.
 * @param {{role?:string,operator_id?:string|null}} [user]
 */
export const isPlatformIdentity = user => user?.role === 'ops' && !user?.operator_id;

/**
 * Read a platform identity's capabilities.
 *
 * Returns [] for anybody who is not a platform identity, including operator
 * ops staff — so a stray grant row attached to an operator account grants
 * nothing at all. Superadmin expands to the full set here rather than at each
 * call site, because "superadmin implies everything" repeated twelve times is
 * eleven chances to get it wrong.
 */
export async function platformCapabilities(tx, user) {
  if (!isPlatformIdentity(user)) return [];
  const { rows } = await tx.query('SELECT capability FROM platform_grants WHERE user_id=$1', [user.id]);
  const held = rows.map(r => r.capability);
  return held.includes(SUPERADMIN) ? [SUPERADMIN, ...PLATFORM_CAPABILITIES] : held;
}

/** Whether an already-resolved identity holds a capability. */
export function holds(user, capability) {
  return isPlatformIdentity(user) && (user.platform_capabilities ?? []).includes(capability);
}

/** Whether an already-resolved identity is THE superadmin. */
export const isSuperadmin = user => holds(user, SUPERADMIN);

/**
 * Refuse unless the identity is platform staff holding `capability`.
 *
 * The message names the missing capability on purpose. A flat "access denied"
 * on an internal console wastes somebody's afternoon; the person reading this
 * is staff, the capability names are not secret, and knowing which grant is
 * missing is the difference between asking for it and filing a bug.
 *
 * @param {{role?:string,operator_id?:string|null,platform_capabilities?:string[]}} user
 * @param {string} capability
 */
export function requirePlatform(user, capability) {
  invariant(GRANTABLE.includes(capability), 'INTERNAL_ERROR', 'Unknown platform capability.', 500);
  invariant(isPlatformIdentity(user), 'FORBIDDEN', 'Platform Operations access required.', 403);
  invariant(holds(user, capability), 'FORBIDDEN',
    `Accès refusé : cette action demande l’autorisation « ${CAPABILITY_LABELS[capability]} ».`, 403);
  return user;
}

/** Refuse unless the identity is the superadmin. */
export function requireSuperadmin(user) {
  invariant(isPlatformIdentity(user), 'FORBIDDEN', 'Platform Operations access required.', 403);
  invariant(isSuperadmin(user), 'FORBIDDEN',
    'Seul le super-administrateur peut gérer les autorisations de l’équipe plateforme.', 403);
  return user;
}

/** Validate a requested grant list coming from a client. */
export function normaliseCapabilities(value) {
  invariant(Array.isArray(value), 'INVALID_INPUT', 'Les autorisations doivent être une liste.');
  const unique = [...new Set(value)];
  for (const capability of unique) {
    invariant(PLATFORM_CAPABILITIES.includes(capability), 'INVALID_INPUT',
      `Autorisation inconnue : ${String(capability).slice(0, 40)}.`);
  }
  // Superadmin is deliberately NOT grantable through this path. There is one,
  // it came from the reviewed bootstrap, and a console that can mint another
  // would make the single-superadmin index the only thing standing between a
  // mistake and a second owner of the platform.
  return unique.sort();
}
