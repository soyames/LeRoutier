# USSD shortcode — ARCEP Bénin application pack

Everything needed to apply for a LeRoutier USSD access code, assembled from
ARCEP Bénin's own published rules.

> **Nothing here has been submitted and no fee has been paid.** This is the
> preparation an applicant can do without a regulator, so that submission is an
> afternoon rather than a project. Submission, payment and allocation are the
> owner's to perform.

**LeRoutier has no shortcode.** No part of the product claims one exists.

## The order matters

An SVA declaration is a **prerequisite**, not a parallel step. ARCEP allocates
numbering resources to network operators, to **value-added service providers
already declared with it**, and to State services. Applying for a code without
the declaration means applying as an entity ARCEP does not yet recognise.

```
1. SVA declaration            récépissé, valid 5 years
2. USSD code application      requires an accepted declaration
3. Operator or aggregator routing   a commercial contract, not a regulatory one
4. Live handset test
```

## Step 1 — SVA declaration

Value-added services in Benin operate under a **declaration** regime, per
articles 55 and 57 of loi n° 2017-20 of 20 April 2018 (Code du numérique), as
amended by loi n° 2020-35 of 6 January 2021, with procedures set by arrêté 2020
n° 013/MND/DC/SGM/CTJ/CJ/SA/026SGG20 of 28 August 2020.

| | |
| --- | --- |
| Submit at | `https://e-services.arcep.bj/dossier/sva/demande` |
| Documents | listed on that platform under **« Dépôt du dossier »** |
| Declaration fee | **100 000 FCFA**, payable on submission |
| Annual management fee | **100 000 FCFA**, for year N by 31 December of year N, pro-rated if accepted mid-year |
| Validity | **5 years**, renewed every 5 years |
| Refunds | dossier fees are **non-refundable in all circumstances** |

## Step 2 — USSD access code

Governed by décision n° 2020-202/ARCEP/PT/SE/DJPC/DCT/DEM/DAR/GU of 14 July
2020, which opened USSD codes to value-added service providers.

| | |
| --- | --- |
| Submit at | `https://e-services.arcep.bj/dossier/code/ussd/sva` |
| Documents | listed on that platform under **« Dépôt du dossier »** |
| Dossier study | **50 000 FCFA** |
| Allocation or reservation | **200 000 FCFA** |
| Annual usage fee | **150 000 FCFA** (pro-rated if allocated mid-year) |
| Payment methods | `https://e-services.arcep.bj/faq` |

### ⚠️ One question to put to ARCEP first

ARCEP's published format list reads:

- `*8YZ#` — mobile financial services
- `*6YZ#` — **SVA aggregators and payment aggregators**
- `*2YZ#`, `*3YZ#`, `*4YZ#`, `*5YZ#`, `*7YZ#`, `*9YZ#` — mobile financial services

Every listed format is designated either for **mobile financial services** or
for **aggregators**. LeRoutier is neither: it is a transport service that takes
payment through a licensed provider (FedaPay), not a financial service itself.

**No published format is explicitly designated for a non-financial SVA.** That
is most likely an editorial gap on the page rather than a policy that excludes
transport, but it decides the whole approach, so ask before paying a
non-refundable study fee:

> Under décision n° 2020-202, which USSD format applies to a declared
> value-added service provider whose service is passenger transport and parcel
> logistics rather than a mobile financial service? If no direct format
> applies, is routing under an aggregator's `*6YZ#` code the intended path?

The answer chooses between two routes:

| Answer | Route |
| --- | --- |
| A direct format applies | apply for LeRoutier's own code, per the fees above |
| Only aggregators qualify | contract an aggregator holding a `*6YZ#` code; LeRoutier becomes a service under it |

## Step 3 — do not propose an allocated code

ARCEP publishes the allocation list, and it is the evidence to check against —
not an assumption.

**Checked against « Liste des codes USSD attribués », version 1.1, 04/02/2026**
(`arcep.bj/wp-content/uploads/2026/02/`). It records **65 allocated codes**.

Allocated in the aggregator range, which is the range that matters if the
aggregator route applies:

| Code | Holder | Code | Holder |
| --- | --- | --- | --- |
| `*601#` | FEDAPAY SAS | `*615#` | AM AFRIQUE |
| `*605#` | CROSS SWITCH BENIN S.A. | `*616#` | OPEN SI |
| `*607#` | Kerry Payments Bénin | `*624#` | CAFRITECH |
| `*611#` | ASIN | `*654#` | YAPHA SARL |
| `*612#` | ASIN | `*655#` | GIM-UEMOA |
| | | `*660#` | RINEL SARL |
| | | `*678#` | Porting Bénin |

`*601#` is **FedaPay's**. LeRoutier uses FedaPay for payments and must not
reuse, borrow or route through its code as though it were LeRoutier's own.

Occupancy by range, from that list:

