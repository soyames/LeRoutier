import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Structural regressions: places where a second copy of something has already
// appeared once, and would be cheap to add again.
//
// These read the source rather than the running app, because that is where the
// duplication lives. A copy does not fail a behavioural test — it passes, twice,
// while quietly drifting from the original.

/**
 * Every .js/.jsx under a directory, EXCLUDING tests.
 *
 * A test that names a SQL fragment or constructs a stub is not a second
 * implementation — it is the thing proving the first one. Counting test files
 * made the duplication assertions fire on their own coverage.
 */
function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!['node_modules', 'tests', 'dist'].includes(entry.name)) out.push(...sources(full)); }
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('there is exactly one camera reader in the product', () => {
  // There were three: qr-capture.jsx, plus copies inside the crew console for
  // tickets and for parcels. They drifted — only one of them stopped the camera
  // when the app went to the background, so a driver switching to their maps
  // app left the camera running on the crew screens.
  const callers = [];
  for (const file of [...sources('packages'), ...sources('apps/web/src')]) {
    const code = fs.readFileSync(file, 'utf8');
    if (/new QrScanner\s*\(/.test(code)) callers.push(file.replaceAll('\\', '/'));
  }
  expect(callers, 'the camera is constructed in one place; import QrCapture instead')
    .toEqual(['packages/screens/src/qr-capture.jsx']);
});

test('the evidence document policy has one implementation', () => {
  // The URL rules for a KYC proof decide what a Platform Ops reviewer opens and
  // what a passenger's browser renders. A second copy is a second answer.
  const definitions = [];
  for (const file of sources('packages')) {
    const code = fs.readFileSync(file, 'utf8');
    if (/BLOCKED_SUFFIXES\s*=/.test(code)) definitions.push(file.replaceAll('\\', '/'));
  }
  expect(definitions).toEqual(['packages/database/src/evidence-storage.js']);
});

test('a proof is named the same way to the reviewer and to the operator', () => {
  // A reviewer refusing "Contrôle technique" and an operator reading a
  // different wording for the same document would be discussing one file
  // without knowing it.
  const definitions = [];
  for (const file of sources('packages')) {
    const code = fs.readFileSync(file, 'utf8');
    if (/(export\s+)?const EVIDENCE_LABELS\s*=/.test(code)) definitions.push(file.replaceAll('\\', '/'));
  }
  expect(definitions).toEqual(['packages/screens/src/operator-onboarding.jsx']);
});

test('registration capacity is measured once, by the code that enforces it', () => {
  // Platform Ops reads the same number the gate refuses on. Two measurements
  // would eventually disagree, and the dashboard would be the one that was wrong.
  const definitions = [];
  for (const file of sources('packages')) {
    const code = fs.readFileSync(file, 'utf8');
    if (/pg_database_size/.test(code)) definitions.push(file.replaceAll('\\', '/'));
  }
  expect(definitions).toEqual(['packages/database/src/registration.js']);
});

test('a passenger does not download the Platform Ops console', () => {
  // Server authorization made this harmless, never useful: the whole
  // verification queue, user register and capacity console sat in the main
  // chunk, so somebody searching for a bus on a phone paid for a screen they
  // can never open — and the bundle described the internal surface to anybody
  // who read it.
  const assets = 'apps/web/dist/assets';
  if (!fs.existsSync(assets)) test.skip(true, 'run after pnpm build');
  const main = fs.readdirSync(assets).filter(f => /^index-.*\.js$/.test(f));
  expect(main.length, 'one entry chunk').toBe(1);
  const code = fs.readFileSync(path.join(assets, main[0]), 'utf8');
  // Field names and copy that exist only inside the consoles.
  for (const internal of ['kycQueue', 'evidenceComplete', 'payoutAnomalies', 'storageProtection']) {
    expect(code.includes(internal), `${internal} reached the passenger bundle`).toBe(false);
  }
  // And the consoles really are shipped, just separately.
  const split = fs.readdirSync(assets);
  expect(split.some(f => /^ops-.*\.js$/.test(f)), 'the operator console is its own chunk').toBe(true);
  expect(split.some(f => /^platform-ops-.*\.js$/.test(f)), 'the platform console is its own chunk').toBe(true);
});

test('the production bundle ships no source maps and no development sign-in', () => {
  const dist = 'apps/web/dist';
  if (!fs.existsSync(dist)) test.skip(true, 'run after pnpm build');
  // Walked directly rather than through sources(), which only collects .js and
  // .jsx and so could never have found a .map — an assertion that cannot fail
  // is not an assertion.
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  const files = walk(dist);
  expect(files.some(f => f.endsWith('.js')), 'the build really is present').toBe(true);
  expect(files.filter(f => f.endsWith('.map')),
    'a source map publishes every original file next to the bundle').toEqual([]);
  // The development panel is compiled out of Vercel builds by a build-time
  // constant, so this local build still carries it; what must never appear is
  // the TEST profile list, which names every workspace and the bypass shape.
  // Asserted on the source instead: the gate has to be the constant, because
  // a runtime-only check ships the panel.
  const panel = fs.readFileSync('packages/ui/src/api-state.jsx', 'utf8');
  expect(panel).toMatch(/import\.meta\.env\.VITE_DEVELOPMENT_SIGN_IN/);
  expect(panel).not.toMatch(/\{demoLogin && <details/);
});
