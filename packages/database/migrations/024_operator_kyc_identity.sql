-- Manual KYC/KYB evidence and public independent-driver identity data.
-- Company employees are NOT individually KYC'd by LeRoutier: the company is
-- verified as the accountable transport operator. Independent owner-drivers
-- are verified personally because they are both the operator and the driver.

ALTER TABLE operators ADD COLUMN legal_name text;
ALTER TABLE operators ADD COLUMN tax_reference text;
ALTER TABLE operators ADD COLUMN representative_name text;
ALTER TABLE operators ADD COLUMN representative_id_reference text;
ALTER TABLE operators ADD COLUMN transport_authorization_reference text;
ALTER TABLE operators ADD COLUMN registered_address text;
ALTER TABLE operators ADD COLUMN verified_at timestamptz;
ALTER TABLE operators ADD COLUMN verified_by uuid REFERENCES users(id);

ALTER TABLE driver_profiles ADD COLUMN id_document_type text
  CHECK (id_document_type IS NULL OR id_document_type IN ('national_id','passport','residence_permit','other'));
ALTER TABLE driver_profiles ADD COLUMN id_document_reference text;
ALTER TABLE driver_profiles ADD COLUMN photo_url text;
ALTER TABLE driver_profiles ADD COLUMN insurance_reference text;
ALTER TABLE driver_profiles ADD COLUMN roadworthiness_reference text;
ALTER TABLE driver_profiles ADD COLUMN transport_authorization_reference text;

ALTER TABLE vehicles ADD COLUMN make text;
ALTER TABLE vehicles ADD COLUMN color text;
ALTER TABLE vehicles ADD COLUMN model_year integer CHECK (model_year IS NULL OR model_year BETWEEN 1980 AND 2100);
ALTER TABLE vehicles ADD COLUMN photo_url text;

CREATE TABLE verification_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  subject_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'company_registration','tax_registration','legal_representative_identity','transport_authorization','registered_address',
    'identity','driving_license','vehicle_registration','insurance','roadworthiness','driver_photo','vehicle_photo'
  )),
  reference text,
  file_url text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  CHECK (reference IS NOT NULL OR file_url IS NOT NULL)
);
CREATE INDEX verification_evidence_operator ON verification_evidence(operator_id,status,kind);
