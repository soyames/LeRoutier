// The account rule: buying comes first, an account is what you may have after.
//
// What this suite defends, in the order the product promises it:
//   - a visitor buys with a name and a phone, and no account exists to require;
//   - the purchase is reachable only through the token issued with it;
//   - an account created afterwards adopts the purchase, which is what turns it
//     into a passenger account;
//   - and nothing else does. A brand-new identity, a guessed identifier or a
//     replay of a spent token activates nothing.
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { transport } from '../src/transport.js';
import { guestCheckout } from '../src/guest-checkout.js';
import { mapIdentity, updateProfile, claimGuestPurchase, activeIdentity } from '../src/identities.js';
import { onboarding } from '../src/onboarding.js';
import { commercial } from '../src/commercial.js';

const config = { ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true };
const db = createDatabase(config);
const domain = transport(db);
const guest = guestCheckout(db);
const ISSUER = 'https://issuer.test.invalid';

const one = async (sql, args = []) => (await db.transaction(async tx => (await tx.query(sql, args)).rows[0]));

const buy = (quantity = 1) => guest(null, { serviceId: demo.service, origin: 0, destination: 1, quantity,
  passengerName: 'Awa Sossou', passengerPhone: '+229 97 00 00 42' }, randomUUID());

/** A guest purchase that has actually been paid for. */
async function paidPurchase(quantity = 2) {
  const purchase = await buy(quantity);
  const buyer = { id: purchase.purchaser_id, role: 'passenger' };
  await domain.simulatedTestPayment(buyer, purchase.id, randomUUID(), { allowTestInventory: true });
  return { purchase, buyer };
}

/** A brand-new LeRoutier account, provisioned the way first sign-in provisions it. */
const newAccount = subject => mapIdentity(db, { subject, issuer: ISSUER });

