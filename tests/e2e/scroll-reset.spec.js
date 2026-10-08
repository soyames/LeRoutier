import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

// Where a page starts.
//
// A browser resets the scroll position when it loads a document. A single-page
// app does not — the document never reloads — so tapping a footer link at the
// bottom of one page used to leave the reader at the bottom of the next one,
// looking at ITS footer with the heading they asked for somewhere above the
// viewport. That is the reported bug, and it is reproduced here the way it was
// found: from a real footer link, at the bottom of a real page.
//
// Three other cases share the same machinery and are just as easy to break
// while fixing this one: a link to a fragment must still reach its fragment,
// the Back button must still return somebody to where they were reading, and
// focus has to follow the page so a screen reader is not left in a document
// that no longer exists.
const APP = 'http://127.0.0.1:4173';

/**
 * A link in the footer, which is where the reported navigation happened.
 *
 * Scoped to the footer on purpose: the page body links to the same documents
 * — the terms are linked from an article about parcels, for one — and clicking
 * the wrong one would test a different journey than the one that broke.
 */
const footerLink = (page, name) => page.locator('footer.site-footer').getByRole('link', { name, exact: true });

/**
 * Where the page is, once it has settled.
 *
 * The reset happens in an effect — one render after the address changes — so
 * reading `scrollY` the instant the URL matches is a race. A quiet machine
 * always loses it, and a loaded CI runner wins it, which is how a passing
 * suite and a failing pipeline described the same behaviour. Polling asserts
 * the property that matters (the reader ends at the top) instead of the
 * instant at which it became true.
 */
const atTop = page => expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 }).toBeLessThan(4);

/**
 * True when the element is where a reader would say it is: on screen, and not
 * under the fold.
 *
 * The tolerance at the top is deliberate. `scrollIntoView` aligns an element's
 * own box with the top of the viewport, and the page's own rhythm — a line of
 * margin the element does not own — can leave it a few pixels above. What the
 * assertion is about is whether somebody who clicked a link is looking at the
 * thing they clicked it for, not whether two numbers agree to the pixel.
 */
async function isInViewport(locator) {
  const box = await locator.boundingBox();
  const height = await locator.evaluate(() => window.innerHeight);
  if (!box) return false;
  return box.y >= -40 && box.y < height / 2;
}

test('a footer link from the bottom of a long page starts the new page at its top', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP + '/about');

  // Read to the bottom, exactly as somebody does before they reach for a legal
  // link: the footer is only clickable once it is on screen.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled, 'the page is long enough for this to be a real test').toBeGreaterThan(400);

  await footerLink(page, 'Conditions d’utilisation').click();
  await expect(page).toHaveURL(APP + '/terms');

  // The destination's own heading, on screen, without anybody scrolling up.
  const heading = page.getByRole('heading', { name: 'Conditions d’utilisation et de réservation' });
  await expect(heading).toBeVisible();
  expect(await isInViewport(heading), 'the new page starts at its top').toBe(true);
  await atTop(page);
});

test('every footer route link lands at the top, not at the previous page’s bottom', async ({ page }) => {
  await mockApi(page);
  // The footer is one row of links to five different pages; the bug was in the
  // navigation, not in the link to /terms that happened to be reported.
  for (const [name, path] of [['Conditions d’utilisation', '/terms'], ['Confidentialité', '/privacy'],
    ['Mentions légales', '/legal'], ['Cookies et technologies', '/cookies'], ['À propos de LeRoutier', '/about']]) {
    await page.goto(APP + '/about');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await footerLink(page, name).click();
    await expect(page).toHaveURL(APP + path);
    await atTop(page);
  }
});

test('a link to a fragment still reaches the fragment', async ({ page }) => {
  await mockApi(page);
  // Resetting to the top of a page somebody asked for the middle of is the
  // same defect pointing the other way.
  await page.goto(APP + '/#pro-title');
  const section = page.getByRole('heading', { name: /Vous transportez déjà des voyageurs/ });
  await expect(section).toBeVisible();
  await expect.poll(() => isInViewport(section), { message: 'the fragment is where the reader was sent' }).toBe(true);
  // And the page did not then wipe it by jumping to the top.
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test('going back returns the reader to where they were', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP + '/about');
  await page.evaluate(() => window.scrollTo(0, 700));
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(600);

  await footerLink(page, 'Conditions d’utilisation').click();
  await expect(page).toHaveURL(APP + '/terms');
  await atTop(page);

  await page.goBack();
  await expect(page).toHaveURL(APP + '/about');
  // A single-page app that always jumps to the top has quietly taken away the
  // one thing the Back button is for.
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(600);
});

test('focus follows the page, so a keyboard reader is not left in the old one', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP + '/about');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await footerLink(page, 'Conditions d’utilisation').click();
  await expect(page).toHaveURL(APP + '/terms');

  // The main landmark takes focus on arrival. It is also what the skip link at
  // the top of every page has always pointed at.
  await expect(page.locator('#lr-content')).toBeFocused();
  // And taking focus did not scroll somewhere else: the top is still the top.
  await atTop(page);
});

test('a route that changes the page title also starts at the top', async ({ page }) => {
  await mockApi(page);
  // The footer links live above <App>, in their own shell, and the app's pages
  // live inside it — which is exactly why the fix cannot belong to either.
  await page.goto(APP + '/terms');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await footerLink(page, 'Bus et transport au Bénin').click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(4);
});
