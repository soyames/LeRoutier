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

test('the Platform Ops user register searches and pages on the server', async () => {
  const marker = 'Registre' + randomUUID().slice(0, 6);
  for (let n = 0; n < 7; n += 1) await newPassenger(`${marker} Compte ${n}`);

  // A search is answered by the database, not by filtering a truncated array
  // in the browser — so the total describes the same filter as the page.
  const found = await health.users(platformOps, { q: marker, limit: 3 });
  assert.equal(found.total, 7);
  assert.equal(found.users.length, 3);
  assert.ok(found.users.every(u => u.display_name.startsWith(marker)));

  const second = await health.users(platformOps, { q: marker, limit: 3, offset: 3 });
  assert.equal(second.total, 7);
  assert.equal(second.users.length, 3);
  const last = await health.users(platformOps, { q: marker, limit: 3, offset: 6 });
  assert.equal(last.users.length, 1, 'the final page is short, not empty');
  const ids = new Set([...found.users, ...second.users, ...last.users].map(u => u.id));
  assert.equal(ids.size, 7, 'paging returns each account exactly once');

  // An account past the first page is still findable by name and by id: the
  // failure this replaces was a search that silently stopped at a fixed cap.
  const target = last.users[0];
  assert.equal((await health.users(platformOps, { q: target.id })).total, 1);
  assert.equal((await health.users(platformOps, { q: target.display_name })).total, 1);
  // A query matching nothing is an honest empty answer.
  assert.equal((await health.users(platformOps, { q: 'aucun-compte-' + randomUUID() })).total, 0);
});

test('the user register is minimal, and Company Ops cannot read it', async () => {
  const listing = await health.users(platformOps, { limit: 5 });
  const text = JSON.stringify(listing);
  // A driving licence is a government identifier. It belongs to the reviewed
  // dossier, not to a directory listing.
  assert.ok(!text.includes('license_reference'), 'no licence number in a user listing');
  for (const secret of ['auth_subject', 'password', 'id_token', 'refresh_token', 'access_token']) {
    assert.ok(!text.includes(secret), `the register must never carry ${secret}`);
  }
  assert.ok(listing.users.every(u => typeof u.authenticated === 'boolean'),
    'whether an identity provider is linked is a boolean, never the subject itself');
  await assert.rejects(health.users({ id: platformOps.id, role: 'ops', operator_id: demo.operator }, {}), { code: 'FORBIDDEN' });
  await assert.rejects(health.users({ id: demo.passenger, role: 'passenger' }, {}), { code: 'FORBIDDEN' });
});

test('a page size cannot be used to dump the whole register', async () => {
  const huge = await health.users(platformOps, { limit: 100000 });
  assert.ok(huge.users.length <= 100, 'the server caps the page size it will serve');
  assert.equal(huge.limit, 100);
  const negative = await health.users(platformOps, { limit: -5, offset: -10 });
  assert.equal(negative.limit, 50, 'a nonsense page size falls back to the default');
  assert.equal(negative.offset, 0);
});

// ---------------------------------------------------- correcting a refusal --
// The loop that was missing entirely. A reviewer could refuse a proof and write
// why; the operator saw neither and had no way to submit a replacement, while
// verification() refused to proceed until one arrived. Every dossier with a
// single refused document was permanently stuck — for the operator AND for the
// reviewer who refused it.
test('an operator reads its own file, sees why a proof was refused, and replaces it', async () => {
  const { operatorId, actor } = await onboardIndependent();
  await reviewAll(operatorId, { reject: ['insurance'] });

  const before = await onboard.dossier(actor);
  assert.equal(before.verificationStatus, 'pending_verification');
  const refused = before.evidence.find(e => e.kind === 'insurance');
  assert.equal(refused.status, 'rejected');
  assert.equal(refused.notes, 'Document illisible.', 'the operator is told what was wrong');
  assert.deepEqual(before.correctable, [refused.id], 'and exactly which proof they may replace');
  // Who reviewed it is internal; what they decided is the operator's business.
  assert.ok(!Object.hasOwn(refused, 'reviewed_by'));

  // Verification is genuinely blocked until it is fixed.
  await assert.rejects(onboard.verification(platformOps, operatorId, 'verified'), { code: 'VERIFICATION_INCOMPLETE' });

  const replaced = await onboard.resubmitEvidence(actor, refused.id,
    { reference: 'ASS-2025-9001', fileUrl: doc('assurance-2025') });
  assert.equal(replaced.status, 'pending', 'a replacement goes back into the queue, not straight to verified');
  const after = await onboard.dossier(actor);
  const fixed = after.evidence.find(e => e.kind === 'insurance');
  assert.equal(fixed.notes, null, 'the old refusal no longer hangs over the new document');
  assert.equal(fixed.reviewed_at, null);
  assert.deepEqual(after.correctable, []);

  // And now the dossier can actually complete.
  await onboard.verification(platformOps, operatorId, { type: 'evidence', evidenceId: refused.id, status: 'verified' });
  const decision = await onboard.verification(platformOps, operatorId, 'verified');
  assert.equal(decision.verificationStatus, 'verified');
});

