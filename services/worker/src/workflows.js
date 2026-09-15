import { createDatabase } from '@leroutier/database';
import { serverConfig } from '@leroutier/config';
import { transport } from '@leroutier/database/transport';
import { payments } from '@leroutier/database/payments';
import { payouts } from '@leroutier/database/payouts';
import { recovery } from '@leroutier/database/recovery';
import { parcels } from '@leroutier/database/parcels';
import { createActions, createWorkflowEngine } from '@leroutier/agents';
import { paymentAdapter } from '../../../services/api/src/payment-adapter.js';

// Event-driven workflow runner: consumes undelivered outbox events and drives
// workflow steps through the same domain services as the API. Safe to run on
// a schedule and safe to run concurrently.
const db = createDatabase();
try {
  const adapter = paymentAdapter(serverConfig());
  const domain = transport(db);
  const actions = createActions({ db, domain, payments: payments(db, adapter), payouts: payouts(db, adapter), recovery: recovery(db), parcels: parcels(db) });
  const engine = createWorkflowEngine({ db, actions });
  const result = await engine.processOutbox();
  console.log(`Workflow tick processed ${result.processed} events.`);
} catch {
  console.error('Workflow processing failed.');
  process.exitCode = 1;
} finally {
  await db.close();
}
