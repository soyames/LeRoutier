/**
 * Cover offered on LeRoutier, carried by somebody else.
 *
 * WHAT THIS MODULE IS NOT. It is not an insurer, it does not price risk, it
 * does not hold a premium and it does not settle a claim. Benin's insurance
 * market runs under the CIMA code: carrying risk needs an insurer's agrément
 * and selling cover needs an intermediary's registration. LeRoutier holds
 * neither, so this module is a distribution surface and every function below
 * is written to keep it one.
 *
 * Three rules do the work.
 *
 * NOBODY IS TOLD THEY ARE COVERED UNTIL THEY ARE. A policy is created
 * `requested`. Only `record` — the partner's answer, carrying the partner's
 * own reference — moves it to `active`. There is no path from "the passenger
 * ticked a box" to "the passenger is insured", because in reality there isn't
 * one either.
 *
 * THE TRIP IS NEVER HOSTAGE TO THE COVER. Attaching, declining, or losing a
 * policy does not touch the booking or the parcel. Insurance is an add-on in
 * the literal sense: remove it and the transport is unchanged. Every failure
 * here is contained.
 *
 * WHAT LEAVES IS WRITTEN DOWN AND IS THE MINIMUM. A referral hands the partner
 * the few fields they need to issue a policy, the person consented to that
 * specific transfer, and `shared_fields` records which fields — names only,
 * never values, because an audit trail must not become a second copy of
 * somebody's personal data. See docs/INSURANCE.md and the APDP filing.
 */
import { invariant, uuid } from '@leroutier/domain';
import { audit } from './identities.js';
import { requirePlatform } from './platform-access.js';

const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
const many = async (tx, sql, args = []) => (await tx.query(sql, args)).rows;
/**
 * A domain event, keyed on the BOOKING or PARCEL rather than on the policy.
 *
 * The notification audiences resolve a recipient from the aggregate id — a
 * booking gives its passenger, a parcel gives its sender. Keying these events
 * on the policy would resolve nobody and the message would be dropped without
 * an error, which is the worst possible failure for "your cover was refused".
 */
const emit = (tx, type, subjectId, payload = {}) => tx.query(
  'INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)', [type, subjectId, JSON.stringify(payload)]);

const text = (value, max, label) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const trimmed = String(value).trim();
  invariant(trimmed.length <= max, 'INVALID_INPUT', `${label} est trop long.`);
  return trimmed;
};
const required = (value, max, label) => {
  const trimmed = text(value, max, label);
  invariant(trimmed, 'INVALID_INPUT', `${label} est obligatoire.`);
  return trimmed;
};

/**
 * The consent text version a caller must echo back to attach cover.
 *
 * Bumping this string is how a wording change becomes visible in the audit
 * trail: consents taken under the old text keep saying so, instead of being
 * silently reinterpreted as agreement to something nobody read.
 */
export const CONSENT_VERSION = 'lr-insurance-2026-09';

/**
 * Exactly what a referral hands the partner, by scope.
 *
 * Deliberately short and deliberately explicit. A partner needs to reach the
 * person and to identify what is covered; they do not need the passenger's
 * other journeys, their account, or anything about anybody else on the
 * vehicle. Adding a field here is a privacy decision and changes the APDP
 * declaration, which is why the list is a constant and not built from
 * whatever a query happened to select.
 */
export const SHARED_FIELDS = Object.freeze({
  trip: Object.freeze(['fullName', 'phone', 'tripDate', 'origin', 'destination', 'operatorName', 'coverAmount']),
  parcel: Object.freeze(['fullName', 'phone', 'parcelReference', 'origin', 'destination', 'declaredValue', 'coverAmount']),
});

/**
 * One policy with the two things the covered person needs beside it: what it
 * is called, and how to reach the party who actually answers a claim.
 */
const POLICY_SELECT = `SELECT po.*,pr.name AS product_name,p.name AS partner_name,
    p.claims_phone,p.claims_email,p.claims_url
  FROM insurance_policies po
  JOIN insurance_products pr ON pr.id=po.product_id
  JOIN insurance_partners p ON p.id=po.partner_id`;

/**
 * The premium for one product against one declared value.
 *
 * Rounded UP for basis-point products: rounding a premium down in the
 * customer's favour sounds generous until the insurer reconciles and the
 * difference is LeRoutier's to explain.
 */
