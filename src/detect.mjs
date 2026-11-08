// Commands whose output is worth scanning for swallowed test/build failures.
// Anything else (cat, grep, git log...) can print "FAIL" without meaning it.
const TEST_COMMAND = new RegExp(
  [
    String.raw`(?:^|[\s;&|(])(?:\./)?(?:mvnw?|gradlew?|jest|vitest|karma|pytest|tox|tsc|make)(?=\s|$)`,
    String.raw`\bng\s+(?:test|build|lint|e2e)\b`,
    String.raw`\b(?:go|cargo|dotnet)\s+(?:test|build)\b`,
  ].join('|'),
)

// Text a runner prints when it failed but the exit code was swallowed
// (`npm test || true`) or the failure is reported without a non-zero exit.
// Counts must be non-zero: "Tests: 0 failed, 5 passed" is a green run.
const FAILURE_PATTERNS = [
  /\bFAIL(ED|URE)?\b/,
  /[1-9]\d*\s+failing/i,
  /\bTests?:?\s+[1-9]\d*\s+failed/i, // Jest "Tests: 1 failed", Vitest " Tests  1 failed"
  /\b[1-9]\d*\s+failed\b/i, // pytest "=== 1 failed, 2 passed", Gradle "3 tests completed, 1 failed"
  /\bFailures:\s*[1-9]/, // Maven "Tests run: 3, Failures: 1"
  /\bErrors:\s*[1-9]/, // Maven
  /\berror TS\d+/, // tsc
  /assertionerror/i,
  /BUILD FAILURE/i,
  /[✗✖]/,
]

const SCRIPT = /^(?:test|t|check|build|lint|e2e)(?::\S*)?$/
const PACKAGE_MANAGER = /^(?:npm|pnpm|yarn|bun)(?:\.cmd)?$/i
const WRAPPER = /^(?:sudo|time|nice|env|cross-env|command|exec)$/i
const MAX_COMMAND = 4000
const MAX_TEXT = 100_000

// `npm test`, `npm.cmd run build`, `npm t`, `pnpm -r test`, `npm --prefix web test`.
// Done on tokens, not with a regex: a pattern with nested repetition over the flags
// backtracks exponentially on a long `npm --a --a --a ...` line.
function packageScript(segment) {
  const tokens = segment.trim().split(/\s+/)
  // Skip a few wrappers: `sudo npm test`, `time npm test`, `CI=1 npm test`, `env CI=1 npm test`.
  let start = 0
  while (start < 4 && (WRAPPER.test(tokens[start] ?? '') || /^\w+=/.test(tokens[start] ?? ''))) start++
  tokens.splice(0, start)
  if (!PACKAGE_MANAGER.test(tokens[0] ?? '')) return false
  let afterFlag = false
  for (const tok of tokens.slice(1, 12)) {
    if (tok.startsWith('-')) {
      afterFlag = !tok.includes('=')
      continue
    }
    if (tok === 'run') {
      afterFlag = false
      continue
    }
    if (SCRIPT.test(tok)) return true
    if (!afterFlag) return false
    afterFlag = false // the token was the value of the flag before it
  }
  return false
}

export function isTestCommand(command) {
  if (typeof command !== 'string') return false
  const cmd = command.slice(0, MAX_COMMAND)
  return TEST_COMMAND.test(cmd) || cmd.split(/[;&|()\n]+/).some(packageScript)
}

export function looksLikeTestFailure(command, text) {
  if (!isTestCommand(command) || !text) return false
  // The verdict of a runner is at the end of its output: scan a bounded tail.
  const tail = text.length > MAX_TEXT ? text.slice(-MAX_TEXT) : text
  return FAILURE_PATTERNS.some(re => re.test(tail))
}
