import { createDatabase } from '@leroutier/database';
import { serverConfig } from '@leroutier/config';
import { transport } from '@leroutier/database/transport';
import { payments } from '@leroutier/database/payments';
import { payouts } from '@leroutier/database/payouts';
import { recovery } from '@leroutier/database/recovery';
import { parcels } from '@leroutier/database/parcels';
import { notificationPolicies } from '@leroutier/database/notifications';
import { reminders } from '@leroutier/database/reminders';
import { createActions, createWorkflowEngine } from '@leroutier/agents';
import { paymentAdapter } from '../../../services/api/src/payment-adapter.js';

// Event-driven workflow runner: consumes undelivered outbox events, drives
// workflow steps and dispatches notifications through the same domain services
// as the API. Safe to run on a schedule and safe to run concurrently.
const db = createDatabase();
try {
  const config = serverConfig();
  const adapter = paymentAdapter(config);
  const domain = transport(db);
  const notifications = notificationPolicies(db, config);
  const actions = createActions({ db, domain, payments: payments(db, adapter), payouts: payouts(db, adapter), recovery: recovery(db), parcels: parcels(db) });
  const engine = createWorkflowEngine({ db, actions, onEvent: (tx, event) => notifications.dispatchEvent(tx, event), autonomy: config.agentAutonomy });
  // Time-based journey reminders are raised as ordinary outbox events first, so
  // they travel the same policy path as every other notification.
  const due = await reminders(db, config).tick();
  const result = await engine.processOutbox();
  console.log(`Workflow tick processed ${result.processed} events and raised ${due.raised} reminders `
    + `(${due.journeyReminders} journey, ${due.parcelReminders} parcel).`);
} catch {
  console.error('Workflow processing failed.');
  process.exitCode = 1;
} finally {
  await db.close();
}
