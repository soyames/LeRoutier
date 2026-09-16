# Security Model

## Baseline

- Server-authoritative identity, roles and permissions.
- Separate platform/operator/driver/passenger privileges.
- Secrets only in secret managers/environment configuration.
- Validate and normalize every external input.
- Financial callbacks require provider authentication/signature verification plus idempotency.
- Booking/capacity changes require transactional protection.
- Sensitive operational actions require audit records.
- Public endpoints require rate limiting/abuse controls.
- Location data access follows least privilege and retention rules.
- Production logs must not expose credentials, payment secrets or unnecessary personal data.

## The rest of the analysis

This page states the commitments. Three companion documents say who would
attack them, who may do what, and what is stored:

- [`THREAT_MODEL.md`](THREAT_MODEL.md) — actors, assets, STRIDE per surface,
  and the residual risk left after each control.
- [`AUTHORIZATION_MATRIX.md`](AUTHORIZATION_MATRIX.md) — the capability matrix
  and where each row is enforced on the server.
- [`PRIVACY_AND_RETENTION.md`](PRIVACY_AND_RETENTION.md) — the data inventory,
  retention position and the items still needing legal review.

Retention periods for vehicle GPS, bookings, payments and notifications remain
open and are flagged for legal review in that last document. They are the
principal privacy gap before broad public use.
