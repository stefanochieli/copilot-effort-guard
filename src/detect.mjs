// Commands whose output is worth scanning for swallowed test/build failures.
// Anything else (cat, grep, git log...) can print "FAIL" without meaning it.
const TEST_COMMAND = new RegExp(
  [
    String.raw`(?:^|[\s;&|(])(?:\./)?(?:mvnw?|gradlew?)(?:\.cmd|\.bat)?(?=\s|$)`,
    String.raw`(?:^|[\s;&|(])(?:\./)?(?:jest|vitest|karma|pytest|tox|tsc|make)(?=\s|$)`,
    // flags between the tool and the verb (`pnpm -r test`), `npm t`, Windows `npm.cmd`
    String.raw`\b(?:npm|pnpm|yarn|bun)(?:\.cmd)?(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+(?:run\s+)?(?:test|t|check|build|lint|e2e)\b`,
    String.raw`\bng\s+(?:test|build|lint|e2e)\b`,
    String.raw`\b(?:go|cargo|dotnet)\s+(?:test|build)\b`,
  ].join('|'),
)

// Text a runner prints when it failed but the exit code was swallowed
// (`npm test || true`) or the failure is reported without a non-zero exit.
const FAILURE_PATTERNS = [
  /\bFAIL(ED|URE)?\b/,
  /\b[1-9]\d*\s+failing/i,
  // "N failed" with N > 0 (Jest, Vitest, pytest, Gradle); "0 failed" is a green run
  /\b[1-9]\d*\s+failed\b/i,
  /\bFailures:\s*[1-9]/i, // Maven surefire
  /\bErrors:\s*[1-9]/i,
  /\berror TS\d+/i, // tsc
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
