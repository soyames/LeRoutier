import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

// The branded loading treatment, and the page transitions.
//
// Three properties this suite exists to hold, in order of how easy they are to
// break by accident:
//
//   1. It never flashes. A wait shorter than the reveal delay shows nothing at
//      all, so an answer that arrives immediately does not blink a logo.
//   2. It is announced, and it is decorative — a screen reader is told the
//      region is busy, and the mark itself is hidden from it.
//   3. It takes nothing away. It sits in the layout rather than over it, so the
//      rest of the page keeps working while one region loads.
//
// The mark is the LeRoutier logo the app already has. Nothing in these tests
// asserts a second one, because there is not one.
const APP = 'http://127.0.0.1:4173';
const MARK = '.lr-loader-mark';

/** Delay a request that something else already fulfils, so the wait is real. */
const slowDown = (page, pattern, ms) => page.route(pattern, async route => {
  await new Promise(resolve => setTimeout(resolve, ms));
  return route.fallback();
});

async function chooseTestOffer(page) {
  await mockApi(page);
  await page.goto(APP + '/trips');
  await page.getByRole('radio', { name: 'Choisir une ville' }).click();
  await page.getByLabel('Ville de départ').click();
  await page.getByLabel('Ville de départ').fill('Cotonou');
  await page.getByLabel('Ville de départ').press('Enter');
  await page.getByLabel('Destination').click();
  await page.getByLabel('Destination').fill('Parakou');
  await page.getByLabel('Destination').press('Enter');
  await page.getByRole('button', { name: 'Rechercher un trajet' }).click();
  await page.getByRole('button', { name: 'Chauffeurs indépendants' }).click();
  await page.getByRole('button', { name: 'Choisir' }).first().click();
  await page.getByLabel('Nom et prénom du voyageur principal').fill('Awa Sossou');
  await page.getByLabel('Numéro de téléphone').fill('97000042');
}