test('only a refused proof can be replaced, and only by that operator', async () => {
  const mine = await onboardIndependent();
  const theirs = await onboardIndependent();
  await reviewAll(mine.operatorId, { reject: ['roadworthiness'] });
  await reviewAll(theirs.operatorId, { reject: ['roadworthiness'] });
  const refused = (await onboard.dossier(mine.actor)).evidence.find(e => e.kind === 'roadworthiness');
  const accepted = (await onboard.dossier(mine.actor)).evidence.find(e => e.kind === 'identity');
  const otherOperators = (await onboard.dossier(theirs.actor)).evidence.find(e => e.kind === 'roadworthiness');

  // A proof that was accepted is not a correction opportunity.
  await assert.rejects(onboard.resubmitEvidence(mine.actor, accepted.id, { fileUrl: doc('autre') }),
    { code: 'EVIDENCE_NOT_REJECTED' });
  // Another operator's evidence id is not found, not forbidden-with-detail:
  // the scope is in the WHERE clause, so it can never become a cross-tenant write.
  await assert.rejects(onboard.resubmitEvidence(mine.actor, otherOperators.id, { fileUrl: doc('autre') }),
    { code: 'NOT_FOUND' });
  // A passenger with no operator has no file at all.
  const outsider = await newPassenger();
  await assert.rejects(onboard.dossier({ id: outsider, role: 'passenger' }), { code: 'NOT_FOUND' });
  await assert.rejects(onboard.resubmitEvidence({ id: outsider, role: 'passenger' }, refused.id, { fileUrl: doc('x') }),
    { code: 'NOT_FOUND' });
  // Re-sending the same document that was just refused is not a correction.
  await assert.rejects(onboard.resubmitEvidence(mine.actor, refused.id,
    { reference: refused.reference, fileUrl: refused.file_url }), { code: 'INVALID_ONBOARDING' });
  // And a replacement link is held to the same address rules as the original.
  for (const hostile of ['http://documents.example/x.pdf', 'https://169.254.169.254/latest/meta-data/',
    'https://user:token@documents.example/x.pdf', 'https://10.0.0.5/x.pdf']) {
    await assert.rejects(onboard.resubmitEvidence(mine.actor, refused.id, { fileUrl: hostile }),
      { code: 'INVALID_ONBOARDING' }, `${hostile} was accepted as a replacement proof`);
  }
});

test('a rejected operator cannot resurrect itself, but Platform Ops can re-open the file', async () => {
  const { operatorId, actor } = await onboardIndependent();
  await reviewAll(operatorId, { reject: ['identity'] });
  const refused = (await onboard.dossier(actor)).evidence.find(e => e.kind === 'identity');
  await onboard.verification(platformOps, operatorId, 'rejected');

  // Refusing the OPERATOR is a judgement about the operator, not about a
  // blurry photograph. Re-uploading must not undo it.
  await assert.rejects(onboard.resubmitEvidence(actor, refused.id, { reference: 'CNI-9', fileUrl: doc('cni-2') }),
    { code: 'VERIFICATION_CLOSED' });
  const closed = await onboard.dossier(actor);
  assert.equal(closed.verificationStatus, 'rejected');
  assert.deepEqual(closed.correctable, [], 'and the console is told there is nothing to offer');

  // Reconsideration is LeRoutier's decision, and it exists.
  await onboard.verification(platformOps, operatorId, 'pending_verification');
  assert.equal((await onboard.dossier(actor)).verificationStatus, 'pending_verification');
  const fixed = await onboard.resubmitEvidence(actor, refused.id, { reference: 'CNI-9', fileUrl: doc('cni-2') });
  assert.equal(fixed.status, 'pending');
  // An ordinary operator still cannot re-open its own file.
  await assert.rejects(onboard.verification(actor, operatorId, 'pending_verification'), { code: 'FORBIDDEN' });
});

test('a photo proof is corrected by its file alone, since it carries no reference', async () => {
  const { operatorId, actor } = await onboardIndependent();
  await reviewAll(operatorId, { reject: ['driver_photo'] });
  const refused = (await onboard.dossier(actor)).evidence.find(e => e.kind === 'driver_photo');
  assert.equal(refused.reference, null, 'a photo has no reference to retype');
  const fixed = await onboard.resubmitEvidence(actor, refused.id, { fileUrl: 'https://photos.leroutier.app/koffi-2.jpg' });
  assert.equal(fixed.status, 'pending');
  assert.equal(fixed.file_url, 'https://photos.leroutier.app/koffi-2.jpg');
});

// ------------------------------------------- what a document link may be ----
// LeRoutier does not host these files, so it cannot check a real MIME type or
// a size. What it CAN refuse is a link that is plainly not a document — and
// the one that matters is SVG: an image everywhere else in a product, and a
// scripted page in a reviewer's browser.
test('a proof link cannot be active content a reviewer would execute', async () => {
  for (const hostile of ['https://documents.example.test/cni.svg', 'https://documents.example.test/cni.html',
    'https://documents.example.test/cni.htm', 'https://documents.example.test/cni.xml',
    'https://documents.example.test/payload.js', 'https://documents.example.test/dossier.zip',
    'https://documents.example.test/app.apk', 'https://documents.example.test/run.exe']) {
    await assert.rejects(onboardIndependent({ idDocumentUrl: hostile }), { code: 'INVALID_ONBOARDING' },
      `${hostile} was accepted as an identity document`);
  }
  // And the ordinary shapes a real dossier arrives in still work.
  for (const fine of ['https://documents.example.test/cni.pdf', 'https://documents.example.test/cni.JPG',
    'https://documents.example.test/cni.heic', 'https://documents.example.test/cni.webp',
    // No extension at all: plenty of legitimate hosts serve from an opaque
    // path, and refusing those would block real document storage.
    'https://documents.example.test/d/AbC123', 'https://documents.example.test/file?id=99']) {
    const created = await onboardIndependent({ idDocumentUrl: fine });
    assert.ok(created.operatorId, `${fine} was refused although it is a plausible document`);
  }
});

