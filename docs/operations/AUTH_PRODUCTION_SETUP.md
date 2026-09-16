# Production authentication setup

LeRoutier authenticates with **OIDC Authorization Code + PKCE** against an
external identity provider. There is no password store, no OTP path and no
second authentication system — if the provider is not configured, sign-in fails
closed and the product stays usable for everything that needs no account.

**This document does not choose a provider or any value for you.** It states
exactly what the running code expects, so whoever owns the provider can fill it
in once.

## What the code requires

### API — `le-routier-api` (server-side only)

| Variable | Required | What the code does with it |
| --- | --- | --- |
| `AUTH_ISSUER` | yes | `iss` the access token must carry. Must be HTTPS. |
| `AUTH_JWKS_URL` | yes | Remote JWK set used to verify the signature. Must be HTTPS. |
| `AUTH_AUDIENCE` | yes | `aud` the access token must carry. |
| `OIDC_CLIENT_ID` | yes | Published to the browser by `/api/v1/auth/config`. |
| `OIDC_REDIRECT_URIS` | yes | Comma-separated exact callback URLs. Each must be HTTPS. |
| `OIDC_SCOPE` | no | Defaults to `openid profile`. |
| `OIDC_RESOURCE` | no | Sent as RFC 8707 `resource` — see *Audience* below. |

Signature algorithms accepted: **RS256** and **ES256**. Required claims:
`sub`, `iss`, `aud`, `exp`, `iat`. Clock tolerance: 5 seconds.

All five required values must be present **and** valid HTTPS URLs, or
`/api/v1/auth/config` returns `oidc: null` and the app shows "La connexion
sécurisée n'est pas encore configurée". This is deliberate: a half-configured
provider never produces a half-working sign-in.

### Frontend

The unified PWA needs **no** auth variables. It reads everything from
`/api/v1/auth/config` at runtime, so rotating a client id is an API change
only — no rebuild.

## Redirect URIs

The callback route is `/auth/callback`, served by the SPA rewrite.

```
https://le-routier.vercel.app/auth/callback        # now, canonical
https://leroutier.bj/auth/callback                 # future custom domain
```

Register **both** at the provider when the domain is acquired, and list both in
`OIDC_REDIRECT_URIS`. The browser client only initialises when
`window.location.origin + '/auth/callback'` appears in that list, so an origin
missing from it simply cannot sign in — by design.

The legacy apps, while they remain deployed, each need their own entry:

```
https://le-routier-passenger.vercel.app/auth/callback
https://le-routier-driver.vercel.app/auth/callback
https://le-routier-ops.vercel.app/auth/callback
```

### Post-logout redirect

`window.location.origin + '/'`. Register `https://le-routier.vercel.app/` (and
the future domain) as a post-logout redirect URI. If the provider exposes no
end-session endpoint, the local session is still cleared and the user is told
that provider sign-out is unavailable.

## Audience — the one thing to get right

The API verifies the **access token**, not the id token. Many providers issue an
opaque or userinfo-scoped access token by default, which will not verify.

Two supported shapes:

1. **Provider supports RFC 8707 `resource`** — set `OIDC_RESOURCE` to the API
   identifier and `AUTH_AUDIENCE` to the same value. The browser requests a
   token for that resource and the API accepts it.
2. **Provider uses a fixed API audience** (an "API"/"audience" concept) — leave
   `OIDC_RESOURCE` unset if the provider attaches the audience itself, and set
   `AUTH_AUDIENCE` to the audience it issues.

If sign-in succeeds in the browser but `/api/v1/me` returns 401, the access
token audience does not match `AUTH_AUDIENCE`. That is the first thing to check.

## Scopes

Default `openid profile`. LeRoutier reads only `sub` and `iss` from the token:

> Custom `role`, `operator` or permission claims are **deliberately ignored**.

Roles come from the database, never from the token. A provider cannot grant
someone Ops access by adding a claim.

## What happens on first sign-in

1. The access token is verified against the JWKS.
2. `sub` + `iss` are mapped to a LeRoutier identity. A new `sub` creates one
   `users` row with role `passenger` and an empty passenger profile — nothing
   more.
3. An existing identity whose `iss` does not match is **rejected**, never
   silently relinked.
4. `identity.onboarded` is written to the audit trail.
5. The passenger completes their profile (name, phone) before their first
   booking.

Becoming a driver, convoyeur or Ops user is never self-service: it happens
through operator onboarding (independent) or provisioning by a company
administrator.

## Session behaviour

- Tokens are held **in memory only** and are never written to `localStorage` or
  `sessionStorage`. A page reload requires signing in again. This is a
  deliberate security property, asserted by the browser suite.
- Only the PKCE state lives in `sessionStorage`, as the protocol requires.
- Token expiry clears the session and shows "Votre session a expiré."
- A 401 from any API call clears the session immediately.
- Sign-in returns the user to the page they came from — including an
  interrupted booking, which is resumed automatically. Return paths are
  validated as same-origin absolute paths, so the callback cannot be used as an
  open redirect.

## Verification checklist

Once the provider is configured:

```bash
curl -s https://le-routier.vercel.app/api/v1/auth/config
```

Expect `demoLogin: false` and a populated `oidc` block with `authority`,
`clientId`, `scope` and `redirectUris`. `oidc: null` means at least one required
value is missing or not HTTPS.

Then, in a browser:

1. open `https://le-routier.vercel.app/account` and sign in;
2. confirm you land back on `/account`, not on the home page;
3. complete the profile;
4. open `https://le-routier.vercel.app/trips`, pick a departure while signed
   out in a private window, and confirm sign-in returns you to that trip with
   the booking resumed;
5. confirm `/ops` shows "Espace non autorisé" for a plain passenger identity.

`pnpm smoke:prod` asserts `demoLogin: false` in production on every run.

## Never

- Do not enable `ALLOW_DEMO_LOGIN` in production. It is force-disabled whenever
  `VERCEL` is set or `NODE_ENV=production`, and the smoke test fails if demo
  login is ever reported as enabled.
- Do not add a password, OTP or API-key login path.
- Do not put any auth secret in a `VITE_*` variable — those ship to the browser.
