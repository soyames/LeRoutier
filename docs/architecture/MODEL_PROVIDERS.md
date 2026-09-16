# Model providers

How a language model helps LeRoutier, and — more importantly — what stops it
from running LeRoutier.

## What the model is for

Every task has the same shape, and that shape is the design:

```
deterministic code decides something is worth reasoning about
  → a projection builds a PII-free description of the situation
  → the model returns a classification and a suggested action
  → LeRoutier validates that suggestion against its own catalog
  → Ops sees a recommendation with its evidence
```

**The model is never the last step.** It does not execute, does not approve,
and never learns what a passenger is called.

Deterministic code keeps everything that must be right: capacity, fares,
payment state, payout eligibility, permissions, route geometry, state machines,
ETA arithmetic. The model does what code is bad at — prioritising, triaging,
and explaining a situation in a sentence an operator can act on.

## Providers

| Provider | Selected by | Use |
| --- | --- | --- |
| **Gemini Flash** | `AGENT_MODEL_PROVIDER=gemini` | **primary** remote reasoning |
| **OpenRouter** | `AGENT_MODEL_FALLBACK_PROVIDER=openrouter` | second chance, low-risk tasks only |
| **Local** (MiniCPM or any OpenAI-compatible server) | `AGENT_MODEL_PROVIDER=local` | evaluation on data that must not leave the machine |
| **None** | unset, or anything else | fully deterministic agents |

OpenRouter and the local server speak the OpenAI chat-completions shape, so that
transport is written once. Gemini speaks its own `generateContent` API, which is
worth the separate adapter: it is the one that can be told not to think.

**An unrecognised provider name selects nothing.** Sending an operational
situation to a third party because of a typo would be the worst possible
default.

**The fallback is named, never inferred.** An OpenRouter key sitting in the
environment is not consent to send situations there; only
`AGENT_MODEL_FALLBACK_PROVIDER` is.

| Variable | Meaning |
| --- | --- |
| `AGENT_MODEL_PROVIDER` | `gemini`, `openrouter`, `local`, or unset |
| `AGENT_MODEL_FALLBACK_PROVIDER` | same vocabulary; unset means no second chance |
| `GEMINI_AUTH_MODE` | `oauth` — the only implemented mode; see below |
| `GOOGLE_GEMINI_CLIENT_ID/_CLIENT_SECRET/_REFRESH_TOKEN` | the OAuth credential; server-side only |
| `GOOGLE_GEMINI_PROJECT_ID` | quota attribution (`x-goog-user-project`) |
| `GEMINI_MODEL` | default `gemini-3.6-flash`, verified against the free tier |
| `GEMINI_BASE_URL` | default `https://generativelanguage.googleapis.com/v1beta` |
| `OPENROUTER_API_KEY` | server-side only, never in a browser bundle |
| `OPENROUTER_BASE_URL` | default `https://openrouter.ai/api/v1` |
| `OPENROUTER_MODEL` | default `openrouter/free` |
| `OPENROUTER_APP_NAME`, `OPENROUTER_APP_URL` | attribution headers OpenRouter asks for |
| `LOCAL_MODEL_BASE_URL`, `LOCAL_MODEL_NAME` | a local server; no key required |
| `AGENT_MODEL_TIMEOUT_MS` | bounds the **whole** completion, retry ladder included |
| `AGENT_MODEL_DAILY_CALLS`, `AGENT_MODEL_WORKFLOW_DAILY_CALLS`, `AGENT_MODEL_DEDUP_HOURS` | usage ceilings |
| `AGENT_MODEL_COOLDOWN_MINUTES`, `AGENT_MODEL_FAILURES_BEFORE_COOLDOWN` | how long a refusing provider is left alone |
| `AGENT_TRIAGE_MIN_DELAY_MINUTES`, `AGENT_TRIAGE_MIN_STATIONARY_MINUTES` | the deterministic gate in front of triage |

