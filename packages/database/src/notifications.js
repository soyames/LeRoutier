import { invariant, uuid } from '@leroutier/domain';
import { CATEGORIES, CHANNELS, channelAvailability, resolveChannels } from '@leroutier/notifications';
import { dailyUsage, channelState, quotaPressure, emailAdmitted, DEFAULT_QUOTA_THRESHOLDS } from './notification-channel-state.js';

// Domain event -> policy -> recipient -> channel -> delivery record.
// The outbox stays the only event stream: dispatch runs inside the same
// outbox drain as the workflow engine, so a replayed event cannot duplicate a
// notification (notifications_once) and a provider outage cannot roll back the
// business transaction that produced the event.
const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
const rows = async (tx, sql, args = []) => (await tx.query(sql, args)).rows;

// Recipient resolution is code, not data: each audience knows how to walk from
// an event's aggregate to the people who should hear about it.
const AUDIENCES = {
  async booking_passenger(tx, event) {
    const bookingId = event.payload?.bookingId ?? event.aggregate_id;
    const row = await one(tx, 'SELECT id,passenger_id FROM bookings WHERE id=$1', [bookingId]);
    return row ? [{ userId: row.passenger_id, entityId: row.id }] : [];
  },
  async service_passengers(tx, event) {
    return (await rows(tx, `SELECT DISTINCT passenger_id,service_id FROM bookings
      WHERE service_id=$1 AND status IN ('held','confirmed','boarded')`, [event.aggregate_id]))
      .map(r => ({ userId: r.passenger_id, entityId: r.service_id }));
  },
  async service_driver_independent(tx, event) {
    const serviceId = event.payload?.serviceId ?? event.aggregate_id;
    return (await rows(tx, `SELECT a.driver_id,a.service_id FROM service_assignments a
      JOIN services s ON s.id=a.service_id JOIN operators o ON o.id=s.operator_id
      WHERE a.service_id=$1 AND a.ended_at IS NULL AND o.type='independent' AND o.owner_user_id=a.driver_id`, [serviceId]))
      .map(r => ({ userId: r.driver_id, entityId: r.service_id }));
  },
  // Company drivers are crew, not revenue owners: no settlement or payout
  // policy targets this audience anywhere in the catalogue.
  async service_driver_company(tx, event) {
    const serviceId = event.payload?.serviceId ?? event.aggregate_id;
    return (await rows(tx, `SELECT a.driver_id,a.service_id FROM service_assignments a
      JOIN services s ON s.id=a.service_id JOIN operators o ON o.id=s.operator_id
      WHERE a.service_id=$1 AND a.ended_at IS NULL AND a.driver_id IS NOT NULL AND o.type='company'`, [serviceId]))
      .map(r => ({ userId: r.driver_id, entityId: r.service_id }));
  },
  async service_convoyeur(tx, event) {
    const serviceId = event.payload?.serviceId ?? event.aggregate_id;
    return (await rows(tx, `SELECT a.convoyeur_id,a.service_id FROM service_assignments a
      WHERE a.service_id=$1 AND a.ended_at IS NULL AND a.convoyeur_id IS NOT NULL`, [serviceId]))
      .map(r => ({ userId: r.convoyeur_id, entityId: r.service_id }));
  },
  async operator_ops(tx, event) {
    const operatorId = event.payload?.operatorId ?? (await operatorOf(tx, event));
    if (!operatorId) return [];
    return (await rows(tx, "SELECT id FROM users WHERE role='ops' AND operator_id=$1", [operatorId]))
      .map(r => ({ userId: r.id, entityId: event.aggregate_id }));
  },
  async platform_ops(tx, event) {
    return (await rows(tx, "SELECT id FROM users WHERE role='ops' AND operator_id IS NULL"))
      .map(r => ({ userId: r.id, entityId: event.aggregate_id }));
  },
  /**
   * The person waiting on a payout.
   *
   * Reached through the payout request itself. No existing audience could walk
   * from a payout to its beneficiary — they all start from a service, a parcel
   * or an operator — so a driver was told nothing when their transfer
   * completed, and nothing when it failed and their balance came back.
   */
  async payout_beneficiary(tx, event) {
    const id = event.payload?.payoutRequestId ?? event.aggregate_id;
    const driver = await one(tx, 'SELECT driver_id FROM payout_requests WHERE id=$1', [id]);
    if (driver?.driver_id) return [{ userId: driver.driver_id, entityId: id }];
    // An operator payout is owed to the operator, and for an independent one
    // that is a person with an inbox. A company settles on its own terms.
    const operator = await one(tx, `SELECT o.owner_user_id FROM operator_payout_requests r
      JOIN operators o ON o.id=r.operator_id WHERE r.id=$1 AND o.type='independent'`, [id]);
    return operator?.owner_user_id ? [{ userId: operator.owner_user_id, entityId: id }] : [];
  },
  async operator_owner(tx, event) {
    const operatorId = event.payload?.operatorId ?? (await operatorOf(tx, event));
    if (!operatorId) return [];
    const row = await one(tx, "SELECT owner_user_id FROM operators WHERE id=$1 AND type='independent'", [operatorId]);
    return row?.owner_user_id ? [{ userId: row.owner_user_id, entityId: event.aggregate_id }] : [];
  },
  // Parcel parties are phone contacts, not necessarily LeRoutier identities.
  parcel_sender: (tx, event) => parcelParty(tx, event, 'sender'),
  parcel_receiver: (tx, event) => parcelParty(tx, event, 'receiver'),
  async point_proposer(tx, event) {
    const row = await one(tx, 'SELECT id,proposed_by FROM boarding_points WHERE id=$1', [event.aggregate_id]);
    return row ? [{ userId: row.proposed_by, entityId: row.id }] : [];
  },
};

