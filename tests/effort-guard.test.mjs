import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyState, onTool, closeTurn, summary, readTool, resetState, touchSession } from '../src/effort-guard.mjs'

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
import { execFileSync, execFile } from 'node:child_process'
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

test('resetState clears streaks but keeps the log; touchSession keeps the latest sessions first', () => {
  const state = { ...emptyState(), streak: 3, calm: 9, log: [{ struggled: true }], pendingWarning: 'x', turn: { struggled: true, reason: 'tool_error', command: null } }
  const r = resetState(state)
  assert.equal(r.streak, 0)
  assert.equal(r.calm, 0)
  assert.equal(r.pendingWarning, null)
  assert.equal(r.turn.struggled, false)
  assert.equal(r.log.length, 1)
  let list = touchSession(undefined, { source: 'cli', id: 'a' })
  list = touchSession(list, { source: 'vscode-chat', id: 'b' })
  list = touchSession(list, { source: 'cli', id: 'a' })
  assert.deepEqual(list.map(x => x.id), ['a', 'b'])
})

// ---- review fixes -----------------------------------------------------------
// Fixtures in tests/fixtures are built from the documented schemas, NOT captured
// from a real Copilot session (see tests/fixtures/README.md).
import { promptKey, parseInput, validState, payloadCwd } from '../src/effort-guard.mjs'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

test('documented fixtures: CLI camelCase and VS Code snake_case give the same reading', () => {
  const cli = readTool(fixture('docs-cli-postToolUse-success'))
  assert.deepEqual([cli.tool, cli.command, cli.resultType, cli.text], ['bash', 'npm run ok', 'success', 'all passed'])
  const vs = readTool(fixture('docs-vscode-PostToolUse'))
  assert.deepEqual([vs.tool, vs.command, vs.text], ['run_in_terminal', 'npm test', 'FAIL src/a.test.js'])
  assert.equal(onTool(emptyState(), fixture('docs-vscode-PostToolUse')).turn.struggled, true)
  assert.equal(onTool(emptyState(), fixture('docs-cli-postToolUseFailure'), { failed: true }).turn.reason, 'tool_error')
})

test('errorOccurred counts only failed tool executions, not model or system errors', () => {
  assert.equal(onTool(emptyState(), fixture('docs-cli-errorOccurred-model'), { failed: true }).turn.struggled, false)
  assert.equal(onTool(emptyState(), fixture('docs-cli-errorOccurred-tool'), { failed: true }).turn.struggled, true)
})

test('the same prompt delivered twice (hook registered twice) closes the turn once', () => {
  const prompt = fixture('docs-cli-userPromptSubmitted')
  assert.equal(promptKey(prompt), 'sess-0001|1760000000000')
  assert.equal(promptKey({ hook_event_name: 'UserPromptSubmit' }), null)
  let state = emptyState()
  for (let i = 0; i < 6; i++) {
    const p = { ...prompt, timestamp: prompt.timestamp + i }
    state = run('prompt', p, state, 3).state
    state = run('prompt', p, state, 3).state // duplicate delivery
    state = run('tool', failingTest, state, 3).state
    state = run('tool', failingTest, state, 3).state
  }
  assert.equal(closeTurn(state, 3).state.streak, 6)
})

test('the delivered warning names the event it was delivered on', () => {
  const pending = { ...emptyState(), started: true, pendingWarning: 'W' }
  assert.equal(run('failure', { toolName: 'x' }, pending, 3).stdout.hookSpecificOutput.hookEventName, 'PostToolUseFailure')
  assert.equal(run('tool', { hook_event_name: 'PostToolUse' }, pending, 3).stdout.hookSpecificOutput.hookEventName, 'PostToolUse')
})

test('stdin with a BOM parses; invalid stdin is reported instead of silently dropped', () => {
  assert.deepEqual(parseInput('﻿{"a":1}').payload, { a: 1 })
  const bad = parseInput('{"a":')
  assert.deepEqual(bad.payload, {})
  assert.ok(bad.error)
})

