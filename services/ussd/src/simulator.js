import readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '@leroutier/database';
import { transport } from '@leroutier/database/transport';
import { payments } from '@leroutier/database/payments';
import { parcels } from '@leroutier/database/parcels';
import { tracking } from '@leroutier/database/tracking';
import { createUssdEngine } from './engine.js';

// A USSD handset, at a terminal.
//
// Developing this channel must not require a telecom contract, a shortcode or
// a gateway account. This runs the real engine against the real local database,
// so what you see here is what a caller would see.
//
//   pnpm ussd:dev
//
// Commands: a menu number, `0` back, `00` quit, `#`/`*` to page,
// `:state` to inspect the session, `:new` to hang up and redial, `:quit`.

const config = serverConfig();
const db = createDatabase(config);
const engine = createUssdEngine({
  db,
  domain: transport(db),
  parcels: parcels(db),
  payments: payments(db),
  tracking: tracking(db),
  // The simulator is a development tool: it trusts its own MSISDN so the
  // identity-bound journeys can be exercised. Production decides this with
  // USSD_TRUST_PROVIDER_MSISDN, and only for a verified gateway.
  config: { ...(config.ussd ?? {}), trustProviderMsisdn: true },
});

const msisdn = process.argv.find(a => a.startsWith('--msisdn='))?.split('=')[1] ?? '+22961000001';
let sessionId = `sim-${randomUUID()}`;
const rl = readline.createInterface({ input: stdin, output: stdout });

const frame = ({ text, continues }) => {
  const width = Math.max(...text.split('\n').map(l => l.length), 20) + 2;
  const bar = '─'.repeat(width);
  return `┌${bar}┐\n${text.split('\n').map(l => `│ ${l.padEnd(width - 2)} │`).join('\n')}\n└${bar}┘`
    + (continues ? '' : '\n   (call ended)');
};

async function step(input) {
  const started = Date.now();
  const result = await engine.handle({ provider: 'sandbox', sessionId, msisdn, input, verified: true });
  console.log(`\n${frame(result)}`);
  console.log(`   ${result.text.length} chars · ${Date.now() - started} ms${result.replayed ? ' · replayed' : ''}`);
  return result;
}

try {
  console.log(`LeRoutier USSD simulator — ${msisdn}`);
  console.log('Commands: :state  :new  :quit\n');
  let live = await step('');

  for (;;) {
    const answer = (await rl.question('> ')).trim();
    if (answer === ':quit') break;

    if (answer === ':state') {
      const row = await db.transaction(async tx => (await tx.query(
        'SELECT flow, step, status, steps, user_id IS NOT NULL AS bound, expires_at FROM ussd_sessions WHERE provider_session_id=$1',
        [sessionId])).rows[0]);
      // The phone number is not shown because it is not stored.
      console.log(row ? JSON.stringify(row, null, 2) : '   (no session yet)');
      continue;
    }

    if (answer === ':new' || !live.continues) {
      if (!live.continues && answer !== ':new') console.log('   (the call ended — redialling)');
      sessionId = `sim-${randomUUID()}`;
      live = await step('');
      continue;
    }

    live = await step(answer);
  }
} finally {
  rl.close();
  await db.close();
}
