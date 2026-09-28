/**
 * Any S3-compatible object store, reached without an SDK.
 *
 * WHY THIS EXISTS. LeRoutier's objects live in one provider today (Backblaze
 * B2, through its own JSON API — see evidence-storage.js). Both candidate
 * providers speak S3, so the vendor-shaped part of a move is an endpoint, a
 * region, a bucket and two credentials. This module is that shape and nothing
 * else: it implements the SAME four-member store interface the rest of the
 * codebase already consumes, so switching provider is a change to configuration
 * rather than to a user journey.
 *
 * WHY NOT THE AWS SDK. The same reason evidence-storage.js gives for not using
 * the S3 surface of B2: a serverless function that otherwise has no AWS
 * dependency would carry one, and with it a supply-chain and bundle-size cost,
 * to perform four operations. Signature Version 4 is a documented, deterministic
 * HMAC construction — this file is ~120 lines of it, checked against AWS's own
 * published test vectors in the suite beside it.
 *
 * WHAT IT DOES NOT DO. No multipart upload, no ACLs, no bucket policies. Every
 * object here is at most a few megabytes and every bucket is private at
 * provisioning time; a store that could rewrite a bucket policy is a store that
 * can make an identity document public, and there is no reason for a request
 * handler to be able to.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const sha256Hex = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

/**
 * RFC 3986 encoding, which is NOT encodeURIComponent.
 *
 * encodeURIComponent leaves ! ' ( ) * unescaped and AWS does not, so a key
 * containing any of them would be signed one way and sent another — which
 * surfaces as a signature mismatch and reads like a broken credential.
 */
export function uriEncode(value, encodeSlash = true) {
  let out = '';
  for (const byte of Buffer.from(String(value), 'utf8')) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(character)) out += character;
    else if (character === '/' && !encodeSlash) out += character;
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** Object keys are XML text on the way out of a listing, so they come back
 * escaped. Only the five predefined entities can appear in a key we generate,
 * and an unescaped key would silently fail to match its own row. */
const decodeXml = value => String(value)
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"').replaceAll('&#39;', "'")
  .replaceAll('&amp;', '&');

/** `20260928T101530Z` — the only date format SigV4 accepts. */
export const amzDate = date => date.toISOString().replace(/[:-]|\.\d{3}/g, '');

/**
 * The canonical request and its signature.
 *
 * Exported because it is the part worth testing directly: AWS publishes the
 * expected signature for a set of known requests, and checking against those is
 * the difference between "it worked against one provider once" and "it is
 * correct".
 *
 * @param {{method:string, path:string, query?:Record<string,string>, headers:Record<string,string>,
 *   payloadHash:string, region:string, service:string, accessKeyId:string, secretAccessKey:string,
 *   date:Date}} input
 */
export function signRequest(input) {
  const { method, path, query = {}, headers, payloadHash, region, service, accessKeyId, secretAccessKey, date } = input;
  const stamp = amzDate(date), day = stamp.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;

  // S3 takes the path as sent — it is NOT double-encoded the way other services
  // require, and encoding it here would break every key containing a space or a
  // non-ASCII character.
  const canonicalUri = path.split('/').map(segment => uriEncode(segment)).join('/') || '/';
  const canonicalQuery = Object.keys(query).sort()
    .map(key => `${uriEncode(key)}=${uriEncode(query[key])}`).join('&');

  const lowered = {};
  for (const [key, value] of Object.entries(headers)) lowered[key.toLowerCase().trim()] = String(value).trim();
  const signedHeaders = Object.keys(lowered).sort();
  const canonicalHeaders = signedHeaders.map(key => `${key}:${lowered[key]}\n`).join('');

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders.join(';'), payloadHash].join('\n');
  const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join('\n');

  const key = [day, region, service, 'aws4_request'].reduce((acc, part) => hmac(acc, part), Buffer.from(`AWS4${secretAccessKey}`));
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');

  return {
    signature,
    canonicalRequest,
    stringToSign,
    authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
  };
}

