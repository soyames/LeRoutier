// Read a deployment's readiness and say plainly whether its database matches
// the code it is running.
//
// The same question the post-deploy workflow asks, available by hand — before
// a migration to see the drift, after one to confirm it closed. Reads a public
// endpoint, so it needs no credential and reveals none: counts and a state
// word, never a filename, never SQL, never a host.
//
//   pnpm check:ready                       # production
//   pnpm check:ready http://localhost:4000 # a local API
const base = (process.argv[2] ?? 'https://api.leroutier.app').replace(/\/$/, '');
const url = `${base}/api/v1/health/ready`;

const ADVICE = {
  behind: 'The deployed code expects migrations this database has not applied. '
    + 'Authenticated requests may fail until they are. Run the migration against the target schema.',
  drift: 'An applied migration no longer matches the file it came from, or a declared table is absent. '
    + 'Do not deploy further until this is understood — migrating will refuse.',
  ahead: 'The database holds migrations this build does not declare, which usually means a rollback. '
    + 'Serviceable, because migrations are additive, but worth confirming it was deliberate.',
  unreachable: 'The API is answering but cannot reach its database.',
};

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const data = (await response.json())?.data;
  if (!data) {
    console.error(`No readiness payload from ${base}. HTTP ${response.status}.`);
    console.error('A build that predates /health/ready answers 401 here rather than a payload.');
    process.exitCode = 1;
  } else {
    const { schema, ready, database, migrations, commit } = data;
    console.log(`service   : ${data.service}`);
    console.log(`database  : ${database}`);
    console.log(`schema    : ${schema}`);
    console.log(`migrations: ${migrations.applied ?? '?'} applied / ${migrations.declared} declared`
      + `${migrations.pending ? ` · ${migrations.pending} pending` : ''}`);
    if (commit) console.log(`commit    : ${commit}`);
    console.log('');
    if (!ready) {
      console.error(`NOT READY — ${ADVICE[schema] ?? 'Schema state is not serviceable.'}`);
      process.exitCode = 1;
    } else if (schema !== 'current') {
      console.log(`Serviceable, with a note: ${ADVICE[schema]}`);
    } else {
      console.log('Ready: the database matches the code this deployment is running.');
    }
  }
} catch (error) {
  // process.exit() while a fetch handle is still closing trips a libuv
  // assertion on Windows, so this sets the code and lets Node unwind normally.
  console.error(`Could not read readiness from ${base}: ${error.name}.`);
  process.exitCode = 1;
}
