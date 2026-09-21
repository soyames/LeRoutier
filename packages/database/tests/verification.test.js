// Company KYB vs independent driver KYC, and what the public is allowed to see.
//
// The product rule under test:
//
//   A COMPANY is verified as a legal entity. Its employed drivers are the
//   company's responsibility and are NEVER asked to hand personal identity
//   documents to LeRoutier just because they drive for a verified company.
//
//   An INDEPENDENT owner-driver has no company standing behind them, so they
//   are verified as a person AND as a vehicle.
//
// Plus the three invariants that matter once a dossier exists: "verified"
// cannot be granted on an incomplete file, a proof reference must be an
// address that is safe to open, and the dossier never leaves the two
// audiences allowed to see it.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo, demoId } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { onboarding } from '../src/onboarding.js';
import { transport } from '../src/transport.js';
import { journeyPlanning } from '../src/journey-planning.js';
import { operationalHealth } from '../src/operational-health.js';

const config = { ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true };
const db = createDatabase(config);
const onboard = onboarding(db), domain = transport(db), planner = journeyPlanning(db);
const health = operationalHealth(db);
const one = async (sql, args = []) => (await db.transaction(async tx => (await tx.query(sql, args)).rows[0]));
let platformOps;

// The evidence each operator type must have accepted before it can be
// verified. Mirrors requiredEvidence() in the onboarding module.
const REQUIRED = {
  company: ['company_registration', 'tax_registration', 'legal_representative_identity', 'transport_authorization', 'registered_address'],
  independent: ['identity', 'driving_license', 'vehicle_registration', 'insurance', 'roadworthiness', 'transport_authorization', 'driver_photo'],
};
const doc = name => `https://documents.leroutier.app/${name}.pdf`;

const COMPANY_DOSSIER = {
  displayName: 'Baobab Express', legalName: 'Baobab Transport SARL', contactPhone: '+229 61000100', country: 'BJ',
  registrationRef: 'RCCM/BJ/2024/B/9001', registrationDocumentUrl: doc('rccm'),
  taxReference: '3201900000001', taxDocumentUrl: doc('ifu'),
  representativeName: 'Adjo Hounkpatin', representativeIdReference: 'CNI-REP-4451', representativeIdDocumentUrl: doc('rep-id'),
  transportAuthorizationReference: 'AT-BJ-2024-118', transportAuthorizationDocumentUrl: doc('autorisation'),
  registeredAddress: 'Carré 984, Akpakpa, Cotonou', addressProofUrl: doc('adresse'),
};
const INDEPENDENT_DOSSIER = {
  displayName: 'Koffi Adanlé', phone: '+229 61000200', country: 'BJ',
  idDocumentType: 'national_id', idDocumentReference: 'CNI-4457821', idDocumentUrl: doc('cni'),
  licenseReference: 'PC-BJ-778812', licenseDocumentUrl: doc('permis'),
  driverPhotoUrl: 'https://photos.leroutier.app/koffi.jpg',
  transportAuthorizationReference: 'AT-BJ-2024-902', transportAuthorizationDocumentUrl: doc('autorisation-ind'),
  insuranceReference: 'ASS-2024-5512', insuranceDocumentUrl: doc('assurance'),
  roadworthinessReference: 'VT-2024-7781', roadworthinessDocumentUrl: doc('visite'),
  vehicleRegistration: 'AB-1234-RB', vehicleRegistrationDocumentUrl: doc('carte-grise'),
  vehicleCapacity: 8, vehicleMake: 'Toyota', vehicleModel: 'Hiace', vehicleColor: 'Blanc', vehicleYear: 2019,
  vehiclePhotoUrl: 'https://photos.leroutier.app/hiace.jpg',
};

