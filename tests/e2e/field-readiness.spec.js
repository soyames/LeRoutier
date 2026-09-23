import { test, expect } from '@playwright/test';
import { mockApi, DEPARTURE_AT } from './api-fixture.js';

// Field conditions, as far as a browser can reach them.
//
// What this file can prove: that the camera is opened only when somebody asks
// for it, released when they stop asking, and released again when the app goes
// to the background; that a torch control appears only where there is a torch;
// that a wrong code is explained without killing the scan; and that the crew
// screens are usable with a thumb at 390px.
//
// What it CANNOT prove, and does not claim: that a phone reads another phone's
// screen at dusk, in a station, through a cracked protector, held by somebody
// in a hurry. Those live in docs/PILOT-ACCEPTANCE.md and are unperformed.
const APP = 'http://127.0.0.1:4173';

/**
 * Counts camera opens and lets us see whether tracks were released.
 * @typedef {{opened: number, stopped: number, live: number}} CameraProbe
 */
async function instrumentCamera(page) {
  await page.addInitScript(() => {
    const state = { opened: 0, stopped: 0, live: 0 };
    Object.defineProperty(window, '__camera', { value: state });
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 320;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 320, 320);
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        state.opened++; state.live++;
        const stream = canvas.captureStream(8);
        for (const track of stream.getTracks()) {
          const original = track.stop.bind(track);
          track.stop = () => { state.stopped++; state.live--; original(); };
          // No torch on this device, which is the case the UI must handle by
          // offering nothing rather than a control that does nothing.
          track.getCapabilities = () => ({});
        }
        return stream;
      },
    });
  });
}

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CREW = { id: id(99), display_name: 'Test Identity', needs_profile: false,
  role: 'driver', operator_type: 'company', operator_id: id(1), verification_status: 'verified', owner_user_id: null };

