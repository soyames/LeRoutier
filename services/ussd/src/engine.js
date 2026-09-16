import { translator, fcfa, clock, shortDate, BOOKING_STATUS, PAYMENT_STATUS, SERVICE_STATUS, PARCEL_STATUS } from './messages.js';
import { screen, paginate, enforceLimit, withNotice, gsmLength, MAX_RESPONSE_CHARS } from './render.js';
import { ussdSessions, requestFingerprint } from './sessions.js';

// The USSD state machine.
//
// Every screen is a pure-ish function of (session cursor, caller input) that
// asks the SAME domain services the PWA asks. There is no booking logic here,
// no fare arithmetic, no capacity check — only navigation, and the rendering of
// answers the domain already gave.
//
// If you find yourself about to compute a price or decide whether a seat is
// free in this file, that belongs in packages/domain or packages/database.

const BACK = '0';
const QUIT = '00';
const NEXT_PAGE = '#';
const PREV_PAGE = '*';

/** A booking reference a person can read aloud. Never a raw UUID. */
export const bookingReference = id => `LRB-${String(id).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
const matchesReference = (id, reference) => bookingReference(id) === String(reference).trim().toUpperCase();

/** Domain errors become French; an internal code is never shown to a caller. */
function errorText(t, error) {
  const code = error?.code;
  const specific = code ? t(`error.${code}`) : null;
  return specific && specific !== `error.${code}` ? specific : t('error.generic');
}

/**
 * @param {{ db: any, domain: any, parcels: any, payments: any, tracking: any,
 *   config?: object }} deps
 */
export function createUssdEngine({ db, domain, parcels, payments, tracking, config = {} }) {
  const sessions = ussdSessions(db, {
    ttlSeconds: config.sessionTtlSeconds ?? 180,
    defaultLocale: config.defaultLocale ?? 'fr',
  });
  // Binding a session to an identity needs BOTH a verified callback and an
  // explicit decision to trust the gateway's MSISDN. Neither alone is enough.
  const trustMsisdn = config.trustProviderMsisdn === true;

  const rows = async (sql, args = []) => db.transaction(async tx => (await tx.query(sql, args)).rows);

  /** Bookable points, labelled by city — the same stops the PWA offers. */
  const stops = () => rows(`SELECT s.id, s.name, p.name AS city FROM stops s
    JOIN places p ON p.id = s.place_id ORDER BY p.name, s.name LIMIT 200`);

  // A city name alone, unless the city has a stop whose name adds something —
  // "Cotonou" is what a caller is looking for, "Cotonou – Gare de Jonquet"
  // only when there is more than one place to stand.
  const stopLabel = stop => (stop.name && !String(stop.name).toLowerCase().includes(String(stop.city).toLowerCase())
    ? `${stop.city} - ${stop.name}` : stop.city);

  // ------------------------------------------------------------- screens ----
  const MENU = {
    async render(ctx) {
      const { t } = ctx;
      return cont(screen({
        title: t('menu.title'),
        lines: [t('menu.1'), t('menu.2'), t('menu.3'), t('menu.4'), t('menu.5'), t('menu.6')],
        nav: [t('nav.cancel')],
      }));
    },
    async handle(ctx) {
      const routes = {
        1: { flow: 'search', step: 'origin' }, 2: { flow: 'bookings', step: 'list' },
        3: { flow: 'parcel', step: 'prompt' }, 4: { flow: 'journey', step: 'prompt' },
        5: { flow: 'help', step: 'root' }, 6: { flow: 'locale', step: 'root' },
      };
      const next = routes[ctx.input];
      return next ? ctx.go(next.flow, next.step, {}) : ctx.invalid();
    },
  };

  /** Origin and destination share one screen builder; only the title differs. */
  const stopPicker = (titleKey, onPick) => ({
    async render(ctx) {
      const all = await stops();
      if (!all.length) return end(screen({ title: ctx.t('search.none'), lines: [ctx.t('search.none.hint')] }));
      const page = paginate(all, {
        page: ctx.state.page ?? 0, title: ctx.t(titleKey), limit: ctx.limit ?? MAX_RESPONSE_CHARS,
        nav: [ctx.t('nav.back')],
        render: (stop, i) => `${i + 1}. ${stopLabel(stop)}`,
      });
      // The numbers a caller sees are per page; the offset maps them back.
      const lines = page.items.map((stop, i) => `${i + 1}. ${stopLabel(stop)}`);
      // The carried state is merged, never replaced: the destination screen
      // still has to know which origin the caller chose a moment ago.
      return cont(screen({
        limit: ctx.limit ?? MAX_RESPONSE_CHARS,
        title: ctx.t(titleKey), lines,
        nav: [page.hasNext ? ctx.t('nav.more') : '', page.hasPrevious ? ctx.t('nav.previous') : '', ctx.t('nav.back')],
      }), { ...ctx.state, page: page.page, ids: page.items.map(s => s.id) });
    },
    async handle(ctx) {
      const ids = ctx.state.ids ?? [];
      const choice = Number(ctx.input);
      if (!Number.isInteger(choice) || choice < 1 || choice > ids.length) return ctx.invalid();
      return onPick(ctx, ids[choice - 1]);
    },
  });

  const FLOWS = {
    menu: { root: MENU },

    search: {
      origin: stopPicker('search.origin', (ctx, id) => ctx.go('search', 'destination', { originStopId: id, page: 0 })),
      destination: stopPicker('search.destination', (ctx, id) => {
        if (id === ctx.state.originStopId) return ctx.retry(ctx.t('search.sameStop'));
        return ctx.go('search', 'results', { ...ctx.state, destinationStopId: id, page: 0 });
      }),

      results: {
        async render(ctx) {
          // Straight to the shared domain search: same departures, same fares,
          // same remaining seats the web app would show at this instant.
          const services = await domain.search({
            originStopId: ctx.state.originStopId, destinationStopId: ctx.state.destinationStopId,
          });
          const bookable = services.filter(s => (s.availability?.available ?? 0) > 0);
          if (!bookable.length) {
            return end(screen({ title: ctx.t('search.none'), lines: [ctx.t('search.none.hint')] }));
          }
          const page = paginate(bookable, {
            page: ctx.state.page ?? 0, title: ctx.t('search.results'), nav: [ctx.t('nav.back')], limit: ctx.limit ?? MAX_RESPONSE_CHARS,
            render: (s, i) => `${i + 1}. ${clock(s.departure_at)} ${fcfa(s.availability.fare.amountMinor)}`,
          });
          const lines = page.items.map((s, i) =>
            `${i + 1}. ${clock(s.departure_at)} ${shortDate(s.departure_at)} ${fcfa(s.availability.fare.amountMinor)}`);
          return cont(screen({
            limit: ctx.limit ?? MAX_RESPONSE_CHARS,
            title: ctx.t('search.results'), lines,
            nav: [page.hasNext ? ctx.t('nav.more') : '', page.hasPrevious ? ctx.t('nav.previous') : '', ctx.t('nav.back')],
          }), {
            ...ctx.state, page: page.page,
            // Only identifiers and sequences are remembered. Price and capacity
            // are deliberately NOT cached: they are re-read before confirming.
            picks: page.items.map(s => ({ id: s.id, origin: s.origin, destination: s.destination })),
          });
        },
        async handle(ctx) {
          const picks = ctx.state.picks ?? [];
          const choice = Number(ctx.input);
          if (!Number.isInteger(choice) || choice < 1 || choice > picks.length) return ctx.invalid();
          return ctx.go('book', 'confirm', { ...ctx.state, service: picks[choice - 1] });
        },
      },
    },

    // One booking is one seat, because that is what the domain models — a hold
    // takes no seat count. Asking a USSD caller "how many places?" would be
    // offering a capability the product does not have; a second traveller makes
    // a second booking, exactly as on the web.
    book: {
      confirm: {
        async render(ctx) {
          // Identity is checked before the caller invests any more effort.
          if (!ctx.userId) {
            return end(screen({
              title: ctx.t(trustMsisdn ? 'book.signInRequired' : 'book.unverified'),
              lines: [ctx.t(trustMsisdn ? 'book.signInHint' : 'book.unverifiedHint')],
            }));
          }
          const { service } = ctx.state;
          // Re-read, never recalled: the price on the confirmation screen is
          // the one the domain reports at this instant, not the one that was
          // listed a few keypresses ago.
          const quote = await domain.availability(service.id, service.origin, service.destination);
          if (quote.available < 1) return end(screen({ title: ctx.t('error.SOLD_OUT'), lines: [ctx.t('search.none.hint')] }));
          return cont(screen({
            limit: ctx.limit ?? MAX_RESPONSE_CHARS,
            title: ctx.t('book.summary'),
            lines: ['1 place', `${ctx.t('pay.amount')} ${fcfa(quote.fare.amountMinor)}`, ctx.t('book.confirm'), ctx.t('book.cancel')],
            nav: [ctx.t('nav.back')],
          }), ctx.state);
        },
        async handle(ctx) {
          if (ctx.input === '2') return end(screen({ title: ctx.t('nav.cancelled') }));
          if (ctx.input !== '1') return ctx.invalid();
          return ctx.go('book', 'create', ctx.state);
        },
      },

      create: {
        async render(ctx) {
          const { service } = ctx.state;
          // The same hold the web app performs, through the same transaction
          // and the same segment-aware capacity check. The key is derived from
          // the session, so a gateway retry replays rather than books twice —
          // and its shape satisfies the domain's own key validation.
          const key = `ussd-${String(ctx.session.id).replace(/-/g, '')}-${String(service.id).replace(/-/g, '').slice(0, 8)}`;
          const booking = await domain.hold(ctx.actor, {
            serviceId: service.id, origin: service.origin, destination: service.destination,
          }, key);
          const reference = bookingReference(booking.id);
          return cont(screen({
            title: ctx.t('book.created'),
            lines: [`${ctx.t('book.reference')} ${reference}`, `${ctx.t('pay.amount')} ${fcfa(booking.amount_minor)}`,
              ctx.t('pay.now'), ctx.t('pay.later')],
          }), { ...ctx.state, bookingId: booking.id, reference }, { flow: 'pay', step: 'choice' });
        },
      },
    },

    pay: {
      choice: {
        async render(ctx) {
          return cont(screen({ title: ctx.t('pay.title'), lines: [ctx.t('pay.now'), ctx.t('pay.later')], nav: [ctx.t('nav.back')] }));
        },
        async handle(ctx) {
          if (ctx.input === '2') {
            return end(screen({ title: `${ctx.t('book.reference')} ${ctx.state.reference}`, lines: [ctx.t('pay.laterHint')] }));
          }
          if (ctx.input !== '1') return ctx.invalid();
          try {
            // Initiation only. A payment becomes "payé" when a verified
            // provider webhook says so, and never because a caller pressed 1.
            await payments.initiate(ctx.actor, ctx.state.bookingId, { channel: 'ussd' }, `ussd-pay:${ctx.session.id}`);
            return end(screen({ title: ctx.t('pay.initiated'), lines: [ctx.t('pay.initiatedHint'), `${ctx.t('book.reference')} ${ctx.state.reference}`] }));
          } catch {
            return end(screen({ title: ctx.t('pay.unavailable'), lines: [`${ctx.t('book.reference')} ${ctx.state.reference}`, ctx.t('error.retry')] }));
          }
        },
      },
    },

    bookings: {
      list: {
        async render(ctx) {
          if (!ctx.userId) {
            return end(screen({ title: ctx.t(trustMsisdn ? 'book.signInRequired' : 'book.unverified'),
              lines: [ctx.t(trustMsisdn ? 'book.signInHint' : 'book.unverifiedHint')] }));
          }
          const all = await domain.passengerBookings(ctx.actor);
          const open = all.filter(b => ['held', 'confirmed', 'boarded'].includes(b.status));
          if (!open.length) return end(screen({ title: ctx.t('bookings.none'), lines: [ctx.t('bookings.noneHint')] }));
          const page = paginate(open, {
            page: ctx.state.page ?? 0, title: ctx.t('bookings.title'), nav: [ctx.t('nav.back')], limit: ctx.limit ?? MAX_RESPONSE_CHARS,
            render: (b, i) => `${i + 1}. ${bookingReference(b.id)} ${clock(b.departure_at)}`,
          });
          const lines = page.items.map((b, i) => `${i + 1}. ${bookingReference(b.id)} ${shortDate(b.departure_at)} ${clock(b.departure_at)}`);
          return cont(screen({
            limit: ctx.limit ?? MAX_RESPONSE_CHARS,
            title: ctx.t('bookings.title'), lines,
            nav: [page.hasNext ? ctx.t('nav.more') : '', page.hasPrevious ? ctx.t('nav.previous') : '', ctx.t('nav.back')],
          }), { page: page.page, ids: page.items.map(b => b.id) });
        },
        async handle(ctx) {
          const ids = ctx.state.ids ?? [];
          const choice = Number(ctx.input);
          if (!Number.isInteger(choice) || choice < 1 || choice > ids.length) return ctx.invalid();
          return ctx.go('bookings', 'detail', { bookingId: ids[choice - 1] });
        },
      },

      detail: {
        async render(ctx) {
          const booking = await domain.booking(ctx.actor, ctx.state.bookingId);
          const payment = await payments.status(ctx.actor, ctx.state.bookingId).catch(() => null);
          return end(screen({
            title: `${ctx.t('book.reference')} ${bookingReference(booking.id)}`,
            lines: [
              `${ctx.t('journey.departure')} ${shortDate(booking.departure_at)} ${clock(booking.departure_at)}`,
              `${ctx.t('journey.status')} ${BOOKING_STATUS[booking.status] ?? booking.status}`,
              payment?.status ? `${ctx.t('pay.title')}: ${PAYMENT_STATUS[payment.status] ?? payment.status}` : '',
              booking.departure_point_name ? `${ctx.t('journey.boardingPoint')} ${booking.departure_point_name}` : '',
            ],
          }));
        },
      },
    },

    journey: {
      prompt: {
        async render(ctx) {
          return cont(screen({ title: ctx.t('journey.title'), lines: [ctx.t('journey.prompt')], nav: [ctx.t('nav.back')] }));
        },
        async handle(ctx) {
          if (!ctx.userId) return end(screen({ title: ctx.t('book.unverified'), lines: [ctx.t('book.unverifiedHint')] }));
          const all = await domain.passengerBookings(ctx.actor);
          const booking = all.find(b => matchesReference(b.id, ctx.input));
          if (!booking) return ctx.retry(ctx.t('journey.notFound'));
          return ctx.go('journey', 'detail', { bookingId: booking.id });
        },
      },

      detail: {
        async render(ctx) {
          const live = await tracking.forBooking(ctx.actor, ctx.state.bookingId).catch(() => null);
          const booking = await domain.booking(ctx.actor, ctx.state.bookingId);
          // No ETA is stated unless the tracking layer produced one. A
          // fabricated arrival time is worse than no arrival time.
          const eta = live?.eta?.at ? `${ctx.t('journey.eta')} ${clock(live.eta.at)}` : ctx.t('journey.etaUnavailable');
          return end(screen({
            title: `${bookingReference(booking.id)}`,
            lines: [
              `${ctx.t('journey.status')} ${SERVICE_STATUS[live?.serviceStatus ?? booking.service_status] ?? BOOKING_STATUS[booking.status] ?? ''}`,
              live?.nextStop ? `${ctx.t('journey.nextStop')} ${live.nextStop.city}` : '',
              eta,
            ],
          }));
        },
      },
    },

    parcel: {
      prompt: {
        async render(ctx) {
          return cont(screen({ title: ctx.t('parcel.prompt'), lines: [ctx.t('parcel.promptHint')], nav: [ctx.t('nav.back')] }));
        },
        async handle(ctx) {
          const reference = String(ctx.input).trim().toUpperCase();
          try {
            // The same public projection the web tracker uses: status, cities,
            // point names. Never a sender, a receiver or a pickup code.
            const parcel = await parcels.publicTracking(reference);
            return end(screen({
              title: `${ctx.t('parcel.title')} ${parcel.trackingNumber}`,
              lines: [
                `${ctx.t('parcel.route')} ${parcel.origin?.city ?? ''} - ${parcel.destination?.city ?? ''}`,
                `${ctx.t('parcel.status')} ${PARCEL_STATUS[parcel.status] ?? parcel.status}`,
              ],
            }));
          } catch { return ctx.retry(ctx.t('parcel.notFound')); }
        },
      },
    },

    help: {
      root: {
        async render(ctx) {
          return cont(screen({ title: ctx.t('help.title'),
            lines: [ctx.t('help.1'), ctx.t('help.2'), ctx.t('help.3'), ctx.t('help.4')], nav: [ctx.t('nav.back')] }));
        },
        async handle(ctx) {
          const topics = { 1: 'help.booking', 2: 'help.payment', 3: 'help.parcel', 4: 'help.contact' };
          const key = topics[ctx.input];
          return key ? end(screen({ title: ctx.t('help.title'), lines: [ctx.t(key)] })) : ctx.invalid();
        },
      },
    },

    locale: {
      root: {
        async render(ctx) {
          return cont(screen({ title: ctx.t('locale.title'), lines: [ctx.t('locale.fr'), ctx.t('locale.unavailable')], nav: [ctx.t('nav.back')] }));
        },
        async handle(ctx) {
          if (ctx.input !== '1') return ctx.invalid();
          return ctx.go('menu', 'root', {}, { locale: 'fr' });
        },
      },
    },
  };

  // ------------------------------------------------------------ plumbing ----
  const cont = (text, state, next) => ({ text, continues: true, state, next });
  const end = text => ({ text, continues: false, done: true });

  /** Renders a step, then any step it immediately hands off to. */
  async function renderStep(ctx, flow, step, guard = 0) {
    const definition = FLOWS[flow]?.[step];
    if (!definition) return end(screen({ title: ctx.t('error.generic'), lines: [ctx.t('error.retry')] }));
    const result = await definition.render({ ...ctx, flow, step });
    // A step like `book/create` performs its action and immediately becomes the
    // next screen; bounded so a definition mistake cannot loop forever.
    if (result.next && guard < 4) return { ...result, flow: result.next.flow, step: result.next.step };
    return { ...result, flow, step };
  }

  return {
    sessions,
    flows: FLOWS,

    /**
     * One provider callback in, one rendered screen out.
     *
     * Never throws: a USSD gateway given an error page shows the caller
     * nothing useful, so every failure becomes a short, honest end screen.
     */
    async handle({ provider, sessionId, msisdn, input, verified }) {
      const t = translator(config.defaultLocale ?? 'fr');
      try {
        if (!sessionId) return { text: enforceLimit(screen({ title: t('error.generic') })), continues: false };

        return await db.transaction(async tx => {
          const opened = await sessions.open(tx, { provider, sessionId, msisdn });
          let session = opened.session;

          if (!session) {
            if (await sessions.tooManySessions(tx, opened.phoneHash)) {
              return { text: enforceLimit(screen({ title: t('error.tooMany') })), continues: false };
            }
            session = await sessions.create(tx, { provider, sessionId, msisdn, verified });
            if (trustMsisdn && verified) await sessions.bindKnownPassenger(tx, { session, msisdn });
            session = (await tx.query('SELECT * FROM ussd_sessions WHERE id=$1', [session.id])).rows[0];
          }

          const fingerprint = requestFingerprint(session.id, session.steps, input ?? '');
          const replay = await sessions.replayed(tx, session.id, fingerprint);
          // A retried callback gets the first answer, byte for byte. It must
          // not book a second seat or start a second payment.
          if (replay) return { text: replay.response_text, continues: replay.continues, replayed: true };

          const locale = session.locale ?? 'fr';
          const localised = translator(locale);
          const state = session.state ?? {};
          const userId = session.user_id ?? null;
          const actor = userId ? { id: userId, role: 'passenger' } : null;

          let outcome;
          const base = { t: localised, session, state, userId, actor, input: String(input ?? '').trim() };

          // Navigation is handled once, centrally, so every screen behaves the
          // same way — a caller should never have to learn a per-screen rule.
          const control = base.input;
          const isFirstScreen = session.steps === 0;

          if (!isFirstScreen && control === QUIT) {
            await sessions.close(tx, session.id, 'cancelled');
            return { text: enforceLimit(screen({ title: localised('nav.goodbye') })), continues: false };
          }

          let flow = session.flow, step = session.step, nextState = state;

          if (isFirstScreen) {
            outcome = await renderStep({ ...base }, 'menu', 'root');
          } else if (control === BACK) {
            outcome = await renderStep({ ...base, state: {} }, 'menu', 'root');
            nextState = {};
          } else if (control === NEXT_PAGE || control === PREV_PAGE) {
            nextState = { ...state, page: Math.max(0, (state.page ?? 0) + (control === NEXT_PAGE ? 1 : -1)) };
            outcome = await renderStep({ ...base, state: nextState }, flow, step);
          } else {
            const definition = FLOWS[flow]?.[step];
            const ctx = {
              ...base,
              go: async (nextFlow, nextStep, stateForNext, extra = {}) => {
                const rendered = await renderStep({ ...base, state: stateForNext ?? {}, ...extra }, nextFlow, nextStep);
                return { ...rendered, carriedState: stateForNext ?? {}, extra };
              },
              // A notice re-renders the same screen with its own length already
              // reserved, so the options a caller needs survive the warning.
              retry: async message => {
                const room = MAX_RESPONSE_CHARS - gsmLength(message) - 1;
                const rendered = await renderStep({ ...base, limit: room }, flow, step);
                return { ...rendered, text: withNotice(rendered.text, message) };
              },
              invalid: async () => {
                const message = localised('nav.invalid');
                const room = MAX_RESPONSE_CHARS - gsmLength(message) - 1;
                const rendered = await renderStep({ ...base, limit: room }, flow, step);
                return { ...rendered, text: withNotice(rendered.text, message) };
              },
            };
            outcome = definition?.handle
              ? await definition.handle(ctx)
              : await renderStep(base, 'menu', 'root');
          }

          flow = outcome.flow ?? flow;
          step = outcome.step ?? step;
          // A screen's own returned state wins; otherwise the state it was
          // navigated with; otherwise what the session already held.
          nextState = outcome.state ?? outcome.carriedState ?? nextState;

          const text = enforceLimit(outcome.text);
          const continues = outcome.continues !== false && !outcome.done;

          await sessions.advance(tx, session.id, {
            flow, step, state: nextState, locale: outcome.extra?.locale ?? null,
          });
          if (!continues) await sessions.close(tx, session.id, 'completed');
          await sessions.remember(tx, session.id, fingerprint, { text, continues });
          return { text, continues };
        });
      } catch (error) {
        // Nothing internal ever reaches a handset. A failed backend is a short
        // sentence and a suggestion to try again, not a stack trace.
        const message = error?.code ? errorText(t, error) : t('error.generic');
        return { text: enforceLimit(screen({ title: message, lines: [t('error.retry')] })), continues: false };
      }
    },

    /** Expired sessions closed and old transcripts dropped. */
    sweep: options => db.transaction(tx => sessions.sweep(tx, options)),
  };
}

export { requestFingerprint };
