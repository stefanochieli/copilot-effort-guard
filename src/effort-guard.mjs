#!/usr/bin/env node
// effort-guard for GitHub Copilot (CLI and VS Code agent hooks).
//
// Usage from a hooks file: `node src/effort-guard.mjs [event]`, with the hook
// payload on stdin. The event is taken from the payload (`hook_event_name`, VS Code)
// when present, otherwise from the argument: prompt (userPromptSubmitted),
// tool (postToolUse), failure (postToolUseFailure / errorOccurred), plus the
// commands summary, selftest and doctor.
//
// Observation only: it never denies a tool call. Payload field names are read
// defensively because Copilot delivers camelCase or snake_case depending on the
// event key casing and version.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { looksLikeTestFailure } from './detect.mjs'
import { formatDoctor, renderBar } from './report.mjs'

const DEFAULT_THRESHOLD = 3
const DEFAULT_CALM = 8
const LOG_LIMIT = 500

export function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) {
      return obj[k]
    }
  }
  return undefined
}

// Normalises a tool payload into { tool, command, text }.
export function readTool(payload) {
  const input = pick(payload, 'toolArgs', 'tool_input', 'toolInput') ?? {}
  const parsed = typeof input === 'string' ? safeJson(input) : input
  const result = pick(payload, 'toolResult', 'tool_response', 'toolResponse', 'tool_result') ?? {}
  const text = typeof result === 'string' ? result : pick(result, 'textResultForLlm', 'text', 'stdout', 'output') ?? ''

  // Copilot CLI reports { resultType: 'success' | 'failure' | 'denied', textResultForLlm }.
  const resultType = typeof result === 'object' ? pick(result, 'resultType', 'result_type') : undefined

  return {
    resultType,
    tool: pick(payload, 'toolName', 'tool_name') ?? '',
    command: pick(parsed, 'command', 'cmd') ?? '',
    text: typeof text === 'string' ? text : JSON.stringify(text),
  }
}

// Which Copilot session called the hook. VS Code payloads carry session_id and
// hook_event_name; Copilot CLI payloads may not, so fall back to the terminal id
// the shell exports (Windows Terminal, VS Code terminals), which differs per tab.
// Best effort: the label only helps the human reading doctor, it never drives logic.
export function readSession(payload, env = process.env) {
  const id = pick(payload, 'session_id', 'sessionId', 'conversation_id', 'conversationId')
  const vscodePayload = pick(payload, 'hook_event_name', 'session_id') !== undefined
  const terminal = env.WT_SESSION || env.TERM_SESSION_ID || env.VSCODE_GIT_IPC_HANDLE
  const source = vscodePayload ? 'vscode-chat' : env.TERM_PROGRAM === 'vscode' ? 'cli@vscode' : 'cli'
  const short = v => String(v).replace(/[^A-Za-z0-9]/g, '').slice(-8)
  if (id) return { id: short(id), source }
  if (terminal) return { id: `t-${short(terminal)}`, source }
  return { id: '-', source }
}

function safeJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

// Maps CLI (camelCase) and VS Code (PascalCase) event names, and our short names.
export function normaliseEvent(name) {
  switch (String(name ?? '').replace(/[_-]/g, '').toLowerCase()) {
    case 'prompt':
    case 'userpromptsubmitted':
    case 'userpromptsubmit':
      return 'prompt'
    case 'tool':
    case 'posttooluse':
      return 'tool'
    case 'failure':
    case 'posttoolusefailure':
    case 'erroroccurred':
      return 'failure'
    case 'summary':
      return 'summary'
    case 'selftest':
      return 'selftest'
    case 'doctor':
      return 'doctor'
    case 'status':
      return 'status'
    case 'watch':
      return 'watch'
    case 'reset':
      return 'reset'
    default:
      return null
  }
}

export function emptyState() {
  return { turn: { struggled: false, reason: null, command: null }, streak: 0, log: [], pendingWarning: null }
}

// Starts the evaluation again (after changing model or thinking effort): clears the
// streaks and the pending turn, keeps the history of past turns.
export function resetState(state, now = new Date()) {
  return {
    ...state,
    turn: { struggled: false, reason: null, command: null },
    streak: 0,
    calm: 0,
    pendingWarning: null,
    started: true,
    resetAt: now.toISOString(),
  }
}

