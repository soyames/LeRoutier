# Core API

Authoritative backend for LeRoutier.

Suggested module boundaries:

```text
src/
  auth/
  geography/
  network/
  operators/
  vehicles/
  drivers/
  services/
  search/
  bookings/
  capacity/
  fares/
  payments/
  tracking/
  incidents/
  recovery/
  notifications/
  community/
  admin/
```

Capacity-changing and financial operations require transactional, idempotent server-side handling.