| Range | Allocated | Range | Allocated |
| --- | --- | --- | --- |
| `*2YZ#` | 5 / 100 | `*6YZ#` | 12 / 100 |
| `*3YZ#` | 3 / 100 | `*7YZ#` | 17 / 100 |
| `*4YZ#` | 2 / 100 | `*8YZ#` | 17 / 100 |
| `*5YZ#` | 4 / 100 | `*9YZ#` | 1 / 100 |

**A code absent from that list is not the same as a code that is available.**
It may be reserved, held pending, or restricted by format. Availability is
ARCEP's to confirm, and this document does not propose a specific code.

## Step 4 — operator or aggregator routing

Allocation is regulatory. **Reach is commercial.** A code exists on the networks
that agree to route it, so obtaining a code from ARCEP does not by itself make
it dialable on MTN, Moov and Celtiis.

Two routes:

| | Direct with each operator | Through an aggregator |
| --- | --- | --- |
| Contracts | one per operator | one |
| Coverage | what you sign, network by network | whatever the aggregator carries |
| Code | LeRoutier's own | may be a service under the aggregator's `*6YZ#` |
| Integration | one adapter per operator | one adapter |
| Margin | no intermediary | intermediary |

Whichever is chosen, judge it on: coverage, cost per session, the webhook
contract, **whether the MSISDN is contractually guaranteed**, uptime, retry
behaviour and support. The MSISDN guarantee is the one that changes LeRoutier's
security posture — see *Phone trust* below.

## What to submit — and what already exists

Most of an application's technical annex is already written.

| ARCEP will ask for | Where it is |
| --- | --- |
| Service description | this document, *Service description* below |
| Technical architecture | [`../architecture/USSD.md`](../architecture/USSD.md) |
| Platform and webhook description | same, *Architecture* and *Provider onboarding* |
| Security summary | same, *Security*; [`../security/THREAT_MODEL.md`](../security/THREAT_MODEL.md) |
| Privacy summary | [`../security/PRIVACY_AND_RETENTION.md`](../security/PRIVACY_AND_RETENTION.md) |
| Applicant identity, statutes, tax and registration documents | **the owner's** — not in this repository |
| Expected operator coverage | depends on step 4 |
| Contact details | the owner's |

### Service description (draft — for the owner to adapt)

> LeRoutier is an intercity passenger transport and parcel logistics platform
> for Benin. The USSD channel gives a caller without a smartphone or a data
> plan access to the essential journeys the web application already offers:
> searching departures between two towns with real times, fares and remaining
> seats; making a reservation; initiating payment through a licensed payment
> provider; consulting a reservation and its payment status; following a parcel
> by its tracking reference; and consulting the status of a journey in progress.
>
> The service performs no financial intermediation of its own. Payment is
> initiated through a licensed provider and is recorded as settled only on that
> provider's own verified confirmation.
>
> The channel is served entirely in French. It stores no telephone number in
> clear: a caller is identified across the screens of a call by a cryptographic
> fingerprint of their number. A USSD session expires after three minutes.

## Phone trust

`USSD_TRUST_PROVIDER_MSISDN` stays **false** until a provider's contract and
technical documentation state that the subscriber MSISDN delivered to LeRoutier
is authoritative.

Even then, USSD **binds an account that already exists** and never creates one:
a verified callback proves the gateway sent the number, not that the person
holding the handset owns the LeRoutier account.

## What it costs, before any operator contract

| | Year 1 | Each year after |
| --- | --- | --- |
| SVA declaration | 100 000 | — |
| SVA annual management | 100 000 | 100 000 |
| USSD dossier study | 50 000 | — |
| USSD allocation | 200 000 | — |
| USSD annual usage | 150 000 | 150 000 |
| **Total (FCFA)** | **600 000** | **250 000** |

Operator or aggregator charges are commercial and additional. Per-session USSD
pricing has historically been the dominant cost of running this kind of service
in the region, and is worth settling before allocation rather than after.

## Sources

- [Les codes USSD d'accès aux SVA](https://arcep.bj/les-codes-ussd-dacces-aux-sva/) — formats, fees, platform
- [La déclaration SVA](https://arcep.bj/la-declaration-sva/) — prerequisite, legal basis, fees, validity
- [Les ressources en numérotation](https://arcep.bj/les-ressources-en-numerotation/) — who may hold numbering resources
- [Attribution des codes USSD par l'ARCEP BENIN](https://arcep.bj/attribution-des-codes-ussd-par-larcep-benin-la-levee-dun-frein-a-linnovation-et-au-developpement-de-nouveaux-services-de-communications-electroniques-au-benin/) — décision n° 2020-202 and its intent
- [Liste des codes USSD attribués, v1.1 du 04/02/2026](https://arcep.bj/wp-content/uploads/2026/02/Liste-des-codes-USSD-attribu%C3%A9s.pdf) — the allocation evidence above