before(async () => { await migrate(db); await seed(db, { capacity: 12 }); });
beforeEach(async () => {
  await db.transaction(async tx => {
    assert.ok(db.schema.startsWith('lr_test_'));
    await tx.query(`TRUNCATE bookings, booking_segments, booking_passengers, payments, boarding_events,
      alighting_events, outbox, booking_groups, payment_events CASCADE`);
    await tx.query('DELETE FROM api_sessions');
    await tx.query("UPDATE services SET current_sequence=0,status='active'");
  });
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

// ── what a new account is and is not ────────────────────────────────────────

test('a newly provisioned account is not yet a passenger account', async () => {
  const account = await newAccount('fresh-' + randomUUID());
  assert.equal(account.role, 'passenger');
  assert.equal(account.passenger_activated, false,
    'it exists, it can sign in, and it cannot buy a ticket as itself');
  assert.equal(account.needs_profile, true);
});

test('buying is what makes an account a passenger account', async () => {
  const { purchase } = await paidPurchase(2);
  const account = await newAccount('buyer-' + randomUUID());
  assert.equal(account.passenger_activated, false);
  const result = await claimGuestPurchase(db, account, purchase.guestToken);
  assert.equal(result.activated, true);
  assert.equal(result.tickets, 2);
  const after = await db.transaction(tx => activeIdentity(tx, account.id));
  assert.equal(after.passenger_activated, true);
  assert.equal(after.role, 'passenger');
});

// ── what the token is, and is not ───────────────────────────────────────────

test('the purchase belongs to the token, not to the identity that asked for it', async () => {
  const { purchase } = await paidPurchase(1);
  // The seats are the guest's, and the guest is not the account.
  const account = await newAccount('stranger-' + randomUUID());
  const guestBookings = await domain.passengerBookings({ id: purchase.purchaser_id, role: 'passenger' });
  assert.equal(guestBookings.length, 1);
  assert.equal(await domain.passengerBookings({ id: account.id, role: 'passenger' }).then(b => b.length), 0,
    'an account nobody has linked sees nothing of it');
  assert.notEqual(purchase.purchaser_id, account.id);
});

test('a purchase reference is not a credential: the claim needs the token', async () => {
  const { purchase } = await paidPurchase(1);
  const account = await newAccount('guesser-' + randomUUID());
  for (const guess of ['', 'x'.repeat(40), purchase.purchaser_id, purchase.bookings[0].id, 'TEST-SIM-' + purchase.id]) {
    await assert.rejects(claimGuestPurchase(db, account, guess), { code: 'CLAIM_INVALID' }, `guessed ${guess}`);
  }
  assert.equal((await one('SELECT passenger_activated_at FROM users WHERE id=$1', [account.id])).passenger_activated_at, null,
    'and the account was never activated by guessing');
});

test('an unpaid hold cannot be adopted, and activates nothing', async () => {
  const purchase = await buy(2); // held, never paid
  const account = await newAccount('impatient-' + randomUUID());
  await assert.rejects(claimGuestPurchase(db, account, purchase.guestToken), { code: 'CLAIM_NOTHING_TO_KEEP' });
  assert.equal((await one('SELECT passenger_activated_at FROM users WHERE id=$1', [account.id])).passenger_activated_at, null);
});

test('the token is spent by the claim and cannot be replayed', async () => {
  const { purchase } = await paidPurchase(1);
  const first = await newAccount('first-' + randomUUID());
  await claimGuestPurchase(db, first, purchase.guestToken);
  const second = await newAccount('second-' + randomUUID());
  await assert.rejects(claimGuestPurchase(db, second, purchase.guestToken), { code: 'CLAIM_INVALID' });
  assert.equal((await one('SELECT passenger_activated_at FROM users WHERE id=$1', [second.id])).passenger_activated_at, null);
  const seats = await domain.passengerBookings(first);
  assert.equal(seats.length, 1, 'and the tickets stayed where they were claimed');
});

// ── what moves, and who may move it ─────────────────────────────────────────

test('the seats, the party and the passenger rows all follow the account', async () => {
  const { purchase } = await paidPurchase(3);
  const account = await newAccount('adopter-' + randomUUID());
  await claimGuestPurchase(db, account, purchase.guestToken);
  assert.equal((await one('SELECT count(*)::integer AS n FROM bookings WHERE passenger_id=$1', [account.id])).n, 3);
  assert.equal((await one('SELECT count(*)::integer AS n FROM bookings WHERE passenger_id=$1', [purchase.purchaser_id])).n, 0);
  assert.equal((await one('SELECT count(*)::integer AS n FROM booking_passengers WHERE passenger_id=$1', [account.id])).n, 3);
  assert.equal((await one('SELECT purchaser_id FROM booking_groups WHERE id=$1', [purchase.id])).purchaser_id, account.id);
  // The emptied identity is closed rather than left as a way in.
  const closed = await one('SELECT active FROM users WHERE id=$1', [purchase.purchaser_id]);
  assert.equal(closed.active, false);
  assert.equal((await one('SELECT count(*)::integer AS n FROM api_sessions WHERE user_id=$1', [purchase.purchaser_id])).n, 0);
  await assert.rejects(db.transaction(tx => activeIdentity(tx, purchase.purchaser_id)), { code: 'ACCOUNT_DISABLED' });
});

test('a driver cannot adopt a passenger purchase', async () => {
  const { purchase } = await paidPurchase(1);
  const driver = await mapIdentity(db, { subject: 'driver-' + randomUUID(), issuer: ISSUER });
  await db.transaction(tx => tx.query("UPDATE users SET role='driver' WHERE id=$1", [driver.id]));
  await assert.rejects(claimGuestPurchase(db, { ...driver, role: 'driver' }, purchase.guestToken),
    { code: 'FORBIDDEN' });
  assert.equal((await one('SELECT count(*)::integer AS n FROM bookings WHERE passenger_id=$1', [purchase.purchaser_id])).n, 1,
    'the tickets are still the guest\'s, reachable through the token they hold');
});

test('an unseen guest is signed in to nothing else', async () => {
  const { purchase } = await paidPurchase(1);
  const buyer = await db.transaction(tx => activeIdentity(tx, purchase.purchaser_id));
  assert.equal(buyer.auth_subject, null, 'no authentication subject, so there is nothing to sign in as');
  assert.equal(buyer.role, 'passenger');
  assert.equal(buyer.passenger_activated, true, 'and buying is itself what a guest is for');
});

// ── the provider boundary ───────────────────────────────────────────────────
//
// A driver and a transport company are SERVICE PROVIDERS, not passengers. Their
// accounts are created and put to work by the provider flows, and none of that
// goes near a ticket. What the passenger work added is a condition on BUYING
// ONE, enforced at POST /bookings and nowhere else; these tests are the fence
// showing it stayed there.
//
// The rule has two halves and both are load-bearing: a purchase must never
// grant provider standing, and providing transport must never require a
// purchase.

/**
 * The provider-flow inputs, meeting the dossier's own requirements — including
 * the inspectable proofs, which are HTTPS links LeRoutier never hosts.
 */
const proof = name => `https://documents.example.invalid/${name}.pdf`;
const INDEPENDENT = { displayName: 'Chauffeur Test', phone: '+229 97110022', country: 'BJ',
  idDocumentType: 'national_id', idDocumentReference: 'CNI-2026-01', licenseReference: 'PERMIS-2026-01',
  transportAuthorizationReference: 'AUT-2026-01', insuranceReference: 'ASSUR-2026-01',
  roadworthinessReference: 'TECH-2026-01', vehicleRegistration: 'AB-1234-CD', vehicleCapacity: 14,
  vehicleMake: 'Toyota', vehicleModel: 'Hiace', vehicleColor: 'Blanc',
  idDocumentUrl: proof('identite'), licenseDocumentUrl: proof('permis'), driverPhotoUrl: proof('photo-chauffeur'),
  transportAuthorizationDocumentUrl: proof('autorisation'), insuranceDocumentUrl: proof('assurance'),
  roadworthinessDocumentUrl: proof('visite-technique'), vehicleRegistrationDocumentUrl: proof('carte-grise') };
const COMPANY = { displayName: 'Compagnie Test', legalName: 'Compagnie Test SARL', contactPhone: '+229 97220033',
  country: 'BJ', registrationRef: 'RCCM-2026-01', taxReference: 'IFU-2026-01',
  representativeName: 'Représentant Test', representativeIdReference: 'CNI-2026-02',
  transportAuthorizationReference: 'AUT-2026-02', registeredAddress: 'Cotonou, quartier Ganhi',
  registrationDocumentUrl: proof('rccm'), taxDocumentUrl: proof('ifu'),
  representativeIdDocumentUrl: proof('identite-representant'),
  transportAuthorizationDocumentUrl: proof('autorisation-compagnie'), addressProofUrl: proof('adresse') };

const nothingWasBought = async () => {
  for (const table of ['bookings', 'booking_groups', 'payments', 'booking_segments']) {
    assert.equal((await one(`SELECT count(*)::integer AS n FROM ${table}`)).n, 0, `${table} must stay empty`);
  }
};

test('an independent driver onboards and goes to work without ever buying a ticket', async () => {
  const account = await newAccount('future-driver-' + randomUUID());
  // The whole provider journey, in the order a person walks it: sign up, give a
  // name and a phone, hand in the dossier. No ticket, no fare, no checkout.
  await updateProfile(db, account, { displayName: 'Chauffeur Test', phone: '+229 97110022' });
  const result = await onboarding(db).startIndependent(account, INDEPENDENT, randomUUID());

  assert.equal(result.role, 'driver');
  const driver = await one('SELECT role,operator_id,passenger_activated_at FROM users WHERE id=$1', [account.id]);
  assert.equal(driver.role, 'driver');
  assert.equal(driver.operator_id, result.operatorId, 'and it is bound to its own operator');
  assert.equal(driver.passenger_activated_at, null, 'a driver is not a passenger account, and never needed to be');
  assert.equal((await one('SELECT count(*)::integer AS n FROM driver_profiles WHERE user_id=$1', [account.id])).n, 1);
  await nothingWasBought();

  // The account works for the work it was made for.
  const identity = await db.transaction(tx => activeIdentity(tx, account.id));
  assert.equal(identity.role, 'driver');
  assert.equal(identity.operator_id, result.operatorId);
  assert.equal(identity.needs_profile, false);
});

test('a transport company onboards, and its subscription plan is read, with no ticket involved', async () => {
  const account = await newAccount('future-company-' + randomUUID());
  await updateProfile(db, account, { displayName: 'Compagnie Test', phone: '+229 97220033' });
  const result = await onboarding(db).startCompany(account, COMPANY, randomUUID());
  assert.equal(result.role, 'ops');

  // The subscription is the commercial policy's business and stays there. It is
  // read from the operator's own plan row, which no ticket and no fare touches.
  const plan = await commercial(db).plan({ id: account.id, role: 'ops', operator_id: result.operatorId });
  assert.equal(plan.operatorType, 'company');
  assert.equal(plan.commissionBp, 500, 'the transaction commission policy is unchanged');
  assert.ok(plan.subscription && 'billingStatus' in plan.subscription,
    'and the plan is a subscription record, not a booking');
  await nothingWasBought();

  const identity = await db.transaction(tx => activeIdentity(tx, account.id));
  assert.equal(identity.role, 'ops');
  assert.equal(identity.passenger_activated_at, null);
});

test('adopting a purchase grants the passenger account and nothing else', async () => {
  const { purchase } = await paidPurchase(2);
  const account = await newAccount('claimer-' + randomUUID());
  await claimGuestPurchase(db, account, purchase.guestToken);

  // The tickets moved; the account stayed exactly what it was — a passenger.
  const after = await one('SELECT role,operator_id FROM users WHERE id=$1', [account.id]);
  assert.equal(after.role, 'passenger', 'a claim links a passenger identity and changes no role');
  assert.equal(after.operator_id, null, 'and attaches it to no operator');
  // None of the things that make somebody a provider, or that let them act as
  // one, came along with the tickets.
  for (const [table, column] of [['driver_profiles', 'user_id'], ['convoyeur_profiles', 'user_id'],
    ['platform_grants', 'user_id'], ['operators', 'owner_user_id'], ['operators', 'admin_user_id']]) {
    assert.equal((await one(`SELECT count(*)::integer AS n FROM ${table} WHERE ${column}=$1`, [account.id])).n, 0,
      `${table} must not gain a row from a ticket purchase`);
  }
  const identity = await db.transaction(tx => activeIdentity(tx, account.id));
  assert.deepEqual(identity.platform_capabilities, [], 'and no platform capability is conferred');
});

test('a provider account cannot adopt a purchase at all, so nothing can be granted through one', async () => {
  const { purchase } = await paidPurchase(1);
  const account = await newAccount('provider-' + randomUUID());
  await updateProfile(db, account, { displayName: 'Chauffeur Test', phone: '+229 97110022' });
  // A registration plate belongs to exactly one vehicle, which the database
  // enforces — so a second driver registers a second plate.
  await onboarding(db).startIndependent(account, { ...INDEPENDENT, vehicleRegistration: 'EF-5678-GH' }, randomUUID());
  const driver = await db.transaction(tx => activeIdentity(tx, account.id));

  // Refused, and refused without effect: the boundary is the role, not a flag
  // that could be set by the purchase.
  await assert.rejects(claimGuestPurchase(db, driver, purchase.guestToken), { code: 'FORBIDDEN' });
  assert.equal((await one('SELECT role FROM users WHERE id=$1', [account.id])).role, 'driver');
  assert.equal((await one('SELECT count(*)::integer AS n FROM bookings WHERE passenger_id=$1', [purchase.purchaser_id])).n, 1,
    'and the tickets are still the guest\'s, reachable through the token that bought them');
});