test('state files: wrong shape is rejected, a corrupt one is moved aside and the hooks keep working', () => {
  assert.equal(validState({ turn: null, log: [] }), false)
  assert.equal(validState({ turn: {}, log: 'x' }), false)
  assert.equal(validState(emptyState()), true)
  const dir = mkdtempSync(join(tmpdir(), 'eg-'))
  const env = { ...process.env, EFFORT_GUARD_DIR: dir }
  const call = (payload, arg) => execFileSync('node', ['src/effort-guard.mjs', arg], { input: JSON.stringify(payload), env, encoding: 'utf8' })
  for (const bad of ['{"turn":{"struggled":tr', '{"log":"x","turn":null}']) {
    writeFileSync(join(dir, 'state.json'), bad)
    call({}, 'prompt')
    assert.equal(readFileSync(join(dir, 'state.json.bad'), 'utf8'), bad)
    assert.equal(validState(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))), true)
  }
})

test('parallel hook processes do not lose updates or leave a lock behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eg-'))
  const env = { ...process.env, EFFORT_GUARD_DIR: dir }
  const spawn = payload => new Promise(res => {
    const c = execFile('node', ['src/effort-guard.mjs', 'prompt'], { env }, () => res())
    c.stdin.end(JSON.stringify(payload))
  })
  return Promise.all(Array.from({ length: 8 }, (_, i) => spawn({ session_id: 's', timestamp: i }))).then(() => {
    assert.equal(existsSync(join(dir, 'state.json.lock')), false)
    const lines = readFileSync(join(dir, 'events.log'), 'utf8').trim().split('\n').filter(l => / prompt /.test(l))
    assert.equal(lines.length, 8)
    assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).log.length, 7) // first prompt only opens the first turn
  })
})

test('the payload cwd picks the state folder when it is a real directory', () => {
  assert.equal(payloadCwd({ cwd: tmpdir() }), tmpdir())
  assert.equal(payloadCwd({ cwd: '/no/such/dir-xyz' }), undefined)
  assert.equal(payloadCwd({}), undefined)
  const self = join(homedir(), '.copilot', 'effort-guard', 'effort-guard.mjs')
  assert.equal(stateDir(tmpdir(), self), stateDir(tmpdir() + '/', self))
})

test('the warning is written once to events.log even though it is handed over on a tool event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eg-'))
  const env = { ...process.env, EFFORT_GUARD_DIR: dir, EFFORT_GUARD_THRESHOLD: '1' }
  const call = (payload, arg) => execFileSync('node', ['src/effort-guard.mjs', arg], { input: JSON.stringify(payload), env, encoding: 'utf8' })
  call({}, 'prompt')
  call(failingTest, 'tool')
  call({}, 'prompt')
  call(failingTest, 'tool')
  assert.equal(readFileSync(join(dir, 'events.log'), 'utf8').split('\n').filter(l => / WARNING /.test(l)).length, 1)
})

test('installer: repo install ignores the state in git, uninstall keeps the user state', () => {
  const home = mkdtempSync(join(tmpdir(), 'eg-home-'))
  const repo = mkdtempSync(join(tmpdir(), 'eg-repo-'))
  const env = { ...process.env, COPILOT_HOME: home }
  const install = (...a) => execFileSync('node', ['scripts/install.mjs', ...a], { env, encoding: 'utf8' })
  install(repo)
  install(repo)
  assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), '.effort-guard/\n')
  install(repo, '--uninstall')
  assert.equal(existsSync(join(repo, '.effort-guard-hooks')), false)
  install('--user')
  mkdirSync(join(home, 'effort-guard', 'state', 'abc'), { recursive: true })
  writeFileSync(join(home, 'effort-guard', 'state', 'abc', 'state.json'), '{}')
  install('--user', '--uninstall')
  assert.equal(existsSync(join(home, 'hooks', 'effort-guard.json')), false)
  assert.equal(existsSync(join(home, 'effort-guard', 'effort-guard.mjs')), false)
  assert.equal(existsSync(join(home, 'effort-guard', 'state', 'abc', 'state.json')), true)
})

test('doctor flags the hooks registered both as user file and in the repository', () => {
  const base = { nodeVersion: 'v22', hooksFile: '/h/effort-guard.json', hooksFound: true, stateDir: '/s', stateExists: true, threshold: 3, debug: false, events: [], projects: [] }
  assert.match(formatDoctor({ ...base, duplicateHooks: '/repo/.github/hooks/effort-guard.json' }), /\[!!\] hooks registered twice/)
  assert.doesNotMatch(formatDoctor({ ...base, duplicateHooks: null }), /registered twice/)
})
