// Cases ported from claude-effort-guard tests/rerun.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestRerun } from '../src/rerun.mjs'

test('Maven: reruns only the failing methods, keeping -pl and quiet flags', () => {
  const out = [
    '[ERROR] Tests run: 3, Failures: 1 <<< FAILURE! -- in com.acme.FooTest',
    '[ERROR] com.acme.FooTest.bar -- Time elapsed: 0.01 s <<< FAILURE!',
    '[ERROR] Failures: ',
    '[ERROR]   FooTest.bar:42 expected: <1> but was: <2>',
    '[INFO] BUILD FAILURE',
  ].join('\n')

  assert.equal(suggestRerun('./mvnw -q -pl api verify | tee b.log', out), './mvnw -q -pl api test -Dtest=FooTest#bar -Dsurefire.failIfNoSpecifiedTests=false')
})

test('Maven: JUnit 4 wording and Failsafe ITs', () => {
  assert.equal(suggestRerun('mvn verify', '[ERROR] bar(com.acme.OrderIT)  Time elapsed: 0.2 s  <<< ERROR!'), 'mvn verify -Dit.test=OrderIT#bar -Dfailsafe.failIfNoSpecifiedTests=false')
})

test('Gradle: --tests per failing method, on the task that ran', () => {
  const out = 'com.acme.FooTest > bar() FAILED\n    org.opentest4j.AssertionFailedError\nFooTest > baz FAILED'
  assert.equal(suggestRerun('./gradlew :api:test', out), './gradlew :api:test --tests com.acme.FooTest.bar --tests FooTest.baz')
})

test('Jest, Vitest, Angular and npm scripts: the failing spec files', () => {
  assert.equal(suggestRerun('npx jest --ci', 'FAIL src/app/foo.spec.ts\n  ● foo › works'), 'npx jest src/app/foo.spec.ts')
  assert.equal(suggestRerun('npx vitest run', ' FAIL  src/a.test.ts > suite > case'), 'npx vitest run src/a.test.ts')
  assert.equal(suggestRerun('ng test --watch=false', 'FAIL src/app/x.component.spec.ts'), 'npx ng test --watch=false --include=src/app/x.component.spec.ts')
  assert.equal(suggestRerun('npm run test -- --watch=false', 'FAIL  src/a.test.tsx'), 'npm test -- src/a.test.tsx')
})

test('pytest: the failing node ids, with the same launcher', () => {
  const out = 'FAILED tests/test_a.py::test_x - AssertionError\nFAILED tests/test_b.py::T::test_y[1-2]'
  assert.equal(suggestRerun('python -m pytest -x', out), "python -m pytest tests/test_a.py::test_x 'tests/test_b.py::T::test_y[1-2]'")
})

test('nothing to target: no suggestion', () => {
  assert.equal(suggestRerun('mvn test', '[INFO] BUILD FAILURE'), null)
  assert.equal(suggestRerun('cat log', 'FAIL src/a.spec.ts'), null)
  assert.equal(suggestRerun(undefined, 'x'), null)
})

test('a cd before the runner is kept, and so is -f', () => {
  const out = '[ERROR]   FooTest.bar:42 expected: <1> but was: <2>'
  assert.equal(suggestRerun('cd backend && ./mvnw test | tee b.log', out), 'cd backend && ./mvnw test -Dtest=FooTest#bar -Dsurefire.failIfNoSpecifiedTests=false')
  assert.equal(suggestRerun('mvn -f backend/pom.xml test', out), 'mvn -f backend/pom.xml test -Dtest=FooTest#bar -Dsurefire.failIfNoSpecifiedTests=false')
  assert.equal(suggestRerun('cd web && npx jest', 'FAIL src/a.spec.ts'), 'cd web && npx jest src/a.spec.ts')
  assert.equal(suggestRerun('cd api && pytest -q', 'FAILED tests/test_a.py::test_x - Err'), 'cd api && pytest tests/test_a.py::test_x')
})

test('Maven: unit tests and ITs failing together get both properties', () => {
  const out = '[ERROR]   FooIT.bar:42 x\n[ERROR]   AuditTest.baz:1 y'
  assert.equal(suggestRerun('mvn verify', out), 'mvn verify -Dtest=AuditTest#baz -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=FooIT#bar -Dfailsafe.failIfNoSpecifiedTests=false')
})

test('PowerShell: Maven properties in double quotes, single quotes doubled', () => {
  const out = '[ERROR]   FooTest.bar:42 expected: <1> but was: <2>'
  assert.equal(
    suggestRerun('mvn -q test', out, { shell: 'powershell' }),
    'mvn -q test "-Dtest=FooTest#bar" "-Dsurefire.failIfNoSpecifiedTests=false"',
  )
  assert.equal(suggestRerun('python -m pytest', "FAILED tests/test_a.py::test_x[it's] - E", { shell: 'pwsh' }), "python -m pytest 'tests/test_a.py::test_x[it''s]'")
  assert.equal(suggestRerun('mvn -q test', out, { shell: 'bash' }), 'mvn -q test -Dtest=FooTest#bar -Dsurefire.failIfNoSpecifiedTests=false')
})
