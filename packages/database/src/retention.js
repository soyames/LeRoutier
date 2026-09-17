// Raw vehicle history expires, while unresolved incidents and explicit audit
// holds preserve evidence. Purging is bounded and opt-in; never runs on reads.
export function gpsRetention(db, { days = 30 } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('GPS retention must be 1–365 days.');
  return {
    async run({ dryRun = true } = {}) {
      return db.transaction(async tx => {
        const candidates = await tx.query(`SELECT p.id FROM vehicle_positions p JOIN services s ON s.id=p.service_id
          WHERE p.observed_at < now()-make_interval(days=>$1)
            AND s.status IN ('completed','cancelled')
            AND (s.gps_retain_until IS NULL OR s.gps_retain_until < now())
            AND NOT EXISTS(SELECT 1 FROM incidents i WHERE i.service_id=s.id AND i.status<>'resolved')
          ORDER BY p.observed_at LIMIT 5000 FOR UPDATE OF p SKIP LOCKED`, [days]);
        if (!dryRun && candidates.rowCount) await tx.query('DELETE FROM vehicle_positions WHERE id=ANY($1::uuid[])', [candidates.rows.map(r=>r.id)]);
        return { dryRun, eligible:candidates.rowCount, deleted:dryRun?0:candidates.rowCount, days };
      });
    },
  };
}
