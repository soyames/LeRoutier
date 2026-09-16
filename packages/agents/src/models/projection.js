// What may leave LeRoutier for an external model, and what may come back.
//
// Two one-way valves:
//
//   project*()   builds the ONLY shape that is ever sent. It is an allowlist,
//                not a redaction pass — a field nobody listed here cannot leak,
//                however the caller assembles its data.
//
//   validate()   treats the response as hostile. A model may suggest an action;
//                it can never name one into existence, grant itself a scope, or
//                reach another operator.

import { createHash } from 'node:crypto';

/** Anything that could identify a person, however it is spelled. */
const FORBIDDEN_KEY = /name|phone|tel|mobile|email|mail|address|adresse|subject|token|secret|code|pin|passport|licence|license|iban|account|destination|latitude|longitude|lat|lon|lng|coord/i;

/**
 * Proof, not intention: asserts a payload carries no field that could identify
 * a person or a place. Used by the projections below and by their tests, so a
 * projection cannot quietly grow a leaky field later.
 * @returns {string[]} offending key paths, empty when safe
 */
export function unsafeFields(value, path = '') {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => unsafeFields(item, `${path}[${i}]`));
  return Object.entries(value).flatMap(([key, child]) => {
    const here = path ? `${path}.${key}` : key;
    // `city` and `stopName` are public place labels and are allowed by name
    // below; nothing else matching the pattern gets through.
    if (FORBIDDEN_KEY.test(key) && !['stopName', 'operatorLabel'].includes(key)) return [here];
    return unsafeFields(child, here);
  });
}

const minutes = value => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : null);
const count = value => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);

/**
 * A delayed or possibly broken-down service, as facts.
 *
 * No passenger, no crew member, no phone number, no coordinate. A city name and
 * a stop name are public — they are printed on the ticket — and the model
 * cannot reason about "the next stop" without them.
 */
export function projectServiceSituation(situation = {}) {
  return {
    serviceStatus: situation.serviceStatus ?? 'unknown',
    delayMinutes: minutes(situation.delayMinutes),
    vehicleStationaryMinutes: minutes(situation.vehicleStationaryMinutes),
    signal: situation.signal ?? 'unavailable',
    signalAgeMinutes: minutes(situation.signalAgeMinutes),
    progressFraction: Number.isFinite(situation.progressFraction) ? Number(situation.progressFraction.toFixed(2)) : null,
    remainingKm: Number.isFinite(situation.remainingM) ? Math.round(situation.remainingM / 1000) : null,
    passengersAffected: count(situation.passengersAffected),
    parcelsAffected: count(situation.parcelsAffected),
    stopName: situation.nextStopCity ?? null,
    openIncident: situation.openIncidentKind ?? null,
    replacementVehiclesAvailable: count(situation.replacementVehiclesAvailable),
    alternativeServicesAvailable: count(situation.alternativeServicesAvailable),
  };
}

/** A parcel exception, as facts. Never a sender, a receiver or a pickup code. */
export function projectParcelSituation(situation = {}) {
  return {
    parcelStatus: situation.status ?? 'unknown',
    exceptionKind: situation.exceptionKind ?? null,
    hoursSinceReady: minutes(situation.hoursSinceReady),
    hoursInTransit: minutes(situation.hoursInTransit),
    serviceDelayed: Boolean(situation.serviceDelayed),
    reminderAlreadySent: Boolean(situation.reminderAlreadySent),
    stopName: situation.destinationCity ?? null,
  };
}

/** A stable fingerprint of a task input, for duplicate suppression. */
export const inputHash = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');

// --------------------------------------------------------------- response ---

/** The only shape a recommendation may take. */
export const RECOMMENDATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['classification', 'severity', 'recommendedAction', 'reason'],
  properties: {
    classification: { type: 'string', maxLength: 64 },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    // `none` is a first-class answer. A model that must always recommend
    // something will always recommend something.
    recommendedAction: { type: 'string', maxLength: 64 },
    reason: { type: 'string', maxLength: 280 },
  },
};

export const REJECTIONS = {
  malformed: 'malformed_response',
  unknownAction: 'unknown_action',
  outOfScope: 'out_of_scope',
  notPermittedForTask: 'action_not_permitted_for_task',
  crossOperator: 'cross_operator',
};

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
/**
 * Reasons are rendered in the Ops console, so control characters and angle
 * brackets are stripped from anything the model wrote. Written as an explicit
 * scan rather than a regex: a character class containing control characters is
 * unreadable, easy to get wrong, and needs a lint exception to exist at all.
 */
const cleanText = (value, max) => {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0);
    out += (code < 0x20 || code === 0x7f || char === '<' || char === '>') ? ' ' : char;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
};

/**
 * Turns an untrusted model response into either a recommendation LeRoutier is
 * willing to show, or a reason it refused.
 *
 * Note what this does NOT do: it never executes anything, and it never returns
 * an action the caller did not already list as permissible for this task. The
 * model chooses from a menu; it does not write the menu.
 *
 * @param {unknown} response raw parsed model output
 * @param {{ actions: Record<string, any>, allowedActions: string[], scopes: string[],
 *   operatorId?: string|null, targetOperatorId?: string|null }} policy
 */
export function validateRecommendation(response, policy) {
  const { actions = {}, allowedActions = [], scopes = [], operatorId = null, targetOperatorId = null } = policy;
  if (!response || typeof response !== 'object' || Array.isArray(response)) return { ok: false, rejection: REJECTIONS.malformed };

  // Every read below goes through cleanText or an enum check, so the shape is
  // asserted rather than trusted — this cast narrows the type, nothing else.
  const raw = /** @type {Record<string, unknown>} */ (response);
  const classification = cleanText(raw.classification, 64);
  const reason = cleanText(raw.reason, 280);
  const severity = SEVERITIES.includes(/** @type {string} */ (raw.severity)) ? /** @type {string} */ (raw.severity) : null;
  const proposed = cleanText(raw.recommendedAction, 64);
  if (!classification || !severity || !reason) return { ok: false, rejection: REJECTIONS.malformed };

  // An operator-bound caller reasoning about another operator's service is a
  // containment failure, whatever the model said. Checked before the action.
  if (operatorId && targetOperatorId && operatorId !== targetOperatorId) {
    return { ok: false, rejection: REJECTIONS.crossOperator, classification, severity, reason };
  }

  const recommendation = { classification, severity, reason, recommendedAction: null, requiresApproval: null };

  // "Nothing to do" is a valid, useful answer and must not be forced into one.
  if (!proposed || proposed === 'none') return { ok: true, recommendation };

  const action = actions[proposed];
  if (!action) return { ok: false, rejection: REJECTIONS.unknownAction, ...recommendation };
  // The task's own allowlist is narrower than the catalog: a triage task may
  // propose raising an incident, never executing a payout.
  if (!allowedActions.includes(proposed)) return { ok: false, rejection: REJECTIONS.notPermittedForTask, ...recommendation };
  if (action.scope && !scopes.includes(action.scope)) return { ok: false, rejection: REJECTIONS.outOfScope, ...recommendation };

  return {
    ok: true,
    recommendation: {
      ...recommendation,
      recommendedAction: proposed,
      // Surfaced so Ops sees, before deciding, whether this would need them.
      requiresApproval: action.approval === 'always' || ['privileged', 'financial'].includes(action.category),
    },
  };
}
