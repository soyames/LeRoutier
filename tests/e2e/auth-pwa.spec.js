import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

// Google sign-in on an INSTALLED PWA.
//
// Real Google OAuth cannot run in automation — no test here may authenticate
// against a live Google account, and none pretends to. What these tests do
// prove, against the real built service worker and the real Firebase SDK:
//
//  * the service worker never answers /__/auth/* navigations with the app
//    shell (the failure that killed the OAuth callback on installed devices);
//  * mobile/standalone mode chooses the redirect flow, desktop the popup;
//  * rapid taps start exactly one attempt, and a blocked popup falls back to
//    the redirect;
//  * an interrupted redirect explains itself in French instead of dying
//    silently;
//  * a signed-in session survives a full app relaunch, and /me runs exactly
//    once per sign-in through one session-establishment path.
//
// A PASS here is not a real Google sign-in: the physical installed-PWA
// acceptance gate stays manual (see the pilot acceptance document).
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const APP = 'http://127.0.0.1:4173';
const AUTH_DOMAIN = 'example.firebaseapp.com';
const FIREBASE = {
  apiKey: 'browser-test-api-key', authDomain: AUTH_DOMAIN,
  projectId: 'example-project', appId: '1:1:web:test', providers: ['google'],
};

/**
 * A minimal gapi.iframes stand-in. The SDK only uses it to host the auth
 * helper iframe that relays provider events; the stub opens the real iframe
 * element (whose URL is then handled by the route mocks below) and implements
 * the three methods the SDK calls. No provider protocol is re-implemented.
 */
const GAPI_STUB = () => {
  /** @type {any} */ (window).gapi = { iframes: { Iframe: function Iframe() {}, CROSS_ORIGIN_IFRAMES_FILTER: null,
    getContext: () => ({ open: (opts, cb) => new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:absolute;top:-100px;width:1px;height:1px';
      frame.setAttribute('aria-hidden', 'true');
      frame.src = opts.url;
      document.body.appendChild(frame);
      frame.addEventListener('load', () => {
        const stub = {
          restyle: () => Promise.resolve(),
          ping: done => { done(); return Promise.resolve(); },
          register: () => {},
          send: () => {},
          getOriginFromUrl: () => 'https://example.firebaseapp.com',
          getOriginalUrl: () => frame.src,
          getPageLocation: () => 'https://example.firebaseapp.com',
        };
        resolve(cb(stub));
      });
    })}) }};
};

/**
 * Firebase-facing mocks. identitytoolkit answers the SDK's project-config
 * lookup and password endpoints; the branded helper origin serves stub pages;
 * every other Google-owned host is aborted so no test can reach the real
 * provider.
 */
async function mockFirebaseHosts(page, { password = null, track = null } = {}) {
  await mockApi(page);
  await page.route('**/api/v1/auth/config', r => r.fulfill({ json: { data: { demoLogin: false, firebase: FIREBASE } } }));
  await page.route('**/*', async r => {
    const url = new URL(r.request().url());
    if (url.hostname === 'identitytoolkit.googleapis.com') {
      if (url.pathname === '/v1/projects') {
        return r.fulfill({ json: { authorizedDomains: ['127.0.0.1', AUTH_DOMAIN, 'localhost'] } });
      }
      if (url.pathname === '/v1/accounts:signInWithPassword') {
        if (!password) return r.abort();
        track && (track.passwordSignIns = (track.passwordSignIns ?? 0) + 1);
        return r.fulfill({ status: 200, json: { idToken: 'firebase-id-token', email: password.email,
          localId: 'local-1', refreshToken: 'refresh', expiresIn: '3600' } });
      }
      if (url.pathname === '/v1/accounts:lookup') {
        return r.fulfill({ status: 200, json: { users: [{ localId: 'local-1', email: password?.email ?? '',
          displayName: '', providerUserInfo: [], validSince: '0', lastLoginAt: '0', createdAt: '0' }] } });
      }
      return r.abort();
    }
    if (url.hostname === AUTH_DOMAIN) {
      if (url.pathname === '/__/auth/handler') {
        track?.handler && track.handler.push(url.href);
        return r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>HANDLER-STUB</body></html>' });
      }
      if (url.pathname === '/__/auth/iframe') {
        track?.iframe && track.iframe.push(url.href);
        return r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>IFRAME-STUB</body></html>' });
      }
      return r.abort();
    }
    return /^(?:[a-z0-9-]+\.)*(?:googleapis\.com|google\.com|firebaseapp\.com|gstatic\.com)$/i.test(url.hostname)
      ? r.abort() : r.fallback();
  });
}

