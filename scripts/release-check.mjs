import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';

// One command that answers: is this tree releasable?
//
// Two rules keep it honest:
//
//   1. A gate that could not run is reported as SKIPPED and fails the check.
//      "Nothing went red" is not the same as "everything was verified", and a
//      release gate that quietly shrinks when the database is down is worse
//      than no gate at all.
//   2. Nothing here writes to production. The database gates run against the
//      local container; production is only ever read by `smoke:prod`, which is
//      opt-in below.

const args = new Set(process.argv.slice(2));
const includeProdSmoke = args.has('--with-prod-smoke');

const PASS = 'PASS', FAIL = 'FAIL', SKIP = 'SKIPPED';
const results = [];

// Every gate is a package script, run as one shell string. Passing an argv
// array alongside `shell: true` is both deprecated and a quoting hazard, and
// an absolute interpreter path ("C:\Program Files\...") breaks on the space.
function gate(name, script, { needs = () => null } = {}) {
  const blocker = needs();
  if (blocker) { results.push({ name, status: SKIP, detail: blocker }); return; }
  const started = Date.now();
  const proc = spawnSync(`pnpm run ${script}`, { stdio: 'inherit', shell: true });
  const seconds = Math.round((Date.now() - started) / 1000);
  results.push({ name, status: proc.status === 0 ? PASS : FAIL, detail: `${seconds}s` });
}

/** The local database container has to be reachable for the database gates. */
function databaseReady() {
  if (!fs.existsSync('docker/postgres.env')) return 'docker/postgres.env is missing';
  try {
    execFileSync('docker', ['compose', 'ps', '--status=running', '--format', '{{.Service}}'], { encoding: 'utf8' })
      .includes('postgres') || (() => { throw new Error(); })();
    return null;
  } catch { return 'the local database is not running — `pnpm docker:up`'; }
}

console.log('LeRoutier release check\n');

gate('Lint', 'lint');
gate('Typecheck', 'typecheck');
gate('Build', 'build');
gate('Unit tests', 'test:unit');
gate('API tests', 'test:api');
gate('Browser tests', 'test:frontend');
gate('Migration from empty', 'test:migrate:fresh', { needs: databaseReady });
gate('Database tests', 'test:database:local', { needs: databaseReady });
gate('Live journeys', 'test:live:local', { needs: databaseReady });
gate('Load, profile and restore drill', 'test:operations', { needs: databaseReady });
gate('Dependency audit', 'security:audit');
gate('Secret scan', 'secrets:check');

// Production is read-only here and never part of the default gate: a release
// check must be runnable before the thing it checks has been released.
if (includeProdSmoke) gate('Production smoke (read-only)', 'smoke:prod');

const width = Math.max(...results.map(r => r.name.length));
console.log('\n' + '─'.repeat(width + 24));
for (const r of results) console.log(`  ${r.status.padEnd(8)} ${r.name.padEnd(width)}  ${r.detail}`);
console.log('─'.repeat(width + 24));

const failed = results.filter(r => r.status === FAIL);
const skipped = results.filter(r => r.status === SKIP);
if (failed.length) console.error(`\n${failed.length} gate(s) failed: ${failed.map(r => r.name).join(', ')}`);
if (skipped.length) console.error(`\n${skipped.length} gate(s) could not run, so this tree is NOT verified: ${skipped.map(r => r.name).join(', ')}`);
if (!failed.length && !skipped.length) console.log('\nAll gates passed.');
process.exitCode = failed.length || skipped.length ? 1 : 0;
