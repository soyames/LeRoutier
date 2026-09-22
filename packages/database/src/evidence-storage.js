/**
 * Where a verification document lives, and what LeRoutier may say about it.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * LeRoutier does not host KYC/KYB documents today. An operator supplies an
 * https link to a document they host themselves, and that link is what gets
 * stored, reviewed and — for the two deliberately public images — displayed.
 * That has a consequence which must never be glossed over in the product:
 *
 *   ACCESS TO THE DOCUMENT IS NOT SERVER-AUTHORIZED. Anybody holding the link
 *   can open it. LeRoutier cannot revoke it, cannot expire it, and cannot tell
 *   whether it was ever private in the first place.
 *
 * So this module is not "document storage". It is the boundary around the fact
 * that there is none: one place that decides what a document reference may
 * look like, and one place to replace when real private object storage arrives.
 * Everything else in the codebase goes through `documentReference`.
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
 * Replacing this: implement upload + signed short-lived read against a private
 * bucket, keep `documentReference` as the validator for whatever handle that
 * produces, and flip `EVIDENCE_STORAGE.managed` to true. Nothing outside this
 * module encodes the current arrangement.
 */
import { invariant } from '@leroutier/domain';

/**
 * What the platform can honestly say about document handling right now.
 * Surfaced to Platform Ops so the arrangement is visible rather than assumed,
 * and read by the product copy so no screen can promise more than this.
 */
export const EVIDENCE_STORAGE = {
  /** True only when LeRoutier holds the bytes and authorizes each read. */
  managed: false,
  mode: 'operator_hosted_link',
};

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
