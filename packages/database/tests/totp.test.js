// The second factor: RFC 6238 itself, and the rules the service adds on top.
//
// The algorithm is checked against the RFC's OWN published vectors rather than
// against our own output — a self-referential test would pass just as happily
// if the whole implementation drifted, and an authenticator app on the other
// side would then disagree with us for every user at once.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { base32Decode, base32Encode, hotp, matchingStep, newRecoveryCodes, totpAt, totpService } from '../src/totp.js';

const config = { ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true };
const db = createDatabase(config);
// A clock the tests own. TOTP is a function of time, so leaving the tests on
// the wall clock would make them pass or fail depending on where they fall in
// a 30-second window — and would make the replay and drift rules impossible to
// state precisely.
let clockAt = 1_111_111_100;
const service = totpService(db, { clock: () => clockAt });

const one = async (sql, args = []) => (await db.transaction(async tx => (await tx.query(sql, args)).rows[0]));

before(async () => { await migrate(db); await seed(db); });
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

async function newUser() {
  const subject = 'totp-' + randomUUID();
  return (await one(`INSERT INTO users(auth_subject,auth_issuer,display_name,role)
    VALUES($1,'https://issuer.test.invalid','Test Voyageur','passenger') RETURNING id`, [subject])).id;
}

/** A code the authenticator would be showing for this secret right now. */
const currentCode = secret => totpAt(secret, clockAt);

// ------------------------------------------------------------------ the RFC --
test('every published RFC 6238 SHA-1 vector reproduces', () => {
  // The RFC's own secret is the ASCII string 12345678901234567890.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  /** @type {[number,string][]} */
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [seconds, expected] of vectors) {
    assert.equal(hotp(secret, Math.floor(seconds / 30), 8), expected, `RFC vector at ${seconds}s`);
  }
});

test('base32 round-trips, and refuses anything that is not base32', () => {
  for (const bytes of [Buffer.from([0]), Buffer.from([255, 0, 128]), Buffer.from('LeRoutier')]) {
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  }
  // Nothing here may guess at a malformed secret: a wrong decode would produce
  // codes that never match, for every user, silently.
  for (const bad of ['', 'ABC1', 'ABC!', null, undefined]) {
    assert.throws(() => base32Decode(bad), /TOTP_INVALID|not valid/);
  }
  // Spacing is presentation — a secret read off a screen and retyped with a
  // space in it is still the same secret.
  assert.deepEqual(base32Decode('AB CD'), base32Decode('ABCD'));
});

test('a code is accepted one step either side of now, and names the step it matched', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const at = 1111111111;
  assert.equal(matchingStep(secret, hotp(secret, Math.floor(at / 30)), at), Math.floor(at / 30));
  assert.equal(matchingStep(secret, hotp(secret, Math.floor(at / 30) - 1), at), Math.floor(at / 30) - 1, 'one step behind');
  assert.equal(matchingStep(secret, hotp(secret, Math.floor(at / 30) + 1), at), Math.floor(at / 30) + 1, 'one step ahead');
  assert.equal(matchingStep(secret, hotp(secret, Math.floor(at / 30) + 2), at), null, 'two steps ahead is drift, not tolerance');
  assert.equal(matchingStep(secret, '000000', at), null);
  assert.equal(matchingStep(secret, 'abcdef', at), null, 'only six digits are ever considered');
  assert.equal(matchingStep(secret, '', at), null);
});

test('recovery codes are distinct, grouped, and read back however they are typed', () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
});

// -------------------------------------------------------------- the service --
test('an enrolment gates nothing until a code proves the app received it', async () => {
  const userId = await newUser();
  const started = await service.beginEnrolment(userId, 'Test Voyageur');
  assert.match(started.uri, /^otpauth:\/\/totp\/LeRoutier/);
  assert.ok(started.uri.includes(encodeURIComponent(started.secret)), 'the URI carries the secret');
  // Abandoning here must leave the account exactly as open as it was. This is
  // the trap the whole design is arranged to avoid: a half-finished enrolment
  // that locks someone out of their own account.
  assert.deepEqual(await service.status(userId), { enabled: false, confirmedAt: null, recoveryCodesRemaining: 0 });
  // And a code from an abandoned attempt cannot be used to pass anything.
  await assert.rejects(service.verify(userId, currentCode(started.secret)),
    /** @param {any} error */ error => error.code === 'TOTP_NOT_ENABLED');
});

test('activating confirms the factor and hands back recovery codes once', async () => {
  const userId = await newUser();
  const { secret } = await service.beginEnrolment(userId, 'Test Voyageur');
  await assert.rejects(service.activate(userId, '000000'), /TOTP_INVALID|pas valide/);
  assert.equal((await service.status(userId)).enabled, false, 'a wrong code must not enable anything');

  const activated = await service.activate(userId, currentCode(secret));
  assert.equal(activated.recoveryCodes.length, 10);
  const status = await service.status(userId);
  assert.equal(status.enabled, true);
  assert.equal(status.recoveryCodesRemaining, 10);
  // The secret is never handed back out.
  assert.equal('secret' in status, false);
});

