// Commands whose output is worth scanning for swallowed test/build failures.
// Anything else (cat, grep, git log...) can print "FAIL" without meaning it.
const TEST_COMMAND = new RegExp(
  [
    String.raw`(?:^|[\s;&|(])(?:\./)?(?:mvnw?|gradlew?|jest|vitest|karma|pytest|tox|tsc|make)(?=\s|$)`,
    // npm.cmd / pnpm.cmd on Windows, `npm t`, and flags before the script (`pnpm -r test`).
    String.raw`\b(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:-{1,2}[\w-]+(?:[ =]\S+)?\s+)*(?:run\s+)?(?:test|t|check|build|lint|e2e)\b`,
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

export function isTestCommand(command) {
  return typeof command === 'string' && TEST_COMMAND.test(command)
}

export function looksLikeTestFailure(command, text) {
  return isTestCommand(command) && !!text && FAILURE_PATTERNS.some(re => re.test(text))
}
