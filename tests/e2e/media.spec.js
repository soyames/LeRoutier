import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { mockApi } from './api-fixture.js';
import { MEDIA, PAGE_HERO, mediaFiles } from '../../packages/ui/src/media-assets.js';

// Photography on a public page is the first thing that breaks silently.
//
// A missing file is not a test failure anywhere else in this suite: the page
// still renders, the layout still holds, and the only symptom is a picture
// that does not appear — which is exactly the kind of thing that ships. So it
// is asserted twice, from both ends:
//
//   1. on disk, before a browser is involved, for every width and every format
//      the markup can ask for;
//   2. in the browser, for every page that shows a photograph, because a path
//      can be right in the data and wrong in the markup.

const APP = 'http://127.0.0.1:4173';
const ASSETS = 'apps/web/public/assets';

// Every surface that shows a photograph, and the media it shows. A page that
// grows one adds a line here.
/** @type {[string, { slug: string, widths: number[], sizes: string, ratio: number[], alt: string }[]][]} */
const PAGES = [
  ['/', [MEDIA.hero, MEDIA.voyager, MEDIA.colis, MEDIA.suivi, MEDIA.professionnels]],
  ['/trips', [PAGE_HERO.trips]],
  ['/tracking', [PAGE_HERO.tracking]],
  ['/professionnel', [PAGE_HERO.professionnels]],
  ['/parcels', [MEDIA.colis]],
  ['/parcels/track', [MEDIA.colis]],
];

const ALL = [...new Map([...Object.values(MEDIA), ...Object.values(PAGE_HERO)]
  .map(media => [media.slug, media])).values()];

test.describe('photography', () => {
  test('every declared file exists at every width, in every format', () => {
    const missing = [];
    for (const media of ALL) {
      for (const file of mediaFiles(media)) {
        if (!fs.existsSync(path.join(ASSETS, file))) missing.push(file);
      }
    }
    expect(missing, 'a format the markup can request is not on disk').toEqual([]);
  });

  test('nothing ships the multi-megabyte source, and every picture is optimised', () => {
    const sources = fs.readdirSync(ASSETS);
    // PNGs are what the generator produced. A photograph has no business
    // being a 2 MB PNG on a phone, so none of them are in the shipped set.
    expect(sources.filter(f => f.endsWith('.png'))).toEqual([]);
    for (const media of ALL) {
      const largest = media.widths[media.widths.length - 1];
      const avif = fs.statSync(path.join(ASSETS, `${media.slug}-${largest}.avif`)).size;
      const webp = fs.statSync(path.join(ASSETS, `${media.slug}-${largest}.webp`)).size;
      const fallback = fs.statSync(path.join(ASSETS, `${media.slug}.jpg`)).size;
      expect(avif, `${media.slug} avif is ${Math.round(avif / 1024)}KB`).toBeLessThan(120 * 1024);
      expect(webp, `${media.slug} webp is ${Math.round(webp / 1024)}KB`).toBeLessThan(180 * 1024);
      expect(fallback, `${media.slug} jpeg fallback is ${Math.round(fallback / 1024)}KB`).toBeLessThan(160 * 1024);
    }
  });

  for (const [route, media] of PAGES) {
    test(`${route} renders every photograph it declares, and none of them is broken`, async ({ page }) => {
      const failed = [];
      page.on('response', response => {
        if (response.status() >= 400 && /\/assets\//.test(response.url())) {
          failed.push(`${response.status()} ${response.url()}`);
        }
      });
      await mockApi(page);
      await page.goto(APP + route);
      await page.waitForLoadState('networkidle').catch(() => {});
      // Lazy images below the fold only load once they are approached.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight) {
          window.scrollTo(0, y);
          await new Promise(resolve => setTimeout(resolve, 60));
        }
      });
      await page.waitForLoadState('networkidle').catch(() => {});

      // A photograph is present, decoded, and reported at its real size.
      for (const item of media) {
        const image = page.locator(`img[src="/assets/${item.slug}.jpg"]`);
        // Exactly once: the same picture twice on one page is the density
        // this redesign removed, and it is also two downloads.
        await expect(image, `${item.slug} is on ${route}`).toHaveCount(1);
        await expect(image.first()).toBeVisible();
        const decoded = await image.first().evaluate(node => {
          const img = /** @type {HTMLImageElement} */ (node);
          return { complete: img.complete, width: img.naturalWidth };
        });
        expect(decoded.complete && decoded.width > 0, `${item.slug} did not decode on ${route}`).toBe(true);
      }

      // And nothing on the page is a hole, including pictures this list does
      // not know about — a page that grows one without declaring it here still
      // cannot ship a broken image.
      const broken = await page.evaluate(() =>
        [...document.images].filter(image => image.complete && image.naturalWidth === 0).map(image => image.currentSrc || image.src));
      expect(broken, `broken image on ${route}`).toEqual([]);
      expect(failed, `an image request failed on ${route}`).toEqual([]);
    });
  }

  test('every photograph has alt text that says what it is for, not what it looks like', () => {
    for (const media of ALL) {
      expect(media.alt.length, `${media.slug} has no alt text`).toBeGreaterThan(20);
      // No empty alt: every picture in this product is answering a question,
      // so a screen reader user is owed the answer, not silence.
      expect(media.alt.trim()).not.toBe('');
      expect(media.alt).not.toMatch(/\.(png|jpe?g|webp|avif)/i);
    }
  });
});
