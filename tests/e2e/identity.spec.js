import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

// Production identity and authorisation behaviour: the states a real pilot user
// can land in, and the ones they must never be able to reach.
const APP = 'http://127.0.0.1:4176';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const IDENTITY = id(99);
const me = extra => ({ id: IDENTITY, display_name: 'Test Identity', needs_profile: false, ...extra });
const signInAs = identity => async page => {
  await page.route('**/api/v1/auth/demo', r => r.fulfill({ json: { data: { token: 'fixture-session', user: identity } } }));
  await page.route('**/api/v1/me', r => r.fulfill({ json: { data: identity } }));
};
const login = page => page.getByRole('button', { name: 'Connexion de développement' }).click();

// ---------------------------------------------------- auth availability ----
test('with no identity provider the app fails closed and says so', async ({ page }) => {
  await mockApi(page);
  // Production shape: no OIDC block, no demo login.
  await page.route('**/api/v1/auth/config', r => r.fulfill({ json: { data: { demoLogin: false, oidc: null } } }));
  await page.goto(APP + '/account');
  await expect(page.getByRole('button', { name: 'Connexion indisponible' })).toBeDisabled();
  await expect(page.getByText(/connexion sécurisée n’est pas encore configurée/)).toBeVisible();
  // No password or code entry is ever offered as a fallback.
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByText(/mot de passe|code de vérification/i)).toHaveCount(0);
});

test('public browsing still works while sign-in is unavailable', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/v1/auth/config', r => r.fulfill({ json: { data: { demoLogin: false, oidc: null } } }));
  await page.goto(APP + '/trips');
  await expect(page.getByRole('button', { name: 'Rechercher un trajet' })).toBeVisible();
  await page.getByLabel('Destination').click(); await page.getByLabel('Destination').fill('Cotonou'); await page.getByLabel('Destination').press('Enter');
  await page.getByRole('button', { name: 'Rechercher un trajet' }).click();
  // The search ran without an account; the planner asks for the position only
  // now that the search needs it.
  await expect(page.getByRole('button', { name: 'Utiliser ma position actuelle' })).toBeVisible();
  await page.goto(APP + '/parcels/track');
  await expect(page.getByRole('heading', { name: /Suivre un colis/ })).toBeVisible();
});

// ------------------------------------------------------- identity states ----
test('a new passenger is asked to complete their profile before booking', async ({ page }) => {
  await mockApi(page);
  await signInAs(me({ role: 'passenger', needs_profile: true, display_name: '' }))(page);
  await page.goto(APP + '/trips');
  await login(page);
  await page.getByLabel('Départ', { exact: true }).selectOption('place');
  await page.getByLabel('Ville de départ').click(); await page.getByLabel('Ville de départ').fill('Cotonou'); await page.getByLabel('Ville de départ').press('Enter');
  await page.getByLabel('Destination').click(); await page.getByLabel('Destination').fill('Parakou'); await page.getByLabel('Destination').press('Enter');
  await page.getByRole('button', { name: 'Rechercher un trajet' }).click();
  // The trip cannot be taken until the profile exists, and the button says why.
  await expect(page.getByRole('button', { name: 'Complétez votre profil' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complétez votre profil' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Complétez votre profil' })).toBeVisible();
});

test('a disabled account is explained in product language, not API language', async ({ page }) => {
  await mockApi(page);
  await signInAs(me({ role: 'driver', operator_type: 'company', operator_id: id(1), verification_status: 'verified' }))(page);
  // The server refuses an inactive identity on every data call.
  await page.route('**/api/v1/driver/service', r => r.fulfill({ status: 403,
    json: { error: { code: 'ACCOUNT_DISABLED', message: 'This account is inactive. Contact an administrator.' } } }));
  await page.goto(APP + '/work/today');
  await login(page);
  await expect(page.getByText(/Ce compte est désactivé/)).toBeVisible();
  // The developer-facing English message never reaches the user.
  await expect(page.getByText('This account is inactive. Contact an administrator.')).toHaveCount(0);
});