test('the platform states plainly whether it holds these documents', async () => {
  const { evidenceStorageState, evidenceStore, memoryEvidenceStore } = await import('../src/evidence-storage.js');
  // With no provider configured, nothing anywhere may imply managed custody
  // while the documents live on hosts LeRoutier neither controls nor revokes.
  assert.equal(evidenceStore({}), null, 'an unconfigured deployment selects no store');
  const unmanaged = evidenceStorageState(null);
  assert.equal(unmanaged.managed, false);
  assert.equal(unmanaged.mode, 'operator_hosted_link');
  assert.equal(unmanaged.provider, null);
  // And with one, the state says so and names it.
  const managed = evidenceStorageState(memoryEvidenceStore());
  assert.equal(managed.managed, true);
  assert.equal(managed.mode, 'managed_private_object_store');
  assert.equal(managed.provider, 'memory');
});

// ------------------------------------------ telling the operator what happened --
// The decisions were written to the outbox and nothing consumed them. An
// operator learned the outcome by opening the app and noticing, which makes
// the correction loop unusable: only somebody who knows a proof was refused
// can replace it.
test('a refused proof reaches the operator who has to replace it', async () => {
  const { notificationPolicies } = await import('../src/notifications.js');
  const notify = notificationPolicies(db, { ...config, notificationProviders: {} });
  const { operatorId, actor, userId } = await onboardIndependent();
  const evidence = await reviewAll(operatorId, { reject: ['insurance'] });
  const insurance = evidence.find(e => e.kind === 'insurance');

  // Dispatch whatever the review produced.
  const events = await db.transaction(async tx => (await tx.query(
    `SELECT id,event_type,aggregate_id,payload FROM outbox WHERE event_type='operator.evidence_reviewed'
     AND aggregate_id=$1 ORDER BY created_at`, [operatorId])).rows);
  assert.ok(events.length, 'the review is recorded as an event at all');
  for (const event of events) await db.transaction(tx => notify.dispatchEvent(tx, event));

  const inbox = await db.transaction(async tx => (await tx.query(
    `SELECT template,severity,category FROM notifications WHERE user_id=$1 ORDER BY created_at DESC`, [userId])).rows);
  const refusal = inbox.find(n => n.template === 'operator_evidence_rejected');
  assert.ok(refusal, 'the operator is told a proof was refused: ' + JSON.stringify(inbox));
  assert.equal(refusal.severity, 'urgent');
  assert.equal(refusal.category, 'critical', 'whether you may carry passengers is not a marketing preference');
  // Accepting a proof is routine and does not interrupt anybody.
  assert.ok(!inbox.some(n => n.template === 'operator_evidence_accepted'));

  // And the dossier the operator opens does say which one.
  const dossier = await onboard.dossier(actor);
  assert.equal(dossier.correctable.length, 1);
  assert.equal(dossier.evidence.find(e => e.id === dossier.correctable[0]).kind, 'insurance');
  assert.ok(insurance);
});

test('a verification decision reaches an independent owner and a company alike', async () => {
  const { notificationPolicies } = await import('../src/notifications.js');
  const notify = notificationPolicies(db, { ...config, notificationProviders: {} });
  const independent = await onboardIndependent();
  const company = await onboardCompany();
  for (const dossier of [independent, company]) {
    await reviewAll(dossier.operatorId);
    await onboard.verification(platformOps, dossier.operatorId, 'verified');
  }
  const events = await db.transaction(async tx => (await tx.query(
    `SELECT id,event_type,aggregate_id,payload FROM outbox WHERE event_type='operator.verification_changed'
     AND aggregate_id=ANY($1::uuid[])`, [[independent.operatorId, company.operatorId]])).rows);
  for (const event of events) await db.transaction(tx => notify.dispatchEvent(tx, event));

  // Both shapes, because the accountable person lives in a different place in
  // each: an independent operator has an owner, a company has staff.
  for (const dossier of [independent, company]) {
    const inbox = await db.transaction(async tx => (await tx.query(
      'SELECT template FROM notifications WHERE user_id=$1', [dossier.userId])).rows);
    assert.ok(inbox.some(n => n.template === 'operator_verified'),
      'an operator was never told it was verified: ' + JSON.stringify(inbox));
  }
});

// ------------------------------------------------ account lifecycle, factually --
test('last sign-in is recorded, bounded, and never invented for old accounts', async () => {
  const { mapIdentity } = await import('../src/identities.js');
  const subject = 'ws11-' + randomUUID();

  // An account that existed before the measurement reads as not observed.
  const legacy = randomUUID();
  await db.transaction(tx => tx.query(
    `INSERT INTO users(id,display_name,role,auth_subject,auth_issuer) VALUES($1,'Compte Ancien','passenger',$2,'test')`,
    [legacy, 'legacy-' + legacy]));
  const before = await one('SELECT last_authenticated_at FROM users WHERE id=$1', [legacy]);
  assert.equal(before.last_authenticated_at, null, 'no login history is fabricated for an account that has none');

  // Signing in records it.
  const user = await mapIdentity(db, { subject, issuer: 'https://issuer.test.invalid' });
  const first = await one('SELECT last_authenticated_at FROM users WHERE id=$1', [user.id]);
  assert.ok(first.last_authenticated_at, 'signing in is observed');

  // The write is bounded: identity mapping runs on EVERY authenticated
  // request, so a second call inside the hour must not touch the row again.
  await mapIdentity(db, { subject, issuer: 'https://issuer.test.invalid' });
  const second = await one('SELECT last_authenticated_at FROM users WHERE id=$1', [user.id]);
  assert.equal(second.last_authenticated_at.getTime(), first.last_authenticated_at.getTime(),
    'a row update per API call is exactly the write amplification this platform refuses registrations to avoid');

  // Once the hour has passed it does refresh, so the value stays truthful.
  await db.transaction(tx => tx.query(
    `UPDATE users SET last_authenticated_at=now()-interval '3 hours' WHERE id=$1`, [user.id]));
  await mapIdentity(db, { subject, issuer: 'https://issuer.test.invalid' });
  const third = await one('SELECT last_authenticated_at FROM users WHERE id=$1', [user.id]);
  assert.ok(third.last_authenticated_at > second.last_authenticated_at);
});

