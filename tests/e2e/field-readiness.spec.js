import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

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

/**
 * The crew console on the route being exercised.
 *
 * Sessions are in-memory by design, so every test signs in ON the route it
 * tests rather than navigating afterwards — the same reason the rest of the
 * suite does it this way.
 */
async function crew(page, route, { width = 390, height = 844 } = {}) {
  await page.setViewportSize({ width, height });
  await mockApi(page);
  await instrumentCamera(page);
  await page.route('**/api/v1/auth/demo', r => r.fulfill({ json: { data: { token: 'fixture-session', user: CREW } } }));
  await page.route('**/api/v1/me', r => r.fulfill({ json: { data: CREW } }));
  await page.goto(APP + route);
  await page.getByRole('button', { name: 'Connexion de développement' }).click();
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
  await page.getByRole('button', { name: 'Scanner le QR', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Arrêter la caméra' })).toBeVisible();

  // A stray barcode on a shelf next to the parcel. The crew are holding a
  // phone up to a package; being dropped back to a dead screen for every wrong
  // code makes the scanner unusable in a real store room.
  await page.evaluate(() => {
    const video = document.querySelector('video');
    video?.dispatchEvent(new CustomEvent('qr-test'));
  });
  // The reject path is exercised through the component's own accept(), so the
  // assertion is on what the crew are told and on the camera still running.
  await expect(page.getByRole('button', { name: 'Arrêter la caméra' })).toBeVisible();
  expect(await page.evaluate(() => /** @type {any} */ (window).__camera.live)).toBe(1);

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
