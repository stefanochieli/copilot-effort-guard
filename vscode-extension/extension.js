'use strict'
const vscode = require('vscode')
const lib = require('./lib.js')

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

function activate(context) {
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
        view.webview.onDidReceiveMessage(m => m?.type === 'reset' && resetEvaluation())
        lastHtml = ''
        view.onDidDispose(() => {
          panel = null
        })
        refresh()
      },
    }),
    vscode.commands.registerCommand('effortGuard.reset', resetEvaluation),
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
