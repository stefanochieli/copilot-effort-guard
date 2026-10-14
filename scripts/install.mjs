#!/usr/bin/env node
// Installs effort-guard hooks.
//   node scripts/install.mjs <repo-dir>   -> <repo-dir>/.effort-guard-hooks/ + <repo-dir>/.github/hooks/effort-guard.json (shared with the team via git)
//   node scripts/install.mjs --user       -> ~/.copilot/effort-guard/ + ~/.copilot/hooks/effort-guard.json (personal, Copilot CLI and VS Code)
//   node scripts/install.mjs --user --uninstall   (or <repo-dir> --uninstall) removes what the installer wrote
import { mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2]
const uninstall = process.argv.includes('--uninstall')

if (!target) {
  console.error('usage: node scripts/install.mjs <repo-dir> | --user')
  process.exit(1)
}

const user = target === '--user'
if (target === '--uninstall') {
  console.error('usage: node scripts/install.mjs <repo-dir> | --user [--uninstall]')
  process.exit(1)
}
const base = user ? join(homedir(), '.copilot') : resolve(target)
const codeDir = user ? join(base, 'effort-guard') : join(base, '.effort-guard-hooks')
const hooksDir = user ? join(base, 'hooks') : join(base, '.github', 'hooks')
const entry = user ? join(codeDir, 'effort-guard.mjs') : '.effort-guard-hooks/effort-guard.mjs'
const cmd = event => `node "${entry}" ${event}`

if (uninstall) {
  rmSync(codeDir, { recursive: true, force: true })
  rmSync(join(hooksDir, 'effort-guard.json'), { force: true })
  console.log(`removed: ${codeDir} and ${join(hooksDir, 'effort-guard.json')} (state in .effort-guard/ is left in place)`)
  process.exit(0)
}

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
if (user) {
  console.log('\nNext: restart Copilot CLI / reload VS Code, then check it with:')
  console.log(`  node "${entry}" doctor`)
  console.log('State is kept per working directory in .effort-guard/ (set EFFORT_GUARD_DIR to share one folder).')
}
