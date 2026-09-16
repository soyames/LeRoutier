import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

// Provider adapters.
//
// Every USSD gateway invents its own field names and its own way of saying
// "continue" or "end". That variation stops here: the engine sees one shape,
// and adding a gateway is one object in this file, not a change to any flow.
//
// The adapter answers exactly three questions:
//   - is this request genuinely from the provider?        verify()
//   - who is calling, on which session, having typed what? parse()
//   - how does this provider want the reply?               render()

/** The normalised request every flow sees, whatever the gateway sent. */
/**
 * `terminated` is set only by gateways that say outright that the subscriber
 * hung up or the network timed the call out; most leave it to be inferred.
 * @typedef {{ sessionId: string, msisdn: string, input: string,
 *   verified: boolean, provider: string, sequence: number|null,
 *   terminated?: boolean }} UssdRequest
 */

/**
 * E.164 where the input makes that unambiguous, so one caller is one caller
 * across gateways and across screens.
 *
 * Deliberately conservative. Whether a leading zero is a national trunk prefix
 * to be dropped is a country-specific rule, and Benin's own numbering changed
 * in 2022 — guessing it here would silently merge or split callers. So a bare
 * local number simply gains the country code, and anything already carrying
 * one is left alone. Any operator-specific rule belongs in that gateway's
 * adapter, where it can be stated and tested against real numbers.
 */
export function normalizeMsisdn(value, defaultCountry = '229') {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  // Already international, in either notation.
  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith(defaultCountry)) return `+${digits}`;
  return `+${defaultCountry}${digits}`;
}

/** Sessions and rate limits key on this; the number itself is never stored. */
export const hashMsisdn = msisdn => createHash('sha256').update(String(msisdn)).digest('hex');

/** Never whole, never in a log, but enough for a human to recognise their own. */
export function maskMsisdn(msisdn) {
  const value = String(msisdn ?? '');
  return value.length <= 4 ? '****' : `${value.slice(0, 4)}****${value.slice(-2)}`;
}

/**
 * Only the last segment of a gateway's `text` field is new input.
 *
 * Africa's Talking and several others send the whole accumulated string —
 * `1*2*3` — on every step. Treating that as the answer to the current question
 * is a classic USSD bug: the user types "2" and the app reads "1*2".
 */
export const latestInput = text => String(text ?? '').split('*').filter(part => part !== '').at(-1) ?? '';

