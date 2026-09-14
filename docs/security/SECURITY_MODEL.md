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

A formal threat model and privacy/data-retention assessment are required before production launch.
