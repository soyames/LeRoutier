// Installing LeRoutier from the browser.
//
// LeRoutier ships as a PWA and will not be in an app store, so "how do I get
// this on my phone" is a real question with a real answer. The assistant
// answers it LOCALLY: the install dialog is a browser API bound to a user
// gesture, and no server round trip can open one. These tests hold that line —
// the answer must arrive without the network, and it must be specific to the
// device asking.
import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

const APP = 'http://127.0.0.1:4173';

const openAssistant = async page => {
  await page.goto(APP + '/');
  await page.evaluate(() => window.dispatchEvent(new Event('leroutier:assistant-open')));
  await expect(page.getByRole('button', { name: 'Installer LeRoutier sur mon téléphone' })).toBeVisible();
};

test('the assistant offers installing the app, and answers without the server', async ({ page }) => {
  await mockApi(page);
  // If this answer needed /assistant, the route would be hit. It must not be:
  // installing works with no network at all.
  let assistantCalls = 0;
  await page.route('**/api/v1/assistant', r => { assistantCalls++; return r.fulfill({ json: { data: { reply: 'x' } } }); });

  await openAssistant(page);
  await page.getByRole('button', { name: 'Installer LeRoutier sur mon téléphone' }).click();

  await expect(page.getByText(/ajoute son icône à votre appareil/)).toBeVisible();
  expect(assistantCalls).toBe(0);
});

test('the steps name the device asking, and explain the confirmation rather than waving it away', async ({ page }) => {
  await mockApi(page);
  await openAssistant(page);
  await page.getByRole('button', { name: 'Installer LeRoutier sur mon téléphone' }).click();
  const answer = page.locator('.assistant-msg').last();

  const isMobile = test.info().project.name === 'mobile';
  if (isMobile) {
    // The Android preset carries an Android UA, so the Android steps are the
    // correct ones to show.
    await expect(answer).toContainText('Android');
    await expect(answer).toContainText('Installer l’application');
    // The confirmation is explained and made checkable — never "ignore the
    // warning", which would train people to dismiss prompts that matter.
    await expect(answer).toContainText('leroutier.app');
    await expect(answer).not.toContainText(/ignor/i);
  } else {
    await expect(answer).toContainText(/barre d’adresse|Installer LeRoutier/);
  }
});

test('a typed question about installing is understood too', async ({ page }) => {
  await mockApi(page);
  await openAssistant(page);
  // By its own label: getByRole('textbox') also matches the home page's date
  // field, which refuses a sentence with "Malformed value".
  await page.getByLabel(/Votre message/).fill('comment installer l’appli sur mon telephone');
  // Enter submits the form. Clicking by name would be ambiguous: "Envoyer un
  // colis" is on this page twice before the assistant's own send button.
  await page.getByLabel(/Votre message/).press('Enter');

  await expect(page.getByText(/ajoute son icône à votre appareil/)).toBeVisible();
  // Never the fallback: this is the one question the client answers perfectly.
  await expect(page.getByText(/je ne comprends pas/i)).toHaveCount(0);
});
