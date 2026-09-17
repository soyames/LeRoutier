import {readdir} from 'node:fs/promises';
import {invariant} from '@leroutier/domain';

export function operationalHealth(db) {
  return {
    async record(signal) {
      if(!['api_error','webhook_rejected','gps_anomaly'].includes(signal))return;
      await db.transaction(async tx=>{
        await tx.query(`INSERT INTO operational_signals(signal) VALUES($1)
          ON CONFLICT(minute,signal) DO UPDATE SET count=operational_signals.count+1`,[signal]);
      }).catch(()=>{}); // DB failure remains visible through 503 and safe logs.
    },
    async read(actor) {
      invariant(actor?.role==='ops' && !actor.operator_id,'FORBIDDEN','Platform Operations access required.',403);
      const expected=(await readdir(new URL('../migrations/',import.meta.url))).filter(f=>/^\d+.*\.sql$/.test(f)).length;
      return db.transaction(async tx=>{
        const counts=(await tx.query(`SELECT
          (SELECT count(*) FROM schema_migrations)::integer AS migrations,
          (SELECT count(*) FROM notification_deliveries WHERE status='failed')::integer AS notification_failed,
          (SELECT count(*) FROM notification_deliveries WHERE status='unavailable')::integer AS notification_unavailable,
          (SELECT count(*) FROM outbox WHERE dispatch_dead_at IS NOT NULL)::integer AS dispatch_dead,
          (SELECT count(*) FROM agent_model_cooldowns WHERE until_at>now())::integer AS model_cooldowns,
          (SELECT count(*) FROM agent_model_calls WHERE status='rejected' AND created_at>now()-interval '1 day')::integer AS model_rejected,
          (SELECT count(*) FROM route_geometry_failures WHERE created_at>now()-interval '1 day')::integer AS routing_failed`)).rows[0];
        const signals=(await tx.query("SELECT signal,sum(count)::integer AS count FROM operational_signals WHERE minute>now()-interval '15 minutes' GROUP BY signal")).rows;
        return {database:'ok',migrations:{applied:counts.migrations,expected,matched:counts.migrations===expected},
          signals,counts,pool:db.poolStats?.()??null,alertTransport:'internal_ops_only'};
      });
    },
  };
}
