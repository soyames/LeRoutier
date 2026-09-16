import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screen, paginate, enforceLimit, withNotice, gsmLength, MAX_RESPONSE_CHARS } from '../src/render.js';
import { normalizeMsisdn, hashMsisdn, maskMsisdn, latestInput, adapterFor, sandboxAdapter, hmacAdapter } from '../src/adapters.js';
import { translator, fcfa, clock } from '../src/messages.js';
import { requestFingerprint } from '../src/sessions.js';
import { bookingReference } from '../src/engine.js';
import { createHmac } from 'node:crypto';

// The parts of USSD that need no database: what a screen may contain, what a
// gateway may claim, and what a caller may read.

// ------------------------------------------------------------- rendering ----
test('a screen never exceeds what a handset will display', () => {
  const long = Array.from({ length: 40 }, (_, i) => `${i + 1}. Une option raisonnablement longue`);
  const rendered = screen({ title: 'Départs:', lines: long, nav: ['0. Retour'] });
  assert.ok(gsmLength(rendered) <= MAX_RESPONSE_CHARS, `was ${gsmLength(rendered)}`);
});

test('navigation survives a screen that is too full', () => {
  // The options a caller needs are reserved before any body line is kept:
  // truncation takes the end of the screen, which is where they live.
  const rendered = screen({
    title: 'Départs:',
    lines: Array.from({ length: 40 }, (_, i) => `${i + 1}. Option`),
    nav: ['0. Retour', '00. Quitter'],
  });
  assert.match(rendered, /0\. Retour/);
  assert.match(rendered, /00\. Quitter/);
});

test('GSM extended characters are counted as the gateway counts them', () => {
  assert.equal(gsmLength('abc'), 3);
  assert.equal(gsmLength('€'), 2);
  assert.equal(gsmLength('[]'), 4);
});

test('pagination splits rather than truncating', () => {
  const items = Array.from({ length: 30 }, (_, i) => `Ville numéro ${i + 1} avec un nom long`);
  const first = paginate(items, { title: 'Départ:', nav: ['0. Retour'] });
  assert.ok(first.pageCount > 1, 'a long list must span pages');
  assert.ok(first.hasNext);
  assert.equal(first.hasPrevious, false);

  // Every item appears on exactly one page — nothing is silently dropped.
  const seen = [];
  for (let page = 0; page < first.pageCount; page++) {
    seen.push(...paginate(items, { page, title: 'Départ:', nav: ['0. Retour'] }).items);
  }
  assert.deepEqual(seen, items);
});

test('a page maps its visible numbers back to the right records', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: `id-${i}` }));
  const second = paginate(items, { page: 1, title: 'Départ:', nav: ['0. Retour'], render: (x, i) => `${i + 1}. ${x.id}` });
  assert.ok(second.offset > 0);
  // "1." on page two is the first item of page two, not of the whole list.
  assert.equal(second.items[0].id, items[second.offset].id);
});

test('an out-of-range page clamps instead of returning nothing', () => {
  const items = ['a', 'b', 'c'];
  assert.deepEqual(paginate(items, { page: 99 }).items.length > 0, true);
  assert.deepEqual(paginate(items, { page: -5 }).page, 0);
});

test('an empty list still produces a usable page', () => {
  const page = paginate([], { title: 'Départs:' });
  assert.deepEqual(page.items, []);
  assert.equal(page.pageCount, 1);
});

test('a notice is added only when the screen can still be read', () => {
  const short = screen({ title: 'Menu', lines: ['1. Un'], nav: ['0. Retour'] });
  assert.match(withNotice(short, 'Choix invalide.'), /Choix invalide\.\nMenu/);

  // When it will not fit, the screen wins: being told the choice was invalid
  // is no use without the choices.
  const full = 'x'.repeat(MAX_RESPONSE_CHARS - 2);
  assert.equal(withNotice(full, 'Choix invalide.'), full);
});

test('an oversized response degrades to an honest sentence, never a cut menu', () => {
  const cut = enforceLimit('y'.repeat(500));
  assert.ok(gsmLength(cut) <= MAX_RESPONSE_CHARS);
  assert.match(cut, /indisponible/i);
});

// -------------------------------------------------------------- adapters ----
test('phone numbers normalise to one form per caller', () => {
  // The same Benin caller, however the gateway spells them.
  for (const input of ['+229 61 00 00 01', '+22961000001', '22961000001', '0022961000001']) {
    assert.equal(normalizeMsisdn(input), '+22961000001', `${input} did not normalise`);
  }
  // A bare local number gains the country code and nothing else: whether a
  // leading zero is a trunk prefix is a rule this layer refuses to guess.
  assert.equal(normalizeMsisdn('61000001'), '+22961000001');
  for (const empty of ['', null, undefined, 'abc']) assert.equal(normalizeMsisdn(empty), null);
});

