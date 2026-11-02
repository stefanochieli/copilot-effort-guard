'use strict'
// Pure logic of the status bar item (no vscode import, so it is testable with node --test).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function copilotHome(setting, env = process.env) {
  return setting || env.COPILOT_HOME || path.join(os.homedir(), '.copilot')
}

// Reads every ~/.copilot/effort-guard/state/<hash>/state.json written by the hooks.
function readProjects(home) {
  const root = path.join(home, 'effort-guard', 'state')
  let dirs = []
  try {
    dirs = fs.readdirSync(root)
  } catch {
    return []
  }
  const out = []
  for (const d of dirs) {
    try {
      out.push({ dir: path.join(root, d), state: JSON.parse(fs.readFileSync(path.join(root, d, 'state.json'), 'utf8')) })
    } catch {}
  }
  return out
}

function norm(p) {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:/i.test(s) || p?.includes?.('\\') ? s.toLowerCase() : s
}

function isInside(cwd, folder) {
  const c = norm(cwd)
  const f = norm(folder)
  return c === f || c.startsWith(f + '/')
}

// State of the open workspace: the most recently used project whose cwd is the
// workspace folder or a subfolder of it (the CLI may be started in a subfolder).
function findState(projects, folders) {
  const matches = projects.filter(p => p.state.cwd && folders.some(f => isInside(p.state.cwd, f)))
  matches.sort((a, b) => String(b.state.updated ?? '').localeCompare(String(a.state.updated ?? '')))
  return matches[0] ?? null
}

// level: idle (no data), ok, watch (some struggle), warn (threshold reached).
function computeView(state, fallbackThreshold = 3) {
  if (!state) {
    return { level: 'idle', text: '$(pulse) effort -', tooltip: 'Effort Guard: no data for this folder yet. Use Copilot agent mode or the CLI here.' }
  }
  const threshold = state.threshold || fallbackThreshold
  const streak = state.streak || 0
  const level = streak >= threshold ? 'warn' : streak > 0 || state.turn?.struggled ? 'watch' : 'ok'
  const log = state.log ?? []
  const struggled = log.filter(e => e.struggled).length
  const lines = [
    `Effort Guard: ${streak}/${threshold} struggling turns in a row`,
    `Turns logged: ${log.length}, struggling: ${struggled}`,
  ]
  if (state.turn?.struggled) {
    lines.push(`Current turn: struggling (${state.turn.reason})`)
  }
  if (level === 'warn') {
    lines.push('Consider switching to a stronger model or more reasoning effort.')
  }
  return { level, text: `$(${level === 'warn' ? 'warning' : 'pulse'}) effort ${streak}/${threshold}`, tooltip: lines.join('\n') }
}

// True when the streak has just reached the threshold since the previous check.
function shouldNotify(prev, cur, fallbackThreshold = 3) {
  if (!cur) return false
  const threshold = cur.threshold || fallbackThreshold
  const before = prev?.streak || 0
  return (cur.streak || 0) >= threshold && before < threshold
}

function formatReport(projects, now = Date.now()) {
  if (!projects.length) return 'No state recorded yet. Run Copilot with the hooks installed.'
  const sorted = [...projects].sort((a, b) => String(b.state.updated ?? '').localeCompare(String(a.state.updated ?? '')))
  return sorted
    .map(p => {
      const s = p.state
      const log = s.log ?? []
      const age = s.updated ? `${Math.round((now - new Date(s.updated)) / 60000)} min ago` : '-'
      return `${s.cwd ?? p.dir}\n  turns ${log.length}, struggling ${log.filter(e => e.struggled).length}, streak ${s.streak ?? 0}/${s.threshold ?? 3}, last activity ${age}`
    })
    .join('\n\n')
}

module.exports = { copilotHome, readProjects, findState, computeView, shouldNotify, formatReport, isInside }
