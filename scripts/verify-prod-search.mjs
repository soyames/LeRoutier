import { chromium } from '@playwright/test';

// Live verification of the production homepage search (spec §25): a user
// opening leroutier.app must be able to enter a journey immediately,
// whether or not any service is published. No API is mocked here — the
// geography and the journey plan come from the real production backend.
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
const failures = [];
page.on('pageerror', e => failures.push('pageerror: ' + e.message));

await page.goto('https://leroutier.app/', { waitUntil: 'networkidle' });

// 1. The hero must always contain the real search controls.
const checks = [
  ['heading', page.getByRole('heading', { name: 'Où allez-vous ?' })],
  ['Départ', page.getByLabel('Départ', { exact: true })],
  ['Ma position actuelle option', page.getByLabel('Départ', { exact: true }).locator('option[value="current"]')],
  ['Destination', page.getByLabel('Destination')],
  ['Date', page.getByLabel('Date')],
  ['Rechercher un trajet', page.getByRole('button', { name: 'Rechercher un trajet' })],
];
for (const [name, locator] of checks) {
  // An <option> inside a closed <select> is attached but never "visible".
  const state = name === 'Ma position actuelle option' ? 'attached' : 'visible';
  try { await locator.waitFor({ state, timeout: 15000 }); console.log(`✓ ${name}`); }
  catch { failures.push(`missing control: ${name}`); console.log(`✗ ${name}`); }
}

// 2. The old passive paragraph must be gone.
const passive = await page.getByText('Entrez votre destination pour voir les départs disponibles.').count();
console.log(passive === 0 ? '✓ old passive copy removed' : `✗ old passive copy still present (${passive})`);
if (passive) failures.push('old passive copy still present');

// 3. Real search over the live geography: Cotonou → Parakou, no login.
// The real /places takes a moment to load — wait for the list before typing.
async function choosePlace(page, label, text) {
  const input = page.getByLabel(label);
  await input.click();
  await page.getByRole('listbox').getByRole('option').first().waitFor({ state: 'visible', timeout: 15000 });
  await input.fill(text);
  await input.press('Enter');
}
try {
  await page.getByLabel('Départ', { exact: true }).selectOption('place');
  await choosePlace(page, 'Ville de départ', 'Cotonou');
  await choosePlace(page, 'Destination', 'Parakou');
  await page.getByRole('button', { name: 'Rechercher un trajet' }).click();
  await page.waitForURL(/\/trips\?/, { timeout: 15000 });
  console.log('✓ search navigated to /trips with geography params');
} catch (e) { failures.push('search flow: ' + e.message); console.log('✗ search flow:', e.message); }

// 4. The result is structural: either real departures or the honest
//    no-service state — never an empty UI.
const noService = page.getByText('Aucun départ disponible pour cet itinéraire pour le moment.');
const hasResults = await page.locator('.trip-card').count();
try {
  if (hasResults) console.log(`✓ transport results rendered (${hasResults} option card(s))`);
  else { await noService.waitFor({ state: 'visible', timeout: 30000 }); console.log('✓ honest no-service state shown (empty catalogue)'); }
} catch { failures.push('neither results nor no-service state appeared'); console.log('✗ neither results nor no-service state'); }

// 5. No Google Maps anywhere in the flow.
const google = await page.locator('iframe[src*="google"], script[src*="maps.google"]').count();
console.log(google === 0 ? '✓ no Google Maps dependency' : `✗ Google Maps present (${google})`);
if (google) failures.push('Google Maps dependency found');

await page.screenshot({ path: 'test-results/report-prod-search.png', fullPage: true });
await browser.close();

if (failures.length) { console.error('\nLIVE VERIFICATION FAILED:\n- ' + failures.join('\n- ')); process.exit(1); }
console.log('\nLIVE VERIFICATION PASSED');
