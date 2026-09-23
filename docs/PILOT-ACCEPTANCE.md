# Physical acceptance tests

Things that can only be learned by holding a phone in a station in Benin.

**Nothing in this file has been performed.** Every row reads `NOT RUN` on
purpose and must stay that way until somebody has actually done the test. A row
marked `PASS` without evidence is worse than a row left untouched: it converts
an unknown into a false certainty, and the whole point of this file is to keep
track of which is which.

Fill in **Status**, **Actual · evidence**, and **Blocker** where one exists.

| Status | Means |
|---|---|
| `NOT RUN` | nobody has attempted it |
| `PASS` | performed, matched the expectation, evidence recorded |
| `FAIL` | performed, did not match — including "attempted and inconclusive" |
| `BLOCKED` | could not be attempted; the reason goes in Blocker |

Evidence is a photo, a screen recording, a tracking number, a booking id, or a
note naming who did it and when.

## The minimum pilot gate

These rows must read `PASS` before LeRoutier carries a paying passenger. They
are the subset where a failure puts somebody at a roadside, out of pocket, or
holding a ticket nobody can honour. Everything else in this file improves the
product; these decide whether it may run at all.

| Gate | Row |
|---|---|
| A ticket can be checked phone to phone | 1.1 |
| A used ticket cannot be reused | 1.2 |
| A ticket for another departure is refused | 1.3 |
| Boarding works with no signal, and replays exactly once | 4.2 |
| The driver's position is acquired, and recovered after loss | 2.2, 2.4 |
| A seat freed by alighting is bookable again | 2.8 |
| Capacity is correct across a multi-stop service | 2.9 |
| A passenger can see their own ticket on their own phone | 1.13 |
| A real payment is confirmed end to end | `PAYMENT-GO-LIVE.md` 1.1–1.8 |
| An operator is onboarded, reviewed and published | 5.1, 5.4, 5.7 |
| A reviewer can open a submitted document | 5.3 |
| A crew phone survives a departure | 4.4 |
| A parcel is handed off phone-to-phone | 3.1 |
| A parcel is accepted and custody recorded | 3.3 |
| A recipient is told their parcel is ready | 3.7 |
| A parcel is collected with the right code | 3.8 |

If parcels are part of the first pilot, add **3.1, 3.3, 3.7, 3.8**. If they are
not, say so explicitly rather than leaving the parcel section ambiguous.

**Decision (2026-09-23): parcels ARE part of the first pilot.** Rows **3.1,
3.3, 3.7, 3.8** join the minimum pilot gate below. None has been physically
performed yet.

**Do not claim pilot readiness while any gate row is `NOT RUN`.**

## What is already proven without a device

These hold in the automated suite and do not need a physical test. They are
listed so the physical session can concentrate on what only a device can
answer.

- The camera opens only when somebody presses the button, and is released on
  stop, on backgrounding, and on leaving the screen.
- A torch control appears only where the device reports a torch.
- A code that is not ours is explained and the camera keeps looking.
- The manual reference fallback is present on every scanning screen.
- Crew controls are at least 40px tall at 390px wide.
- A queued offline action is visible without printing the passenger's code.
- Wrong service, wrong stop, already boarded, expired and unpaid tickets are
  each refused by the server with their own message.
- A parcel QR is not the recipient's identity; pickup needs a separate code,
  and that code is rate-limited per parcel.
- KYC evidence is held privately, each reviewer grant expires, and a redaction
  really deletes the object. See `docs/KYC-EVIDENCE-STORAGE.md`.

Proven by the 2026-09-23 field-validation pass (commit `c5fd68c` and its
parents; every claim is an automated test, listed in the evidence map below):

- A foreign QR really decoded from the camera stream is explained and the
  camera keeps looking (`tests/e2e/field-readiness.spec.js`).
- A denied camera names the manual fallback, and granting the permission
  afterwards revives the scanner without reinstalling or signing in.
