// Production smoke validation: strictly non-financial, non-destructive checks.
// Never charges money, never sends payouts, never mutates production data,
// never prints secrets. Usage: PROD_API_URL=... node scripts/prod-smoke.mjs
const api = (process.env.PROD_API_URL || 'https://le-routier-api.vercel.app').replace(/\/$/, '');
const apps = { passenger: 'https://le-routier-passenger.vercel.app', driver: 'https://le-routier-driver.vercel.app', ops: 'https://le-routier-ops.vercel.app' };
let checks = 0, failures = 0;
function ok(name, detail = '') { checks++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ''}`); }
function fail(name, detail) { checks++; failures++; console.log(`  FAIL  ${name} — ${detail}`); }
async function get(path, options = {}) {
  const response = await fetch(api + path, { redirect: 'manual', ...options });
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON bodies are fine for checks */ }
  return { response, body };
}
console.log(`Production smoke against ${api}`);
{
  const { response, body } = await get('/api/v1/health');
  response.status === 200 && body?.data?.status === 'ok' ? ok('API health') : fail('API health', `status ${response.status}`);
}
{
  const { response } = await get('/api/v1/health', { headers: { origin: 'https://untrusted.example.invalid' } });
  response.status === 403 ? ok('CORS rejects unapproved origins') : fail('CORS rejection', `status ${response.status}`);
}
{
  const { response, body } = await get('/api/v1/auth/config');
  if (response.status === 200 && body?.data && typeof body.data.demoLogin === 'boolean') {
    body.data.demoLogin === false ? ok('Auth config public; demo login disabled') : fail('Auth config', 'demo login enabled in production');
  } else fail('Auth config', `status ${response.status}`);
}
{
  const { response, body } = await get('/api/v1/payments/config');
  if (response.status === 200 && body?.data && typeof body.data.available === 'boolean' && typeof body.data.payouts?.available === 'boolean') {
    ok('Payments config flags', `collections=${body.data.available} payouts=${body.data.payouts.available}`);
  } else fail('Payments config', `status ${response.status}`);
}
{
  const response = await fetch(api + '/api/v1/webhooks/fedapay', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fedapay-signature': `t=${Math.floor(Date.now() / 1000)},s=${'f'.repeat(64)}` }, body: JSON.stringify({ id: 0, type: 'transaction.approved', entity: {} }) });
  [400, 401].includes(response.status) ? ok('Webhook rejects invalid signatures') : fail('Webhook signature rejection', `status ${response.status}`);
}
{
  const { response } = await get('/api/v1/public/parcel-tracking/LRP-00000000');
  response.status === 404 ? ok('Public tracking 404 for unknown numbers') : fail('Public tracking validation', `status ${response.status}`);
}
{
  const { response } = await get('/api/v1/services?originStopId=not-an-id&destinationStopId=not-an-id');
  response.status === 400 ? ok('Versioned route validation works') : fail('Route validation', `status ${response.status}`);
}
for (const [name, url] of Object.entries(apps)) {
  const response = await fetch(url);
  response.status === 200 ? ok(`App ${name} serves 200`) : fail(`App ${name}`, `status ${response.status}`);
}
console.log(`\nSmoke complete: ${checks - failures}/${checks} checks passed.`);
if (failures) process.exitCode = 1;
