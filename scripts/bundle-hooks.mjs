#!/usr/bin/env node
// Copies the hooks and their installer into vscode-extension/hooks/, so the extension
// can install them (command "Effort Guard: Install hooks") without a clone of this repo.
// Run automatically by `vsce package` (vscode:prepublish); the output is not committed.
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'vscode-extension', 'hooks')
rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'src'), { recursive: true })
mkdirSync(join(out, 'scripts'), { recursive: true })
for (const f of readdirSync(join(root, 'src')).filter(f => f.endsWith('.mjs'))) {
  cpSync(join(root, 'src', f), join(out, 'src', f))
}
cpSync(join(root, 'scripts', 'install.mjs'), join(out, 'scripts', 'install.mjs'))
writeFileSync(join(out, 'package.json'), '{ "type": "module" }\n')
console.log(`hooks bundled in ${out}`)