/** The real /me contract: provision a new passenger, accept the PATCH. */
async function mockIdentity(page, { delayMs = 0, meCalls = null } = {}) {
  let current = { id: '00000000-0000-4000-8000-000000000099', display_name: 'Test Identity',
    role: 'passenger', operator_id: null, needs_profile: false };
  await page.route('**/api/v1/me', async r => {
    if (r.request().method() === 'PATCH') {
      const body = r.request().postDataJSON();
      current = { ...current, display_name: body.displayName, needs_profile: false };
    }
    if (meCalls) meCalls.count = (meCalls.count ?? 0) + 1;
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    await r.fulfill({ json: { data: current } });
  });
}

// ------------------------------------------------ service worker regression --
test.use({ serviceWorkers: 'allow' });
test('the installed PWA service worker never answers the OAuth callback with the app shell', async ({ page }) => {
  // The mechanism that broke installed-PWA sign-in: the workbox navigation
  // fallback answered /__/auth/* navigations from cache, the Firebase handler
  // never ran, and the OAuth code was never exchanged. Playwright routing
  // happens below the service worker, so a marker-fulfilled route proves the
  // request really reached the network.
  await mockApi(page);
  const MARKER = 'NETWORK-SERVED';
  await page.route('**/__/auth/handler**', r =>
    r.fulfill({ status: 200, contentType: 'text/html', body: `<html><body>${MARKER}</body></html>` }));
  await page.route('**/__/auth/iframe**', r =>
    r.fulfill({ status: 200, contentType: 'text/html', body: `<html><body>${MARKER}</body></html>` }));

  await page.goto(APP + '/');
  await page.evaluate(() => navigator.serviceWorker.ready); // registration completes
  await page.reload(); // the first load is never controlled; the installed app's is
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20000 });

  // The OAuth callback: a same-origin navigation with the authorization code.
  await page.goto(APP + '/__/auth/handler?code=simulated&state=simulated');
  const body = await page.evaluate(() => document.body.innerHTML);
  expect(body).toContain(MARKER);
  expect(body).not.toContain('id="root"');

  // The helper iframe: a frame navigation the fallback would also swallow.
  await page.goto(APP + '/');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20000 });
  const iframeBody = await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    frame.src = '/__/auth/iframe?apiKey=browser-test-api-key';
    document.body.appendChild(frame);
    await new Promise((resolve, reject) => {
      frame.addEventListener('load', resolve);
      frame.addEventListener('error', reject);
      setTimeout(resolve, 5000);
    });
    return frame.contentDocument?.body?.innerHTML ?? '';
  });
  expect(iframeBody).toContain(MARKER);
});

// ------------------------------------------------ strategy and single-flight --
test('rapid Google taps start exactly one attempt; a blocked popup falls back to the redirect', async ({ page }) => {
  const track = { handler: [], iframe: [] };
  await mockFirebaseHosts(page, { track });
  await page.addInitScript(GAPI_STUB);
  await page.addInitScript(() => { window.open = () => null; }); // popup blocked

  await page.goto(APP + '/account');
  await expect(page.getByRole('button', { name: 'Continuer avec Google' })).toBeEnabled();
  // Three taps in the same frame, before React can disable the button — the
  // single-flight guard must absorb the two extras.
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Google'));
    button.click(); button.click(); button.click();
  });
  // The blocked popup falls back to signInWithRedirect: the page navigates to
  // the helper handler exactly once.
  await page.waitForURL(`https://${AUTH_DOMAIN}/__/auth/handler*`, { timeout: 15000 });
  await expect.poll(() => track.handler.length, { timeout: 10000 }).toBe(1);
  expect(track.iframe.length).toBeLessThanOrEqual(1);
});