- A torch control appears only where the camera reports one, and toggles.
- An expired ticket is refused with the invalidation message; the manual code
  answers the same rule (`services/api/tests/test-profiles.test.js`).
- A reused idempotency key with a different payload is refused with
  `IDEMPOTENCY_CONFLICT`, never double-applied.
- Queued crew actions replay by themselves when the app reopens with a
  connection, and when the signal returns; expired queued rows are dropped
  from storage with their ticket codes (`packages/config/tests/auth-config.test.js`).
- A 401 mid-replay returns the action to pending and names reconnection; three
  failed attempts park it visibly and retry resets it.
- GPS fixes captured without signal are buffered and flushed on reconnect;
  a device with no usable position says so (`tests/e2e/tracking.spec.js`).
- Boarding changes no capacity; alighting frees exactly the downstream
  segments; an idempotent hold replay never writes a second set of segment
  rows (`packages/domain/tests/capacity.test.js`,
  `packages/database/tests/capacity.test.js`).
- The journey planner and the trip screen share one freshness definition:
  search never calls a fix live that tracking would call delayed
  (`packages/database/tests/journey-planning.test.js`).
- A screen whose lazy chunk fails mid-load keeps the shell and navigation
  alive and recovers through a reload (`apps/web/src/App.jsx`,
  `tests/e2e/field-readiness.spec.js`).
- No ticket code stays on screen after signing out on a shared handset.

## Automated evidence map

Automated tests support a row; they never perform it. A row stays `NOT RUN`
until a human holds the device.

| Row | Automated evidence (2026-09-23 pass) |
|---|---|
| 1.1–1.6, 1.12 | `services/api/tests/test-profiles.test.js` (verify + board + replay + expiry + conflict), `packages/database/tests/*.test.js`, `tests/e2e/roles.live.spec.js` |
| 1.7–1.11 | decoder exercised against real QR renders only; optics untested |
| 1.13 | `tests/e2e/field-readiness.spec.js` (ticket QR visible, cleared on sign-out) |
| 1.14–1.16 | `tests/e2e/field-readiness.spec.js` (denied/restored camera, background release, foreign QR) |
| 2.2–2.4 | `tests/e2e/tracking.spec.js` (granted, denied, unavailable, offline buffer + flush) |
| 2.8–2.9 | `packages/domain/tests/capacity.test.js`, `packages/database/tests/capacity.test.js` (segment model, alighting release, concurrency) |
| 3.4 | `packages/database/tests/parcels.test.js` (scan replay never duplicates custody), offline queue tests |
| 4.2–4.3, 4.12–4.13 | `tests/e2e/field-readiness.spec.js` (queue visible, restart replay, reconnect replay), `packages/config/tests/auth-config.test.js` (TTL, relogin, retry) |
| 5.1–5.12 | `packages/database/tests/verification.test.js`, `onboarding.test.js`, `platform-access.test.js`, `privacy.test.js` |
| 6 | `docs/PAYMENT-GO-LIVE.md` rows remain the authority |

## Devices

Record what was actually used. An Android mid-range phone on a real Beninese
mobile network is the target; anything else is a weaker signal. At least one
low-end device (2 GB RAM or less, Android 9 or older) must appear here, because
that is what crew will actually be holding.

| Role | Device | OS / browser | RAM | Network | Notes |
|---|---|---|---|---|---|
| Passenger phone | | | | | |
| Crew phone (mid-range) | | | | | |
| Crew phone (low-end) | | | | | |
| Station / Ops | | | | | |

## 1. Ticket QR, phone to phone

The passenger holds up their ticket; the crew scan it from the crew phone.

*Prerequisites: a confirmed booking on a published departure; crew signed in on
the crew phone; passenger signed in on their own.*