async function parcelParty(tx, event, role) {
  const row = await one(tx, `SELECT p.id,pp.phone FROM parcels p JOIN parcel_parties pp ON pp.parcel_id=p.id AND pp.role=$2
    WHERE p.id=$1`, [event.aggregate_id, role]);
  if (!row?.phone) return [];
  // The sender has an authenticated account; do not link a recipient's account
  // by an unverified phone number. Receivers without an account use the gateway.
  const sender = role === 'sender' ? await one(tx,'SELECT created_by FROM parcels WHERE id=$1',[row.id]) : null;
  return [{ contact: row.phone, userId: sender?.created_by ?? null, entityId: row.id }];
}

// Best-effort operator lookup for events whose payload omits it.
async function operatorOf(tx, event) {
  for (const sql of ['SELECT operator_id FROM services WHERE id=$1', 'SELECT operator_id FROM parcels WHERE id=$1',
    'SELECT s.operator_id FROM incidents i JOIN services s ON s.id=i.service_id WHERE i.id=$1']) {
    const row = await one(tx, sql, [event.aggregate_id]).catch(() => null);
    if (row?.operator_id) return row.operator_id;
  }
  return null;
}

// TEST inventory must never notify real people on external channels. An event
// linked to a demo/test service (through the payload or its aggregate id) is
// confined to the in-app inbox; SMS/WhatsApp/e-mail/push are never attempted.
async function testService(tx, event, payload) {
  const ids = [event.aggregate_id, payload.serviceId, payload.bookingId, payload.parcelId,
    payload.data?.serviceId, payload.data?.bookingId].filter(Boolean);
  if (!ids.length) return false;
  const row = await one(tx, `SELECT EXISTS(SELECT 1 FROM services s WHERE s.is_demo AND (
    s.id=ANY($1::uuid[]) OR s.id IN (SELECT service_id FROM bookings WHERE id=ANY($1::uuid[])) OR
    s.id IN (SELECT b.service_id FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE p.id=ANY($1::uuid[])) OR
    s.id IN (SELECT service_id FROM parcel_service_assignments WHERE parcel_id=ANY($1::uuid[])) OR
    s.id IN (SELECT service_id FROM incidents WHERE id=ANY($1::uuid[]))))
    OR EXISTS(SELECT 1 FROM parcels p JOIN operators o ON o.id=p.operator_id LEFT JOIN users u ON u.id=p.created_by
      WHERE p.id=ANY($1::uuid[]) AND (o.is_demo OR u.is_demo)) AS synthetic`, [ids]);
  return row?.synthetic === true;
}

