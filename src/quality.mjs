// Signals about the quality of the result (not the effort), kept per closed turn:
//   tests   'green' | 'red'   last test/build command of the turn
//   rework  true              the next prompt asked to fix or redo it
//   reedits N                 files edited again that an earlier recent turn had edited
//   vote    'up' | 'down'     explicit vote from the IDE panel
// Nothing here changes the streak: quality is shown next to the effort, not mixed into it.
import { createHash } from 'node:crypto'

// Tools that write files (Copilot CLI and VS Code agent names; prefix match, case-insensitive).
// Not confirmed on a real capture yet: `effort-guard payloads` lists the names that arrive.
const EDIT_TOOL = /^(edit|create|write|str_replace|apply_patch|replace_string_in_file|multi_replace_string_in_file|insert_edit_into_file|create_file|editfiles|edit_file|write_file|notebook_edit)/i

export function isEditTool(tool) {
  return EDIT_TOOL.test(String(tool ?? ''))
}

// Short hashes of the edited paths: enough to spot re-edits without storing paths.
export function editedFiles(args) {
  if (!args || typeof args !== 'object') return []
  const raw = []
  for (const k of ['path', 'filePath', 'file_path', 'file', 'filename', 'target_file']) {
    if (typeof args[k] === 'string') raw.push(args[k])
  }
  for (const k of ['files', 'filePaths', 'paths']) {
    if (Array.isArray(args[k])) for (const f of args[k]) if (typeof f === 'string') raw.push(f)
  }
  const norm = p => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  return [...new Set(raw.slice(0, 50).map(p => createHash('sha1').update(norm(p)).digest('hex').slice(0, 10)))]
}

// A follow-up prompt that asks to correct the previous result (Italian and English).
// The prompt text is only classified here, never stored.
const REWORK = [
  /\bnon (funziona|va|compila|parte|passa)\b/i,
  /\b(è|e'|hai fatto|risulta) sbagliat/i,
  /\b(ancora|di nuovo) (errore|errori|rotto|fallisce|non)/i,
  /\b(rifai|riprova|correggi|sistema|aggiusta)\b/i,
  /\b(annulla|ripristina|torna indietro)\b/i,
  /\b(doesn'?t|does not|didn'?t|did not) work\b/i,
  /\bstill (fail|failing|broken|not working|wrong|the same)\b/i,
  /\b(that'?s|this is|it'?s) (wrong|broken|incorrect)\b/i,
  /\b(try again|redo|revert|undo|roll ?back)\b/i,
]

export function looksLikeRework(prompt) {
  if (typeof prompt !== 'string' || !prompt) return false
  const head = prompt.slice(0, 2000)
  return REWORK.some(re => re.test(head))
}

// 0..1 for one closed turn; null when there is no signal at all. A vote overrides the rest.
export function qualityOf(entry) {
  if (!entry) return null
  if (entry.vote === 'up') return 1
  if (entry.vote === 'down') return 0
  const signals = entry.tests || entry.rework || entry.reedits
  if (!signals) return null
  let q = 1
  if (entry.tests === 'red') q -= 0.5
  if (entry.rework) q -= 0.4
  if (entry.reedits) q -= 0.2
  return Math.max(0, Math.round(q * 100) / 100)
}

// Average quality of the last `n` turns that carry a signal, with the counts behind it.
export function qualitySummary(log, n = 20) {
  const rated = (log ?? []).filter(e => qualityOf(e) !== null).slice(-n)
  const counts = { green: 0, red: 0, rework: 0, reedits: 0, up: 0, down: 0 }
  for (const e of rated) {
    if (e.tests === 'green') counts.green++
    if (e.tests === 'red') counts.red++
    if (e.rework) counts.rework++
    if (e.reedits) counts.reedits++
    if (e.vote === 'up') counts.up++
    if (e.vote === 'down') counts.down++
  }
  if (!rated.length) return { score: null, level: 'unknown', rated: 0, counts }
  const score = Math.round((rated.reduce((s, e) => s + qualityOf(e), 0) / rated.length) * 100)
  return { score, level: score >= 75 ? 'good' : score >= 50 ? 'fair' : 'poor', rated: rated.length, counts }
}