test('a code cannot be replayed inside its own window', async () => {
  const userId = await newUser();
  const { secret } = await service.beginEnrolment(userId, 'Test Voyageur');
  await service.activate(userId, currentCode(secret));
  // Activation spends the step it verified, so that same code is already used.
  await assert.rejects(service.verify(userId, currentCode(secret)),
    /** @param {any} error */ error => error.code === 'TOTP_REPLAYED');

  // One step later is a different code, and it opens the door.
  clockAt += 30;
  const next = currentCode(secret);
  assert.equal((await service.verify(userId, next)).method, 'totp');
  // The window would keep accepting it for up to a minute more. It must not:
  // that is the whole difference between a one-time code and a password.
  await assert.rejects(service.verify(userId, next),
    /** @param {any} error */ error => error.code === 'TOTP_REPLAYED');
});

test('a phone whose clock runs fast still works, which is the point of the window', async () => {
  const userId = await newUser();
  const { secret } = await service.beginEnrolment(userId, 'Test Voyageur');
  const step = Math.floor(clockAt / 30);
  await service.activate(userId, hotp(secret, step));
  // The authenticator is a step ahead of the server. Refusing this would read
  // to the user as "the feature is broken", on a phone that was correct when
  // they set it up.
  assert.equal((await service.verify(userId, hotp(secret, step + 1))).method, 'totp');
  // Three steps out is not drift, it is a different code.
  await assert.rejects(service.verify(userId, hotp(secret, step + 3)), /TOTP_INVALID|pas valide/);
});

test('a recovery code works once, and the count follows', async () => {
  const userId = await newUser();
  const { secret } = await service.beginEnrolment(userId, 'Test Voyageur');
  const { recoveryCodes } = await service.activate(userId, currentCode(secret));
  const first = await service.verify(userId, recoveryCodes[0]);
  assert.equal(first.method, 'recovery');
  assert.equal(first.recoveryCodesRemaining, 9);
  await assert.rejects(service.verify(userId, recoveryCodes[0]),
    /** @param {any} error */ error => error.code === 'TOTP_INVALID');
  // Typed the way a person would type it off paper.
  const second = await service.verify(userId, recoveryCodes[1].toLowerCase().replace('-', ' '));
  assert.equal(second.recoveryCodesRemaining, 8, 'case and spacing are presentation, not secret');
});

test('disabling needs a live code, and takes the sessions with it', async () => {
  const userId = await newUser();
  const { secret } = await service.beginEnrolment(userId, 'Test Voyageur');
  await service.activate(userId, currentCode(secret));
  const granted = await service.grant(userId);
  assert.equal(await service.hasSession(userId, granted.token), true);

  await assert.rejects(service.disable(userId, '000000'), /TOTP_INVALID|pas valide/);
  assert.equal((await service.status(userId)).enabled, true, 'a wrong code must not remove the factor');
  // Removing the factor is as sensitive as using it, so the step activation
  // already spent cannot do it either.
  await assert.rejects(service.disable(userId, currentCode(secret)),
    /** @param {any} error */ error => error.code === 'TOTP_REPLAYED');

  clockAt += 30;
  await service.disable(userId, currentCode(secret));
  assert.equal((await service.status(userId)).enabled, false);
  // The proof those sessions carried was proof of a factor that no longer
  // exists, so it stops meaning anything.
  assert.equal(await service.hasSession(userId, granted.token), false);
  assert.equal((await one('SELECT count(*)::integer AS n FROM user_recovery_codes WHERE user_id=$1', [userId])).n, 0);
});

test('a granted session is per-identity, and an unknown token is worth nothing', async () => {
  const first = await newUser(), second = await newUser();
  const { secret } = await service.beginEnrolment(first, 'Test Voyageur');
  await service.activate(first, currentCode(secret));
  const granted = await service.grant(first);

  assert.equal(await service.hasSession(first, granted.token), true);
  assert.equal(await service.hasSession(second, granted.token), false, 'another identity cannot borrow it');
  assert.equal(await service.hasSession(first, 'not-a-token'), false);
  assert.equal(await service.hasSession(first, ''), false);
  assert.equal(await service.hasSession(first, undefined), false);

  // An expired proof is refused on read rather than swept up later.
  await db.transaction(async tx => tx.query('UPDATE totp_sessions SET expires_at=now()-interval \'1 minute\' WHERE user_id=$1', [first]));
  assert.equal(await service.hasSession(first, granted.token), false);
});

test('revoking ends every granted session for one identity and nobody else', async () => {
  const first = await newUser(), second = await newUser();
  for (const userId of [first, second]) {
    const { secret } = await service.beginEnrolment(userId, 'Test Voyageur');
    await service.activate(userId, currentCode(secret));
  }
  const a = await service.grant(first), b = await service.grant(first), other = await service.grant(second);
  assert.equal(await service.revokeAll(first), 2);
  assert.equal(await service.hasSession(first, a.token), false);
  assert.equal(await service.hasSession(first, b.token), false);
  assert.equal(await service.hasSession(second, other.token), true);
});
