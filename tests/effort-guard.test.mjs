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
  assert.match(call('doctor'), /last hook calls:/)
  assert.match(call('status'), /current turn struggling/)
})