test('the Platform Ops register reports activity and suspension without exposing a secret', async () => {
  const { mapIdentity } = await import('../src/identities.js');
  const subject = 'ws11-register-' + randomUUID();
  const user = await mapIdentity(db, { subject, issuer: 'https://issuer.test.invalid' });
  await db.transaction(tx => tx.query(
    `INSERT INTO audit_events(actor_id,action,entity_id,details) VALUES($1,'identity.activation_changed',$1,'{"active":false}')`,
    [user.id]));

  const page = await health.users(platformOps, { q: user.id, limit: 5 });
  const row = page.users.find(u => u.id === user.id);
  assert.ok(row, 'the account is findable by id');
  assert.ok(row.last_authenticated_at, 'last sign-in reaches the console');
  assert.equal(row.status_changed_to, 'false', 'and so does the last suspension, from the audit trail');
  assert.ok(row.status_changed_at);

  // The register stays minimal. A sign-in timestamp is lifecycle information;
  // the credential behind it is not, in any form.
  const text = JSON.stringify(page);
  for (const forbidden of ['auth_subject', 'token', 'password', 'refresh', 'securetoken', subject]) {
    assert.ok(!text.includes(forbidden), `${forbidden} reached the Platform Ops register`);
  }
  assert.equal(row.authenticated, true, 'presence of an external identity is reported as a boolean, not as the subject');
});

// ------------------------------------------ the end of the onboarding funnel --
// The acceptance this suite exists for: a verified operator reaches real,
// bookable inventory without a hidden admin step. It used to stop dead for
// every independent driver — role='driver' could not satisfy the role='ops'
// check every provisioning mutation ran, so an operator passed KYC, was
// verified by a person, and could then publish nothing. Ever.
test('a verified independent owner-driver publishes a real, bookable departure', async () => {
  const { provisioning } = await import('../src/provisioning.js');
  const { transport } = await import('../src/transport.js');
  const provision = provisioning(db, { issuer: 'https://issuer.test.invalid' });
  const search = transport(db);

  const { operatorId, actor, userId } = await onboardIndependent();
  await reviewAll(operatorId);
  await onboard.verification(platformOps, operatorId, 'verified');
  // The identity the API would hand to the route, not a hand-made actor.
  const owner = await db.transaction(tx => import('../src/identities.js')
    .then(m => m.activeIdentity(tx, userId)));
  assert.equal(owner.role, 'driver', 'they stay a driver, because a service assignment names one');

  // 1. They can read the catalogue they need to build from.
  const catalog = await provision.catalog(owner);
  assert.ok(catalog.vehicles.length >= 1, 'the vehicle from their dossier is there');
  assert.ok(catalog.stops.length >= 2);

  // 2. A line, with its fares.
  const [from, to] = catalog.stops.slice(0, 2);
  const route = await provision.route(owner, { operatorId, name: 'Ma ligne',
    stops: [{ stopId: from.id, fareToNext: 3000 }, { stopId: to.id, fareToNext: 0 }] }, randomUUID());
  assert.ok(route.id);

  // 3. A real departure, with themselves driving it.
  const departureAt = new Date(Date.now() + 6 * 3600_000).toISOString();
  const service = await provision.service(owner, { routeId: route.id, vehicleId: catalog.vehicles[0].id,
    driverId: userId, departureAt }, randomUUID());
  assert.ok(service.id);

  // 4. And a passenger can actually find and hold a seat on it. Publishing that
  //    nobody can book is not publishing.
  const offers = await search.search({ originStopId: from.id, destinationStopId: to.id, includeDemo: false });
  const mine = offers.find(o => o.service_id === service.id || o.id === service.id);
  assert.ok(mine, 'the departure reaches public search: ' + JSON.stringify(offers.map(o => o.id)));

  // They still cannot create accounts: an ops account inside their own
  // operator could approve their own withdrawals.
  await assert.rejects(provision.opsUser(owner, { operatorId, subject: 'sub-' + randomUUID(), displayName: 'Complice' }, randomUUID()),
    { code: 'FORBIDDEN' });
  await assert.rejects(provision.driver(owner, { operatorId, subject: 'sub-' + randomUUID(), displayName: 'Employé', licenseReference: 'PC-1' }, randomUUID()),
    { code: 'FORBIDDEN' });
  // Nor create another operator, nor reach into one.
  await assert.rejects(provision.operator(owner, { name: 'Autre', key: 'autre' }, randomUUID()), { code: 'FORBIDDEN' });
  const other = await onboardIndependent();
  await assert.rejects(provision.route(owner, { operatorId: other.operatorId, name: 'Vol',
    stops: [{ stopId: from.id, fareToNext: 1 }, { stopId: to.id, fareToNext: 0 }] }, randomUUID()), { code: 'FORBIDDEN' });
  assert.ok(actor);
});

