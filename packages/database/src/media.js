// The registry of every file LeRoutier holds, and the rules for reaching one.
//
// A caller never learns a provider, a bucket or an object key. It receives a
// LeRoutier media id, and it receives a URL only when it has been authorized to
// open that specific file, only briefly, and only from a store that can be
// pointed at a different provider without the caller noticing.
//
// Three properties are load-bearing and each is checked by a test beside this
// file:
//
//   The id is ours. `med_…` is generated here, never derived from a vendor, and
//   is what business tables and client state reference. Nothing outside this
//   module may persist a provider URL as a canonical reference, because a URL
//   that escapes into a table is a link that cannot be revoked or re-pointed.
//
//   Authorization precedes the URL, not the download. A short-lived grant is
//   issued only after the caller has been shown to own the file or to hold a
//   role that may review it, and every such decision is audited.
//
//   The object is removed before the row is cleared. The other order leaves
//   bytes in a bucket with nothing in the database to find them by — see
//   privacy.js, which applies the same rule to verification evidence.
import { createHash, randomBytes } from 'node:crypto';
import { invariant } from '@leroutier/domain';
import { detectEvidenceType, MAX_EVIDENCE_BYTES } from './evidence-storage.js';
import { audit } from './identities.js';
import { s3Store } from './s3-storage.js';

/** Largest single upload. A photograph or a scanned proof; nothing here is a video. */
export const MAX_MEDIA_BYTES = MAX_EVIDENCE_BYTES;

/** How long a granted URL stays usable. Short enough to be a single look. */
export const MEDIA_READ_TTL_SECONDS = 120;

/** The purposes a file may be stored for — the same closed list the schema enforces. */
export const MEDIA_PURPOSES = ['operator_kyc', 'driver_kyc', 'vehicle_document', 'driver_photo',
  'vehicle_photo', 'parcel_delivery_evidence', 'parcel_pickup_evidence', 'incident_evidence'];

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * A fresh, opaque, immutable media id.
 *
 * 26 base32 characters is 130 bits — far past guessing, and short enough to
 * appear in a URL. Generated here rather than by the database so the value a
 * client holds is the one the application chose, and so a media id can be
 * minted before a row exists (an upload that fails still has a name).
 */
export function newMediaId() {
  const bytes = randomBytes(17);
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  while (out.length < 26) out += ALPHABET[0];
  return `med_${out.slice(0, 26)}`;
}

/** The one object key shape. Opaque, partitioned by owner, never personal. */
const objectKeyFor = (ownerUserId, mediaId) => `media/${ownerUserId}/${mediaId}`;

/**
 * The registry.
 *
 * @param {{transaction:Function}} db
 * @param {{name:string, put:Function, read:Function, remove:Function}|null} store
 * @param {{bucket?:string|null, active?:string|null}} [config]
 */
