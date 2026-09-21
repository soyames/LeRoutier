import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// Never log matched text or raw process output. The reference stays outside the repo.
//
// Two layers, deliberately separated so this can also run in CI:
//
//   1. Pattern checks — always run, and are what catch a *new* leak: a tracked
//      .env file, a private key, a JWT, a database URL inside a browser bundle,
//      a VITE_ variable carrying a secret, a non-loopback local database URL.
//   2. Reference matching — compares against the owner's real credential file,
//      which exists only on their machine. Stronger, but unavailable in CI.
//
// Layer 1 never being skipped is the security property. Layer 2 is reported as
// used or skipped, so a passing run never overstates what it verified.

/** Values from the owner's out-of-repo credential file, or null when absent. */
function loadReference() {
  const explicit = process.env.SECRET_REFERENCE_FILE;
  const reference = explicit || path.join(os.homedir(), 'Downloads', 'leroutier-db.txt');
  // A reference inside the repository would itself be the leak.
  if (path.resolve(reference).startsWith(process.cwd() + path.sep)) {
    throw new Error('The secret reference file must live outside this repository.');
  }
  let raw;
  try {
    raw = fs.readFileSync(reference, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' && !explicit) return null;
    throw new Error('SECRET_REFERENCE_FILE was set but cannot be read.', { cause: error });
  }
  const values = new Set();
  for (const match of raw.matchAll(/postgres(?:ql)?:\/\/[^\s'"`<>]+/gi)) {
    const url = new URL(match[0]);
    for (const value of [match[0], url.toString(), url.username, url.password, url.hostname,
      decodeURIComponent(url.username), decodeURIComponent(url.password)]) if (value) values.add(value);
  }
  for (const line of raw.split(/\r?\n/)) {
    const pair = line.match(/^\s*(?:password|username|host|hostname|api[_ -]?key|token)\s*[:=]\s*['"]?(.+?)['"]?\s*$/i);
    if (pair?.[1]) values.add(pair[1]);
  }
  if (!values.size) throw new Error('The secret reference file yielded no values to match.');
  return values;
}

try {
  const reference = loadReference();
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' }).split('\0').filter(Boolean);
  let failures = 0, checked = 0;

  function scan(text, isBundle = false) {
    checked++;
    if (reference && [...reference].some(value => text.includes(value))) failures++;
    if (isBundle && (/postgres(?:ql)?:\/\//i.test(text) || /DATABASE_URL/.test(text))) failures++;
    if (/VITE_[A-Z_]*(?:DATABASE|DB_PASSWORD|NEON|SECRET)[A-Z_]*\s*=\s*[^\s]/.test(text)) failures++;
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) failures++;
    if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(text)) failures++;
    // A Google service account, however it was named. The Firebase Admin
    // credential is the one file that would turn a leak into full project
    // control, so it is matched by shape rather than by filename.
    if (/"type"\s*:\s*"service_account"/.test(text)) failures++;
    if (/"private_key(?:_id)?"\s*:\s*"/.test(text)) failures++;
    // An Application Default Credentials file. It is a real credential — the
    // refresh token inside it mints Gemini access tokens until revoked — and
    // it lives in a predictable place on every developer machine, so it is the
    // easiest of all of these to copy into a repo by accident.
    if (/"type"\s*:\s*"authorized_user"/.test(text)) failures++;
    if (/\bGOCSPX-[A-Za-z0-9_-]{10,}/.test(text)) failures++;
    // A Google OAuth refresh credential mints access tokens for as long as
    // nobody revokes it, and a live access token does the same for an hour.
    // Both are matched by shape, because neither has a filename to watch.
    if (/\b1\/\/[A-Za-z0-9_-]{20,}/.test(text)) failures++;
    if (/\bya29\.[A-Za-z0-9_-]{20,}/.test(text)) failures++;
    // Firebase Admin belongs to the server. Importing it into anything the
    // browser loads is how a service account ends up in a bundle.
    if (isBundle && /firebase-admin|googleapis\.com\/auth\/cloud-platform/.test(text)) failures++;
    // The Gemini credential is server-side configuration. Its *names* appearing
    // in a bundle would mean the server config module reached the browser,
    // which is the step before its values do.
    if (isBundle && /GOOGLE_GEMINI_|oauth2\.googleapis\.com\/token/.test(text)) failures++;
    // Application Default Credentials live at a predictable path on every
    // machine. A tracked file pointing at one is a file that will eventually
    // be read by something that should not read it.
    if (/gcloud[/\\]application_default_credentials\.json/.test(text)) failures++;
  }

  for (const file of files) {
    // No tracked file may begin with `.env`, whatever it contains. Absolute rule.
    if (/(?:^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.env.example')) { failures++; continue; }
    try {
      scan(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (!['ENOENT', 'EISDIR'].includes(error?.code)) throw error;
    }
  }

  // Derived from the apps directory rather than listed, so a new app — or the
  // canonical unified PWA — cannot be left unscanned by omission.
  let apps = [];
  try {
    apps = fs.readdirSync('apps', { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  function scanBundleDir(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) scanBundleDir(file);
      else if (entry.isFile()) scan(fs.readFileSync(file, 'utf8'), true);
    }
  }
  for (const app of apps) scanBundleDir(`apps/${app}/dist`);

  scan(execFileSync('git', ['diff', 'HEAD', '--no-ext-diff'], { encoding: 'utf8', maxBuffer: 30_000_000 }));
  scan(execFileSync('git', ['log', '--all', '-p', '--no-ext-diff'], { encoding: 'utf8', maxBuffer: 60_000_000 }));

  // Every environment file the project can produce must be ignored, or a
  // routine `git add -A` would commit it.
  for (const file of ['.env.local', 'services/api/.env.local', ...apps.map(app => `apps/${app}/.env.local`)]) {
    execFileSync('git', ['check-ignore', '--quiet', file]);
    checked++;
  }

  // The committed local-database file must stay local-only: if it ever grows a
  // remote host, the isolation this repository promises is gone.
  try {
    const postgresEnv = fs.readFileSync('docker/postgres.env', 'utf8');
    checked++;
    for (const match of postgresEnv.matchAll(/postgres(?:ql)?:\/\/[^\s'"`]+/gi)) {
      if (!['localhost', '127.0.0.1', '::1'].includes(new URL(match[0]).hostname)) failures++;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const mode = reference ? 'reference values and patterns' : 'patterns only (no local reference file)';
  if (failures) {
    console.error(`Secret scan failed: ${failures} unsafe content checks. Matched values withheld.`);
    process.exitCode = 1;
  } else {
    console.log(`Secret scan passed: ${checked} source, diff, history and bundle checks — ${mode}.`);
  }
} catch (error) {
  // Fail closed: an incomplete scan must never read as a clean one. The message
  // is the reason the scan could not run, never anything it matched.
  console.error(`Secret scan could not complete safely: ${error.message}`);
  process.exitCode = 1;
}
