#!/usr/bin/env node
// Gate per le PR verso main: la versione in testa a CHANGELOG.md deve essere nuova
// (nessun tag vX.Y.Z esistente) e maggiore dell'ultimo tag v*. Serve fetch-depth: 0.
// Uso: node .github/scripts/check-release-version.mjs [--root <dir>]
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const i = process.argv.indexOf('--root');
const ROOT = i > -1 ? resolve(process.argv[i + 1]) : process.cwd();
const top = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').match(/^## \[(\d+(?:\.\d+)+)\]/m);
if (!top) { console.error('check-release-version: nessuna voce "## [X.Y.Z]" in CHANGELOG.md'); process.exit(1); }
const version = top[1];
const parse = (v) => [...v.split('.').map(Number), 0, 0].slice(0, 3);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const r = spawnSync('git', ['tag', '-l', 'v*'], { cwd: ROOT, encoding: 'utf8' });
if (r.status !== 0) { console.error('check-release-version: git tag fallito'); process.exit(1); }
const tags = r.stdout.split('\n').filter(Boolean);
if (tags.includes(`v${version}`)) {
  console.error(`check-release-version: il tag v${version} esiste gia': lancia prepare-release.`);
  process.exit(1);
}
const parsed = tags.map((t) => t.match(/^v(\d+(?:\.\d+)+)$/)).filter(Boolean).map((m) => ({ text: m[1], n: parse(m[1]) }));
const last = parsed.sort((a, b) => cmp(a.n, b.n)).at(-1);
if (last && cmp(parse(version), last.n) <= 0) {
  console.error(`check-release-version: v${version} non e' maggiore dell'ultimo tag v${last.text}.`);
  process.exit(1);
}
console.log(`check-release-version: OK (v${version}${last ? `, ultimo tag v${last.text}` : ', nessun tag precedente'}).`);