export function mediaService(db, store, config = {}) {
  const bucket = config.bucket ?? 'media';
  const rows = async (tx, sql, args = []) => (await tx.query(sql, args)).rows;

  /**
   * Which store holds a given row's bytes.
   *
   * A single store is the normal case and is accepted directly. The map form is
   * what makes a provider cutover safe: during a migration, old rows still name
   * the provider that holds them, new rows name the new one, and each read goes
   * to the right place. Without this, moving providers would mean moving every
   * object in one step or breaking the ones left behind.
   */
  const stores = store && typeof store.put === 'function' ? { [store.name]: store } : (store ?? {});
  const activeName = config.active ?? (store && typeof store.put === 'function' ? store.name : null);
  /** The store new writes go to. Null when nothing is configured. */
  const active = activeName ? stores[activeName] ?? null : null;
  const storeFor = row => stores[row?.provider] ?? null;

  /**
   * May this caller reach this file?
   *
   * Ownership first, because it is the common case and the cheapest. Then the
   * two review roles: a platform identity with a capability that covers the
   * purpose, and the operator the file belongs to. Anything else is refused
   * with the same 404 a missing id produces, so probing for which ids exist
   * tells a stranger nothing.
   */
  function authorize(actor, row, { forWrite = false } = {}) {
    invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
    if (row.owner_user_id === actor.id) return 'owner';
    const capabilities = Array.isArray(actor.platform_capabilities) ? actor.platform_capabilities : [];
    const isPlatform = actor.role === 'ops' && !actor.operator_id;
    if (isPlatform && capabilities.some(capability => ['superadmin', 'verification', 'operations', 'system'].includes(capability))) {
      // A platform identity may READ what it reviews. It may NOT delete another
      // person's file from here: removal is a retention decision, and the
      // retention engine owns that ordering and its own audit.
      if (!forWrite) return 'platform';
    }
    // A transport company's own staff, for files belonging to their operator.
    // Scoped by the column, never by anything the caller supplied.
    if (!forWrite && row.operator_id && actor.operator_id === row.operator_id && ['ops', 'driver'].includes(actor.role)) return 'operator';
    invariant(false, 'NOT_FOUND', 'Ce fichier est introuvable.', 404);
  }

  /** One live row by its public id, or nothing. */
  const liveByMediaId = (tx, mediaId) => rows(tx, 'SELECT * FROM media WHERE media_id=$1 AND status <> \'deleted\'', [mediaId]).then(found => found[0]);

  return {
    /** Where this deployment puts objects, or null when nothing is configured. */
    provider: activeName,
    available: Boolean(active),
    bucket,

    /**
     * Store one file, and register it.
     *
     * The row is written BEFORE the object, and confirmed after. That ordering
     * is deliberate: an upload that dies mid-flight leaves a `pending` row
     * pointing at nothing, which reconciliation can find and clean — the
     * reverse would leave bytes in a bucket that no row mentions, which nothing
     * can find at all.
     *
     * @param {{id:string, role?:string, operator_id?:string|null, platform_capabilities?:string[]}} actor
     * @param {{purpose:string, bytes:Uint8Array,
     *   associations?:{subjectUserId?:string, operatorId?:string, parcelId?:string, vehicleId?:string}}} input
     */
    async upload(actor, input = /** @type {any} */({})) {
      const { purpose, bytes, associations = {} } = input;
      invariant(active, 'EVIDENCE_STORAGE_UNAVAILABLE',
        'Le stockage privé n’est pas configuré sur ce déploiement.', 503);
      invariant(MEDIA_PURPOSES.includes(purpose), 'INVALID_MEDIA', 'Type de fichier non pris en charge.');
      invariant(bytes && bytes.length > 0, 'INVALID_MEDIA', 'Le fichier est vide.');
      invariant(bytes.length <= MAX_MEDIA_BYTES, 'INVALID_MEDIA',
        'Le fichier dépasse la taille maximale de 8 Mo.', 413);
      // The declared content type is the uploader's claim; these are the file's
      // own first bytes. An SVG announced as image/png is still a scripted page
      // when a reviewer opens it.
      const contentType = detectEvidenceType(bytes);
      const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
      const mediaId = newMediaId();
      const key = objectKeyFor(actor.id, mediaId);

      const rowId = await db.transaction(async tx => (await tx.query(
        `INSERT INTO media(media_id,owner_user_id,subject_user_id,purpose,provider,bucket,object_key,
            content_type,byte_size,checksum_sha256,visibility,status,operator_id,parcel_id,vehicle_id,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'private','pending',$11,$12,$13,$2) RETURNING id`,
        [mediaId, actor.id, associations.subjectUserId ?? actor.id, purpose, activeName, bucket, key,
          contentType, bytes.length, checksumSha256, associations.operatorId ?? null,
          associations.parcelId ?? null, associations.vehicleId ?? null])).rows[0].id);

      // The provider call is OUTSIDE any transaction: an upload can be slow and
      // a transaction held open across it is a lock held across it.
      let stored;
      try {
        stored = await active.put({ key, bytes, contentType });
      } catch (error) {
        // Recorded, not swallowed, and deliberately left `pending` so the
        // failure is visible to reconciliation rather than being a silence.
        await db.transaction(async tx => tx.query('UPDATE media SET updated_at=now() WHERE id=$1', [rowId])).catch(() => {});
        throw error;
      }

      await db.transaction(async tx => {
        await tx.query('UPDATE media SET status=\'stored\', byte_size=$2, checksum_sha256=$3, updated_at=now() WHERE id=$1',
          [rowId, stored.byteSize ?? bytes.length, stored.checksumSha256 ?? checksumSha256]);
        // Audited against the row's uuid, with the public id in the details —
        // the audit stream keys on uuids, and a trail that cannot name the
        // thing it audited would not be a trail.
        await audit(tx, actor.id, 'media.stored', rowId, associations.operatorId ?? null, { purpose, mediaId });
      });

      return { id: mediaId, contentType, byteSize: bytes.length, checksumSha256 };
    },

    /** Everything a caller may see about one file, without a URL. */
    async describe(actor, mediaId) {
      const row = await db.transaction(async tx => liveByMediaId(tx, mediaId));
      invariant(row, 'NOT_FOUND', 'Ce fichier est introuvable.', 404);
      const reason = authorize(actor, row);
      return { id: row.media_id, purpose: row.purpose, contentType: row.content_type, byteSize: Number(row.byte_size),
        visibility: row.visibility, status: row.status, createdAt: row.created_at, authorizedAs: reason };
    },

    /**
     * A short-lived URL, issued only after authorization.
     *
     * The URL is the access control — without it the object is unreachable —
     * which is the whole reason a private bucket differs from an operator-hosted
     * link that anybody holding it can open forever.
     */
    async grant(actor, mediaId, { ttlSeconds = MEDIA_READ_TTL_SECONDS } = {}) {
      const row = await db.transaction(async tx => liveByMediaId(tx, mediaId));
      invariant(row, 'NOT_FOUND', 'Ce fichier est introuvable.', 404);
      // A file marked public_read needs no ownership check — that is what the
      // mark means — but it still receives a grant minted HERE rather than a
      // bare bucket URL, so expiry and revocation apply to it too.
      const reason = row.visibility === 'public_read' ? 'public' : authorize(actor, row);
      // The row names its own provider, so a record left behind by a part-done
      // migration still opens from where its bytes actually are.
      const target=storeFor(row);
      invariant(target, 'EVIDENCE_STORAGE_UNAVAILABLE',
        'Le stockage privé n’est pas configuré sur ce déploiement.', 503);
      invariant(row.status === 'stored', 'MEDIA_NOT_STORED',
        'Ce fichier n’est pas disponible pour le moment.', 409);
      const grant = await target.read(row.object_key, { ttlSeconds });
      // That a file was opened, by whom, and for what — never the address that
      // was handed out.
      if (reason !== 'public') {
        await db.transaction(async tx => audit(tx, actor.id, 'media.opened', row.id, row.operator_id,
          { purpose: row.purpose, mediaId: row.media_id }));
      }
      return { ...grant, contentType: row.content_type, byteSize: Number(row.byte_size), authorizedAs: reason };
    },

    /**
     * Forget one file: the object first, the row second.
     *
     * The other order leaves bytes in a bucket with nothing in the database to
     * find them by, which is the one outcome a deletion must never produce. If
     * the store cannot be reached the row is left alone and the caller is told,
     * because recording that LeRoutier forgot something it still holds is worse
     * than the delay.
     */
    async remove(actor, mediaId) {
      return db.transaction(async tx => {
        // Deliberately NOT the live-only lookup: deleting something already
        // deleted is the desired end state, so it must succeed rather than
        // report a missing file. Authorization still runs first, so a stranger
        // learns nothing from the difference.
        const row = (await rows(tx, 'SELECT * FROM media WHERE media_id=$1', [mediaId]))[0];
        invariant(row, 'NOT_FOUND', 'Ce fichier est introuvable.', 404);
        authorize(actor, row, { forWrite: true });
        if (row.status === 'deleted') return { id: row.media_id, status: 'deleted' };
        await tx.query('SELECT id FROM media WHERE id=$1 FOR UPDATE', [row.id]);
        const target=storeFor(row);
        if (target && row.status === 'stored') await target.remove(row.object_key);
        await tx.query('UPDATE media SET status=\'deleted\', updated_at=now(), deleted_at=now() WHERE id=$1', [row.id]);
        await audit(tx, actor.id, 'media.deleted', row.id, row.operator_id, { purpose: row.purpose, mediaId: row.media_id });
        return { id: row.media_id, status: 'deleted' };
      });
    },

    /**
     * The files attached to one domain entity.
     *
     * Ids and descriptions only — never a key, never a URL. Whether a document
     * exists is list information; where it lives is not.
     */
    async forParcel(parcelId) {
      return db.transaction(async tx => (await rows(tx, `SELECT media_id,purpose,content_type,byte_size,status
        FROM media WHERE parcel_id=$1 AND status <> 'deleted' ORDER BY created_at`, [parcelId]))
        .map(row => ({ id: row.media_id, purpose: row.purpose, contentType: row.content_type,
          byteSize: Number(row.byte_size), status: row.status })));
    },

    /** The same, for a vehicle's documents and photographs. */
    async forVehicle(vehicleId) {
      return db.transaction(async tx => (await rows(tx, `SELECT media_id,purpose,content_type,byte_size,status
        FROM media WHERE vehicle_id=$1 AND status <> 'deleted' ORDER BY created_at`, [vehicleId]))
        .map(row => ({ id: row.media_id, purpose: row.purpose, contentType: row.content_type,
          byteSize: Number(row.byte_size), status: row.status })));
    },

    /** Everything a person owns, for their own account screen. */
    async mine(actor) {
      return db.transaction(async tx => (await rows(tx, `SELECT media_id,purpose,content_type,byte_size,visibility,status,created_at
        FROM media WHERE owner_user_id=$1 AND status <> 'deleted' ORDER BY created_at DESC LIMIT 200`, [actor.id]))
        .map(row => ({ id: row.media_id, purpose: row.purpose, contentType: row.content_type,
          byteSize: Number(row.byte_size), visibility: row.visibility, status: row.status, createdAt: row.created_at })));
    },

    /**
     * Reconciliation: what the registry claims that does not match reality.
     *
     * Not a repair — a report. Rows left `pending` are uploads that died; rows
     * `missing` are objects a store has lost. Both need a human or a scheduled
     * job, and neither should be discovered by a passenger.
     */
    async anomalies({ limit = 200 } = {}) {
      return db.transaction(async tx => (await rows(tx, `SELECT media_id,purpose,provider,status,created_at,updated_at
        FROM media WHERE status <> 'stored' ORDER BY created_at LIMIT $1`, [limit]))
        .map(row => ({ id: row.media_id, purpose: row.purpose, provider: row.provider,
          status: row.status, createdAt: row.created_at, updatedAt: row.updated_at })));
    },
  };
}

