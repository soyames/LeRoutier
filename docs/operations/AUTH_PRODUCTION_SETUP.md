# Production authentication setup

LeRoutier authenticates with **Firebase Authentication** and **Google Sign-In**.
There is no password store, no OTP path and no second authentication system —
if the provider is not configured, sign-in fails closed and the product stays
usable for everything that needs no account.

Firebase is used for **authentication only**, on the free plan, with **no
billing account**. See [`FIREBASE_FREE_TIER.md`](FIREBASE_FREE_TIER.md).

## How it works

```
PWA  →  Firebase Authentication (Google)
     →  Firebase ID token
     →  Authorization: Bearer <token>  →  le-routier-api
     →  signature / issuer / audience / expiry verified against Google's public keys
     →  existing LeRoutier identity mapping
     →  roles read from the database
```

**Google decides who you are. LeRoutier decides what you may do.** A token
claiming `role: ops` grants nothing: only `sub` and `iss` are read from it.

## Configuration

Four variables, all on **`le-routier-api`**. None on `le-routier`.

| Variable | What it is |
| --- | --- |
| `FIREBASE_PROJECT_ID` | the Firebase project |
| `FIREBASE_API_KEY` | browser-facing Firebase key |
| `FIREBASE_AUTH_DOMAIN` | `<project>.firebaseapp.com` |
| `FIREBASE_APP_ID` | the registered web app |

### Why all four live on the API

Three of these are browser-facing values, so it would be reasonable to build
them into the PWA. They are served by `/api/v1/auth/config` at runtime instead,
which means **rotating a Firebase key is an API change, not a rebuild and
redeploy of the app**. The PWA needs no authentication variable of its own.

### Classification

| Value | Class | Note |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_APP_ID` | **FRONTEND_SAFE** | every Firebase web app ships all four; they are restricted by **authorized domains**, not by secrecy |
| Firebase service-account JSON | **SERVER_ONLY_SECRET** | **not used and not stored** — see below |
| Google OAuth client secret | **SERVER_ONLY_SECRET** | belongs in the Firebase Console's Google provider settings, nowhere else |

A Firebase web API key is *not* a credential. It identifies a project; it grants
nothing on its own. What protects the project is the authorized-domain list and
the fact that every privileged decision is made by LeRoutier's own API.

### Derived, never typed

The issuer, audience and key set are computed from `FIREBASE_PROJECT_ID`:

```
issuer   = https://securetoken.google.com/<projectId>
audience = <projectId>
jwks     = https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com
```

They are not configurable, because a mistyped issuer or audience is exactly the
mistake that makes a verifier accept another project's tokens. One variable
cannot disagree with itself.

Accepted algorithms: **RS256** and **ES256**. Required claims: `sub`, `iss`,
`aud`, `exp`, `iat`. Clock tolerance: 5 seconds.

If any of the four is missing, `/api/v1/auth/config` returns `firebase: null`
and the app shows "La connexion sécurisée n'est pas encore configurée". A
half-configured provider never produces a half-working sign-in.

## No Admin SDK, and why

Verifying an ID token needs no service account — only the project id and
Google's public keys. `firebase-admin` is therefore **not installed**, no
private key is stored anywhere, and there is no cold-start cost from a large SDK
in a serverless function. A secret that is not stored cannot leak.

The trade-off, stated: no `checkRevoked`. A token remains valid until it expires
— at most an hour — even if the Google account is disabled meanwhile. Disabling
an identity **in LeRoutier** takes effect immediately, which is the control that
matters for this product.

## Firebase Console setup

| Setting | Value |
| --- | --- |
| Sign-in provider | **Google**, enabled |
| Authorized domains | must include `le-routier.vercel.app` |
| Web app | registered; supplies the four values above |

> The Google provider's **Web SDK configuration** is where an external OAuth
> client id and secret go, if the project uses one. That secret stays in the
> console. It never enters this repository, Vercel, or a browser bundle.

Add a custom domain to the authorized list when one is acquired. Nothing else
changes: the callback is same-origin and there is no redirect URI to register.

## Scopes

`openid`, `profile`, `email`. Nothing else, ever, without a product decision and
a privacy-policy change to match.

LeRoutier does **not** request Gmail, Drive, Calendar, Contacts or Photos, and
cannot read them. This is asserted by test against the source, so a scope added
in a hurry fails the build rather than quietly outgrowing the published policy.

## What happens on first sign-in

1. Firebase authenticates with Google and issues an ID token.
2. The API verifies it and takes **only** `sub` and `iss`.
3. A new subject becomes a **passenger**: `role = passenger`,
   `operator_id = null`, a passenger profile row, `needs_profile = true`,
   and an `identity.onboarded` audit event.
4. Concurrent first logins produce exactly one identity.
5. A known subject cannot be re-bound to a different issuer.

Custom claims, email address, email domain and Google profile grant **nothing**.
Becoming a driver, convoyeur or Ops happens only through LeRoutier's own
provisioning, and is covered by tests.

## Sessions

Tokens live in memory and in `sessionStorage` for the tab, never in
`localStorage` — a shared handset at a station must not sign the next person in
as the last one. The SDK refreshes a token shortly before expiry, and the token
is requested per API call rather than held, so a long booking does not fail on a
token that went stale while the user was reading.

Signing out clears the Firebase session and LeRoutier's own state, and is
asserted to leave nothing behind.

## Verify

```bash
pnpm auth:verify
```

Checks the four variables, the derived issuer and audience, that the published
browser payload carries nothing server-side, and that Google's key set is
reachable and offers an accepted algorithm.

Then sign in once and pipe the ID token in to confirm a real one end to end. The
script verifies signature, issuer, audience and expiry exactly as the API does,
prints the claims, and **never prints the token**:

```bash
node --env-file=<reviewed env file> scripts/verify-auth.mjs < token.txt
```

## Status

| Key | Status |
| --- | --- |
| `FIREBASE_AUTH_CODE` | **READY** |
| `FIREBASE_ADMIN_BACKEND` | **NOT USED — by design**; token verification needs no service account |
| `GOOGLE_SIGN_IN` | **READY** — provider enabled, scopes limited to identity |
| `PRODUCTION_CONFIG` | **READY** — four variables set on `le-routier-api` |
| `REAL_LOGIN` | see [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) |
| `FREE_TIER_ONLY` | **ENFORCED** — [`FIREBASE_FREE_TIER.md`](FIREBASE_FREE_TIER.md) |

**Authentication is not READY until one real production sign-in has succeeded.**

## Never

- A client secret in the browser, in this repository, or in Vercel.
- A service-account JSON anywhere but the owner's own machine.
- A role, operator or permission taken from a token claim.
- A second sign-in path "just for staff".