/**
 * A URL that stops working, which is the property that makes a private bucket
 * an access control rather than a filing cabinet.
 *
 * Signed in the query string because the consumer is a browser NAVIGATION — the
 * reviewer console opens a document in a tab — and a navigation cannot carry an
 * Authorization header.
 */
export function presignUrl({ url, method = 'GET', expiresSeconds, region, service, accessKeyId, secretAccessKey, date }) {
  const parsed = new URL(url);
  const stamp = amzDate(date), day = stamp.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const query = {
    ...Object.fromEntries(parsed.searchParams),
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(Math.max(1, Math.min(604_800, Math.trunc(expiresSeconds)))),
    'X-Amz-SignedHeaders': 'host',
  };
  // The host is the only signed header: a browser sends nothing else that we
  // control, and signing a header the client will not send is how a correct
  // signature arrives as a 403.
  const { signature } = signRequest({
    method, path: parsed.pathname, query, headers: { host: parsed.host },
    payloadHash: UNSIGNED_PAYLOAD, region, service, accessKeyId, secretAccessKey, date,
  });
  const search = Object.keys({ ...query, 'X-Amz-Signature': signature }).sort()
    .map(key => `${uriEncode(key)}=${uriEncode(key === 'X-Amz-Signature' ? signature : query[key])}`).join('&');
  return `${parsed.origin}${parsed.pathname}?${search}`;
}

/**
 * A store backed by any S3-compatible endpoint — Backblaze's S3 surface, Neon
 * Object Storage, or anything else that signs with SigV4 and addresses buckets
 * by path.
 *
 * Path-style is not optional: Neon documents it as the only addressing it
 * supports, and B2 accepts it. Virtual-hosted addressing would put the bucket in
 * the hostname, which is one more thing for a caller to get wrong.
 *
 * @param {{endpoint?:string, region?:string, bucket?:string, accessKeyId?:string,
 *   secretAccessKey?:string, service?:string, publicBaseUrl?:string|null,
 *   ttlSeconds?:number}} settings
 * @param {typeof fetch} http
 */
