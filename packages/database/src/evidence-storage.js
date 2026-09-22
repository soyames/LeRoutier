/**
 * Where a verification document lives, and what LeRoutier may say about it.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * There are TWO arrangements, and the difference between them is the whole
 * reason this module exists as a boundary.
 *
 * MANAGED (a provider is configured, Backblaze B2 today). LeRoutier holds the
 * bytes in a private bucket. Every read is a server-authorized grant that
 * EXPIRES, the uploaded file's type is read from its own first bytes, and a
 * redaction genuinely deletes the object.
 *
 * OPERATOR-HOSTED LINK (no provider configured). An operator supplies an https
 * link to a document they host themselves. That carries a consequence which
 * must never be glossed over in the product:
 *
 *   ACCESS TO THE DOCUMENT IS NOT SERVER-AUTHORIZED. Anybody holding the link
 *   can open it. LeRoutier cannot revoke it, cannot expire it, and cannot tell
 *   whether it was ever private in the first place.
 *
 * Both shapes coexist so a dossier submitted under one stays readable after
 * the other arrives. Everything else in the codebase goes through
 * `documentReference` for links and the four-member store interface for
 * managed objects; no vendor call appears anywhere but here.
 *
 * What is genuinely enforced without a storage provider:
 *   - the link is a plain, credential-free, port-free https URL on a real
 *     named host — so it cannot be an internal address, a metadata endpoint or
 *     an embedded secret;
 *   - the link does not point at active content, so a reviewer opening a
 *     "document" is not opening a scripted page;
 *   - the link never reaches a passenger API, a log line or an event payload.
 *
 * What CANNOT be enforced without one, and must therefore not be claimed:
 *   - that the file is private, or enumerable only by us;
 *   - its real MIME type, its size, or that it is a document at all;
 *   - expiry, revocation, or an audit trail of who opened it.
 *
 * Adding another provider: implement the four members below and name it in
 * `evidenceStore`. Nothing outside this module encodes which one is in use.
 */
import { createHash, randomUUID } from 'node:crypto';
import { invariant } from '@leroutier/domain';

/**
 * What the platform can honestly say about document handling, given its
 * configuration. Surfaced to Platform Ops so the arrangement is visible rather
 * than assumed, and read by the product copy so no screen can promise more
 * than this.
 *
 * @param {{name?:string}|null} [adapter]
 */
export const evidenceStorageState = (adapter = null) => ({
  /** True only when LeRoutier holds the bytes and authorizes each read. */
  managed: Boolean(adapter),
  mode: adapter ? 'managed_private_object_store' : 'operator_hosted_link',
  provider: adapter?.name ?? null,
});

/**
 * What a document REALLY is, read from its first bytes.
 *
 * A declared content type is the uploader's claim. These signatures are the
 * file's own, and they are the only reason a managed store can promise what a
 * link never could: that the thing a reviewer opens is a document rather than
 * a page somebody wrote. Deliberately a short allow-list — a proof is a PDF or
 * a photograph, and anything that is neither has no business here.
 */