| # | Test | Role · device | Environment | Expected | Status | Actual · evidence | Blocker |
|---|---|---|---|---|---|---|---|
| 1.1 | Scan a valid ticket | crew · mid-range | daylight, outdoors | seat and passenger name shown, boarding confirmable | NOT RUN | | |
| 1.2 | Scan the same ticket again | crew · mid-range | daylight | refused: already boarded | NOT RUN | | |
| 1.3 | Scan a ticket for another departure | crew · mid-range | daylight | refused: wrong service | NOT RUN | | |
| 1.4 | Scan at a stop the passenger did not book | crew · mid-range | daylight | refused: wrong stop | NOT RUN | | |
| 1.5 | Scan a cancelled ticket | crew · mid-range | daylight | refused: invalid or replaced | NOT RUN | | |
| 1.6 | Scan a ticket revoked after issue | crew · mid-range | daylight | refused, and the reason names revocation | NOT RUN | | |
| 1.7 | Scan at dusk, passenger screen at low brightness | crew · mid-range | ~18:30 | reads, or torch makes it read | NOT RUN | | |
| 1.8 | Scan in a dark station | crew · mid-range | after dark | torch appears and helps | NOT RUN | | |
| 1.9 | Scan in the dark on a device with no torch | crew · low-end | after dark | no torch control offered; manual code works | NOT RUN | | |
| 1.10 | Scan through a cracked or matte screen protector | crew · any | any | reads, or manual code used | NOT RUN | | |
| 1.11 | Passenger phone in strong sun | crew · any | midday | reads, or manual code used | NOT RUN | | |
| 1.12 | Manual code entry instead of scanning | crew · any | any | same result as a scan | NOT RUN | | |
| 1.13 | Passenger opens their own ticket | passenger · own phone | any | ticket visible, QR legible, works offline once opened | NOT RUN | | |
| 1.14 | Deny camera permission, then board | crew · any | any | message names the manual fallback, boarding still possible | NOT RUN | | |
| 1.15 | Grant camera permission afterwards | crew · any | any | scanning starts working without reinstalling or signing in again | NOT RUN | | |
| 1.16 | Switch apps mid-scan and return | crew · any | any | camera released, no recording indicator while away, resumes cleanly | NOT RUN | | |
| 1.17 | Scan on the low-end phone | crew · low-end | daylight | decodes within a few seconds; app does not reload mid-session | NOT RUN | | |

## 2. Trip operations and position

The part no test can fake: a vehicle moving through the country, on a network
that comes and goes.

*Prerequisites: a published multi-stop departure with at least three stops and
at least two passengers booked on different segments.*

| # | Test | Role · device | Environment | Expected | Status | Actual · evidence | Blocker |
|---|---|---|---|---|---|---|---|
| 2.1 | Driver goes on duty | driver · mid-range | station | service shows as active, crew tools available | NOT RUN | | |
| 2.2 | Grant location permission and acquire a fix | driver · mid-range | outdoors | position appears; first fix time noted | NOT RUN | | |
| 2.3 | Deny location permission | driver · mid-range | outdoors | the product says what is lost and does not pretend to track | NOT RUN | | |
| 2.4 | Lose position (tunnel, dense cover) and regain it | driver · mid-range | en route | stale position is marked stale, not shown as current; recovers without restarting | NOT RUN | | |
| 2.5 | Drive with no data for 20 minutes | driver · mid-range | between towns | no crash, no silent loss; positions queue or are dropped honestly | NOT RUN | | |
| 2.6 | Arrive at an intermediate stop | driver · mid-range | roadside stop | stop marked reached; passengers for that stop are listed | NOT RUN | | |
| 2.7 | Board a passenger at an intermediate stop | crew · mid-range | roadside stop | boarding accepted for that segment only | NOT RUN | | |
| 2.8 | Alight a passenger, then sell that seat onward | crew · mid-range | roadside stop | the freed seat becomes bookable for the remaining segments | NOT RUN | | |
| 2.9 | Book the last seat on one segment | passenger · own phone | any | other segments still sellable; the full leg is not oversold | NOT RUN | | |
| 2.10 | Watch the ETA during the journey | passenger · own phone | en route | it changes as the vehicle moves, or says it cannot | NOT RUN | | |
| 2.11 | Complete the service | driver · mid-range | destination | service closes; revenue visible to whoever owns it | NOT RUN | | |
| 2.12 | Whole departure with no GPS at all | driver · low-end | en route | the journey still works; nothing claims a position it does not have | NOT RUN | | |