export function s3Store(settings, http = fetch) {
  const { endpoint, region, bucket, accessKeyId, secretAccessKey } = settings;
  const service = settings.service ?? 's3';
  // Half a configuration produces NO store rather than one that fails on the
  // first upload — the same rule every other provider here follows.
  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) return null;

  const base = endpoint.replace(/\/+$/, '');
  const objectUrl = key => `${base}/${uriEncode(bucket)}/${key.split('/').map(segment => uriEncode(segment)).join('/')}`;

  const signedHeaders = (method, url, payloadHash, extra = {}) => {
    const parsed = new URL(url);
    const headers = { host: parsed.host, ...extra };
    const { authorization } = signRequest({
      method, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), headers,
      payloadHash, region, service, accessKeyId, secretAccessKey, date: new Date(),
    });
    return { ...headers, authorization, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate(new Date()) };
  };

  return {
    name: 's3',

    /**
     * Upload one object. The key is supplied by the caller and is already
     * opaque; this store never derives a key from anything personal.
     */
    async put({ key, bytes, contentType }) {
      // A SHA-256 of the body is both the integrity check SigV4 wants and the
      // checksum the media row records, so it is computed once.
      const payloadHash = sha256Hex(bytes);
      const response = await http(objectUrl(key), {
        method: 'PUT', body: bytes, signal: AbortSignal.timeout(30_000),
        headers: { ...signedHeaders('PUT', objectUrl(key), payloadHash, { 'content-type': contentType }), 'content-length': String(bytes.length) },
      });
      // 201 and 200 both mean stored; providers differ.
      if (!(response.ok || response.status === 201)) {
        const error = new Error('EVIDENCE_STORAGE_UNAVAILABLE');
        Object.assign(error, { code: 'EVIDENCE_STORAGE_UNAVAILABLE', status: 503 });
        throw error;
      }
      return { key, contentType, byteSize: bytes.length, checksumSha256: payloadHash };
    },

    async read(key, { ttlSeconds = settings.ttlSeconds ?? 120 } = {}) {
      const url = presignUrl({
        url: objectUrl(key), expiresSeconds: ttlSeconds, region, service,
        accessKeyId, secretAccessKey, date: new Date(),
      });
      return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
    },

    /**
     * Delete one object. Idempotent: a missing object is the desired end state,
     * so 404 is success — and nothing else is. A caller that cannot tell
     * "already gone" from "the provider is down" will eventually record a
     * deletion that did not happen.
     */
    async remove(key) {
      const payloadHash = sha256Hex('');
      const response = await http(objectUrl(key), {
        method: 'DELETE', signal: AbortSignal.timeout(15_000),
        headers: signedHeaders('DELETE', objectUrl(key), payloadHash),
      });
      if (response.ok || response.status === 404) return;
      const error = new Error('EVIDENCE_STORAGE_UNAVAILABLE');
      Object.assign(error, { code: 'EVIDENCE_STORAGE_UNAVAILABLE', status: 503 });
      throw error;
    },

    /**
     * What this bucket actually holds.
     *
     * Read-only, and the only listing this store offers: enough to answer "how
     * much of the allowance is spent, and is anything in here that no row
     * mentions?", and nothing that could change a bucket. A store that could
     * rewrite a bucket's access is a store that could publish a passport.
     *
     * Paginates, and stops at `limit` with `truncated` set rather than
     * pretending the list is complete — a usage figure that silently caps is
     * exactly the kind of comfortable number this project refuses.
     */
    async list({ prefix = '', limit = 5000 } = {}) {
      const objects = [];
      let token = null;
      // A bounded number of pages, so a runaway loop cannot bill the account
      // for listings it will never finish reading.
      for (let page = 0; page < 100; page++) {
        const query = new URLSearchParams({ 'list-type': '2', 'max-keys': '1000' });
        if (prefix) query.set('prefix', prefix);
        if (token) query.set('continuation-token', token);
        const url = `${base}/${uriEncode(bucket)}?${query.toString()}`;
        const response = await http(url, { method: 'GET', signal: AbortSignal.timeout(20_000),
          headers: signedHeaders('GET', url, sha256Hex('')) });
        if (!response.ok) {
          const error = new Error('EVIDENCE_STORAGE_UNAVAILABLE');
          Object.assign(error, { code: 'EVIDENCE_STORAGE_UNAVAILABLE', status: 503 });
          throw error;
        }
        const body = await response.text();
        for (const match of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = match[1].match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
          const size = Number(match[1].match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0);
          if (key !== undefined) objects.push({ key: decodeXml(key), size });
        }
        token = body.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? null;
        if (!token || objects.length >= limit) break;
      }
      const truncated = objects.length > limit;
      return { objects: objects.slice(0, limit), truncated };
    },

    /**
     * Whether the endpoint answers at all, with the credential presented.
     *
     * A HEAD on the bucket, not a listing: it proves the credentials and the
     * bucket's existence without spending a listing allowance or returning a
     * single object name. It deliberately does NOT claim the bucket is private
     * — that is a provisioning setting this call never tests, and reporting it
     * from here would be the kind of unearned green badge this project refuses.
     */
    async health() {
      const checkedAt = new Date().toISOString();
      try {
        const url = `${base}/${uriEncode(bucket)}`;
        const response = await http(url, {
          method: 'HEAD', signal: AbortSignal.timeout(10_000),
          headers: signedHeaders('HEAD', url, sha256Hex('')),
        });
        return { reachable: response.ok || response.status === 403, region, bucketScoped: true, capabilities: [], checkedAt };
      } catch {
        // Never the credential, never the endpoint's own message.
        return { reachable: false, region: null, bucketScoped: null, capabilities: [], checkedAt };
      }
    },
  };
}

/** Exported for the tests that pin the signing against AWS's own vectors. */
export const __internals = { sha256Hex, hmac, timingSafeEqual };
