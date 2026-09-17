import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {serverConfig} from '../packages/config/src/index.js';
import {createDatabase} from '../packages/database/src/index.js';
import {migrate} from '../packages/database/src/migrations.js';
import {seed,demo} from '../packages/database/src/seed.js';
import {dropDisposableSchema} from '../packages/database/src/guards.js';
import {routeGeometry} from '../packages/database/src/route-geometry.js';
import {createRouter} from '../packages/routing/src/index.js';
const config=serverConfig(),db=createDatabase({...config,schema:'lr_test_'+randomUUID().replaceAll('-','')});
try {
 await migrate(db);await seed(db);
 const router=createRouter({routing:{url:'http://127.0.0.1:5500',provider:'osrm-benin-local'}});
 const geo=routeGeometry(db,router),actor={id:demo.ops,role:'ops',operator_id:demo.operator};
 const result=await geo.generate(actor,demo.route);assert.equal(result.regenerated,true);
 const stored=await geo.read(demo.route);assert.ok(stored.coordinates.length>100);assert.ok(stored.durationS>0);assert.equal(stored.legs.length,3);
 assert.equal((await geo.generate(actor,demo.route)).regenerated,false);
 writeFileSync('.tmp/routing-drill.json',JSON.stringify({generatedAt:new Date().toISOString(),source:'Geofabrik Benin OSM extract; OSRM v6.0.0 car profile',...stored},null,2));
 console.log(JSON.stringify({distanceM:stored.distanceM,durationS:stored.durationS,points:stored.coordinates.length,legs:stored.legs,cacheReplay:'passed'}));
} finally {try{await dropDisposableSchema(db);}finally{await db.close();}}