test('an unverified operator cannot publish, and a company driver never provisions', async () => {
  const { provisioning } = await import('../src/provisioning.js');
  const provision = provisioning(db, { issuer: 'https://issuer.test.invalid' });

  // Verification is still the gate: passing KYC is what opens publishing, and
  // nothing else does.
  const pending = await onboardIndependent();
  const owner = await db.transaction(tx => import('../src/identities.js')
    .then(m => m.activeIdentity(tx, pending.userId)));
  const catalog = await provision.catalog(owner);
  const [from, to] = catalog.stops.slice(0, 2);
  const route = await provision.route(owner, { operatorId: pending.operatorId, name: 'Ligne en attente',
    stops: [{ stopId: from.id, fareToNext: 2000 }, { stopId: to.id, fareToNext: 0 }] }, randomUUID());
  await assert.rejects(provision.service(owner, { routeId: route.id, vehicleId: catalog.vehicles[0].id,
    driverId: pending.userId, departureAt: new Date(Date.now() + 7200_000).toISOString() }, randomUUID()),
  { code: 'OPERATOR_NOT_VERIFIED' });

  // A company's employed driver is crew, not operations, however verified the
  // company is.
  const company = await onboardCompany();
  const employee = randomUUID();
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO users(id,display_name,role,operator_id,profile_completed_at)
      VALUES($1,'Chauffeur Salarié','driver',$2,now())`, [employee, company.operatorId]);
    await tx.query(`INSERT INTO driver_profiles(user_id,operator_id,license_reference,active)
      VALUES($1,$2,'PC-SAL-1',true)`, [employee, company.operatorId]);
  });
  const crew = await db.transaction(tx => import('../src/identities.js')
    .then(m => m.activeIdentity(tx, employee)));
  await assert.rejects(provision.catalog(crew), { code: 'FORBIDDEN' });
  await assert.rejects(provision.route(crew, { operatorId: company.operatorId, name: 'Ligne pirate',
    stops: [{ stopId: from.id, fareToNext: 1 }, { stopId: to.id, fareToNext: 0 }] }, randomUUID()), { code: 'FORBIDDEN' });
});

// ------------------------------------------------------- corridor catalogue --
// The distinction the whole table exists to protect: a corridor is a road
// people travel. It belongs to nobody, carries no fare, and says nothing about
// whether anybody is driving it today.
test('a corridor is a road, never a service, and reaches no passenger', async () => {
  const { provisioning } = await import('../src/provisioning.js');
  const { transport } = await import('../src/transport.js');
  const provision = provisioning(db, { issuer: 'https://issuer.test.invalid' });
  const search = transport(db);

  const { operatorId, userId } = await onboardIndependent();
  await reviewAll(operatorId);
  await onboard.verification(platformOps, operatorId, 'verified');
  const owner = await db.transaction(tx => import('../src/identities.js').then(m => m.activeIdentity(tx, userId)));

  const corridors = await provision.corridors(owner);
  assert.ok(corridors.length >= 5, 'the catalogue is populated: ' + corridors.length);
  const central = corridors.find(c => c.name === 'Cotonou → Parakou');
  assert.ok(central, 'the corridor people actually ask for is in it');
  assert.deepEqual(central.stops.map(s => s.city),
    ['Cotonou', 'Allada', 'Bohicon', 'Dassa-Zoumè', 'Savè', 'Tchaourou', 'Parakou']);
  // Sequences are zero-based and contiguous, because a route consumes them
  // directly and journeySegments() counts from zero.
  assert.deepEqual(central.stops.map(s => s.sequence), [0, 1, 2, 3, 4, 5, 6]);

  // A corridor carries no fare and no operator. Those are the route's, and the
  // route does not exist until somebody creates one.
  const text = JSON.stringify(central);
  for (const leak of ['fare', 'price', 'operator', 'departure', 'vehicle']) {
    assert.ok(!text.toLowerCase().includes(leak), `a corridor must not carry ${leak}`);
  }
  // Nothing in the catalogue is bookable. Adopting one changes that only once
  // a real departure is published.
  const offers = await search.search({ originStopId: central.stops[0].stopId,
    destinationStopId: central.stops.at(-1).stopId, includeDemo: false });
  assert.equal(offers.length, 0, 'a known road is not an offer: ' + JSON.stringify(offers));
});

test('adopting a corridor produces the operator’s own route, with the operator’s own fares', async () => {
  const { provisioning } = await import('../src/provisioning.js');
  const provision = provisioning(db, { issuer: 'https://issuer.test.invalid' });
  const { operatorId, userId } = await onboardIndependent();
  await reviewAll(operatorId);
  await onboard.verification(platformOps, operatorId, 'verified');
  const owner = await db.transaction(tx => import('../src/identities.js').then(m => m.activeIdentity(tx, userId)));

  const corridor = (await provision.corridors(owner)).find(c => c.name === 'Cotonou → Lokossa');
  assert.ok(corridor);
  // The operator takes the sequence, drops a stop they do not serve, and sets
  // their own prices. None of that touches the catalogue.
  const kept = corridor.stops.filter(s => s.city !== 'Comè');
  const route = await provision.route(owner, { operatorId, name: 'Cotonou – Lokossa direct',
    stops: kept.map((s, i) => ({ stopId: s.stopId, fareToNext: i === kept.length - 1 ? 0 : 2500 })) }, randomUUID());

  const stored = await db.transaction(async tx => (await tx.query(
    `SELECT rs.sequence,p.name AS city FROM route_stops rs JOIN stops s ON s.id=rs.stop_id
     JOIN places p ON p.id=s.place_id WHERE rs.route_id=$1 ORDER BY rs.sequence`, [route.id])).rows);
  assert.deepEqual(stored.map(r => r.city), ['Cotonou', 'Ouidah', 'Lokossa']);
  const owned = await one('SELECT operator_id FROM routes WHERE id=$1', [route.id]);
  assert.equal(owned.operator_id, operatorId, 'the route is the operator’s, not the catalogue’s');
  // And the catalogue is untouched: the next operator still sees Comè.
  const after = (await provision.corridors(owner)).find(c => c.name === 'Cotonou → Lokossa');
  assert.ok(after.stops.some(s => s.city === 'Comè'), 'one operator’s choices do not edit the shared catalogue');
});

test('every commune has somewhere to board, and a passenger never sees the catalogue', async () => {
  // Thirteen stops existed for seventy-seven communes, so building a line meant
  // inventing every stop by hand, with coordinates, on a phone.
  const communes = await one(`SELECT count(*)::int AS n FROM places WHERE kind='city' AND source='benin-geography'`);
  const served = await one(`SELECT count(DISTINCT p.id)::int AS n FROM places p JOIN stops s ON s.place_id=p.id
    WHERE p.kind='city' AND p.source='benin-geography' AND NOT s.is_demo`);
  assert.equal(served.n, communes.n, 'every commune has a real boarding stop');

  // The stop is commune-level on purpose: LeRoutier does not know where the
  // gare routière in Bantè is, and a precise address it cannot verify is a
  // place it would be sending somebody to for nothing.
  const sample = await one(`SELECT s.name,s.latitude,s.longitude,p.latitude AS place_lat FROM stops s
    JOIN places p ON p.id=s.place_id WHERE p.name='Savalou' AND NOT s.is_demo`);
  assert.equal(sample.name, 'Savalou');
  assert.equal(Number(sample.latitude), Number(sample.place_lat));

  // Cross-border corridors are marked as such. Whether an operator may legally
  // run one is their transport authorization's business, never inferred here.
  const crossing = await db.transaction(async tx => (await tx.query(
    "SELECT name,country_codes FROM corridors WHERE array_length(country_codes,1)>1 ORDER BY name")).rows);
  assert.ok(crossing.length >= 2, 'border corridors are represented: ' + JSON.stringify(crossing));
  assert.ok(crossing.every(c => c.country_codes.includes('BJ')));
});

test('the corridor catalogue is for operators, not for the public', async () => {
  const { provisioning } = await import('../src/provisioning.js');
  const provision = provisioning(db, { issuer: 'https://issuer.test.invalid' });
  const passenger = await newPassenger('Curieux');
  await assert.rejects(provision.corridors({ id: passenger, role: 'passenger' }), { code: 'FORBIDDEN' });
  // A company's employed driver is crew and does not plan the network either.
  const company = await onboardCompany();
  const employee = randomUUID();
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO users(id,display_name,role,operator_id,profile_completed_at)
      VALUES($1,'Salarié','driver',$2,now())`, [employee, company.operatorId]);
    await tx.query(`INSERT INTO driver_profiles(user_id,operator_id,license_reference,active)
      VALUES($1,$2,'PC-C-1',true)`, [employee, company.operatorId]);
  });
  const crew = await db.transaction(tx => import('../src/identities.js').then(m => m.activeIdentity(tx, employee)));
  await assert.rejects(provision.corridors(crew), { code: 'FORBIDDEN' });
});

