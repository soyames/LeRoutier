import { createDatabase } from '@leroutier/database';
import { serverConfig } from '@leroutier/config';
import { transport } from '@leroutier/database/transport';
import { payments } from '@leroutier/database/payments';
import { payouts } from '@leroutier/database/payouts';
import { recovery } from '@leroutier/database/recovery';
import { parcels } from '@leroutier/database/parcels';
import { notificationPolicies } from '@leroutier/database/notifications';
import { notificationDelivery } from '@leroutier/database/notification-delivery';
import { reminders } from '@leroutier/database/reminders';
import { privacyCenter, retentionEngine } from '@leroutier/database/privacy';
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
  await notificationDelivery(db).tick();
  // Retention runs DRY by default: the scan reports eligibility and never
  // deletes. Destructive execution is an explicit owner decision
  // (RETENTION_EXECUTE=true), never a surprise of the schedule.
  const execute = config.retentionExecute === true;
  const retention = await retentionEngine(db).run({ execute });
  // Inactive accounts nearing their retention due date get ONE warning
  // through the existing mandatory policy path; a keep-confirmation resets
  // the state, and no background request ever counts as activity.
  const expiring = await db.transaction(async tx => (await tx.query(`UPDATE users SET retention_notification_sent_at=now()
    WHERE retention_due_at IS NOT NULL AND retention_due_at<=now()+interval '7 days' AND retention_notification_sent_at IS NULL
      AND keep_confirmed_at IS NULL RETURNING id`)).rows);
  for (const user of expiring) {
    await db.transaction(async tx => tx.query(`INSERT INTO outbox(event_type,aggregate_id,payload)
      VALUES('notification.send',$1,$2)`, [user.id, JSON.stringify({ recipients: [user.id], template: 'privacy_retention_expiring', data: {} })]));
  }
  // Deletion requests whose blockers have cleared are anonymized here —
  // tombstone, never cascade — and the completion event notifies the user
  // through the mandatory policy path.
  const deletions = await privacyCenter(db).processDueDeletions();
  console.log(`Workflow tick processed ${result.processed} events and raised ${due.raised} reminders `
    + `(${due.journeyReminders} journey, ${due.parcelReminders} parcel). Retention ${execute ? 'executed' : 'dry-run'}: `
    + `${retention.report.map(r => `${r.category}=${r.eligible}`).join(', ')}; ${expiring.length} retention warning(s) raised; `
    + `${deletions.processed.length} deletion(s) processed.`);
} catch {
  console.error('Workflow processing failed.');
  process.exitCode = 1;
} finally {
  await db.close();
}