test('an operator awaiting verification is told what it can and cannot do yet', async ({ page }) => {
  await mockApi(page);
  await signInAs(me({ role: 'driver', operator_type: 'independent', operator_id: id(1),
    owner_user_id: IDENTITY, verification_status: 'pending_verification' }))(page);
  await page.goto(APP + '/work/today');
  await login(page);
  await expect(page.getByText('Vérification en cours').first()).toBeVisible();
  await expect(page.getByText(/dès validation/)).toBeVisible();
  // The raw enum is never shown.
  await expect(page.getByText('pending_verification')).toHaveCount(0);
});

test('a rejected operator is told the outcome and the way forward', async ({ page }) => {
  await mockApi(page);
  await signInAs(me({ role: 'driver', operator_type: 'independent', operator_id: id(1),
    owner_user_id: IDENTITY, verification_status: 'rejected' }))(page);
  await page.goto(APP + '/work/today');
  await login(page);
  await expect(page.getByText('Dossier refusé').first()).toBeVisible();
  await expect(page.getByText(/Mettez à jour vos informations ou contactez LeRoutier/)).toBeVisible();
});

test('a suspended operator gets a support path', async ({ page }) => {
  await mockApi(page);
  await signInAs(me({ role: 'driver', operator_type: 'company', operator_id: id(1), verification_status: 'suspended' }))(page);
  await page.goto(APP + '/work/today');
  await login(page);
  await expect(page.getByText('Compte suspendu').first()).toBeVisible();
  await expect(page.getByText(/Contactez LeRoutier/)).toBeVisible();
});

// ----------------------------------------------------------- authorisation --
test('a passenger cannot reach a crew or operations workspace', async ({ page }) => {
  await mockApi(page);
  await signInAs(me({ role: 'passenger', operator_id: null }))(page);
  for (const route of ['/work/today', '/work/earnings', '/ops/today', '/ops/settlements']) {
    await page.goto(APP + route);
    await login(page);
    await expect(page.getByText('Espace non autorisé'), route).toBeVisible();
    // Never silently redirected somewhere unrelated.
    await expect(page, route).toHaveURL(new RegExp(route.replace('/', '\\/') + '$'));
  }
});

test('a company driver is refused the operations workspace and revenue tools', async ({ page }) => {
  await mockApi(page);
  await signInAs(me({ role: 'driver', operator_type: 'company', operator_id: id(1),
    verification_status: 'verified', operator_name: 'Baobab Express' }))(page);
  await page.goto(APP + '/ops/settlements');
  await login(page);
  await expect(page.getByText('Espace non autorisé')).toBeVisible();
  await page.goto(APP + '/work/earnings');
  await login(page);
  await expect(page.getByText(/reviennent à Baobab Express/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Demander le retrait/ })).toHaveCount(0);
});

test('the workspace switcher names the job and the company, never a role string', async ({ page }) => {
  await mockApi(page);
  await signInAs(me({ role: 'ops', operator_type: 'company', operator_id: id(1),
    verification_status: 'verified', operator_name: 'Baobab Express' }))(page);
  await page.goto(APP + '/ops/today');
  await login(page);
  await page.getByRole('button', { name: /Changer d’espace/ }).click();
  await expect(page.getByRole('menuitem', { name: /Exploitation — Baobab Express/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Voyageur/ })).toBeVisible();
  // Internal role names never appear in the switcher.
  await expect(page.getByRole('menuitem', { name: /^ops$|^driver$|^convoyeur$/ })).toHaveCount(0);
});

test('one identity keeps one session across workspaces', async ({ page }) => {
  await mockApi(page);
  await signInAs(me({ role: 'convoyeur', operator_type: 'company', operator_id: id(1),
    verification_status: 'verified', operator_name: 'Baobab Express' }))(page);
  await page.goto(APP + '/work/today');
  await login(page);
  let logins = 0;
  await page.route('**/api/v1/auth/demo', r => { logins++; return r.fulfill({ json: { data: { token: 'x', user: me({ role: 'convoyeur' }) } } }); });
  await page.getByRole('button', { name: /Changer d’espace/ }).click();
  await page.getByRole('menuitem', { name: /Voyageur/ }).click();
  await expect(page).toHaveURL(/\/trips$/);
  // Switching workspace is navigation, not a second authentication.
  await expect(page.getByRole('button', { name: 'Se connecter pour réserver' })).toHaveCount(0);
  expect(logins).toBe(0);
});