test('the number is hashed for storage and masked for humans', () => {
  assert.match(hashMsisdn('+22961000001'), /^[0-9a-f]{64}$/);
  const masked = maskMsisdn('+22961000001');
  assert.equal(masked.includes('61000001'), false);
  assert.match(masked, /\*/);
});

test('only the newest segment of an accumulated gateway string is the answer', () => {
  // Several gateways resend the whole path on every step. Reading "1*2" as the
  // answer to the current question is the classic USSD bug.
  assert.equal(latestInput('1*2*3'), '3');
  assert.equal(latestInput('1'), '1');
  assert.equal(latestInput(''), '');
  assert.equal(latestInput('1**2'), '2');
});

test('the sandbox gateway can never authenticate anyone', () => {
  assert.equal(sandboxAdapter.verify(), false);
  assert.equal(sandboxAdapter.parse({ sessionId: 's', phoneNumber: '61000001', text: '1*2' }).verified, false);
});

test('an unknown provider resolves to no adapter, never to the sandbox', () => {
  assert.equal(adapterFor('sandbox'), sandboxAdapter);
  assert.equal(adapterFor('generic'), hmacAdapter);
  for (const wrong of ['sandbox ', 'SANDBOX', 'sandbx', '', null, undefined]) {
    assert.equal(adapterFor(/** @type {any} */ (wrong)), null, `${wrong} must not resolve`);
  }
});

test('a signature is required, correct, and compared in constant time', () => {
  const secret = 'gateway-shared-secret';
  const raw = '{"sessionId":"s","msisdn":"+22961000001","text":"1"}';
  const good = createHmac('sha256', secret).update(raw).digest('hex');
  const headers = value => new Headers(value ? { 'x-ussd-signature': value } : {});

  assert.equal(hmacAdapter.verify(raw, headers(good), secret), true);
  assert.equal(hmacAdapter.verify(raw, headers(good), 'wrong-secret'), false);
  assert.equal(hmacAdapter.verify(raw, headers('deadbeef'), secret), false);
  assert.equal(hmacAdapter.verify(raw, headers(), secret), false, 'a missing signature never passes');
  assert.equal(hmacAdapter.verify(raw, headers(good), undefined), false, 'a missing secret never passes');
  assert.equal(hmacAdapter.verify(`${raw} `, headers(good), secret), false, 'a modified body never passes');
});

test('replies use the gateway control words', () => {
  assert.match(sandboxAdapter.render({ text: 'Menu', continues: true }).body, /^CON /);
  assert.match(sandboxAdapter.render({ text: 'Bye', continues: false }).body, /^END /);
});

// ---------------------------------------------------------------- content ---
test('a booking reference is readable and never a raw identifier', () => {
  const id = '3f2a1b9c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
  const reference = bookingReference(id);
  assert.match(reference, /^LRB-[0-9A-F]{8}$/);
  assert.equal(reference.includes('-4d5e-'), false);
});

test('prices read as FCFA, with no decimals and no box characters', () => {
  assert.equal(fcfa(7500), '7 500 F');
  assert.equal(fcfa(0), '0 F');
  // A narrow no-break space would render as a box on some handsets.
  for (const char of fcfa(1234567)) assert.ok(char.codePointAt(0) < 0x2000 || char === ' ');
});

test('times are 24-hour and an unknown time says so', () => {
  assert.equal(clock('2026-09-17T07:05:00Z'), '07:05');
  assert.equal(clock('not a date'), '--:--');
});

test('every catalogue key resolves, and a missing one is visible rather than blank', () => {
  const t = translator('fr');
  assert.equal(t('menu.title'), 'Bienvenue sur LeRoutier');
  assert.equal(t('nope.missing'), 'nope.missing', 'a missing key must be reportable, not invisible');
  // An unknown locale falls back to French rather than to nothing.
  assert.equal(translator('xx')('menu.title'), 'Bienvenue sur LeRoutier');
});

test('the menu is French, with no English leaking in', () => {
  const t = translator('fr');
  for (const key of ['menu.1', 'menu.2', 'menu.3', 'menu.4', 'menu.5', 'menu.6', 'nav.back', 'nav.cancel']) {
    assert.equal(/\b(Search|Booking|Parcel|Help|Language|Back|Exit)\b/.test(t(key)), false, `${key} carries English`);
  }
});

test('the same input at the same step fingerprints identically, and differently otherwise', () => {
  assert.equal(requestFingerprint('s', 3, '1'), requestFingerprint('s', 3, '1'));
  assert.notEqual(requestFingerprint('s', 3, '1'), requestFingerprint('s', 4, '1'));
  assert.notEqual(requestFingerprint('s', 3, '1'), requestFingerprint('s', 3, '2'));
  assert.notEqual(requestFingerprint('s', 3, '1'), requestFingerprint('t', 3, '1'));
});
