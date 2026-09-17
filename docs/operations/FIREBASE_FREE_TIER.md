# Firebase and Google: zero-billing operating policy

Billing must remain disabled. Do not link a billing account, enable Blaze,
paid Identity Platform, Vertex AI, Cloud Functions, Firestore, Firebase Storage,
paid Google APIs or a paid model tier. No automatic upgrade is permitted.

## Features actually used

| Feature | Configuration | Limit / failure behavior |
| --- | --- | --- |
| Firebase Authentication, Google social sign-in | Spark, Web SDK; public runtime configuration | Google abuse and request limits apply; sign-in failure leaves public search and parcel tracking usable |
| Firebase public signing keys | jose JWKS cache; no service account | Unavailable keys fail authentication closed |
| Gemini Developer API | Google OAuth, Sensitive GOOGLE_GEMINI_CREDENTIALS; gemini-3.6-flash | Free quota is opportunistic; shared database cooldown honors Retry-After/RetryInfo; core journeys continue |
| OpenRouter fallback | Explicitly selected free model, low-risk tasks only | No financial, identity or capacity authority; failure produces no recommendation |
| MiniCPM | Local only | Never silently selected as a remote provider |

The previous ?50,000 MAU then sign-ins stop? statement conflated basic Firebase
Authentication with upgraded Identity Platform pricing. Basic social sign-in is
a no-cost Firebase feature; do not use the Identity Platform pricing table as a
quota promise for this project. Google's published authentication limits include
account creation abuse limits (100 new accounts/hour/IP) and endpoint-specific
limits. These may change; throttling never authorizes billing.

Sources checked 2026-09-17:
[Firebase pricing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans),
[Authentication limits](https://firebase.google.com/docs/auth/limits),
[Identity Platform pricing](https://cloud.google.com/identity-platform/pricing).

The public Firebase project ID returned by production is leroutier-df848.
The Gemini OAuth Google project is leroutier. These are distinct configuration
identifiers; the verifier derives issuer and audience from FIREBASE_PROJECT_ID.

## Authentication controls

RS256 Firebase tokens are checked for signature, issuer, audience, expiry and
issued-at time. DB roles alone control authorization. First login creates one
Passenger and one passenger profile, with no operator. Token claims, email,
domain and profile fields cannot grant a role. No Admin SDK or private signing
key is needed. Firebase-side revocation is not checked; DB identity deactivation
blocks the next request. Firebase ID tokens can otherwise remain valid until expiry.

The browser requests only openid/profile/email. Persistence is session-scoped,
falling back to memory if session storage cannot be used. CSP permits Google's
auth helper and the project's auth iframe. Popup sign-in is primary; redirect
fallback remains subject to browser storage restrictions described by
[Firebase](https://firebase.google.com/docs/auth/web/redirect-best-practices).
The real owner sign-in remains a manual verification gate.

## Platform Ops MFA

LeRoutier does not enforce a second factor. Firebase MFA requires the upgraded
Identity Platform feature set; it is not activated under the owner's no-billing
policy. Compensating controls are Google account two-step verification/passkeys
(managed by the owner), individual Ops accounts, no shared credentials, DB
deactivation, scoped roles, audit, and human financial approval. Do not claim
these controls are app-enforced MFA.

## Verification boundary

No billing mutation was performed. Repository dependency and configuration
inspection proves the app does not require paid Firebase features; it does not
prove an account's current billing state. Console/account verification is
read-only. Never infer ?billing cannot be enabled? merely from application code.

## Custom auth domain via reverse proxy

`leroutier.app` is the Firebase authDomain, served by a Vercel rewrite of
`/__/auth/*` to the project's `firebaseapp.com` helper. No Firebase Hosting
site, no Blaze plan, no Identity Platform feature is involved — this is the
documented free-tier reverse-proxy pattern for custom auth domains.
