-- What a member of LeRoutier's own staff is allowed to do.
--
-- Until now "Platform Ops" was a single, total permission: `role='ops'` with no
-- operator_id. One identity shape opened KYC dossiers containing national
-- identity documents, every user account on the platform, the finance console,
-- and the system capacity controls. There was no smaller thing to be. Adding a
-- colleague to review carte grise scans meant handing them the payout console
-- and the entire user register as well, and there was no way to say otherwise.
--
-- That is the gap this closes. A platform identity now HOLDS CAPABILITIES, and
-- each one is checked where the work happens:
--
--   verification  review KYC/KYB dossiers, open evidence, decide an operator
--   users         the user register, account activation and lifecycle
--   finance       platform finance, anomalies, settlements and payouts
--   incidents     platform-wide incidents
--   operations    day-to-day platform view of services and parcels
--   system        capacity, storage, migrations, technical state
--   provisioning  create operators, provision people into them
--   superadmin    all of the above, plus managing this table itself
--
-- ONE superadmin, enforced by the database rather than by a code path. The
-- partial unique index below makes a second superadmin row impossible: not
-- discouraged, not validated against in application code that somebody later
-- forgets to call, but rejected by PostgreSQL. The owner asked to be the only
-- superadmin on this project, and the honest way to implement "only" is a
-- constraint that cannot be argued with.
--
-- Capabilities are DENY BY DEFAULT. A platform identity with no rows here can
-- authenticate and sees nothing: every platform surface asks for a named
-- capability and gets a refusal. Deleting a row removes access at the next
-- request rather than at the next deployment.
--
-- Operator staff are untouched. `role='ops'` WITH an operator_id is a transport
-- company's own operations account, scoped to that company by operator_id as it
-- always was; this table is only about LeRoutier's own people.
CREATE TABLE platform_grants (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability text NOT NULL CHECK (capability IN
    ('verification','users','finance','incidents','operations','system','provisioning','superadmin')),
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, capability)
);

CREATE INDEX platform_grants_user ON platform_grants(user_id);

-- At most one superadmin on the platform, ever. The index is on a constant
-- expression restricted to superadmin rows, so a second one collides.
CREATE UNIQUE INDEX platform_grants_single_superadmin
  ON platform_grants ((capability)) WHERE capability = 'superadmin';

-- Backfill, so this migration changes nobody's access on the day it runs.
--
-- The bootstrapped identity becomes the superadmin, because that is the one
-- the owner provisioned deliberately through a reviewed, one-time action. If
-- no bootstrap receipt exists (a database seeded another way), the earliest
-- platform identity takes it — deterministic, and never an arbitrary one.
INSERT INTO platform_grants (user_id, capability)
SELECT id, 'superadmin' FROM users
WHERE role = 'ops' AND operator_id IS NULL AND active
ORDER BY (id = (SELECT ops_user_id FROM bootstrap_receipt LIMIT 1)) DESC, created_at
LIMIT 1
ON CONFLICT DO NOTHING;

-- Any OTHER pre-existing platform identity keeps everything it could already
-- do, minus the superadmin seat. Migrating must not quietly demote somebody
-- who was working yesterday; narrowing them is the owner's decision to make
-- afterwards, in the console, with an audit trail.
INSERT INTO platform_grants (user_id, capability)
SELECT u.id, c.capability
FROM users u
CROSS JOIN (VALUES ('verification'),('users'),('finance'),('incidents'),
                   ('operations'),('system'),('provisioning')) AS c(capability)
WHERE u.role = 'ops' AND u.operator_id IS NULL AND u.active
  AND NOT EXISTS (SELECT 1 FROM platform_grants g WHERE g.user_id = u.id AND g.capability = 'superadmin')
ON CONFLICT DO NOTHING;
