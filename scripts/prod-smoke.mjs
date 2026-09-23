// Production smoke validation: strictly non-financial, non-destructive checks.
// Never charges money, never sends payouts, never mutates production data,
// never prints secrets. Usage: PROD_API_URL=... node scripts/prod-smoke.mjs
const stripTrailingSlash = value => value.endsWith('/') ? value.slice(0, -1) : value;
const api = stripTrailingSlash(process.env.PROD_API_URL || 'https://api.leroutier.app');
const unified = stripTrailingSlash(process.env.PROD_APP_URL || 'https://leroutier.app');
let checks = 0, failures = 0;
function ok(name, detail = '') { checks++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ''}`); }
function fail(name, detail) { checks++; failures++; console.log(`  FAIL  ${name} — ${detail}`); }
function cspHasSource(csp, directive, source) {
  const parts = csp.split(';').map(entry => entry.trim().split(/\s+/)).find(tokens => tokens[0] === directive);
  return Boolean(parts?.slice(1).includes(source));
}
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
  response.headers.get('x-content-type-options')==='nosniff' && response.headers.get('x-frame-options')==='DENY'
    ? ok('API security headers') : fail('API security headers','missing protections');
}
{
  const { response } = await get('/api/v1/health', { headers: { origin: 'https://untrusted.example.invalid' } });
  response.status === 403 ? ok('CORS rejects unapproved origins') : fail('CORS rejection', `status ${response.status}`);
}
{
  const { response, body } = await get('/api/v1/auth/config');
  if (response.status === 200 && body?.data && typeof body.data.demoLogin === 'boolean') {
    body.data.demoLogin === false ? ok('Auth config public; demo login disabled') : fail('Auth config', 'demo login enabled in production');
    body.data.firebase?.projectId && body.data.firebase?.apiKey && body.data.firebase?.authDomain && body.data.firebase?.appId
      ? ok('Firebase public configuration populated') : fail('Firebase public configuration','missing identifiers');
    // Google sign-in stays hidden in production until GOOGLE_AUTH_ENABLED=true
    // is set on the API. The published provider list is what the login UI
    // renders from — empty means e-mail/password only.
    Array.isArray(body.data.firebase?.providers) && !body.data.firebase.providers.includes('google')
      ? ok('Google provider hidden in production config') : fail('Auth config','google provider still published');
    // The browser pins the branded auth origin itself; no localhost value may
    // ever be served as the auth domain, and no value may leak server-side
    // material.
    const payload = JSON.stringify(body.data.firebase ?? {});
    /localhost|127\.0\.0\.1/.test(payload)
      ? fail('Auth config', 'a localhost auth value is shipped to production browsers')
      : ok('Auth config carries no localhost values');
  } else fail('Auth config', `status ${response.status}`);
}
for (const path of ['/privacy','/terms','/legal','/cancellations','/cookies']) {
  const response=await fetch(unified+path);
  response.status===200 ? ok(`Legal route ${path}`) : fail(`Legal route ${path}`,`status ${response.status}`);
}
{
  // The custom authDomain proxy: leroutier.app serves Firebase's auth helper
  // for the SAME project, without Firebase Hosting or any billing. The SPA
  // rewrite must never swallow it — handler, iframe and the helper scripts
  // are all part of the SDK's redirect and popup flows.
  for (const path of ['/__/auth/handler','/__/auth/iframe','/__/auth/handler.js']) {
    const response=await fetch(unified+path);
    const text=await response.text();
    const notSpa=!text.includes('id="root"') && text.length>0;
    response.status===200 && notSpa
      ? ok(`Firebase auth helper proxied: ${path}`) : fail('Firebase auth helper proxy',`${path} status ${response.status} spa=${!notSpa}`);
  }
}
{
  // The apex is the ONE authoritative auth origin: Google returns to
  // https://leroutier.app/__/auth/handler. The platform's apex→www redirect,
  // while it exists, must preserve the callback (308 keeps the query string)
  // and must never turn the handler into the app shell.
  const response=await fetch(unified+'/__/auth/handler',{redirect:'follow'});
  const text=await response.text();
  response.status===200 && text.length>200 && !text.includes('id="root"')
    ? ok('Auth handler reachable through the apex→www chain') : fail('Auth handler apex chain',`status ${response.status}`);
}
{
  // The installed PWA's service worker is revalidated on every launch: an
  // app that cannot be told about a new auth implementation would stay broken
  // forever on phones that installed the old one.
  const response=await fetch(unified+'/sw.js',{redirect:'follow'});
  const cacheControl=response.headers.get('cache-control') ?? '';
  /max-age=0/.test(cacheControl)
    ? ok('Service worker revalidated on every launch') : fail('Service worker cache headers',`cache-control: ${cacheControl}`);
}
{
  // The pinned auth origin must be allowed from either branded host: with the
  // apex as the auth domain, the helper iframe/popup URL is apex even when
  // the app itself serves on www.
  const response=await fetch(unified+'/');
  const csp=response.headers.get('content-security-policy') ?? '';
  cspHasSource(csp, 'frame-src', "'self'") && cspHasSource(csp, 'frame-src', 'https://accounts.google.com')
    && cspHasSource(csp, 'frame-src', 'https://*.leroutier.app')
    ? ok('PWA CSP allows the auth iframe and Google from either branded host') : fail('PWA CSP','auth iframe origins missing');
}
{
  const {response,body}=await get('/api/v1/services');
  response.status===200 && Array.isArray(body?.data) ? ok('Public trip search') : fail('Public trip search',`status ${response.status}`);
  if(Array.isArray(body?.data)) {
    body.data.every(s=>!s.is_demo && !/TEST|DEMO/i.test(`${s.route_name} ${s.operator_name}`)) ? ok('No TEST inventory in public discovery',`${body.data.length} public services`) : fail('TEST isolation','synthetic service visible');
    if(!body.data.length) console.log('  INFO  Real booking/payment journeys unavailable: no production services. No inventory created.');
  }
}
{
  const {response,body}=await get('/api/v1/services?testMode=1');
  response.status===200 && Array.isArray(body?.data) && body.data.every(s=>!s.is_demo)
    ? ok('Anonymous testMode cannot expose TEST services') : fail('TEST query isolation',`status ${response.status}`);
}
{
  const {response,body}=await get('/api/v1/places?q=Cotonou');
  response.status===200 && Array.isArray(body?.data) && body.data.some(p=>p.name==='Cotonou')
    ? ok('Geography search') : fail('Geography search',`status ${response.status}`);
}
{
  const {response,body}=await get('/api/v1/journey-plan?originPlaceId=00000000-0000-4000-b000-000000000181&destinationPlaceId=00000000-0000-4000-b000-000000000145');
  response.status===200 && body?.data ? ok('Valid journey planning') : fail('Journey planning',`status ${response.status}`);
}
for(const path of ['/me','/driver/service','/ops/fleet','/ops/health','/me/bookings']) {
  const {response,body}=await get('/api/v1'+path);
  response.status===401 && body?.error?.code==='UNAUTHORIZED' ? ok('Anonymous rejected: '+path) : fail('Protected '+path,`status ${response.status}`);
  !/postgres|DATABASE_URL|stack|node_modules|Bearer /i.test(JSON.stringify(body)) ? ok('Sanitized response: '+path) : fail('Error privacy',path);
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
{
  const response = await fetch(unified);
  response.status === 200 ? ok('Unified PWA serves 200') : fail('Unified PWA', `status ${response.status}`);
}
{
  // One installable PWA, branded LeRoutier rather than per role.
  const response = await fetch(unified + '/manifest.webmanifest');
  let manifest = null;
  try { manifest = await response.json(); } catch { /* reported as a failure below */ }
  manifest?.name === 'LeRoutier' && manifest.start_url === '/' && manifest.scope === '/' && manifest.icons?.length >= 2
    ? ok('Unified PWA manifest installable', `${manifest.icons.length} icons`)
    : fail('Unified PWA manifest', `status ${response.status}`);
}
{
  // Deep links must survive a refresh through the SPA rewrite.
  const response = await fetch(unified + '/work/today');
  response.status === 200 ? ok('Unified deep link survives refresh') : fail('Unified deep link', `status ${response.status}`);
}
{
  // The app reaches the API on its own origin, so no CORS entry is needed.
  const { response, body } = await (async () => {
    const r = await fetch(unified + '/api/v1/health');
    let b = null; try { b = await r.json(); } catch { /* non-JSON handled below */ }
    return { response: r, body: b };
  })();
  response.status === 200 && body?.data?.status === 'ok'
    ? ok('Unified same-origin API proxy') : fail('Unified same-origin API proxy', `status ${response.status}`);
}
console.log(`\nSmoke complete: ${checks - failures}/${checks} checks passed.`);
if (failures) process.exitCode = 1;
