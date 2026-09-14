// Called inside the same transaction as the business operation.
export async function enqueue(tx, type, aggregateId, payload) {
  await tx.query('INSERT INTO outbox (event_type, aggregate_id, payload) VALUES ($1,$2,$3)',
    [type, aggregateId, JSON.stringify(payload)]);
}
