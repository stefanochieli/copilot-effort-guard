import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const lib = createRequire(import.meta.url)('../vscode-extension/lib.js')

test('computeView: idle, ok, watch and warn levels', () => {
  assert.equal(lib.computeView(null).level, 'idle')
  assert.equal(lib.computeView({ streak: 0, turn: {}, log: [] }).level, 'ok')
  assert.equal(lib.computeView({ streak: 1, threshold: 3, turn: {}, log: [] }).text, '$(pulse) \u25B0\u25B1\u25B1 1/3')
  const warn = lib.computeView({ streak: 3, threshold: 3, turn: {}, log: [] })
  assert.equal(warn.level, 'warn')
  assert.match(warn.tooltip, /stronger model/)
  assert.equal(lib.computeView({ streak: 0, turn: { struggled: true, reason: 'tool_error' }, log: [] }).level, 'watch')
})

test('shouldNotify fires only when the streak crosses the threshold', () => {
  assert.equal(lib.shouldNotify({ streak: 2 }, { streak: 3, threshold: 3 }), 'warn')
  assert.equal(lib.shouldNotify({ streak: 3 }, { streak: 4, threshold: 3 }), null)
  assert.equal(lib.shouldNotify(null, { streak: 1, threshold: 3 }), null)
  assert.equal(lib.shouldNotify({ streak: 2 }, null), null)
  assert.equal(lib.shouldNotify({ calm: 7 }, { streak: 0, calm: 8, calmThreshold: 8 }), 'calm')
  assert.equal(lib.shouldNotify({ calm: 8 }, { streak: 0, calm: 9, calmThreshold: 8 }), null)
})

test('findState matches the workspace folder or a subfolder, case-insensitively on Windows paths, newest first', () => {
  const projects = [
    { dir: 'a', state: { cwd: 'C:\\Users\\x\\proj\\sub', updated: '2026-11-02T10:00:00Z', streak: 1 } },
    { dir: 'b', state: { cwd: 'C:\\Users\\x\\proj', updated: '2026-11-02T12:00:00Z', streak: 2 } },
    { dir: 'c', state: { cwd: 'C:\\Users\\x\\other', updated: '2026-11-02T13:00:00Z', streak: 0 } },
  ]
  assert.equal(lib.findState(projects, ['c:\\users\\x\\PROJ']).dir, 'b')
  assert.equal(lib.findState(projects, ['C:\\Users\\x\\nothing']), null)
  assert.equal(lib.isInside('/a/bc', '/a/b'), false)
})

test('readProjects loads state.json files written by the hooks', () => {
  const home = mkdtempSync(join(tmpdir(), 'eg-ext-'))
  mkdirSync(join(home, 'effort-guard', 'state', 'abc'), { recursive: true })
  writeFileSync(join(home, 'effort-guard', 'state', 'abc', 'state.json'), JSON.stringify({ cwd: '/w', streak: 2, log: [] }))
  const projects = lib.readProjects(home)
  assert.equal(projects.length, 1)
  assert.equal(projects[0].state.streak, 2)
  assert.deepEqual(lib.readProjects(join(home, 'missing')), [])
  assert.match(lib.formatReport(projects), /\/w\n  turns 0/)
})

test('computeView suggests a lighter model after a long clean run, a stronger one when struggling', () => {
  const calm = lib.computeView({ streak: 0, calm: 8, calmThreshold: 8, turn: {}, log: [] })
  assert.equal(calm.level, 'calm')
  assert.match(calm.message, /lighter model/)
  assert.equal(lib.computeView({ streak: 0, calm: 3, calmThreshold: 8, turn: {}, log: [] }).level, 'ok')
  const warn = lib.computeView({ streak: 3, threshold: 3, calm: 0, turn: {}, log: [] })
  assert.match(warn.message, /stronger model/)
})

test('side panel html: segments follow the streak, colour follows the level, text is escaped', () => {
  const view = lib.computeView({ streak: 2, threshold: 3, turn: {}, log: [{ struggled: false }, { struggled: true }], session: { source: 'cli', id: '<x>' }, cwd: '/w', updated: new Date().toISOString() })
  const html = lib.renderHtml(view)
  assert.equal((html.match(/class="seg on"/g) ?? []).length, 2)
  assert.equal((html.match(/class="seg"/g) ?? []).length, 1)
  assert.match(html, /--c: #d29922/)
  assert.match(html, /class="dot good"/)
  assert.match(html, /class="dot bad"/)
  assert.match(html, /cli \/ &lt;x&gt;/)
  assert.match(lib.renderHtml(lib.computeView({ streak: 3, threshold: 3, turn: {}, log: [] })), /--c: #f85149/)
  assert.match(lib.renderHtml(lib.computeView(null)), /No data yet/)
})
