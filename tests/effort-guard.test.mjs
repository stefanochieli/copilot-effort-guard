import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyState, onTool, closeTurn, summary, readTool } from '../src/effort-guard.mjs'

const failingTest = { toolName: 'bash', toolArgs: { command: 'npm test' }, toolResult: { textResultForLlm: '2 failing' } }

test('reads camelCase and snake_case payloads', () => {
  assert.equal(readTool(failingTest).command, 'npm test')
  assert.equal(readTool({ tool_name: 'bash', tool_input: '{"command":"mvn test"}' }).command, 'mvn test')
})

test('a failing test run makes the turn a struggle; a clean one does not', () => {
  assert.equal(onTool(emptyState(), failingTest).turn.struggled, true)
  const clean = { ...failingTest, toolResult: { textResultForLlm: '12 passing' } }
  assert.equal(onTool(emptyState(), clean).turn.struggled, false)
})

test('warns once when the streak reaches the threshold and resets on a clean turn', () => {
  let state = emptyState()
  const warnings = []
  // Each prompt closes the previous turn, then the turn runs a failing test.
  for (let i = 0; i < 4; i++) {
    const c = closeTurn(state, 3)
    state = onTool(c.state, failingTest)
    if (c.warning) warnings.push(c.warning)
  }
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /3 struggling turns/)

  const afterFourth = closeTurn(state, 3).state
  assert.equal(afterFourth.streak, 4)
  assert.equal(closeTurn(afterFourth, 3).state.streak, 0) // a turn with no failure resets it
})

test('the same command failing twice in a turn is a repeated_error', () => {
  const once = onTool(emptyState(), failingTest)
  assert.equal(onTool(once, failingTest).turn.reason, 'repeated_error')
})

test('failure events count even for non-shell tools', () => {
  const s = onTool(emptyState(), { toolName: 'edit' }, { failed: true })
  assert.equal(s.turn.reason, 'tool_error')
})

test('summary on an empty log', () => {
  assert.match(summary(emptyState()), /no turns logged/)
})

test('a postToolUse result with resultType "failure" counts as a tool error', () => {
  const s = onTool(emptyState(), { toolName: 'edit', toolResult: { resultType: 'failure', textResultForLlm: 'nope' } })
  assert.equal(s.turn.reason, 'tool_error')
})

import { normaliseEvent, run, warningOutput } from '../src/effort-guard.mjs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('event names from the CLI and from VS Code map to the same events', () => {
  assert.equal(normaliseEvent('userPromptSubmitted'), 'prompt')
  assert.equal(normaliseEvent('UserPromptSubmit'), 'prompt')
  assert.equal(normaliseEvent('PostToolUse'), 'tool')
  assert.equal(normaliseEvent('errorOccurred'), 'failure')
  assert.equal(normaliseEvent('nope'), null)
})

test('the warning from the prompt hook is handed to the first tool event once', () => {
  let state = emptyState()
  let outputs = []
  for (let i = 0; i < 4; i++) {
    state = run('prompt', {}, state, 3).state
    const r = run('tool', failingTest, state, 3)
    state = r.state
    if (r.stdout) outputs.push(r.stdout)
  }
  assert.equal(outputs.length, 1)
  assert.match(outputs[0].hookSpecificOutput.additionalContext, /3 struggling turns/)
  assert.equal(outputs[0].hookSpecificOutput.hookEventName, 'PostToolUse')
})

test('VS Code style payload (snake_case, hook_event_name) works end to end through the CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eg-'))
  const env = { ...process.env, EFFORT_GUARD_DIR: dir, EFFORT_GUARD_THRESHOLD: '1', EFFORT_GUARD_DEBUG: '1' }
  const call = (payload, arg) =>
    execFileSync('node', ['src/effort-guard.mjs', ...(arg ? [arg] : [])], { input: JSON.stringify(payload), env, encoding: 'utf8' })
  call({ hook_event_name: 'UserPromptSubmit' })
  call({ hook_event_name: 'PostToolUse', tool_name: 'run_in_terminal', tool_input: { command: 'mvn test' }, tool_response: 'BUILD FAILURE' })
  call({ hook_event_name: 'UserPromptSubmit' })
  const out = call({ hook_event_name: 'PostToolUse', tool_name: 'run_in_terminal', tool_input: { command: 'ls' }, tool_response: 'ok' })
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /1 struggling turns/)
  assert.equal(readFileSync(join(dir, 'payloads.jsonl'), 'utf8').trim().split('\n').length, 4)
})

