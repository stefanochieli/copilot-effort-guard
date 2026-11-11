'use strict'
const vscode = require('vscode')
const path = require('node:path')
const fs = require('node:fs')
const { execFile } = require('node:child_process')
const lib = require('./lib.js')

// Hooks bundled with the extension (scripts/bundle-hooks.mjs, run by vsce package).
const BUNDLED = path.join(__dirname, 'hooks')
let extensionContext = null
let hooks = null
let hooksCheckedAt = 0

let item
let timer
let previous = null
let panel = null
let lastHtml = ''
let currentDir = null

function settings() {
  const cfg = vscode.workspace.getConfiguration('effortGuard')
  return { home: lib.copilotHome(cfg.get('copilotHome')), threshold: cfg.get('threshold') || 3, notify: cfg.get('notify') !== false }
}

function refresh() {
  const { home, threshold, notify } = settings()
  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
  const found = lib.findState(lib.readProjects(home, folders), folders)
  const state = found?.state ?? null
  currentDir = found?.dir ?? null
  const view = lib.computeView(state, threshold)
  // Checking the installed hooks reads files: once a minute is enough.
  if (!hooks || Date.now() - hooksCheckedAt > 60000) {
    hooks = lib.hooksStatus(home, path.join(BUNDLED, 'src'), folders)
    hooksCheckedAt = Date.now()
  }
  view.hooks = hooks

  item.text = view.text
  item.tooltip = view.tooltip
  // Status bar items can only use the warning/error backgrounds; the other levels tint the text.
  item.backgroundColor = view.level === 'warn' ? new vscode.ThemeColor('statusBarItem.errorBackground') : view.level === 'watch' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
  const themeColor = lib.LEVEL_THEME_COLOR[view.level]
  item.color = themeColor && view.level !== 'warn' && view.level !== 'watch' ? new vscode.ThemeColor(themeColor) : undefined

  if (panel) {
    const html = lib.renderHtml(view)
    if (html !== lastHtml) {
      panel.webview.html = html
      lastHtml = html
    }
  }

  const kind = notify ? lib.shouldNotify(previous, state, threshold) : null
  if (kind === 'warn' || kind === 'escalate') {
    vscode.window.showWarningMessage(`Effort Guard: ${view.messages[kind]}`)
  } else if (kind === 'calm') {
    vscode.window.showInformationMessage(`Effort Guard: ${view.messages.calm}`)
  }
  previous = state
}

function resetEvaluation() {
  if (!currentDir) {
    vscode.window.showInformationMessage('Effort Guard: no data for this folder yet, nothing to reset.')
    return
  }
  try {
    lib.resetProject(currentDir)
    previous = null
    refresh()
    vscode.window.showInformationMessage('Effort Guard: evaluation restarted.')
  } catch (err) {
    vscode.window.showErrorMessage(`Effort Guard: reset failed (${err.message})`)
  }
}

function workspaceFolder() {
  const folders = vscode.workspace.workspaceFolders ?? []
  if (folders.length <= 1) return Promise.resolve(folders[0]?.uri.fsPath)
  return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Project for the Effort Guard thresholds' }).then(f => f?.uri.fsPath)
}

// Installs (or updates) the per-user hooks with the installer bundled in the extension.
// Needs Node.js 20+ in the PATH: the hooks themselves run with it.
function installHooks() {
  const installer = path.join(BUNDLED, 'scripts', 'install.mjs')
  if (!fs.existsSync(installer)) {
    vscode.window.showErrorMessage('Effort Guard: this build of the extension has no bundled hooks. Install them from the repository: node scripts/install.mjs --user')
    return
  }
  const env = { ...process.env, COPILOT_HOME: settings().home }
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Effort Guard: installing the Copilot hooks…' }, () =>
    new Promise(resolve => {
      execFile('node', [installer, '--user'], { env, timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
        hooks = null
        if (err) {
          const msg = err.code === 'ENOENT' ? 'Node.js 20 or later was not found in the PATH. Install it from https://nodejs.org and try again.' : (stderr || err.message).trim()
          vscode.window.showErrorMessage(`Effort Guard: hook install failed. ${msg}`)
        } else {
          vscode.window.showInformationMessage('Effort Guard: hooks installed. Restart the Copilot CLI and run "Developer: Reload Window" so Copilot loads them.', 'Reload Window').then(a => a && vscode.commands.executeCommand('workbench.action.reloadWindow'))
        }
        refresh()
        resolve()
      })
    }),
  )
}

// Offers the install once, when nothing is installed (or the per-user copy is outdated).
function offerInstall() {
  const state = extensionContext.globalState
  if (!hooks || state.get('effortGuard.installOfferDismissed')) return
  if (!hooks.installed) {
    vscode.window.showInformationMessage('Effort Guard: the Copilot hooks are not installed, so the bar has no data. Install them now?', 'Install hooks', "Don't ask again").then(a => {
      if (a === 'Install hooks') installHooks()
      else if (a) state.update('effortGuard.installOfferDismissed', true)
    })
  } else if (hooks.outdated) {
    vscode.window.showInformationMessage('Effort Guard: the installed hooks are older than this extension. Update them?', 'Update hooks', "Don't ask again").then(a => {
      if (a === 'Update hooks') installHooks()
      else if (a) state.update('effortGuard.installOfferDismissed', true)
    })
  }
}

