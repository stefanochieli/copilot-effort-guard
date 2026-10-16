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
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { looksLikeTestFailure } from './detect.mjs'

const DEFAULT_THRESHOLD = 3
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
    default:
      return null
  }
}

export function emptyState() {
  return { turn: { struggled: false, reason: null, command: null }, streak: 0, log: [], pendingWarning: null }
}

// Pure state transitions: the CLI wrapper below only does I/O.
export function onTool(state, payload, { failed: failedEvent = false } = {}) {
  const { tool, command, text, resultType } = readTool(payload)
  const failed = failedEvent || resultType === 'failure'
  const isShell = /^(bash|shell|powershell|pwsh|run_in_terminal|runInTerminal|terminal|execute)/i.test(tool)

  if (!isShell && !failed) {
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
export function closeTurn(state, threshold, now = new Date()) {
  if (state.log.length === 0 && !state.turn.struggled && state.streak === 0 && !state.started) {
    return { state: { ...state, started: true }, warning: null }
  }

  const { struggled, reason, command } = state.turn
  const streak = struggled ? state.streak + 1 : 0
  const entry = { ts: now.toISOString(), struggled, reason, streak }
  const warning =
    streak === threshold
      ? `effort-guard: ${streak} struggling turns in a row (failed commands/tests)` +
        `${command ? `, last: ${command.slice(0, 60)}` : ''}. ` +
        `Consider switching to a stronger model or giving it more reasoning effort.`
      : null

  return {
    state: {
      started: true,
      turn: { struggled: false, reason: null, command: null },
      streak,
      log: [...state.log, entry].slice(-LOG_LIMIT),
      pendingWarning: warning,
    },
    warning,
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

// Per-user install (script under ~/.copilot): keep state out of the projects,
// one folder per working directory. Otherwise: .effort-guard/ in the project.
export function stateDir(cwd = process.cwd(), self = fileURLToPath(import.meta.url)) {
  if (process.env.EFFORT_GUARD_DIR) {
    return process.env.EFFORT_GUARD_DIR
  }
  if (self.startsWith(copilotHome())) {
    return join(dirname(self), 'state', createHash('sha1').update(cwd).digest('hex').slice(0, 12))
  }
  return join(cwd, '.effort-guard')
}

function statePath() {
  return join(stateDir(), 'state.json')
}

function load(path) {
  try {
    return { ...emptyState(), ...JSON.parse(readFileSync(path, 'utf8')) }
  } catch {
    return emptyState()
  }
}

function save(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state))
}

// EFFORT_GUARD_DEBUG=1 keeps every raw payload, so the real field names of a
// Copilot version can be checked and the fixtures updated.
// Folder shared by all working directories: holds events.log (one line per hook
// call, no tool output) so "do the hooks fire at all?" can be answered.
export function homeDir(self = fileURLToPath(import.meta.url)) {
  return self.startsWith(copilotHome()) ? dirname(self) : stateDir()
}

function logEvent(event, payload, state, now = new Date()) {
  const dir = homeDir()
  const path = join(dir, 'events.log')
  mkdirSync(dir, { recursive: true })
  const { tool } = readTool(payload)
  const line = `${now.toISOString()} ${event}${tool ? ` tool=${tool}` : ''} struggled=${state.turn.struggled} streak=${state.streak} cwd=${process.cwd()}\n`
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

function debugDump(event, payload) {
  if (!process.env.EFFORT_GUARD_DEBUG) {
    return
  }
  mkdirSync(stateDir(), { recursive: true })
  appendFileSync(join(stateDir(), 'payloads.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event, payload }) + '\n')
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

export function run(event, payload, state, threshold, now = new Date()) {
  if (event === 'prompt') {
    const closed = closeTurn(state, threshold, now)
    return { state: closed.state, stderr: closed.warning, stdout: null }
  }

  if (event === 'tool' || event === 'failure') {
    let next = onTool(state, payload, { failed: event === 'failure' })
    // The prompt hook cannot inject context in every host, so the warning that
    // the prompt hook produced is handed over on the first tool event instead.
    if (next.pendingWarning) {
      const warning = next.pendingWarning
      next = { ...next, pendingWarning: null }
      return { state: next, stderr: warning, stdout: warningOutput(warning, 'PostToolUse') }
    }
    return { state: next, stderr: null, stdout: null }
  }

  return { state, stderr: null, stdout: null }
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
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
    return readdirSync(root).map(d => ({ dir: join(root, d), state: load(join(root, d, 'state.json')) }))
  } catch {
    return []
  }
}

function doctor() {
  const dir = stateDir()
  const hooksFile = join(copilotHome(), 'hooks', 'effort-guard.json')
  console.log(`node ${process.version}`)
  console.log(`hooks file: ${hooksFile} (${existsSync(hooksFile) ? 'found' : 'MISSING: run scripts/install.mjs --user'})`)
  console.log(`state dir for this folder: ${dir} (${existsSync(dir) ? 'exists' : 'not created yet'})`)
  console.log(`threshold: ${Math.max(1, Math.floor(Number(process.env.EFFORT_GUARD_THRESHOLD)) || DEFAULT_THRESHOLD)}`)
  console.log(`debug payload dump: ${process.env.EFFORT_GUARD_DEBUG ? 'on' : 'off (set EFFORT_GUARD_DEBUG=1)'}`)
  const events = lastEvents(5)
  console.log(events.length ? `last hook calls:\n  ${events.join('\n  ')}` : 'no hook call recorded yet: restart Copilot (hooks load at startup) and send a prompt')
  const projects = projectStates()
  for (const p of projects) {
    console.log(`- ${p.state.cwd ?? p.dir}: ${summary(p.state)} streak=${p.state.streak}`)
  }
  if (!projects.length) {
    console.log(summary(load(statePath())))
  }
}

function status() {
  const s = load(statePath())
  console.log(`${summary(s)} | streak ${s.streak}/${Math.max(1, Math.floor(Number(process.env.EFFORT_GUARD_THRESHOLD)) || DEFAULT_THRESHOLD)} | current turn ${s.turn.struggled ? `struggling (${s.turn.reason})` : 'ok'}`)
}

// Live view for a second terminal: Copilot has no status bar a hook can draw on.
function watch() {
  let last = null
  console.log('effort-guard watch (Ctrl+C to stop)')
  setInterval(() => {
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
  if (arg === 'summary') {
    return console.log(summary(load(statePath())))
  }

  const payload = readStdin()
  const event = normaliseEvent(pick(payload, 'hook_event_name', 'hookEventName')) ?? arg
  if (!event) {
    return
  }
  debugDump(event, payload)

  const path = statePath()
  const result = run(event, payload, load(path), threshold)
  result.state = { ...result.state, cwd: process.cwd() }
  save(path, result.state)
  logEvent(event, payload, result.state)
  if (result.stderr) {
    appendFileSync(join(homeDir(), 'events.log'), `${new Date().toISOString()} WARNING ${result.stderr}\n`)
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
