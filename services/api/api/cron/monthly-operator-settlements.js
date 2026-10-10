import { serverConfig } from '@leroutier/config';
import { createDatabase } from '@leroutier/database';
import { operatorSettlements } from '@leroutier/database/operator-settlements';
import { schemaStatus } from '@leroutier/database/migrations';
import { paymentAdapter } from '../../src/payment-adapter.js';

export default async function monthlyOperatorSettlements(req,res) {
  const secret=process.env.CRON_SECRET;
  if(!secret || req.method!=='GET' || req.headers.authorization!==`Bearer ${secret}`) {
    res.statusCode=401;
    return res.end(JSON.stringify({error:'Unauthorized'}));
  }
  let db;
  try {
    const config=serverConfig();
    db=createDatabase(config);
    if((await schemaStatus(db)).status!=='current')throw new Error('Migration validation required.');
    const result=await operatorSettlements(db,paymentAdapter(config)).runMonthly();
    res.statusCode=200;
    res.setHeader('content-type','application/json; charset=utf-8');
    return res.end(JSON.stringify(result));
  } catch {
    console.error(JSON.stringify({event:'monthly_operator_settlement_failed'}));
    res.statusCode=503;
    res.setHeader('content-type','application/json; charset=utf-8');
    return res.end(JSON.stringify({error:'Monthly settlement job failed.'}));
  } finally {
    if(db)await db.close();
  }
}
