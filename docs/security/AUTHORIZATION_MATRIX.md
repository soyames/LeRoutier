# Authorization matrix

Who may do what, and **where that is enforced**.

One rule governs this whole document:

> **Hiding a control in the UI is not authorization.** Every row below is
> enforced on the server, inside the request, usually inside the SQL. The
> frontend hides what a person cannot do only so the screen makes sense.

Enforcement lives in three places: `services/api/src/app.js` (identity, rate
limiting, agent confinement), the domain services in `packages/database/src/`
(operator scoping and ownership, applied in the query), and
`packages/database/src/guards.js` (environment safety).

## Principals

| Principal | How it is proven | Notes |
| --- | --- | --- |
| Anonymous | no credential | may read the public catalogue only |
| Passenger | OIDC identity | the default for any authenticated person |
| Independent owner-driver | identity + operator ownership | owns the operator, so owns its money |
| Company driver | identity + operator membership | crew rights only |
| Convoyeur | identity + operator membership | crew rights, never driver rights |
| Operator Ops / admin | identity + operator membership with ops role | bounded by `operator_id` |
| Platform Ops | identity with no operator binding | the widest human privilege |
| Agent principal | `lragt_…` bearer token | confined to `/agent/*` and the workflow tick |

An agent is a distinct identity namespace. It can never be a human user, and a
request carrying an agent token to any non-agent path is refused with 403 —
enforced once, centrally, rather than per route.

## Public surface — no credential

| Resource | Allowed | Control |
| --- | --- | --- |
| `GET /health` | status only | no data |
| `GET /auth/config`, `GET /payments/config` | capability flags | no secret is ever included |
| `GET /stops`, `/places`, `/routes`, `/services`, `/services/:id/availability` | the travel catalogue | **rate limited per client address**; results contain no party data |
| `GET /public/parcel-tracking/LRP-…` | status, cities, point names, coarse vehicle position | rate limited; never sender, receiver, phone, pickup code or payment |
| `POST /webhooks/fedapay` | provider events | HMAC signature + timestamp tolerance; unsigned is 401 |
| `POST /auth/demo` | a demo session | **404 unless explicitly enabled**; impossible in production config |

Everything else requires an authenticated identity.

## Capability matrix

`✓` allowed · `own` only their own record · `op` only within their operator ·
`—` refused by the server.

| Resource / action | Anon | Passenger | Driver (company) | Convoyeur | Owner-driver | Operator Ops | Platform Ops | Agent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Search trips, view availability | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Hold / confirm a booking | — | own | — | — | — | — | — | — |
| View a booking | — | own | — | — | — | op | ✓ | — |
| Pay online | — | own | — | — | — | — | — | — |
| Sell a walk-up fare in cash | — | — | ✓ | ✓ | ✓ | — | — | — |
| Scan / verify a ticket | — | — | op | op | op | op | ✓ | — |
| View the passenger manifest | — | — | op | op | op | op | ✓ | read |
| Advance service state | — | — | op | op | op | op | ✓ | — |
| Publish a vehicle position | — | — | **assigned service only** | **assigned service only** | **assigned service only** | — | — | — |
| Read live tracking | — | own journey | op | op | op | op | ✓ | read |
| Read fleet tracking | — | — | — | — | — | **op** | ✓ | read |
| Generate route geometry | — | — | — | — | op | op | ✓ | — |
| Create / update a vehicle | — | — | — | — | op | op | ✓ | — |
| Create / update crew | — | — | — | — | op | op | ✓ | — |
| Propose a boarding point | — | — | op | op | op | op | ✓ | — |
| Approve a boarding point | — | — | — | — | — | op | ✓ | — |
| Consign / scan a parcel | — | own (send) | op | op | op | op | ✓ | — |
| Release a parcel to its receiver | — | — | op | op | op | op | ✓ | — |
| View operator revenue | — | — | — | — | **own operator** | op | ✓ | read |
| **Withdraw money** | — | — | **—** | **—** | **own operator** | — | ✓ | **approval only** |
| Approve a payout | — | — | — | — | — | op | ✓ | **approval only** |
| Manual payment reconciliation | — | — | — | — | — | op | ✓ | **approval only** |
| Assign a replacement vehicle | — | — | — | — | — | op | ✓ | **approval only** |
| Create an operator | — | via onboarding | — | — | — | **—** | ✓ | — |
| Grant platform privilege | — | — | — | — | — | **—** | ✓ | — |
| Suspend an operator | — | — | — | — | — | — | ✓ | — |
| Read the audit log | — | — | — | — | — | op | ✓ | — |
| Run the workflow tick | — | — | — | — | — | — | ✓ | ✓ |

### The rows that matter most

- **A company driver can never withdraw money.** Revenue belongs to the
  operator; only the operator's owner has a withdrawal path. This is a
  different code path, not a hidden button.
- **A convoyeur is never a driver.** Same console, different capabilities: no
  vehicle page, no earnings.
- **An operator Ops admin is not a platform admin.** They cannot create
  operators, grant platform privilege, or see another operator's anything.
- **Only assigned crew publish positions.** Not passengers, not other crew of
  the same operator, and not after the service closes.
- **An agent never decides money.** It can inspect and recommend; a human
  approves, and the approved step executes under *that human's* identity.

## Agent scopes

Least privilege, checked server-side against the principal on every action.

| Scope | Grants |
| --- | --- |
| `service.read` | inspect services, capacity, route summaries |
| `incident.read` | inspect open incidents, propose recoveries |
| `incident.manage` | assign replacement vehicles — approval required |
| `notification.send` | queue passenger notifications |
| `payment.reconcile` | inspect and reconcile collections — approval required |
| `payout.review` | inspect payouts, execute — approval required |
| `alert.create` | raise operational alerts for Ops |
| `workflow.run` | trigger the outbox/workflow tick |

An operator-bound principal stays operator-bound for every scope it holds.
There is no blanket scope and no superuser principal.

## How this is verified

| Claim | Test |
| --- | --- |
| Cross-operator manifests, service actions and fleet access are refused | `packages/database/tests/provisioning.test.js` |
| A passenger cannot retrieve another passenger's booking | `provisioning.test.js` |
| Operator Ops cannot create operators or grant platform privilege | `provisioning.test.js` |
| Disabled identities and inactive driver profiles fail closed | `provisioning.test.js` |
| Only assigned crew may publish a position; a closed service refuses | `tracking.test.js` |
| The fleet view is scoped to the caller's own operator | `tracking.test.js` |
| A passenger without an active ticket cannot track the vehicle | `tracking.test.js` |
| Only an authorised operator may generate geometry for its own route | `tracking.test.js` |
| Agents cannot leave the agent API; scopes and approvals hold | `agentic.test.js` |
| Anonymous catalogue reads are metered; bad input costs nothing | `services/api/tests/http.test.js` |
| A passenger identity cannot open the ops workspace | `tests/e2e/unified.spec.js` |

## Known gaps

- **Per-endpoint enumeration limits are coarse.** One shared counter covers the
  whole anonymous catalogue rather than a budget per resource.
- **Agent token rotation is manual.** Principals can be deactivated
  immediately, but there is no scheduled rotation.
- **Platform Ops has no second factor enforced by this system.** That control
  belongs to the OIDC provider and is carried as an external dependency.