## 3. Parcel handoff

Full lifecycle with a real parcel, from a sender who has no printer.

*Prerequisites: a published departure, a real package, a recipient reachable at
the destination. Skip this section only if parcels are out of scope for the
first pilot — and record that decision.*

**Parcels are in scope for the first pilot (decision 2026-09-23).** Rows 3.1,
3.3, 3.7 and 3.8 are part of the minimum pilot gate.

| # | Test | Role · device | Environment | Expected | Status | Actual · evidence | Blocker |
|---|---|---|---|---|---|---|---|
| 3.1 | Sender shows the QR on their own phone | sender · own phone | station | crew scan it, no printing needed | NOT RUN | | |
| 3.2 | Crew read the handwritten LRP reference instead | crew · mid-range | station | resolves to the same parcel | NOT RUN | | |
| 3.3 | Accept and load | crew · mid-range | station | custody recorded, sender sees the status change | NOT RUN | | |
| 3.4 | Handoff while the signal drops | crew · mid-range | station, weak coverage | the handoff is not lost; it queues and completes once | NOT RUN | | |
| 3.5 | Departure scan | crew · mid-range | station | status advances | NOT RUN | | |
| 3.6 | Arrival scan at destination | crew · mid-range | destination | status advances | NOT RUN | | |
| 3.7 | Station marks ready for pickup | station · any | destination | recipient is told through the channels that exist | NOT RUN | | |
| 3.8 | Recipient collects with the correct code | station · any | destination | collected; proof of delivery recorded | NOT RUN | | |
| 3.9 | Someone presents the parcel QR but no code | station · any | destination | refused — the QR is not identity | NOT RUN | | |
| 3.10 | Wrong pickup code | station · any | destination | refused, attempt counted | NOT RUN | | |
| 3.11 | Wrong code eleven times | station · any | destination | locked; a new code must be issued | NOT RUN | | |
| 3.12 | Collect a second time | station · any | destination | refused | NOT RUN | | |
| 3.13 | Public tracking by reference only | anyone · any phone | any | status and city, no names or phone numbers | NOT RUN | | |

## 4. Device and field conditions

| # | Test | Role · device | Environment | Expected | Status | Actual · evidence | Blocker |
|---|---|---|---|---|---|---|---|
| 4.1 | Board five passengers in a row | crew · mid-range | station, queue waiting | no scan takes more than a few seconds | NOT RUN | | |
| 4.2 | Lose signal, board three, regain signal | crew · mid-range | edge of coverage | queued, then replayed exactly once, no duplicates | NOT RUN | | |
| 4.3 | Work an entire departure offline | crew · mid-range | no coverage | every action queues and syncs | NOT RUN | | |
| 4.4 | Crew phone from 100% through a full departure | crew · mid-range | real journey | reaches the destination usable; battery drop recorded | NOT RUN | | |
| 4.5 | Crew phone at 10% battery, one hour of scanning | crew · any | station | still usable; camera not left running | NOT RUN | | |
| 4.6 | Read the screen in direct sunlight | crew · any | midday | states and buttons legible | NOT RUN | | |
| 4.7 | Screen wet or dirty | crew · any | rain or dusty station | taps still register, or the failure is obvious rather than silent | NOT RUN | | |
| 4.8 | Sign out on a shared station handset | station · any | station | next person sees nothing of the previous one | NOT RUN | | |
| 4.9 | Slow 3G, first load | passenger · any | real network | app usable; note the time to first search | NOT RUN | | |
| 4.10 | Install as a PWA from the browser | passenger · mid-range | any | installs, launches from the home screen, branded LeRoutier | NOT RUN | | |
| 4.11 | Open the installed PWA with no connectivity | passenger · mid-range | airplane mode | shell loads; what needs the network says so | NOT RUN | | |
| 4.12 | Background the app for an hour, then resume | crew · any | station | resumes without losing queued work or signing out unexpectedly | NOT RUN | | |
| 4.13 | Low-memory device under pressure | crew · low-end | station, other apps open | the app is not killed mid-boarding, or recovers with the queue intact | NOT RUN | | |
| 4.14 | Audio or haptic confirmation on a successful scan | crew · any | noisy station | crew can tell a scan succeeded without reading the screen, or we learn they cannot | NOT RUN | | |
| 4.15 | Driver reports an incident while stopped | driver · any | roadside | one tap, no typing, confirmation visible | NOT RUN | | |

