#!/usr/bin/env node
// Installs effort-guard hooks.
//   node scripts/install.mjs <repo-dir>   -> <repo-dir>/.effort-guard-hooks/ + <repo-dir>/.github/hooks/effort-guard.json (shared with the team via git)
//   node scripts/install.mjs --user       -> ~/.copilot/effort-guard/ + ~/.copilot/hooks/effort-guard.json (personal, Copilot CLI and VS Code)
//   node scripts/install.mjs --user --uninstall   (or <repo-dir> --uninstall) removes the code and hook file it wrote, keeps the recorded state
//   --no-gitignore   (repo install) do not add .effort-guard/ to the repo's .gitignore
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, appendFileSync, rmSync, rmdirSync, existsSync } from 'node:fs'
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
const base = user ? (process.env.COPILOT_HOME ?? join(homedir(), '.copilot')) : resolve(target)
const codeDir = user ? join(base, 'effort-guard') : join(base, '.effort-guard-hooks')
const hooksDir = user ? join(base, 'hooks') : join(base, '.github', 'hooks')
const entry = user ? join(codeDir, 'effort-guard.mjs') : '.effort-guard-hooks/effort-guard.mjs'
const cmd = event => `node "${entry}" ${event}`

const SRC_FILES = ['effort-guard.mjs', 'detect.mjs', 'report.mjs', 'redact.mjs']
const CODE_FILES = [...SRC_FILES, 'package.json']

if (uninstall) {
  // Only what the installer wrote: for --user the state/ folders and events.log live
  // next to the code and are kept, so a later reinstall does not lose the history.
  for (const f of CODE_FILES) {
    rmSync(join(codeDir, f), { force: true })
  }
  try {
    rmdirSync(codeDir) // only succeeds when nothing else is in there
  } catch {}
  rmSync(join(hooksDir, 'effort-guard.json'), { force: true })
  const kept = user ? `${codeDir}${existsSync(codeDir) ? ' (state and events.log kept: delete the folder to remove them)' : ''}` : 'state in .effort-guard/ is left in place'
  console.log(`removed: the code and ${join(hooksDir, 'effort-guard.json')} (${kept})`)
  process.exit(0)
}

mkdirSync(codeDir, { recursive: true })
mkdirSync(hooksDir, { recursive: true })
for (const f of SRC_FILES) {
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
  console.log(`State is kept per working directory in ${join(codeDir, 'state')} (set EFFORT_GUARD_DIR to share one folder).`)
  if (existsSync(join(resolve(process.cwd()), '.github', 'hooks', 'effort-guard.json'))) {
    console.log('Warning: this folder also has .github/hooks/effort-guard.json: with both registered the hooks run twice per event.')
  }
} else if (!process.argv.includes('--no-gitignore')) {
  // The state is local: it must not end up in the team's repository.
  const ignore = join(base, '.gitignore')
  const current = existsSync(ignore) ? readFileSync(ignore, 'utf8') : ''
  if (!/^\/?\.effort-guard\/?\s*$/m.test(current)) {
    appendFileSync(ignore, `${current && !current.endsWith('\n') ? '\n' : ''}.effort-guard/\n`)
    console.log(`added .effort-guard/ to ${ignore} (use --no-gitignore to skip)`)
  }
}