export function premiumFor(product, declaredValueMinor = 0) {
  if (product.premium_mode === 'included') return 0;
  if (product.premium_mode === 'flat') return Number(product.premium_minor);
  return Math.ceil((Number(declaredValueMinor) * Number(product.premium_bp)) / 10000);
}

/** The public shape of an offer. No partner internals, no licence number. */
const offerShape = (row, declaredValueMinor) => ({
  productId: row.id,
  code: row.code,
  name: row.name,
  summary: row.summary,
  scope: row.scope,
  coverAmountMinor: Number(row.cover_amount_minor),
  premiumMinor: premiumFor(row, declaredValueMinor),
  premiumMode: row.premium_mode,
  currency: row.currency,
  exclusions: row.exclusions ?? null,
  termsUrl: row.terms_url ?? null,
  partner: { name: row.partner_name, kind: row.partner_kind },
  // The premium never reaches LeRoutier on a referral, and saying so on the
  // offer itself is the difference between a hand-off somebody expected and
  // one that feels like a bait and switch at the insurer's counter.
  paidTo: row.handoff === 'embedded' ? 'leroutier' : 'partner',
  consentVersion: CONSENT_VERSION,
});

const policyShape = row => ({
  id: row.id,
  status: row.status,
  scope: row.subject_type === 'booking' ? 'trip' : 'parcel',
  productName: row.product_name,
  coverAmountMinor: Number(row.cover_amount_minor),
  premiumMinor: Number(row.premium_minor),
  currency: row.currency,
  premiumCollectedBy: row.premium_collected_by,
  // Present only once the insurer has issued. Until then there is nothing to
  // show and the product must not invent a placeholder that looks like one.
  partnerReference: row.partner_reference ?? null,
  declinedReason: row.declined_reason ?? null,
  requestedAt: row.created_at,
  partner: {
    name: row.partner_name,
    claimsPhone: row.claims_phone ?? null,
    claimsEmail: row.claims_email ?? null,
    claimsUrl: row.claims_url ?? null,
  },
});

