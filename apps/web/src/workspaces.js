// One identity, several authorized workspaces.
//
// Workspaces are derived from the identity the API returns, never from a
// frontend flag. The database stays authoritative: this only decides what to
// show. Every protected action is authorized again server-side, so typing a
// URL grants nothing — see docs/architecture/UNIFIED_PWA.md.
export const PASSENGER = 'passenger', WORK = 'work', OPS = 'ops';

export function workspacesFor(user) {
  if (!user) return [];
  // Anyone with an account can travel: the passenger workspace is universal.
  const available = [{ id: PASSENGER, label: 'Voyageur', hint: 'Rechercher, réserver, suivre', path: '/trips' }];
  const independent = user.role === 'driver' && user.operator_type === 'independent' && user.owner_user_id === user.id;
  if (user.role === 'driver' || user.role === 'convoyeur') {
    available.push({
      id: WORK,
      label: user.role === 'convoyeur' ? 'Convoyeur' : independent ? 'Mon activité' : 'Conduite',
      hint: user.role === 'convoyeur' ? 'Manifeste, colis, comptant'
        : independent ? 'Service, recettes, retraits' : 'Service assigné',
      path: '/work/today',
    });
  }
  if (user.role === 'ops') available.push({ id: OPS, label: 'Exploitation', hint: 'Services, flotte, équipage', path: '/ops/today' });
  return available;
}

export function capabilities(user) {
  const role = user?.role === 'convoyeur' ? 'convoyeur' : user?.role === 'driver' ? 'driver' : null;
  return {
    role,
    // An independent owner-driver owns the operator: revenue is theirs. A
    // company driver is crew and never sees settlements or withdrawals.
    independent: role === 'driver' && user?.operator_type === 'independent' && user?.owner_user_id === user?.id,
    convoyeur: role === 'convoyeur',
    ops: user?.role === 'ops',
    platformOps: user?.role === 'ops' && !user?.operator_id,
    verified: user?.verification_status === 'verified',
  };
}

// Which workspace a path belongs to, so a deep link lands in the right shell.
export function workspaceOf(pathname) {
  if (pathname.startsWith('/ops')) return OPS;
  if (pathname.startsWith('/work')) return WORK;
  return PASSENGER;
}

export function isAuthorized(workspace, user) {
  return workspacesFor(user).some(w => w.id === workspace);
}
