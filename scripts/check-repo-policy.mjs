import { execFileSync } from 'node:child_process';

// Repository policy: the docs/ directory is never tracked.
//
// Its history was removed deliberately, and reintroducing it silently would
// undo that decision in one clone before anyone noticed. This check runs in CI
// and in the local `pnpm repo:policy` gate, so a stray `git add docs/...`
// fails loudly instead of landing on main.
const tracked = execFileSync('git', ['ls-files', 'docs/**'], { encoding: 'utf8' })
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean);

if (tracked.length > 0) {
  console.error('Repository policy violation: files under docs/ must not be tracked.');
  for (const file of tracked) console.error(`  ${file}`);
  process.exit(1);
}
console.log('Repository policy: no tracked files under docs/.');