None of these may ever be prefixed `VITE_` or placed on the PWA project. See
[`../operations/VERCEL.md`](../operations/VERCEL.md) — one public product does
not mean one security boundary. `pnpm secrets:check` fails if the string
`GOOGLE_GEMINI_` appears in any built bundle, because that would mean the server
configuration module reached the browser — the step before its values do.

## Gemini, and why OAuth

LeRoutier reaches Gemini through the **Developer API**
(`generativelanguage.googleapis.com`) with an **OAuth bearer token**.

Three things this deliberately is not:

- **Not Vertex AI.** Different host, and it requires a billing account. Billing
  on the Google project is disabled and must stay disabled, so Vertex is not
  reachable from this configuration at all — `pnpm model:verify` fails if the
  endpoint ever points at `aiplatform`.
- **Not an API key.** An API key is a permanent bearer secret that has to exist
  somewhere forever. A refresh credential mints access tokens that die in an
  hour and can be revoked from the Google account that granted them. There is
  no `GEMINI_API_KEY` and no `x-goog-api-key` path in the code.
- **Not the signed-in user's identity.** Firebase Authentication says who a
  *passenger* is. This OAuth credential is LeRoutier's own backend identity for
  reaching a model. The two never meet: no passenger's Google token is ever used
  to call Gemini, and no Gemini credential authenticates anybody.

`GEMINI_AUTH_MODE` exists to be checked rather than chosen. Any value other than
`oauth` withholds the credential and leaves the provider unconfigured, so
someone who sets it to `api_key` gets no model rather than a quietly different
trust model.

### The token manager

`models/google-oauth.js` mints an access token from the refresh credential and
keeps it in memory:

- refreshed **60 s before expiry**, because a token can die between the check
  and the request arriving;
- **concurrent callers share one refresh** — a cold serverless instance serving
  several events at once would otherwise send several identical refresh
  requests, and Google rate-limits the token endpoint per client;
- a failed refresh **clears the shared promise**, so the next caller retries
  rather than inheriting a rejection;
- a 401 on a previously-valid token **drops the cache and mints once more**,
  then gives up — revocation and rotation both look like this;
- failure is **closed**: no token means no call, never an unauthenticated one.

The token is never written to Neon, never logged, and never reaches the browser.
Nothing persists it, which is the point of a credential that expires anyway.

## What the free tier actually does

### Gemini

Measured against the live endpoint on the project's free tier, 2026-09-16:

| Observation | Consequence in the code |
| --- | --- |
| `gemini-3.6-flash` answered **3/3** attempts, median **1.7 s**, strict JSON every time | it is the default, and it is recorded as *verified*, not assumed |
| `gemini-3.7-flash`, `gemini-3.5-flash`, `gemini-flash-latest` answered **0/3** — all `503 UNAVAILABLE` | 503 is a routine shared-capacity state, not a fault; the fallback exists because of this |
| `gemini-2.5-flash` returns **404**: "no longer available to new users", pointing at `gemini-3.6-flash` | a model name is checked against the live tier before it ships, never copied from a prompt |
| `gemini-flash-lite-latest` rejects `thinkingConfig` with **400 INVALID_ARGUMENT**, and works without it | the last rung of the ladder sends no `thinkingConfig` at all |
| **429 `RESOURCE_EXHAUSTED`** after a handful of calls in quick succession | a quota error starts a cooldown; retrying into it spends the next window too |
| `thinkingBudget: 0` is honoured — **0 thought tokens** | thinking is switched *off*, not hidden, so there is no reasoning trace to mishandle |

Verify any change with `pnpm model:verify`, which sends one synthetic situation
— invented in the script, read from no database — and reports the model that
actually served it, the latency, and whether the answer survived validation.

### OpenRouter

`openrouter/free` is not a model. It is a router, and it behaves differently
from one request to the next. Measured against the live endpoint:

| Observation | Consequence in the code |
| --- | --- |
| A strict `json_schema` request can return **HTTP 200 with an empty body** | an empty success is treated as unusable, not as an answer |
| Served model varies per request — Nemotron 120B, Nemotron 550B, Gemma 26B | the model that *actually* answered is recorded; an evaluation that does not know is worth little |
| Some served models are **reasoning models** that narrate before answering | JSON is extracted from the text rather than assuming the whole string parses |
| Reasoning consumed the entire token budget and truncated the answer | `max_tokens` is 1200, and reasoning is asked to be brief and omitted |
| Latency ranged **6.5 s to 49 s** for the same prompt | one deadline bounds the whole operation |

### The ladder

Each provider asks for progressively less:

| | Gemini | OpenRouter / local |
| --- | --- | --- |
| 1 | `responseSchema` + JSON MIME + thinking off | strict `json_schema` |
| 2 | JSON MIME + thinking off | `json_object` |
| 3 | JSON MIME only | no format constraint |

It stops at the first usable object. **One deadline covers all three rungs.**
Three rungs at 20 s each would be a 60 s call, which outlives any serverless
budget. A bad credential, a rate limit or a timeout is never retried down the
ladder — only a refusal of that *request shape* is worth trying differently.

Gemini's `responseSchema` is a narrow OpenAPI subset: `toGeminiSchema()`
upper-cases types and **drops** keywords it rejects, such as
`additionalProperties` and `maxLength`. Passing them through turns a harmless
constraint into a 400. Nothing is lost, because `validateRecommendation()`
enforces length and shape again on the way back in, where the guarantee actually
has to hold.

### Extraction

Narration and code fences are stripped, then the first **balanced** object is
parsed. Scanning for balance rather than using a greedy regex is what lets a
brace inside a string value survive.

## What may leave, and what may come back

Two one-way valves, in `models/projection.js`.

**Projections are an allowlist, not a redaction pass.** A field nobody listed
cannot leak, however the caller assembles its data. `unsafeFields()` proves it
rather than trusting it, and is asserted in tests, so a projection cannot
quietly grow a leaky field later.

Never sent: passenger or crew names, phone numbers, emails, addresses, exact
coordinates, pickup codes, payment references, payout destinations, tokens, or
raw parcel party identity. Sent: statuses, durations, counts, and public place
labels — a city is printed on the ticket.

**The response is treated as hostile.** `validateRecommendation()` accepts only
a classification, a severity from a fixed set, a sanitised one-sentence reason,
and an action drawn from that task's own menu. A model can suggest; it cannot:

- **name an action into existence** — unknown names are rejected;
- **reach past its task** — `payout.execute` exists, is not on the triage menu,
  and is refused;
- **grant itself a scope** — the principal's scopes are checked server-side;
- **cross an operator boundary** — refused before the action is even read;
- **escape an approval gate** — a privileged action still requires a human.

`none` is a first-class answer. A model that must always recommend something
will always recommend something.

### Task menus

| Task | May propose |
| --- | --- |
| `incident.triage` | `alert.create`, `recovery.propose` (mutates nothing), `notification.send`, `none` |
| `parcel.triage` | `parcel.notify`, `parcel.escalate`, `alert.create`, `none` |

Assigning a vehicle, reconciling a payment and executing a payout are absent
from every menu.

## Prompt injection

System policy and untrusted content travel in **separate turns**. Task data is
never interpolated into the system prompt, so content cannot rewrite policy.

The structural defence matters more than the prompt: there is no free-form
command path, so an injected instruction has nothing to call. An event payload
carrying `"action":"payout.execute"` and a persuasive note changes nothing.

## Cost control

Free capacity is shared and exhaustible, and the API is serverless — so an
in-process counter would enforce nothing. Usage lives in `agent_model_calls`,
where every instance can see it.

- **Daily ceiling** and a **per-workflow daily ceiling**, so one runaway
  workflow cannot drain the budget for everything else.
- **Duplicate suppression**: the same situation within the window reuses the
  previous conclusion instead of paying for it twice.
- **Cooldown**: a `429` puts that provider down for `AGENT_MODEL_COOLDOWN_MINUTES`,
  and three consecutive hard failures do the same. A model answering *badly*
  never trips it — that is the model's fault, not the provider being down. The
  window is per serverless instance, which is the honest limit of doing this
  without another shared store; it still removes the retry storm inside one
  instance, which is where a single event fanning out produces it.
