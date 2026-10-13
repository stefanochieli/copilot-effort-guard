import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTestCommand, looksLikeTestFailure } from '../src/detect.mjs'

test('recognises the test and build runners of the usual stacks', () => {
  for (const cmd of ['npm test', 'ng test --watch=false', './mvnw -q verify', 'cd api && ./gradlew test', 'pytest -x', 'go test ./...']) {
    assert.equal(isTestCommand(cmd), true, cmd)
  }
})

test('ignores commands that only print text', () => {
  for (const cmd of ['cat build.log', 'grep FAIL build.log', 'git log --oneline', 'echo FAILED', 'ls', undefined]) {
    assert.equal(isTestCommand(cmd), false, String(cmd))
  }
})

test('failure text only counts for a test command', () => {
  assert.equal(looksLikeTestFailure('npm test || true', 'Tests: 2 failed, 5 passed'), true)
  assert.equal(looksLikeTestFailure('mvn test', '[ERROR] BUILD FAILURE'), true)
  assert.equal(looksLikeTestFailure('npm test', '12 passing'), false)
  assert.equal(looksLikeTestFailure('cat build.log', 'FAILED'), false)
})
