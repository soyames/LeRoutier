import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { serverConfig } from '../packages/config/src/index.js';
import { createDatabase } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrations.js';
import { seed } from '../packages/database/src/seed.js';
import { assertDisposableSchema, dropDisposableSchema, environmentLabel } from '../packages/database/src/guards.js';
import { createApi } from '../services/api/src/app.js';
import { nodeHandler } from '../services/api/src/node-handler.js';

// Live integration: real API, real PostgreSQL, real browsers.
//
// Each journey mutates the seeded service (booking, boarding, advancing), so
// every spec gets its own schema and its own API server. Sharing one schema
// made the second journey depend on where the first one left the service.
const PREVIEW_ORIGINS = [4173, 4174, 4175, 4176].flatMap(port => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
// Preview origins are granted explicitly so the live run does not depend on a
// developer's local CORS_ORIGINS. Production CORS is unaffected: this config
// exists only for these throwaway schemas and this in-process server.
const base = serverConfig();
const SPECS = ['tests/e2e/live.spec.js', 'tests/e2e/unified.live.spec.js'];

function reclaimPorts() {
  if (process.platform !== 'win32') return;
  spawnSync('powershell', ['-NoProfile', '-Command',
    'Get-NetTCPConnection -LocalPort 4000,4173,4174,4175,4176 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }'],
  { stdio: 'ignore' });
}

async function runSpec(spec) {
  const config = { ...base, schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true,
    corsOrigins: [...new Set([...base.corsOrigins, ...PREVIEW_ORIGINS])] };
  const db = createDatabase(config), server = createServer(nodeHandler(createApi(db, config)));
  try {
    // Prove the target before writing anything, and say so out loud. Schema and
    // environment label only — never a host or a connection string.
    assertDisposableSchema(db, { purpose: 'The live integration suite' });
    console.log(`Live suite target: schema=${db.schema} environment=${environmentLabel(db.schema)}`);
    await migrate(db); await seed(db);
    reclaimPorts();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(4000, resolve); });
    return await new Promise(resolve => {
      const child = spawn('pnpm', ['exec', 'playwright', 'test', '--config', 'playwright.live.config.js', spec],
        { stdio: 'inherit', shell: process.platform === 'win32' });
      child.on('close', resolve); child.on('error', () => resolve(1));
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    try { await dropDisposableSchema(db); }
    finally { await db.close(); }
  }
}

try {
  reclaimPorts();
  // The preview servers serve prebuilt bundles; rebuild with the local API URL
  // baked in. One build serves every spec.
  const built = spawnSync('pnpm', ['--filter', '@leroutier/passenger-web', '--filter', '@leroutier/driver-web',
    '--filter', '@leroutier/ops-web', '--filter', '@leroutier/web', 'build'],
  { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, VITE_API_URL: 'http://127.0.0.1:4000' } });
  if (built.status !== 0) throw new Error('Live e2e build failed.');
  let failures = 0;
  for (const spec of SPECS) failures += Number(await runSpec(spec)) === 0 ? 0 : 1;
  process.exitCode = failures ? 1 : 0;
} catch {
  console.error('Live integration test setup failed. No connection details logged.');
  process.exitCode = 1;
}