// Sessions that recently ran hooks in this folder (the streaks are shared per folder).
export function touchSession(sessions, session, now = new Date(), limit = 5) {
  const list = Array.isArray(sessions) ? sessions : []
  if (!session) return list
  const rest = list.filter(x => !(x.id === session.id && x.source === session.source))
  return [{ source: session.source, id: session.id, last: now.toISOString() }, ...rest].slice(0, limit)
}

// Pure state transitions: the CLI wrapper below only does I/O.
export function onTool(state, payload, { failed: failedEvent = false } = {}) {
  const { tool, command, text, resultType } = readTool(payload)
  // errorOccurred also covers model calls, system and input errors (often recoverable):
  // only an error raised while running a tool is a struggling turn.
  const context = pick(payload, 'errorContext', 'error_context')
  const notFromTool = failedEvent && context !== undefined && context !== 'tool_execution'
  const failed = !notFromTool && (failedEvent || resultType === 'failure')
  const isShell = /^(bash|shell|powershell|pwsh|run_in_terminal|runInTerminal|terminal|execute)/i.test(tool)

  if (notFromTool || (!isShell && !failed)) {
    return state
  }

  const reason = failed ? 'tool_error' : looksLikeTestFailure(command, text) ? 'test_failure_pattern' : null

  if (!reason) {
    return state
  }

  const repeated = state.turn.struggled && command && state.turn.command === command

  return {
    ...state,
    turn: { struggled: true, reason: repeated ? 'repeated_error' : reason, command: command || state.turn.command },
  }
}

// Closes the previous turn: updates the streak and log. Returns the warning to
// show, if the streak just reached the threshold.
export function closeTurn(state, threshold, now = new Date(), calmThreshold = DEFAULT_CALM) {
  if (state.log.length === 0 && !state.turn.struggled && state.streak === 0 && !state.started) {
    return { state: { ...state, started: true }, warning: null, notice: null }
  }

  const { struggled, reason, command } = state.turn
  const streak = struggled ? state.streak + 1 : 0
  // Consecutive clean turns: a long calm run suggests the task is easy.
  const calm = struggled ? 0 : (state.calm ?? 0) + 1
  const notice =
    calm === calmThreshold
      ? `effort-guard: ${calm} clean turns in a row. The task looks easy: downgrade to a lighter model or lower the thinking effort to save tokens.`
      : null
  const entry = { ts: now.toISOString(), struggled, reason, streak }
  // Two steps: first more thinking, then (if the streak keeps growing) a stronger model.
  const where = `${streak} struggling turns in a row (failed commands/tests)${command ? `, last: ${command.slice(0, 60)}` : ''}.`
  const warning =
    streak === threshold
      ? `effort-guard: ${where} Raise the thinking / reasoning effort: the task may need more deliberation.`
      : struggled && streak === threshold * 2
        ? `effort-guard: ${where} More thinking did not help: switch to a more powerful model.`
        : null

  return {
    state: {
      started: true,
      turn: { struggled: false, reason: null, command: null },
      streak,
      calm,
      log: [...state.log, entry].slice(-LOG_LIMIT),
      pendingWarning: warning,
    },
    warning,
    notice,
  }
}

export function summary(state) {
  if (state.log.length === 0) {
    return 'effort-guard: no turns logged yet.'
  }

  const struggled = state.log.filter(e => e.struggled)
  const reasons = {}
  for (const e of struggled) {
    reasons[e.reason] = (reasons[e.reason] ?? 0) + 1
  }
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0]

  return `effort-guard: ${state.log.length} turns, ${struggled.length} struggling${top ? ` (most common: ${top[0]})` : ''}.`
}

export function copilotHome() {
  return process.env.COPILOT_HOME ?? join(homedir(), '.copilot')
}

