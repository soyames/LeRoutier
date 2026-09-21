import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

const APP = 'http://127.0.0.1:4173';

const publicPages = [
  ['/', /Transport interurbain et colis au Bénin/, /Où allez-vous \?/],
  ['/bus-benin', /Bus et transport interurbain au Bénin/, /Bus et transport interurbain au Bénin/],
  ['/cotonou-parakou', /Cotonou – Parakou/, /Transport Cotonou – Parakou/],
  ['/cotonou-porto-novo', /Cotonou – Porto-Novo/, /Transport Cotonou – Porto-Novo/],
  ['/cotonou-bohicon', /Cotonou – Bohicon/, /Transport Cotonou – Bohicon/],
  ['/cotonou-natitingou', /Cotonou – Natitingou/, /Transport Cotonou – Natitingou/],
  ['/colis-benin', /Envoi et suivi de colis/, /Envoi et suivi de colis au Bénin/],
  ['/gares-routieres-benin', /Gares routières/, /Gares routières et points d’embarquement au Bénin/],
  ['/transporteurs-benin', /Chauffeurs et compagnies/, /Chauffeurs indépendants et compagnies de transport au Bénin/],
];

test.describe('SEO foundations', () => {
  for (const [path, title, h1] of publicPages) {
    test(`${path} has unique indexable metadata and one descriptive H1`, async ({ page }) => {
      await mockApi(page);
      await page.goto(APP + path);
      await expect(page).toHaveTitle(title);
      await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /Bénin|LeRoutier/);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /^index,follow/);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://leroutier.app${path === '/' ? '/' : path}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(h1);
    });
  }

  test('app-only and authenticated surfaces are not indexed', async ({ page }) => {
    await mockApi(page);
    for (const path of ['/trips', '/checkout', '/tickets', '/account', '/work/today', '/ops/today']) {
      await page.goto(APP + path);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,follow');
    }
  });

  test('home links crawlers to useful public topic and route pages', async ({ page }) => {
    await mockApi(page);
    await page.goto(APP + '/');
    for (const href of ['/bus-benin', '/cotonou-parakou', '/colis-benin', '/gares-routieres-benin', '/transporteurs-benin']) {
      await expect(page.locator(`a[href="${href}"]`)).toBeVisible();
    }
  });

  test('robots and sitemap expose only the public discovery surface', async ({ request }) => {
    const robots = await (await request.get(APP + '/robots.txt')).text();
    expect(robots).toContain('Sitemap: https://leroutier.app/sitemap.xml');
    const sitemap = await (await request.get(APP + '/sitemap.xml')).text();
    expect(sitemap).toContain('https://leroutier.app/cotonou-parakou');
    expect(sitemap).toContain('https://leroutier.app/colis-benin');
    expect(sitemap).not.toContain('/work/');
    expect(sitemap).not.toContain('/ops/');
    expect(sitemap).not.toContain('/checkout');
  });
});
