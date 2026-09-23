# KYC/KYB evidence storage

How LeRoutier handles the documents an operator submits to prove who they are:
a carte grise, an insurance certificate, a national identity card, a transport
authorization.

## Where things stand

**Backblaze B2 is configured**, in the `eu-central-003` region: a private,
encrypted bucket holding KYC/KYB documents, reached through a bucket-scoped
application key. Identity documents belonging to people in Benin stay in the
EU rather than crossing to a US region by default.

The operator-hosted-link arrangement still works for dossiers submitted before
the bucket existed, and the product keeps saying plainly which arrangement each
proof is under. A hosted link carries one consequence that must never be
glossed over:

> Access to an operator-hosted document is **not** server-authorized. Anybody
> holding the link can open it. LeRoutier cannot revoke it, cannot expire it,
> and cannot tell whether it was ever private.

Everything below the storage layer works the same way under either
arrangement:

- the reviewer fetches **one grant per document, at the moment they open it**.
  No list payload carries a document address, so a URL never sits in a JSON
  response, a browser tab, devtools, or anything that copies a response;
- opening a proof is **authorized and audited** — who looked at which document,
  and when. What was handed out is not recorded;
- rejection, replacement and re-review work;
- the 90-day redaction of refused dossiers works, and account deletion clears
  the driver photograph published to passengers along with identity references.

## What managed storage adds

The evidence row points at an object LeRoutier holds instead of somebody
else's URL, and three things become true that a link can never offer:

1. **The grant expires.** `EVIDENCE_READ_TTL_SECONDS` (120s) — a reviewer's
   link stops working shortly after they open it.
2. **The bytes are checked.** `detectEvidenceType` reads the file's own
   signature. A declared content type is the uploader's claim; an SVG announced
   as `image/png` is still a scripted page when a reviewer opens it, so the
   declaration is never consulted. PDF, JPEG, PNG, WEBP, HEIC, GIF and TIFF are
   accepted; everything else is refused, up to 8 MB.
3. **Deletion is real.** Redaction removes the object and only then clears the
   row. If the store cannot be reached the row is left alone and the next scan
   tries again — recording that LeRoutier forgot a document it still holds
   would be worse than the delay.

Object keys are opaque, random, and never returned to any client.

## Adding a provider

Implement four members in `packages/database/src/evidence-storage.js`, inside
`evidenceStore()`. Nothing anywhere else in the codebase makes a vendor call,
so swapping provider is a change to one object:

```
name    string
put({ operatorId, kind, bytes })  -> { key, contentType, byteSize }
read(key, { ttlSeconds })         -> { url, expiresAt }
remove(key)                       -> void, idempotent
```

`read` MUST return a URL that expires. A provider that can only issue permanent
public URLs is not a candidate — it would be the current arrangement with extra
steps and a misleading "managed" badge.

### Requirements for any candidate

- private by default; no public bucket, no public object ACL;
- server-issued, time-limited read access;
- deletion that actually deletes;
- credentials supplied by environment variable, never committed;
- a region choice that is defensible for Beninese personal data.

## CORS: deliberately none

The bucket has **no CORS rules, and needs none.** The reviewer console opens a
document with

```js
window.open(access.url, '_blank', 'noopener,noreferrer');
```

which is a top-level browser navigation, not a JavaScript `fetch`. Navigations
are not subject to CORS — the browser simply goes to the URL and renders what
comes back. Verified end to end against the real bucket: a plain request with
no custom headers returns `200`, `content-type: application/pdf`,
`content-disposition: inline`.

`noreferrer` also means Backblaze never learns which origin opened the
document, so an origin-based rule would have nothing to match on anyway.

**Do not add a CORS rule** unless the console is changed to read a document
with `fetch`/XHR — for example to render a PDF inside the page rather than in
a tab. If that day comes, the rule should name the LeRoutier Ops origin
exactly, allow `GET` and `HEAD` only, and nothing else.

## One B2 behaviour worth knowing

`b2_get_download_authorization` **binds the token to the override parameters it
was issued with.** Ask for a token with `b2ContentDisposition` and then omit
that parameter from the download URL, and every request returns
`401 bad_auth_token` — which looks exactly like a broken credential and is not.
The adapter puts the disposition on both, and the test double enforces the
binding so this cannot regress quietly.

## Configuration

Set on `le-routier-api`, production and preview, all as sensitive values:

| Variable | Meaning |
|---|---|
| `EVIDENCE_STORAGE_PROVIDER` | `b2` |
| `B2_BUCKET_NAME` | bucket holding the evidence |
| `B2_BUCKET_ID` | same bucket, by id |
| `B2_KEY_ID` | bucket-scoped application key id |
| `B2_APPLICATION_KEY` | its secret |

The key is scoped to this one bucket with exactly `listFiles`, `readFiles`,
`writeFiles`, `deleteFiles` and `shareFiles`. **The account's master key is not
used and must never be:** it can delete buckets and mint further keys, and has
no business in a request handler.

## Bucket state, read from B2 rather than from memory

Verified against the live bucket on 2026-09-22 with `b2_list_buckets`:

| Setting | Value | Why it matters |
|---|---|---|
| `bucketType` | `allPrivate` | the expiring grant IS the access control |
| `defaultServerSideEncryption` | `SSE-B2` / `AES256` | encrypted at rest by the provider |
| `fileLockConfiguration` | `isFileLockEnabled: false` | Object Lock off, so a redaction can actually delete |
| `corsRules` | `[]` | none needed; see above |
| `lifecycleRules` | `daysFromUploadingToHiding: null`, `daysFromHidingToDeleting: 1` | see below |

