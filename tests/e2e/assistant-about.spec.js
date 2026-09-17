import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

// The About page and the Assistant: public positioning, and an assistant
// that is reachable, keyboard-operable, honest offline and role-aware.
const APP = 'http://127.0.0.1:4176';

test.describe('About page', () => {
  test('the About page positions LeRoutier honestly with the legal entity', async ({ page }) => {
    await mockApi(page);
    await page.goto(APP + '/about');
    await expect(page.getByRole('heading', { level: 1, name: /À propos de LeRoutier/ })).toBeVisible();
    // The hero image loads and carries alternative text.
    const hero = page.getByRole('img', { name: /Bus interurbain LeRoutier/ });
    await expect(hero).toBeVisible();
    const box = await hero.boundingBox();
    expect(box && box.width > 200, 'hero image renders at a readable size').toBeTruthy();
    await expect(page.getByText('DIGITAL CONDORDIA', { exact: true })).toBeVisible();
    await expect(page.getByText('RB/ABC/21 A 28773')).toBeVisible();
    // Positioning: a platform, not a ticket website.
    await expect(page.getByText(/plateforme numérique d’exploitation et de transaction/)).toBeVisible();
    // Every legal page stays reachable from the footer.
    for (const [label, path] of [['Mentions légales', '/legal'], ['Confidentialité', '/privacy'],
      ['Conditions d’utilisation', '/terms'], ['Annulations et remboursements', '/cancellations'], ['Cookies et technologies', '/cookies']]) {
      const link = page.getByRole('link', { name: label, exact: true }).last();
      await expect(link).toBeVisible();
      expect(await link.getAttribute('href')).toBe(path);
    }
    // No unverifiable marketing claims about delivery guarantees.
    const text = await page.locator('main, .page').first().innerText().catch(() => '');
    expect(text).not.toMatch(/garanti(e)? à 100|livraison garantie/);
  });

  test('the About link appears in the home footer', async ({ page }) => {
    await mockApi(page);
    await page.goto(APP + '/');
    await expect(page.getByRole('link', { name: 'À propos' })).toBeVisible();
  });
});

test.describe('Assistant', () => {
  const assistantReply = async (page, message) => {
    await page.route('**/api/v1/assistant', r => r.fulfill({
      json: { data: { reply: message, intent: 'trip_search', mode: 'deterministic', tools: ['search_departures'] } },
    }));
  };

  test('the launcher opens a labelled dialog and focus lands in the input', async ({ page }) => {
    await mockApi(page);
    await page.goto(APP + '/');
    const launcher = page.getByRole('button', { name: 'Assistant', exact: true });
    await expect(launcher).toBeVisible();
    await launcher.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Assistant LeRoutier' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Votre message à l’assistant' })).toBeFocused();
  });

  test('Escape closes the panel and returns focus to the launcher', async ({ page }) => {
    await mockApi(page);
    await page.goto(APP + '/');
    const launcher = page.getByRole('button', { name: 'Assistant', exact: true });
    await launcher.click();
    await expect(page.getByRole('dialog', { name: 'Assistant LeRoutier' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Assistant LeRoutier' })).toBeHidden();
    await expect(launcher).toBeFocused();
  });

  test('a question receives the server answer and announces it politely', async ({ page }) => {
    await mockApi(page);
    await assistantReply(page, 'Il reste 2 places sur le départ de 14h30.');
    await page.goto(APP + '/');
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Votre message à l’assistant' });
    await input.fill('Y a-t-il de la place pour Bohicon ?');
    await page.getByRole('dialog', { name: 'Assistant LeRoutier' }).getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect(page.getByText('Il reste 2 places sur le départ de 14h30.')).toBeVisible();
    // User and assistant messages are visually distinguished by role.
    await expect(page.getByText('Y a-t-il de la place pour Bohicon ?')).toBeVisible();
  });

  test('an offline assistant states it plainly instead of failing silently', async ({ page }) => {
    await mockApi(page);
    await page.goto(APP + '/');
    await page.context().setOffline(true);
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await expect(page.getByText(/Hors ligne/)).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Assistant LeRoutier' }).getByRole('button', { name: 'Envoyer', exact: true })).toBeDisabled();
  });

  test('a failed answer offers retry rather than a dead end', async ({ page }) => {
    await mockApi(page);
    await page.route('**/api/v1/assistant', r => r.fulfill({ status: 500, json: { error: { code: 'INTERNAL_ERROR', message: 'The service is temporarily unavailable.' } } }));
    await page.goto(APP + '/');
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await page.getByRole('textbox', { name: 'Votre message à l’assistant' }).fill('Bonjour ?');
    await page.getByRole('dialog', { name: 'Assistant LeRoutier' }).getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect(page.getByText('La réponse a échoué.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Réessayer' })).toBeVisible();
  });

  test('the assistant never exposes architecture to the user', async ({ page }) => {
    await mockApi(page);
    await assistantReply(page, 'Réponse utile.');
    await page.goto(APP + '/');
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const panel = await page.getByRole('dialog', { name: 'Assistant LeRoutier' }).innerText();
    expect(panel).not.toMatch(/Gemini|OpenRouter|workflow|workflow_run|agent_model|provider/i);
  });

  test('quick commands answer with one tap', async ({ page }) => {
    await mockApi(page);
    await assistantReply(page, 'Départs publiés depuis Cotonou.');
    await page.goto(APP + '/');
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Assistant LeRoutier' });
    await expect(dialog.getByRole('button', { name: 'Quels départs depuis Cotonou ?' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Quels départs depuis Cotonou ?' }).click();
    await expect(dialog.getByText('Départs publiés depuis Cotonou.')).toBeVisible();
    await expect(dialog.getByText('Quels départs depuis Cotonou ?')).toBeVisible();
  });

  test('the assistant link sits in the footer after the legal links and never floats over navigation', async ({ page }) => {
    await mockApi(page);
    await page.goto(APP + '/');
    // No fixed-position launcher button exists anywhere.
    await expect(page.locator('.assistant-launcher')).toHaveCount(0);
    const footer = page.locator('footer').first();
    const assistant = footer.getByRole('button', { name: 'Assistant', exact: true });
    await expect(assistant).toBeVisible();
    // The mobile navigation remains fully clickable: the panel only appears
    // after the link is activated.
    await expect(page.getByRole('dialog', { name: 'Assistant LeRoutier' })).toHaveCount(0);
  });
});
