import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Documentation rots quietly. A link that 404s and a document nobody indexed
// both look fine in a diff and are both useless to the next reader, so they are
// checked mechanically rather than by remembering.
//
// Two rules:
//   1. Every relative link in a tracked markdown file must resolve.
//   2. Every document under docs/ must be reachable from docs/README.md.

const files = execFileSync('git', ['ls-files', '-z', '*.md'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const problems = [];

// Fenced code blocks contain example paths that are not links; strip them first.
const stripCode = text => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

for (const file of files) {
  const text = stripCode(fs.readFileSync(file, 'utf8'));
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim();
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const [pathPart] = target.split('#');
    if (!pathPart) continue;
    const resolved = path.resolve(path.dirname(file), pathPart);
    if (!fs.existsSync(resolved)) problems.push(`${file} → ${target} does not exist`);
  }
}

const INDEX = 'docs/README.md';
if (!fs.existsSync(INDEX)) {
  problems.push(`${INDEX} is missing — the documentation has no index`);
} else {
  const index = fs.readFileSync(INDEX, 'utf8');
  const linked = new Set([...index.matchAll(/\[[^\]]*\]\(([^)#]+)/g)]
    .map(m => path.resolve(path.dirname(INDEX), m[1].trim())));
  for (const file of files) {
    if (!file.startsWith('docs/') || file === INDEX) continue;
    if (!linked.has(path.resolve(file))) problems.push(`${file} is not listed in ${INDEX}`);
  }
}

if (problems.length) {
  console.error(`Documentation check failed:\n  - ${problems.join('\n  - ')}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation check passed: ${files.length} markdown files, every relative link resolves, every doc is indexed.`);
}
