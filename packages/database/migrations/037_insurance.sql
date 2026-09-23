-- Insurance, offered on LeRoutier and underwritten by somebody else.
--
-- READ THIS BEFORE EXTENDING ANY OF IT.
--
-- Until now "assurance" in this codebase meant one thing: the certificate an
-- operator uploads so LeRoutier can check they are lawfully on the road. That
-- is a KYC document and it is untouched here. This migration is about a
-- different thing entirely — cover a passenger or a sender can take for their
-- own trip or their own parcel.
--
-- THE CONSTRAINT THAT SHAPES EVERYTHING BELOW. In Benin, insurance is governed
-- by the CIMA code. Only a licensed insurer may carry risk, and only a
-- registered intermediary may sell cover. LeRoutier is neither. So the schema
-- deliberately CANNOT express LeRoutier carrying risk:
--
--   * there is no premium account, no reserve, no claims table. A claim is the
--     insurer's process and it happens at the insurer. LeRoutier stores their
--     reference and their contact so a passenger can find them, and nothing
--     more.
--   * every policy belongs to a partner, and the partner carries the licence
--     number that makes them lawful. No partner, no offer.
--   * a policy is born `requested`, never `active`. LeRoutier does not decide
--     that somebody is covered; the insurer does, and until they say so the
--     product says "demande transmise" rather than "vous êtes couvert".
--     Showing somebody cover they do not have is the single worst thing this
--     feature could do, so the state machine makes it impossible rather than
--     unlikely.
--
-- Two integration depths, and only one of them is legal for LeRoutier today:
--
--   referral  LeRoutier shows the offer, takes an explicit consent, hands a
--             minimal lead to the partner, and the partner sells and collects.
--             LeRoutier touches no premium. This is what the pilot runs.
--   embedded  the premium is collected at checkout as a separate line and
--             remitted. This needs LeRoutier (or a partner of record) to be a
--             REGISTERED INTERMEDIARY. The column exists so the model is
--             honest about the difference, and `attach` still refuses to move
--             money — see insurance.js.

CREATE TABLE insurance_partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  legal_name text,
  kind text NOT NULL CHECK (kind IN ('insurer','broker')),
  -- The agrément/registration that makes this partner lawful to underwrite or
  -- to intermediate. Required before a partner can be activated: an offer from
  -- an unlicensed party is not an offer, it is a liability.
  cima_registration text,
  country char(2) NOT NULL DEFAULT 'BJ',
  contact_name text,
  contact_email text,
  contact_phone text,
  -- Where a claim actually goes. Shown to the covered person, because a policy
  -- nobody can claim on is worse than no policy.
  claims_phone text,
  claims_email text,
  claims_url text,
  handoff text NOT NULL DEFAULT 'referral' CHECK (handoff IN ('referral', 'embedded')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'suspended')),
  notes text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- An active partner must be identifiable as licensed. Draft partners are
  -- being set up and are never shown to anybody.
  CONSTRAINT insurance_partner_licensed_to_be_active
    CHECK (status <> 'active' OR (cima_registration IS NOT NULL AND length(btrim(cima_registration)) > 0))
);

CREATE INDEX insurance_partners_active ON insurance_partners(status) WHERE status = 'active';

-- A named cover a partner offers. LeRoutier displays it; it does not price it.
CREATE TABLE insurance_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES insurance_partners(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  summary text NOT NULL,
  -- What it attaches to. A trip cover and a parcel cover are different
  -- products with different risks and are never interchangeable.
  scope text NOT NULL CHECK (scope IN ('trip', 'parcel')),
  cover_amount_minor bigint NOT NULL CHECK (cover_amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'XOF',
  -- flat               a fixed premium per booking or per parcel
  -- declared_value_bp  basis points of the declared value (parcels)
  -- included           no premium from the traveller: the operator or the
  --                    insurer pays for it. Still a real policy, still shown.
  premium_mode text NOT NULL CHECK (premium_mode IN ('flat', 'declared_value_bp', 'included')),
  premium_minor bigint NOT NULL DEFAULT 0 CHECK (premium_minor >= 0),
  premium_bp integer NOT NULL DEFAULT 0 CHECK (premium_bp >= 0 AND premium_bp <= 10000),
  min_declared_value_minor bigint CHECK (min_declared_value_minor IS NULL OR min_declared_value_minor >= 0),
  max_declared_value_minor bigint CHECK (max_declared_value_minor IS NULL OR max_declared_value_minor >= 0),
  -- Said plainly to the person deciding, in their language. Not a PDF nobody
  -- opens: the three or four things actually excluded.
  exclusions text,
  terms_url text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, code),
  -- Each premium mode needs its own number and not the other one. A flat
  -- product with a basis-point rate and no amount is a pricing bug waiting to
  -- be discovered by a customer.
  CONSTRAINT insurance_product_premium_is_coherent CHECK (
    (premium_mode = 'flat' AND premium_minor > 0)
    OR (premium_mode = 'declared_value_bp' AND premium_bp > 0)
    OR (premium_mode = 'included' AND premium_minor = 0 AND premium_bp = 0)),
  CONSTRAINT insurance_product_value_band_is_ordered CHECK (
    min_declared_value_minor IS NULL OR max_declared_value_minor IS NULL
    OR max_declared_value_minor >= min_declared_value_minor)
);

