import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockApi } from './api-fixture.js';

// Accessibility, checked mechanically and then by behaviour.
//
// An automated pass catches roughly a third of real barriers, so this file does
// both: axe over every significant screen, and explicit assertions for the
// things axe cannot see — that a keyboard can actually reach the primary
// action, that focus is visible, that a status change is announced.
//
// LeRoutier's audience makes this concrete rather than aspirational: the
// product is used one-handed, on a phone, often in bright sunlight, sometimes
// by someone who is not a confident reader. Contrast and target size are not
// compliance details here, they are whether the thing works at the station.
const APP = 'http://127.0.0.1:4176';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const me = extra => ({ id: id(99), display_name: 'Test Identity', needs_profile: false, ...extra });
const PASSENGER = me({ role: 'passenger', operator_id: null });
const DRIVER = me({ role: 'driver', operator_type: 'company', operator_id: id(1), verification_status: 'verified' });
const OPS = me({ role: 'ops', operator_type: 'company', operator_id: id(1), verification_status: 'verified' });

const signInAs = identity => async page => {
  await page.route('**/api/v1/auth/demo', r => r.fulfill({ json: { data: { token: 'fixture-session', user: identity } } }));
  await page.route('**/api/v1/me', r => r.fulfill({ json: { data: identity } }));
};

async function open(page, route, identity = null) {
  await mockApi(page);
  if (identity) await signInAs(identity)(page);
  await page.goto(APP + route);
  if (identity) await page.getByRole('button', { name: 'Connexion de développement' }).click();
  // Let lazily-rendered content settle before the tree is analysed.
  await page.waitForLoadState('networkidle').catch(() => {});
}

/** WCAG 2.1 A and AA, which is the level this product targets. */
const audit = page => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();

const describeViolations = violations => violations
  .map(v => `${v.id} (${v.impact}) — ${v.nodes.length}×: ${v.nodes[0]?.target?.join(' ')}`).join('\n  ');

const PUBLIC_SCREENS = [
  ['public home', '/'],
  ['trip search', '/trips'],
  ['public parcel tracking', '/parcels/track'],
  ['operator onboarding', '/onboarding'],
];

for (const [name, route] of PUBLIC_SCREENS) {
  test(`${name} has no WCAG A/AA violations`, async ({ page }) => {
    await open(page, route);
    const { violations } = await audit(page);
    expect(violations, `\n  ${describeViolations(violations)}\n`).toEqual([]);
  });
}

const SIGNED_IN_SCREENS = [
  ['passenger tickets', '/tickets', PASSENGER],
  ['notification centre', '/notifications', PASSENGER],
  ['account', '/account', PASSENGER],
  ['crew today', '/work/today', DRIVER],
  ['crew manifest', '/work/manifest', DRIVER],
  ['ops today', '/ops/today', OPS],
  ['ops services', '/ops/services', OPS],
];

for (const [name, route, identity] of SIGNED_IN_SCREENS) {
  test(`${name} has no WCAG A/AA violations`, async ({ page }) => {
    await open(page, route, identity);
    const { violations } = await audit(page);
    expect(violations, `\n  ${describeViolations(violations)}\n`).toEqual([]);
  });
}

// ------------------------------------------------- what axe cannot check ----

test('a keyboard alone reaches the primary action on the landing screen', async ({ page }) => {
  await open(page, '/');
  const search = page.getByRole('button', { name: 'Rechercher' });
  await expect(search).toBeVisible();

  // Tab until the primary action holds focus. Bounded, so a focus trap fails
  // this test rather than hanging it.
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await search.evaluate(el => el === document.activeElement);
  }
  expect(reached, 'the search button was not reachable by keyboard within 40 tabs').toBe(true);
});

test('a skip link is the first thing a keyboard finds', async ({ page }) => {
  await open(page, '/trips');
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return { text: el?.textContent?.trim() ?? '', href: el?.getAttribute('href') ?? '' };
  });
  expect(focused.text).toMatch(/Aller au contenu/i);
  expect(focused.href).toBe('#lr-content');
});

test('focus is visible wherever it lands', async ({ page }) => {
  await open(page, '/trips');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  // A focused control must be distinguishable by something other than colour
  // alone — an outline, a ring, or a box-shadow.
  const visible = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
    return outline || style.boxShadow !== 'none';
  });
  expect(visible, 'the focused element had no visible focus indicator').toBe(true);
});

test('every screen has one main landmark and a page heading', async ({ page }) => {
  for (const [, route] of PUBLIC_SCREENS) {
    await open(page, route);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('heading').first()).toBeVisible();
  }
});

test('loading and error states are announced, not just drawn', async ({ page }) => {
  await mockApi(page);
  // A failing search must reach a screen reader, not only the eye.
  await page.route('**/api/v1/services?*', r => r.fulfill({ status: 503, json: { error: { code: 'X', message: 'indisponible' } } }));
  await page.goto(APP + '/trips');
  const announced = page.locator('[role="status"], [role="alert"], [aria-live]');
  await expect(announced.first()).toBeVisible();
});

test('touch targets on the primary navigation are large enough to hit', async ({ page }) => {
  await open(page, '/trips');
  const items = page.getByRole('navigation').getByRole('button');
  const count = await items.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const box = await items.nth(i).boundingBox();
    if (!box) continue;
    // 44 px is the WCAG 2.1 AAA target; 24 px is the AA floor. A bus station
    // is not a desk, so this asserts the AA floor with room to spare.
    expect(box.height, `navigation item ${i} is only ${Math.round(box.height)}px tall`).toBeGreaterThanOrEqual(36);
  }
});