export function insurance(db) {
  /** The booking or parcel this policy would attach to, and whose it is. */
  async function subject(tx, scope, subjectId, forUpdate = false) {
    const id = uuid(subjectId);
    const lock = forUpdate ? ' FOR UPDATE' : '';
    if (scope === 'trip') {
      const row = await one(tx, `SELECT id,passenger_id AS owner_id,status FROM bookings WHERE id=$1${lock}`, [id]);
      invariant(row, 'NOT_FOUND', 'Booking not found.', 404);
      return { type: 'booking', id: row.id, ownerId: row.owner_id, status: row.status };
    }
    const row = await one(tx, `SELECT id,created_by AS owner_id,status,declared_value_minor FROM parcels WHERE id=$1${lock}`, [id]);
    invariant(row, 'NOT_FOUND', 'Parcel not found.', 404);
    return { type: 'parcel', id: row.id, ownerId: row.owner_id, status: row.status,
      declaredValueMinor: Number(row.declared_value_minor ?? 0) };
  }

  return {
    /**
     * What can be taken, for this scope and this declared value.
     *
     * Anonymous on purpose. The checkout shows the fare before anybody signs
     * in and the add-on has to be visible at the same moment, or the first
     * time a passenger hears about cover is after they have paid. A product
     * catalogue carries no personal data, so there is nothing to protect here.
     *
     * @param {{scope?:string,declaredValueMinor?:number}} [query]
     */
    async offers(query = {}) {
      const { scope, declaredValueMinor = 0 } = query;
      invariant(scope === 'trip' || scope === 'parcel', 'INVALID_INPUT', 'Unknown insurance scope.');
      const declared = Number(declaredValueMinor) || 0;
      invariant(Number.isInteger(declared) && declared >= 0, 'INVALID_INPUT', 'Declared value is invalid.');
      return db.transaction(async tx => {
        const rows = await many(tx, `SELECT pr.*,p.name AS partner_name,p.kind AS partner_kind,p.handoff
          FROM insurance_products pr JOIN insurance_partners p ON p.id=pr.partner_id
          WHERE pr.status='active' AND p.status='active' AND pr.scope=$1
            AND (pr.min_declared_value_minor IS NULL OR $2 >= pr.min_declared_value_minor)
            AND (pr.max_declared_value_minor IS NULL OR $2 <= pr.max_declared_value_minor)
          ORDER BY pr.premium_mode='included' DESC,pr.cover_amount_minor`, [scope, declared]);
        return rows.map(row => offerShape(row, declared));
      });
    },

    /** The cover on one booking or parcel, for the person it belongs to. */
    async forSubject(actor, scope, subjectId) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Authentication required.', 401);
      return db.transaction(async tx => {
        const target = await subject(tx, scope, subjectId);
        invariant(target.ownerId === actor.id, 'FORBIDDEN', 'Operation is not permitted.', 403);
        const row = await one(tx, `${POLICY_SELECT} WHERE po.subject_type=$1 AND po.subject_id=$2`,
          [target.type, target.id]);
        return row ? policyShape(row) : null;
      });
    },

    /**
     * Ask the partner for cover on this trip or this parcel.
     *
     * Everything this does is create a request and write down a consent. It
     * moves no money — not even for an `embedded` partner, because collecting
     * a premium is intermediation and LeRoutier is not registered to do it.
     * When that changes, the premium becomes a line in the existing payment
     * flow and this function gains one branch; until then an embedded product
     * behaves exactly like a referral and says so.
     */
    async attach(actor, input, idempotencyKey = null) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Authentication required.', 401);
      invariant(input && Object.keys(input).every(k => ['scope', 'subjectId', 'productId', 'consentVersion'].includes(k)),
        'INVALID_INPUT', 'Unexpected insurance fields.');
      invariant(input.scope === 'trip' || input.scope === 'parcel', 'INVALID_INPUT', 'Unknown insurance scope.');
      // The consent version is echoed back by the client from the offer it
      // actually rendered. A mismatch means the wording moved under somebody
      // between reading and agreeing, and the honest response is to make them
      // read it again rather than record a consent to text they never saw.
      invariant(input.consentVersion === CONSENT_VERSION, 'INSURANCE_CONSENT_STALE',
        'Les conditions ont changé. Relisez l’offre avant de confirmer.', 409);
      return db.transaction(async tx => {
        const target = await subject(tx, input.scope, input.subjectId, true);
        invariant(target.ownerId === actor.id, 'FORBIDDEN', 'Operation is not permitted.', 403);
        invariant(!['cancelled', 'refunded', 'completed', 'delivered', 'collected'].includes(target.status),
          'INSURANCE_UNAVAILABLE', 'Ce trajet ou cet envoi est terminé : la garantie ne peut plus être ajoutée.', 409);

        const existing = await one(tx, 'SELECT id,status FROM insurance_policies WHERE subject_type=$1 AND subject_id=$2 FOR UPDATE',
          [target.type, target.id]);
        // Re-posting the same request is a network retry, not a second policy.
        if (existing && ['requested', 'active'].includes(existing.status)) {
          return policyShape(await one(tx, `${POLICY_SELECT} WHERE po.id=$1`, [existing.id]));
        }

        const product = await one(tx, `SELECT pr.*,p.id AS pid,p.name AS partner_name,p.handoff,p.status AS partner_status,
          p.claims_phone,p.claims_email,p.claims_url
          FROM insurance_products pr JOIN insurance_partners p ON p.id=pr.partner_id WHERE pr.id=$1`,
        [uuid(input.productId)]);
        invariant(product, 'NOT_FOUND', 'Insurance product not found.', 404);
        invariant(product.status === 'active' && product.partner_status === 'active',
          'INSURANCE_UNAVAILABLE', 'Cette garantie n’est plus proposée.', 409);
        invariant(product.scope === input.scope, 'INVALID_INPUT', 'Cette garantie ne couvre pas ce type de service.');

        const declared = target.type === 'parcel' ? target.declaredValueMinor : 0;
        invariant(product.min_declared_value_minor === null || declared >= Number(product.min_declared_value_minor),
          'INSURANCE_UNAVAILABLE', 'La valeur déclarée est en dehors des limites de cette garantie.', 409);
        invariant(product.max_declared_value_minor === null || declared <= Number(product.max_declared_value_minor),
          'INSURANCE_UNAVAILABLE', 'La valeur déclarée est en dehors des limites de cette garantie.', 409);

        const premium = premiumFor(product, declared);
        // 'none' when the traveller pays nothing; otherwise the partner bills
        // them directly. 'leroutier' is unreachable from here by design.
        const collectedBy = product.premium_mode === 'included' ? 'none' : 'partner';
        const inserted = await one(tx, `INSERT INTO insurance_policies
          (product_id,partner_id,subject_type,subject_id,user_id,premium_minor,cover_amount_minor,currency,
           premium_collected_by,consent_version,shared_fields)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
          ON CONFLICT (subject_type,subject_id) DO UPDATE SET
            product_id=EXCLUDED.product_id,partner_id=EXCLUDED.partner_id,status='requested',
            premium_minor=EXCLUDED.premium_minor,cover_amount_minor=EXCLUDED.cover_amount_minor,
            premium_collected_by=EXCLUDED.premium_collected_by,consent_at=now(),
            consent_version=EXCLUDED.consent_version,shared_fields=EXCLUDED.shared_fields,
            partner_reference=NULL,declined_reason=NULL,updated_at=now()
          RETURNING *`,
        [product.id, product.pid, target.type, target.id, actor.id, premium,
          product.cover_amount_minor, product.currency, collectedBy, CONSENT_VERSION,
          JSON.stringify(SHARED_FIELDS[input.scope])]);

        await audit(tx, actor.id, 'insurance.requested', inserted.id, null, {
          scope: input.scope, productCode: product.code, partner: product.partner_name,
          premiumMinor: premium, idempotencyKey: idempotencyKey ?? null,
        });
        return policyShape({ ...inserted, product_name: product.name, partner_name: product.partner_name,
          claims_phone: product.claims_phone, claims_email: product.claims_email, claims_url: product.claims_url });
      });
    },

    /** Withdraw a request, or drop cover that has not been confirmed. */
    async cancel(actor, policyId) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Authentication required.', 401);
      return db.transaction(async tx => {
        const policy = await one(tx, 'SELECT * FROM insurance_policies WHERE id=$1 FOR UPDATE', [uuid(policyId)]);
        invariant(policy, 'NOT_FOUND', 'Policy not found.', 404);
        invariant(policy.user_id === actor.id, 'FORBIDDEN', 'Operation is not permitted.', 403);
        // An active policy is a contract with the insurer, not a row in this
        // table. LeRoutier cannot cancel it and must not pretend to: the
        // person is sent to the party who can.
        invariant(policy.status === 'requested', 'INSURANCE_NOT_CANCELLABLE',
          policy.status === 'active'
            ? 'Cette garantie est déjà émise : contactez l’assureur pour y mettre fin.'
            : 'Cette demande n’est plus en cours.', 409);
        await tx.query("UPDATE insurance_policies SET status='cancelled',updated_at=now() WHERE id=$1", [policy.id]);
        await audit(tx, actor.id, 'insurance.cancelled', policy.id, null, {});
        return { id: policy.id, status: 'cancelled' };
      });
    },
  };
}

