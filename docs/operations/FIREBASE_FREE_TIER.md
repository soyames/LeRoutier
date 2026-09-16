# Firebase — what LeRoutier uses, and what it costs

**Hard rule: billing is never enabled.** No code, command, deployment script,
extension, Cloud Function or Google Cloud API in this repository may require a
billing account. If a capability needs one, it is not activated — it is written
down here as unavailable, with what LeRoutier does instead.

Firebase is used for **authentication only**.

## What is used

| Feature | Plan | Quota | Status |
| --- | --- | --- | --- |
| **Firebase Authentication** — Google sign-in | Spark (free) | 50 000 monthly active users on the no-cost tier | **in use** |
| **Firebase Web SDK** (`firebase/app`, `firebase/auth`) | free | — | **in use** |
| **Google Secure Token public keys** | free, unauthenticated | — | **in use** — this is what verifies a token |

Nothing else. No Firestore, no Realtime Database, no Storage, no Hosting, no
Cloud Functions, no Cloud Messaging, no Analytics, no App Check, no Extensions.

## What is deliberately not used

| Not used | Why |
| --- | --- |
| **Firestore / Realtime Database** | Neon PostgreSQL is LeRoutier's authoritative database. A second user store would be a second answer to "who is this?" |
| **Firebase Storage** | nothing is stored in Firebase |
| **Cloud Functions** | the backend is `le-routier-api` on Vercel. Cloud Functions require the Blaze plan — a billing account — which settles it |
| **Firebase Hosting** | the PWA is on Vercel |
| **Identity Platform (upgraded Auth)** | multi-tenancy, SAML, OIDC providers and MFA are paid. Not needed; not enabled |
| **Phone authentication** | billed per verification beyond a small free allowance, and needs a billing account for production volume |
| **App Check** | free tier exists, but its enforcement APIs and reCAPTCHA Enterprise path lead to billing. Not enabled |
| **Firebase Analytics** | LeRoutier does not do behavioural tracking — see the privacy policy |

## The Admin SDK is not installed

Verifying a Firebase ID token needs **no service account**: an ID token is an
RS256 JWT signed by Google, with

```
iss = https://securetoken.google.com/<projectId>
aud = <projectId>
```

verified against Google's public key set. LeRoutier's existing `jose` verifier
already does exactly that, so the migration from the previous provider was
configuration rather than new code.

Consequences, all good ones:

- **No private key exists in Vercel**, in CI, or anywhere else. A secret that is
  not stored cannot leak.
- **No cold-start cost** from a large SDK in a serverless function.
- **No new dependency** on the server at all.

What is given up: `checkRevoked`. A token stays valid until it expires — at most
an hour — even if the Firebase user is disabled in the meantime. Revoking
*LeRoutier* access is immediate and unaffected: an identity disabled in the
database fails every request at once, which is the control that matters.

If revocation-on-Google's-side is ever wanted, it needs `firebase-admin` and a
service account. That is a deliberate decision to take then, not a default now.

## Quotas, and what happens at the edge

| Limit | Free allowance | If reached |
| --- | --- | --- |
| Monthly active users | 50 000 | further sign-ins are refused by Google; LeRoutier shows its existing "connexion indisponible" state and everything that needs no account keeps working |
| Sign-in requests per IP | Google's abuse throttling | the same |
| Key-set fetches | none stated; cached by `jose` | — |

For LeRoutier's pilot this is not a near-term constraint. A transport platform
serving 50 000 people a month is far past the point where the billing question
should be revisited on its own merits.

**Degradation is honest, not silent.** The product already treats sign-in as an
optional capability: searching trips, comparing fares and tracking a parcel need
no account, and the sign-in card states plainly when authentication is
unavailable rather than failing at the moment someone tries to book.

## Project configuration

| Setting | Value | Free |
| --- | --- | --- |
| Project | `leroutier-df848` | yes |
| Web app | registered via the Firebase Management API | yes |
| Sign-in provider | Google, enabled | yes |
| Authorized domains | `localhost`, `leroutier-df848.firebaseapp.com`, `leroutier-df848.web.app`, `le-routier.vercel.app` | yes |

The Google provider is configured against the owner's existing Google Auth
Platform project. **That OAuth client's secret belongs in the Firebase Console**
— in the Google provider's Web SDK configuration — and never in this repository,
in Vercel, or in a browser bundle. LeRoutier itself never needs it: a browser
app cannot keep a secret, which is the whole reason this flow does not use one.

## Verifying no billing was enabled

Firebase and Google Cloud both refuse Blaze-only operations outright without a
billing account, so any attempt would have failed loudly rather than silently
incurring cost. Two positive checks:

- The Firebase console shows the **Spark** plan for `leroutier-df848`.
- No `firebase-admin`, `firebase-functions` or `firebase-tools` dependency
  exists in this repository — `pnpm why firebase-admin` finds nothing.

```bash
pnpm auth:verify        # configuration and Google's key set, no billing surface
```