## 5. Platform Ops and a real operator

Cannot be simulated. A real transport operator, their real documents, their
real vehicle.

**Private evidence storage is now configured** — Backblaze B2, private bucket,
EU region, expiring reviewer grants, real deletion. An operator's documents are
held by LeRoutier and access is revocable, so real identity documents may be
submitted in this section. That was not true before 2026-09-22 and the earlier
warning in this file has been removed. See `docs/KYC-EVIDENCE-STORAGE.md`.

*Prerequisites: a platform identity holding `verification`; an operator who has
not used the product before; their real registration and insurance documents.*

| # | Test | Role · device | Expected | Status | Actual · evidence | Blocker |
|---|---|---|---|---|---|---|
| 5.1 | Operator completes onboarding unaided | operator · own phone | no support call needed | NOT RUN | | |
| 5.2 | They understand what each document is for | operator · own phone | no wrong document submitted | NOT RUN | | |
| 5.3 | Reviewer opens a submitted document | ops · desktop | opens in a new tab, readable, and the grant expires shortly after | NOT RUN | | |
| 5.4 | Platform Ops reviews the dossier | ops · desktop | decision within the promised time | NOT RUN | | |
| 5.5 | A proof is refused with a reason | ops · desktop | operator is told which document and why | NOT RUN | | |
| 5.6 | They resubmit the refused proof | operator · own phone | they find the reason and correct it unaided; the old file is replaced | NOT RUN | | |
| 5.7 | Dossier approved | ops · desktop | operator becomes verified and can publish | NOT RUN | | |
| 5.8 | They publish a line and a departure unaided | operator · own phone | reaches passenger search | NOT RUN | | |
| 5.9 | A passenger discovers and books that departure | passenger · own phone | booking confirmed | NOT RUN | | |
| 5.10 | They carry that passenger | crew · mid-range | boarded and alighted | NOT RUN | | |
| 5.11 | They read their own revenue | operator · own phone | figure matches what they expected | NOT RUN | | |
| 5.12 | A teammate with only `verification` sees only KYC | ops · desktop | no finance, no user register, no system page | NOT RUN | | |

## 6. Money

Covered separately, with its own checklist: `docs/PAYMENT-GO-LIVE.md`. One real
collection and one real payout, both unperformed. Those rows are part of the
pilot gate above.

## Recording a session

For each session, note the date, who was present, the devices, the network, and
which rows were attempted. A row that was attempted and inconclusive is a
`FAIL` with a note, not a `NOT RUN` — `NOT RUN` means nobody tried.

| Session | Date | Present | Devices | Network | Rows attempted |
|---|---|---|---|---|---|
| Automated field-validation pass (no physical session) | 2026-09-23 | Claude Code QA | none — headless Chromium + local Postgres only | local | 0 physical rows attempted; automated evidence recorded above |

### Tally

Update this when a session ends. It is the number the go/no-go conversation
actually turns on.

| | Count |
|---|---|
| PASS | 0 |
| FAIL | 0 |
| BLOCKED | 0 |
| NOT RUN | 69 |
| **Gate criteria still unmet** | **16 of 16** (12 base + 4 parcels, decision 2026-09-23) |

69 rows across five sections: 17 ticket QR, 12 trip and position, 13 parcel,
15 device and field, 12 Platform Ops. None performed.
