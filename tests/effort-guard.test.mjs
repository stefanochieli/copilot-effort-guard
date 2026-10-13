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
