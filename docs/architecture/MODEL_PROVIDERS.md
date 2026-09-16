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
| **OpenRouter** | `AGENT_MODEL_PROVIDER=openrouter` | production remote reasoning |
| **Local** (MiniCPM or any OpenAI-compatible server) | `AGENT_MODEL_PROVIDER=local` | evaluation on data that must not leave the machine |
| **None** | unset, or anything else | fully deterministic agents |

Both speak the OpenAI chat-completions shape, so the transport is written once.

**An unrecognised provider name selects nothing.** Sending an operational
situation to a third party because of a typo would be the worst possible
default, so there is no fallback to a remote provider.

| Variable | Meaning |
| --- | --- |
| `AGENT_MODEL_PROVIDER` | `openrouter`, `local`, or unset |
| `OPENROUTER_API_KEY` | server-side only, never in a browser bundle |
| `OPENROUTER_BASE_URL` | default `https://openrouter.ai/api/v1` |
| `OPENROUTER_MODEL` | default `openrouter/free` |
| `OPENROUTER_APP_NAME`, `OPENROUTER_APP_URL` | attribution headers OpenRouter asks for |
| `LOCAL_MODEL_BASE_URL`, `LOCAL_MODEL_NAME` | a local server; no key required |
| `AGENT_MODEL_TIMEOUT_MS` | bounds the **whole** completion, retry ladder included |
| `AGENT_MODEL_DAILY_CALLS`, `AGENT_MODEL_WORKFLOW_DAILY_CALLS`, `AGENT_MODEL_DEDUP_HOURS` | usage ceilings |

None of these may ever be prefixed `VITE_` or placed on the PWA project. See
[`../operations/VERCEL.md`](../operations/VERCEL.md) — one public product does
not mean one security boundary.

## What the free tier actually does

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

A completion tries, in order: strict schema → JSON hint → no format constraint.
It stops at the first usable object.

**One deadline covers all three.** Three rungs at 20 s each would be a 60 s
call, which outlives any serverless budget. A bad key, a rate limit or a
timeout is never retried down the ladder — only a refusal of that *request
shape* is worth trying differently.

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
- **The model is never called on routine events** — not per GPS update, per
  booking, per scan, per payment callback or per notification. Deterministic
  logic identifies a reasoning-worthy case first.

What is stored: provider, task, requested and actual model, status, latency, a
**hash** of the input, and the validated recommendation. What is not stored:
the prompt, the completion text, or any party data.

## When it fails

Every failure path degrades to **no recommendation**. `recommend()` never
throws for a model problem, because its caller is deterministic operational
code that must proceed exactly as it did before this feature existed.

A test holds a booking through payment to confirmation while the provider
throws on every call: **model availability must never gate a core journey.**

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

## Testing

No test spends real quota. Every provider call in the suite goes through an
injected fetch — a suite that depends on a third party being up and generous
fails for reasons unrelated to the code. CI never contacts OpenRouter.

The live tier's quirks above are each covered by a test written *from the
observed behaviour*, not from imagination.
