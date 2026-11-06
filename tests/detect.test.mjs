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

test('green runs with zero counts are not failures', () => {
  assert.equal(looksLikeTestFailure('npm test', 'Tests: 0 failed, 5 passed'), false)
  assert.equal(looksLikeTestFailure('pytest', '5 passed, 0 failed'), false)
  assert.equal(looksLikeTestFailure('mvn test', 'Tests run: 3, Failures: 0, Errors: 0\nBUILD SUCCESS'), false)
})

test('summary-only failures of the usual runners are recognised', () => {
  const cases = [
    ['mvn test', 'Tests run: 3, Failures: 1, Errors: 0'],
    ['pytest', '=== 1 failed, 2 passed in 0.1s ==='],
    ['./gradlew test', '3 tests completed, 1 failed'],
    ['npx vitest run', ' Tests  1 failed | 4 passed (5)'],
    ['npm run build', 'error TS2304: Cannot find name'],
  ]
  for (const [cmd, out] of cases) {
    assert.equal(looksLikeTestFailure(cmd, out), true, `${cmd}: ${out}`)
  }
})

test('npm variants: npm.cmd on Windows, npm t, flags before the script', () => {
  for (const cmd of ['npm.cmd test', 'npm t', 'pnpm -r test', 'yarn --silent test', 'npm run test:unit']) {
    assert.equal(isTestCommand(cmd), true, cmd)
  }
})
