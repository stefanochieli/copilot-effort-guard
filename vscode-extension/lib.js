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

// Starts the evaluation again for one project folder (same effect as `effort-guard reset`).
function resetProject(dir, now = new Date()) {
  const file = path.join(dir, 'state.json')
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  const next = {
    ...state,
    turn: { struggled: false, reason: null, command: null },
    streak: 0,
    calm: 0,
    pendingWarning: null,
    started: true,
    resetAt: now.toISOString(),
  }
  const tmp = `${file}.${process.pid}.ext.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next))
  fs.renameSync(tmp, file) // atomic: the hooks never read a half-written file
  return next
}

// 'vscode-chat' -> Chat, 'cli' / 'cli@vscode' -> CLI.
function sessionKind(source) {
  return String(source ?? '').startsWith('cli') ? 'CLI' : source === 'vscode-chat' ? 'Chat' : null
}

const LEVEL_LABEL = { idle: 'No data yet', ok: 'All good', calm: 'Very smooth', watch: 'Some struggle', warn: 'Struggling' }
// Theme colour ids (work in light and dark themes) and a hex fallback for the webview.
const LEVEL_THEME_COLOR = { ok: 'testing.iconPassed', calm: 'charts.blue', watch: 'editorWarning.foreground', warn: 'editorError.foreground' }
const LEVEL_HEX = { idle: '#8b949e', ok: '#3fb950', calm: '#58a6ff', watch: '#d29922', warn: '#f85149' }

function levelOf(state, fallbackThreshold = 3) {
  if (!state) return 'idle'
  const threshold = state.threshold || fallbackThreshold
  const streak = state.streak || 0
  const calmThreshold = state.calmThreshold || 8
  if (streak >= threshold) return 'warn'
  if (streak > 0 || state.turn?.struggled) return 'watch'
  return (state.calm || 0) >= calmThreshold ? 'calm' : 'ok'
}

// Text bar for the status bar: one segment per allowed struggling turn (max 10).
function textBar(streak, threshold) {
  const segments = Math.min(Math.max(threshold, 1), 10)
  const filled = Math.min(streak, segments)
  return '\u25B0'.repeat(filled) + '\u25B1'.repeat(segments - filled)
}

// level: idle (no data), ok, calm (long clean run: task may be easy), watch (some struggle), warn (threshold reached).
function computeView(state, fallbackThreshold = 3) {
  if (!state) {
    return { level: 'idle', label: LEVEL_LABEL.idle, text: '$(pulse) effort -', tooltip: 'Effort Guard: no data for this folder yet. Use Copilot agent mode or the CLI here.', segments: fallbackThreshold, filled: 0, streak: 0, threshold: fallbackThreshold, calm: 0, calmThreshold: 8, timeline: [], hint: null }
  }
  const threshold = state.threshold || fallbackThreshold
  const streak = state.streak || 0
  const calm = state.calm || 0
  const calmThreshold = state.calmThreshold || 8
  const level = levelOf(state, fallbackThreshold)
  const log = state.log ?? []
  const struggled = log.filter(e => e.struggled).length
  const lines = [
    `Effort Guard: ${streak}/${threshold} struggling turns in a row`,
    `Turns logged: ${log.length}, struggling: ${struggled}`,
  ]
  if (state.turn?.struggled) {
    lines.push(`Current turn: struggling (${state.turn.reason})`)
  }
  const messages = adviceMessages(streak, threshold, calm)
  // action: what to do with the model settings right now.
  const action = level === 'warn' ? (streak >= threshold * 2 ? 'model-up' : 'thinking-up') : level === 'calm' ? 'down' : null
  const kind = sessionKind(state.session?.source)
  const tag = kind ? ` (${kind} session)` : ''
  const base = action === 'model-up' ? messages.escalate : action === 'thinking-up' ? messages.warn : action === 'down' ? messages.calm : null
  const hint = base ? base + tag : null
  if (hint) lines.push(hint)
  const icon = level === 'warn' ? 'warning' : level === 'calm' ? 'check' : 'pulse'
  return {
    level,
    label: LEVEL_LABEL[level],
    text: `$(${icon}) ${textBar(streak, threshold)} ${streak}/${threshold}`,
    tooltip: lines.join('\n'),
    message: hint ? `Effort Guard: ${hint}` : null,
    messages,
    action,
    segments: Math.min(Math.max(threshold, 1), 10),
    filled: Math.min(streak, Math.min(Math.max(threshold, 1), 10)),
    streak,
    threshold,
    calm,
    calmThreshold,
    timeline: log.slice(-24).map(e => Boolean(e.struggled)),
    hint,
    session: state.session ?? null,
    kind,
    sessions: (state.sessions ?? []).map(x => ({ kind: sessionKind(x.source), source: x.source, id: x.id, last: x.last })),
    resetAt: state.resetAt ?? null,
    cwd: state.cwd ?? null,
    updated: state.updated ?? null,
  }
}

const ACTION_BADGE = { 'thinking-up': '\u2191 Raise thinking', 'model-up': '\u2191\u2191 Upgrade model', down: '\u2193 Downgrade' }

// The advice for each situation, in the order the user should try it.
function adviceMessages(streak, threshold, calm) {
  return {
    warn: `${Math.max(streak, threshold)} struggling turns in a row: raise the thinking / reasoning effort, the task may need more deliberation.`,
    escalate: `${Math.max(streak, threshold * 2)} struggling turns in a row, more thinking did not help: switch to a more powerful model.`,
    calm: `${calm} clean turns in a row, the task looks easy: downgrade to a lighter model or lower the thinking effort to save tokens.`,
  }
}

// Fixed per process: a new nonce on every render would reload the panel each time.
const NONCE = Math.random().toString(36).slice(2)

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function ageText(iso, now = Date.now()) {
  if (!iso) return '-'
  const s = Math.max(0, Math.round((now - new Date(iso)) / 1000))
  if (Number.isNaN(s)) return '-'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

// HTML of the side panel: a segmented bar that changes colour with the model's effort level.
function renderHtml(view, now = Date.now()) {
  const color = LEVEL_HEX[view.level]
  const segs = Array.from({ length: view.segments }, (_, i) => `<span class="seg${i < view.filled ? ' on' : ''}"></span>`).join('')
  const dots = view.timeline.length
    ? view.timeline.map(st => `<span class="dot ${st ? 'bad' : 'good'}"></span>`).join('')
    : '<span class="muted">no turns yet</span>'
  const session = view.session ? `${esc(view.session.source)} / ${esc(view.session.id)}` : '-'
  const badge = view.action ? `<span class="badge">${esc(ACTION_BADGE[view.action] + (view.kind ? ' \u00b7 ' + view.kind : ''))}</span>` : ''
  const sessions = (view.sessions ?? [])
    .map((x, i) => `<li>${i === 0 ? '<b>' : ''}${esc(x.kind ?? x.source)} / ${esc(x.id)}${i === 0 ? '</b> (latest)' : ''} <span class="muted">${esc(ageText(x.last, now))}</span></li>`)
    .join('')
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${NONCE}';">
<style>
  :root { --c: ${color}; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px 12px; }
  .level { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
  .level b { font-size: 1.25em; color: var(--c); }
  .count { opacity: .75; }
  .badge { background: var(--c); color: #0d1117; border-radius: 10px; padding: 1px 8px; font-size: .8em; font-weight: 600; }
  .bar { display: flex; gap: 4px; margin: 6px 0 12px; }
  .seg { flex: 1; height: 14px; border-radius: 3px; background: var(--vscode-input-background, #3338); border: 1px solid var(--vscode-widget-border, #8884); }
  .seg.on { background: var(--c); border-color: var(--c); }
  .calm { height: 6px; border-radius: 3px; background: var(--vscode-input-background, #3338); margin: 2px 0 12px; overflow: hidden; }
  .calm i { display: block; height: 100%; width: ${Math.min(100, Math.round((view.calm / Math.max(view.calmThreshold, 1)) * 100))}%; background: ${LEVEL_HEX.calm}; }
  h4 { margin: 12px 0 4px; font-weight: 600; opacity: .8; text-transform: uppercase; font-size: .75em; letter-spacing: .04em; }
  .timeline { display: flex; flex-wrap: wrap; gap: 3px; }
  .dot { width: 10px; height: 10px; border-radius: 2px; }
  .dot.good { background: ${LEVEL_HEX.ok}; }
  .dot.bad { background: ${LEVEL_HEX.warn}; }
  .hint { margin-top: 12px; padding: 8px; border-left: 3px solid var(--c); background: var(--vscode-textBlockQuote-background, #8881); }
  .muted { opacity: .65; font-size: .9em; }
  button { margin-top: 12px; width: 100%; padding: 6px; border: 0; border-radius: 3px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  ul { margin: 4px 0; padding-left: 18px; line-height: 1.5; }
  .meta { margin-top: 12px; line-height: 1.5; }
</style></head><body>
<div class="level"><b>${esc(view.label)}</b>${badge}<span class="count">${view.streak}/${view.threshold} struggling turns in a row</span></div>
<div class="bar">${segs}</div>
<h4>Clean run (${view.calm}/${view.calmThreshold})</h4>
<div class="calm"><i></i></div>
<h4>Last turns</h4>
<div class="timeline">${dots}</div>
${view.hint ? `<div class="hint">${esc(view.hint)}</div>` : ''}
${sessions ? `<h4>Sessions in this folder</h4><ul>${sessions}</ul><div class="muted">Streaks are counted per folder, shared by these sessions.</div>` : ''}
<button id="reset" title="Use it after changing model or thinking effort">Reset after changing model / thinking</button>
<div class="meta muted">Session: ${session}<br>Folder: ${esc(view.cwd ?? '-')}<br>Last activity: ${esc(ageText(view.updated, now))}</div>
<script nonce="${NONCE}">const vs = acquireVsCodeApi(); document.getElementById('reset').addEventListener('click', () => vs.postMessage({ type: 'reset' }))</script>
</body></html>`
}

// Which notification to show, if any: 'warn' when the streak has just reached the
// threshold, 'escalate' at twice the threshold, 'calm' at the calm threshold.
function shouldNotify(prev, cur, fallbackThreshold = 3) {
  if (!cur) return null
  const threshold = cur.threshold || fallbackThreshold
  if ((cur.streak || 0) >= threshold * 2 && (prev?.streak || 0) < threshold * 2) return 'escalate'
  if ((cur.streak || 0) >= threshold && (prev?.streak || 0) < threshold) return 'warn'
  const calmThreshold = cur.calmThreshold || 8
  if ((cur.calm || 0) >= calmThreshold && (prev?.calm || 0) < calmThreshold) return 'calm'
  return null
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

module.exports = { resetProject, sessionKind, copilotHome, readProjects, findState, computeView, levelOf, textBar, renderHtml, shouldNotify, formatReport, isInside, LEVEL_THEME_COLOR, LEVEL_HEX }
