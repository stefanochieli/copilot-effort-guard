'use strict'
// Pure logic of the status bar item (no vscode import, so it is testable with node --test).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function copilotHome(setting, env = process.env) {
  return setting || env.COPILOT_HOME || path.join(os.homedir(), '.copilot')
}

// Parsed state.json files by path, reused while mtime and size do not change: the
// panel refreshes every 2 s and most files are untouched between two refreshes.
const stateCache = new Map()

function readState(file, cache = stateCache) {
  let st
  try {
    st = fs.statSync(file)
  } catch {
    cache.delete(file)
    return null
  }
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return hit.state
  }
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    if (!state || typeof state !== 'object') return null
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, state })
    return state
  } catch {
    return hit?.state ?? null // half-written file: keep the last good copy
  }
}

// Reads every ~/.copilot/effort-guard/state/<hash>/state.json written by the hooks
// (per-user install) plus <folder>/.effort-guard/state.json of the given workspace
// folders (per-repo install, `node scripts/install.mjs <repo>`).
function readProjects(home, folders = [], cache = stateCache) {
  const root = path.join(home, 'effort-guard', 'state')
  const dirs = []
  try {
    for (const d of fs.readdirSync(root)) dirs.push(path.join(root, d))
  } catch {}
  for (const f of folders) dirs.push(path.join(f, '.effort-guard'))
  const out = []
  for (const dir of dirs) {
    const state = readState(path.join(dir, 'state.json'), cache)
    if (state) out.push({ dir, state: state.cwd ? state : { ...state, cwd: path.dirname(dir) } })
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
  if (state.lanes && typeof state.lanes === 'object') {
    next.lanes = Object.fromEntries(Object.entries(state.lanes).map(([k, v]) => [k, { ...v, turn: { struggled: false, reason: null, command: null }, streak: 0, calm: 0, pendingWarning: null, started: true }]))
  }
  // Temporary file + rename: the hooks never read a half-written state.
  withStateLock(file, () => writeStateAtomic(file, next))
  return next
}

// --- Hooks installed by the extension -------------------------------------------------

// Are the hooks installed (per user, or per repo in one of the folders), and is the
// per-user copy older than the one bundled with this extension?
function hooksStatus(home, bundledSrc, folders = []) {
  const userFile = path.join(home, 'hooks', 'effort-guard.json')
  const user = fs.existsSync(userFile)
  const repo = folders.some(f => fs.existsSync(path.join(f, '.github', 'hooks', 'effort-guard.json')))
  let outdated = false
  if (user && bundledSrc) {
    try {
      const installed = fs.readFileSync(path.join(home, 'effort-guard', 'effort-guard.mjs'), 'utf8')
      outdated = installed !== fs.readFileSync(path.join(bundledSrc, 'effort-guard.mjs'), 'utf8')
    } catch {
      outdated = fs.existsSync(path.join(bundledSrc, 'effort-guard.mjs'))
    }
  }
  return { installed: user || repo, user, repo, outdated }
}

// --- Per-project thresholds (.effort-guard.json, read by the hooks) ------------------

const CONFIG_FILE = '.effort-guard.json'

function readConfig(folder) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(folder, CONFIG_FILE), 'utf8').replace(/^\uFEFF/, ''))
    return c && typeof c === 'object' ? c : {}
  } catch {
    return {}
  }
}

// Returns an error message, or null when the value is valid.
function validateThreshold(value, min, max) {
  const n = Number(value)
  return Number.isInteger(n) && n >= min && n <= max ? null : `Enter a whole number between ${min} and ${max}.`
}

// Keeps any other key already in the file.
function writeConfig(folder, values) {
  const file = path.join(folder, CONFIG_FILE)
  const next = { ...readConfig(folder), ...values }
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return { file, config: next }
}

// --- Result quality (mirrors src/quality.mjs and EffortCore.kt) -----------------------

// 0..1 for one closed turn; null when there is no signal. A vote overrides the rest.
function qualityOf(entry) {
  if (!entry) return null
  if (entry.vote === 'up') return 1
  if (entry.vote === 'down') return 0
  if (!(entry.tests || entry.rework || entry.reedits)) return null
  let q = 1
  if (entry.tests === 'red') q -= 0.5
  if (entry.rework) q -= 0.4
  if (entry.reedits) q -= 0.2
  return Math.max(0, Math.round(q * 100) / 100)
}