async function newPassenger(displayName = 'Nouvel Utilisateur') {
  const id = randomUUID();
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO users(id,auth_subject,auth_issuer,display_name,role,profile_completed_at)
      VALUES($1,$2,'test',$3,'passenger',now())`, [id, 'subject-' + id, displayName]);
    await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1)', [id]);
  });
  return id;
}
async function onboardCompany(overrides = {}) {
  const userId = await newPassenger('Représentante Compagnie');
  const result = await onboard.startCompany({ id: userId, role: 'passenger' }, { ...COMPANY_DOSSIER, ...overrides }, randomUUID());
  return { userId, operatorId: result.operatorId, actor: { id: userId, role: 'ops', operator_id: result.operatorId } };
}
async function onboardIndependent(overrides = {}) {
  const userId = await newPassenger('Candidat Indépendant');
  const result = await onboard.startIndependent({ id: userId, role: 'passenger' },
    { ...INDEPENDENT_DOSSIER, vehicleRegistration: 'IND-' + randomUUID().slice(0, 6).toUpperCase(), ...overrides }, randomUUID());
  return { userId, operatorId: result.operatorId, actor: { id: userId, role: 'driver', operator_id: result.operatorId } };
}
/** Review every piece of a dossier, accepting all but the named exceptions. */
async function reviewAll(operatorId, { reject = [], skip = [] } = {}) {
  const rows = await db.transaction(async tx => (await tx.query(
    'SELECT id,kind FROM verification_evidence WHERE operator_id=$1', [operatorId])).rows);
  for (const row of rows) {
    if (skip.includes(row.kind)) continue;
    await onboard.verification(platformOps, operatorId,
      { type: 'evidence', evidenceId: row.id, status: reject.includes(row.kind) ? 'rejected' : 'verified',
        notes: reject.includes(row.kind) ? 'Document illisible.' : null });
  }
  return rows;
}

before(async () => {
  await migrate(db); await seed(db);
  platformOps = { id: randomUUID(), role: 'ops', operator_id: null };
  await db.transaction(async tx => {
    await tx.query("INSERT INTO users(id,display_name,role) VALUES($1,'Platform Ops','ops')", [platformOps.id]);
  });
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

// ---------------------------------------------------------------------------
// Company (KYB)
// ---------------------------------------------------------------------------

test('a company dossier never asks its employed drivers for personal identity documents', async () => {
  const { operatorId } = await onboardCompany({ displayName: 'Dossier Shape SARL', contactPhone: '+229 61000110' });
  const kinds = (await db.transaction(async tx => (await tx.query(
    'SELECT kind FROM verification_evidence WHERE operator_id=$1 ORDER BY kind', [operatorId])).rows)).map(r => r.kind);
  assert.deepEqual(kinds.slice().sort(), REQUIRED.company.slice().sort(),
    'a company files company documents, not its drivers’ ID cards');
  for (const personal of ['identity', 'driving_license', 'driver_photo']) {
    assert.ok(!kinds.includes(personal), `company KYB must not collect ${personal}`);
  }
  // A company-employed driver provisioned under that operator holds no
  // personal dossier of their own.
  const driverId = await newPassenger('Salarié Conducteur');
  await db.transaction(async tx => {
    await tx.query("UPDATE users SET role='driver',operator_id=$2 WHERE id=$1", [driverId, operatorId]);
    await tx.query('INSERT INTO driver_profiles(user_id,operator_id,license_reference) VALUES($1,$2,$3)', [driverId, operatorId, 'LIC-SAL-1']);
  });
  assert.equal((await one('SELECT count(*)::integer AS n FROM verification_evidence WHERE subject_user_id=$1', [driverId])).n, 0);
});

test('a complete company dossier is verified; an incomplete one never is', async () => {
  const { operatorId } = await onboardCompany();
  const created = await one('SELECT * FROM operators WHERE id=$1', [operatorId]);
  assert.equal(created.type, 'company');
  assert.equal(created.verification_status, 'pending_verification');
  assert.equal(created.legal_name, COMPANY_DOSSIER.legalName);
  assert.equal(created.registered_address, COMPANY_DOSSIER.registeredAddress);
  assert.equal(created.representative_name, COMPANY_DOSSIER.representativeName);

  // Everything is filed but nothing is reviewed: refusing is the whole point.
  await assert.rejects(onboard.verification(platformOps, operatorId, 'verified'), { code: 'VERIFICATION_INCOMPLETE' });
  await reviewAll(operatorId);
  const verified = await onboard.verification(platformOps, operatorId, 'verified');
  assert.equal(verified.verificationStatus, 'verified');
  const row = await one('SELECT verified_at,verified_by FROM operators WHERE id=$1', [operatorId]);
  assert.equal(row.verified_by, platformOps.id, 'the decision records who took it');
  assert.ok(row.verified_at);
});

for (const missing of REQUIRED.company) {
  test(`a company dossier whose ${missing} is not reviewed cannot be verified`, async () => {
    const { operatorId } = await onboardCompany({ displayName: 'Partielle ' + missing, contactPhone: '+229 61000111' });
    await reviewAll(operatorId, { skip: [missing] });
    await assert.rejects(onboard.verification(platformOps, operatorId, 'verified'),
      /** @param {any} error */ error => {
        assert.equal(error.code, 'VERIFICATION_INCOMPLETE');
        assert.ok(error.message.includes(missing), `the reviewer is told which proof is outstanding: ${error.message}`);
        return true;
      });
    // Reviewing the last piece completes it, so the refusal was about that
    // document and not something incidental.
    await reviewAll(operatorId);
    assert.equal((await onboard.verification(platformOps, operatorId, 'verified')).verificationStatus, 'verified');
  });
}

test('a rejected proof blocks verification until it is replaced', async () => {
  const { operatorId } = await onboardCompany({ displayName: 'Refus SARL', contactPhone: '+229 61000112' });
  await reviewAll(operatorId, { reject: ['tax_registration'] });
  await assert.rejects(onboard.verification(platformOps, operatorId, 'verified'), { code: 'VERIFICATION_INCOMPLETE' });
  const rejected = await one("SELECT id,notes,status FROM verification_evidence WHERE operator_id=$1 AND kind='tax_registration'", [operatorId]);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.notes, 'Document illisible.', 'the operator is told why');
  await onboard.verification(platformOps, operatorId, { type: 'evidence', evidenceId: rejected.id, status: 'verified' });
  assert.equal((await onboard.verification(platformOps, operatorId, 'verified')).verificationStatus, 'verified');
});

test('a company can never verify itself, nor touch another company dossier', async () => {
  const first = await onboardCompany({ displayName: 'Auto Verif SARL', contactPhone: '+229 61000113' });
  const second = await onboardCompany({ displayName: 'Concurrent Express', contactPhone: '+229 61000114' });
  await reviewAll(first.operatorId);
  // Company Ops is still role 'ops'; the operator_id is what separates them.
  await assert.rejects(onboard.verification(first.actor, first.operatorId, 'verified'), { code: 'FORBIDDEN' });
  await assert.rejects(onboard.verification(second.actor, first.operatorId, 'verified'), { code: 'FORBIDDEN' });
  await assert.rejects(onboard.evidence(first.actor, second.operatorId), { code: 'FORBIDDEN' });
  await assert.rejects(onboard.evidence(first.actor, first.operatorId), { code: 'FORBIDDEN' });
  await assert.rejects(onboard.evidence({ id: first.userId, role: 'passenger' }, first.operatorId), { code: 'FORBIDDEN' });
  // Platform Ops can.
  const reviewed = await onboard.evidence(platformOps, first.operatorId);
  assert.equal(reviewed.length, REQUIRED.company.length);
});

// ---------------------------------------------------------------------------
// Independent owner-driver (KYC)
// ---------------------------------------------------------------------------

test('a full independent dossier stores the person and the vehicle, and verifies', async () => {
  const { userId, operatorId } = await onboardIndependent({ vehicleRegistration: 'AB-9001-RB' });
  const driver = await one('SELECT * FROM driver_profiles WHERE user_id=$1', [userId]);
  assert.equal(driver.license_reference, INDEPENDENT_DOSSIER.licenseReference);
  assert.equal(driver.id_document_type, 'national_id');
  assert.equal(driver.id_document_reference, INDEPENDENT_DOSSIER.idDocumentReference);
  assert.equal(driver.photo_url, INDEPENDENT_DOSSIER.driverPhotoUrl);
  assert.equal(driver.insurance_reference, INDEPENDENT_DOSSIER.insuranceReference);
  assert.equal(driver.roadworthiness_reference, INDEPENDENT_DOSSIER.roadworthinessReference);
  const vehicle = await one('SELECT * FROM vehicles WHERE operator_id=$1', [operatorId]);
  assert.equal(vehicle.registration, 'AB-9001-RB');
  assert.equal(vehicle.make, 'Toyota');
  assert.equal(vehicle.color, 'Blanc');
  assert.equal(vehicle.model_year, 2019);

  await assert.rejects(onboard.verification(platformOps, operatorId, 'verified'), { code: 'VERIFICATION_INCOMPLETE' });
  await reviewAll(operatorId);
  assert.equal((await onboard.verification(platformOps, operatorId, 'verified')).verificationStatus, 'verified');
});

for (const field of ['idDocumentReference', 'licenseReference', 'transportAuthorizationReference',
  'insuranceReference', 'roadworthinessReference', 'vehicleRegistration']) {
  test(`an independent applicant without ${field} is refused at onboarding`, async () => {
    await assert.rejects(onboardIndependent({ [field]: undefined }), { code: 'INVALID_ONBOARDING' });
  });
}
for (const field of ['idDocumentUrl', 'licenseDocumentUrl', 'transportAuthorizationDocumentUrl',
  'insuranceDocumentUrl', 'roadworthinessDocumentUrl', 'vehicleRegistrationDocumentUrl', 'driverPhotoUrl']) {
  test(`an independent applicant without ${field} is refused at onboarding`, async () => {
    await assert.rejects(onboardIndependent({ [field]: undefined }), { code: 'INVALID_ONBOARDING' });
  });
}
for (const missing of REQUIRED.independent) {
  test(`an independent dossier whose ${missing} is not reviewed cannot be verified`, async () => {
    const { operatorId } = await onboardIndependent();
    await reviewAll(operatorId, { skip: [missing] });
    await assert.rejects(onboard.verification(platformOps, operatorId, 'verified'),
      /** @param {any} error */ error => {
        assert.equal(error.code, 'VERIFICATION_INCOMPLETE');
        assert.ok(error.message.includes(missing), error.message);
        return true;
      });
    await reviewAll(operatorId);
    assert.equal((await onboard.verification(platformOps, operatorId, 'verified')).verificationStatus, 'verified');
  });
}

test('current policy requires a driver photo, and it is filed as its own proof', async () => {
  const { operatorId } = await onboardIndependent();
  const photo = await one("SELECT * FROM verification_evidence WHERE operator_id=$1 AND kind='driver_photo'", [operatorId]);
  assert.ok(photo, 'the driver photo is part of the reviewed dossier');
  assert.equal(photo.file_url, INDEPENDENT_DOSSIER.driverPhotoUrl);
  assert.ok(REQUIRED.independent.includes('driver_photo'));
});

// ---------------------------------------------------------------------------
// Document reference safety
// ---------------------------------------------------------------------------

test('an unsafe document reference is refused before it is ever stored', async () => {
  // `https://` alone is not a safety property: every address below satisfies
  // "must use HTTPS" and none of them is a document a reviewer should open.
  const unsafe = [
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'file:///etc/passwd',
    'http://documents.leroutier.app/doc.pdf',            // not https
    'https://user:secret@documents.leroutier.app/d.pdf', // embedded credentials
    'https://documents.leroutier.app:8443/d.pdf',        // explicit port
    'https://127.0.0.1/doc.pdf',
    'https://10.0.0.5/doc.pdf',
    'https://169.254.169.254/latest/meta-data/',         // cloud metadata
    'https://192.168.1.10/doc.pdf',
    'https://[::1]/doc.pdf',
    'https://localhost/doc.pdf',
    'https://intranet.local/doc.pdf',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://2130706433/doc.pdf',                        // 127.0.0.1 in decimal
    'https://intranet/doc.pdf',                          // single label, no dot
    'not a url at all',
  ];
  const before = (await one('SELECT count(*)::integer AS n FROM verification_evidence')).n;
  for (const value of unsafe) {
    await assert.rejects(onboardCompany({ displayName: 'Mauvais Lien', contactPhone: '+229 61000115', registrationDocumentUrl: value }),
      { code: 'INVALID_ONBOARDING' }, `${value} must be refused`);
    await assert.rejects(onboardIndependent({ driverPhotoUrl: value }),
      { code: 'INVALID_ONBOARDING' }, `${value} must be refused as a photo too`);
  }
  assert.equal((await one('SELECT count(*)::integer AS n FROM verification_evidence')).n, before,
    'nothing unsafe is ever persisted');
  // A plain public https document reference is accepted.
  const ok = await onboardCompany({ displayName: 'Bon Lien SARL', contactPhone: '+229 61000116',
    registrationDocumentUrl: 'https://docs.example.org/rccm.pdf' });
  assert.equal((await one("SELECT file_url FROM verification_evidence WHERE operator_id=$1 AND kind='company_registration'", [ok.operatorId])).file_url,
    'https://docs.example.org/rccm.pdf');
});

