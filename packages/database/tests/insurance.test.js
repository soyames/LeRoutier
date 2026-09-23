// Insurance offered on LeRoutier and carried by somebody else.
//
// The properties worth protecting here are not arithmetic. They are:
//   - nobody is shown cover they do not have;
//   - a failed or refused policy never touches the trip or the parcel;
//   - only a licensed partner can be offered at all;
//   - what leaves the platform is the consented minimum and is written down;
//   - the insurance console is its own capability, not a corner of another.
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { transport } from '../src/transport.js';
import { insurance, insuranceAdmin, premiumFor, CONSENT_VERSION, SHARED_FIELDS } from '../src/insurance.js';
import { PLATFORM_CAPABILITIES } from '../src/platform-access.js';

const config = { ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true };
const db = createDatabase(config);
const cover = insurance(db), admin = insuranceAdmin(db), domain = transport(db);
const one = async (sql, args = []) => (await db.transaction(async tx => (await tx.query(sql, args)).rows[0]));

/** A platform identity holding exactly the capabilities named. */
async function platformUser(capabilities = ['insurance']) {
  const id = randomUUID();
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO users(id,auth_subject,auth_issuer,display_name,role,profile_completed_at)
      VALUES($1,$2,'test','Staff','ops',now())`, [id, 'ins-' + id]);
    for (const c of capabilities) await tx.query('INSERT INTO platform_grants(user_id,capability) VALUES($1,$2)', [id, c]);
  });
  return { id, role: 'ops', operator_id: null, platform_capabilities: capabilities };
}

async function newPassenger() {
  const id = randomUUID();
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO users(id,auth_subject,auth_issuer,display_name,role,profile_completed_at)
      VALUES($1,$2,'test','Voyageur Assuré','passenger',now())`, [id, 'insp-' + id]);
    await tx.query("INSERT INTO passenger_profiles(user_id,phone) VALUES($1,'+22990000001')", [id]);
  });
  return { id, role: 'passenger' };
}

const bookingFor = async passenger =>
  (await domain.hold(passenger, { serviceId: demo.service, origin: 0, destination: 1 }, randomUUID())).id;

/** An active partner with one active trip product. */
async function activePartner(staff, overrides = {}) {
  const partner = await admin.savePartner(staff, {
    name: 'Assureur Test', kind: 'insurer', cimaRegistration: 'CIMA-BJ-0001',
    claimsPhone: '+22921000000', status: 'active', ...overrides,
  });
  const product = await admin.saveProduct(staff, {
    partnerId: partner.id, code: 'TRIP-BASE', name: 'Protection voyage',
    summary: 'Couvre les frais médicaux en cas d’accident pendant le trajet.',
    scope: 'trip', coverAmountMinor: 500000, premiumMode: 'flat', premiumMinor: 500, status: 'active',
  });
  return { partner, product };
}

