'use strict'
const vscode = require('vscode')
const lib = require('./lib.js')

let item
let timer
let previous = null
let panel = null
let lastHtml = ''

function settings() {
  const cfg = vscode.workspace.getConfiguration('effortGuard')
  return { home: lib.copilotHome(cfg.get('copilotHome')), threshold: cfg.get('threshold') || 3, notify: cfg.get('notify') !== false }
}

function refresh() {
  const { home, threshold, notify } = settings()
  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
  const found = lib.findState(lib.readProjects(home), folders)
  const state = found?.state ?? null
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
        lastHtml = ''
        view.onDidDispose(() => {
          panel = null
        })
        refresh()
      },
    }),
    vscode.commands.registerCommand('effortGuard.showReport', () => {
      channel.clear()
      channel.appendLine(lib.formatReport(lib.readProjects(settings().home)))
      channel.show(true)
    }),
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('effortGuard') && refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
  )

  refresh()
  timer = setInterval(refresh, 2000)
  context.subscriptions.push({ dispose: () => clearInterval(timer) })
}

function deactivate() {
  clearInterval(timer)
}

module.exports = { activate, deactivate }
