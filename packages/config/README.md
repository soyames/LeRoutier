# Shared Configuration

Validated environment/configuration contracts shared across applications and services.

Never expose server secrets through client-side configuration. Country, operator, fare and provider differences should be explicit validated configuration/data.

## Production Google authentication

The production website redirects `leroutier.app` to `www.leroutier.app`.
Firebase Authentication must authorize **both** domains. Keep the other
existing authorized domains when updating the allowlist.

The API project's production environment uses:

```text
FIREBASE_PROJECT_ID=leroutier-df848
FIREBASE_AUTH_DOMAIN=leroutier-df848.firebaseapp.com
```

`FIREBASE_API_KEY` and `FIREBASE_APP_ID` must belong to that same Firebase
project. The API publishes the public browser configuration at
`/api/v1/auth/config`. Environment changes require an API redeployment;
an already-open browser tab needs a refresh to load the new configuration.
These hosting and Firebase settings are managed outside Git.

### Why the Google button was stuck

The API previously published `leroutier.app` as its auth domain, while the
application ran on `www.leroutier.app`. The browser blocked the helper frame,
and the helper popup returned to the application instead of Google. Firebase's
authorized-domain list also lacked `www.leroutier.app`.

The production repair added `www.leroutier.app` to Firebase's allowlist and
restored the Firebase-hosted auth domain above, then redeployed the existing
API code. It required no changes to application security headers, identity
verification, role permissions, or production demo-login restrictions.

Do not substitute a custom website domain for the Firebase-hosted auth domain
without configuring and verifying the complete helper-hosting flow: OAuth
callbacks, Firebase authorization, helper routes, iframe headers, and service
worker exclusions. See Firebase's [Google sign-in documentation](https://firebase.google.com/docs/auth/web/google-signin)
and [redirect guidance](https://firebase.google.com/docs/auth/web/redirect-best-practices).

### Verification

- Check that the live auth configuration publishes the expected Firebase
  domain and `demoLogin: false`.
- Open `/account`, select **Continuer avec Google**, and confirm the popup
  reaches `accounts.google.com` rather than the LeRoutier homepage.
- Close the popup and confirm the Google button becomes usable again.
- Complete sign-in with an authorized user's own Google account to verify
  the final account step; never log or capture credentials or tokens.

After the repair, the real Google account screen and cancellation recovery
passed in desktop Chromium and mobile emulation. Production smoke passed
35/35. Personal account sign-in and first-time registration were not completed
by automation; those require the user's interaction with Google.
