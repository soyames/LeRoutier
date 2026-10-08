import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

// Where a traveller can go, and what tells them where they are.
//
// A phone gets a bar at the bottom with exactly four destinations; a wide
// screen keeps the header row it always had. The two must agree on names and
// on routes — a destination that moves when the screen changes width is a
// destination people have to learn twice — and the fourth slot belongs to the
// traveller, not to the professional door that shares the product with them.
//
// Two things here are easy to get wrong and invisible in a screenshot: a bar
// that sits on top of the content beneath it, and one whose labels don't fit
// on a small phone. Both are measured rather than eyeballed.
const APP = 'http://127.0.0.1:4173';
const TABS = ['Réservations', 'Trajets', 'Colis', 'Profil'];
/** The four widths a phone is actually held at, narrowest first. */
const WIDTHS = [320, 360, 390, 430];

const bottomBar = page => page.getByRole('navigation', { name: 'Navigation voyageur' });
const headerNav = page => page.getByRole('navigation', { name: 'Navigation principale' });

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the four traveller destinations are on screen, in order, with their labels', async ({ page }) => {
    await mockApi(page);
    await page.goto(APP + '/trips');

    const bar = bottomBar(page);
    await expect(bar).toBeVisible();
    // Links, not buttons: a destination a traveller cannot open in a new tab is
    // a picture of a destination.
    await expect(bar.getByRole('link')).toHaveCount(4);
    await expect(bar.getByRole('link')).toHaveText(TABS);
    await expect(bar.getByRole('link', { name: 'Réservations' })).toHaveAttribute('href', '/trips');
    await expect(bar.getByRole('link', { name: 'Trajets' })).toHaveAttribute('href', '/tracking');
    await expect(bar.getByRole('link', { name: 'Colis' })).toHaveAttribute('href', '/parcels');
    await expect(bar.getByRole('link', { name: 'Profil' })).toHaveAttribute('href', '/account');
    // The professional door shares the product with travellers and does NOT
    // share a quarter of their bar. It is in the drawer, one tap away.
    await expect(bar.getByRole('link', { name: 'Professionnels' })).toHaveCount(0);
  });

  test('the bar says which destination is open, and moves when another is chosen', async ({ page }) => {
    await mockApi(page);
    for (const [label, path, title] of [['Trajets', '/tracking', 'Trajets'], ['Colis', '/parcels', 'Colis'], ['Profil', '/account', 'Mon compte']]) {
      await page.goto(APP + path);
      const current = bottomBar(page).getByRole('link', { name: label });
      // `aria-current="page"` is the whole of "where am I" for a screen reader,
      // and it is also what the visible highlight is keyed on.
      await expect(current).toHaveAttribute('aria-current', 'page');
      for (const other of TABS.filter(t => t !== label)) {
        await expect(bottomBar(page).getByRole('link', { name: other })).not.toHaveAttribute('aria-current', 'page');
      }
      expect(title).toBeTruthy();
    }
  });

  test('tapping a tab goes where the header goes on a wide screen', async ({ page }) => {
    await mockApi(page);
    await page.goto(APP + '/trips');
    await bottomBar(page).getByRole('link', { name: 'Trajets' }).click();
    await expect(page).toHaveURL(APP + '/tracking');
    await bottomBar(page).getByRole('link', { name: 'Réservations' }).click();
    await expect(page).toHaveURL(APP + '/trips');
  });

  test('bought tickets are one tap from the Réservations tab, without an account', async ({ page }) => {
    await mockApi(page);
    // A guest who bought on this browser — no session of any kind.
    await page.addInitScript(() => window.localStorage.setItem('leroutier:guest-access', 'guest-token-from-a-purchase'));
    await page.route('**/api/v1/me/bookings', r => r.fulfill({ json: { data: [] } }));
    await page.goto(APP + '/trips');

    // The ticket history is not behind the signup wall the product no longer
    // has, and it is not buried either.
    await page.getByRole('button', { name: 'Voir mes billets' }).click();
    await expect(page).toHaveURL(APP + '/tickets');
    await expect(page.getByText('Mes billets')).toBeVisible();
  });

  test('the bar clears the content, the footer, and the help button at every phone width', async ({ page }) => {
    await mockApi(page);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 720 });
      // A long page that ends in the footer, which is the hardest case: the bar
      // is fixed, so the last thing on the page is what it would cover.
      await page.goto(APP + '/terms');
      const bar = await bottomBar(page).boundingBox();
      expect(bar, `the bar is drawn at ${width}px`).toBeTruthy();
      // Nothing wider than the screen: a label that overflows turns the whole
      // app into a horizontally scrolling one.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `no horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);

      // Every label is fully drawn, not clipped to "Réservat…".
      const clipped = await bottomBar(page).locator('a span').evaluateAll(nodes =>
        nodes.filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.textContent));
      expect(clipped, `labels must fit at ${width}px`).toEqual([]);

      // The end of the page is above the bar, not underneath it.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const link = await page.getByRole('link', { name: 'Conditions d’utilisation' }).boundingBox();
      expect(link.y + link.height, `the footer clears the bar at ${width}px`).toBeLessThanOrEqual(bar.y + 1);

      // And the help button, which shares that corner, sits above it too.
      const launcher = await page.locator('.assistant-launcher').boundingBox();
      expect(launcher.y + launcher.height, `the help button clears the bar at ${width}px`).toBeLessThanOrEqual(bar.y + 1);
    }
  });

  test('the legal and support links are all still reachable', async ({ page }) => {
    await mockApi(page);
    await page.goto(APP + '/terms');
    const bar = await bottomBar(page).boundingBox();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    // Reachable means clickable: a link under a fixed bar is not.
    for (const name of ['Mentions légales', 'Confidentialité', 'Cookies et technologies']) {
      const link = await page.getByRole('link', { name }).boundingBox();
      expect(link.y + link.height, `${name} is not under the bar`).toBeLessThanOrEqual(bar.y + 1);
    }
    await page.getByRole('link', { name: 'Mentions légales' }).click();
    await expect(page).toHaveURL(APP + '/legal');
  });
});

test.describe('on a wide screen', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('the header keeps its four destinations, renamed and in place', async ({ page }) => {
    await mockApi(page);
    await page.goto(APP + '/trips');
    const nav = headerNav(page);
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link')).toHaveText(['Réservations', 'Colis', 'Trajets', 'Professionnels']);
    await expect(nav.getByRole('link', { name: 'Réservations' })).toHaveAttribute('href', '/trips');
    await expect(nav.getByRole('link', { name: 'Trajets' })).toHaveAttribute('href', '/tracking');
    await expect(nav.getByRole('link', { name: 'Colis' })).toHaveAttribute('href', '/parcels');
    await expect(nav.getByRole('link', { name: 'Professionnels' })).toHaveAttribute('href', '/professionnel');
    // The phone's bar is not on a desktop, in any form.
    await expect(bottomBar(page)).toHaveCount(0);
  });

  test('the professional door is still one click away on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await page.goto(APP + '/trips');
    await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
    await page.getByRole('navigation', { name: 'Menu principal' }).getByRole('link', { name: 'Espace professionnel' }).click();
    await expect(page).toHaveURL(APP + '/professionnel');
  });
});