// Content carried to the recipient. Deliberately narrow: identifiers and
// scheduling facts only. Pickup codes, ticket tokens and another party's
// contact details are never copied into a notification.
const SAFE_KEYS = ['serviceId', 'bookingId', 'trackingNumber', 'status', 'departureAt', 'previousDepartureAt',
  'boardingPointName', 'previousBoardingPointName', 'amountMinor', 'sequence', 'leaveBy', 'reason', 'decision'];
const safeData = payload => Object.fromEntries(Object.entries(payload ?? {}).filter(([k]) => SAFE_KEYS.includes(k)));

export function notificationPolicies(db, config = {}) {
  const availability = channelAvailability(config);
  // Dispatch one outbox event. Called with the caller's transaction.
  async function dispatchEvent(tx, event) {
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : (event.payload ?? {});
    const normalized = { ...event, payload };
    const synthetic = await testService(tx, event, payload);
    const deliveryState = channel => synthetic && channel.channel !== 'in_app'
      ? { ...channel, status: 'suppressed', detail: 'TEST transport: external delivery suppressed' } : channel;
    // Existing agent/direct sends enter the same inbox and delivery tables.
    if(event.event_type==='notification.send') {
      let recipients=[],template=payload.template??'parcel_update',channels=['in_app'];
      if(Array.isArray(payload.recipients)) recipients=payload.recipients.map(userId=>({userId}));
      else if(payload.kind==='channel' && CHANNELS.includes(payload.channel)) {
        recipients=[payload.channel==='in_app'?{userId:payload.to}:{contact:payload.to}];channels=[payload.channel];
      } else if(payload.kind==='parcel' && ['sender','receiver'].includes(payload.party)) {
        recipients=await parcelParty(tx,{...event,aggregate_id:payload.parcelId},payload.party);channels=['sms','whatsapp'];
      }
      // Test-linked events never leave the in-app inbox.
      if(synthetic) channels=[...new Set(['in_app', ...channels])];
      let created=0;
      for(const recipient of recipients) {
        const inserted=await one(tx,`INSERT INTO notifications(user_id,contact,event_type,category,template,data,source_event_id)
          VALUES($1,$2,$3,'operational',$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
        [recipient.userId??null,recipient.contact??null,event.event_type,template,JSON.stringify(safeData(payload.data)),event.id]);
        if(!inserted)continue;created++;
        const preferences=recipient.userId?await rows(tx,'SELECT category,channel,enabled FROM notification_preferences WHERE user_id=$1',[recipient.userId]):[];
        for(const channel of resolveChannels({policyChannels:channels,availability,category:'operational',preferences}).map(deliveryState)) {
          if(channel.channel==='in_app' && !recipient.userId)continue;
          await tx.query('INSERT INTO notification_deliveries(notification_id,channel,status,detail) VALUES($1,$2,$3,$4)',[inserted.id,channel.channel,channel.status,channel.detail]);
        }
      }
      return created;
    }
    const policies = await rows(tx, `SELECT * FROM notification_policies
      WHERE active AND event_type=$1 AND $2::jsonb @> payload_match`, [event.event_type, JSON.stringify(payload)]);
    // Read once per event rather than per policy per recipient: an event that
    // fans out to forty passengers must not ask forty times.
    const pressure = policies.some(p => (p.channels ?? []).includes('email'))
      ? quotaPressure(
        await dailyUsage(tx, 'email', config.emailDailyQuota ?? null),
        await channelState(tx, 'email'),
        config.emailQuotaThresholds ?? DEFAULT_QUOTA_THRESHOLDS)
      : 'healthy';
    let created = 0;
    for (const policy of policies) {
      const resolve = AUDIENCES[policy.audience];
      if (!resolve) continue;
      for (const recipient of await resolve(tx, normalized)) {
        if (!recipient.userId && !recipient.contact) continue;
        const preferences = recipient.userId
          ? await rows(tx, 'SELECT category,channel,enabled FROM notification_preferences WHERE user_id=$1', [recipient.userId]) : [];
        const inserted = await one(tx, `INSERT INTO notifications(policy_id,user_id,contact,event_type,category,severity,template,data,entity_type,entity_id,source_event_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING *`,
        [policy.id, recipient.userId ?? null, recipient.contact ?? null, event.event_type, policy.category, policy.severity,
          policy.template, JSON.stringify(safeData(payload)), policy.entity_type, recipient.entityId ?? null, event.id]);
        if (!inserted) continue;
        created++;
        // Test-linked events are confined to the in-app inbox — genuinely, not
        // merely in the sense that the adapter would refuse them later. A TEST
        // notification that reaches an outbound adapter costs attempts and can
        // colour the channel's health with failures nobody caused.
        const policyChannels = synthetic ? ['in_app']
          // When the day's allowance is under pressure, spend what is left on
          // the messages somebody has to act on. Only the EMAIL is dropped;
          // the notification is created and delivered in-app exactly as
          // before, because the application is where the state lives.
          : emailAdmitted(policy.importance ?? 'normal', pressure)
            ? policy.channels
            : policy.channels.filter(channel => channel !== 'email');
        for (const channel of resolveChannels({ policyChannels, availability, mandatory: policy.mandatory, category: policy.category, preferences }).map(deliveryState)) {
          // A contact without an account has no in-app inbox to read.
          if (channel.channel === 'in_app' && !recipient.userId) continue;
          await tx.query(`INSERT INTO notification_deliveries(notification_id,channel,status,detail) VALUES($1,$2,$3,$4)
            ON CONFLICT(notification_id,channel) DO NOTHING`, [inserted.id, channel.channel, channel.status, channel.detail]);
        }
        // Timing advice replaces itself instead of stacking contradictions.
        if (policy.template === 'first_mile_leave_soon' || policy.template === 'service_delayed') await supersede(tx, inserted);
      }
    }
    return created;
  }

  // Mark earlier advice about the same entity as superseded so a passenger is
  // never left holding two different "leave at" times.
  async function supersede(tx, notification) {
    const previous=await rows(tx,`UPDATE notifications SET superseded_at=now()
      WHERE id<>$1 AND superseded_at IS NULL AND entity_type=$2 AND entity_id=$3 AND template=$4
      AND (user_id=$5 OR ($5::uuid IS NULL AND contact=$6)) RETURNING id,created_at`,
    [notification.id, notification.entity_type, notification.entity_id, notification.template, notification.user_id, notification.contact]);
    if(previous.length) await tx.query('UPDATE notifications SET supersedes_id=$2 WHERE id=$1 AND supersedes_id IS NULL',
      [notification.id,previous.sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime())[0].id]);
  }

  return {
    dispatchEvent,
    availability: () => ({ ...availability }),
    // In-app notification centre. Superseded advice is hidden by default so the
    // list never shows two conflicting recommendations at once.
    /**
     * What Platform Ops needs to know about the email channel.
     *
     * Non-sensitive by construction: counts, one state word, and timestamps.
     * No key, no recipient, no subject, no body, no signed link, and no
     * provider string — the provider's own messages echo addresses back and
     * never leave the adapter.
     *
     * `sentToday` is LEROUTIER'S count of sends this platform observed being
     * accepted, not a balance read from the provider. Brevo Free does not
     * expose a per-day remaining figure through the API, so inventing one
     * would be a made-up metric; this is labelled for what it is and the
     * provider's own refusal remains authoritative when it comes.
     */
    async channelHealth() {
      return db.transaction(async tx => {
        const usage = await dailyUsage(tx, 'email', config.emailDailyQuota ?? null);
        const state = await channelState(tx, 'email');
        const thresholds = config.emailQuotaThresholds ?? DEFAULT_QUOTA_THRESHOLDS;
        const failures = await rows(tx, `SELECT detail, count(*)::int AS count
          FROM notification_delivery_attempts a
          JOIN notification_deliveries d ON d.id=a.delivery_id
          WHERE d.channel='email' AND a.created_at > now()-interval '24 hours'
            AND a.status <> 'provider_accepted'
          GROUP BY detail ORDER BY count DESC`);
        return {
          available: availability.email === true,
          provider: config.notificationProviders?.emailProvider ?? (config.notificationProviders?.email ? 'gateway' : null),
          pressure: quotaPressure(usage, state, thresholds),
          thresholds,
          // Deliberately named so nobody mistakes it for the provider's number.
          leRoutierSentToday: usage.sent,
          configuredDailyAllowance: usage.allowance,
          estimatedRemaining: usage.remaining,
          usedPercent: usage.usedPercent,
          suppressedUntil: state?.suppressed_until ?? null,
          suppressionReason: state?.suppression_reason ?? null,
          rateLimitRemaining: state?.rate_limit_remaining ?? null,
          lastOutcome: state?.last_outcome ?? null,
          lastOutcomeAt: state?.last_outcome_at ?? null,
          lastSuccessAt: state?.last_success_at ?? null,
          recentFailures: failures,
        };
      });
    },

    async list(actor, { unreadOnly = false, limit = 50 } = {}) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      const max = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 50;
      return db.transaction(async tx => (await rows(tx, `SELECT n.id,n.event_type,n.category,n.severity,n.template,n.data,
        n.entity_type,n.entity_id,n.read_at,n.created_at,
        coalesce(jsonb_object_agg(d.channel,d.status) FILTER (WHERE d.channel IS NOT NULL),'{}'::jsonb) AS channels
        FROM notifications n LEFT JOIN notification_deliveries d ON d.notification_id=n.id
        WHERE n.user_id=$1 AND n.superseded_at IS NULL AND ($2=false OR n.read_at IS NULL)
        GROUP BY n.id ORDER BY n.created_at DESC LIMIT $3`, [actor.id, unreadOnly === true, max]))
        .map(r => ({ id: r.id, eventType: r.event_type, category: r.category, severity: r.severity, template: r.template,
          data: r.data, entityType: r.entity_type, entityId: r.entity_id, read: r.read_at !== null,
          createdAt: r.created_at, channels: r.channels })));
    },
    async markRead(actor, id) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      return db.transaction(async tx => {
        const row = await one(tx, 'UPDATE notifications SET read_at=coalesce(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at',
          [uuid(id), actor.id]);
        invariant(row, 'NOT_FOUND', 'Notification not found.', 404);
        return { id: row.id, read: true };
      });
    },
    async preferences(actor) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      return db.transaction(async tx => {
        const stored = await rows(tx, 'SELECT category,channel,enabled FROM notification_preferences WHERE user_id=$1', [actor.id]);
        // Mandatory categories are reported as locked so the UI cannot offer a
        // switch that the dispatcher would ignore anyway.
        const mandatory = (await rows(tx, 'SELECT DISTINCT category FROM notification_policies WHERE mandatory AND active')).map(r => r.category);
        return {
          channels: CHANNELS.map(channel => ({ channel, available: availability[channel] })),
          categories: CATEGORIES.map(category => ({
            category, locked: mandatory.includes(category),
            channels: CHANNELS.map(channel => ({ channel,
              enabled: stored.find(p => p.category === category && p.channel === channel)?.enabled ?? true })),
          })),
        };
      });
    },
    async setPreference(actor, input) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      invariant(input && Object.keys(input).every(k => ['category', 'channel', 'enabled'].includes(k)), 'INVALID_PREFERENCE', 'Unexpected preference fields.');
      invariant(CATEGORIES.includes(input.category), 'INVALID_PREFERENCE', 'Unknown notification category.');
      invariant(CHANNELS.includes(input.channel), 'INVALID_PREFERENCE', 'Unknown notification channel.');
      invariant(typeof input.enabled === 'boolean', 'INVALID_PREFERENCE', 'Enabled must be true or false.');
      return db.transaction(async tx => {
        // Mandatory transactional alerts cannot be switched off: refuse rather
        // than store a preference the dispatcher will not honour.
        const locked = await one(tx, 'SELECT 1 FROM notification_policies WHERE mandatory AND active AND category=$1 LIMIT 1', [input.category]);
        invariant(!(locked && input.enabled === false), 'PREFERENCE_LOCKED',
          'Les alertes essentielles (paiement, annulation, point d’embarquement) ne peuvent pas être désactivées.', 409);
        await tx.query(`INSERT INTO notification_preferences(user_id,category,channel,enabled) VALUES($1,$2,$3,$4)
          ON CONFLICT(user_id,category,channel) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`,
        [actor.id, input.category, input.channel, input.enabled]);
        return { category: input.category, channel: input.channel, enabled: input.enabled };
      });
    },
  };
}