test('selftest passes', () => {
  assert.match(execFileSync('node', ['src/effort-guard.mjs', 'selftest'], { encoding: 'utf8' }), /^ok/)
})

import { stateDir } from '../src/effort-guard.mjs'
import { homedir } from 'node:os'

test('a per-user install keeps state outside the project, one folder per cwd', () => {
  const self = join(homedir(), '.copilot', 'effort-guard', 'effort-guard.mjs')
  const a = stateDir('/work/a', self)
  assert.ok(a.startsWith(join(homedir(), '.copilot', 'effort-guard', 'state')))
  assert.notEqual(a, stateDir('/work/b', self))
  assert.equal(stateDir('/work/a', '/repo/src/effort-guard.mjs'), join('/work/a', '.effort-guard'))
})

test('every hook call leaves a line in events.log, doctor and status read it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eg-'))
  const env = { ...process.env, EFFORT_GUARD_DIR: dir }
  const call = (arg, payload = {}) =>
    execFileSync('node', ['src/effort-guard.mjs', arg], { input: JSON.stringify(payload), env, encoding: 'utf8' })
  call('prompt')
  call('tool', failingTest)
  const log = readFileSync(join(dir, 'events.log'), 'utf8')
  assert.match(log, /prompt struggled=false/)
  assert.match(log, /tool tool=bash struggled=true/)
  assert.match(call('doctor'), /Are the hooks running\?\n-+\n\s+\[ok\] last call/)
  assert.match(call('status'), /current turn struggling/)
})

import { formatDoctor, parseEventLine, baseName } from '../src/report.mjs'

test('doctor report: hooks running, warnings and projects are laid out readably', () => {
  const now = new Date('2026-11-02T14:30:00')
  const events = [
    '2026-11-02T14:27:19.547Z tool tool=read_file struggled=false streak=0 cwd=C:\\Users\\x\\proj',
    '2026-11-02T14:27:25.000Z WARNING effort-guard: 3 struggling turns in a row',
  ]
  const text = formatDoctor(
    {
      nodeVersion: 'v24.0.0',
      hooksFile: '/h/effort-guard.json',
      hooksFound: true,
      stateDir: '/s',
      stateExists: true,
      threshold: 3,
      debug: false,
      events,
      projects: [{ cwd: 'C:\\Users\\x\\proj', dir: '/s/a', turns: 38, struggling: 2, streak: 1, topReason: 'tool_error', updated: '2026-11-02T14:27:25.000Z' }],
    },
    now,
  )
  assert.match(text, /\[ok\] hooks file found/)
  assert.match(text, /read_file\s+ok\s+0\s+proj/)
  assert.match(text, /\[!!\].*3 struggling turns/)
  assert.match(text, /proj\s+38\s+2\s+1\/3\s+tool_error/)
})

test('doctor report: says what to do when no hook was called', () => {
  const text = formatDoctor({ nodeVersion: 'v1', hooksFile: 'f', hooksFound: false, stateDir: 's', stateExists: false, threshold: 3, debug: true, events: [], projects: [] })
  assert.match(text, /hooks file MISSING/)
  assert.match(text, /no hook call recorded yet/)
  assert.match(text, /no state recorded yet/)
})

test('event lines parse and folder names are extracted on Windows and POSIX paths', () => {
  assert.equal(parseEventLine('garbage'), null)
  assert.equal(parseEventLine('2026-11-02T14:27:19.547Z prompt struggled=true streak=2 cwd=/a/b').streak, 2)
  assert.equal(baseName('C:\\a\\b\\proj'), 'proj')
  assert.equal(baseName('/a/b/proj/'), 'proj')
})

import { readSession } from '../src/effort-guard.mjs'

