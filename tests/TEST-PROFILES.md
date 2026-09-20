# Inspecting every LeRoutier workspace

Run from the repository root with Node 24 and the pinned pnpm:

```powershell
pnpm docker:up
pnpm seed:test-profiles
pnpm dev:local
```

Open <http://localhost:3003/account>, expand **Profils TEST — tous les espaces**,
and choose a profile. No password is needed for these local sessions. Sign out
before choosing another profile. Refreshing ends a development session; sign
in again. Workspace switching inside the app preserves the same session.

| Profile button | Identity | Landing page |
| --- | --- | --- |
| TEST : Voyageur | TEST Passenger | `/tickets` |
| TEST : Chauffeur indépendant | TEST Chauffeur 01 | `/work/today` |
| TEST : Conducteur de compagnie | TEST Chauffeur Compagnie | `/work/today` |
| TEST : Convoyeur | TEST Convoyeur | `/work/today` |
| TEST : Exploitation compagnie | TEST Company Ops | `/ops/today` |
| TEST : Exploitation plateforme | TEST Platform Ops | `/ops/today` |

The existing `/auth/demo` development mechanism selects fixed, allowlisted
TEST identities. It is disabled in production and on Vercel. Real sign-in
continues to use Firebase. No Firebase accounts or production inventory are
created by this seed.

The independent and company services each have a vehicle, route and stops,
an active assignment, a paid simulated passenger booking, a parcel assigned
for loading, and a low-severity delay report. The convoyeur shares the company
service. Company Ops sees its company; Platform Ops sees the existing
cross-operator controls. Independent revenue is deliberately zero: TEST
payments do not credit settlements or Fare Intelligence.

Seeding is idempotent and keeps your boarding/custody progress. It refuses
production schemas and production runtimes. To inspect a fresh journey after
completing one, use another disposable `*_dev` schema with `DATABASE_SCHEMA`
set consistently for seeding and the API. Do not run the older transport-reset
seed over this dataset: its foreign-key guards refuse parcels/incident history.

## Tickets and camera

In Voyageur → Billets, display the company or independent ticket. In a separate
browser session, sign in as its assigned driver, then choose Scanner. A scan
shows the seat, passenger, service and stops before **Confirmer l’embarquement**.
Manual ticket codes use the same verification. Offline scans remain pending
and are revalidated by the server after reconnection; they are never shown as
confirmed while offline. Duplicate, wrong-service, wrong-stop and unassigned
boarding are rejected.

Phone cameras require a secure browser origin. `localhost` works on the same
device; plain HTTP at a computer's LAN address is not a secure phone origin.
Use a trusted local HTTPS setup for a physical two-phone check. Automated live
tests feed the passenger UI's real QR into a video stream and exercise the
actual decoder, API and database; they do not prove handset optics.

## Parcels without a printer

Voyageur → Colis → **Afficher le reçu et le QR** reopens the digital receipt.
Show the QR on the sender's phone, or write the short `LRP-XXXXXXXX` reference
on the parcel. Printing is optional. The assigned driver or convoyeur can
identify it by camera or manual reference, then load, depart and arrive.

Ops → Colis → search that LRP reference handles acceptance/assignment and
**Prêt au retrait**. Ops generates the separate, expiring pickup code after
the recipient check. The assigned driver can use **Remettre avec le code**;
Ops can also record collection. A parcel QR alone never authorizes pickup.
Convoyeurs do not generate pickup credentials or release parcels.

Sender/receiver notification events and delivery decisions are exercised
locally. TEST external messages are suppressed, including parcels not yet
assigned to a service. No SMS/WhatsApp receipt is claimed by this local test:
actual external delivery requires configured channels. Public tracking exposes
logistics status, never names, phone numbers, pickup codes or ticket tokens.

## Validation

`pnpm test:api` includes real PostgreSQL profile, custody, role, ticket and
financial-isolation checks. `pnpm test:live:local` includes every workspace,
camera decoding, manual/offline boarding, and parcel handover through the
built PWA and real API. `pnpm release:check` runs all twelve release gates.

CI run `35495070081` failed at `quality → API tests` because that job had no
PostgreSQL service. API tests now run once in the existing `database` job.
No assertions, retries, or security gates were removed to repair CI.
