// Outbound adapters must guarantee idempotency for the supplied delivery ID.
// A provider accepting a request is recorded as sent, not handset delivery.
export function notificationDelivery(db, adapters = {}) {
  return {
    async tick() {
      const claimed = await db.transaction(async tx => (await tx.query(`UPDATE notification_deliveries SET
        lease_until=now()+interval '2 minutes',attempts=attempts+1,updated_at=now()
        WHERE id IN (SELECT id FROM notification_deliveries WHERE status='pending'
          AND (next_attempt_at IS NULL OR next_attempt_at<=now()) AND (lease_until IS NULL OR lease_until<now())
          ORDER BY updated_at LIMIT 25 FOR UPDATE SKIP LOCKED) RETURNING *`)).rows);
      for (const delivery of claimed) {
        let status='unavailable', detail='provider_unavailable';
        const adapter=adapters[delivery.channel];
        if(delivery.channel==='in_app') { status='sent'; detail='inbox_available'; }
        else if(adapter?.idempotent===true && typeof adapter.send==='function') {
          try {
            const notification=await db.transaction(async tx=>(await tx.query('SELECT * FROM notifications WHERE id=$1',[delivery.notification_id])).rows[0]);
            const result=await adapter.send({notification,idempotencyKey:delivery.id});
            if(result?.accepted!==true) throw new Error('not accepted');
            status='sent'; detail='provider_accepted';
          } catch {status=delivery.attempts>=5?'failed':'pending';detail=status==='failed'?'dead_letter':'retry_scheduled';}
        }
        await db.transaction(async tx=>{
          await tx.query(`UPDATE notification_deliveries SET status=$2,detail=$3,lease_until=NULL,updated_at=now(),
            next_attempt_at=CASE WHEN $2='pending' THEN now()+make_interval(secs=>$4) ELSE NULL END WHERE id=$1`,
          [delivery.id,status,detail,Math.min(3600,30*2**delivery.attempts)]);
          await tx.query('INSERT INTO notification_delivery_attempts(delivery_id,status) VALUES($1,$2)',[delivery.id,detail]);
        });
      }
      return {processed:claimed.length};
    },
  };
}