// True when `file` lives inside `dir`: whole path segments only, case-insensitive on Windows.
export function isUnder(file, dir, platform = process.platform) {
  const fold = p => (platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
  const f = fold(file)
  const d = fold(dir).replace(/[\\/]+$/, '')
  return f === d || f.startsWith(d + sep) || f.startsWith(d + '/')
}

// Per-user install (script under ~/.copilot): keep state out of the projects,
// one folder per working directory. Otherwise: .effort-guard/ in the project.
export function stateDir(cwd = process.cwd(), self = fileURLToPath(import.meta.url)) {
  if (process.env.EFFORT_GUARD_DIR) {
    return process.env.EFFORT_GUARD_DIR
  }
  if (isUnder(self, copilotHome())) {
    return join(dirname(self), 'state', createHash('sha1').update(cwd).digest('hex').slice(0, 12))
  }
  return join(cwd, '.effort-guard')
}

let workingDir = process.cwd()

function statePath() {
  return join(stateDir(workingDir), 'state.json')
}

// A state file is usable only if the fields the logic dereferences have the right shape.
export function validState(s) {
  return Boolean(
    s &&
      typeof s === 'object' &&
      s.turn &&
      typeof s.turn === 'object' &&
      Array.isArray(s.log) &&
      Number.isFinite(s.streak),
  )
}

// A missing file is a fresh start. A file that cannot be read or has the wrong shape is
// moved to state.json.bad (not silently overwritten) and the evaluation restarts.
function load(path, { quarantine = true } = {}) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return emptyState()
  }
  try {
    const parsed = { ...emptyState(), ...JSON.parse(raw.replace(/^\uFEFF/, '')) }
    if (validState(parsed)) {
      return parsed
    }
  } catch {}
  if (quarantine) {
    try {
      renameSync(path, `${path}.bad`)
    } catch {}
  }
  return emptyState()
}

// Write to a temporary file and rename it: readers (the IDE extensions) never see a half file.
export function save(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, path)
}

// Cross-process lock (exclusive create, expires after 5 s) around read-modify-write, so
// parallel tool hooks or two sessions in one folder do not overwrite each other.
export function withLock(path, fn, { wait = 1500, stale = 5000 } = {}) {
  const lock = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true })
  const start = Date.now()
  let held = false
  while (!held) {
    try {
      closeSync(openSync(lock, 'wx'))
      held = true
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > stale) {
          unlinkSync(lock)
          continue
        }
      } catch {}
      if (Date.now() - start > wait) {
        break
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try {
    return fn()
  } finally {
    if (held) {
      try {
        unlinkSync(lock)
      } catch {}
    }
  }
}

// EFFORT_GUARD_DEBUG=1 keeps every raw payload, so the real field names of a
// Copilot version can be checked and the fixtures updated.
// Folder shared by all working directories: holds events.log (one line per hook
// call, no tool output) so "do the hooks fire at all?" can be answered.
export function homeDir(self = fileURLToPath(import.meta.url)) {
  return isUnder(self, copilotHome()) ? dirname(self) : stateDir(workingDir)
}

function logEvent(event, payload, state, now = new Date()) {
  const { id, source } = readSession(payload)
  const dir = homeDir()
  const path = join(dir, 'events.log')
  mkdirSync(dir, { recursive: true })
  const { tool } = readTool(payload)
  const line = `${now.toISOString()} ${event}${tool ? ` tool=${tool}` : ''} struggled=${state.turn.struggled} streak=${state.streak} session=${id} src=${source} cwd=${workingDir}\n`
  appendFileSync(path, line)
  try {
    if (statSync(path).size > 200_000) {
      writeFileSync(path, readFileSync(path, 'utf8').split('\n').slice(-500).join('\n'))
    }
  } catch {}
}

function lastEvents(n) {
  try {
    return readFileSync(join(homeDir(), 'events.log'), 'utf8').trim().split('\n').slice(-n)
  } catch {
    return []
  }
}