// ------------------------------------------- private evidence storage ------
// Everything below uses generated TEST fixtures. No real identity document is
// ever uploaded, and the store is an in-memory double that no deployment can
// select by configuration.
const PDF = () => Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x37, 0x0A, 0x25, 0xC7, 0xEC]);
const PNG = () => Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]);
const SVG = () => Uint8Array.from([...'<svg xmlns="http://www.w3.org/2000/svg"><script/>'].map(c => c.charCodeAt(0)));
const HTML = () => Uint8Array.from([...'<!DOCTYPE html><html><script>alert(1)</script>'].map(c => c.charCodeAt(0)));

test('a proof is identified by its own bytes, never by what the uploader claimed', async () => {
  const { detectEvidenceType, MAX_EVIDENCE_BYTES } = await import('../src/evidence-storage.js');
  assert.equal(detectEvidenceType(PDF()), 'application/pdf');
  assert.equal(detectEvidenceType(PNG()), 'image/png');
  assert.equal(detectEvidenceType(Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0])), 'image/jpeg');

  // The whole attack is a declaration that does not match the bytes. An SVG
  // announced as image/png is still a scripted page in a reviewer's browser,
  // so the declaration is never consulted.
  /** @type {Array<[string, Uint8Array]>} */
  const refused = [['svg', SVG()], ['html', HTML()],
    ['empty', new Uint8Array(0)], ['random', Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])]];
  for (const [label, bytes] of refused) {
    assert.throws(() => detectEvidenceType(bytes), { code: 'INVALID_EVIDENCE_FILE' }, `${label} was accepted`);
  }
  assert.throws(() => detectEvidenceType(new Uint8Array(MAX_EVIDENCE_BYTES + 1)), { code: 'INVALID_EVIDENCE_FILE' });
});