// ---------------------------------------------------------------------------
// What the public actually sees
// ---------------------------------------------------------------------------

/** An independent operator running one real, bookable service. */
async function independentService({ verified = true } = {}) {
  const { userId, operatorId } = await onboardIndependent();
  if (verified) { await reviewAll(operatorId); await onboard.verification(platformOps, operatorId, 'verified'); }
  const routeId = randomUUID(), serviceId = randomUUID();
  const vehicle = await one('SELECT id,capacity FROM vehicles WHERE operator_id=$1', [operatorId]);
  await db.transaction(async tx => {
    await tx.query('INSERT INTO routes(id,operator_id,name) VALUES($1,$2,$3)', [routeId, operatorId, 'Cotonou → Bohicon (indépendant)']);
    await tx.query('INSERT INTO route_stops(route_id,sequence,stop_id,fare_to_next) VALUES($1,0,$2,3000),($1,1,$3,0)', [routeId, demoId(200), demoId(201)]);
    await tx.query(`INSERT INTO services(id,route_id,operator_id,departure_at,capacity,status)
      VALUES($1,$2,$3,now()+interval '3 hours',$4,'scheduled')`, [serviceId, routeId, operatorId, vehicle.capacity]);
    await tx.query('INSERT INTO service_stops(service_id,sequence,stop_id) SELECT $1,sequence,stop_id FROM route_stops WHERE route_id=$2', [serviceId, routeId]);
    await tx.query('INSERT INTO service_segments(service_id,sequence,fare_minor) SELECT $1,sequence,fare_to_next FROM route_stops WHERE route_id=$2 AND sequence<1', [serviceId, routeId]);
    await tx.query('INSERT INTO service_seats(service_id,seat_number) SELECT $1,generate_series(1,$2::integer)', [serviceId, vehicle.capacity]);
    await tx.query('INSERT INTO service_assignments(service_id,driver_id,vehicle_id) VALUES($1,$2,$3)', [serviceId, userId, vehicle.id]);
  });
  return { userId, operatorId, serviceId };
}

