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
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, join, relative, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { looksLikeTestFailure, isTestCommand, isTestSuccess, exitCodeOf, ignoresExitCode } from './detect.mjs'
import { errorRules, isBenignError, isMissingCommand, isProbe } from './benign.mjs'
import { formatDoctor, renderBar } from './report.mjs'
import { redact, clip } from './redact.mjs'
import { isEditTool, editedFiles, looksLikeRework, qualitySummary } from './quality.mjs'

const DEFAULT_THRESHOLD = 3
const DEFAULT_CALM = 8
const LOG_LIMIT = 500
const COMMAND_LIMIT = 200
const PAYLOAD_LOG_BYTES = 5_000_000
// State and logs hold commands and paths: readable by the user only (no effect on Windows).
const DIR_MODE = 0o700
const FILE_MODE = 0o600

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
    args: parsed && typeof parsed === 'object' ? parsed : {},
  }
}

// Which Copilot session called the hook, and from where.
// VS Code chat payloads carry the event name (hook_event_name or hookEventName),
// snake_case tool fields (tool_name, tool_input, tool_response, tool_use_id) or
// transcript_path, even when VS Code reads the CLI-format hook file. Copilot CLI
// payloads carry none of those (sessionId, toolName, toolArgs, toolResult).
// The process that runs the hook is a second signal: VS Code's extension host
// exports ELECTRON_RUN_AS_NODE / VSCODE_CRASH_REPORTER_PROCESS_TYPE=extensionHost,
// which a shell in a terminal tab does not have.
// The terminal id (Windows Terminal, VS Code terminals) is the fallback id for a CLI
// payload without a session id. Best effort: the label is shown to the human, it
// never drives the struggle logic.
const CHAT_KEYS = ['hook_event_name', 'hookEventName', 'session_id', 'transcript_path', 'tool_name', 'tool_input', 'tool_response', 'tool_use_id']
// Variable names only: their values are never read or logged.
export const HOST_ENV = ['ELECTRON_RUN_AS_NODE', 'VSCODE_CRASH_REPORTER_PROCESS_TYPE', 'VSCODE_PID', 'VSCODE_IPC_HOOK', 'TERM_PROGRAM', 'WT_SESSION', 'COPILOT_CLI', 'COPILOT_HOME']

export function hostEnv(env = process.env) {
  return HOST_ENV.filter(k => env[k] !== undefined && env[k] !== '')
}

export function sessionSource(payload, env = process.env) {
  const chatPayload = CHAT_KEYS.some(k => pick(payload, k) !== undefined)
  const inTerminal = Boolean(env.TERM_PROGRAM || env.WT_SESSION || env.TERM_SESSION_ID)
  const extensionHost = env.VSCODE_CRASH_REPORTER_PROCESS_TYPE === 'extensionHost' || (Boolean(env.ELECTRON_RUN_AS_NODE) && !inTerminal)
  if (chatPayload || extensionHost) {
    return 'vscode-chat'
  }
  return env.TERM_PROGRAM === 'vscode' ? 'cli@vscode' : 'cli'
}

export function readSession(payload, env = process.env) {
  const id = pick(payload, 'session_id', 'sessionId', 'conversation_id', 'conversationId')
  const terminal = env.WT_SESSION || env.TERM_SESSION_ID || env.VSCODE_GIT_IPC_HANDLE
  const source = sessionSource(payload, env)
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
    case 'payloads':
      return 'payloads'
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
    ...(state.lanes ? { lanes: Object.fromEntries(Object.entries(state.lanes).map(([k, v]) => [k, { ...v, turn: { struggled: false, reason: null, command: null }, streak: 0, calm: 0, pendingWarning: null, started: true }])) } : {}),
  }
}

// Sessions that recently ran hooks in this folder (the streaks are shared per folder).
export function touchSession(sessions, session, now = new Date(), limit = 5) {
  const list = Array.isArray(sessions) ? sessions : []
  if (!session) return list
  const rest = list.filter(x => !(x.id === session.id && x.source === session.source))
  return [{ source: session.source, id: session.id, last: now.toISOString() }, ...rest].slice(0, limit)
}

