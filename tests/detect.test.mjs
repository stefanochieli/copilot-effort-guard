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

test('a green run that prints "0 failed" is not a failure', () => {
  assert.equal(looksLikeTestFailure('npm test', 'Tests: 0 failed, 5 passed'), false)
  assert.equal(looksLikeTestFailure('mvn test', 'Tests run: 3, Failures: 0, Errors: 0'), false)
})

test('catches failure summaries without the word FAIL', () => {
  assert.equal(looksLikeTestFailure('vitest run', 'Tests  1 failed | 4 passed'), true)
  assert.equal(looksLikeTestFailure('pytest', '=== 1 failed, 3 passed in 0.2s ==='), true)
  assert.equal(looksLikeTestFailure('./gradlew test', '3 tests completed, 1 failed'), true)
  assert.equal(looksLikeTestFailure('mvn test', 'Tests run: 3, Failures: 1, Errors: 0'), true)
  assert.equal(looksLikeTestFailure('tsc', "src/a.ts(1,1): error TS2304: Cannot find name 'x'."), true)
})

test('recognises Windows and flag variants of the runners', () => {
  for (const cmd of ['npm.cmd test', 'npm t', 'pnpm -r test', 'gradlew.bat test']) {
    assert.equal(isTestCommand(cmd), true, cmd)
  }
})
