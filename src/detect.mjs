// Commands whose output is worth scanning for swallowed test/build failures.
// Anything else (cat, grep, git log...) can print "FAIL" without meaning it.
const TEST_COMMAND = new RegExp(
  [
    String.raw`(?:^|[\s;&|(])(?:\./)?(?:mvnw?|gradlew?|jest|vitest|karma|pytest|tox|tsc|make)(?=\s|$)`,
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|build|lint|e2e)\b`,
    String.raw`\bng\s+(?:test|build|lint|e2e)\b`,
    String.raw`\b(?:go|cargo|dotnet)\s+(?:test|build)\b`,
  ].join('|'),
)

// Text a runner prints when it failed but the exit code was swallowed
// (`npm test || true`) or the failure is reported without a non-zero exit.
const FAILURE_PATTERNS = [
  /\bFAIL(ED|URE)?\b/,
  /\d+\s+failing/i,
  /tests?:\s*\d+\s*failed/i,
  /assertionerror/i,
  /BUILD FAILURE/i,
  /[✗✖]/,
]

export function isTestCommand(command) {
  return typeof command === 'string' && TEST_COMMAND.test(command)
}

export function looksLikeTestFailure(command, text) {
  return isTestCommand(command) && !!text && FAILURE_PATTERNS.some(re => re.test(text))
}
