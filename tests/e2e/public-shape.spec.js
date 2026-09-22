import { test, expect } from '@playwright/test';

const APP = 'http://127.0.0.1:4173';

// The public product is a travel product. These assertions are about what a
// visitor is offered first, not about styling: trip search leads, professional
// onboarding is reachable but quiet, and Platform Ops is nowhere.
const PUBLIC_PAGES = ['/', '/trips', '/parcels', '/professionnel', '/account'];

test('no public page scrolls sideways on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of PUBLIC_PAGES) {
    await page.goto(APP + path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => {
      const limit = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth <= limit) return null;
      const describe = el => el.tagName.toLowerCase() +
        (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '');
      const scrolls = el => ['auto', 'scroll', 'hidden'].includes(getComputedStyle(el).overflowX);
      const worst = [...document.querySelectorAll('body *')].filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        if (r.right <= limit + 1 && r.left >= -1) return false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (scrolls(p)) return false;
        return true;
      }).map(el => describe(el) + ' @' + Math.round(el.getBoundingClientRect().right));
      return { scrollWidth: document.documentElement.scrollWidth, viewport: limit, worst: worst.slice(0, 3) };
    });
    expect(overflow, `${path}: ` + JSON.stringify(overflow)).toBeNull();
  }
});

test('the public footer offers the traveller’s tasks and never names Platform Ops', async ({ page }) => {
  await page.goto(APP + '/');
  // The footer renders inside <main>, so it is not a contentinfo landmark.
  // Its navigation is a real, labelled landmark, which is what a screen
  // reader user would actually jump to.
  const footer = page.getByRole('navigation', { name: 'Navigation du pied de page' });
  for (const label of ['Rechercher un trajet', 'Mes billets', 'Envoyer un colis', 'Suivre un colis', 'Mon compte', 'Espace professionnel']) {
    await expect(footer.getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  // Platform Ops is granted, never advertised.
  const text = (await page.locator('body').textContent()) ?? '';
  for (const forbidden of ['Exploitation plateforme', 'Platform Ops', 'Vue plateforme']) {
    expect(text).not.toContain(forbidden);
  }
});

test('the home page leads with the trip search, not with operator onboarding', async ({ page }) => {
  await page.goto(APP + '/');
  const search = page.getByRole('heading', { level: 1 });
  await expect(search.first()).toBeVisible();
  // Professional access exists as one quiet line, below the fold of intent.
  const pro = page.getByRole('link', { name: 'Espace professionnel' });
  await expect(pro.first()).toBeVisible();
  const heroBox = await page.locator('h1').first().boundingBox();
  const proBox = await pro.first().boundingBox();
  expect(proBox.y).toBeGreaterThan(heroBox.y);
});

test('the professional entry explains the three situations and stays public', async ({ page }) => {
  await page.goto(APP + '/professionnel');
  await expect(page.getByRole('heading', { name: 'Vous travaillez dans le transport ?' })).toBeVisible();
  for (const title of ['Chauffeur indépendant', 'Compagnie de transport', 'Conducteur ou convoyeur d’une compagnie']) {
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
  }
  // A company's employees are the company's responsibility, and the page says so.
  await expect(page.getByText(/aucune pièce d’identité personnelle à déposer ici/)).toBeVisible();
});
