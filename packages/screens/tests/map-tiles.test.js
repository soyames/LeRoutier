// Which basemap this deployment draws on, and what it says about it.
//
// The cases that matter are the ones nobody configures deliberately: a URL
// pasted without the provider's credit line, a template with a placeholder
// missing, a key-less http endpoint. Each of those has to end somewhere
// honest, and the honest place is OpenStreetMap's shared public tiles WITH
// their attribution and WITH the provider named — never a map drawn from a
// service this product has no right to draw from, and never a map whose
// attribution has quietly gone missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTiles } from '../src/map-tiles.js';

const OSM_HOST = /tile\.openstreetmap\.org/;
/** The app's own attribution anchor, which is the only markup ever allowed. */
const OSM_LINK = /<a href="https:\/\/www\.openstreetmap\.org\/copyright">OpenStreetMap<\/a> contributors/;

test('with nothing configured, the pilot fallback is named as what it is', () => {
  const { styles, provider } = resolveTiles({});
  assert.equal(provider.configured, false);
  assert.equal(provider.id, 'osm-public');
  assert.match(styles.light.url, OSM_HOST);
  // The credit line is not decoration: it is the condition of using them.
  assert.match(styles.light.attribution, /OpenStreetMap/);
  assert.match(styles.light.attribution, /openstreetmap\.org\/copyright/);
  // No placeholder, no tile: a URL that cannot be addressed is not a template.
  assert.equal(styles.light.url.includes('{s}') || styles.light.url.includes('{z}'), true);
});

test('a configured provider is used, credited, and named as configured', () => {
  const { styles, provider } = resolveTiles({
    VITE_MAP_TILE_URL: 'https://tiles.example.invalid/{z}/{x}/{y}.png?key=PUBLIC_KEY',
    VITE_MAP_TILE_ATTRIBUTION: '© Exemple 2026',
  });
  assert.equal(provider.configured, true);
  assert.equal(provider.id, 'configured');
  assert.match(styles.light.url, /tiles\.example\.invalid/);
  // The provider's own credit travels WITH the OpenStreetMap one whenever the
  // tiles are derived from OSM data, which raster tiles of Benin are.
  assert.match(styles.light.attribution, /OpenStreetMap/);
  assert.match(styles.light.attribution, /Exemple 2026/);
});

test('a configured URL with no attribution falls back rather than shipping uncredited tiles', () => {
  const { styles, provider } = resolveTiles({ VITE_MAP_TILE_URL: 'https://tiles.example.invalid/{z}/{x}/{y}.png' });
  assert.equal(provider.configured, false);
  assert.match(styles.light.url, OSM_HOST);
  assert.doesNotMatch(styles.light.url, /example\.invalid/);
});

test('a template that cannot be addressed is not a template', () => {
  for (const url of [
    'https://tiles.example.invalid/{z}/{x}.png',            // no {y}
    'https://tiles.example.invalid/tiles?z={z}&x={x}&y={y}'.replace('&y={y}', ''), // no {y} either
    'http://tiles.example.invalid/{z}/{x}/{y}.png',         // not https
    'tiles.example.invalid/{z}/{x}/{y}.png',                // no scheme
    '   ',                                                   // nothing at all
  ]) {
    const { provider } = resolveTiles({ VITE_MAP_TILE_URL: url, VITE_MAP_TILE_ATTRIBUTION: '© Exemple' });
    assert.equal(provider.configured, false, `${url} must not be treated as a usable tile template`);
  }
});

test('a dark style is separate from the light one, and optional', () => {
  const base = { VITE_MAP_TILE_URL: 'https://light.example.invalid/{z}/{x}/{y}.png', VITE_MAP_TILE_ATTRIBUTION: '© Exemple' };
  // Not given: the dark style is the light one rather than the fallback, so a
  // dark map is never drawn from a different provider than the light one.
  const without = resolveTiles(base);
  assert.equal(without.styles.dark.url, without.styles.light.url);
  const with_ = resolveTiles({ ...base, VITE_MAP_TILE_URL_DARK: 'https://dark.example.invalid/{z}/{x}/{y}.png' });
  assert.match(with_.styles.dark.url, /dark\.example\.invalid/);
  assert.match(with_.styles.light.url, /light\.example\.invalid/);
  // A dark URL that is not usable does not drag the light one down with it.
  const broken = resolveTiles({ ...base, VITE_MAP_TILE_URL_DARK: 'http://dark.example.invalid/{z}/{x}/{y}.png' });
  assert.equal(broken.styles.dark.url, broken.styles.light.url);
});

test('the provider’s zoom ceiling is honoured, and a nonsense one is not', () => {
  const base = { VITE_MAP_TILE_URL: 'https://tiles.example.invalid/{z}/{x}/{y}.png', VITE_MAP_TILE_ATTRIBUTION: '© Exemple' };
  assert.equal(resolveTiles({ ...base, VITE_MAP_TILE_MAX_ZOOM: '17' }).provider.maxZoom, 17);
  // A ceiling of 0, 99 or "beaucoup" is not a ceiling: the default stands.
  for (const value of ['0', '99', 'beaucoup', '']) {
    assert.equal(resolveTiles({ ...base, VITE_MAP_TILE_MAX_ZOOM: value }).provider.maxZoom, 19, value);
  }
});

test('the configured credit line is text, and can never be markup', () => {
  const { styles } = resolveTiles({
    VITE_MAP_TILE_URL: 'https://tiles.example.invalid/{z}/{x}/{y}.png',
    VITE_MAP_TILE_ATTRIBUTION: '<img src=x onerror=alert(1)> © Exemple',
  });
  // Leaflet puts this string into the attribution control as HTML, so the one
  // thing that must never survive configuration is a tag. The angle brackets
  // are stripped and the words are kept, which is the only part a provider
  // legitimately needs to send.
  const configured = styles.light.attribution.replace(OSM_LINK, '');
  assert.doesNotMatch(configured, /[<>]/, 'no tag can be introduced by configuration');
  assert.match(configured, /Exemple/, 'and the credit itself is not thrown away');
});