// Writes .effort-guard.json in the project folder, read by the hooks at every event.
async function setThresholds() {
  const folder = await workspaceFolder()
  if (!folder) {
    vscode.window.showInformationMessage('Effort Guard: open a folder first.')
    return
  }
  const current = lib.readConfig(folder)
  const threshold = await vscode.window.showInputBox({
    title: 'Effort Guard: struggling turns in a row before the warning',
    value: String(current.threshold ?? previous?.threshold ?? 3),
    validateInput: v => lib.validateThreshold(v, 1, 100),
  })
  if (threshold === undefined) return
  const calm = await vscode.window.showInputBox({
    title: 'Effort Guard: clean turns in a row before suggesting a lighter model',
    value: String(current.calmThreshold ?? previous?.calmThreshold ?? 8),
    validateInput: v => lib.validateThreshold(v, 2, 1000),
  })
  if (calm === undefined) return
  try {
    const { file } = lib.writeConfig(folder, { threshold: Number(threshold), calmThreshold: Number(calm) })
    vscode.window.showInformationMessage(`Effort Guard: thresholds ${threshold} / ${calm} saved in ${path.basename(file)}; they apply from the next Copilot event. Commit the file to share them with the team.`)
  } catch (err) {
    vscode.window.showErrorMessage(`Effort Guard: could not save the thresholds (${err.message})`)
  }
}

async function exportCsv() {
  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
  const projects = lib.readProjects(settings().home, folders)
  if (!projects.length) {
    vscode.window.showInformationMessage('Effort Guard: nothing recorded yet.')
    return
  }
  const target = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, defaultUri: vscode.Uri.file(path.join(folders[0] ?? require('node:os').homedir(), 'effort-guard-history.csv')) })
  if (!target) return
  await vscode.workspace.fs.writeFile(target, Buffer.from(lib.toCsv(projects), 'utf8'))
  vscode.window.showInformationMessage(`Effort Guard: history exported to ${target.fsPath}`)
}

const PANEL_ACTIONS = { reset: () => resetEvaluation(), install: () => installHooks(), thresholds: () => setThresholds(), csv: () => exportCsv() }

function activate(context) {
  extensionContext = context
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  item.command = 'workbench.view.extension.effortGuard'
  item.show()

  const channel = vscode.window.createOutputChannel('Effort Guard')
  context.subscriptions.push(
    item,
    channel,
    vscode.window.registerWebviewViewProvider('effortGuard.panel', {
      resolveWebviewView(view) {
        panel = view
        view.webview.options = { enableScripts: true }
        view.webview.onDidReceiveMessage(m => PANEL_ACTIONS[m?.type]?.())
        lastHtml = ''
        view.onDidDispose(() => {
          panel = null
        })
        refresh()
      },
    }),
    vscode.commands.registerCommand('effortGuard.reset', resetEvaluation),
    vscode.commands.registerCommand('effortGuard.installHooks', installHooks),
    vscode.commands.registerCommand('effortGuard.setThresholds', setThresholds),
    vscode.commands.registerCommand('effortGuard.exportCsv', exportCsv),
    vscode.commands.registerCommand('effortGuard.showReport', () => {
      channel.clear()
      channel.appendLine(lib.formatReport(lib.readProjects(settings().home, (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath))))
      channel.show(true)
    }),
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('effortGuard') && refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
  )

  // Instant refresh when a hook writes the state; the timer stays as a fallback
  // (watchers outside the workspace are not guaranteed on every platform).
  let pending = null
  const soon = () => {
    clearTimeout(pending)
    pending = setTimeout(refresh, 150)
  }
  const watchers = [
    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(settings().home), 'effort-guard/state/*/state.json')),
    vscode.workspace.createFileSystemWatcher('**/.effort-guard/state.json'),
  ]
  for (const w of watchers) {
    context.subscriptions.push(w, w.onDidChange(soon), w.onDidCreate(soon))
  }
  // A window in the background is refreshed less often; focus brings it up to date.
  context.subscriptions.push(vscode.window.onDidChangeWindowState(e => e.focused && refresh()))

  refresh()
  offerInstall()
  timer = setInterval(() => {
    if (vscode.window.state.focused || panel?.visible) refresh()
  }, 2000)
  const slow = setInterval(refresh, 15000)
  context.subscriptions.push({ dispose: () => (clearInterval(timer), clearInterval(slow), clearTimeout(pending)) })
}

function deactivate() {
  clearInterval(timer)
}

module.exports = { activate, deactivate }