const SIGNATURES = [
  { type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },                     // %PDF
  { type: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { type: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { type: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },                           // GIF8
  { type: 'image/tiff', bytes: [0x49, 0x49, 0x2A, 0x00] },
  { type: 'image/tiff', bytes: [0x4D, 0x4D, 0x00, 0x2A] },
];
/** RIFF....WEBP and ftyp-based HEIC/AVIF carry their marker past the header. */
const CONTAINERS = [
  { type: 'image/webp', lead: [0x52, 0x49, 0x46, 0x46], at: 8, marker: 'WEBP' },
  { type: 'image/heic', lead: null, at: 4, marker: 'ftyp' },
];

/** Largest a single proof may be. A carte grise photographed on a phone is a
 * few megabytes; anything far past that is not a document. */
export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

/**
 * Identify an uploaded proof, or refuse it.
 *
 * Refusal is by signature, not by what the uploader said it was, because the
 * whole attack is a declaration that does not match the bytes: an SVG announced
 * as image/png is still a scripted document when a reviewer opens it.
 *
 * @param {Uint8Array} bytes
 * @returns {string} the detected content type
 */
export function detectEvidenceType(bytes) {
  invariant(bytes && bytes.length > 0, 'INVALID_EVIDENCE_FILE', 'Le fichier est vide.');
  invariant(bytes.length <= MAX_EVIDENCE_BYTES, 'INVALID_EVIDENCE_FILE',
    'Le justificatif dépasse la taille maximale de 8 Mo.', 413);
  const starts = signature => signature.every((byte, i) => bytes[i] === byte);
  for (const candidate of SIGNATURES) if (starts(candidate.bytes)) return candidate.type;
  const text = String.fromCharCode(...bytes.slice(0, 16));
  for (const candidate of CONTAINERS) {
    if (candidate.lead && !starts(candidate.lead)) continue;
    if (text.slice(candidate.at, candidate.at + candidate.marker.length) === candidate.marker) return candidate.type;
  }
  // Named explicitly so the operator is told what to send rather than left
  // guessing why a photograph was refused.
  invariant(false, 'INVALID_EVIDENCE_FILE',
    'Ce fichier n’est pas un justificatif lisible. Envoyez un PDF ou une photo (JPG, PNG, WEBP, HEIC, TIFF).');
}

// Hosts that are never a legitimate place to keep a carte grise, and are the
// usual target when somebody wants another person's browser to reach an
// internal service.
const BLOCKED_HOSTS = ['localhost', 'metadata', 'metadata.google.internal', 'instance-data'];
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.home.arpa', '.lan'];

/**
 * Extensions that make a link something other than a document to look at.
 *
 * SVG is the one that surprises people: it is an image everywhere else in a
 * product, and a scripted document here. A reviewer opening an operator's
 * "identity card" as .svg is opening a page the operator wrote, in a tab, with
 * a real browser behind it. Refused at submission, where it is cheap.
 */
const ACTIVE_CONTENT = ['.svg', '.svgz', '.html', '.htm', '.xhtml', '.xht', '.shtml', '.mhtml', '.mht',
  '.xml', '.js', '.mjs', '.jsx', '.wasm', '.swf', '.exe', '.msi', '.bat', '.cmd', '.sh', '.ps1',
  '.jar', '.apk', '.zip', '.rar', '.7z', '.tar', '.gz'];

/** What a proof may plausibly be. Checked only when the link states a type. */
const DOCUMENT_TYPES = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.avif', '.tif', '.tiff', '.gif', '.bmp'];

/**
 * Validate an operator-supplied document or photo reference.
 *
 * This is NOT an SSRF sandbox — LeRoutier never fetches these URLs server-side.
 * It protects the party that DOES load them: a Platform Ops reviewer opening a
 * proof, and every passenger's browser rendering a verified driver's photo.
 *
 * `https://` alone is not enough: `https://user:token@…`, `https://10.0.0.5/`,
 * `https://169.254.169.254/latest/meta-data/` and `https://2130706433/` all
 * satisfy "must use HTTPS" and none of them is a document.
 *
 * @param {unknown} value
 * @param {boolean} [required]
 * @returns {string|null}
 */
export function documentReference(value, required = false) {
  if (value === undefined || value === null || value === '') {
    invariant(!required, 'INVALID_ONBOARDING', 'A secure document link is required.');
    return null;
  }
  const text = String(value).trim();
  invariant(text.length <= 2000, 'INVALID_ONBOARDING', 'Document URL is too long.');
  let parsed;
  try { parsed = new URL(text); } catch { invariant(false, 'INVALID_ONBOARDING', 'Document URL is invalid.'); }
  const refuse = () => invariant(false, 'INVALID_ONBOARDING',
    'Document URL must be a public HTTPS address, without credentials or an internal host.');
  // https only: this is also what excludes javascript:, data:, blob: and file:.
  if (parsed.protocol !== 'https:') refuse();
  // Embedded credentials become a leaked secret the moment the link is
  // rendered, copied or logged.
  if (parsed.username || parsed.password) refuse();
  // An explicit port on a document link is either a mistake or a service that
  // is not a document host.
  if (parsed.port) refuse();
  const host = parsed.hostname.toLowerCase();
  if (!host || host.length > 253) refuse();
  // IPv6 literals ([::1], [fd00::1], …) are never a document host.
  if (host.startsWith('[') || host.includes(':')) refuse();
  if (BLOCKED_HOSTS.includes(host)) refuse();
  if (BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix))) refuse();
  // Any IP literal is refused, not merely the private ranges: a real document
  // host has a name, and refusing the whole shape removes every decimal,
  // octal and hexadecimal encoding trick at once.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) refuse();
  // A dotted name with at least one label separator. This also rejects bare
  // numbers (https://2130706433/) and single labels (https://intranet/).
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) refuse();
  if (/^\d+$/.test(host.replaceAll('.', ''))) refuse();

  // The type check, such as it can be without fetching the file. A link that
  // names an extension must name a document one; a link that names none is
  // allowed, because plenty of legitimate document hosts serve from an opaque
  // path. This stops the clear-cut case, not every case.
  const extension = (parsed.pathname.toLowerCase().match(/\.[a-z0-9]{1,6}$/) ?? [''])[0];
  if (ACTIVE_CONTENT.includes(extension)) {
    invariant(false, 'INVALID_ONBOARDING',
      'Ce type de fichier ne peut pas servir de justificatif. Fournissez un PDF ou une photo (JPG, PNG, WEBP).');
  }
  if (extension && !DOCUMENT_TYPES.includes(extension)) {
    invariant(false, 'INVALID_ONBOARDING',
      'Le justificatif doit être un PDF ou une image (JPG, PNG, WEBP, HEIC, TIFF).');
  }
  return parsed.toString();
}