// A QR encoding https://example.com/not-leroutier, rendered once with
// qrcode.react so the suite carries its own foreign code instead of a new
// dependency. Whatever qr-scanner decodes from this is "a code that is not
// ours", and the product must say so while the camera keeps looking.
const FOREIGN_QR = '<svg height="380" width="380" viewBox="0 0 37 37" role="img"><path fill="#FFFFFF" d="M0,0 h37v37H0z" shape-rendering="crispEdges"></path><path fill="#000000" d="M4 4h7v1H4zM14 4h3v1H14zM18 4h1v1H18zM23 4h1v1H23zM26,4 h7v1H26zM4 5h1v1H4zM10 5h1v1H10zM12 5h1v1H12zM14 5h1v1H14zM16 5h2v1H16zM21 5h4v1H21zM26 5h1v1H26zM32,5 h1v1H32zM4 6h1v1H4zM6 6h3v1H6zM10 6h1v1H10zM13 6h1v1H13zM16 6h1v1H16zM19 6h1v1H19zM22 6h2v1H22zM26 6h1v1H26zM28 6h3v1H28zM32,6 h1v1H32zM4 7h1v1H4zM6 7h3v1H6zM10 7h1v1H10zM13 7h1v1H13zM15 7h3v1H15zM20 7h1v1H20zM26 7h1v1H26zM28 7h3v1H28zM32,7 h1v1H32zM4 8h1v1H4zM6 8h3v1H6zM10 8h1v1H10zM12 8h4v1H12zM17 8h1v1H17zM20 8h4v1H20zM26 8h1v1H26zM28 8h3v1H28zM32,8 h1v1H32zM4 9h1v1H4zM10 9h1v1H10zM15 9h2v1H15zM18 9h6v1H18zM26 9h1v1H26zM32,9 h1v1H32zM4 10h7v1H4zM12 10h1v1H12zM14 10h1v1H14zM16 10h1v1H16zM18 10h1v1H18zM20 10h1v1H20zM22 10h1v1H22zM24 10h1v1H24zM26,10 h7v1H26zM15 11h2v1H15zM19 11h1v1H19zM21 11h2v1H21zM24 11h1v1H24zM4 12h1v1H4zM6 12h1v1H6zM8 12h1v1H8zM10 12h1v1H10zM13 12h2v1H13zM16 12h1v1H16zM20 12h2v1H20zM23 12h2v1H23zM28 12h1v1H28zM31 12h1v1H31zM5 13h1v1H5zM7 13h1v1H7zM11 13h1v1H11zM14 13h4v1H14zM19 13h2v1H19zM24 13h1v1H24zM26 13h1v1H26zM29 13h1v1H29zM32,13 h1v1H32zM5 14h3v1H5zM9 14h2v1H9zM13 14h3v1H13zM18 14h3v1H18zM26 14h3v1H26zM30,14 h3v1H30zM4 15h4v1H4zM9 15h1v1H9zM12 15h1v1H12zM14 15h1v1H14zM16 15h3v1H16zM20 15h2v1H20zM24 15h2v1H24zM28 15h1v1H28zM31 15h1v1H31zM5 16h2v1H5zM9 16h2v1H9zM12 16h4v1H12zM18 16h4v1H18zM23 16h4v1H23zM29 16h1v1H29zM31,16 h2v1H31zM4 17h4v1H4zM9 17h1v1H9zM13 17h1v1H13zM15 17h1v1H15zM18 17h2v1H18zM21 17h1v1H21zM25 17h2v1H25zM29 17h1v1H29zM32,17 h1v1H32zM4 18h3v1H4zM8 18h3v1H8zM13 18h1v1H13zM15 18h1v1H15zM17 18h1v1H17zM20 18h1v1H20zM25 18h1v1H25zM27 18h3v1H27zM31,18 h2v1H31zM4 19h2v1H4zM8 19h1v1H8zM13 19h1v1H13zM15 19h2v1H15zM21 19h5v1H21zM27 19h1v1H27zM29 19h1v1H29zM31 19h1v1H31zM5 20h3v1H5zM10 20h2v1H10zM13 20h1v1H13zM16 20h1v1H16zM21 20h1v1H21zM23 20h4v1H23zM29 20h1v1H29zM31,20 h2v1H31zM6 21h1v1H6zM13 21h1v1H13zM15 21h1v1H15zM17 21h1v1H17zM20 21h3v1H20zM24 21h3v1H24zM29 21h2v1H29zM32,21 h1v1H32zM4 22h1v1H4zM7 22h1v1H7zM10 22h1v1H10zM14 22h1v1H14zM18 22h1v1H18zM21 22h2v1H21zM25 22h2v1H25zM28 22h1v1H28zM31,22 h2v1H31zM5 23h1v1H5zM9 23h1v1H9zM11 23h1v1H11zM13 23h1v1H13zM17 23h5v1H17zM24 23h1v1H24zM27 23h3v1H27zM31 23h1v1H31zM4 24h1v1H4zM6 24h2v1H6zM10 24h1v1H10zM12 24h2v1H12zM18 24h1v1H18zM20 24h2v1H20zM23 24h6v1H23zM12 25h2v1H12zM15 25h1v1H15zM18 25h1v1H18zM20 25h1v1H20zM23 25h2v1H23zM28 25h1v1H28zM30,25 h3v1H30zM4 26h7v1H4zM14 26h1v1H14zM16 26h2v1H16zM21 26h1v1H21zM23 26h2v1H23zM26 26h1v1H26zM28 26h2v1H28zM31,26 h2v1H31zM4 27h1v1H4zM10 27h1v1H10zM13 27h1v1H13zM15 27h2v1H15zM19 27h1v1H19zM21 27h2v1H21zM24 27h1v1H24zM28 27h2v1H28zM4 28h1v1H4zM6 28h3v1H6zM10 28h1v1H10zM12 28h1v1H12zM16 28h1v1H16zM19 28h3v1H19zM24 28h5v1H24zM32,28 h1v1H32zM4 29h1v1H4zM6 29h3v1H6zM10 29h1v1H10zM13 29h1v1H13zM15 29h1v1H15zM20 29h3v1H20zM24 29h2v1H24zM28 29h1v1H28zM30,29 h3v1H30zM4 30h1v1H4zM6 30h3v1H6zM10 30h1v1H10zM12 30h4v1H12zM17 30h1v1H17zM20 30h1v1H20zM24 30h1v1H24zM27 30h3v1H27zM32,30 h1v1H32zM4 31h1v1H4zM10 31h1v1H10zM14 31h2v1H14zM19 31h6v1H19zM26 31h1v1H26zM31 31h1v1H31zM4 32h7v1H4zM12 32h1v1H12zM14 32h1v1H14zM16 32h2v1H16zM21 32h1v1H21zM23 32h2v1H23zM27 32h2v1H27zM31,32 h2v1H31z" shape-rendering="crispEdges"></path></svg>';