test('managed evidence is reachable only by an authorized reviewer, and only briefly', async () => {
  const { onboarding } = await import('../src/onboarding.js');
  const { memoryEvidenceStore } = await import('../src/evidence-storage.js');
  let clock = Date.UTC(2026, 0, 1);
  const store = memoryEvidenceStore({ now: () => clock });
  const managed = onboarding(db, store);

  const { operatorId, userId } = await onboardIndependent();
  await reviewAll(operatorId, { reject: ['insurance'] });
  const owner = await db.transaction(tx => import('../src/identities.js').then(m => m.activeIdentity(tx, userId)));
  const refused = (await managed.dossier(owner)).evidence.find(e => e.kind === 'insurance');

  // The operator replaces it by handing LeRoutier the document itself.
  const uploaded = await managed.uploadEvidence(owner, refused.id, PDF());
  assert.equal(uploaded.status, 'pending');
  assert.equal(uploaded.content_type, 'application/pdf');
  const row = await one('SELECT storage_key,storage_provider,file_url FROM verification_evidence WHERE id=$1', [refused.id]);
  assert.ok(row.storage_key, 'LeRoutier holds the bytes');
  assert.equal(row.storage_provider, 'memory');
  assert.equal(row.file_url, null, 'and no operator-hosted link is left pointing at the old document');

  // A reviewer gets a grant. Nobody else gets anything.
  const stranger = await newPassenger('Curieux');
  await assert.rejects(managed.accessEvidence({ id: stranger, role: 'passenger' }, refused.id), { code: 'FORBIDDEN' });
  await assert.rejects(managed.accessEvidence(owner, refused.id), { code: 'FORBIDDEN' },
    'not even the operator who uploaded it reads it back through the review surface');
  await assert.rejects(managed.accessEvidence({ id: randomUUID(), role: 'ops', operator_id: randomUUID() }, refused.id),
    { code: 'FORBIDDEN' }, 'and certainly not another operator');

  const grant = await managed.accessEvidence(platformOps, refused.id);
  assert.equal(grant.storage, 'managed');
  assert.ok(grant.expiresAt, 'a managed grant expires; an operator link never could');
  assert.ok(store.resolve(grant.url), 'and it works while it lasts');

  // The property an operator-hosted link can never have.
  clock += 10 * 60 * 1000;
  assert.equal(store.resolve(grant.url), null, 'the grant stopped working');

  // Opening a document is recorded. What was handed out is not.
  const opened = await db.transaction(async tx => (await tx.query(
    `SELECT details::text AS details FROM audit_events WHERE action='operator.evidence_opened'
     AND details->>'evidenceId'=$1`, [refused.id])).rows);
  assert.equal(opened.length, 1);
  assert.ok(!opened[0].details.includes(row.storage_key), 'the object key stays out of the audit trail');
});

test('no client payload carries a document address, managed or linked', async () => {
  const { onboarding } = await import('../src/onboarding.js');
  const { memoryEvidenceStore } = await import('../src/evidence-storage.js');
  const store = memoryEvidenceStore();
  const managed = onboarding(db, store);
  const { operatorId, userId } = await onboardIndependent();
  await reviewAll(operatorId, { reject: ['roadworthiness'] });
  const owner = await db.transaction(tx => import('../src/identities.js').then(m => m.activeIdentity(tx, userId)));
  const refused = (await managed.dossier(owner)).evidence.find(e => e.kind === 'roadworthiness');
  await managed.uploadEvidence(owner, refused.id, PNG());
  const key = (await one('SELECT storage_key FROM verification_evidence WHERE id=$1', [refused.id])).storage_key;

  // Three payloads a browser receives. None may contain a key or a URL: an
  // address in a list ends up in a tab, in devtools, and in anything that
  // copies a response.
  const surfaces = {
    'reviewer dossier': await managed.evidence(platformOps, operatorId),
    'operator dossier': await managed.dossier(owner),
    'review queue': (await health.read(platformOps)).kycQueue,
  };
  for (const [name, payload] of Object.entries(surfaces)) {
    const text = JSON.stringify(payload);
    assert.ok(!text.includes(key), `${name} leaked the object key`);
    assert.ok(!/documents\.leroutier|https:\/\/documents|file_url|fileUrl/.test(text), `${name} leaked a document URL`);
  }
  // What they DO carry is whether a document exists and under which
  // arrangement, which is what a console needs to draw a button.
  const listed = surfaces['reviewer dossier'].find(e => e.kind === 'roadworthiness');
  assert.equal(listed.has_document, true);
  assert.equal(listed.storage, 'managed');
});

test('a redacted document is deleted from the store, and cannot be opened afterwards', async () => {
  const { onboarding } = await import('../src/onboarding.js');
  const { memoryEvidenceStore } = await import('../src/evidence-storage.js');
  const { retentionEngine } = await import('../src/privacy.js');
  const store = memoryEvidenceStore();
  const managed = onboarding(db, store);
  const retention = retentionEngine(db, store);

  const { operatorId, userId } = await onboardIndependent();
  await reviewAll(operatorId, { reject: ['identity'] });
  const owner = await db.transaction(tx => import('../src/identities.js').then(m => m.activeIdentity(tx, userId)));
  const refused = (await managed.dossier(owner)).evidence.find(e => e.kind === 'identity');
  await managed.uploadEvidence(owner, refused.id, PDF());
  const key = (await one('SELECT storage_key FROM verification_evidence WHERE id=$1', [refused.id])).storage_key;
  assert.ok(store.has(key), 'the document is really there first');

  // The dossier is refused and ages past the appeal window.
  await onboard.verification(platformOps, operatorId, 'rejected');
  await db.transaction(tx => tx.query(
    "UPDATE operators SET created_at=now()-interval '200 days' WHERE id=$1", [operatorId]));
  await retention.run({ execute: true });

  assert.equal(store.has(key), false, 'the bytes are gone, not merely the pointer to them');
  const after = await one('SELECT storage_key,storage_provider,redacted_at FROM verification_evidence WHERE id=$1', [refused.id]);
  assert.equal(after.storage_key, null);
  assert.equal(after.storage_provider, null);
  assert.ok(after.redacted_at);
  // And a reviewer is told it was deleted rather than left hunting for it.
  await assert.rejects(managed.accessEvidence(platformOps, refused.id), { code: 'EVIDENCE_REDACTED' });
});

