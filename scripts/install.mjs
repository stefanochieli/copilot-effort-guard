#!/usr/bin/env node
// Installs effort-guard hooks.
//   node scripts/install.mjs <repo-dir>   -> <repo-dir>/.effort-guard-hooks/ + <repo-dir>/.github/hooks/effort-guard.json (shared with the team via git)
//   node scripts/install.mjs --user       -> ~/.copilot/effort-guard/ + ~/.copilot/hooks/effort-guard.json (personal, Copilot CLI)
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2]

if (!target) {
  console.error('usage: node scripts/install.mjs <repo-dir> | --user')
  process.exit(1)
}

const user = target === '--user'
const base = user ? join(homedir(), '.copilot') : resolve(target)
const codeDir = user ? join(base, 'effort-guard') : join(base, '.effort-guard-hooks')
const hooksDir = user ? join(base, 'hooks') : join(base, '.github', 'hooks')
const entry = user ? join(codeDir, 'effort-guard.mjs') : '.effort-guard-hooks/effort-guard.mjs'
const cmd = event => `node "${entry}" ${event}`

mkdirSync(codeDir, { recursive: true })
mkdirSync(hooksDir, { recursive: true })
for (const f of ['effort-guard.mjs', 'detect.mjs']) {
  copyFileSync(join(root, 'src', f), join(codeDir, f))
}
// The copied files are ES modules even when the host repo is not.
writeFileSync(join(codeDir, 'package.json'), '{ "type": "module" }\n')

const hook = event => [{ type: 'command', bash: cmd(event), powershell: cmd(event), timeoutSec: 10 }]
const config = {
  version: 1,
  hooks: {
    userPromptSubmitted: hook('prompt'),
    postToolUse: hook('tool'),
    postToolUseFailure: hook('failure'),
    errorOccurred: hook('failure'),
  },
}
writeFileSync(join(hooksDir, 'effort-guard.json'), JSON.stringify(config, null, 2) + '\n')
console.log(`installed: ${codeDir}\nconfig:    ${join(hooksDir, 'effort-guard.json')}`)