// Copilot Chat (VS Code agent) and Copilot CLI often work in the same folder at the
// same time. Each has its own lane: its own open turn, streak and clean run, so a
// prompt in one never closes the other's turn. The turn log is shared (each entry
// says which lane wrote it) and the top-level fields mirror the lane that acted
// last, so older extensions keep working.
export const LANES = ['chat', 'cli']
const LANE_KEYS = ['turn', 'streak', 'calm', 'pendingWarning', 'lastPromptKey', 'recentFiles', 'started', 'sessionId']

// A new episode starts after a pause (no hook of this lane for gapMinutes) or, when
// asked for, when another session takes over the lane: the streak starts from zero,
// so two struggles hours apart are not counted as one. Turns, calm run and log stay.
export const DEFAULT_GAP_MINUTES = 30

export function newEpisode(view, { last, now = new Date(), gapMinutes = DEFAULT_GAP_MINUTES, sessionId = null, resetOnSession = false } = {}) {
  const idle = last && gapMinutes > 0 ? now.getTime() - new Date(last).getTime() : 0
  const byGap = Number.isFinite(idle) && idle > gapMinutes * 60_000
  const bySession = resetOnSession && sessionId && sessionId !== '-' && view.sessionId && view.sessionId !== sessionId
  const next = sessionId && sessionId !== '-' ? { ...view, sessionId } : view
  if (!byGap && !bySession) return next
  return { ...next, streak: 0, pendingWarning: null, episode: byGap ? 'gap' : 'session' }
}

export function laneOf(source) {
  return source === 'vscode-chat' ? 'chat' : 'cli'
}

function laneFields(state) {
  const out = {}
  for (const k of LANE_KEYS) if (state[k] !== undefined) out[k] = state[k]
  return out
}

// The state one lane works on: its own fields plus the shared log.
export function laneView(state, lane) {
  const own = state.lanes?.[lane]
  if (own) return { ...own, turn: own.turn ?? { struggled: false, reason: null, command: null }, streak: own.streak ?? 0, log: state.log }
  // A state written before lanes existed belongs to whichever lane comes first.
  if (!state.lanes) return { ...laneFields(state), log: state.log }
  return { turn: { struggled: false, reason: null, command: null }, streak: 0, calm: 0, pendingWarning: null, fresh: true, log: state.log }
}

export function mergeLane(state, lane, next, now = new Date()) {
  const own = { ...laneFields(next), last: now.toISOString() }
  const { last, ...mirror } = own
  return { ...state, ...mirror, log: next.log, lanes: { ...(state.lanes ?? {}), [lane]: own }, lane }
}

