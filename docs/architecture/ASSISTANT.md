# LeRoutier Assistant

A polished, role-aware conversational assistant inside the canonical PWA. It
sits on the existing agentic architecture — it introduces no second chatbot
stack, no separate database and no direct LLM-to-database execution.

## Architecture

    message
      → deterministic intent routing (French keyword rules, services/api/src/assistant.js)
      → typed tool against existing domain services, with the CALLER's identity
        (the server resolves the actor; a message can never change who the caller is)
      → grounded French answer from a template
      → optionally re-phrased by the reasoning layer (`assistant.explain` in
        packages/agents/src/models/reasoning.js), which shares the SAME budget,
        duplicate suppression, audit and fallback rules as workflow triage

The model never chooses a tool, never computes a value (no fare, seat, ETA or
price ever comes from a model), never executes an action, and only ever sees
projected tool results — no names, phones, emails, coordinates, tokens or
pickup codes leave the server.

## Roles

- **Anonymous**: public surface only — departures, published fares, public
  parcel tracking, policy and support.
- **Passenger**: own bookings, payments, journey ETA, parcels.
- **Driver / convoyeur**: assigned service, incidents; no financial tools.
- **Company ops**: services, incidents, Fare Intelligence, own operator only.
- **Platform ops**: platform technical health (same gate as `/ops/health`).

## Tools (deterministic)

search_departures · get_booking_status · get_payment_status · get_journey_eta ·
get_parcel_status · get_fare_intelligence · get_service_status ·
get_incident_summary · get_operator_health_summary

Each validates input, uses the server-side actor for authentication, role and
operator boundaries, and returns minimal structured output. No tool accepts an
operator_id, user_id, booking_id or parcel_id from the message.

## Model usage

- Only for phrasing an explanation (`assistant.explain`), never for numbers or
  decisions. Gemini is the primary; OpenRouter free-tier fallback is allowed
  for this low-risk task; when both fail the assistant still answers from
  deterministic templates ("Je peux toujours consulter votre réservation…").
- The action risk model is untouched: the assistant has NO action-execution
  surface. Refunds, payouts, cancellations and role changes remain behind the
  existing approval gates and are never reachable through chat.

## Limits and audit

- Rate limited per identity or per client address (`request_limits`).
- Messages capped at 1 000 characters; session id validated.
- Every turn is audited in `assistant_events`: session, actor, role, intent,
  tools, outcome, provider and fallback — the message itself is stored only
  as a SHA-256 hash. Model calls are additionally recorded in
  `agent_model_calls` through the shared reasoning path.
- Conversation history lives in the current browser session only; nothing is
  persisted, so one user's history can never leak to another.

## UI

Floating launcher and mobile-first drawer in apps/web (`assistant.jsx`):
keyboard-operable, focus-trapped while open, Escape closes and restores focus,
polite live region for answers, offline and retry states, French-first. No
model names, provider fallbacks or internal architecture are ever shown.
