import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Structural regressions: places where a second copy of something has already
// appeared once, and would be cheap to add again.
//
// These read the source rather than the running app, because that is where the
// duplication lives. A copy does not fail a behavioural test — it passes, twice,
// while quietly drifting from the original.

/** Every tracked .js/.jsx under a directory. */
function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...sources(full)); }
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
