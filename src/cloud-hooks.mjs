// Hook file for Copilot cloud agent that keeps the repository light: one
// .github/hooks/effort-guard.json and no copied code. In the cloud sandbox each hook
// downloads the tagged release once per job (GitHub hosts are reachable through the
// agent firewall) and runs it; anywhere else it exits at once, so a local Copilot CLI
// that loads the same repository file does nothing twice.
export const REPO = 'stefanochieli/copilot-effort-guard'

// The script and its state stay in /tmp: nothing is written into the clone, so the
// agent cannot commit it.
export function cloudCommand(ref, event) {
  if (!/^v\d+\.\d+\.\d+$/.test(ref)) throw new Error(`not a release tag: ${ref}`)
  if (!/^[a-z]+$/.test(event)) throw new Error(`bad event: ${event}`)
  const dir = `/tmp/effort-guard-${ref}`
  const url = `https://github.com/${REPO}/archive/refs/tags/${ref}.tar.gz`
  return [
    '[ -n "$COPILOT_AGENT_PROMPT$GITHUB_COPILOT_API_TOKEN" ] || exit 0',
    `d=${dir}`,
    `[ -f "$d/src/effort-guard.mjs" ] || { mkdir -p "$d" && curl -fsSL --max-time 20 ${url} | tar -xz -C "$d" --strip-components=1; } 2>/dev/null`,
    `[ -f "$d/src/effort-guard.mjs" ] && exec node "$d/src/effort-guard.mjs" ${event}`,
    'exit 0',
  ].join('; ')
}

export function cloudHookConfig(ref) {
  // Only `bash`: the cloud sandbox is Linux, and Copilot CLI on Windows skips the entry.
  const hook = event => [{ type: 'command', bash: cloudCommand(ref, event), env: { EFFORT_GUARD_DIR: '/tmp/effort-guard-state' }, timeoutSec: 30 }]
  return {
    version: 1,
    hooks: {
      userPromptSubmitted: hook('prompt'),
      postToolUse: hook('tool'),
      postToolUseFailure: hook('failure'),
      errorOccurred: hook('failure'),
      agentStop: hook('stop'),
      sessionEnd: hook('end'),
    },
  }
}