test('readSession tells VS Code chat from the CLI and falls back to the terminal tab id', () => {
  assert.deepEqual(readSession({ session_id: 'abc-12345678', hook_event_name: 'PostToolUse' }, {}), { id: '12345678', source: 'vscode-chat' })
  assert.deepEqual(readSession({}, { WT_SESSION: 'aaaa-bbbb-cccc' }), { id: 't-bbbbcccc', source: 'cli' })
  assert.equal(readSession({}, { TERM_PROGRAM: 'vscode' }).source, 'cli@vscode')
  assert.deepEqual(readSession({}, {}), { id: '-', source: 'cli' })
})

test('doctor report lists the sessions seen in the log, old log lines still parse', () => {
  const events = [
    '2026-11-02T14:00:00.000Z tool tool=bash struggled=false streak=0 session=t-bbbbcccc src=cli cwd=/w/a',
    '2026-11-02T14:01:00.000Z prompt struggled=false streak=0 session=12345678 src=vscode-chat cwd=/w/a',
    '2026-11-02T13:00:00.000Z tool tool=bash struggled=false streak=0 cwd=/w/old',
  ]
  const text = formatDoctor(
    { nodeVersion: 'v1', hooksFile: 'f', hooksFound: true, stateDir: 's', stateExists: true, threshold: 3, debug: false, events, projects: [] },
    new Date('2026-11-02T14:02:00'),
  )
  assert.match(text, /vscode-chat\s+12345678\s+a\s+1/)
  assert.match(text, /cli\s+t-bbbbcccc\s+a\s+1/)
  assert.match(text, /\?\s+-\s+old\s+1/)
})

test('a run of clean turns raises one calm notice, a struggling turn resets it', () => {
  let state = emptyState()
  const notices = []
  for (let i = 0; i < 6; i++) {
    const r = run('prompt', {}, state, 3, new Date(), 3)
    state = r.state
    if (r.notice) notices.push(r.notice)
  }
  assert.equal(notices.length, 1)
  assert.match(notices[0], /lighter model/)
  state = onTool(state, failingTest)
  state = run('prompt', {}, state, 3, new Date(), 3).state
  assert.equal(state.calm, 0)
})

import { renderBar, levelOf } from '../src/report.mjs'

test('terminal bar: segments, level and optional colour', () => {
  assert.equal(levelOf({ streak: 0, threshold: 3 }), 'ok')
  assert.equal(levelOf({ streak: 1, threshold: 3 }), 'watch')
  assert.equal(levelOf({ streak: 3, threshold: 3 }), 'warn')
  assert.equal(levelOf({ streak: 0, calm: 8, calmThreshold: 8 }), 'calm')
  assert.equal(renderBar({ streak: 2, threshold: 3 }), 'effort [■■□] 2/3 WATCH')
  assert.match(renderBar({ streak: 3, threshold: 3 }), /STRUGGLING.*RAISE the thinking/)
  assert.match(renderBar({ streak: 6, threshold: 3 }), /STRUGGLING.*UPGRADE the model/)
  assert.match(renderBar({ streak: 0, calm: 9, calmThreshold: 8 }), /SMOOTH.*DOWNGRADE/)
  assert.ok(renderBar({ streak: 3, threshold: 3 }, { color: true }).includes('\x1b[31m'))
  assert.ok(!renderBar({ streak: 3, threshold: 3 }).includes('\x1b['))
})

test('status prints the bar line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eg-'))
  const env = { ...process.env, EFFORT_GUARD_DIR: dir }
  const out = execFileSync('node', ['src/effort-guard.mjs', 'status'], { input: '{}', env, encoding: 'utf8' })
  assert.match(out, /^effort \[.*\] 0\/3 OK/)
})

test('struggling advice has two steps: more thinking at the threshold, a stronger model at twice the threshold', () => {
  let state = emptyState()
  const warnings = []
  for (let i = 0; i < 8; i++) {
    const c = closeTurn(state, 3)
    state = onTool(c.state, failingTest)
    if (c.warning) warnings.push(c.warning)
  }
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /Raise the thinking/)
  assert.match(warnings[1], /switch to a more powerful model/)
})
