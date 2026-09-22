# Physical acceptance tests

Things that can only be learned by holding a phone in a station in Benin.

**Nothing in this file has been performed.** The Result column is empty on
purpose and must stay empty until somebody has actually done the test. A row
marked passed without evidence is worse than a row left blank: it converts an
unknown into a false certainty, and the whole point of this file is to keep
track of which is which.

Fill in: **Result** (pass / fail / blocked), **Evidence** (photo, screen
recording, tracking number, booking id, or a note naming who did it and when).

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

## Devices

Record what was actually used. An Android mid-range phone on a real Beninese
mobile network is the target; anything else is a weaker signal.

| Role | Device | OS / browser | Network | Notes |
|---|---|---|---|---|
| Passenger phone | | | | |
| Crew phone | | | | |
| Station / Ops | | | | |

## 1. Ticket QR, phone to phone

The passenger holds up their ticket; the crew scan it from the crew phone.

| # | Test | Environment | Expected | Result | Evidence | Blocker |
|---|---|---|---|---|---|---|
| 1.1 | Scan a valid ticket | daylight, outdoors | seat and passenger name shown, boarding confirmable | | | |
| 1.2 | Scan the same ticket again | daylight | refused: already boarded | | | |
| 1.3 | Scan a ticket for another departure | daylight | refused: wrong service | | | |
| 1.4 | Scan at a stop the passenger did not book | daylight | refused: wrong stop | | | |
| 1.5 | Scan a cancelled ticket | daylight | refused: invalid or replaced | | | |
| 1.6 | Scan at dusk, passenger screen at low brightness | ~18:30 | reads, or torch makes it read | | | |
| 1.7 | Scan in a dark station | after dark | torch appears and helps | | | |
| 1.8 | Scan through a cracked or matte screen protector | any | reads, or manual code used | | | |
| 1.9 | Passenger phone in strong sun | midday | reads, or manual code used | | | |
| 1.10 | Manual code entry instead of scanning | any | same result as a scan | | | |
| 1.11 | Deny camera permission, then board | any | message names the manual fallback, boarding still possible | | | |
| 1.12 | Switch apps mid-scan and return | any | camera released, no recording indicator while away | | | |

## 2. Parcel handoff

Full lifecycle with a real parcel, from a sender who has no printer.

| # | Test | Environment | Expected | Result | Evidence | Blocker |
|---|---|---|---|---|---|---|
| 2.1 | Sender shows the QR on their own phone | station | crew scan it, no printing needed | | | |
| 2.2 | Crew read the handwritten LRP reference instead | station | resolves to the same parcel | | | |
| 2.3 | Accept and load | station | custody recorded, sender sees the status change | | | |
| 2.4 | Departure scan | station | status advances | | | |
| 2.5 | Arrival scan at destination | destination | status advances | | | |
| 2.6 | Station marks ready for pickup | destination | recipient is told through the channels that exist | | | |
| 2.7 | Recipient collects with the correct code | destination | collected; proof of delivery recorded | | | |
| 2.8 | Someone presents the parcel QR but no code | destination | refused — the QR is not identity | | | |
| 2.9 | Wrong pickup code | destination | refused, attempt counted | | | |
| 2.10 | Wrong code eleven times | destination | locked; a new code must be issued | | | |
| 2.11 | Collect a second time | destination | refused | | | |
| 2.12 | Public tracking by reference only | any phone | status and city, no names or phone numbers | | | |

## 3. Field conditions

| # | Test | Environment | Expected | Result | Evidence | Blocker |
|---|---|---|---|---|---|---|
| 3.1 | Board five passengers in a row | station, queue waiting | no scan takes more than a few seconds | | | |
| 3.2 | Lose signal, board three, regain signal | edge of coverage | queued, then replayed exactly once, no duplicates | | | |
| 3.3 | Work an entire departure offline | no coverage | every action queues and syncs | | | |
| 3.4 | Crew phone at 10% battery, one hour of scanning | station | still usable; camera not left running | | | |
| 3.5 | Read the screen in direct sunlight | midday | states and buttons legible | | | |
| 3.6 | Sign out on a shared station handset | station | next person sees nothing of the previous one | | | |
| 3.7 | Slow 3G, first load | real network | app usable; note the time to first search | | | |
| 3.8 | Driver reports an incident while stopped | roadside | one tap, no typing, confirmation visible | | | |

## 4. Real operator

Cannot be simulated. A real transport operator, their real documents, their
real vehicle.

| # | Test | Expected | Result | Evidence | Blocker |
|---|---|---|---|---|---|
| 4.1 | Operator completes onboarding unaided | no support call needed | | | |
| 4.2 | They understand what each document is for | no wrong document submitted | | | |
| 4.3 | Platform Ops reviews the dossier | decision within the promised time | | | |
| 4.4 | A proof is refused, and they fix it | they find the reason and correct it unaided | | | |
| 4.5 | They publish a line and a departure unaided | reaches passenger search | | | |
| 4.6 | A passenger books that departure | booking confirmed | | | |
| 4.7 | They carry that passenger | boarded and alighted | | | |
| 4.8 | They read their own revenue | figure matches what they expected | | | |

**Do not submit real identity documents until private evidence storage is
configured.** See `docs/KYC-EVIDENCE-STORAGE.md`: operators currently host
their own documents, and LeRoutier cannot revoke access to them. For 4.1–4.4,
use documents the operator is willing to have permanently readable by anyone
holding the link, or wait.

## 5. Money

Covered separately, with its own checklist: `docs/PAYMENT-GO-LIVE.md`. One real
collection and one real payout, both unperformed.

## Recording a session

For each session, note the date, who was present, the devices, the network, and
which rows were attempted. A row that was attempted and inconclusive is a
**fail** with a note, not a blank — blank means nobody tried.