/**
 * The storage adapter interface.
 *
 * Four methods, because that is everything the KYC lifecycle needs from a
 * store, and every one of them is something a reviewer or a retention scan
 * already does:
 *
 *   put({ operatorId, kind, bytes })  → { key, contentType, byteSize }
 *   read(key, { ttlSeconds })         → { url, expiresAt }   short-lived
 *   remove(key)                       → void, idempotent
 *   name                              → for the audit trail and Ops display
 *
 * `read` returns a URL that EXPIRES. That single property is what the current
 * arrangement cannot offer at all: an operator-hosted link is permanent and
 * unrevocable, so "access was withdrawn" is something LeRoutier can say only
 * once it holds the bytes.
 *
 * Nothing outside this module knows which provider is in use, and no vendor
 * call appears anywhere else in the codebase. Swapping provider means writing
 * one object with these four members.
 *
 * @typedef {{
 *   name: string,
 *   put(input: {operatorId: string, kind: string, bytes: Uint8Array}): Promise<{key: string, contentType: string, byteSize: number}>,
 *   read(key: string, options?: {ttlSeconds?: number}): Promise<{url: string, expiresAt: string}>,
 *   remove(key: string): Promise<void>,
 * }} EvidenceStore
 */

/** How long a reviewer's link to a document stays usable. */
export const EVIDENCE_READ_TTL_SECONDS = 120;

/**
 * Select the configured store, or none.
 *
 * Returning null is a supported, honest state: the product keeps accepting
 * operator-hosted links, says plainly that it does not hold the documents, and
 * nothing anywhere pretends otherwise. A half-configured provider produces NO
 * store rather than one that fails on the first upload — the same rule
 * sign-in follows.
 *
 * @param {{evidenceStorage?: {provider?: string|null,
 *   b2?: {keyId?: string, applicationKey?: string, bucketId?: string, bucketName?: string}}}} [config]
 * @param {typeof fetch} [http]
 * @returns {EvidenceStore|null}
 */
export function evidenceStore(config = {}, http = fetch) {
  const settings = config.evidenceStorage ?? {};
  // Constructed here and nowhere else; see docs/KYC-EVIDENCE-STORAGE.md for
  // what each provider needs and which of the four members it has to satisfy.
  if (!settings.provider) return null;
  if (settings.provider === 'b2') return backblazeEvidenceStore(settings.b2 ?? {}, http);
  invariant(false, 'EVIDENCE_STORAGE_UNAVAILABLE',
    `Le fournisseur de stockage « ${String(settings.provider).slice(0, 40) }» n'est pas implémenté.`, 503);
}

const B2_API = 'https://api.backblazeb2.com/b2api/v3';