test('a store that cannot delete does not let the platform claim it forgot', async () => {
  const { onboarding } = await import('../src/onboarding.js');
  const { memoryEvidenceStore } = await import('../src/evidence-storage.js');
  const { retentionEngine } = await import('../src/privacy.js');
  const store = memoryEvidenceStore();
  const broken = { ...store, remove: async () => { throw new Error('provider down'); } };
  const managed = onboarding(db, store);

  const { operatorId, userId } = await onboardIndependent();
  await reviewAll(operatorId, { reject: ['driving_license'] });
  const owner = await db.transaction(tx => import('../src/identities.js').then(m => m.activeIdentity(tx, userId)));
  const refused = (await managed.dossier(owner)).evidence.find(e => e.kind === 'driving_license');
  await managed.uploadEvidence(owner, refused.id, PDF());
  await onboard.verification(platformOps, operatorId, 'rejected');
  await db.transaction(tx => tx.query(
    "UPDATE operators SET created_at=now()-interval '200 days' WHERE id=$1", [operatorId]));

  // Clearing the row while the object survives would record that LeRoutier
  // forgot something it still holds. Failing means the next scan tries again.
  await retentionEngine(db, broken).run({ execute: true });
  const stuck = await one('SELECT storage_key,redacted_at FROM verification_evidence WHERE id=$1', [refused.id]);
  assert.ok(stuck.storage_key, 'the pointer survives a failed delete');
  assert.equal(stuck.redacted_at, null, 'and nothing claims the document was redacted');

  // With a working store the same scan completes.
  await retentionEngine(db, store).run({ execute: true });
  const done = await one('SELECT storage_key,redacted_at FROM verification_evidence WHERE id=$1', [refused.id]);
  assert.equal(done.storage_key, null);
  assert.ok(done.redacted_at);
});

test('managed upload obeys the same rules as a link replacement', async () => {
  const { onboarding } = await import('../src/onboarding.js');
  const { memoryEvidenceStore } = await import('../src/evidence-storage.js');
  const store = memoryEvidenceStore();
  const managed = onboarding(db, store);
  const mine = await onboardIndependent();
  const theirs = await onboardIndependent();
  await reviewAll(mine.operatorId, { reject: ['insurance'] });
  await reviewAll(theirs.operatorId, { reject: ['insurance'] });
  const owner = await db.transaction(tx => import('../src/identities.js').then(m => m.activeIdentity(tx, mine.userId)));
  const dossier = await managed.dossier(owner);
  const refused = dossier.evidence.find(e => e.kind === 'insurance');
  const accepted = dossier.evidence.find(e => e.kind === 'identity');
  const foreign = (await managed.evidence(platformOps, theirs.operatorId)).find(e => e.kind === 'insurance');

  await assert.rejects(managed.uploadEvidence(owner, accepted.id, PDF()), { code: 'EVIDENCE_NOT_REJECTED' });
  await assert.rejects(managed.uploadEvidence(owner, foreign.id, PDF()), { code: 'NOT_FOUND' },
    'another operator’s evidence id is scoped out in the WHERE clause, never a cross-tenant write');
  await assert.rejects(managed.uploadEvidence(owner, refused.id, SVG()), { code: 'INVALID_EVIDENCE_FILE' });

  // And with no store configured the upload path refuses honestly rather than
  // pretending to take custody.
  const unmanaged = onboarding(db, null);
  await assert.rejects(unmanaged.uploadEvidence(owner, refused.id, PDF()), { code: 'EVIDENCE_STORAGE_UNAVAILABLE' });
});

test('replacing a managed document removes the one it replaced', async () => {
  const { onboarding } = await import('../src/onboarding.js');
  const { memoryEvidenceStore } = await import('../src/evidence-storage.js');
  const store = memoryEvidenceStore();
  const managed = onboarding(db, store);
  const { operatorId, userId } = await onboardIndependent();
  await reviewAll(operatorId, { reject: ['transport_authorization'] });
  const owner = await db.transaction(tx => import('../src/identities.js').then(m => m.activeIdentity(tx, userId)));
  const refused = (await managed.dossier(owner)).evidence.find(e => e.kind === 'transport_authorization');

  await managed.uploadEvidence(owner, refused.id, PDF());
  const first = (await one('SELECT storage_key FROM verification_evidence WHERE id=$1', [refused.id])).storage_key;
  // A reviewer refuses it again, and the operator sends another.
  await onboard.verification(platformOps, operatorId, { type: 'evidence', evidenceId: refused.id, status: 'rejected', notes: 'Encore illisible.' });
  await managed.uploadEvidence(owner, refused.id, PNG());
  const second = (await one('SELECT storage_key FROM verification_evidence WHERE id=$1', [refused.id])).storage_key;

  assert.notEqual(first, second);
  assert.equal(store.has(first), false, 'the superseded document is not left paid for and forgotten');
  assert.equal(store.has(second), true);
});