function qualitySummary(log, n = 20) {
  const rated = (log ?? []).filter(e => qualityOf(e) !== null).slice(-n)
  const counts = { green: 0, red: 0, rework: 0, reedits: 0, up: 0, down: 0 }
  for (const e of rated) {
    if (e.tests === 'green') counts.green++
    if (e.tests === 'red') counts.red++
    if (e.rework) counts.rework++
    if (e.reedits) counts.reedits++
    if (e.vote === 'up') counts.up++
    if (e.vote === 'down') counts.down++
  }
  if (!rated.length) return { score: null, level: 'unknown', rated: 0, counts }
  const score = Math.round((rated.reduce((s, e) => s + qualityOf(e), 0) / rated.length) * 100)
  return { score, level: score >= 75 ? 'good' : score >= 50 ? 'fair' : 'poor', rated: rated.length, counts }
}

const QUALITY_HEX = { good: '#3fb950', fair: '#d29922', poor: '#f85149', unknown: '#8b949e' }

// Same lock as the hooks (a directory next to state.json), so a write from the IDE
// never interleaves with a hook's read-modify-write. Gives up after ~1.5 s.
function withStateLock(file, fn) {
  const lock = `${file}.lock`
  let held = false
  for (let i = 0; i < 75 && !held; i++) {
    try {
      fs.mkdirSync(lock)
      held = true
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5000) {
          fs.rmdirSync(lock)
          continue
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try {
    return fn()
  } finally {
    if (held) {
      try {
        fs.rmdirSync(lock)
      } catch {}
    }
  }
}

function writeStateAtomic(file, state) {
  const tmp = `${file}.${process.pid}.ext.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, file)
  stateCache.delete(file)
}

// Puts 'up' or 'down' on the last closed turn (the same vote again removes it).
function voteLast(dir, vote) {
  const file = path.join(dir, 'state.json')
  return withStateLock(file, () => {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    const log = Array.isArray(state.log) ? [...state.log] : []
    if (!log.length) return null
    const last = { ...log[log.length - 1] }
    if (last.vote === vote) delete last.vote
    else last.vote = vote
    log[log.length - 1] = last
    writeStateAtomic(file, { ...state, log })
    return last.vote ?? null
  })
}

// --- History ------------------------------------------------------------------------

function dayKey(d) {
  return new Date(d).toISOString().slice(0, 10)
}

// Turns and struggling turns per day for the last `days` days (oldest first, empty days included).
function dailyHistory(log, days = 14, now = Date.now()) {
  const out = []
  const index = new Map()
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(now - i * 86400000)
    index.set(day, out.length)
    out.push({ day, turns: 0, struggling: 0 })
  }
  for (const e of log ?? []) {
    if (!e?.ts) continue
    let k
    try {
      k = dayKey(e.ts)
    } catch {
      continue
    }
    const i = index.get(k)
    if (i === undefined) continue
    out[i].turns++
    if (e.struggled) out[i].struggling++
  }
  return out
}

// Most frequent reasons of struggling turns, most frequent first.
function reasonCounts(log) {
  const counts = {}
  for (const e of log ?? []) if (e?.struggled) counts[e.reason ?? 'unknown'] = (counts[e.reason ?? 'unknown'] ?? 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }))
}

function csvCell(v) {
  const s = String(v ?? '')
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// One row per logged turn of every project: no commands, no tool output.
function toCsv(projects) {
  // New columns go at the end: older rows simply leave them empty.
  const rows = [['project', 'timestamp', 'struggled', 'reason', 'streak', 'tests', 'rework', 'reedits', 'vote', 'quality', 'kind', 'session', 'agent', 'episode', 'cleared']]
  for (const p of projects) {
    for (const e of p.state.log ?? []) {
      const q = qualityOf(e)
      rows.push([p.state.cwd ?? p.dir, e.ts ?? '', e.struggled ? 'true' : 'false', e.reason ?? '', e.streak ?? '', e.tests ?? '', e.rework ? 'true' : '', e.reedits ?? '', e.vote ?? '', q === null ? '' : q, LANE_LABEL[e.kind] ?? '', e.session ?? '', e.agent ?? '', e.episode ?? '', e.cleared === true ? 'true' : e.cleared ?? ''])
    }
  }
  return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n'
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

// Chat (VS Code agent) and CLI keep separate lanes in the same state file: each has
// its own open turn, streak and clean run. The main view follows the lane that needs
// attention most (then the most recent one); both are listed side by side.
const LANE_LABEL = { chat: 'Chat', cli: 'CLI' }
const LEVEL_RANK = { warn: 3, watch: 2, calm: 1, ok: 1, idle: 0 }

function laneList(state, fallbackThreshold = 3) {
  if (!state?.lanes || typeof state.lanes !== 'object') return []
  return ['chat', 'cli']
    .filter(k => state.lanes[k] && typeof state.lanes[k] === 'object')
    .map(k => {
      const lane = state.lanes[k]
      const merged = { ...lane, threshold: state.threshold, calmThreshold: state.calmThreshold }
      return { kind: k, label: LANE_LABEL[k], streak: lane.streak || 0, calm: lane.calm || 0, struggling: Boolean(lane.turn?.struggled), reason: lane.turn?.reason ?? null, last: lane.last ?? null, level: levelOf(merged, fallbackThreshold), state: merged }
    })
}

function primaryLane(lanes) {
  return [...lanes].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || String(b.last ?? '').localeCompare(String(a.last ?? '')))[0] ?? null
}

// level: idle (no data), ok, calm (long clean run: task may be easy), watch (some struggle), warn (threshold reached).
function computeView(stateIn, fallbackThreshold = 3) {
  const lanes = laneList(stateIn, fallbackThreshold)
  const primary = primaryLane(lanes)
  const state = primary ? { ...stateIn, turn: primary.state.turn, streak: primary.streak, calm: primary.calm } : stateIn
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
  const kind = primary ? primary.label : sessionKind(state.session?.source)
  for (const l of lanes) lines.push(`${l.label}: ${l.streak}/${threshold} in a row${l.struggling ? ', current turn struggling' : ''}`)
  const tag = kind ? ` (${kind} session)` : ''
  const base = action === 'model-up' ? messages.escalate : action === 'thinking-up' ? messages.warn : action === 'down' ? messages.calm : null
  const hint = base ? base + tag : null
  if (hint) lines.push(hint)
  const q = qualitySummary(log)
  if (q.score !== null) lines.push(`Result quality: ${q.score}% (${q.level}) over ${q.rated} turns`)
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
    lanes: lanes.map(({ state: _s, ...l }) => l),
    resetAt: state.resetAt ?? null,
    cwd: state.cwd ?? null,
    updated: state.updated ?? null,
    history: dailyHistory(log),
    reasons: reasonCounts(log),
    quality: qualitySummary(log),
    lastVote: log.length ? log[log.length - 1].vote ?? null : null,
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

// Bar chart (inline SVG) of the turns per day: struggling turns in red on top of the clean ones.
function historySvg(history) {
  const max = Math.max(1, ...history.map(h => h.turns))
  const w = 12
  const gap = 4
  const h = 48
  const bars = history
    .map((d, i) => {
      const x = i * (w + gap)
      const total = Math.round((d.turns / max) * h)
      const bad = Math.round((d.struggling / max) * h)
      const label = `${d.day}: ${d.turns} turns, ${d.struggling} struggling`
      return `<g><title>${esc(label)}</title><rect x="${x}" y="${h - total}" width="${w}" height="${Math.max(total - bad, 0)}" fill="${LEVEL_HEX.ok}" rx="2"/><rect x="${x}" y="${h - bad}" width="${w}" height="${bad}" fill="${LEVEL_HEX.warn}" rx="2"/>${d.turns === 0 ? `<rect x="${x}" y="${h - 1}" width="${w}" height="1" fill="#8884"/>` : ''}</g>`
    })
    .join('')
  const width = history.length * (w + gap) - gap
  return `<svg class="chart" viewBox="0 0 ${width} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="Turns per day, last ${history.length} days">${bars}</svg>`
}

const QUALITY_LABEL = { good: 'Good', fair: 'Mixed', poor: 'Poor', unknown: 'No signal yet' }

// Result quality: score of the last rated turns, what it is made of, and the vote buttons.
function qualityHtml(view) {
  const q = view.quality
  if (!q) return ''
  const c = q.counts
  const parts = [
    c.green && `${c.green} green tests`,
    c.red && `${c.red} red tests`,
    c.rework && `${c.rework} asked to redo`,
    c.reedits && `${c.reedits} re-edited files`,
    c.up && `${c.up} \u{1F44D}`,
    c.down && `${c.down} \u{1F44E}`,
  ].filter(Boolean)
  const score = q.score === null ? '-' : `${q.score}%`
  const canVote = (view.timeline ?? []).length > 0
  return `<h4>Result quality</h4>
<div class="quality"><b style="color:${QUALITY_HEX[q.level]}">${esc(QUALITY_LABEL[q.level])} ${esc(score)}</b> <span class="muted">${q.rated ? `last ${q.rated} rated turns` : 'tests, follow-up prompts, re-edits and votes'}</span></div>
${parts.length ? `<div class="muted">${esc(parts.join(' \u00b7 '))}</div>` : ''}
${canVote ? `<div class="row vote"><button data-msg="vote-up" class="secondary${view.lastVote === 'up' ? ' on' : ''}" title="The last turn gave a good result">\u{1F44D} Good result</button><button data-msg="vote-down" class="secondary${view.lastVote === 'down' ? ' on' : ''}" title="The last turn gave a bad result">\u{1F44E} Bad result</button></div>` : ''}`
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
  const lanes = (view.lanes ?? []).length
    ? `<h4>Chat and CLI</h4><div class="lanes">${view.lanes
        .map(l => `<div class="lane" style="--l:${LEVEL_HEX[l.level]}"><b>${esc(l.label)}</b> <span class="muted">${esc(LEVEL_LABEL[l.level])}</span><div class="mini">${Array.from({ length: view.segments }, (_, i) => `<span class="${i < Math.min(l.streak, view.segments) ? 'on' : ''}"></span>`).join('')}</div><span class="muted">${l.streak}/${view.threshold} in a row${l.struggling ? ' \u00b7 turn struggling' : ''}<br>last hook ${esc(ageText(l.last, now))}</span></div>`)
        .join('')}</div>`
    : ''
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
  .chart { display: block; margin: 4px 0 2px; }
  .quality b { font-size: 1.1em; }
  .vote button.on { outline: 2px solid var(--c); }
  .row { display: flex; gap: 6px; }
  .row button { margin-top: 6px; }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .lanes { display: flex; gap: 6px; }
  .lane { flex: 1; padding: 6px; border-radius: 4px; border: 1px solid var(--vscode-widget-border, #8884); border-top: 3px solid var(--l); line-height: 1.4; }
  .lane b { color: var(--l); }
  .mini { display: flex; gap: 2px; margin: 4px 0; }
  .mini span { flex: 1; height: 6px; border-radius: 2px; background: var(--vscode-input-background, #3338); }
  .mini span.on { background: var(--l); }
</style></head><body>
<div class="level"><b>${esc(view.label)}</b>${badge}<span class="count">${view.streak}/${view.threshold} struggling turns in a row</span></div>
<div class="bar">${segs}</div>
<h4>Clean run (${view.calm}/${view.calmThreshold})</h4>
<div class="calm"><i></i></div>
${lanes}
${qualityHtml(view)}
<h4>Last turns</h4>
<div class="timeline">${dots}</div>
${view.hint ? `<div class="hint">${esc(view.hint)}</div>` : ''}
${sessions ? `<h4>Sessions in this folder</h4><ul>${sessions}</ul><div class="muted">Chat and CLI have separate streaks in each folder; CLI sessions share theirs.</div>` : ''}
${view.history?.some(d => d.turns) ? `<h4>Last ${view.history.length} days</h4>${historySvg(view.history)}<div class="muted">${esc(view.history[0].day)} \u2192 ${esc(view.history.at(-1).day)} \u00b7 red: struggling turns</div>` : ''}
${view.reasons?.length ? `<h4>Why it struggled</h4><ul>${view.reasons.map(r => `<li>${esc(r.reason)}: ${r.count}</li>`).join('')}</ul>` : ''}
${view.hooks && !view.hooks.installed ? `<div class="hint">The Copilot hooks are not installed, so there is nothing to show yet.<button data-msg="install">Install hooks</button></div>` : ''}
${view.hooks?.outdated ? `<div class="hint">The installed hooks are older than this extension.<button data-msg="install">Update hooks</button></div>` : ''}
<button id="reset" data-msg="reset" title="Use it after changing model or thinking effort">Reset after changing model / thinking</button>
<div class="row"><button data-msg="thresholds" class="secondary">Thresholds (${view.threshold} / ${view.calmThreshold})\u2026</button><button data-msg="csv" class="secondary">Export CSV</button></div>
<div class="meta muted">Session: ${session}<br>Folder: ${esc(view.cwd ?? '-')}<br>Last activity: ${esc(ageText(view.updated, now))}</div>
<script nonce="${NONCE}">const vs = acquireVsCodeApi(); document.querySelectorAll('button[data-msg]').forEach(b => b.addEventListener('click', () => vs.postMessage({ type: b.dataset.msg })))</script>
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

module.exports = { qualityOf, qualitySummary, voteLast, QUALITY_HEX, hooksStatus, readConfig, writeConfig, validateThreshold, dailyHistory, reasonCounts, toCsv, historySvg, CONFIG_FILE, readState, resetProject, sessionKind, copilotHome, readProjects, findState, computeView, levelOf, textBar, renderHtml, shouldNotify, formatReport, isInside, LEVEL_THEME_COLOR, LEVEL_HEX }