test('an installed PWA (standalone display mode) goes straight to the redirect', async ({ page }) => {
  const track = { handler: [], iframe: [] };
  await mockFirebaseHosts(page, { track });
  await page.addInitScript(GAPI_STUB);
  await page.addInitScript(() => {
    window.matchMedia = query => ({ matches: query === '(display-mode: standalone)', media: query,
      onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false });
  });
  const popups = [];
  page.on('popup', p => popups.push(p));

  await page.goto(APP + '/account');
  await page.getByRole('button', { name: 'Continuer avec Google' }).click();
  await page.waitForURL(`https://${AUTH_DOMAIN}/__/auth/handler*`, { timeout: 15000 });
  expect(track.handler.length).toBe(1);
  expect(popups).toEqual([]);
});

test('an interrupted Google redirect explains itself in French and clears the marker', async ({ page }) => {
  await mockFirebaseHosts(page);
  await page.addInitScript(GAPI_STUB);
  // A previous life of the app started a redirect that never came back: the
  // marker survives, but there is no credential and no user to restore.
  await page.addInitScript(() => {
    localStorage.setItem('leroutier:auth-redirect', JSON.stringify({ returnTo: '/tickets' }));
  });

  await page.goto(APP + '/account');
  await expect(page.getByText('La connexion Google n’a pas abouti. Réessayez.')).toBeVisible({ timeout: 15000 });
  // The attempt is over: the marker is gone, and one tap starts a clean flow.
  expect(await page.evaluate(() => localStorage.getItem('leroutier:auth-redirect'))).toBeNull();
  await expect(page.getByRole('button', { name: 'Continuer avec Google' })).toBeEnabled();
});

// ----------------------------------------------- session persistence & /me --
test('a Firebase session survives a full app relaunch, with one /me per sign-in', async ({ page }) => {
  const track = {};
  const meCalls = { count: 0 };
  await mockFirebaseHosts(page, { password: { email: 'voyageur@example.com' }, track });
  await mockIdentity(page, { delayMs: 300, meCalls });
  await page.addInitScript(GAPI_STUB);

  await page.goto(APP + '/account');
  // /me never runs before Firebase has an authenticated user.
  expect(meCalls.count).toBe(0);

  await page.getByLabel('Adresse e-mail').fill('voyageur@example.com');
  await page.getByLabel('Mot de passe').fill('secret-mot-de-passe');
  await page.getByRole('button', { name: 'Se connecter avec mon adresse e-mail' }).click();
  // The UI stays on its progress state while the server session hydrates
  // (both the Google and the e-mail buttons carry the busy label).
  await expect(page.getByRole('button', { name: 'Connexion en cours…' }).first()).toBeVisible();
  await expect(page.getByText('Test Identity').first()).toBeVisible({ timeout: 15000 });
  // One session-establishment path: the sign-in action joined the listener's
  // in-flight /me instead of racing a second one.
  expect(meCalls.count).toBe(1);
  expect(track.passwordSignIns).toBe(1);

  // A full relaunch: local persistence restores the user, the auth-state
  // listener hydrates the session, and no second provider sign-in is needed.
  await page.reload();
  await expect(page.getByText('Test Identity').first()).toBeVisible({ timeout: 15000 });
  expect(track.passwordSignIns).toBe(1);
  expect(meCalls.count).toBe(2);

  // Explicit logout ends it: the sign-in entry returns, nothing provider-side
  // is left behind for the next person on the handset.
  await page.getByRole('button', { name: 'Compte de Test Identity' }).click();
  await page.getByRole('menuitem', { name: 'Déconnexion' }).click();
  await expect(page.getByText('Bienvenue sur LeRoutier')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Se connecter', exact: true })).toBeVisible();
});