### The lifecycle rule, and why it is that one

`daysFromUploadingToHiding: null` means **the current version is never hidden
and never expires.** That is deliberate: a blanket provider-side expiry would
delete a live operator's carte grise out from under a verified account, and
LeRoutier — not Backblaze — decides when evidence has reached the end of its
90-day retention. The application remains authoritative for deletion.

`daysFromHidingToDeleting: 1` means a version that has been superseded or
hidden is **permanently deleted** a day later, rather than kept forever or
merely hidden. Old KYC bytes do not accumulate.

An earlier note in the downloaded bucket export says "Keep all versions". That
export is stale; the rule above is what B2 reports today, and B2 is the
authority. **Do not enable Object Lock** — it would make redaction impossible,
which is the opposite of what a retention policy needs.

### Verified: replacement leaves nothing recoverable

Checked end to end against the real bucket with generated TEST fixtures (a PDF
header, never anybody's document), using a temporary bucket-scoped key that was
deleted afterwards:

```
PASS  upload original        versions=1
PASS  upload replacement     versions=1
PASS  old version removed    remaining=0
INFO  same-name versions     2 (older is hidden; lifecycle deletes it after 1 day)
PASS  fixtures cleaned up    remaining=0
```

The important line is the third. LeRoutier never overwrites an object name —
every `put` uses a fresh random key — so replacing a proof uploads a new object
and **explicitly deletes the old one immediately**, rather than leaving it to
the lifecycle rule. The rule is the safety net for the case the application
does not produce; the application is the guarantee.

## Rotating the application key

```bash
pnpm rotate:b2 "C:/path/to/your/Backblaze-export.txt"
```

Then redeploy, because a running deployment keeps the environment it started
with:

```bash
vercel redeploy <current-production-url>
```

Confirm on Platform Ops → **Système** → *Justificatifs KYC*: provider `b2`,
region `eu-central-003`, key limited to the bucket, recent last check.

### Why a script rather than the console

Rotating by hand went wrong twice in one sitting on 2026-09-23, in two
different ways, and the script exists to remove both.

**The console pre-ticks capabilities.** A key created there arrived with
nineteen of them, including `writeBuckets`, `writeBucketEncryption` and
`writeBucketLifecycleRules` — any one of which could make the KYC bucket
public or delete its retention rule. A request handler that only puts, reads
and deletes objects must not be able to do that. The script fixes the set in
code and refuses to install anything broader.

**Moving a secret by hand means handling it.** One was pasted into a place it
should never have reached and had to be revoked immediately. The script takes
the secret from Backblaze's own response straight into Vercel's API: no shell,
no argument, no file, no log line, nothing rendered.

It also mints and verifies BEFORE revoking the old key, so an interrupted
rotation leaves a working credential rather than none — and it proves the new
one end to end (upload, reviewer grant, unauthenticated request still refused,
delete, nothing left behind) on a generated fixture, never a real document.

The one thing it cannot do is remove the need for an account-level credential:
minting a bucket-scoped key requires one. That is the argument you pass it, and
it is read for two lines and nothing else.

## External action still required

1. **Rotate the master application key.** Still outstanding, and now more
   pressing rather than less: it is LIVE, scoped to the entire account, with 38
   capabilities including `writeKeys`, `deleteKeys`, `deleteBuckets` and
   `bypassGovernance`; it sits in a downloaded file; and it has since been used
   to mint the production key, which is exactly the power it should not need to
   be lying around with. Production does not use it — `b2_list_keys` shows one
   application key, `leroutier-kyc-evidence-api`, confined to this bucket with
   five capabilities and nothing privileged.

   Rotate it AFTER any pending `pnpm rotate:b2`, since that command needs it.

   Backblaze has **no API for regenerating the master key**; it is a console
   action, which is why this cannot be done for you:

   1. B2 console → *Account* → *Application Keys*
   2. *Regenerate Master Application Key*, and confirm
   3. Do **not** put the new master key in Vercel, this repository, a script,
      a log, or a document. Production has no use for it.
   4. Delete the downloaded export, or store it somewhere a `git add` can
      never reach. `.gitignore` now refuses `Backblaze-*.txt` by name, which
      stops an accident, not a decision.
   5. Confirm nothing broke: the Platform Ops **Système** screen's *Justificatifs
      KYC* card should still read *Stockage privé actif*.

   Rotating it does not touch `leroutier-kyc-evidence-api`, so production keeps
   working throughout.

2. Watch the daily caps. They are set low (10 GB storage, 1 GB download,
   2,500 class B/C transactions) with alerts to the project mailbox; a pilot
   should stay far inside them, and a reviewer session costs one class B
   transaction per document opened. The Système card's health check is cached
   for five minutes for the same reason.

## Testing

`memoryEvidenceStore()` exists so the managed path's security properties —
authorization, expiry, replacement, deletion — can be proven without a vendor
account and without putting a real identity document anywhere. It is never
selected by `evidenceStore()`, so no deployment can reach it by configuration:
a test double that production could pick up is a fake provider.

Test fixtures are generated byte sequences (a PDF header, a PNG header, an SVG
that must be refused). Never upload a real document to a test.
