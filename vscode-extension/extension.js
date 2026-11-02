'use strict'
const vscode = require('vscode')
const lib = require('./lib.js')

let item
let timer
let previous = null

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
  item.backgroundColor = view.level === 'warn' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined

  if (notify && lib.shouldNotify(previous, state, threshold)) {
    vscode.window.showWarningMessage(view.tooltip.split('\n').filter(Boolean).join(' - '))
  }
  previous = state
}

function activate(context) {
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  item.command = 'effortGuard.showReport'
  item.show()

  const channel = vscode.window.createOutputChannel('Effort Guard')
  context.subscriptions.push(
    item,
    channel,
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