/**
 * Backblaze B2, through its native API.
 *
 * Deliberately not the S3-compatible surface: SigV4 would mean an AWS SDK in a
 * serverless function that otherwise has none, to sign requests to an endpoint
 * whose own API is plain HTTPS and JSON. Fewer moving parts, and nothing new to
 * keep patched.
 *
 * Three facts about the bucket this is written against, because the code
 * depends on all three:
 *
 *   Private. Objects are unreachable without an authorization token, so the
 *   expiring grant IS the access control rather than a courtesy on top of a
 *   public URL.
 *
 *   "Keep all versions". Deleting one version of a file leaves the previous
 *   ones, so `remove` deletes EVERY version. A redaction that leaves an older
 *   copy behind has not deleted the document, and the retention scan would
 *   record that LeRoutier forgot something it still holds.
 *
 *   eu-central. Identity documents belonging to people in Benin stay in the
 *   EU rather than crossing to a US region by default.
 *
 * Credentials come from a BUCKET-SCOPED application key with exactly
 * listFiles, readFiles, writeFiles, deleteFiles and shareFiles. The account's
 * master key can delete buckets and mint further keys, and has no business in
 * a request handler.
 *
 * @param {{keyId?:string,applicationKey?:string,bucketId?:string,bucketName?:string}} settings
 * @param {typeof fetch} http
 */