// Pure state transitions: the CLI wrapper below only does I/O.
export function onTool(state, payload, { failed: failedEvent = false, rules = errorRules() } = {}) {
  // errorOccurred also reports model, system and user-input errors: only a failed
  // tool execution says anything about the task being hard.
  const errorContext = pick(payload, 'errorContext', 'error_context')
  if (errorContext !== undefined && errorContext !== 'tool_execution') {
    return state
  }
  const { tool, command, text, resultType, args } = readTool(payload)
  const failed = failedEvent || resultType === 'failure'
  const isShell = /^(bash|shell|powershell|pwsh|run_in_terminal|runInTerminal|terminal|execute)/i.test(tool)

  // Quality signals of the turn (they never change the streak): files written and the
  // outcome of the last test/build command.
  const quality = {}
  if (!failed && isEditTool(tool)) {
    const files = editedFiles(args)
    if (files.length) quality.files = [...new Set([...(state.turn.files ?? []), ...files])].slice(0, 200)
  }

  if (!isShell && !failed) {
    return quality.files ? { ...state, turn: { ...state.turn, ...quality } } : state
  }

  const result = pick(payload, 'toolResult', 'tool_response', 'toolResponse', 'tool_result')
  const exitCode = isShell ? exitCodeOf(result && typeof result === 'object' ? result : {}, text) : null
  const badExit = exitCode !== null && exitCode !== 0 && !ignoresExitCode(command) && !isProbe(command, rules)
  let reason = failed ? 'tool_error' : looksLikeTestFailure(command, text) ? 'test_failure_pattern' : badExit ? 'exit_code' : null
  // Errors that say nothing about the task (benign.mjs, extendable per repository).
  // A real test/build failure is always counted.
  let missing = false
  if (reason && reason !== 'test_failure_pattern' && !isTestCommand(command)) {
    if (isBenignError(text, rules)) {
      reason = null
    } else if (isMissingCommand(text, exitCode, rules)) {
      missing = true
      if (!state.turn.missing) reason = null // the first one in a turn is forgiven
    }
  }
  if (isShell && isTestCommand(command)) {
    quality.tests = isTestSuccess(command, text, exitCode) && !failed ? 'green' : 'red'
  }
  const keep = { files: state.turn.files, tests: state.turn.tests, ...(missing || state.turn.missing ? { missing: true } : {}), ...quality }

  if (!reason) {
    // Red then green in the same turn (TDD, or a fix that worked) is not a struggle.
    // EFFORT_GUARD_RED_GREEN=0 turns this off.
    if (state.turn.struggled && state.turn.test && isShell && process.env.EFFORT_GUARD_RED_GREEN !== '0' && isTestSuccess(command, text, exitCode)) {
      return { ...state, turn: { struggled: false, reason: null, command: null, ...keep } }
    }
    return quality.tests || quality.files || (missing && !state.turn.missing) ? { ...state, turn: { ...state.turn, ...keep } } : state
  }

  // What is kept is a short, redacted copy: the full command line can hold a token.
  const kept = command ? clip(redact(command), COMMAND_LIMIT) : ''
  const repeated = state.turn.struggled && kept && state.turn.command === kept

  return {
    ...state,
    // `test`: the struggle came from a test/build command, so a later green run of one clears it.
    turn: { struggled: true, reason: repeated ? 'repeated_error' : reason, command: kept || state.turn.command, test: isTestCommand(command) || (state.turn.struggled && state.turn.test) || undefined, ...keep },
  }
}

// Files written in this turn that one of the last RECENT_TURNS turns had written too.
const RECENT_TURNS = 3
function reedits(files, recent) {
  if (!files?.length || !Array.isArray(recent)) return 0
  const seen = new Set(recent.flat())
  return files.filter(f => seen.has(f)).length
}

// Closes the previous turn: updates the streak and log. Returns the warning to
// show, if the streak just reached the threshold.
export function closeTurn(state, threshold, now = new Date(), calmThreshold = DEFAULT_CALM) {
  if ((state.log.length === 0 || state.fresh) && !state.turn.struggled && state.streak === 0 && !state.started) {
    return { state: { ...state, started: true }, warning: null, notice: null }
  }

  // A turn whose last test/build run is green ended well: whatever failed on the way
  // (a missing file, a refused command) was not a struggle.
  const green = state.turn.tests === 'green'
  const struggled = Boolean(state.turn.struggled) && !green
  const reason = struggled ? state.turn.reason : null
  const command = struggled ? state.turn.command : null
  const streak = struggled ? state.streak + 1 : 0
  // Consecutive clean turns: a long calm run suggests the task is easy.
  const calm = struggled ? 0 : (state.calm ?? 0) + 1
  const notice =
    calm === calmThreshold
      ? `effort-guard: ${calm} clean turns in a row. The task looks easy: downgrade to a lighter model or lower the thinking effort to save tokens.`
      : null
  const entry = { ts: now.toISOString(), struggled, reason, streak }
  if (green && state.turn.struggled) entry.cleared = state.turn.reason ?? true
  const { tests, files } = state.turn
  if (tests) entry.tests = tests
  const again = reedits(files, state.recentFiles)
  if (again) entry.reedits = again
  const recentFiles = files?.length ? [...(state.recentFiles ?? []), files].slice(-RECENT_TURNS) : (state.recentFiles ?? []).slice(-RECENT_TURNS)
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
      recentFiles,
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

  const q = qualitySummary(state.log)
  const quality = q.score === null ? '' : ` Result quality ${q.score}% (${q.level}, ${q.rated} rated turns).`
  const lanes = state.lanes ? ' ' + LANES.filter(l => state.lanes[l]).map(l => `${l === 'chat' ? 'Chat' : 'CLI'}: ${state.lanes[l].streak ?? 0} in a row`).join(', ') + '.' : ''
  return `effort-guard: ${state.log.length} turns, ${struggled.length} struggling${top ? ` (most common: ${top[0]})` : ''}.${quality}${lanes}`
}