before(async () => { await migrate(db); await seed(db); });
beforeEach(async () => {
  await db.transaction(async tx => {
    await tx.query('DELETE FROM insurance_policies');
    await tx.query('DELETE FROM insurance_products');
    await tx.query('DELETE FROM insurance_partners');
    // The event stream too. Without this the "keyed on the booking" assertion
    // reads an earlier test's confirmation and passes or fails on row order.
    await tx.query('DELETE FROM outbox');
    await tx.query('DELETE FROM booking_segments');
    await tx.query("UPDATE bookings SET status='cancelled'");
    await tx.query("UPDATE services SET current_sequence=0,status='active'");
  });
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

test('the insurance console is its own capability', () => {
  assert.ok(PLATFORM_CAPABILITIES.includes('insurance'),
    'managing insurers must be grantable without handing over KYC or finance');
});

test('a premium is computed per mode, and a percentage never rounds in the insurer’s disfavour', () => {
  assert.equal(premiumFor({ premium_mode: 'included', premium_minor: 0, premium_bp: 0 }, 100000), 0);
  assert.equal(premiumFor({ premium_mode: 'flat', premium_minor: 500, premium_bp: 0 }, 100000), 500);
  // 1.5 % of 10 001 is 150.015 -> 151, not 150.
  assert.equal(premiumFor({ premium_mode: 'declared_value_bp', premium_minor: 0, premium_bp: 150 }, 10001), 151);
});

test('an unlicensed partner cannot be activated, and a draft partner is never offered', async () => {
  const staff = await platformUser();
  await assert.rejects(admin.savePartner(staff, { name: 'Sans agrément', kind: 'insurer', status: 'active' }),
    { code: 'INVALID_INPUT' }, 'activation without a CIMA registration must be refused');

  const draft = await admin.savePartner(staff, { name: 'En cours', kind: 'insurer', status: 'draft' });
  await admin.saveProduct(staff, { partnerId: draft.id, code: 'X', name: 'Garantie', summary: 'Résumé.',
    scope: 'trip', coverAmountMinor: 100000, premiumMode: 'flat', premiumMinor: 200, status: 'active' });
  assert.deepEqual(await cover.offers({ scope: 'trip' }), [],
    'an active product under a draft partner is not an offer');
});

test('the insurance console refuses a platform identity that was not granted it', async () => {
  const other = await platformUser(['finance', 'verification']);
  await assert.rejects(admin.partners(other), { code: 'FORBIDDEN' });
  await assert.rejects(admin.queue(other), { code: 'FORBIDDEN' });
  await assert.rejects(admin.savePartner(other, { name: 'X', kind: 'insurer' }), { code: 'FORBIDDEN' });
});

test('a policy is born requested, and only the insurer’s own reference makes it active', async () => {
  const staff = await platformUser(), passenger = await newPassenger();
  const { product } = await activePartner(staff);
  const booking = await bookingFor(passenger);

  const policy = await cover.attach(passenger, { scope: 'trip', subjectId: booking,
    productId: product.id, consentVersion: CONSENT_VERSION });
  assert.equal(policy.status, 'requested', 'ticking a box does not create cover');
  assert.equal(policy.partnerReference, null, 'there is no reference to show before the insurer issues one');
  assert.equal(policy.premiumCollectedBy, 'partner', 'LeRoutier does not collect the premium on a referral');

  await assert.rejects(admin.record(staff, policy.id, { status: 'active' }), { code: 'INVALID_INPUT' },
    'confirming without the insurer’s reference must be impossible');

  await admin.record(staff, policy.id, { status: 'active', partnerReference: 'POL-2026-77' });
  const active = await cover.forSubject(passenger, 'trip', booking);
  assert.equal(active.status, 'active');
  assert.equal(active.partnerReference, 'POL-2026-77');
  assert.equal(active.partner.claimsPhone, '+22921000000', 'a claim must be reachable');
});

test('the database refuses an active policy with no reference, even outside the domain module', async () => {
  const staff = await platformUser(), passenger = await newPassenger();
  const { product, partner } = await activePartner(staff);
  const booking = await bookingFor(passenger);
  await cover.attach(passenger, { scope: 'trip', subjectId: booking, productId: product.id, consentVersion: CONSENT_VERSION });
  void partner;
  await assert.rejects(
    db.transaction(tx => tx.query("UPDATE insurance_policies SET status='active' WHERE subject_id=$1", [booking])),
    /./, 'the constraint, not the application, is what makes this impossible');
});

test('a refusal is recorded with a reason and leaves the booking untouched', async () => {
  const staff = await platformUser(), passenger = await newPassenger();
  const { product } = await activePartner(staff);
  const booking = await bookingFor(passenger);
  const before = await one('SELECT status,amount_minor FROM bookings WHERE id=$1', [booking]);

  const policy = await cover.attach(passenger, { scope: 'trip', subjectId: booking,
    productId: product.id, consentVersion: CONSENT_VERSION });
  await admin.record(staff, policy.id, { status: 'declined', declinedReason: 'Trajet hors zone couverte.' });

  const after = await one('SELECT status,amount_minor FROM bookings WHERE id=$1', [booking]);
  assert.deepEqual(after, before, 'a refused policy must not change the journey or its price');
  const read = await cover.forSubject(passenger, 'trip', booking);
  assert.equal(read.status, 'declined');
  assert.equal(read.declinedReason, 'Trajet hors zone couverte.');
});

test('consent is versioned, and stale wording is refused rather than reinterpreted', async () => {
  const staff = await platformUser(), passenger = await newPassenger();
  const { product } = await activePartner(staff);
  const booking = await bookingFor(passenger);
  await assert.rejects(cover.attach(passenger, { scope: 'trip', subjectId: booking,
    productId: product.id, consentVersion: 'lr-insurance-1999-01' }), { code: 'INSURANCE_CONSENT_STALE' });
});

test('what is shared is the consented minimum, recorded by field name and never by value', async () => {
  const staff = await platformUser(), passenger = await newPassenger();
  const { product } = await activePartner(staff);
  const booking = await bookingFor(passenger);
  await cover.attach(passenger, { scope: 'trip', subjectId: booking, productId: product.id, consentVersion: CONSENT_VERSION });

  const stored = await one('SELECT shared_fields,consent_version,consent_at FROM insurance_policies WHERE subject_id=$1', [booking]);
  assert.deepEqual(stored.shared_fields, [...SHARED_FIELDS.trip]);
  assert.equal(stored.consent_version, CONSENT_VERSION);
  assert.ok(stored.consent_at, 'a consent without a timestamp is not evidence of one');
  // The audit row must not become a second copy of the person's data.
  const serialised = JSON.stringify(stored.shared_fields);
  assert.ok(!serialised.includes('+229'), 'field NAMES are stored, never the values behind them');

  const [queued] = await admin.queue(staff);
  assert.deepEqual(Object.keys(queued.referral).sort(), [...SHARED_FIELDS.trip].sort(),
    'the referral handed over carries exactly the fields consented to');
  assert.equal(queued.referral.phone, '+22990000001');
});

test('a policy belongs to one trip, and re-requesting is not a second policy', async () => {
  const staff = await platformUser(), passenger = await newPassenger();
  const { product } = await activePartner(staff);
  const booking = await bookingFor(passenger);
  const first = await cover.attach(passenger, { scope: 'trip', subjectId: booking, productId: product.id, consentVersion: CONSENT_VERSION });
  const again = await cover.attach(passenger, { scope: 'trip', subjectId: booking, productId: product.id, consentVersion: CONSENT_VERSION });
  assert.equal(again.id, first.id, 'a retry is the same request, not a duplicate contract');
  const { count } = await one('SELECT count(*)::integer AS count FROM insurance_policies WHERE subject_id=$1', [booking]);
  assert.equal(count, 1);
});

test('somebody else’s booking cannot be insured, and somebody else’s policy cannot be cancelled', async () => {
  const staff = await platformUser(), passenger = await newPassenger(), stranger = await newPassenger();
  const { product } = await activePartner(staff);
  const booking = await bookingFor(passenger);
  await assert.rejects(cover.attach(stranger, { scope: 'trip', subjectId: booking,
    productId: product.id, consentVersion: CONSENT_VERSION }), { code: 'FORBIDDEN' });
  const policy = await cover.attach(passenger, { scope: 'trip', subjectId: booking, productId: product.id, consentVersion: CONSENT_VERSION });
  await assert.rejects(cover.cancel(stranger, policy.id), { code: 'FORBIDDEN' });
  await assert.rejects(cover.forSubject(stranger, 'trip', booking), { code: 'FORBIDDEN' });
});

test('LeRoutier cannot cancel a policy the insurer has issued', async () => {
  const staff = await platformUser(), passenger = await newPassenger();
  const { product } = await activePartner(staff);
  const booking = await bookingFor(passenger);
  const policy = await cover.attach(passenger, { scope: 'trip', subjectId: booking, productId: product.id, consentVersion: CONSENT_VERSION });
  await admin.record(staff, policy.id, { status: 'active', partnerReference: 'POL-1' });
  await assert.rejects(cover.cancel(passenger, policy.id), { code: 'INSURANCE_NOT_CANCELLABLE' },
    'an issued contract is between the insured and the insurer; LeRoutier must send them there');
});

test('confirming and refusing each raise an event keyed on the booking, so the passenger is reachable', async () => {
  const staff = await platformUser(), passenger = await newPassenger();
  const { product } = await activePartner(staff);
  const booking = await bookingFor(passenger);
  const policy = await cover.attach(passenger, { scope: 'trip', subjectId: booking, productId: product.id, consentVersion: CONSENT_VERSION });
  await admin.record(staff, policy.id, { status: 'active', partnerReference: 'POL-9' });

  const event = await one("SELECT event_type,aggregate_id,payload FROM outbox WHERE event_type='insurance.confirmed'");
  assert.ok(event, 'a confirmation nobody is told about is not a confirmation');
  assert.equal(event.aggregate_id, booking,
    'keyed on the booking, because that is what resolves the passenger to notify');
  assert.equal(event.payload.scope, 'trip');
});

test('an incoherent product is refused before it can price anything', async () => {
  const staff = await platformUser();
  const partner = await admin.savePartner(staff, { name: 'A', kind: 'insurer', cimaRegistration: 'C-1', status: 'active' });
  const base = { partnerId: partner.id, code: 'C', name: 'N', summary: 'S.', scope: 'trip', coverAmountMinor: 1000 };
  await assert.rejects(admin.saveProduct(staff, { ...base, premiumMode: 'flat', premiumMinor: 0 }), { code: 'INVALID_INPUT' });
  await assert.rejects(admin.saveProduct(staff, { ...base, premiumMode: 'declared_value_bp', premiumBp: 0 }), { code: 'INVALID_INPUT' });
  await assert.rejects(admin.saveProduct(staff, { ...base, premiumMode: 'included', premiumMinor: 300 }), { code: 'INVALID_INPUT' });
  await assert.rejects(admin.saveProduct(staff, { ...base, premiumMode: 'flat', premiumMinor: 100,
    minDeclaredValueMinor: 5000, maxDeclaredValueMinor: 1000 }), { code: 'INVALID_INPUT' });
});

test('an offer outside its declared-value band is not offered', async () => {
  const staff = await platformUser();
  const partner = await admin.savePartner(staff, { name: 'B', kind: 'insurer', cimaRegistration: 'C-2', status: 'active' });
  await admin.saveProduct(staff, { partnerId: partner.id, code: 'P', name: 'Colis protégé',
    summary: 'Couvre la valeur déclarée du colis.', scope: 'parcel', coverAmountMinor: 200000,
    premiumMode: 'declared_value_bp', premiumBp: 200, minDeclaredValueMinor: 10000,
    maxDeclaredValueMinor: 200000, status: 'active' });
  assert.equal((await cover.offers({ scope: 'parcel', declaredValueMinor: 5000 })).length, 0, 'below the band');
  assert.equal((await cover.offers({ scope: 'parcel', declaredValueMinor: 900000 })).length, 0, 'above the band');
  const [offer] = await cover.offers({ scope: 'parcel', declaredValueMinor: 50000 });
  assert.equal(offer.premiumMinor, 1000, '2 % of 50 000');
  assert.equal(offer.paidTo, 'partner');
  // The catalogue is public, so it must carry nothing internal.
  assert.ok(!('cimaRegistration' in offer.partner) && !('contactEmail' in offer.partner),
    'a public offer exposes a trading name, never the partner file');
});

test('a trip product is never offered for a parcel', async () => {
  const staff = await platformUser(), passenger = await newPassenger();
  const { product } = await activePartner(staff);
  assert.equal((await cover.offers({ scope: 'parcel' })).length, 0);
  const booking = await bookingFor(passenger);
  await assert.rejects(cover.attach(passenger, { scope: 'parcel', subjectId: booking,
    productId: product.id, consentVersion: CONSENT_VERSION }), { code: 'NOT_FOUND' },
  'a booking id is not a parcel id, whatever the caller claims');
});