test('a verified independent service publishes the driver and vehicle a passenger needs to recognise', async () => {
  const { serviceId } = await independentService();
  const offer = (await domain.search({ originStopId: demoId(200), destinationStopId: demoId(201) })).find(s => s.id === serviceId);
  assert.ok(offer, 'a verified independent service is publicly bookable');
  assert.equal(offer.operator_type, 'independent');
  assert.equal(offer.driver_name, INDEPENDENT_DOSSIER.displayName);
  assert.equal(offer.driver_photo_url, INDEPENDENT_DOSSIER.driverPhotoUrl);
  assert.equal(offer.vehicle_make, 'Toyota');
  assert.equal(offer.vehicle_color, 'Blanc');
  assert.ok(offer.registration);
  // The recognisable half is public; the dossier is not.
  const text = JSON.stringify(offer);
  for (const secret of ['CNI-4457821', 'PC-BJ-778812', 'ASS-2024-5512', 'VT-2024-7781', 'documents.leroutier.app', 'id_document']) {
    assert.ok(!text.includes(secret), `the public catalogue must not contain ${secret}`);
  }
});

test('an unverified independent service is not publicly bookable at all', async () => {
  const { serviceId } = await independentService({ verified: false });
  assert.ok(!(await domain.search({ originStopId: demoId(200), destinationStopId: demoId(201) })).some(s => s.id === serviceId),
    'pending verification is not a publishable state');
  const plan = await planner.plan({ originStopId: demoId(200), destinationStopId: demoId(201) });
  assert.ok(!plan.options.some(o => o.serviceId === serviceId));
});

