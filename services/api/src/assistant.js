// LeRoutier Assistant: role-aware, deterministic tools first, model phrasing
// second. This is not a generic bot and not a second stack:
//
//   message → deterministic intent routing (French keywords)
//          → typed tool against existing domain services, with the CALLER's
//            identity (roles and operator boundaries come from the server)
//          → grounded French answer from a template
//          → optionally re-phrased by the reasoning layer (assistant.explain),
//            which shares the same budget, audit and fallback rules
//
// The model never chooses a tool, never computes a value, never executes an
// action and never sees PII — tool results are projected before anything is
// handed to a provider. Anonymous callers get the public surface only.

import { createHash } from 'node:crypto';
import { invariant } from '@leroutier/domain';

const SUPPORT_EMAIL = 'leroutierbj@gmail.com';
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');

const MONEY = minor => `${Number(minor ?? 0).toLocaleString('fr-FR')} FCFA`;
const when = iso => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

// ---- deterministic intent rules ---------------------------------------------
// [name, matcher, capabilities] — a rule fires only when the caller's role is
// allowed by `roles` (null = everyone including anonymous).
// Intent matching must survive Unicode variance: mobile keyboards deliver
// decomposed accents (NFD) or plain ASCII, and some build/transport layers
// double-encode UTF-8 into mojibake (é -> Ã©). Both the message and the
// patterns are folded — known mojibake pairs repaired, accents stripped,
// non-ASCII removed — and matched a second time, so "départs", "departs",
// "départs" and any double-encoded form reach the same deterministic
// tool. The SQL tools underneath still match the canonical stored names.
const fold = s => [...String(s)
  .replace(/Ã©/g, 'é').replace(/Ã¨/g, 'è').replace(/Ã´/g, 'ô').replace(/Ã§/g, 'ç')
  .replace(/Ã /g, 'à').replace(/Ãª/g, 'ê').replace(/Ã®/g, 'î').replace(/Ã»/g, 'û')
  .replace(/Ã¹/g, 'ù').replace(/Ã«/g, 'ë').replace(/Ã¯/g, 'ï')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')]
  .filter(c => c.charCodeAt(0) < 128).join('');

/** @type {[string, RegExp, {roles: string[]|null}][]} */
const RULES = [
  ['trip_search', /(trajet|voyag(e|er)|départ|aller à|bus|car |horaire|route)/i, { roles: null }],
  ['booking_status', /(réservation|mes billets|mon billet|booking|billet)/i, { roles: null }],
  ['payment_status', /(paiement|payé|débité)/i, { roles: null }],
  ['journey_status', /(où est|position|avancement|suivi du voyage|progression|le bus)/i, { roles: null }],
  ['eta', /(arrivée|heure d'arrivée|quand arrive|retard)/i, { roles: null }],
  ['parcel_tracking', /(colis|parcel)/i, { roles: null }],
  ['fare_lookup', /(prix|tarif|combien coûte|coût)/i, { roles: null }],
  ['fare_intelligence', /(intelligence tarifaire|comparer|marché|suggér|tarif conseillé)/i, { roles: ['ops'] }],
  ['service_status', /(service|manifeste|équipage|véhicule|flotte)/i, { roles: ['ops', 'driver', 'convoyeur'] }],
  ['incident', /(incident|panne|accident)/i, { roles: ['ops', 'driver', 'convoyeur'] }],
  ['operator_health', /(santé (technique|de la plateforme)|plateforme (va|marche)|état technique)/i, { roles: null }],
  ['privacy_summary', /(quelles (données|informations)|données (sur moi|avez-vous)|mes données personnelles|politique de conservation)/i, { roles: null }],
  ['account_deletion', /(supprim(er|e) mon compte|suppression de mon compte|effacer mon compte|désinscrire)/i, { roles: null }],
  ['data_export', /(télécharger mes données|exporter mes données|export de (mes )?données)/i, { roles: null }],
  ['cancellation_policy', /(annul)/i, { roles: null }],
  ['refund_policy', /(rembours)/i, { roles: null }],
  ['support', /(aide|support|assistance|contact|réclamation)/i, { roles: null }],
];

const STOP_NAME = s => s.city ? `${s.name} (${s.city})` : s.name;

const POLICIES = {
  cancellation_policy: 'L’annulation dépend du statut de votre réservation et des règles affichées pour le service. Avant le départ, annulez depuis « Mes billets ». Un remboursement n’est jamais déclenché automatiquement par une instruction libre : chaque opération financière est validée par le système. Consultez la page « Annulations et remboursements » pour les règles détaillées.',
  refund_policy: 'Un remboursement est déterminé par les règles du service et la législation applicable, jamais par un simple message. Si votre paiement est en attente ou a échoué, écrivez à ' + SUPPORT_EMAIL + ' avec votre référence. N’envoyez jamais votre code OTP ou un secret de paiement.',
  support: 'Pour une aide humaine, écrivez à ' + SUPPORT_EMAIL + ' avec votre référence de réservation, de colis ou de paiement. Les réponses peuvent prendre du temps selon la demande ; ne transmettez jamais de mot de passe, de code OTP ou de secret de portefeuille.',
};

export function assistantService({ db, domain, parcels, fares, health, track = null, privacy = null }) {
  /** Every turn is audited; messages are stored only as a hash. */
  async function audit({ sessionId, actor, intent, tools, status, providerUsed = null, fallbackUsed = false, input }) {
    await db.transaction(async tx => {
      await tx.query(`INSERT INTO assistant_events(session_id,actor_id,role,intent,tools,status,provider_used,fallback_used,input_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [sessionId, actor?.id ?? null, actor?.role ?? 'anonymous', intent, JSON.stringify(tools), status, providerUsed, fallbackUsed, digest(input)]);
    }).catch(() => { /* audit failure must not fail the answer */ });
  }

  function actorRole(actor) {
    if (!actor) return 'anonymous';
    if (actor.role === 'driver' && actor.operator_type === 'independent') return 'driver';
    return actor.role ?? 'anonymous';
  }

  // ---- tools (deterministic, identity-bound, minimal structured output) -----
  async function toolTripSearch(_actor, query) {
    const stops = await db.transaction(async tx => (await tx.query(
      `SELECT s.id,s.name,p.name AS city FROM stops s JOIN places p ON p.id=s.place_id
       WHERE s.name ILIKE $1 OR p.name ILIKE $1 ORDER BY s.name LIMIT 5`, [`%${query.slice(0, 40)}%`])).rows);
    if (!stops.length) return { reply: `Je n’ai trouvé aucun arrêt correspondant à « ${query.slice(0, 40)} ». Essayez le nom d’une ville comme Cotonou, Bohicon, Dassa-Zoumè ou Parakou.`, data: null };
    if (stops.length === 1) {
      const origin = stops[0];
      // Departures from one stop, with the segment fare published for it.
      const services = await db.transaction(async tx => (await tx.query(
        `SELECT s.id,r.name AS route_name,s.departure_at,
          (SELECT ss.fare_minor FROM service_stops o JOIN service_segments ss ON ss.service_id=o.service_id AND ss.sequence=o.sequence
           WHERE o.service_id=s.id AND o.stop_id=$1 LIMIT 1) AS fare_minor
         FROM services s JOIN routes r ON r.id=s.route_id
         WHERE s.status IN ('scheduled','active') AND (s.departure_at>now() OR s.status='active')
           AND EXISTS(SELECT 1 FROM service_stops ss WHERE ss.service_id=s.id AND ss.stop_id=$1 AND ss.sequence>=s.current_sequence)
         ORDER BY s.departure_at LIMIT 5`, [origin.id])).rows);
      if (!services.length) return { reply: `Aucun départ programmé n’est publié depuis ${STOP_NAME(origin)} pour le moment.`, data: null };
      const lines = services.map(s => `• ${s.route_name} — départ ${when(s.departure_at)}${s.fare_minor !== null ? `, à partir de ${MONEY(s.fare_minor)}` : ''}`).join('\n');
      return { reply: `Départs publiés depuis ${STOP_NAME(origin)} :\n${lines}\nVérifiez les disponibilités dans l’application avant de réserver.`, data: null };
    }
    return { reply: `Arrêts correspondants : ${stops.map(STOP_NAME).join(' · ')}. Précisez votre départ et votre destination, par exemple « Cotonou vers Parakou ».`, data: null };
  }

  async function toolSearchBetween(_actor, match) {
    const names = [...match.matchAll(/vers|à partir de|depuis|de ([A-Za-zÀ-ÿ'-]+)|à ([A-Za-zÀ-ÿ'-]+)/gi)].map(m => (m[1] ?? m[2] ?? '').trim()).filter(Boolean);
    const [from, to] = names.length >= 2 ? [names[0], names[1]] : [names[0], null];
    if (!from) return null;
    const stops = await db.transaction(async tx => (await tx.query(
      `SELECT s.id,s.name,p.name AS city FROM stops s JOIN places p ON p.id=s.place_id
       WHERE s.name ILIKE $1 OR p.name ILIKE $1 ORDER BY s.name LIMIT 8`, [`%${from.slice(0, 40)}%`])).rows);
    if (!stops.length) return null;
    const result = [];
    const destinationId = to ? (stops.find(s => s.city?.toLowerCase() === to.toLowerCase())?.id ?? null) : null;
    if (!destinationId) return null;
    for (const origin of stops) {
      const services = await domain.search({ originStopId: origin.id, destinationStopId: destinationId }).catch(() => []);
      for (const s of services.slice(0, 3)) result.push({ route: s.route_name, departureAt: s.departure_at, fare: s.availability?.fare?.amountMinor ?? null, destination: s.destination });
    }
    if (!result.length) return { reply: `Aucun départ publié ne correspond pour le moment. Consultez l’onglet Voyager pour chercher d’autres horaires.`, data: null };
    const lines = result.slice(0, 5).map(s => `• ${s.route} — départ ${when(s.departureAt)}${s.fare !== null ? `, à partir de ${MONEY(s.fare)}` : ''}`).join('\n');
    return { reply: `Voici des départs publiés correspondant à votre recherche :\n${lines}\nLes places restantes et le tarif final sont confirmés dans l’application au moment de la réservation.`, data: null };
  }

  async function toolBookingStatus(actor) {
    const bookings = await domain.passengerBookings(actor);
    const active = bookings.filter(b => ['held', 'confirmed', 'boarded'].includes(b.status));
    if (!bookings.length) return { reply: 'Vous n’avez pas encore de réservation sur LeRoutier. Cherchez un trajet dans l’onglet Voyager pour réserver.', data: null };
    const lines = bookings.slice(0, 5).map(b => {
      const state = { held: 'en attente de paiement', confirmed: 'confirmée', boarded: 'en cours de voyage', completed: 'terminée', cancelled: 'annulée', expired: 'expirée' }[b.status] ?? b.status;
      return `• ${b.route_name} — ${when(b.departure_at)} : ${state}`;
    }).join('\n');
    return { reply: `Vos réservations récentes :\n${lines}\n${active.length === 1 && active[0].status === 'held' ? 'Votre réservation est en attente de paiement : payez dans « Mes billets » pour la confirmer.' : ''}`, data: null };
  }

  async function toolPaymentStatus(actor) {
    const bookings = await domain.passengerBookings(actor);
    if (!bookings.length) return { reply: 'Vous n’avez pas encore de réservation : il n’y a aucun paiement à vérifier.', data: null };
    const paid = bookings.filter(b => ['confirmed', 'boarded', 'completed'].includes(b.status));
    const unpaid = bookings.filter(b => b.status === 'held');
    let reply = `Sur vos ${bookings.length} réservations récentes : ${paid.length} payée(s) et confirmée(s)`;
    if (unpaid.length) reply += `, ${unpaid.length} en attente de paiement`;
    reply += '. Un paiement est confirmé uniquement après vérification du prestataire.';
    return { reply, data: null };
  }

  async function toolJourney(actor) {
    const bookings = await domain.passengerBookings(actor);
    const current = bookings.find(b => ['boarded', 'confirmed'].includes(b.status)) ?? bookings[0];
    if (!current) return { reply: 'Aucun voyage en cours. Réservez un trajet puis suivez-le depuis « Mes billets ».', data: null };
    let journey = null;
    if (track) { try { journey = await track.forBooking(actor, current.id); } catch { journey = null; } }
    if (!journey) return { reply: `Votre trajet ${current.route_name} est prévu à ${when(current.departure_at)}. Le suivi en direct s’active lorsque le véhicule transmet sa position.`, data: null };
    const eta = journey.eta;
    const progress = journey.nextStop ? `Prochain arrêt : ${journey.nextStop.name} (${journey.nextStop.city}).` : '';
    const etaLine = eta?.at ? `Arrivée estimée vers ${when(eta.at)}${eta.confidence === 'scheduled' ? ' (selon l’horaire prévu)' : eta.confidence === 'live' ? ' (d’après la position récente)' : ''}.` : 'L’heure d’arrivée estimée n’est pas disponible pour le moment.';
    return { reply: `Votre trajet ${current.route_name} : ${progress} ${etaLine}`, data: null };
  }

  async function toolParcel(actor, trackingRef) {
    if (!trackingRef) {
      if (actor?.role === 'passenger') {
        const parcelsList = await parcels.listMine(actor);
        if (!parcelsList.length) return { reply: 'Vous n’avez pas encore d’expédition de colis. Envoyez-en une depuis l’onglet Colis.', data: null };
        const lines = parcelsList.slice(0, 5).map(p => `• ${p.trackingNumber} — ${p.status}${p.serviceLevel === 'express' ? ' (express)' : ''}`).join('\n');
        return { reply: `Vos expéditions récentes :\n${lines}\nDonnez-moi un numéro de suivi (LRP-XXXXXXXX) pour l’état détaillé.`, data: null };
      }
      return { reply: 'Donnez-moi le numéro de suivi du colis (LRP-XXXXXXXX) pour retrouver son état.', data: null };
    }
    try {
      const p = await parcels.publicTracking(trackingRef);
      const state = { created: 'enregistré', accepted: 'accepté', manifested: 'manifesté', loaded: 'chargé', in_transit: 'en transit', arrived: 'arrivé à destination', ready_for_pickup: 'prêt au retrait', collected: 'retiré par le destinataire', cancelled: 'annulé', held: 'retenu', damaged: 'endommagé', lost: 'perdu' }[p.status] ?? p.status;
      return { reply: `Colis ${p.trackingNumber} : ${state}.${p.etaAt ? ` Arrivée prévue vers ${when(p.etaAt)}.` : ''}${p.status === 'ready_for_pickup' ? ' Il est prêt au retrait : présentez-vous avec le code remis au destinataire.' : ''}`, data: null };
    } catch { return { reply: 'Ce numéro de suivi ne correspond à aucun colis connu. Vérifiez qu’il commence par LRP- suivi de 8 caractères.', data: null }; }
  }

  async function toolFareIntelligence(actor) {
    if (actor.role !== 'ops' || !actor.operator_id) return { reply: 'L’intelligence tarifaire est réservée aux opérateurs vérifiés.', data: null };
    // The most recently published route corridor is the natural default.
    const routes = await db.transaction(async tx => (await tx.query(
      `SELECT r.id,rs.stop_id,lead(rs.stop_id) OVER (PARTITION BY rs.route_id ORDER BY rs.sequence) AS next_stop_id
       FROM routes r JOIN route_stops rs ON rs.route_id=r.id WHERE r.operator_id=$1 AND r.active=true ORDER BY r.created_at DESC LIMIT 1`, [actor.operator_id])).rows);
    if (!routes.length) return { reply: 'Publiez d’abord une ligne et ses tarifs (Administration du réseau), puis je pourrai comparer votre tarif au marché.', data: null };
    const segment = routes.find(r => r.next_stop_id);
    const rec = await fares.recommend({ originStopId: segment.stop_id, destinationStopId: segment.next_stop_id, fareType: 'passenger', ownOperatorId: actor.operator_id });
    if (rec.status === 'insufficient_data') return { reply: rec.message + ' Vos tarifs publiés alimentent cette comparaison dès maintenant.', data: null };
    const advice = { above: 'supérieur aux tarifs comparables', below: 'inférieur aux tarifs comparables', within_range: 'dans la fourchette typique' }[rec.advice];
    return { reply: `Sur votre première ligne : votre tarif est ${advice}. Fourchette typique : ${MONEY(rec.typicalRange[0])}–${MONEY(rec.typicalRange[1])}. Prix suggéré : ${MONEY(rec.suggestedPriceMinor)}. Vous restez seul décisionnaire du tarif final.`, data: null };
  }

  async function toolServiceStatus(actor) {
    const scope = actor.operator_id ? `($1::uuid IS NULL OR s.operator_id=$1)` : 'TRUE';
    const rows = await db.transaction(async tx => (await tx.query(`SELECT s.id,r.name AS route_name,s.status,s.departure_at,
        (SELECT count(*)::integer FROM bookings b WHERE b.service_id=s.id AND b.status IN ('confirmed','boarded')) AS onboard
      FROM services s JOIN routes r ON r.id=s.route_id
      WHERE ${scope} AND s.status IN ('scheduled','active','disrupted') ORDER BY s.departure_at LIMIT 5`, actor.operator_id ? [actor.operator_id] : [])).rows);
    if (!rows.length) return { reply: 'Aucun service programmé ou en cours pour votre périmètre.', data: null };
    const lines = rows.map(s => `• ${s.route_name} — départ ${when(s.departure_at)} · ${s.status === 'active' ? `${s.onboard} passagers à bord` : 'programmé'}`).join('\n');
    return { reply: `Services à venir :\n${lines}`, data: null };
  }

  async function toolIncidents(actor) {
    const scope = actor.operator_id ? `AND s.operator_id=$2` : '';
    const rows = await db.transaction(async tx => (await tx.query(`SELECT i.kind,i.severity,i.status,i.created_at,s.id AS service_id,r.name AS route_name
      FROM incidents i JOIN services s ON s.id=i.service_id JOIN routes r ON r.id=s.route_id
      WHERE i.status IN ('open','investigating') ${scope} ORDER BY i.created_at DESC LIMIT 5`, actor.operator_id ? [null, actor.operator_id] : [null])).rows);
    if (!rows.length) return { reply: 'Aucun incident ouvert sur votre périmètre.', data: null };
    const kind = { breakdown: 'panne', delay: 'retard', medical: 'médical', accident: 'accident', other: 'autre' };
    const lines = rows.map(i => `• ${i.route_name} : ${kind[i.kind] ?? i.kind} (${i.severity}) — ${i.status === 'open' ? 'ouvert' : 'en cours d’investigation'}`).join('\n');
    return { reply: `Incidents en cours :\n${lines}\nChaque incident est traité dans l’onglet Incidents, avec validation humaine pour toute action.`, data: null };
  }

  async function toolHealth(actor) {
    if (!(actor.role === 'ops' && !actor.operator_id)) return { reply: 'L’état technique détaillé est réservé aux opérations de la plateforme.', data: null };
    const h = await health.read(actor);
    const alerts = h.signals.reduce((s, x) => s + x.count, 0);
    return { reply: `État technique : base de données disponible, migrations ${h.migrations.matched ? 'à jour' : 'à vérifier'}. Notifications en échec : ${h.counts.notification_failed}. Événements à reprendre : ${h.counts.dispatch_dead}. Signaux opérationnels récents : ${alerts}.`, data: null };
  }

  // Privacy tools read the caller's own data through the same privacy domain
  // the privacy center uses. The assistant NEVER executes a deletion, export
  // or consent change — high-impact actions stay typed, confirmed UI flows.
  async function toolPrivacySummary(actor) {
    if (!privacy || !actor?.id) return { reply: 'Connectez-vous puis ouvrez « Confidentialité et données » dans votre compte : vous y verrez vos données et leur conservation. Je peux aussi vous répondre une fois connecté.', data: null };
    const summary = await privacy.summary(actor);
    const lines = summary.categories.filter(c => c.count > 0).map(c => `• ${c.category} : ${c.count}`).join('\n');
    const gps = summary.retention.find(r => r.data_category === 'raw_gps');
    const deletion = summary.deletion ? `Votre demande de suppression est « ${summary.deletion.status} ».` : 'Aucune demande de suppression en cours.';
    return { reply: `Voici les catégories de vos données dans LeRoutier :\n${lines}\n${deletion}${gps ? ` Les positions GPS brutes des services terminés sont conservées ${gps.retention_days} jours.` : ''}\nPour le détail complet, ouvrez « Confidentialité et données » dans Compte.`, data: null };
  }

  async function toolDeletionGuide(actor) {
    if (!privacy || !actor?.id) return { reply: 'Connectez-vous, puis ouvrez Compte → « Confidentialité et données » → « Supprimer mon compte ». La suppression suit un parcours sécurisé et vous explique ce qui est supprimé ou anonymisé, et ce qui doit être conservé pour des raisons légales ou comptables.', data: null };
    const status = await privacy.deletionStatus(actor);
    if (!status) return { reply: 'Vous pouvez demander la suppression depuis Compte → « Confidentialité et données » → « Supprimer mon compte ». Si vous avez un voyage actif, un colis en cours ou un paiement en attente, la suppression sera planifiée après leur clôture, sans casser vos réservations.', data: null };
    const states = { requested: 'reçue et en attente de traitement', scheduled: 'planifiée : elle attendra la clôture de vos voyages, colis ou paiements en cours', processing: 'en cours de traitement', completed: 'traitée', rejected_or_blocked: 'en attente d’examen' };
    const blockers = Array.isArray(status.blockers) && status.blockers.length ? ` Éléments en attente : ${status.blockers.map(b => ({ active_booking: 'réservation active', pending_payment: 'paiement en attente', active_parcel: 'colis en cours' })[b.kind] ?? b.kind).join(', ')}.` : '';
    return { reply: `Votre demande de suppression est ${states[status.status] ?? status.status}.${blockers}`, data: null };
  }

  async function toolExportGuide(actor) {
    if (!privacy || !actor?.id) return { reply: 'Connectez-vous, puis ouvrez Compte → « Confidentialité et données » → « Télécharger mes données ». L’export contient uniquement vos propres données et reste disponible 24 heures.', data: null };
    const summary = await privacy.summary(actor);
    return { reply: `Pour télécharger vos données, ouvrez Compte → « Confidentialité et données » → « Télécharger mes données ». Le fichier contient vos ${summary.categories.reduce((s, c) => s + c.count, 0)} enregistrements répartis entre ${summary.categories.filter(c => c.count > 0).length} catégories, jamais les données d’un autre utilisateur.`, data: null };
  }

  // ---- intent resolution ----------------------------------------------------
  function resolveIntent(message, actor) {
    const role = actorRole(actor);
    const foldedMessage = fold(message);
    for (const [name, pattern, { roles }] of RULES) {
      if (roles && !roles.includes(role)) continue;
      if (pattern.test(message)) return name;
      // The accented rules also match folded (accent-stripped, mojibake-
      // repaired) input — and a folded pattern matches a folded message, so
      // whichever side a transport/build layer corrupted, the intent still
      // resolves deterministically.
      const foldedPattern = new RegExp(fold(pattern.source), pattern.flags);
      if (foldedPattern.source !== pattern.source && foldedPattern.test(foldedMessage)) return name;
    }
    return 'unknown';
  }

  return {
    /**
     * One assistant turn. `actor` is the server-resolved identity or null for
     * anonymous callers; nothing in the message can change who the caller is.
     */
    async handle({ actor = null, sessionId, message, reasoning = null }) {
      invariant(typeof sessionId === 'string' && /^[\w-]{8,64}$/.test(sessionId), 'INVALID_INPUT', 'Session is invalid.');
      invariant(typeof message === 'string', 'INVALID_INPUT', 'A message is required.');
      invariant(message.length <= 1000, 'INVALID_INPUT', 'Message is too long.', 413);
      const text = message.trim();
      invariant(text.length >= 2, 'INVALID_INPUT', 'Message is too short.');
      const input = { actor: actor?.id ?? null, message: text };
      const role = actorRole(actor);
      const toolsUsed = [];

      const answer = async (intent, reply, status = 'answered', { providerUsed = null, fallbackUsed = false, explain = false } = {}) => {
        await audit({ sessionId, actor, intent, tools: toolsUsed, status, providerUsed, fallbackUsed, input });
        return { reply, intent, mode: explain ? 'model' : status === 'fallback' ? 'fallback' : 'deterministic', tools: toolsUsed };
      };

      const explainWithModel = async (intent, facts, question, fallbackReply) => {
        if (!reasoning) return answer(intent, fallbackReply, 'fallback', { fallbackUsed: true });
        const result = await reasoning.explain({ facts, question });
        if (result.available && result.text) return answer(intent, result.text, 'model_explained',
          { providerUsed: result.providerUsed ?? null, fallbackUsed: !!result.fallbackFrom, explain: true });
        return answer(intent, fallbackReply, 'fallback', { fallbackUsed: true });
      };

      // Policy answers need no tools and no model.
      for (const name of ['cancellation_policy', 'refund_policy', 'support']) {
        if (resolveIntent(text, actor) === name) return answer(name, POLICIES[name]);
      }
      // Asking for operator pricing insight without an ops identity is stated
      // plainly — the comparison is never shown to passengers.
      if (/(intelligence tarifaire|comparer|marché|suggér|tarif conseillé)/i.test(text) && role !== 'ops') {
        return answer('fare_intelligence', 'L’intelligence tarifaire est réservée aux opérateurs.', 'refused');
      }

      const intent = resolveIntent(text, actor);
      switch (intent) {
        case 'trip_search': {
          const between = await toolSearchBetween(actor, text);
          if (between) { toolsUsed.push('search_departures'); return answer(intent, between.reply); }
          const match = text.match(/(?:vers|depuis|à|au|de)\s+([A-Za-zÀ-ÿ'-]{2,})/i);
          const q = match?.[1] ?? text.replace(/[^A-Za-zÀ-ÿ'-]/g, ' ').split(' ').find(w => w.length > 3) ?? 'Cotonou';
          toolsUsed.push('search_departures');
          const r = await toolTripSearch(actor, q);
          return answer(intent, r.reply);
        }
        case 'fare_lookup': {
          toolsUsed.push('search_departures');
          const between = await toolSearchBetween(actor, text);
          if (between) return answer(intent, between.reply);
          return answer(intent, 'Donnez-moi votre départ et votre destination, par exemple « Quel est le prix de Cotonou vers Parakou ? » Le tarif affiché est le prix final que vous payez.');
        }
        case 'booking_status': {
          if (role !== 'passenger') return answer(intent, 'Connectez-vous en tant que voyageur pour consulter vos réservations.');
          toolsUsed.push('get_booking_status');
          const r = await toolBookingStatus(actor);
          return answer(intent, r.reply);
        }
        case 'payment_status': {
          if (role !== 'passenger') return answer(intent, 'Connectez-vous en tant que voyageur pour consulter vos paiements.');
          toolsUsed.push('get_payment_status');
          const r = await toolPaymentStatus(actor);
          return answer(intent, r.reply);
        }
        case 'journey_status':
        case 'eta': {
          if (role !== 'passenger') return answer(intent, 'Connectez-vous en tant que voyageur pour suivre votre voyage.');
          toolsUsed.push('get_journey_eta');
          const r = await toolJourney(actor);
          return answer(intent, r.reply);
        }
        case 'parcel_tracking': {
          const ref = text.match(/LRP-[0-9A-Fa-f]{8}/)?.[0] ?? null;
          toolsUsed.push('get_parcel_status');
          const r = await toolParcel(actor, ref);
          return answer(intent, r.reply);
        }
        case 'fare_intelligence': {
          if (role !== 'ops') return answer(intent, 'L’intelligence tarifaire est réservée aux opérateurs.', 'refused');
          toolsUsed.push('get_fare_intelligence');
          const r = await toolFareIntelligence(actor);
          return answer(intent, r.reply);
        }
        case 'service_status': {
          if (!['ops', 'driver', 'convoyeur'].includes(role)) return answer(intent, 'Connectez-vous avec votre espace de travail pour consulter les services.', 'refused');
          toolsUsed.push('get_service_status');
          const r = await toolServiceStatus(actor);
          return answer(intent, r.reply);
        }
        case 'incident': {
          if (!['ops', 'driver', 'convoyeur'].includes(role)) return answer(intent, 'Connectez-vous avec votre espace de travail pour consulter les incidents.', 'refused');
          toolsUsed.push('get_incident_summary');
          const r = await toolIncidents(actor);
          return answer(intent, r.reply);
        }
        case 'operator_health': {
          toolsUsed.push('get_operator_health_summary');
          const r = await toolHealth(actor);
          return answer(intent, r.reply);
        }
        case 'privacy_summary': {
          toolsUsed.push('get_privacy_summary');
          const r = await toolPrivacySummary(actor);
          return answer(intent, r.reply);
        }
        case 'account_deletion': {
          toolsUsed.push('get_deletion_request_status');
          const r = await toolDeletionGuide(actor);
          return answer(intent, r.reply);
        }
        case 'data_export': {
          toolsUsed.push('request_data_export_guide');
          const r = await toolExportGuide(actor);
          return answer(intent, r.reply);
        }
        default: {
          // Free-form question: the deterministic layer has no answer, so the
          // model may phrase one — grounded in public product facts only, and
          // never in PII. When the model is unavailable, an honest fallback.
          const facts = 'LeRoutier est une plateforme béninoise de transport interurbain routier et de colis : recherche de trajets, réservation en ligne, suivi GPS en direct, billetterie, colis standard et express, et outils d’exploitation pour compagnies et chauffeurs indépendants. Les tarifs affichés sont les prix finaux. Assistance : ' + SUPPORT_EMAIL + '.';
          return explainWithModel(intent, facts, text,
            'Je peux toujours consulter les départs, vos réservations et vos colis, mais l’assistant d’explication est temporairement indisponible. Pour une question précise, écrivez à ' + SUPPORT_EMAIL + '.');
        }
      }
    },
  };
}
