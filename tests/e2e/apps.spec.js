import { test, expect } from '@playwright/test';

const apps = [
  {
    name: 'passenger', port: 4173, role: 'Voyageur', title: 'Voyageur',
    routes: [
      ['/', 'Voyagez entre les villes du Bénin, simplement.'],
      ['/trips', 'Départs disponibles'],
      ['/tickets', 'Mes billets'],
      ['/stations', "Gares & points d'arrêt"],
      ['/tracking', 'Suivi de mon trajet'],
      ['/account', 'Mon compte'],
    ],
    nav: ['Billets', '/tickets', 'Trajets', '/trips'],
  },
  {
    name: 'driver', port: 4174, role: 'Chauffeur', title: 'Chauffeur',
    routes: [
      ['/', 'Scanner billet passager'],
      ['/route', 'Scanner billet passager'],
      ['/profile', 'Affectation véhicule'],
    ],
    nav: ['Profil & bord', '/profile', 'Feuille de route', '/route'],
  },
  {
    name: 'ops', port: 4175, role: 'Régulation', title: 'Régulation',
    routes: [['/', 'Unités roulantes en surveillance'], ['/fleet/live', 'Unités roulantes en surveillance']],
  },
];

for (const app of apps) {
  test.describe(app.name, () => {
    test.use({ baseURL: `http://127.0.0.1:${app.port}` });

    test('production routes render shared UI and survive reload', async ({ page }) => {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error' && !message.text().includes('net::ERR_')) errors.push(message.text());
      });
      for (const [path, heading] of app.routes) {
        const response = await page.goto(path + '?smoke=1');
        expect(response.status()).toBe(200);
        await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
        await expect(page.locator('.lr-role-strip > span')).toHaveText(app.role);
        await expect(page).toHaveTitle(`LeRoutier · ${app.title}`);
        await expect(page.locator('.lr-logo')).toBeVisible();
        await expect(page.locator('.card').first()).toHaveCSS('border-radius', '18px');
        expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(page.viewportSize().width);
        await page.reload();
        await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      }
      expect(errors).toEqual([]);
    });

    if (app.nav) {
      test('navigation updates URLs, handles history and unknown paths', async ({ page }) => {
        const [firstLabel, firstPath, secondLabel, secondPath] = app.nav;
        await page.goto('/');
        const nav = page.getByRole('navigation');
        await nav.getByRole('button', { name: firstLabel, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(firstPath + '$'));
        await expect(nav.getByRole('button', { name: firstLabel, exact: true })).toHaveAttribute('aria-current', 'page');
        await nav.getByRole('button', { name: secondLabel, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(secondPath + '$'));
        await page.goBack();
        await expect(page).toHaveURL(new RegExp(firstPath + '$'));
        await expect(nav.getByRole('button', { name: firstLabel, exact: true })).toHaveAttribute('aria-current', 'page');
        await page.goForward();
        await expect(page).toHaveURL(new RegExp(secondPath + '$'));
        await page.goto('/unknown/nested/path');
        await expect(page).toHaveURL(`http://127.0.0.1:${app.port}/`);
        await page.goto(firstPath + '/');
        await expect(nav.getByRole('button', { name: firstLabel, exact: true })).toHaveAttribute('aria-current', 'page');
      });
    }
  });
}