// Per-project thresholds: `.effort-guard.json` in the working directory or one of its
// parents (written by the IDE extensions, can be committed to share it with the team):
// { "threshold": 4, "calmThreshold": 10 }. The environment variables still win.
export const CONFIG_FILE = '.effort-guard.json'

export function projectConfig(cwd = activeCwd) {
  let dir = resolve(String(cwd))
  for (let i = 0; i < 10; i++) {
    const file = join(dir, CONFIG_FILE)
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      return raw && typeof raw === 'object' ? { ...raw, file } : {}
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
        return {} // present but unreadable: defaults, never a crash
      }
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return {}
}

const intIn = (v, min, max) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined
}

export function thresholds(env = process.env, config = {}) {
  return {
    threshold: intIn(env.EFFORT_GUARD_THRESHOLD, 1, 100) ?? intIn(config.threshold, 1, 100) ?? DEFAULT_THRESHOLD,
    calmThreshold: intIn(env.EFFORT_GUARD_CALM, 2, 1000) ?? intIn(config.calmThreshold, 2, 1000) ?? DEFAULT_CALM,
    // 0 turns the pause reset off.
    gapMinutes: intIn(env.EFFORT_GUARD_GAP_MINUTES, 0, 10080) ?? intIn(config.gapMinutes, 0, 10080) ?? DEFAULT_GAP_MINUTES,
    resetOnSession: (env.EFFORT_GUARD_RESET_ON_SESSION ?? '') !== '' ? env.EFFORT_GUARD_RESET_ON_SESSION === '1' : config.resetOnSessionChange === true,
  }
}

export function copilotHome() {
  return process.env.COPILOT_HOME ?? join(homedir(), '.copilot')
}

// Windows paths are case-insensitive and may come with either slash: one project
// must map to one state folder whichever spelling the host uses.
function normaliseCwd(cwd) {
  const s = resolve(String(cwd))
  return process.platform === 'win32' ? s.replace(/\\/g, '/').toLowerCase() : s
}

function isUnder(file, dir) {
  const a = process.platform === 'win32' ? file.toLowerCase() : file
  const b = process.platform === 'win32' ? dir.toLowerCase() : dir
  const rel = relative(b, a)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

// Working directory of the session: the payload's `cwd` when it is a real folder,
// otherwise the one the process was started in.
let activeCwd = process.cwd()
export function payloadCwd(payload) {
  const c = pick(payload, 'cwd')
  try {
    return typeof c === 'string' && c && statSync(c).isDirectory() ? c : undefined
  } catch {
    return undefined
  }
}

// Per-user install (script under ~/.copilot): keep state out of the projects,
// one folder per working directory. Otherwise: .effort-guard/ in the project.
export function stateDir(cwd = activeCwd, self = fileURLToPath(import.meta.url)) {
  if (process.env.EFFORT_GUARD_DIR) {
    return process.env.EFFORT_GUARD_DIR
  }
  if (isUnder(self, copilotHome())) {
    return join(dirname(self), 'state', createHash('sha1').update(normaliseCwd(cwd)).digest('hex').slice(0, 12))
  }
  return join(cwd, '.effort-guard')
}

function statePath() {
  return join(stateDir(), 'state.json')
}

// A state file is usable only if the fields the logic touches have the right shape.
export function validState(v) {
  return Boolean(
    v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      v.turn &&
      typeof v.turn === 'object' &&
      Array.isArray(v.log) &&
      (v.streak === undefined || Number.isFinite(v.streak)),
  )
}

// Unreadable or wrongly shaped files are moved to state.json.bad (one backup) and
// the evaluation starts again, instead of failing on every hook call.
function load(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return emptyState()
  }
  try {
    const parsed = JSON.parse(raw)
    if (validState(parsed)) {
      return { ...emptyState(), ...parsed }
    }
  } catch {}
  try {
    renameSync(path, `${path}.bad`)
  } catch {}
  return emptyState()
}

