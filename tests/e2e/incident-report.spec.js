import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

const me = extra => ({ id: '00000000-0000-4000-8000-000000000099', display_name: 'Test Identity', needs_profile: false, ...extra });

// Reporting an incident from the road.
//
// The rule under test is that the driver never types: one tap carries a real
// kind and a real severity to the API, and it survives a white zone.
const APP = 'http://127.0.0.1:4173';
const asDriver = page => page.route('**/api/v1/auth/demo', r => r.fulfill({
  json: { data: { token: 'fixture-session-driver', user: me({ role: 'driver', operator_type: 'company',
    verification_status: 'verified', operator_id: '00000000-0000-4000-8000-000000000001' }) } },
}));

async function openReporter(page) {
  await mockApi(page);
  await asDriver(page);
  await page.goto(APP + '/work/today');
  await page.getByRole('button', { name: 'Développement : driver' }).click();
  await page.getByRole('button', { name: 'Signaler un incident' }).click();
  return page.getByRole('group', { name: 'Type d’incident' });
}

test('an incident is one tap, and never asks the driver to write', async ({ page }) => {
  const sent = [];
  await page.route('**/api/v1/driver/actions', r => {
    sent.push(r.request().postDataJSON());
    return r.fulfill({ json: { data: { id: 'i1', status: 'open', serviceId: 's1' } } });
  });
  const grid = await openReporter(page);
  // Every preset is a button with a label; none of them is a text field.
  await expect(grid.getByRole('textbox')).toHaveCount(0);
  await expect(grid.getByRole('button')).toHaveCount(9);
  await grid.getByRole('button', { name: 'Panne mécanique' }).click();
  await expect(page.getByText('Signalement envoyé à l’exploitation.')).toBeVisible();
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  const payload = sent[0].payload;
  // The real kind and severity reach the API, rather than the old form's
  // hardcoded other/medium.
  expect(sent[0].type).toBe('incident');
  expect(payload.kind).toBe('breakdown');
  expect(payload.severity).toBe('high');
  expect(payload.description).toContain('Panne mécanique');
});

test('severity is carried by the label, not by colour alone', async ({ page }) => {
  const grid = await openReporter(page);
  // A driver who cannot distinguish the tile colours still reads what each
  // report means.
  for (const label of ['Accident', 'Urgence médicale', 'Route barrée', 'Ralentissement', 'Contrôle routier']) {
    await expect(grid.getByRole('button', { name: label })).toBeVisible();
  }
});

test('a report made without a signal is queued rather than lost', async ({ page }) => {
  const grid = await openReporter(page);
  await page.context().setOffline(true);
  await grid.getByRole('button', { name: 'Route barrée' }).click();
  // The crew are told it is held on the device, not that it was delivered.
  await expect(page.getByText(/enregistr[ée]s sur l’appareil|en attente/i).first()).toBeVisible();
  await page.context().setOffline(false);
});

test('free text stays available for a stopped vehicle', async ({ page }) => {
  const sent = [];
  await page.route('**/api/v1/driver/actions', r => {
    sent.push(r.request().postDataJSON());
    return r.fulfill({ json: { data: { id: 'i2', status: 'open', serviceId: 's1' } } });
  });
  await openReporter(page);
  await page.getByRole('button', { name: /Autre : décrire/ }).click();
  await page.getByRole('textbox', { name: 'Que se passe-t-il ?' }).fill('Pont coupé à Savè.');
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  expect(sent[0].payload.description).toBe('Pont coupé à Savè.');
});
