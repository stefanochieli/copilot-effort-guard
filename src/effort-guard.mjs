#!/usr/bin/env node
// effort-guard for GitHub Copilot (CLI and VS Code agent hooks).
//
// Usage from a hooks file: `node src/effort-guard.mjs <event>`, with the hook
// payload on stdin. Events: prompt (userPromptSubmitted), tool (postToolUse),
// failure (postToolUseFailure), summary (prints the log).
//
// Observation only: it never denies a tool call. Payload field names are read
// defensively because Copilot delivers camelCase or snake_case depending on the
// event key casing and version.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

export function emptyState() {
  return { turn: { struggled: false, reason: null, command: null }, streak: 0, log: [] }
}

// Pure state transitions: the CLI wrapper below only does I/O.
export function onTool(state, payload, { failed: failedEvent = false } = {}) {
  const { tool, command, text, resultType } = readTool(payload)
  const failed = failedEvent || resultType === 'failure'
  const isShell = /^(bash|shell|powershell|run_in_terminal|terminal)/i.test(tool)

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

function statePath() {
  return join(process.env.EFFORT_GUARD_DIR ?? join(process.cwd(), '.effort-guard'), 'state.json')
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

function main() {
  const event = process.argv[2]
  const threshold = Math.max(1, Math.floor(Number(process.env.EFFORT_GUARD_THRESHOLD)) || DEFAULT_THRESHOLD)
  let payload = {}
  try {
    payload = JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {}

  const path = statePath()
  const state = load(path)

  if (event === 'summary') {
    console.log(summary(state))
    return
  }

  if (event === 'prompt') {
    const closed = closeTurn(state, threshold)
    save(path, closed.state)
    if (closed.warning) {
      // stderr is shown to the user; stdout JSON is offered to the agent as context.
      console.error(closed.warning)
      console.log(JSON.stringify({ additionalContext: closed.warning }))
    }
    return
  }

  if (event === 'tool' || event === 'failure') {
    save(path, onTool(state, payload, { failed: event === 'failure' }))
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
