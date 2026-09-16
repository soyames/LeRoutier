// Where "this provider is out of quota" is remembered.
//
// The API is serverless. An in-process cooldown is forgotten the moment the
// instance is recycled, and the *next* instance cheerfully calls a provider
// that has already said no — which is how a rate limit becomes a rate-limit
// storm. So the window lives in the database, where every instance can see it.
//
// It holds no PII and no credential: a provider name, a timestamp, and a reason
// code.

/**
 * A cooldown shared by every instance.
 * @param {{ transaction: (run: (tx: any) => Promise<any>) => Promise<any> }} db
 */
export function databaseCooldownStore(db) {
  return {
    /** When this provider may be used again, or null. */
    async until(provider) {
      const row = await db.transaction(async tx => (await tx.query(
        'SELECT until_at FROM agent_model_cooldowns WHERE provider=$1 AND until_at > now()', [provider])).rows[0]);
      return row ? new Date(row.until_at).getTime() : null;
    },

    /**
     * Start (or extend) a cooldown. Never shortens one: two instances failing
     * at once must not let the second one's shorter window overwrite the
     * first's longer one.
     */
    async enter(provider, untilMs, reason) {
      await db.transaction(tx => tx.query(
        `INSERT INTO agent_model_cooldowns(provider,until_at,reason) VALUES($1,to_timestamp($2/1000.0),$3)
         ON CONFLICT(provider) DO UPDATE
           SET until_at=GREATEST(agent_model_cooldowns.until_at, EXCLUDED.until_at),
               reason=EXCLUDED.reason, updated_at=now()`,
        [provider, untilMs, reason]));
    },

    /** Used when a provider answers again, so a stale window does not linger. */
    async clear(provider) {
      await db.transaction(tx => tx.query('DELETE FROM agent_model_cooldowns WHERE provider=$1', [provider]));
    },
  };
}

/**
 * The same contract without a database — for tests, and for a local model.
 * The signatures match the database store exactly, including the `reason` it
 * has no use for: two implementations of one interface that disagree about
 * their arguments is a bug waiting for whichever one is swapped in later.
 */
export function memoryCooldownStore() {
  /** @type {Map<string, {until: number, reason: string}>} */
  const windows = new Map();
  return {
    async until(provider) {
      const entry = windows.get(provider);
      return entry && entry.until > Date.now() ? entry.until : null;
    },
    async enter(provider, untilMs, reason) {
      windows.set(provider, { until: Math.max(windows.get(provider)?.until ?? 0, untilMs), reason });
    },
    async clear(provider) { windows.delete(provider); },
  };
}