test('suspending an operator removes its services from both public surfaces immediately', async () => {
  const { serviceId, operatorId } = await independentService();
  assert.ok((await domain.search({ originStopId: demoId(200), destinationStopId: demoId(201) })).some(s => s.id === serviceId));
  await onboard.verification(platformOps, operatorId, 'suspended');
  assert.ok(!(await domain.search({ originStopId: demoId(200), destinationStopId: demoId(201) })).some(s => s.id === serviceId),
    'a suspended operator stops being bookable now, not when its last service expires');
  const plan = await planner.plan({ originStopId: demoId(200), destinationStopId: demoId(201) });
  assert.ok(!plan.options.some(o => o.serviceId === serviceId));
  // Suspension and rejection are never evidence-gated: stopping an operator
  // must always be possible immediately.
  await onboard.verification(platformOps, operatorId, 'rejected');
  assert.equal((await one('SELECT verification_status FROM operators WHERE id=$1', [operatorId])).verification_status, 'rejected');
});

test('the public journey plan carries the independent driver identity and no dossier material', async () => {
  const { serviceId, operatorId } = await independentService();
  const plan = await planner.plan({ originStopId: demoId(200), destinationStopId: demoId(201) });
  const option = plan.options.find(o => o.serviceId === serviceId);
  assert.ok(option, 'the verified independent service is plannable');
  assert.equal(option.operatorType, 'independent');
  assert.equal(option.verified, true);
  assert.equal(option.driver.name, INDEPENDENT_DOSSIER.displayName);
  assert.equal(option.driver.photoUrl, INDEPENDENT_DOSSIER.driverPhotoUrl);
  assert.equal(option.vehicle.make, 'Toyota');
  assert.equal(option.vehicle.color, 'Blanc');
  // The two photographs above ARE public: that is how a passenger recognises
  // the person and the car. Every proof in the dossier is not.
  const text = JSON.stringify(plan);
  const proofs = (await db.transaction(async tx => (await tx.query(
    "SELECT file_url FROM verification_evidence WHERE operator_id=$1 AND kind NOT IN ('driver_photo','vehicle_photo')", [operatorId])).rows)).map(r => r.file_url);
  assert.ok(proofs.length >= 6, 'the dossier really does hold proof references');
  for (const uri of proofs) assert.ok(!text.includes(uri), `the public plan must not contain the proof reference ${uri}`);
  for (const secret of ['CNI-4457821', 'PC-BJ-778812', 'ASS-2024-5512', 'id_document', 'licenseReference']) {
    assert.ok(!text.includes(secret), `the public plan must not contain ${secret}`);
  }
});

