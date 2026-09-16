# UI & information architecture

Every screen in LeRoutier must answer three questions in about five seconds:

1. **Where am I?** — the shell title, the workspace strip, one heading.
2. **What is happening?** — one status, in product language.
3. **What should I do next?** — one obvious primary action.

Screens with ten equally weighted controls fail this test. When in doubt,
promote one action and demote the rest.

## Navigation model

One PWA, one identity, workspaces resolved from `/api/v1/me`
(see `../architecture/UNIFIED_PWA.md`).

| Workspace | Mobile navigation (5 max) | Home is |
| --- | --- | --- |
| Voyageur | Voyager · Billets · Colis · Alertes · Compte | the brand mark in the header |
| Conducteur / Convoyeur | Aujourd'hui · Manifeste · Scanner · Comptant · Colis (+ Véhicule, Points, Recettes by role) | Aujourd'hui |
| Exploitation | Aujourd'hui · Services · Flotte · Équipage · Stations · Colis · Paiements · Règlements · Incidents · Alertes · Paramètres | Aujourd'hui |

Passenger navigation is deliberately short and thumb-reachable. Operations is
denser because its users are at a desk; it stays responsive, never a phone-first
experience pretending to be a console.

The workspace switcher names the job and the company — "Conducteur — Baobab
Express", "Exploitation — Baobab Express" — never a role string like `driver`.

## Primary action per screen

| Screen | Primary action |
| --- | --- |
| `/` public home | **Rechercher** a trip |
| `/trips` | **Choisir ce trajet** |
| `/tickets/:id` | Pay → **Afficher mon billet** |
| `/parcels` | **Continuer** through three steps → **Confirmer l'envoi** |
| `/parcels/track` | **Suivre mon colis** |
| `/onboarding` | Choose independent driver or company |
| `/work/today` | **Scanner un billet** (then Vendre une place) |
| `/work/walk-up` | **Encaisser {fare}** |
| `/ops/today` | Clear the setup checklist, or handle the exceptions listed |

## Passenger flow

```
public home (search)
  → /trips           results: times, places, seats, fare
  → sign in          only here, and the chosen trip is preserved
  → /tickets/:id     booking summary → pay → ticket (QR leads)
  → journey timeline first mile · boarding · departure · arrival
```

A search started on the home page carries its criteria into `/trips` through
the URL, so the result screen is shareable and survives a refresh.

**Booking interrupted by sign-in.** The selected trip is stored in
`sessionStorage`, survives the identity-provider round trip, and the hold is
placed automatically on return. The user never re-picks their trip.

## Result card

Times lead, then the exact places, then the price:

```
07:30  →  13:40   [6 h 10]
● Cotonou · Godomey – Carrefour
● Parakou · Parakou – Gare centrale
Opérateur · 12 places                7 500 FCFA   [Choisir ce trajet]
```

Vehicle registration, driver name and internal identifiers are **not** shown to
passengers — they do not help anyone choose a trip.

## Status system

One vocabulary, defined once in `packages/ui/src/format.js` and used by every
screen. No component renders a raw domain enum.

| Tone | Meaning | Examples |
| --- | --- | --- |
| `success` | done, confirmed, active | Confirmé · À bord · Paiement reçu · Retiré · Compte vérifié |
| `warning` | needs attention or is pending | À payer · Prêt à retirer · Vérification en cours · Perturbé |
| `danger` | failed or lost | Paiement refusé · Annulé · Expiré · Perdu · Dossier refusé |
| `neutral` | informational | Programmé · Terminé · En route |

`status(kind, value)` returns `{ label, tone }` and falls back to a neutral dash
rather than leaking an unmapped enum name.

## Loading, empty and error

- **Loading** — `SkeletonCards` shows the shape of the answer. Never invented
  content, never a bare spinner on a blank page.
- **Empty** — always offers the next action. "Aucun voyage pour le moment" is
  followed by *Rechercher un trajet*; a search with no result on the chosen day
  automatically falls forward to the next departures and says so.
- **Error** — states what failed and offers **Réessayer**. Status codes and
  driver messages stay in logs: the user reads "Impossible de charger les
  départs.", not `503`.

## Forms

- Ask only what is needed, and split long flows into steps (parcel creation is
  Trajet → Personnes → Colis & prix).
- Optional fields live behind a `<details>` disclosure rather than padding the
  form.
- Defaults do the work: the walk-up sale reads the fare from the service and
  pre-fills a receipt reference, so crew type a name, a phone and nothing else.
- Errors appear next to the action, and input is preserved across failures.

## Terminology

Product language, never internal vocabulary.

| Internal | Shown to users |
| --- | --- |
| `operator settlement balance` | Solde disponible / Recette de mon activité |
| `boarding_point` | Point d'embarquement |
| `service` | Départ, trajet |
| `workflow run failed` | Traitement automatique à relancer |
| `pending_verification` | Vérification en cours |
| `ready_for_pickup` | Prêt à retirer |
| `driver earnings` (for company crew) | *not shown* — "Les recettes reviennent à {compagnie}" |

## Crew: low distraction by design

The crew home is glanceable and one-handed: departure time, passengers aboard,
seats free, parcels, next stop, and three large actions. Revenue is **not** the
visual focus during operations. Incident reporting sits one tap away rather than
occupying the driving screen, and works offline.

Company crew see no ledger and no withdrawal control anywhere — the API enforces
this, and the UI does not present it either.

## Offline

Crew see exactly what is pending:

```
Hors ligne              [2 actions en attente]
Vos scans sont enregistrés sur l'appareil et partiront dès le retour du réseau.
Embarquement · non envoyé                      [Réessayer]
```

Queued actions are named for what the person did ("Embarquement", "Colis
scanné"), never `board` or `parcel`. Conflicts say the situation changed and
offer a decision, so no one is left guessing whether a scan was accepted.

## Accessibility

- A visible focus ring on every interactive element, and a skip link to content.
- Minimum 44 px touch targets; 56 px in the bottom navigation.
- Labels on every field; the swap control and the notification bell have
  explicit accessible names including the unread count.
- Status messages use `role="status"`, errors `role="alert"`.
- Skeletons respect `prefers-reduced-motion`.
- Colour is never the only carrier of meaning — every badge has a text label.

## Maps

Coordinates are never the interface. Where a point has them, the screen offers
"Voir le point d'embarquement" / "Voir sur la carte"; the numbers themselves are
not displayed.

## Real data only

No hardcoded operational content anywhere. An empty production database renders
honest empty states, which the browser suite asserts.
