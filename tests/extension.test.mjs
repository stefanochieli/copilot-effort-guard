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
  assert.match(warn.tooltip, /raise the thinking/)
  assert.equal(warn.action, 'thinking-up')
  const esc = lib.computeView({ streak: 6, threshold: 3, turn: {}, log: [] })
  assert.equal(esc.action, 'model-up')
  assert.match(esc.message, /more powerful model/)
  assert.match(lib.renderHtml(esc), /Upgrade model/)
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
  assert.match(calm.message, /downgrade to a lighter model/)
  assert.equal(calm.action, 'down')
  assert.equal(lib.computeView({ streak: 0, calm: 3, calmThreshold: 8, turn: {}, log: [] }).level, 'ok')
  const warn = lib.computeView({ streak: 3, threshold: 3, calm: 0, turn: {}, log: [] })
  assert.match(warn.message, /raise the thinking/)
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

test('shouldNotify escalates at twice the threshold', () => {
  assert.equal(lib.shouldNotify({ streak: 5 }, { streak: 6, threshold: 3 }), 'escalate')
  assert.equal(lib.shouldNotify({ streak: 6 }, { streak: 7, threshold: 3 }), null)
})

test('advice is labelled with the session kind and the panel lists the sessions and a reset button', () => {
  const state = { streak: 0, calm: 8, calmThreshold: 8, turn: {}, log: [], session: { source: 'cli@vscode', id: 'abc' }, sessions: [{ source: 'cli@vscode', id: 'abc', last: '2026-11-03T10:00:00Z' }, { source: 'vscode-chat', id: 'def', last: '2026-11-03T09:00:00Z' }] }
  const view = lib.computeView(state)
  assert.equal(view.kind, 'CLI')
  assert.match(view.hint, /downgrade.*\(CLI session\)/)
  const html = lib.renderHtml(view)
  assert.match(html, /Downgrade \u00b7 CLI/)
  assert.match(html, /Chat \/ def/)
  assert.match(html, /id="reset"/)
  assert.equal(lib.renderHtml(view), html, 'html must be stable between renders')
})

test('resetProject clears streaks and keeps the history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eg-reset-'))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ streak: 4, calm: 0, log: [{ struggled: true }], turn: { struggled: true, reason: 'x' }, cwd: '/p' }))
  const next = lib.resetProject(dir)
  assert.equal(next.streak, 0)
  assert.equal(next.turn.struggled, false)
  assert.equal(next.log.length, 1)
  assert.equal(next.cwd, '/p')
})

import { readFileSync, statSync, utimesSync, readdirSync } from 'node:fs'

const shared = JSON.parse(readFileSync(new URL('./fixtures/shared/views.json', import.meta.url), 'utf8'))

test('shared fixtures: same level, action, bar and advice as the IntelliJ plugin', () => {
  for (const c of shared.views) {
    const v = lib.computeView(c.state)
    assert.equal(v.level, c.level, c.name)
    assert.equal(v.action ?? null, c.action, c.name)
    assert.equal(v.hint ?? null, c.hint, c.name)
    if (c.bar) assert.equal(lib.textBar(v.streak, v.threshold), c.bar, c.name)
  }
  for (const n of shared.notify) {
    assert.equal(lib.shouldNotify(n.prev, n.cur), n.notice, JSON.stringify(n))
  }
})

test('readProjects also reads the per-repo state of the workspace folders', () => {
  const home = mkdtempSync(join(tmpdir(), 'eg-home-'))
  const repo = mkdtempSync(join(tmpdir(), 'eg-repo-'))
  mkdirSync(join(repo, '.effort-guard'))
  writeFileSync(join(repo, '.effort-guard', 'state.json'), JSON.stringify({ streak: 1, log: [] }))
  const projects = lib.readProjects(home, [repo])
  assert.equal(projects.length, 1)
  assert.equal(projects[0].state.cwd, repo) // no cwd recorded: the repo folder is used
  assert.equal(lib.findState(projects, [repo]).state.streak, 1)
})

test('readState reuses the parsed file until it changes and keeps the last good copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eg-cache-'))
  const file = join(dir, 'state.json')
  const cache = new Map()
  writeFileSync(file, JSON.stringify({ streak: 1 }))
  const first = lib.readState(file, cache)
  assert.equal(lib.readState(file, cache), first, 'unchanged file: same object, not parsed again')
  writeFileSync(file, '{"streak": 2')
  const later = new Date(Date.now() + 5000)
  utimesSync(file, later, later)
  assert.equal(lib.readState(file, cache).streak, 1, 'half-written file: last good copy')
  writeFileSync(file, JSON.stringify({ streak: 3 }))
  utimesSync(file, new Date(Date.now() + 10000), new Date(Date.now() + 10000))
  assert.equal(lib.readState(file, cache).streak, 3)
})