/**
 * The crew console on the route being exercised.
 *
 * Sessions are in-memory by design, so every test signs in ON the route it
 * tests rather than navigating afterwards — the same reason the rest of the
 * suite does it this way.
 */
async function crew(page, route, { width = 390, height = 844, instrument = instrumentCamera } = {}) {
  await page.setViewportSize({ width, height });
  await mockApi(page);
  await instrument(page);
  await page.route('**/api/v1/auth/demo', r => r.fulfill({ json: { data: { token: 'fixture-session', user: CREW } } }));
  await page.route('**/api/v1/me', r => r.fulfill({ json: { data: CREW } }));
  await page.goto(APP + route);
  await page.getByRole('button', { name: 'Connexion de développement' }).click();
}

/**
 * Puts a real foreign QR in front of the camera: the canvas stream carries it
 * and qr-scanner decodes it, so the reject branch of accept() runs for real.
 */
async function foreignQrCamera(page) {
  await page.evaluate(async svg => {
    // instrumentCamera has already installed __camera (non-configurable): the
    // probe is reused in place rather than redefined.
    const state = /** @type {any} */ (window).__camera;
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 640;
    const ctx = canvas.getContext('2d'); const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + btoa(svg); await img.decode();
    const draw = () => { ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 640, 640); ctx.drawImage(img, 130, 130, 380, 380); };
    draw(); const timer = setInterval(draw, 80);
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      state.opened++; state.live++;
      const stream = canvas.captureStream(12);
      for (const track of stream.getTracks()) {
        const original = track.stop.bind(track);
        track.stop = () => { state.stopped++; state.live--; original(); };
      }
      return stream;
    } });
  }, FOREIGN_QR.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '));
}

test('the camera is not opened until somebody asks for it', async ({ page }) => {
  await crew(page, '/work/scanner');
  await expect(page.getByRole('button', { name: 'Scanner le QR', exact: true })).toBeVisible();
  // Arriving on the scanner screen is not consent to switch a camera on. A
  // crew phone that starts filming when a tab loads is a battery drain and a
  // recording light nobody asked for.
  expect(await page.evaluate(() => /** @type {any} */ (window).__camera.opened)).toBe(0);

  await page.getByRole('button', { name: 'Scanner le QR', exact: true }).click();
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__camera.opened)).toBe(1);
  await expect(page.getByRole('button', { name: 'Arrêter la caméra' })).toBeVisible();
});

test('stopping, backgrounding and leaving all release the camera', async ({ page }) => {
  await crew(page, '/work/scanner');
  const open = () => page.getByRole('button', { name: 'Scanner le QR', exact: true }).click();
  const live = () => page.evaluate(() => /** @type {any} */ (window).__camera.live);

  // 1. The explicit stop.
  await open();
  await expect.poll(live).toBe(1);
  await page.getByRole('button', { name: 'Arrêter la caméra' }).click();
  await expect.poll(live).toBe(0);

  // 2. The app goes to the background. A driver switching to their maps app
  //    must not leave the camera running on the crew screen behind it.
  await open();
  await expect.poll(live).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(live).toBe(0);

  // 3. Leaving the flow entirely.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });
  await open();
  await expect.poll(live).toBe(1);
  await page.getByRole('navigation').getByRole('button', { name: 'Colis', exact: true }).click();
  await expect.poll(live).toBe(0);
});