/**
 * The LeRoutier side of the relationship: who the partners are, what they
 * offer, and answering the queue of requests they have come back on.
 *
 * All of it sits behind one capability, `insurance`. It is not `verification`
 * — that reviews an operator's carte grise and opens identity documents — and
 * it is not `finance`, which releases LeRoutier's own money. Whoever runs the
 * insurance relationship needs neither of those, and giving it to them because
 * there was no smaller thing to grant is exactly the problem migration 034
 * was written to end.
 */
export function insuranceAdmin(db) {
  return {
    /** Partners and their products, including the licence, for staff. */
    async partners(actor) {
      requirePlatform(actor, 'insurance');
      return db.transaction(async tx => {
        const partners = await many(tx, 'SELECT * FROM insurance_partners ORDER BY status,name');
        const products = await many(tx, 'SELECT * FROM insurance_products ORDER BY scope,name');
        const counts = await many(tx, `SELECT partner_id,status,count(*)::integer AS count
          FROM insurance_policies GROUP BY partner_id,status`);
        return partners.map(p => ({
          id: p.id, name: p.name, legalName: p.legal_name, kind: p.kind,
          cimaRegistration: p.cima_registration, country: p.country, handoff: p.handoff, status: p.status,
          contactName: p.contact_name, contactEmail: p.contact_email, contactPhone: p.contact_phone,
          claimsPhone: p.claims_phone, claimsEmail: p.claims_email, claimsUrl: p.claims_url,
          notes: p.notes, createdAt: p.created_at,
          products: products.filter(pr => pr.partner_id === p.id).map(pr => ({
            id: pr.id, code: pr.code, name: pr.name, summary: pr.summary, scope: pr.scope,
            coverAmountMinor: Number(pr.cover_amount_minor), premiumMode: pr.premium_mode,
            premiumMinor: Number(pr.premium_minor), premiumBp: pr.premium_bp,
            minDeclaredValueMinor: pr.min_declared_value_minor === null ? null : Number(pr.min_declared_value_minor),
            maxDeclaredValueMinor: pr.max_declared_value_minor === null ? null : Number(pr.max_declared_value_minor),
            exclusions: pr.exclusions, termsUrl: pr.terms_url, status: pr.status,
          })),
          policies: Object.fromEntries(counts.filter(c => c.partner_id === p.id).map(c => [c.status, c.count])),
        }));
      });
    },

    /**
     * Create or update a partner.
     *
     * Activation is where the licence is enforced. The database refuses an
     * active partner with no registration (migration 037) and so does this,
     * with a message that says which field is missing rather than surfacing a
     * constraint name to somebody trying to do their job.
     */
    async savePartner(actor, input, idempotencyKey = null) {
      requirePlatform(actor, 'insurance');
      invariant(input && Object.keys(input).every(k => ['id', 'name', 'legalName', 'kind', 'cimaRegistration',
        'country', 'contactName', 'contactEmail', 'contactPhone', 'claimsPhone', 'claimsEmail', 'claimsUrl',
        'handoff', 'status', 'notes'].includes(k)), 'INVALID_INPUT', 'Unexpected partner fields.');
      const kind = input.kind ?? 'insurer';
      invariant(['insurer', 'broker'].includes(kind), 'INVALID_INPUT', 'Type de partenaire inconnu.');
      const handoff = input.handoff ?? 'referral';
      invariant(['referral', 'embedded'].includes(handoff), 'INVALID_INPUT', 'Mode de distribution inconnu.');
      const status = input.status ?? 'draft';
      invariant(['draft', 'active', 'suspended'].includes(status), 'INVALID_INPUT', 'Statut inconnu.');
      const registration = text(input.cimaRegistration, 120, 'Le numéro d’agrément');
      invariant(status !== 'active' || registration, 'INVALID_INPUT',
        'Un partenaire ne peut être activé sans son numéro d’agrément CIMA : c’est lui qui rend l’offre licite.');
      // Embedded means LeRoutier would collect the premium, which is
      // intermediation. Refused here rather than discovered at the first
      // payment, with the reason stated so nobody thinks it is a bug.
      invariant(handoff !== 'embedded' || !input.id, 'INSURANCE_NOT_PERMITTED',
        'La distribution « embedded » suppose une immatriculation d’intermédiaire au nom de LeRoutier. '
        + 'Tant qu’elle n’existe pas, utilisez « referral » : le partenaire encaisse la prime.');
      const name = required(input.name, 160, 'Le nom du partenaire');
      const country = (text(input.country, 2, 'Le pays') ?? 'BJ').toUpperCase();
      return db.transaction(async tx => {
        const row = input.id
          ? await one(tx, `UPDATE insurance_partners SET name=$2,legal_name=$3,kind=$4,cima_registration=$5,
              country=$6,contact_name=$7,contact_email=$8,contact_phone=$9,claims_phone=$10,claims_email=$11,
              claims_url=$12,handoff=$13,status=$14,notes=$15,updated_at=now() WHERE id=$1 RETURNING *`,
          [uuid(input.id), name, text(input.legalName, 200, 'La raison sociale'), kind, registration, country,
            text(input.contactName, 160, 'Le contact'), text(input.contactEmail, 200, 'L’e-mail'),
            text(input.contactPhone, 40, 'Le téléphone'), text(input.claimsPhone, 40, 'Le téléphone sinistres'),
            text(input.claimsEmail, 200, 'L’e-mail sinistres'), text(input.claimsUrl, 400, 'Le lien sinistres'),
            handoff, status, text(input.notes, 2000, 'Les notes')])
          : await one(tx, `INSERT INTO insurance_partners(name,legal_name,kind,cima_registration,country,
              contact_name,contact_email,contact_phone,claims_phone,claims_email,claims_url,handoff,status,notes,created_by)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [name, text(input.legalName, 200, 'La raison sociale'), kind, registration, country,
            text(input.contactName, 160, 'Le contact'), text(input.contactEmail, 200, 'L’e-mail'),
            text(input.contactPhone, 40, 'Le téléphone'), text(input.claimsPhone, 40, 'Le téléphone sinistres'),
            text(input.claimsEmail, 200, 'L’e-mail sinistres'), text(input.claimsUrl, 400, 'Le lien sinistres'),
            handoff, status, text(input.notes, 2000, 'Les notes'), actor.id]);
        invariant(row, 'NOT_FOUND', 'Partner not found.', 404);
        await audit(tx, actor.id, 'insurance.partner_saved', row.id, null,
          { name: row.name, status: row.status, idempotencyKey: idempotencyKey ?? null });
        return { id: row.id, name: row.name, status: row.status };
      });
    },

    /** Create or update one cover a partner offers. */
    async saveProduct(actor, input, idempotencyKey = null) {
      requirePlatform(actor, 'insurance');
      invariant(input && Object.keys(input).every(k => ['id', 'partnerId', 'code', 'name', 'summary', 'scope',
        'coverAmountMinor', 'premiumMode', 'premiumMinor', 'premiumBp', 'minDeclaredValueMinor',
        'maxDeclaredValueMinor', 'exclusions', 'termsUrl', 'status'].includes(k)),
      'INVALID_INPUT', 'Unexpected product fields.');
      invariant(['trip', 'parcel'].includes(input.scope), 'INVALID_INPUT', 'Portée de garantie inconnue.');
      const mode = input.premiumMode;
      invariant(['flat', 'declared_value_bp', 'included'].includes(mode), 'INVALID_INPUT', 'Mode de prime inconnu.');
      const status = input.status ?? 'draft';
      invariant(['draft', 'active', 'retired'].includes(status), 'INVALID_INPUT', 'Statut inconnu.');
      const cover = Number(input.coverAmountMinor);
      invariant(Number.isInteger(cover) && cover > 0, 'INVALID_INPUT', 'Le capital garanti doit être un montant positif.');
      const premium = Number(input.premiumMinor ?? 0), bp = Number(input.premiumBp ?? 0);
      invariant(Number.isInteger(premium) && premium >= 0 && Number.isInteger(bp) && bp >= 0 && bp <= 10000,
        'INVALID_INPUT', 'La prime est invalide.');
      // The same coherence the database enforces, said in the console's own
      // words so a typo is a sentence rather than a constraint violation.
      invariant(mode !== 'flat' || premium > 0, 'INVALID_INPUT', 'Une prime forfaitaire doit avoir un montant.');
      invariant(mode !== 'declared_value_bp' || bp > 0, 'INVALID_INPUT', 'Une prime en pourcentage doit avoir un taux.');
      invariant(mode !== 'included' || (premium === 0 && bp === 0), 'INVALID_INPUT',
        'Une garantie incluse ne peut pas porter de prime.');
      const band = ['minDeclaredValueMinor', 'maxDeclaredValueMinor'].map(k => {
        if (input[k] === undefined || input[k] === null || input[k] === '') return null;
        const value = Number(input[k]);
        invariant(Number.isInteger(value) && value >= 0, 'INVALID_INPUT', 'Les bornes de valeur déclarée sont invalides.');
        return value;
      });
      invariant(band[0] === null || band[1] === null || band[1] >= band[0], 'INVALID_INPUT',
        'La borne haute doit être supérieure à la borne basse.');
      return db.transaction(async tx => {
        const args = [required(input.code, 60, 'Le code'), required(input.name, 160, 'Le nom'),
          required(input.summary, 600, 'Le résumé'), input.scope, cover, mode, premium, bp,
          band[0], band[1], text(input.exclusions, 2000, 'Les exclusions'), text(input.termsUrl, 400, 'Le lien'), status];
        const row = input.id
          ? await one(tx, `UPDATE insurance_products SET code=$2,name=$3,summary=$4,scope=$5,cover_amount_minor=$6,
              premium_mode=$7,premium_minor=$8,premium_bp=$9,min_declared_value_minor=$10,max_declared_value_minor=$11,
              exclusions=$12,terms_url=$13,status=$14,updated_at=now() WHERE id=$1 RETURNING *`, [uuid(input.id), ...args])
          : await one(tx, `INSERT INTO insurance_products(partner_id,code,name,summary,scope,cover_amount_minor,
              premium_mode,premium_minor,premium_bp,min_declared_value_minor,max_declared_value_minor,
              exclusions,terms_url,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [uuid(input.partnerId), ...args]);
        invariant(row, 'NOT_FOUND', 'Product not found.', 404);
        await audit(tx, actor.id, 'insurance.product_saved', row.id, null,
          { code: row.code, status: row.status, idempotencyKey: idempotencyKey ?? null });
        return { id: row.id, code: row.code, status: row.status };
      });
    },

    /**
     * Requests waiting on a partner, and what LeRoutier may hand over.
     *
     * The referral payload is assembled here and nowhere else, from
     * SHARED_FIELDS. Whoever contacts the partner copies this and only this:
     * the point of a fixed list is that it does not grow by accident when
     * somebody adds a column to bookings.
     */
    async queue(actor, { status = 'requested', partnerId = null } = {}) {
      requirePlatform(actor, 'insurance');
      invariant(['requested', 'active', 'declined', 'cancelled', 'expired', 'all'].includes(status),
        'INVALID_INPUT', 'Statut inconnu.');
      return db.transaction(async tx => {
        const rows = await many(tx, `SELECT po.id,po.status,po.subject_type,po.subject_id,po.premium_minor,
            po.cover_amount_minor,po.currency,po.partner_reference,po.declined_reason,po.consent_at,
            po.consent_version,po.shared_fields,po.shared_at,po.created_at,
            pr.name AS product_name,pr.code AS product_code,p.name AS partner_name,p.id AS partner_id,
            u.display_name AS holder_name,pp.phone AS holder_phone,
            s.departure_at AS trip_date,bo.name AS trip_origin,bd.name AS trip_destination,op.name AS operator_name,
            pa.tracking_number,pa.declared_value_minor,pog.name AS parcel_origin,pdst.name AS parcel_destination
          FROM insurance_policies po
          JOIN insurance_products pr ON pr.id=po.product_id
          JOIN insurance_partners p ON p.id=po.partner_id
          JOIN users u ON u.id=po.user_id
          LEFT JOIN passenger_profiles pp ON pp.user_id=u.id
          LEFT JOIN bookings b ON po.subject_type='booking' AND b.id=po.subject_id
          LEFT JOIN services s ON s.id=b.service_id
          LEFT JOIN operators op ON op.id=s.operator_id
          -- A booking names its ends by POSITION on the route, not by stop id,
          -- so the boarding and alighting stops come back through service_stops
          -- at those two sequences.
          LEFT JOIN service_stops bos ON bos.service_id=b.service_id AND bos.sequence=b.origin_sequence
          LEFT JOIN stops bo ON bo.id=bos.stop_id
          LEFT JOIN service_stops bds ON bds.service_id=b.service_id AND bds.sequence=b.destination_sequence
          LEFT JOIN stops bd ON bd.id=bds.stop_id
          LEFT JOIN parcels pa ON po.subject_type='parcel' AND pa.id=po.subject_id
          LEFT JOIN stops pog ON pog.id=pa.origin_stop_id
          LEFT JOIN stops pdst ON pdst.id=pa.destination_stop_id
          WHERE ($1='all' OR po.status=$1) AND ($2::uuid IS NULL OR po.partner_id=$2)
          ORDER BY po.created_at DESC LIMIT 200`,
        [status, partnerId ? uuid(partnerId) : null]);
        return rows.map(r => ({
          id: r.id, status: r.status, scope: r.subject_type === 'booking' ? 'trip' : 'parcel',
          productName: r.product_name, productCode: r.product_code,
          partner: { id: r.partner_id, name: r.partner_name },
          premiumMinor: Number(r.premium_minor), coverAmountMinor: Number(r.cover_amount_minor), currency: r.currency,
          partnerReference: r.partner_reference, declinedReason: r.declined_reason,
          consentAt: r.consent_at, consentVersion: r.consent_version,
          sharedFields: r.shared_fields, sharedAt: r.shared_at, requestedAt: r.created_at,
          // Exactly the fields in SHARED_FIELDS for this scope, and nothing
          // that happened to be joined above for the list view.
          referral: r.subject_type === 'booking'
            ? { fullName: r.holder_name, phone: r.holder_phone, tripDate: r.travel_date,
              origin: r.trip_origin, destination: r.trip_destination, operatorName: r.operator_name,
              coverAmount: Number(r.cover_amount_minor) }
            : { fullName: r.holder_name, phone: r.holder_phone, parcelReference: r.tracking_number,
              origin: r.parcel_origin, destination: r.parcel_destination,
              declaredValue: Number(r.declared_value_minor ?? 0), coverAmount: Number(r.cover_amount_minor) },
        }));
      });
    },

    /** Note that the referral was actually sent, and when. */
    async markShared(actor, policyId) {
      requirePlatform(actor, 'insurance');
      return db.transaction(async tx => {
        const row = await one(tx, `UPDATE insurance_policies SET shared_at=COALESCE(shared_at,now()),updated_at=now()
          WHERE id=$1 AND status='requested' RETURNING id,shared_at`, [uuid(policyId)]);
        invariant(row, 'NOT_FOUND', 'Aucune demande en cours pour cette garantie.', 404);
        await audit(tx, actor.id, 'insurance.referral_shared', row.id, null, {});
        return { id: row.id, sharedAt: row.shared_at };
      });
    },

    /**
     * Record the partner's answer. This is the only path to `active`.
     *
     * A confirmation requires the insurer's own reference, because that
     * reference is the only evidence cover exists — LeRoutier saying so is
     * not evidence of anything. The database enforces the same rule, so a
     * future caller that skips this function still cannot create a covered
     * passenger out of nothing.
     */
    async record(actor, policyId, input) {
      requirePlatform(actor, 'insurance');
      invariant(input && Object.keys(input).every(k => ['status', 'partnerReference', 'declinedReason'].includes(k)),
        'INVALID_INPUT', 'Unexpected decision fields.');
      invariant(['active', 'declined', 'expired'].includes(input.status), 'INVALID_INPUT',
        'Décision inconnue : « active », « declined » ou « expired ».');
      const reference = text(input.partnerReference, 120, 'La référence de police');
      invariant(input.status !== 'active' || reference, 'INVALID_INPUT',
        'Une garantie ne peut être confirmée sans la référence de police de l’assureur.');
      const reason = text(input.declinedReason, 600, 'Le motif');
      return db.transaction(async tx => {
        const policy = await one(tx, `SELECT po.*,pr.name AS product_name,p.name AS partner_name
          FROM insurance_policies po JOIN insurance_products pr ON pr.id=po.product_id
          JOIN insurance_partners p ON p.id=po.partner_id WHERE po.id=$1 FOR UPDATE OF po`, [uuid(policyId)]);
        invariant(policy, 'NOT_FOUND', 'Policy not found.', 404);
        invariant(policy.status === 'requested' || policy.status === 'active', 'INSURANCE_NOT_DECIDABLE',
          'Cette demande a déjà été close.', 409);
        await tx.query(`UPDATE insurance_policies SET status=$2,partner_reference=$3,declined_reason=$4,updated_at=now()
          WHERE id=$1`, [policy.id, input.status, reference, input.status === 'declined' ? reason : null]);
        const scope = policy.subject_type === 'booking' ? 'trip' : 'parcel';
        await audit(tx, actor.id, 'insurance.recorded', policy.id, null, { status: input.status, scope });
        // Keyed on the booking/parcel so the audience resolves, and carrying
        // `scope` so the trip policy and the parcel policy each match their own
        // notification row rather than both firing for everybody.
        if (input.status === 'active' || input.status === 'declined') {
          await emit(tx, `insurance.${input.status === 'active' ? 'confirmed' : 'declined'}`, policy.subject_id, {
            scope, policyId: policy.id, productName: policy.product_name, partnerName: policy.partner_name,
            ...(scope === 'trip' ? { bookingId: policy.subject_id } : { parcelId: policy.subject_id }),
          });
        }
        return { id: policy.id, status: input.status };
      });
    },
  };
}
