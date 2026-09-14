import { serverConfig } from '@leroutier/config';
import { createDatabase } from '@leroutier/database';
import { createApi } from '../src/app.js';
import { nodeHandler } from '../src/node-handler.js';
let handler;
export default async function api(req,res) {
  try {
    if(!handler) {const config=serverConfig();handler=nodeHandler(createApi(createDatabase(config),config));}
    return await handler(req,res);
  } catch {res.statusCode=503;res.end(JSON.stringify({error:{code:'UNAVAILABLE',message:'The service is temporarily unavailable.'}}));}
}
