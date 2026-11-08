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

test('wrappers before the package manager are skipped, other words are not', () => {
  for (const cmd of ['sudo npm test', 'CI=1 npm run build', 'env CI=1 npm test', 'time pnpm -r test', 'npm --prefix web test']) {
    assert.equal(isTestCommand(cmd), true, cmd)
  }
  for (const cmd of ['echo npm test', 'npm install test', 'npm install', 'npm config set test 1']) {
    assert.equal(isTestCommand(cmd), false, cmd)
  }
})

test('pathological command lines are scanned in linear time (no regex backtracking)', () => {
  const started = Date.now()
  for (const cmd of ['npm ' + '--a '.repeat(5000) + 'zzz', 'npm ' + '--a=b '.repeat(5000) + 'x', 'npm ' + '-a x '.repeat(5000), 'a'.repeat(100000) + ' mvn']) {
    isTestCommand(cmd)
  }
  looksLikeTestFailure('npm test', 'x'.repeat(2_000_000))
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`)
})
