import { createServer } from 'node:http';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '@leroutier/database';
import { createApi } from './app.js';
import { nodeHandler } from './node-handler.js';

try {
  const config=serverConfig(),db=createDatabase(config);
  const server=createServer(nodeHandler(createApi(db,config)));
  server.listen(Number(process.env.PORT || 4000),'127.0.0.1',()=>console.log('LeRoutier API ready.'));
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>server.close(()=>db.close()));
} catch {console.error('API configuration is unavailable.');process.exitCode=1;}