export function backblazeEvidenceStore(settings, http = fetch) {
  const { keyId, applicationKey, bucketId, bucketName } = settings;
  // A half-configured provider produces NO store rather than one that fails on
  // the first upload — the same rule sign-in follows.
  if (!keyId || !applicationKey || !bucketId || !bucketName) return null;

  /** Account authorization, reused until it expires. Valid ~24h; refreshed at 12. */
  let session = null;
  async function authorize(force = false) {
    if (!force && session && session.until > Date.now()) return session;
    const basic = Buffer.from(`${keyId}:${applicationKey}`).toString('base64');
    const response = await http(`${B2_API}/b2_authorize_account`, {
      headers: { authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(10_000),
    });
    // Never the key, never the Authorization header, never the raw body.
    invariant(response.ok, 'EVIDENCE_STORAGE_UNAVAILABLE',
      'Le stockage des justificatifs est indisponible. Réessayez plus tard.', 503);
    const body = await response.json();
    const api = body.apiInfo?.storageApi ?? body;
    invariant(api?.apiUrl && api?.downloadUrl && body.authorizationToken, 'EVIDENCE_STORAGE_UNAVAILABLE',
      'Le stockage des justificatifs est indisponible. Réessayez plus tard.', 503);
    session = { token: body.authorizationToken, apiUrl: api.apiUrl, downloadUrl: api.downloadUrl,
      until: Date.now() + 12 * 3600_000 };
    return session;
  }

  /**
   * One B2 call, retried once against a token that expired mid-flight.
   *
   * `tolerate` names B2 error codes that mean the call already got what it
   * wanted, and resolves them to null. Everything else throws: a caller that
   * cannot tell "already gone" from "Backblaze is down" will eventually record
   * a deletion that did not happen.
   */
  async function call(path, body, { retry = true, tolerate = [] } = {}) {
    const current = await authorize();
    const response = await http(`${current.apiUrl}/b2api/v3/${path}`, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { authorization: current.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status === 401 && retry) { await authorize(true); return call(path, body, { retry: false, tolerate }); }
    if (!response.ok && tolerate.length) {
      const failure = await response.json().catch(() => ({}));
      if (tolerate.includes(failure?.code)) return null;
    }
    invariant(response.ok, 'EVIDENCE_STORAGE_UNAVAILABLE',
      'Le stockage des justificatifs est indisponible. Réessayez plus tard.', 503);
    return response.json();
  }

  return {
    name: 'b2',

    async put({ operatorId, kind, bytes }) {
      const contentType = detectEvidenceType(bytes);
      // Opaque and unguessable. Naming an object after the operator and the
      // document kind alone would make one reviewer's URL a template for
      // everybody else's; the random segment is what stops that.
      const key = `evidence/${operatorId}/${kind}/${randomUUID()}`;
      const sha1 = createHash('sha1').update(bytes).digest('hex');
      const upload = await call('b2_get_upload_url', { bucketId });
      const response = await http(upload.uploadUrl, {
        method: 'POST', body: bytes, signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: upload.authorizationToken,
          // B2 wants the name percent-encoded in the header.
          'x-bz-file-name': encodeURIComponent(key),
          'content-type': contentType,
          'content-length': String(bytes.length),
          'x-bz-content-sha1': sha1,
        },
      });
      invariant(response.ok, 'EVIDENCE_STORAGE_UNAVAILABLE',
        'L’envoi du justificatif a échoué. Réessayez.', 503);
      return { key, contentType, byteSize: bytes.length };
    },

    async read(key, { ttlSeconds = EVIDENCE_READ_TTL_SECONDS } = {}) {
      const current = await authorize();
      // Scoped to this one object by prefix, and to a couple of minutes. The
      // token is the access control: without it the object is unreachable.
      // A reviewer opening an identity card wants to look at it, not download
      // it. Safe because the object is served from Backblaze's own origin,
      // never LeRoutier's, and because what it contains was checked by
      // signature at upload — active content never got in.
      const disposition = 'inline';
      const grant = await call('b2_get_download_authorization', {
        bucketId, fileNamePrefix: key,
        validDurationInSeconds: Math.max(1, Math.min(604_800, Math.trunc(ttlSeconds))),
        b2ContentDisposition: disposition,
      });
      // B2 BINDS the token to the override parameters it was issued with, so
      // the disposition has to appear on the request too. Ask for a token with
      // b2ContentDisposition and then omit it from the URL and every download
      // is 401 bad_auth_token — which looks exactly like a broken credential
      // and is not.
      const path = key.split('/').map(encodeURIComponent).join('/');
      const query = new URLSearchParams({
        Authorization: grant.authorizationToken,
        b2ContentDisposition: disposition,
      });
      return {
        url: `${current.downloadUrl}/file/${encodeURIComponent(bucketName)}/${path}?${query}`,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      };
    },

    async remove(key) {
      // EVERY version. The bucket keeps all of them, so deleting the newest
      // and stopping would leave the document in place behind a redaction that
      // claims it is gone.
      let startFileName = key, startFileId;
      for (let page = 0; page < 50; page++) {
        /** @type {any} */
        const listing = await call('b2_list_file_versions', {
          bucketId, prefix: key, startFileName, startFileId, maxFileCount: 100,
        });
        const files = (listing.files ?? []).filter(file => file.fileName === key);
        for (const file of files) {
          // Already gone is the desired state, so removal stays idempotent —
          // but ONLY that. Any other failure propagates, because the retention
          // scan clears the database row on success and must not do so while
          // the document is still sitting in the bucket.
          await call('b2_delete_file_version',
            { fileName: file.fileName, fileId: file.fileId },
            { tolerate: ['file_not_present', 'not_found'] });
        }
        if (!listing.nextFileName) return;
        startFileName = listing.nextFileName;
        startFileId = listing.nextFileId;
      }
    },
  };
}

/**
 * An in-memory store, for tests only.
 *
 * Exported so the security properties of the managed path — authorization,
 * expiry, replacement, deletion — can be proven without a vendor account and
 * without putting a real identity document anywhere. It is never selected by
 * `evidenceStore`, so no deployment can reach it by configuration, which is
 * the point: a test double that production could pick up is a fake provider.
 */
export function memoryEvidenceStore({ now = () => Date.now() } = {}) {
  const objects = new Map();
  const grants = new Map();
  return {
    name: 'memory',
    async put({ operatorId, kind, bytes }) {
      const contentType = detectEvidenceType(bytes);
      // The key carries no personal data and is not guessable: naming an
      // object after the operator and the document kind would make one
      // reviewer's URL a template for everybody else's.
      const key = `evidence/${operatorId}/${kind}/${randomUUID()}`;
      objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
      return { key, contentType, byteSize: bytes.length };
    },
    async read(key, { ttlSeconds = EVIDENCE_READ_TTL_SECONDS } = {}) {
      invariant(objects.has(key), 'NOT_FOUND', 'Document not found.', 404);
      const token = randomUUID();
      const expiresAtMs = now() + ttlSeconds * 1000;
      grants.set(token, { key, expiresAtMs });
      return { url: `memory://evidence/${token}`, expiresAt: new Date(expiresAtMs).toISOString() };
    },
    async remove(key) { objects.delete(key); },
    /** Test-only: follow a grant the way a browser would. */
    resolve(url) {
      const grant = grants.get(String(url).split('/').pop());
      if (!grant || grant.expiresAtMs <= now()) return null;
      return objects.get(grant.key) ?? null;
    },
    has: key => objects.has(key),
  };
}