test('a torch control is offered only where the device has one', async ({ page }) => {
  await crew(page, '/work/scanner');
  await page.getByRole('button', { name: 'Scanner le QR', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Arrêter la caméra' })).toBeVisible();
  // This instrumented camera reports no capabilities, which is what a laptop
  // webcam and many handsets do. A dead "Allumer la lampe" button at dusk is
  // worse than none: the crew press it, nothing happens, and they stop
  // trusting the screen.
  await expect(page.getByRole('button', { name: /lampe/i })).toHaveCount(0);
});

test('a code that is not ours is explained, and the camera keeps looking', async ({ page }) => {
  await crew(page, '/work/parcels');
  // A stray barcode on a shelf next to the parcel. The crew are holding a
  // phone up to a package; being dropped back to a dead screen for every wrong
  // code makes the scanner unusable in a real store room. The foreign QR is
  // decoded for real by qr-scanner out of the camera stream, so the accept()
  // reject branch is the product code under test, not a mocked event. The
  // camera is armed BEFORE the button opens it: a stream that is already
  // running ignores a later getUserMedia swap.
  await foreignQrCamera(page);
  await page.getByRole('button', { name: 'Scanner le QR', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Arrêter la caméra' })).toBeVisible();
  await expect(page.getByText('QR colis inconnu : utilisez le numéro LRP manuscrit en secours.')).toBeVisible();
  expect(await page.evaluate(() => /** @type {any} */ (window).__camera.live)).toBe(1);
  await expect(page.getByRole('button', { name: 'Arrêter la caméra' })).toBeVisible();

  // And the manual fallback is present without opening anything: no printer,
  // no camera, a number written on the parcel in biro.
  await expect(page.getByLabel('Référence LRP')).toBeVisible();
});

test('crew controls are thumb-sized on the phone they are used on', async ({ page }) => {
  await crew(page, '/work/today');
  // Boarding happens standing at a door with one hand. The WCAG 2.5.8 floor is
  // 24px; 44px is the size a thumb actually hits without looking.
  for (const screen of ['Aujourd’hui', 'Manifeste', 'Scanner', 'Comptant', 'Colis']) {
    await page.getByRole('navigation').getByRole('button', { name: screen, exact: true }).click();
    await page.waitForLoadState('networkidle');
    const small = await page.evaluate(() => [...document.querySelectorAll('main button, main a.btn')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.height < 40;
      })
      .map(el => ({ text: (el.textContent || '').trim().slice(0, 40), height: Math.round(el.getBoundingClientRect().height) })));
    expect(small, `${screen}: controls a thumb cannot reliably hit`).toEqual([]);
  }
});

test('the offline queue shows what is waiting without showing a ticket code', async ({ page }) => {
  await crew(page, '/work/scanner');
  // The screen has to be loaded before the network goes: a crew phone that
  // loses signal mid-shift already has its assignment, which is the whole
  // reason the queue exists.
  await expect(page.getByLabel('Code du billet')).toBeVisible();
  await page.context().setOffline(true);
  const code = 'LR-DEAD-BEEF-CAFE-0001';
  await page.getByLabel('Code du billet').fill(code);
  await page.getByRole('button', { name: 'Valider le billet' }).click();

  // The crew must see that something is waiting, and must not be told it
  // worked — but the passenger's code is not part of that message. A queue
  // panel held up at a station door is read by whoever is standing there.
  await expect(page.getByText(/hors ligne|en attente/i).first()).toBeVisible();
  const shell = await page.locator('main').innerText();
  expect(shell, 'a queued action must not print the passenger’s ticket code').not.toContain(code);
  await page.context().setOffline(false);
});

test('a denied camera names the manual fallback, and granting it later revives the scanner', async ({ page }) => {
  await crew(page, '/work/scanner', { instrument: p => p.addInitScript(() => {
    const state = { opened: 0, stopped: 0, live: 0 };
    Object.defineProperty(window, '__camera', { value: state });
    // qr-scanner retries getUserMedia across constraint fallbacks before it
    // gives up, so a realistic denial rejects every call while it lasts.
    Object.defineProperty(window, '__denyCamera', { value: true, writable: true });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      if (window.__denyCamera) throw new DOMException('Permission denied', 'NotAllowedError');
      state.opened++; state.live++;
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 320;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 320, 320);
      const stream = canvas.captureStream(8);
      for (const track of stream.getTracks()) {
        const original = track.stop.bind(track);
        track.stop = () => { state.stopped++; state.live--; original(); };
        track.getCapabilities = () => ({});
      }
      return stream;
    } });
  }) });
  await page.getByRole('button', { name: 'Scanner le QR', exact: true }).click();
  // The refusal must say what to do and leave the manual path wide open.
  await expect(page.getByText('Caméra indisponible : saisissez le code du billet manuellement.')).toBeVisible();
  expect(await page.evaluate(() => /** @type {any} */ (window).__camera.opened)).toBe(0);
  await expect(page.getByLabel('Code du billet')).toBeVisible();

  // The passenger grants the permission in the browser afterwards: scanning
  // starts working again without reinstalling or signing in again.
  await page.evaluate(() => { window.__denyCamera = false; });
  await page.getByRole('button', { name: 'Scanner le QR', exact: true }).click();
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__camera.opened)).toBe(1);
  await expect(page.getByRole('button', { name: 'Arrêter la caméra' })).toBeVisible();
});