test('a company service publishes the company, never the name of the employee driving it', async () => {
  const operator = await one('SELECT type,verification_status FROM operators WHERE id=$1', [demo.operator]);
  assert.equal(operator.type, 'company');
  assert.equal(operator.verification_status, 'verified');
  const driverName = (await one('SELECT display_name FROM users WHERE id=$1', [demo.driver])).display_name;
  const company = (await domain.search({ includeDemo: true })).filter(s => s.operator_type === 'company');
  assert.ok(company.length > 0, 'the seeded company service is bookable');
  for (const offer of company) {
    assert.equal(offer.driver_name, null, 'a company employee is never named in the public catalogue');
    assert.equal(offer.driver_photo_url, null);
    assert.ok(offer.operator_name, 'the verified company is what the passenger sees instead');
  }
  assert.ok(!JSON.stringify(company).includes(driverName),
    'publishing which employee drives which bus at which hour is staff surveillance, not a product feature');
});

// ---------------------------------------------------------------------------
// One rule, one place
// ---------------------------------------------------------------------------

test('the review queue reports completeness from the same rule verification enforces', async () => {
  const { operatorId } = await onboardCompany({ displayName: 'Cohérence SARL', contactPhone: '+229 61000120' });
  const queueFor = async id => (await health.read(platformOps)).kycQueue.find(o => o.id === id);

  const pending = await queueFor(operatorId);
  assert.equal(pending.evidenceComplete, false);
  assert.deepEqual(pending.evidenceRequired.slice().sort(), REQUIRED.company.slice().sort());
  assert.deepEqual(pending.evidenceMissing.slice().sort(), REQUIRED.company.slice().sort());
  // The console blocks the decision exactly when the server would refuse it.
  await assert.rejects(onboard.verification(platformOps, operatorId, 'verified'), { code: 'VERIFICATION_INCOMPLETE' });

  // A rejected proof keeps the dossier incomplete even once everything is reviewed.
  await reviewAll(operatorId, { reject: ['tax_registration'] });
  const withRejection = await queueFor(operatorId);
  assert.equal(withRejection.evidenceComplete, false, 'a rejected proof is not a complete dossier');
  assert.deepEqual(withRejection.evidenceRejected, ['tax_registration']);
  await assert.rejects(onboard.verification(platformOps, operatorId, 'verified'), { code: 'VERIFICATION_INCOMPLETE' });

  await reviewAll(operatorId);
  const ready = await queueFor(operatorId);
  assert.equal(ready.evidenceComplete, true);
  assert.deepEqual(ready.evidenceMissing, []);
  assert.equal((await onboard.verification(platformOps, operatorId, 'verified')).verificationStatus, 'verified');
  // Once verified it leaves the queue, which is why the dossier must stay
  // readable through its own endpoint.
  assert.equal(await queueFor(operatorId), undefined);
  assert.equal((await onboard.evidence(platformOps, operatorId)).length, REQUIRED.company.length);
});

test('Platform Ops health never carries an authentication secret', async () => {
  const report = await health.read(platformOps);
  const text = JSON.stringify(report);
  for (const secret of ['auth_subject', 'password', 'id_token', 'refresh_token', 'access_token',
    'session_secret', 'api_secret', 'webhook_secret', 'private_key', 'DATABASE_URL']) {
    assert.ok(!text.includes(secret), `Platform Ops must never see ${secret}`);
  }
  // Company Ops and passengers cannot read it at all.
  await assert.rejects(health.read({ id: platformOps.id, role: 'ops', operator_id: demo.operator }), { code: 'FORBIDDEN' });
  await assert.rejects(health.read({ id: demo.passenger, role: 'passenger' }), { code: 'FORBIDDEN' });
});
