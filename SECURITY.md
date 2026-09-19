# Security policy

LeRoutier moves people, parcels and money in Benin. A vulnerability here can
strand a passenger, expose someone's location, or misdirect an operator's
revenue. Reports are taken seriously and answered.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). It creates a private advisory visible
only to the maintainers.

Please include:

- what you found and where (endpoint, screen, file, or request);
- the steps to reproduce it, ideally with a minimal request;
- what an attacker gains — data read, data changed, money moved, access gained;
- anything you already tried that did *not* work, which saves triage time.

**Never include real credentials, real passenger data, or a live token in a
report.** Describe the class of value and where it came from. If you believe a
credential has leaked, say which variable and where you saw it, not its value.

### What to expect

| | |
| --- | --- |
| Acknowledgement | within 3 working days |
| Initial assessment | within 10 working days |
| Fix or mitigation plan | communicated with the assessment |

You will be credited in the advisory unless you ask not to be.

## Scope

In scope:

- the API (`/api/v1`) and the domain services behind it;
- the unified PWA and the three legacy applications still deployed;
- authentication, authorization and operator isolation;
- payment, payout and ledger handling;
- parcel custody, pickup codes and public parcel tracking;
- vehicle GPS ingestion, storage and exposure;
- agent principals, scopes, actions and the approval queue;
- CI, deployment configuration and anything that could leak a secret.

Out of scope:

- findings that require a compromised device or a stolen session already in the
  attacker's hands;
- denial of service through sheer volume against shared free infrastructure
  (map tiles, routing) — report the dependency risk instead, which is useful;
- missing hardening headers with no demonstrated impact (still welcome, but
  triaged as hardening rather than as a vulnerability);
- reports produced only by an automated scanner with no verified impact.

## Please do not

- Test against production with real passengers, real payments or real parcels.
  A local Docker database (`pnpm docker:up`) reproduces the whole system.
- Run load or stress tests against production.
- Access, modify or retain data belonging to anyone else.
- Initiate a real payment or payout.

Testing within these limits, reported privately, will not be pursued.

## Supporting documents

- Security controls, threat analysis and retention details are maintained privately.
