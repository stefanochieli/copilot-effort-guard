import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { redact, clip } from '../src/redact.mjs'

test('tokens, passwords and auth headers are redacted, ordinary commands are not', () => {
  const gh = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
  assert.equal(redact('npm test'), 'npm test')
  assert.equal(redact('mvn -q verify -Dtest=FooTest'), 'mvn -q verify -Dtest=FooTest')
  assert.equal(redact('token expired, please retry'), 'token expired, please retry')
  assert.ok(!redact(`git push https://x:${gh}@github.com/a/b`).includes(gh))
  assert.ok(!redact('curl -H "Authorization: Bearer abcdef0123456789"').includes('abcdef0123456789'))
  assert.ok(!redact('mysql --password hunter22 -u root').includes('hunter22'))
  assert.ok(!redact('export API_KEY=sekret-value-1').includes('sekret-value-1'))
  assert.ok(!redact('{"password":"hunter2hunter2"}').includes('hunter2hunter2'))
  assert.ok(!redact('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk').includes('eyJhbGci'))
})

test('redaction is linear on long input', () => {
  const started = Date.now()
  redact('token '.repeat(200_000))
  redact('--token '.repeat(100_000))
  redact('a'.repeat(2_000_000))
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`)
  assert.equal(clip('abcdef', 3), 'abc…')
})

test('state keeps a short redacted command; the debug dump is redacted unless EFFORT_GUARD_DEBUG=raw', () => {
  const secret = 'ghp_' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8'
  const payload = { toolName: 'bash', toolArgs: { command: `npm test --token=${secret} ${'x'.repeat(5000)}` }, toolResult: { textResultForLlm: 'FAIL' } }
  for (const [mode, hidden] of [['1', true], ['raw', false]]) {
    const dir = mkdtempSync(join(tmpdir(), 'eg-'))
    const env = { ...process.env, EFFORT_GUARD_DIR: dir, EFFORT_GUARD_DEBUG: mode }
    execFileSync('node', ['src/effort-guard.mjs', 'tool'], { input: JSON.stringify(payload), env })
    const state = readFileSync(join(dir, 'state.json'), 'utf8')
    assert.ok(!state.includes(secret), 'state.json must never hold the token')
    assert.ok(state.length < 2000, `state.json is ${state.length} bytes`)
    assert.equal(!readFileSync(join(dir, 'payloads.jsonl'), 'utf8').includes(secret), hidden, mode)
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dir, 'state.json')).mode & 0o077, 0, 'state.json is private to the user')
      assert.equal(statSync(join(dir, 'payloads.jsonl')).mode & 0o077, 0, 'payloads.jsonl is private to the user')
    }
  }
})