// Written to a temporary file and renamed, so a reader (the IDE extensions) never
// sees a half-written file.
function save(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state), { mode: FILE_MODE })
  try {
    renameSync(tmp, path)
  } catch {
    // Windows can refuse to replace a file another process has open.
    writeFileSync(path, JSON.stringify(state), { mode: FILE_MODE })
    rmSync(tmp, { force: true })
  }
}

// Serialises the read-modify-write of two hook processes (parallel tool calls,
// two sessions in one folder). Never blocks the agent for long: after ~1.5 s it
// carries on without the lock.
function withLock(path, fn) {
  const lock = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
  let held = false
  for (let i = 0; i < 75 && !held; i++) {
    try {
      mkdirSync(lock)
      held = true
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) {
          rmdirSync(lock)
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
        rmdirSync(lock)
      } catch {}
    }
  }
}

// EFFORT_GUARD_DEBUG=1 keeps every raw payload, so the real field names of a
// Copilot version can be checked and the fixtures updated.
// Folder shared by all working directories: holds events.log (one line per hook
// call, no tool output) so "do the hooks fire at all?" can be answered.
export function homeDir(self = fileURLToPath(import.meta.url)) {
  return isUnder(self, copilotHome()) ? dirname(self) : stateDir()
}

function logEvent(event, payload, state, now = new Date()) {
  const { id, source } = readSession(payload)
  const dir = homeDir()
  const path = join(dir, 'events.log')
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  const { tool } = readTool(payload)
  const line = `${now.toISOString()} ${event}${tool ? ` tool=${tool}` : ''} struggled=${state.turn.struggled} streak=${state.streak} session=${id} src=${source} cwd=${activeCwd}\n`
  appendFileSync(path, line, { mode: FILE_MODE })
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

// Payloads are redacted (tokens, passwords, Authorization headers) unless the
// variable is exactly "raw", and the file is rotated so it cannot grow without limit.
function debugDump(event, payload, input = {}) {
  const mode = process.env.EFFORT_GUARD_DEBUG
  if (!mode) {
    return
  }
  const dir = stateDir()
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  const path = join(dir, 'payloads.jsonl')
  // When stdin was not valid JSON the raw text is kept too, so the capture shows why.
  const extra = input.error ? { stdinError: input.error, stdinRaw: String(input.raw).slice(0, 4000) } : {}
  let line = JSON.stringify({ ts: new Date().toISOString(), event, source: sessionSource(payload), hostEnv: hostEnv(), payload, ...extra })
  if (mode !== 'raw') {
    line = redact(line)
  }
  appendFileSync(path, line + '\n', { mode: FILE_MODE })
  try {
    if (statSync(path).size > PAYLOAD_LOG_BYTES) {
      writeFileSync(path, readFileSync(path, 'utf8').split('\n').slice(-1000).join('\n'), { mode: FILE_MODE })
    }
  } catch {}
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

// Identifies one prompt: the same prompt reaching two registered hooks has the same
// session and timestamp. Without both there is no safe way to tell, so no key.
// Name of the agent (custom agent, subagent) when the host sends one. Not confirmed
// for Copilot yet: `effort-guard payloads` lists the keys that really arrive.
export function agentOf(payload) {
  const v = pick(payload, 'agent', 'agentName', 'agent_name', 'agentId', 'agent_id', 'subagent', 'subagentType', 'subagent_type', 'chatMode')
  const name = typeof v === 'object' && v ? pick(v, 'name', 'id', 'slug') : v
  return typeof name === 'string' && name.trim() ? name.trim().replace(/[^\w .:@/-]/g, '').slice(0, 40) : null
}

export function promptKey(payload) {
  const session = pick(payload, 'session_id', 'sessionId')
  const ts = pick(payload, 'timestamp')
  return session !== undefined && ts !== undefined ? `${session}|${ts}` : null
}

export function run(event, payload, state, threshold, now = new Date(), calmThreshold = DEFAULT_CALM, lane = null, { rules = errorRules(), session = null } = {}) {
  if (event === 'prompt') {
    // The same hook registered twice (user and repository files) delivers the same
    // prompt twice: closing the turn twice would see a clean turn and reset the streak.
    const key = promptKey(payload)
    if (key && state.lastPromptKey === key) {
      return { state, stderr: null, stdout: null, notice: null, duplicate: true }
    }
    const closed = closeTurn(state, threshold, now, calmThreshold)
    let next = key ? { ...closed.state, lastPromptKey: key } : closed.state
    if (next.log.length > state.log.length) {
      // Who ran the turn: the lane, the session and (when the host says) the agent.
      const agent = agentOf(payload)
      const tags = { ...(lane ? { kind: lane } : {}), ...(session?.id && session.id !== '-' ? { session: session.id } : {}), ...(agent ? { agent } : {}), ...(state.episode ? { episode: state.episode } : {}) }
      if (Object.keys(tags).length) next = { ...next, log: [...next.log.slice(0, -1), { ...next.log.at(-1), ...tags }] }
    }
    if (state.sessionId) next = { ...next, sessionId: state.sessionId }
    // A prompt asking to fix or redo marks the turn it reacts to: the last one closed
    // in the same lane (Chat and CLI turns interleave in the shared log).
    if (looksLikeRework(pick(payload, 'prompt', 'user_prompt', 'userPrompt'))) {
      const i = next.log.findLastIndex(e => !lane || !e.kind || e.kind === lane)
      if (i >= 0) {
        const log = [...next.log]
        log[i] = { ...log[i], rework: true }
        next = { ...next, log }
      }
    }
    return { state: next, stderr: closed.warning, stdout: null, notice: closed.notice }
  }

  if (event === 'tool' || event === 'failure') {
    let next = onTool(state, payload, { failed: event === 'failure', rules })
    // The prompt hook cannot inject context in every host, so the warning that
    // the prompt hook produced is handed over on the first tool event instead.
    if (next.pendingWarning) {
      const warning = next.pendingWarning
      next = { ...next, pendingWarning: null }
      const name = pick(payload, 'hook_event_name', 'hookEventName') ?? (event === 'failure' ? 'PostToolUseFailure' : 'PostToolUse')
      return { state: next, stderr: warning, stdout: warningOutput(warning, name), delivered: true }
    }
    return { state: next, stderr: null, stdout: null }
  }

  return { state, stderr: null, stdout: null }
}

// Strips a UTF-8 BOM (PowerShell can add one) before parsing.
export function parseInput(raw) {
  try {
    return { payload: JSON.parse(String(raw).replace(/^\uFEFF/, '') || '{}'), raw }
  } catch (err) {
    return { payload: {}, raw, error: err.message }
  }
}

function readStdin() {
  try {
    return parseInput(readFileSync(0, 'utf8'))
  } catch (err) {
    return { payload: {}, raw: '', error: err.message }
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

// Shape of the captured payloads (EFFORT_GUARD_DEBUG=1), without values: event names,
// keys, value types, tool names, result shapes, exit-code fields. Safe to share.
export function summarisePayloads(lines) {
  const kind = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
  const groups = new Map()
  for (const line of lines) {
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const p = rec.payload ?? {}
    const keys = Object.keys(p).sort().map(k => `${k}:${kind(p[k])}`).join(', ')
    const { tool, resultType, text } = readTool(p)
    const result = pick(p, 'toolResult', 'tool_response', 'toolResponse', 'tool_result')
    const resultKeys = result && typeof result === 'object' ? Object.keys(result).sort().join(', ') : result === undefined ? '' : `(${kind(result)})`
    const args = pick(p, 'toolArgs', 'tool_input', 'toolInput')
    const argKeys = args && typeof args === 'object' ? Object.keys(args).sort().join(', ') : typeof args === 'string' ? `(string) ${Object.keys(safeJson(args)).sort().join(', ')}` : ''
    const exitCode = tool ? exitCodeOf(result && typeof result === 'object' ? result : {}, text) : null
    const g = { event: rec.event, source: rec.source ?? '', hostEnv: (rec.hostEnv ?? []).join(', '), keys, tool, argKeys, resultKeys, resultType: resultType ?? '', exitCode, parseError: rec.stdinError ?? '' }
    const id = JSON.stringify(g)
    groups.set(id, { ...g, count: (groups.get(id)?.count ?? 0) + 1 })
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}

function payloads() {
  let lines = []
  try {
    lines = readFileSync(join(stateDir(), 'payloads.jsonl'), 'utf8').trim().split('\n')
  } catch {
    return console.log('effort-guard: no payloads.jsonl here. Start Copilot with EFFORT_GUARD_DEBUG=1 first.')
  }
  for (const g of summarisePayloads(lines)) {
    console.log(`${g.count}x ${g.event}${g.tool ? ` tool=${g.tool}` : ''} source=${g.source || '-'}\n   host env: ${g.hostEnv || '-'}\n   payload keys: ${g.keys}\n   tool args keys: ${g.argKeys || '-'}\n   result keys: ${g.resultKeys || '-'} resultType=${g.resultType || '-'} exitCode=${g.exitCode ?? '-'}${g.parseError ? `\n   STDIN ERROR: ${g.parseError}` : ''}`)
  }
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
      duplicateHooks: existsSync(hooksFile) && existsSync(join(activeCwd, '.github', 'hooks', 'effort-guard.json')) ? join(activeCwd, '.github', 'hooks', 'effort-guard.json') : null,
      stateDir: dir,
      stateExists: existsSync(dir),
      threshold: thresholds(process.env, projectConfig(activeCwd)).threshold,
      debug: Boolean(process.env.EFFORT_GUARD_DEBUG),
      events: lastEvents(200),
      projects,
    }),
  )
}

function barInfo(s) {
  return {
    streak: s.streak ?? 0,
    threshold: s.threshold || thresholds(process.env, projectConfig(activeCwd)).threshold,
    calm: s.calm ?? 0,
    calmThreshold: s.calmThreshold || thresholds(process.env, projectConfig(activeCwd)).calmThreshold,
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
  save(path, resetState(load(path)))
  appendFileSync(join(homeDir(), 'events.log'), `${new Date().toISOString()} RESET cwd=${activeCwd}\n`)
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
  if (arg === 'payloads') {
    return payloads()
  }
  if (arg === 'summary') {
    return console.log(summary(load(statePath())))
  }

  const input = readStdin()
  const payload = input.payload
  const cwd = payloadCwd(payload)
  if (cwd) {
    activeCwd = cwd
  }
  const event = normaliseEvent(pick(payload, 'hook_event_name', 'hookEventName')) ?? arg
  if (!event) {
    return
  }
  debugDump(event, payload, input)

  const path = statePath()
  const config = projectConfig(activeCwd)
  const { threshold, calmThreshold, gapMinutes, resetOnSession } = thresholds(process.env, config)
  const rules = errorRules(config)
  withLock(path, () => {
    const before = load(path)
    const session = readSession(payload)
    const lane = laneOf(session.source)
    const now = new Date()
    // The pause is measured on prompts only: a long build inside a turn is not a pause.
    const view = laneView(before, lane)
    const last = before.lanes ? before.lanes[lane]?.last : before.updated
    const start = event === 'prompt' ? newEpisode(view, { last, now, gapMinutes, sessionId: session.id, resetOnSession }) : view
    const result = run(event, payload, start, threshold, now, calmThreshold, lane, { rules, session })
    if (result.duplicate) {
      return
    }
    result.state = { ...mergeLane(before, lane, result.state, now), cwd: activeCwd, updated: new Date().toISOString(), threshold, calmThreshold, session, sessions: touchSession(before.sessions, session), resetAt: before.resetAt }
    save(path, result.state)
    logEvent(event, payload, result.state)
    // The warning is logged once, when the prompt hook produces it; the copy handed
    // over on a tool event is the same message.
    if (result.stderr && event === 'prompt') {
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
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    // A broken observer must never break the agent.
    console.error(`effort-guard: ${err?.message ?? err}`)
  }
}
