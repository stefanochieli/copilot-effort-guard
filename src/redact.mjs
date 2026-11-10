// Keeps secrets out of what the hook writes to disk (state.json, payloads.jsonl).
// Every pattern is linear: no nested repetition, so a long input cannot stall the hook.

const SECRET_PATTERNS = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted-token]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted-token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-token]'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[redacted-jwt]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  // password=..., "token": "...", Authorization: ...
  [/\b(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|auth(?:orization)?)(["']?\s*[:=]\s*["']?)(?!\[redacted)[^\s"',;&]{3,}/gi, '$1$2[redacted]'],
  // --token abc, -p secret, --api-key abc
  [/(\s--?[\w-]*(?:pass(?:word)?|token|secret|api-?key)[\w-]*)\s+(?!-|\[redacted)[^\s"']{3,}/gi, '$1 [redacted]'],
]

export function redact(text) {
  if (typeof text !== 'string' || text === '') return text
  let out = text
  for (const [re, to] of SECRET_PATTERNS) {
    out = out.replace(re, to)
  }
  return out
}

export function clip(text, max) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}
