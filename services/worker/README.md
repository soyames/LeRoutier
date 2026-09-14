# Worker

Background processing for retryable asynchronous work: notifications, payment reconciliation, scheduled service transitions, cleanup of expired holds and derived tracking/ETA jobs.

Jobs must be idempotent and observable.
