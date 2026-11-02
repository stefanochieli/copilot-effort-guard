// Pure formatting for the `doctor` report: no I/O, so it can be tested.

const EVENT_RE = /^(\S+) (\S+?)(?: tool=(\S+))? struggled=(true|false) streak=(\d+) cwd=(.*)$/

export function parseEventLine(line) {
  const warning = line.match(/^(\S+) WARNING (.*)$/)
  if (warning) {
    return { ts: warning[1], kind: 'warning', text: warning[2] }
  }
  const m = line.match(EVENT_RE)
  if (!m) {
    return null
  }
  return { ts: m[1], kind: 'event', event: m[2], tool: m[3] ?? null, struggled: m[4] === 'true', streak: Number(m[5]), cwd: m[6] }
}

export function baseName(path) {
  const parts = String(path ?? '').split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? String(path ?? '')
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

// "12:34:56" today, "02/11 12:34" otherwise (local time).
export function formatTime(iso, now = new Date()) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    return iso
  }
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay ? time : `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${time.slice(0, 5)}`
}

export function relativeAge(iso, now = new Date()) {
  const s = Math.max(0, Math.round((now - new Date(iso)) / 1000))
  if (Number.isNaN(s)) {
    return '?'
  }
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

function table(rows, headers) {
  const all = [headers, ...rows]
  const widths = headers.map((_, i) => Math.max(...all.map(r => String(r[i]).length)))
  const line = r => '  ' + r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd()
  return [line(headers), line(widths.map(w => '-'.repeat(w))), ...rows.map(line)].join('\n')
}

// projects: [{ cwd, dir, turns, struggling, topReason, streak, updated }]
export function formatDoctor(info, now = new Date()) {
  const ok = '[ok]'
  const bad = '[!!]'
  const out = []
  const section = title => out.push('', title, '-'.repeat(title.length))

  out.push('effort-guard doctor')

  section('Setup')
  out.push(`  ${ok} node ${info.nodeVersion}`)
  out.push(info.hooksFound ? `  ${ok} hooks file found` : `  ${bad} hooks file MISSING: run scripts/install.mjs --user`)
  out.push(`        ${info.hooksFile}`)
  out.push(`  ${ok} threshold: ${info.threshold} struggling turns in a row`)
  out.push(`  ${info.debug ? ok : '    '} payload dump ${info.debug ? 'on' : 'off (set EFFORT_GUARD_DEBUG=1 to enable)'}`)
  out.push(`        state for this folder: ${info.stateDir} (${info.stateExists ? 'exists' : 'not created yet'})`)

  const events = info.events.map(parseEventLine).filter(Boolean)
  const calls = events.filter(e => e.kind === 'event')
  const warnings = events.filter(e => e.kind === 'warning')

  section('Are the hooks running?')
  if (calls.length === 0) {
    out.push(`  ${bad} no hook call recorded yet.`)
    out.push('        Restart Copilot (hooks load at startup), send a prompt that uses a tool, run doctor again.')
  } else {
    const last = calls.at(-1)
    out.push(`  ${ok} last call ${relativeAge(last.ts, now)} (${formatTime(last.ts, now)}), event "${last.event}"${last.tool ? `, tool ${last.tool}` : ''}`)
    out.push('')
    out.push(
      table(
        calls.slice(-8).map(e => [formatTime(e.ts, now), e.event, e.tool ?? '-', e.struggled ? 'struggling' : 'ok', e.streak, baseName(e.cwd)]),
        ['time', 'event', 'tool', 'turn', 'streak', 'folder'],
      ),
    )
  }

  section('Warnings')
  if (warnings.length === 0) {
    out.push('  none in the recent log.')
  } else {
    for (const w of warnings.slice(-3)) {
      out.push(`  ${bad} ${formatTime(w.ts, now)}  ${w.text}`)
    }
  }

  section('Projects')
  if (info.projects.length === 0) {
    out.push('  no state recorded yet.')
  } else {
    const sorted = [...info.projects].sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')))
    out.push(
      table(
        sorted.map(p => [
          baseName(p.cwd ?? p.dir),
          p.turns,
          p.struggling,
          `${p.streak}/${info.threshold}`,
          p.topReason ?? '-',
          p.updated ? relativeAge(p.updated, now) : '-',
        ]),
        ['project', 'turns', 'struggling', 'streak', 'main cause', 'last activity'],
      ),
    )
    out.push('')
    out.push('  State is per working directory: run doctor from the folder you use Copilot in to see its line first.')
  }

  return out.join('\n') + '\n'
}