- **The model is never called on routine events** — not per GPS update, per
  booking, per scan, per payment callback or per notification. Deterministic
  logic identifies a reasoning-worthy case first.

What is stored: provider that *answered*, the provider it fell back from, task,
requested and actual model, status, latency, a **hash** of the input, and the
validated recommendation. What is not stored: the prompt, the completion text,
any reasoning trace, or any party data.

## When it fails

Every failure path degrades to **no recommendation**. `recommend()` never
throws for a model problem, because its caller is deterministic operational
code that must proceed exactly as it did before this feature existed.

A test holds a booking through payment to confirmation while the provider
throws on every call: **model availability must never gate a core journey.**

### Falling back

Fallback is **per request and opt-in**. A task asks for it (`allowFallback`),
and only tasks whose worst outcome is a missing suggestion ever do. Both triage
tasks qualify: the result is a sentence shown to a human who can ignore it.

Nothing financial and nothing authoritative may fall back. The point of a second
provider is that Ops still gets a hint when the first is out of quota — not that
a decision gets made by whoever happened to answer. Which provider answered is
recorded, because a recommendation is worth less when it came from the model
nobody evaluated.

| Reason | Meaning |
| --- | --- |
| `not_configured` | no provider — a supported production state, not a degraded one |
| `timeout` | the deadline passed; operations continue |
| `rate_limited`, `unauthorized` | reachable but refusing; Ops can tell this from an outage |
| `malformed_output` | nothing usable after the full ladder |
| `budget_exceeded` | the ceiling did its job |

No key, header or provider payload reaches an error, a log, or a response.

## Operating it

| Endpoint | Who | Cost |
| --- | --- | --- |
| `GET /api/v1/ops/model-usage` | operator Ops | free — no network call, safe to poll |
| `POST /api/v1/ops/model-health` | **platform** Ops only | one tiny completion |

Health is platform-only and rate limited precisely because it spends quota: an
operator admin must not be able to drain the shared budget by refreshing a
dashboard.

## The one workflow that asks a model anything

`incident-triage` in `packages/agents/src/workflows.js`, triggered by
`incident.created`, running at **`recommend`** autonomy:

```
gather  (reads)   deterministic facts from the database
                  → a deterministic threshold decides it is abnormal
triage  (reads)   the PII-free projection goes to the model
                  → the answer is validated against the action catalog
surface (mutates) an Ops alert carrying the recommendation and its evidence
                  → gated: a human releases it
```

The gate in `gather` is the important part. A model is asked only when
deterministic code already considers the situation abnormal — a breakdown,
accident or medical incident, or a delay past `AGENT_TRIAGE_MIN_DELAY_MINUTES`,
or a vehicle stationary past `AGENT_TRIAGE_MIN_STATIONARY_MINUTES` — **and** the
service is actually carrying passengers or parcels. An incident nobody is
waiting on never reaches a model at all.

The recommendation is never executed. `surface` creates an alert whose text is
labelled as a suggestion; the proposed action is *displayed*, not run. At
`recommend` autonomy even that alert waits for Ops.

`breakdown-recovery` and `parcel-breakdown` react to the same event and never
consult a model, so a model that is slow, absent, over quota or wrong changes
nothing about what LeRoutier actually does.

An outbox-driven run has no agent principal, so there are no granted scopes to
check a proposal against. `reasoning.scopesFor()` supplies the task allowlist
instead — what contains a system run is the menu (narrower than the catalog),
the operator boundary, and the approval gate. A *bound agent* asking still
presents its own scopes, and those are still checked.

## Testing

No test spends real quota. Every provider call in the suite goes through an
injected fetch, and `packages/agents/tests/gemini.test.js` replaces
`globalThis.fetch` with a function that throws — so a code path that fell
through to the real network fails the suite loudly rather than quietly spending
free quota. **CI never contacts Google or OpenRouter**, and has no credentials
for either.

The live tier's quirks above are each covered by a test written *from the
observed behaviour*, not from imagination.