test('the mark never appears before its delay, so a quick wait cannot flash it', async ({ page }) => {
  await chooseTestOffer(page);
  // When the reveal happens is recorded relative to the click, rather than
  // asserting that it never happens on a fast machine. The property that makes
  // a fast request safe is the DELAY: a wait shorter than it is over before the
  // mark can appear, whatever the machine is doing. Measuring the deadline is
  // deterministic; measuring whether this particular run beat it is not.
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__revealOffsets = [];
    new MutationObserver(mutations => {
      for (const m of mutations) {
        const target = /** @type {Element} */ (m.target);
        if (target.matches?.('[data-visible]') && w.__clickedAt != null) {
          w.__revealOffsets.push(performance.now() - w.__clickedAt);
        }
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-visible'] });
  });
  await page.evaluate(() => { /** @type {any} */ (window).__clickedAt = performance.now(); });
  await page.getByRole('button', { name: /Continuer vers le paiement/ }).click();
  await expect(page).toHaveURL(/\/tickets\//, { timeout: 15000 });
  const offsets = await page.evaluate(() => /** @type {number[]} */ (/** @type {any} */ (window).__revealOffsets));
  // 180ms is the delay; 140 leaves room for clock granularity without letting a
  // genuinely instant reveal through.
  for (const offset of offsets) expect(offset).toBeGreaterThanOrEqual(140);
});

test('a wait that is not over quickly shows the mark', async ({ page }) => {
  await chooseTestOffer(page);
  await slowDown(page, '**/api/v1/bookings', 3000);
  await page.getByRole('button', { name: /Continuer vers le paiement/ }).click();
  // A real wait gets the mark. That it does not arrive instantly — the other
  // half of the delay — is asserted in the test above, where the response is
  // fast and the observer proves nothing was ever revealed.
  await expect(page.locator(`${MARK}[data-visible]`)).toHaveCount(1, { timeout: 3000 });
  await expect(page.getByText('Création de votre réservation…')).toBeAttached();
  await expect(page).toHaveURL(/\/tickets\//, { timeout: 15000 });
});

test('the mark is announced to a screen reader and hidden from it at the same time', async ({ page }) => {
  await chooseTestOffer(page);
  await slowDown(page, '**/api/v1/bookings', 2500);
  await page.getByRole('button', { name: /Continuer vers le paiement/ }).click();
  const loader = page.locator('.lr-loader');
  await expect(loader).toHaveAttribute('role', 'status');
  await expect(loader).toHaveAttribute('aria-busy', 'true');
  // The words carry the meaning; the picture is decoration.
  await expect(loader.locator('.sr-only')).toHaveText('Création de votre réservation…');
  await expect(page.locator(MARK)).toHaveAttribute('aria-hidden', 'true');
  // The logo is the one the app already uses, at its own aspect ratio.
  const box = await page.locator('.lr-loader-logo').boundingBox();
  expect(Math.abs(box.width - box.height)).toBeLessThan(1.5);
  await expect(page).toHaveURL(/\/tickets\//, { timeout: 15000 });
});

test('the mark sits in the page rather than over it', async ({ page }) => {
  await chooseTestOffer(page);
  await slowDown(page, '**/api/v1/bookings', 2500);
  await page.getByRole('button', { name: /Continuer vers le paiement/ }).click();
  await expect(page.locator(`${MARK}[data-visible]`)).toHaveCount(1, { timeout: 2000 });
  const shape = await page.locator('.lr-loader').evaluate(el => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return { position: style.position, pointerEvents: style.pointerEvents, coversViewport: rect.height >= window.innerHeight - 1 };
  });
  // No overlay, no scrim, nothing inert: a loader that covers the page is an
  // obstacle, and the region it belongs to is the only thing that is waiting.
  expect(shape.position).toBe('static');
  expect(shape.pointerEvents).not.toBe('none');
  expect(shape.coversViewport).toBe(false);
  await expect(page).toHaveURL(/\/tickets\//, { timeout: 15000 });
});

test('reduced motion keeps the mark and removes the movement', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await chooseTestOffer(page);
  await slowDown(page, '**/api/v1/bookings', 2500);
  await page.getByRole('button', { name: /Continuer vers le paiement/ }).click();
  const mark = page.locator(MARK);
  await expect(page.locator(`${MARK}[data-visible]`)).toHaveCount(1, { timeout: 2000 });
  const motion = await mark.evaluate(el => {
    const style = getComputedStyle(el);
    return { name: style.animationName, duration: parseFloat(style.animationDuration), opacity: Number(style.opacity) };
  });
  // Still shown — it is the only sign the region is busy — but holding still,
  // and fully opaque rather than stranded at the dim end of a breath it can no
  // longer complete.
  expect(motion.name).toBe('none');
  expect(motion.duration).toBeLessThanOrEqual(0.01);
  expect(motion.opacity).toBe(1);
  await expect(page).toHaveURL(/\/tickets\//, { timeout: 15000 });
});

test('the first thing anybody meets on a cold load is the mark, not a sentence', async ({ page }) => {
  await mockApi(page);
  // The wait before a sign-in surface can be drawn at all: the published
  // sign-in providers have not answered yet, so nothing can be offered and
  // nothing is known. It used to be the words "Connexion en cours…" with
  // nothing above them.
  await slowDown(page, '**/api/v1/auth/config', 2500);
  await page.goto(APP + '/account');
  await expect(page.locator(`${MARK}[data-visible]`)).toHaveCount(1, { timeout: 3000 });
  // The words are still there, for the people who need them — as the label of
  // a status region rather than as a paragraph.
  await expect(page.locator('.lr-loader[role="status"] .sr-only')).toHaveText('Connexion en cours…');
  // And the mark is the app's own logo at its own aspect ratio.
  const box = await page.locator('.lr-loader-logo').boundingBox();
  expect(Math.abs(box.width - box.height)).toBeLessThan(1.5);
});

test('the bootstrap mark never flashes on a fast load', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP + '/account');
  // The config answers immediately here, so the sign-in form is what appears —
  // and the mark must not have blinked on the way past.
  await expect(page.getByText('Bienvenue sur LeRoutier')).toBeVisible();
  await expect(page.locator(`${MARK}[data-visible]`)).toHaveCount(0);
});

test('a route change is one short entrance on the page container', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP + '/trips');
  const main = page.locator('main.lr-main');
  await expect(main).toHaveClass(/lr-enter/);
  const motion = await main.evaluate(el => {
    const style = getComputedStyle(el);
    return { name: style.animationName, duration: parseFloat(style.animationDuration) };
  });
  expect(motion.name).toBe('lr-rise');
  expect(motion.duration).toBeLessThanOrEqual(0.4);
  // Navigating gives the container a fresh entrance rather than leaving the
  // previous page's animation behind.
  await page.goto(APP + '/');
  await expect(page.locator('main.lr-main')).toHaveClass(/lr-enter/);
});

test('reduced motion shortens the page entrance rather than blocking it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page);
  await page.goto(APP + '/trips');
  const duration = await page.locator('main.lr-main')
    .evaluate(el => parseFloat(getComputedStyle(el).animationDuration));
  expect(duration).toBeLessThanOrEqual(0.01);
  // The page is still there and still usable — reduced motion removes the
  // movement, never the content.
  await expect(page.getByRole('button', { name: 'Rechercher un trajet' })).toBeVisible();
});
