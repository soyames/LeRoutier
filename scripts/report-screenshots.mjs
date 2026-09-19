import { chromium } from '@playwright/test';
import { mockApi } from '../tests/e2e/api-fixture.js';

// Screenshots for the report: the geography-backed hero must render real
// controls at phone and desktop widths, and an empty transport catalogue
// must keep the search visible with the honest no-service state.
const browser = await chromium.launch();

const homeMobile = await browser.newPage({ viewport: { width: 412, height: 915 } });
await mockApi(homeMobile);
await homeMobile.goto('http://127.0.0.1:4173/');
await homeMobile.waitForLoadState('networkidle').catch(() => {});
await homeMobile.screenshot({ path: 'test-results/report-home-mobile.png', fullPage: true });

const homeDesktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await mockApi(homeDesktop);
await homeDesktop.goto('http://127.0.0.1:4173/');
await homeDesktop.waitForLoadState('networkidle').catch(() => {});
await homeDesktop.screenshot({ path: 'test-results/report-home-desktop.png' });

const empty = await browser.newPage({ viewport: { width: 412, height: 915 } });
await mockApi(empty);
await empty.route('**/api/v1/journey-plan*', r => r.fulfill({ json: { data: { options: [], originResolved: null, generatedAt: '2026-09-17T00:00:00Z' } } }));
await empty.goto(`http://127.0.0.1:4173/trips?from=place%3A00000000-0000-4000-b000-0000000003001&to=place%3A00000000-0000-4000-b000-0000000003031&date=${new Date().toISOString().slice(0, 10)}`);
await empty.waitForLoadState('networkidle').catch(() => {});
await empty.getByText('Aucun départ disponible pour cet itinéraire pour le moment.').waitFor();
await empty.screenshot({ path: 'test-results/report-empty-catalogue-mobile.png', fullPage: true });

await browser.close();
console.log('screenshots written');
