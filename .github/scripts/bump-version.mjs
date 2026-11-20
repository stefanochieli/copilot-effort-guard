#!/usr/bin/env node
// Prepara il rilascio: nuova voce in CHANGELOG.md e versione allineata in package.json (radice e sottocartelle
// di primo livello, es. vscode-extension/) e in intellij-plugin/gradle.properties. NON fa commit.
// Uso: node .github/scripts/bump-version.mjs [patch|minor|major] [--set X.Y.Z] [--notes "testo"] [--root <dir>]
// Versione corrente: voce in testa al CHANGELOG, altrimenti ultimo tag v*, altrimenti 0.0.0.
// Note: --notes, altrimenti i subject dei commit dall'ultimo tag, raggruppati in Novita' (feat), Correzioni (fix), Altro.
// Multi-modulo Maven: usa la proprieta' <revision> (CI-friendly) oppure lancia "mvn versions:set" dopo il bump.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function fail(msg) { console.error(`bump-version: ${msg}`); process.exit(1); }

let ROOT = process.cwd();
let notes = null;
let kind = 'patch';
let explicit = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--notes') { notes = args[++i]; if (!notes) fail('--notes richiede un testo'); }
  else if (args[i] === '--root') ROOT = resolve(args[++i]);
  else if (args[i] === '--set') {
    explicit = args[++i];
    if (!/^\d+\.\d+\.\d+$/.test(explicit || '')) fail('--set richiede una versione X.Y.Z');
  } else if (['patch', 'minor', 'major'].includes(args[i])) kind = args[i];
  else fail(`argomento non riconosciuto: ${args[i]}`);
}

const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
const parse = (v) => [...v.split('.').map(Number), 0, 0].slice(0, 3);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const clPath = join(ROOT, 'CHANGELOG.md');
const changelog = existsSync(clPath) ? readFileSync(clPath, 'utf8') : '# Changelog\n\n';
const lastTag = (git('tag', '-l', 'v*', '--sort=-version:refname').stdout || '').split('\n').find(Boolean);
const topEntry = changelog.match(/^## \[(\d+(?:\.\d+)+)\]/m);
const cur = parse(topEntry ? topEntry[1] : lastTag ? lastTag.slice(1) : '0.0.0');

let next;
if (explicit) {
  if (cmp(parse(explicit), cur) <= 0) fail(`--set ${explicit} non e' maggiore della versione corrente ${cur.join('.')}`);
  next = explicit;
} else {
  const [maj, min, pat] = cur;
  next = kind === 'major' ? `${maj + 1}.0.0` : kind === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}

if (notes === null) {
  const range = lastTag ? [`${lastTag}..HEAD`] : ['-n', '30'];
  const log = git('log', ...range, '--no-merges', '--pretty=%s');
  if (log.status !== 0) fail('git log fallito');
  const subjects = log.stdout.split('\n').filter(Boolean);
  const groups = [['Novità', /^feat(\(.+\))?!?:\s*/], ['Correzioni', /^fix(\(.+\))?!?:\s*/], ['Altro', null]];
  const buckets = new Map(groups.map(([t]) => [t, []]));
  for (const s of subjects) {
    if (/^chore: release v\d/.test(s)) continue;
    const [title, re] = groups.find(([, r]) => r && r.test(s)) || groups.at(-1);
    buckets.get(title).push(`- ${re ? s.replace(re, '') : s}`);
  }
  notes = [...buckets].filter(([, l]) => l.length).map(([t, l]) => `### ${t}\n\n${l.join('\n')}`).join('\n\n');
  if (!notes) fail('nessun commit utile dall\'ultimo tag: usa --notes "testo"');
}

// CHANGELOG
const entry = `## [${next}] — ${new Date().toISOString().slice(0, 10)}\n\n${notes.trim()}\n\n`;
writeFileSync(clPath, /^## \[/m.test(changelog) ? changelog.replace(/^## \[/m, () => entry + '## [') : changelog.trimEnd() + '\n\n' + entry);

const touched = [];

// versione del plugin IntelliJ
const gp = join(ROOT, 'intellij-plugin', 'gradle.properties');
if (existsSync(gp)) {
  const t = readFileSync(gp, 'utf8');
  const u = t.replace(/^(pluginVersion\s*=\s*).*$/m, `$1${next}`);
  if (u !== t) { writeFileSync(gp, u); touched.push(gp); }
}

// package.json (radice + sottocartelle di primo livello)
const dirs = [ROOT, ...readdirSync(ROOT).filter((n) => !n.startsWith('.') && n !== 'node_modules' && n !== 'target')
  .map((n) => join(ROOT, n)).filter((p) => statSync(p).isDirectory())];
for (const d of dirs) {
  const pkg = join(d, 'package.json');
  if (existsSync(pkg)) {
    const t = readFileSync(pkg, 'utf8');
    const u = t.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`);
    if (u !== t) { writeFileSync(pkg, u); touched.push(pkg); }
  }
  const pom = join(d, 'pom.xml');
  if (existsSync(pom)) {
    const t = readFileSync(pom, 'utf8');
    let u = t.replace(/(<revision>)[^<]*(<\/revision>)/, `$1${next}$2`);
    if (u === t) {
      // <version> del progetto: primo <artifactId><version> dopo </parent> (o dopo <modelVersion>), prima di <dependencies>
      const start = Math.max(t.indexOf('</parent>'), t.indexOf('<modelVersion>'), 0);
      const deps = t.indexOf('<dependencies>', start);
      const m = /(<artifactId>[^<]*<\/artifactId>\s*<version>)[^<]*(<\/version>)/.exec(t.slice(start));
      if (m && (deps < 0 || start + m.index < deps)) {
        u = t.slice(0, start + m.index) + m[0].replace(/(<version>)[^<]*(<\/version>)/, `$1${next}$2`) + t.slice(start + m.index + m[0].length);
      }
    }
    if (u !== t) { writeFileSync(pom, u); touched.push(pom); }
  }
}
console.log(`bump-version: nuova versione ${next}. File aggiornati: CHANGELOG.md${touched.map((f) => ', ' + f.slice(ROOT.length + 1)).join('')}. Nessun commit eseguito.`);