/**
 * An in-memory store, for tests only.
 *
 * Exported so the properties that matter about the registry — authorization,
 * expiry, deletion ordering, checksums — can be proven without a vendor account
 * and without putting a real document anywhere. It is never returned by
 * `mediaStore`, so no deployment can select it by configuration: a test double
 * that production could pick up is a fake provider.
 */
export function memoryMediaStore({ now = () => Date.now(), failPut = false, failRemove = false } = {}) {
  const objects = new Map(), grants = new Map();
  return {
    name: 'memory',
    async put({ key, bytes, contentType }) {
      // A way to make an upload fail on demand, so the abandoned-row path is
      // exercised rather than assumed.
      if (failPut) { const error = new Error('unavailable'); Object.assign(error, { code: 'EVIDENCE_STORAGE_UNAVAILABLE' }); throw error; }
      objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
      return { key, contentType, byteSize: bytes.length, checksumSha256: createHash('sha256').update(bytes).digest('hex') };
    },
    async read(key, { ttlSeconds = MEDIA_READ_TTL_SECONDS } = {}) {
      invariant(objects.has(key), 'NOT_FOUND', 'Ce fichier est introuvable.', 404);
      const token = randomBytes(8).toString('hex');
      grants.set(token, { key, expiresAtMs: now() + ttlSeconds * 1000 });
      return { url: `memory://media/${token}`, expiresAt: new Date(now() + ttlSeconds * 1000).toISOString() };
    },
    async remove(key) {
      if (failRemove) { const error = new Error('unavailable'); Object.assign(error, { code: 'EVIDENCE_STORAGE_UNAVAILABLE' }); throw error; }
      objects.delete(key);
    },
    /** Test-only: follow a grant the way a browser would. */
    resolve(url) {
      const grant = grants.get(String(url).split('/').pop());
      if (!grant || grant.expiresAtMs <= now()) return null;
      return objects.get(grant.key) ?? null;
    },
    has: key => objects.has(key),
    keys: () => [...objects.keys()],
  };
}

/**
 * Which store this deployment uses, or none.
 *
 * Absent configuration is a supported state — nothing here pretends a file can
 * be stored when nothing can hold it. An unknown provider fails closed rather
 * than silently using a weaker one.
 */
export function mediaStore(config = {}, http = fetch) {
  const settings = config.mediaStorage ?? {};
  if (!settings.provider) return null;
  // Backblaze's S3 surface and Neon Object Storage are the same code path with
  // different coordinates, which is the entire point of the interface.
  if (settings.provider === 'neon' || settings.provider === 'b2' || settings.provider === 's3') {
    return s3Store(settings.s3 ?? {}, http);
  }
  invariant(false, 'EVIDENCE_STORAGE_UNAVAILABLE',
    `Le fournisseur de stockage « ${String(settings.provider).slice(0, 40)} » n’est pas implémenté.`, 503);
}
