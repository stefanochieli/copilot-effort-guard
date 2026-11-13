// Tool errors that say nothing about the task being hard. Extend the defaults here,
// or per repository in .effort-guard.json:
//   { "benignErrors": ["PLAN_MISMATCH"], "probeCommands": ["javap"], "gapMinutes": 30 }
// Matching is a case-insensitive substring test on the tool output.
export const BENIGN_ERRORS = [
  'view_range out of bounds', // the view tool asked for lines past the end of a file
  'too large, not read', // the view tool refused a big file
  'permission to run this tool was denied', // a permission rule, not a struggle
  '--deny-tool', // command refused by a --deny-tool rule
  'denied by a deny-tool rule',
]

// A command that is not installed (Windows exit 9009, "command not found"): the first
// one in a turn is an environment hiccup, a second one in the same turn counts.
export const MISSING_COMMAND = [
  'python non è stato trovato',
  'python was not found',
  'is not recognized as an internal or external command',
  'non è riconosciuto come comando interno o esterno',
  'command not found',
]
export const MISSING_EXIT_CODES = [9009, 127]

// Commands whose non-zero exit is an answer to a question (does it exist?), on top
// of grep/diff/test/where in detect.mjs. Matched on the first word of the command.
export const PROBE_COMMANDS = ['get-childitem', 'gci', 'ls', 'dir', 'test-path', 'get-item', 'stat']

function lower(list) {
  return (Array.isArray(list) ? list : []).filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().toLowerCase())
}

// Defaults plus the repository's own entries.
export function errorRules(config = {}) {
  return {
    benign: [...BENIGN_ERRORS, ...lower(config.benignErrors)],
    missing: MISSING_COMMAND,
    probes: [...PROBE_COMMANDS, ...lower(config.probeCommands)],
  }
}

const TAIL = 20_000

export function isBenignError(text, rules = errorRules()) {
  const t = String(text ?? '').slice(-TAIL).toLowerCase()
  return t !== '' && rules.benign.some(s => t.includes(s))
}

export function isMissingCommand(text, exitCode, rules = errorRules()) {
  if (MISSING_EXIT_CODES.includes(exitCode)) return true
  const t = String(text ?? '').slice(-TAIL).toLowerCase()
  return t !== '' && rules.missing.some(s => t.includes(s))
}

export function isProbe(command, rules = errorRules()) {
  const first = String(command ?? '').trim().split(/\s+/)[0]?.replace(/^\.\//, '').toLowerCase() ?? ''
  return first !== '' && rules.probes.includes(first)
}