function debugDump(event, payload, extra = {}) {
  if (!process.env.EFFORT_GUARD_DEBUG) {
    return
  }
  mkdirSync(stateDir(workingDir), { recursive: true })
  appendFileSync(join(stateDir(workingDir), 'payloads.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event, payload, ...extra }) + '\n')
}

// Output understood by VS Code agent hooks (common output format plus
// hookSpecificOutput) and tolerated by the CLI, which ignores unknown keys.
export function warningOutput(warning, hookEventName) {
  return {
    systemMessage: warning,
    additionalContext: warning,
    hookSpecificOutput: { hookEventName, additionalContext: warning },
  }
}

// Identifies one prompt, so the same prompt delivered twice (hooks registered both in
// ~/.copilot/hooks and in .github/hooks) closes the turn only once. Needs a timestamp.
export function promptKey(payload) {
  const ts = pick(payload, 'timestamp', 'ts')
  if (ts === undefined) {
    return null
  }
  const prompt = pick(payload, 'prompt')
  return [pick(payload, 'session_id', 'sessionId') ?? '', ts, prompt ? createHash('sha1').update(String(prompt)).digest('hex').slice(0, 8) : ''].join('|')
}

export function run(event, payload, state, threshold, now = new Date(), calmThreshold = DEFAULT_CALM) {
  if (event === 'prompt') {
    const key = promptKey(payload)
    if (key && state.lastPrompt === key) {
      return { state, stderr: null, stdout: null, notice: null }
    }
    const closed = closeTurn(state, threshold, now, calmThreshold)
    return { state: key ? { ...closed.state, lastPrompt: key } : closed.state, stderr: closed.warning, stdout: null, notice: closed.notice }
  }

  if (event === 'tool' || event === 'failure') {
    let next = onTool(state, payload, { failed: event === 'failure' })
    // The prompt hook cannot inject context in every host, so the warning that
    // the prompt hook produced is handed over on the first tool event instead.
    if (next.pendingWarning) {
      const warning = next.pendingWarning
      next = { ...next, pendingWarning: null }
      return { state: next, stderr: warning, stdout: warningOutput(warning, event === 'failure' ? 'PostToolUseFailure' : 'PostToolUse'), delivered: true }
    }
    return { state: next, stderr: null, stdout: null }
  }

  return { state, stderr: null, stdout: null }
}

// Parses the hook payload (a UTF-8 BOM, which PowerShell can add, is removed). When it
// cannot be parsed the raw text is kept in payloads.jsonl under EFFORT_GUARD_DEBUG.
export function parseStdin(raw) {
  try {
    return { payload: JSON.parse(raw.replace(/^\uFEFF/, '') || '{}') }
  } catch (err) {
    return { payload: {}, error: err.message, raw }
  }
}

function readStdin() {
  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {}
  return parseStdin(raw)
}

function selftest() {
  const fail = { toolName: 'bash', toolArgs: { command: 'npm test' }, toolResult: { textResultForLlm: '2 failing' } }
  let state = emptyState()
  const out = []
  for (let i = 0; i < 4; i++) {
    state = run('prompt', {}, state, 3).state
    const r = run('tool', fail, state, 3)
    state = r.state
    if (r.stdout) out.push(r.stdout.systemMessage)
  }
  console.log(out.length === 1 ? `ok: warning raised once\n${out[0]}` : `FAILED: ${out.length} warnings`)
  process.exitCode = out.length === 1 ? 0 : 1
}

function projectStates() {
  const root = join(homeDir(), 'state')
  try {
    return readdirSync(root).map(d => ({ dir: join(root, d), state: load(join(root, d, 'state.json'), { quarantine: false }) }))
  } catch {
    return []
  }
}

function doctor() {
  const dir = stateDir()
  const hooksFile = join(copilotHome(), 'hooks', 'effort-guard.json')
  const found = projectStates()
  const own = existsSync(statePath()) ? [{ dir, state: load(statePath()) }] : []
  const projects = (found.length ? found : own).map(p => {
    const log = p.state.log ?? []
    const struggled = log.filter(e => e.struggled)
    const reasons = {}
    for (const e of struggled) {
      reasons[e.reason] = (reasons[e.reason] ?? 0) + 1
    }
    return {
      cwd: p.state.cwd,
      dir: p.dir,
      turns: log.length,
      struggling: struggled.length,
      streak: p.state.streak,
      topReason: Object.entries(reasons).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      updated: p.state.updated ?? null,
      session: p.state.session ?? null,
    }
  })
  console.log(
    formatDoctor({
      nodeVersion: process.version,
      hooksFile,
      hooksFound: existsSync(hooksFile),
      stateDir: dir,
      stateExists: existsSync(dir),
      threshold: Math.max(1, Math.floor(Number(process.env.EFFORT_GUARD_THRESHOLD)) || DEFAULT_THRESHOLD),
      debug: Boolean(process.env.EFFORT_GUARD_DEBUG),
      events: lastEvents(200),
      projects,
    }),
  )
}

function barInfo(s) {
  return {
    streak: s.streak ?? 0,
    threshold: s.threshold || Math.max(1, Math.floor(Number(process.env.EFFORT_GUARD_THRESHOLD)) || DEFAULT_THRESHOLD),
    calm: s.calm ?? 0,
    calmThreshold: s.calmThreshold || DEFAULT_CALM,
    struggling: Boolean(s.turn?.struggled),
  }
}

const useColor = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR

function status() {
  const s = load(statePath())
  console.log(renderBar(barInfo(s), { color: useColor() }))
  console.log(`${summary(s)} | current turn ${s.turn.struggled ? `struggling (${s.turn.reason})` : 'ok'}`)
}

function reset() {
  const path = statePath()
  if (!existsSync(path)) {
    return console.log('effort-guard: nothing to reset in this folder yet.')
  }
  withLock(path, () => save(path, resetState(load(path))))
  appendFileSync(join(homeDir(), 'events.log'), `${new Date().toISOString()} RESET cwd=${process.cwd()}\n`)
  console.log('effort-guard: streaks reset, the evaluation starts again.')
}

// Live view for a second terminal: Copilot has no status bar a hook can draw on.
// Prints the coloured bar whenever it changes, plus the new events.log lines.
function watch() {
  let last = null
  let lastBar = null
  console.log('effort-guard watch (Ctrl+C to stop)')
  setInterval(() => {
    const bar = renderBar(barInfo(load(statePath())), { color: useColor() })
    if (bar !== lastBar) {
      console.log(bar)
      lastBar = bar
    }
    const lines = lastEvents(500)
    const fresh = last === null ? lines.slice(-5) : lines.slice(lines.lastIndexOf(last) + 1)
    for (const l of fresh) {
      console.log(l)
    }
    last = lines.at(-1) ?? last
  }, 1000)
}

function main() {
  const threshold = Math.max(1, Math.floor(Number(process.env.EFFORT_GUARD_THRESHOLD)) || DEFAULT_THRESHOLD)
  const arg = normaliseEvent(process.argv[2])

  if (arg === 'selftest') {
    return selftest()
  }
  if (arg === 'doctor') {
    return doctor()
  }
  if (arg === 'status') {
    return status()
  }
  if (arg === 'watch') {
    return watch()
  }
  if (arg === 'reset') {
    return reset()
  }
  if (arg === 'summary') {
    return console.log(summary(load(statePath())))
  }

  const { payload, error, raw } = readStdin()
  // The folder Copilot says the hook ran in; process.cwd() when the payload has none.
  const payloadCwd = pick(payload, 'cwd')
  workingDir = typeof payloadCwd === 'string' && payloadCwd ? resolve(payloadCwd) : process.cwd()
  const event = normaliseEvent(pick(payload, 'hook_event_name', 'hookEventName')) ?? arg
  if (!event) {
    return
  }
  debugDump(event, payload, error ? { parseError: error, raw } : {})

  withLock(statePath(), () => process_(event, payload, threshold))
}

function process_(event, payload, threshold) {
  const path = statePath()
  const calmThreshold = Math.max(2, Math.floor(Number(process.env.EFFORT_GUARD_CALM)) || DEFAULT_CALM)
  const before = load(path)
  const result = run(event, payload, before, threshold, new Date(), calmThreshold)
  const session = readSession(payload)
  result.state = { ...result.state, cwd: workingDir, updated: new Date().toISOString(), threshold, calmThreshold, session, sessions: touchSession(before.sessions, session), resetAt: before.resetAt }
  save(path, result.state)
  logEvent(event, payload, result.state)
  if (result.stderr && !result.delivered) {
    appendFileSync(join(homeDir(), 'events.log'), `${new Date().toISOString()} WARNING ${result.stderr}\n`)
  }

  if (result.notice) {
    // Only logged and shown by the extension: it is not fed to the agent as context.
    appendFileSync(join(homeDir(), 'events.log'), `${new Date().toISOString()} INFO ${result.notice}\n`)
  }

  if (result.stderr) {
    // stderr is shown to the user; stdout JSON is offered to the agent as context.
    console.error(result.stderr)
  }
  if (result.stdout) {
    console.log(JSON.stringify(result.stdout))
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    // A broken observer must never break the agent.
    console.error(`effort-guard: ${err?.message ?? err}`)
  }
}