test('a torch control appears where the camera reports one, and toggles', async ({ page }) => {
  await crew(page, '/work/scanner', { instrument: p => p.addInitScript(() => {
    const state = { opened: 0, stopped: 0, live: 0 };
    Object.defineProperty(window, '__camera', { value: state });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      state.opened++; state.live++;
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 320;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 320, 320);
      const stream = canvas.captureStream(8);
      for (const track of stream.getTracks()) {
        const original = track.stop.bind(track);
        track.stop = () => { state.stopped++; state.live--; original(); };
        // qr-scanner decides torch support from getSettings(), not capabilities.
        track.getSettings = () => ({ torch: true });
        track.applyConstraints = async () => {};
      }
      return stream;
    } });
  }) });
  await page.getByRole('button', { name: 'Scanner le QR', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Arrêter la caméra' })).toBeVisible();
  const torch = page.getByRole('button', { name: 'Allumer la lampe' });
  await expect(torch).toBeVisible();
  await torch.click();
  await expect(page.getByRole('button', { name: 'Éteindre la lampe' })).toBeVisible();
});

test('queued offline actions replay by themselves when the app reopens with a connection', async ({ page }) => {
  // A crew phone killed to save battery between towns: the pending boarding
  // from before the outage is in localStorage, and the app comes back with
  // signal. Reopening must drain the queue without a network flap or a tap.
  const owner = id(99);
  const row = { id: 'queued-before-restart', owner, type: 'board',
    payload: { serviceId: id(30), bookingId: id(40), stopSequence: 0, code: 'LR-SEED-SEED-SEED-0001' },
    createdAt: Date.now(), state: 'pending', attempts: 0, error: null };
  await page.addInitScript(({ key, row }) => { localStorage.setItem(key, JSON.stringify([row])); },
    { key: 'lr-driver-queue:' + owner, row });
  let posted = null;
  await page.route('**/api/v1/driver/actions', r => {
    posted = { key: r.request().headers()['idempotency-key'], body: r.request().postDataJSON() };
    return r.fulfill({ json: { data: { id: 'applied', status: 'boarded', serviceId: id(30) } } });
  });
  await crew(page, '/work/scanner');
  await expect.poll(() => posted, 'the queued action must leave without any tap or network toggle').not.toBeNull();
  expect(posted.key).toBe('queued-before-restart');
  expect(posted.body.type).toBe('board');
  // Landed: the pending badge is gone, the row is succeeded, and the ticket
  // code has been scrubbed from the payload.
  await expect(page.getByText(/en attente/i)).toHaveCount(0);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('lr-driver-queue:00000000-0000-4000-8000-000000000099'))[0]);
  expect(stored.state).toBe('succeeded');
  expect(JSON.stringify(stored.payload)).not.toContain('LR-SEED');
});

test('no ticket code stays on screen after signing out of a shared handset', async ({ page }) => {
  await mockApi(page);
  const booking = { id: id(40), status: 'confirmed', departure_city: 'Cotonou', arrival_city: 'Parakou',
    route_name: 'DEMO Cotonou → Parakou', departure_at: DEPARTURE_AT, departure_point_name: 'Godomey – Carrefour',
    departure_point_landmark: null, seat_number: 7, amount_minor: 7500, currency: 'XOF', expires_at: null };
  await page.route('**/api/v1/me/bookings', r => r.fulfill({ json: { data: [booking] } }));
  const code = 'LR-F1XT-URE0-0001';
  await page.route('**/api/v1/bookings/*/ticket', r => r.fulfill({ json: { data: {
    bookingId: id(40), serviceId: id(30), document: null, token: 'LRT1.fixturetoken', manualCode: code } } }));
  await page.goto(APP + '/tickets');
  await page.getByRole('button', { name: 'Connexion de développement' }).click();
  await expect(page.getByRole('heading', { name: 'Cotonou → Parakou' })).toBeVisible();
  await page.getByRole('button', { name: 'Afficher mon billet' }).click();
  await expect(page.locator('.ticket-qr')).toBeVisible();
  await expect(page.getByText(code, { exact: true })).toBeVisible();

  // Sign out: the sign-in panel takes over and nothing of the ticket remains.
  await page.getByRole('button', { name: 'Compte de Compte Démo' }).click();
  await page.getByRole('menuitem', { name: 'Déconnexion' }).click();
  await expect(page.getByRole('button', { name: 'Connexion de développement' })).toBeVisible();
  await expect(page.locator('.ticket-qr')).toHaveCount(0);
  await expect(page.getByText(code, { exact: true })).toHaveCount(0);
});