CREATE INDEX insurance_products_offerable ON insurance_products(scope, status) WHERE status = 'active';

-- Somebody asked for cover on one specific trip or one specific parcel.
CREATE TABLE insurance_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES insurance_products(id),
  partner_id uuid NOT NULL REFERENCES insurance_partners(id),
  subject_type text NOT NULL CHECK (subject_type IN ('booking', 'parcel')),
  subject_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- requested  consent taken, lead is the partner's to answer
  -- active     the partner confirmed and gave a policy reference
  -- declined   the partner refused. The trip and the parcel are unaffected.
  -- cancelled  withdrawn before the partner answered, or after
  -- expired    the trip happened, or the parcel was delivered
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'active', 'declined', 'cancelled', 'expired')),
  premium_minor bigint NOT NULL DEFAULT 0 CHECK (premium_minor >= 0),
  cover_amount_minor bigint NOT NULL CHECK (cover_amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'XOF',
  -- Who takes the money. 'partner' for every referral, which is every policy
  -- until LeRoutier holds an intermediary registration. 'none' for included
  -- cover, where the traveller pays nothing.
  premium_collected_by text NOT NULL DEFAULT 'partner'
    CHECK (premium_collected_by IN ('partner', 'none', 'leroutier')),
  -- The insurer's own number. The only thing that proves cover exists, so a
  -- policy cannot be active without one.
  partner_reference text,
  declined_reason text,
  -- APDP Art. 384/389: consent is explicit, timestamped and versioned, and
  -- what left the platform is written down. `shared_fields` is the list of
  -- FIELD NAMES transmitted, never the values — this row is an audit record,
  -- not a second copy of somebody's personal data.
  consent_at timestamptz NOT NULL DEFAULT now(),
  consent_version text NOT NULL,
  shared_fields jsonb NOT NULL DEFAULT '[]',
  shared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One cover per trip, one per parcel. Two policies on one parcel is a
  -- dispute between two insurers with the sender in the middle.
  UNIQUE (subject_type, subject_id),
  CONSTRAINT insurance_policy_active_has_reference
    CHECK (status <> 'active' OR (partner_reference IS NOT NULL AND length(btrim(partner_reference)) > 0))
);

CREATE INDEX insurance_policies_user ON insurance_policies(user_id);
CREATE INDEX insurance_policies_partner_queue ON insurance_policies(partner_id, status, created_at);
CREATE INDEX insurance_policies_subject ON insurance_policies(subject_type, subject_id);

-- Managing partners and answering their queue is its own job, held by whoever
-- runs the insurance relationship. It is not verification (that reviews carte
-- grise scans) and it is not finance (that releases LeRoutier's own money).
ALTER TABLE platform_grants DROP CONSTRAINT IF EXISTS platform_grants_capability_check;
ALTER TABLE platform_grants ADD CONSTRAINT platform_grants_capability_check
  CHECK (capability IN ('verification', 'users', 'finance', 'incidents', 'operations',
    'system', 'provisioning', 'insurance', 'superadmin'));

-- The two moments the covered person must hear about, and only those two.
-- A cover that was confirmed and a cover that was refused both change what
-- somebody believes about their own risk, so both are mandatory and both carry
-- email. Requesting one does not: the screen they are looking at already said
-- so. Everything else about a policy is in-app, per docs/NOTIFICATIONS.md.
--
-- Trip and parcel cover are separate policies because the audience differs:
-- `booking.passenger` for a trip, the sender for a parcel. Both resolve from
-- the event's aggregate id, which is the booking or the parcel.
INSERT INTO notification_policies
  (event_type, payload_match, audience, category, severity, template, channels, mandatory, entity_type, importance)
VALUES
  ('insurance.confirmed', '{"scope":"trip"}', 'booking_passenger', 'critical', 'info',
    'insurance_confirmed', '["in_app","email"]', true, 'booking', 'normal'),
  ('insurance.declined', '{"scope":"trip"}', 'booking_passenger', 'critical', 'warning',
    'insurance_declined', '["in_app","email"]', true, 'booking', 'high'),
  ('insurance.confirmed', '{"scope":"parcel"}', 'parcel_sender', 'critical', 'info',
    'insurance_confirmed', '["in_app","email"]', true, 'parcel', 'normal'),
  ('insurance.declined', '{"scope":"parcel"}', 'parcel_sender', 'critical', 'warning',
    'insurance_declined', '["in_app","email"]', true, 'parcel', 'high')
ON CONFLICT (event_type, audience, payload_match) DO NOTHING;