/** Constant-time HMAC-SHA256 comparison; a missing secret never "passes". */
function verifyHmac(raw, provided, secret) {
  if (!secret || !provided) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  let supplied;
  try { supplied = Buffer.from(String(provided).trim(), 'hex'); } catch { return false; }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * The sandbox gateway: the local simulator and the test suite.
 *
 * It exists so the whole channel can be developed and tested without a telecom
 * contract. It is **never verified**, which means it can never bind an identity
 * — a development convenience must not become an authentication bypass.
 */
export const sandboxAdapter = {
  name: 'sandbox',
  /** @returns {boolean} */
  verify() { return false; },
  /** @param {any} body @returns {UssdRequest} */
  parse(body) {
    return {
      provider: 'sandbox',
      sessionId: String(body?.sessionId ?? ''),
      msisdn: normalizeMsisdn(body?.phoneNumber ?? body?.msisdn),
      input: latestInput(body?.text),
      sequence: Number.isInteger(body?.sequence) ? body.sequence : null,
      verified: false,
    };
  },
  render({ text, continues }) {
    return { body: `${continues ? 'CON' : 'END'} ${text}`, contentType: 'text/plain; charset=utf-8' };
  },
  metadata() { return { name: 'sandbox', verified: false, maxResponseChars: 182 }; },
};

/**
 * A generic HMAC gateway.
 *
 * Shaped after the common denominator — a form/JSON body, an HMAC-SHA256 over
 * the raw body, `CON`/`END` replies — so most gateways need only their field
 * names changed. It is production-capable the moment a real secret is set, and
 * refuses everything until then.
 */
export const hmacAdapter = {
  name: 'generic',
  verify(raw, headers, secret) {
    return verifyHmac(raw, headers.get?.('x-ussd-signature') ?? headers['x-ussd-signature'], secret);
  },
  parse(body) {
    return {
      provider: 'generic',
      sessionId: String(body?.sessionId ?? body?.session_id ?? ''),
      msisdn: normalizeMsisdn(body?.msisdn ?? body?.phoneNumber ?? body?.phone_number),
      input: latestInput(body?.text ?? body?.input ?? body?.userInput),
      sequence: Number.isInteger(body?.sequence) ? body.sequence : null,
      verified: true,
    };
  },
  render({ text, continues }) {
    return { body: `${continues ? 'CON' : 'END'} ${text}`, contentType: 'text/plain; charset=utf-8' };
  },
  metadata() { return { name: 'generic', verified: true, maxResponseChars: 182 }; },
};

/**
 * MTN Group USSD interface.
 *
 * MTN's own inbound shape, which is not the `CON`/`END` convention most
 * aggregators use:
 *
 *   sessionId    stable for the whole call
 *   messageType  0 Begin · 1 Continue · 2 End · 3 Notification · 4 Cancel · 5 Timeout
 *   msisdn       the subscriber
 *   serviceCode  the shortcode, e.g. *1234*356#
 *   ussdString   the message content; for a cancel, the reason
 *
 * `messageType` is the part worth having: MTN says explicitly whether this is
 * the first screen, a continuation, or a call the subscriber or network has
 * already ended. Most gateways leave that to be inferred.
 *
 * ⚠️ **Not yet confirmed against the portal's own Swagger.** These field names
 * come from MTN's published API description; the specification itself sits
 * behind developer-portal authentication, and Benin is served by
 * `appx.developers.mtn.com` rather than the main portal. Before activation,
 * check this mapping against the downloaded spec — `contract` below exists so
 * that check is a single diff, and the contract tests pin every field name.
 *
 * The inbound verification scheme is deliberately NOT guessed. Until MTN's
 * scheme is confirmed, `verify()` accepts only an explicitly configured shared
 * secret, and anything else fails closed — which means an unconfirmed callback
 * can never bind an identity.
 */
export const mtnAdapter = {
  name: 'mtn',
  /** Every field this adapter depends on, in one place, for the diff. */
  contract: {
    inbound: ['sessionId', 'messageType', 'msisdn', 'serviceCode', 'ussdString'],
    messageTypes: { begin: 0, continue: 1, end: 2, notification: 3, cancel: 4, timeout: 5 },
    signatureHeader: 'x-ussd-signature',
    confirmed: false,
  },
  verify(raw, headers, secret) {
    return verifyHmac(raw, headers.get?.('x-ussd-signature') ?? headers['x-ussd-signature'], secret);
  },
  /** @param {any} body @returns {UssdRequest} */
  parse(body) {
    const messageType = Number(body?.messageType);
    // MTN sends the whole dialled string on Begin (`*1234*356#`). That is the
    // shortcode, not an answer to a question — so the first screen gets no
    // input, exactly as a caller who has only dialled in has typed nothing.
    const isBegin = messageType === 0;
    return {
      provider: 'mtn',
      sessionId: String(body?.sessionId ?? ''),
      msisdn: normalizeMsisdn(body?.msisdn),
      input: isBegin ? '' : latestInput(body?.ussdString),
      sequence: Number.isInteger(messageType) ? messageType : null,
      verified: true,
      // A cancelled or timed-out call is over: the engine must close the
      // session rather than render another screen into a dead channel.
      terminated: [2, 4, 5].includes(messageType),
    };
  },
  render({ text, continues }) {
    // MTN's response carries the continuation decision as a message type
    // rather than a text prefix.
    return {
      body: JSON.stringify({ messageType: continues ? 1 : 2, ussdString: text }),
      contentType: 'application/json; charset=utf-8',
    };
  },
  metadata() {
    return {
      name: 'mtn', verified: true, maxResponseChars: 182,
      // ARCEP-approved operational limits, used as defaults rather than as
      // targets: LeRoutier aims far below both.
      maxSessionSeconds: 120, maxResponseSeconds: 60,
      contractConfirmed: false,
    };
  },
};

const ADAPTERS = { sandbox: sandboxAdapter, generic: hmacAdapter, mtn: mtnAdapter };

/**
 * An unknown provider resolves to nothing rather than to the sandbox: silently
 * falling back to the one adapter that never verifies would turn a typo into an
 * open endpoint.
 */
export const adapterFor = name => ADAPTERS[name] ?? null;
export const adapterNames = () => Object.keys(ADAPTERS);