test('resetProject writes atomically (no temporary file left)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eg-reset2-'))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ streak: 4, log: [], turn: {} }))
  lib.resetProject(dir)
  assert.deepEqual(readdirSync(dir), ['state.json'])
})

test('shared fixtures: daily history and reasons match the IntelliJ plugin', () => {
  for (const h of shared.history) {
    assert.deepEqual(lib.dailyHistory(h.log, h.days, Date.parse(h.now)), h.expected)
    assert.deepEqual(lib.reasonCounts(h.log).map(r => [r.reason, r.count]), h.reasons)
  }
})

test('history chart and buttons are in the panel', () => {
  const now = new Date().toISOString()
  const view = lib.computeView({ streak: 0, threshold: 4, calmThreshold: 9, turn: {}, log: [{ ts: now, struggled: true, reason: 'tool_error' }, { ts: now, struggled: false }] })
  assert.equal(view.history.length, 14)
  assert.equal(view.history.at(-1).turns, 2)
  const html = lib.renderHtml(view)
  assert.match(html, /<svg class="chart"/)
  assert.match(html, /tool_error: 1/)
  assert.match(html, /data-msg="thresholds" class="secondary">Thresholds \(4 \/ 9\)/)
  assert.match(html, /data-msg="csv"/)
  assert.doesNotMatch(html, /Install hooks/)
  assert.match(lib.renderHtml({ ...view, hooks: { installed: false } }), /data-msg="install">Install hooks/)
  assert.match(lib.renderHtml({ ...view, hooks: { installed: true, outdated: true } }), /Update hooks/)
})

test('thresholds file: validated, merged with other keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eg-cfg-'))
  writeFileSync(join(dir, '.effort-guard.json'), JSON.stringify({ note: 'team' }))
  lib.writeConfig(dir, { threshold: 4, calmThreshold: 10 })
  assert.deepEqual(lib.readConfig(dir), { note: 'team', threshold: 4, calmThreshold: 10 })
  assert.equal(lib.validateThreshold('4', 1, 100), null)
  assert.notEqual(lib.validateThreshold('0', 1, 100), null)
  assert.notEqual(lib.validateThreshold('2.5', 1, 100), null)
})

test('CSV export: one row per turn, quoted when needed, no commands', () => {
  const csv = lib.toCsv([{ dir: 'd', state: { cwd: 'C:\\a,b', log: [{ ts: 't1', struggled: true, reason: 'tool_error', streak: 1 }] } }])
  assert.equal(csv, 'project,timestamp,struggled,reason,streak\n"C:\\a,b",t1,true,tool_error,1\n')
})

test('hooksStatus: not installed, installed per repo, outdated per-user copy', () => {
  const home = mkdtempSync(join(tmpdir(), 'eg-hs-'))
  const bundled = mkdtempSync(join(tmpdir(), 'eg-bundle-'))
  writeFileSync(join(bundled, 'effort-guard.mjs'), 'new')
  assert.equal(lib.hooksStatus(home, bundled).installed, false)
  const repo = mkdtempSync(join(tmpdir(), 'eg-repo-'))
  mkdirSync(join(repo, '.github', 'hooks'), { recursive: true })
  writeFileSync(join(repo, '.github', 'hooks', 'effort-guard.json'), '{}')
  assert.equal(lib.hooksStatus(home, bundled, [repo]).installed, true)
  mkdirSync(join(home, 'hooks'))
  writeFileSync(join(home, 'hooks', 'effort-guard.json'), '{}')
  mkdirSync(join(home, 'effort-guard'))
  writeFileSync(join(home, 'effort-guard', 'effort-guard.mjs'), 'old')
  assert.equal(lib.hooksStatus(home, bundled).outdated, true)
  writeFileSync(join(home, 'effort-guard', 'effort-guard.mjs'), 'new')
  assert.equal(lib.hooksStatus(home, bundled).outdated, false)
})

test('the hooks bundled in the extension install and run', async () => {
  const { execFileSync } = await import('node:child_process')
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  execFileSync(process.execPath, [join(root, 'scripts', 'bundle-hooks.mjs')])
  const home = mkdtempSync(join(tmpdir(), 'eg-inst-'))
  execFileSync(process.execPath, [join(root, 'vscode-extension', 'hooks', 'scripts', 'install.mjs'), '--user'], { env: { ...process.env, COPILOT_HOME: home } })
  assert.equal(lib.hooksStatus(home, join(root, 'vscode-extension', 'hooks', 'src')).outdated, false)
  const out = execFileSync(process.execPath, [join(home, 'effort-guard', 'effort-guard.mjs'), 'selftest'], { env: { ...process.env, COPILOT_HOME: home } }).toString()
  assert.match(out, /^ok/)
})
