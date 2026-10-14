// Masks secrets and personal identifiers in text that may leave the machine.
// Pure string -> string. Placeholders never match the patterns themselves, so
// redact(redact(x)) === redact(x).

import os from 'node:os';

const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const PEM_OPEN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?/g;
const BEARER_RE = /\b(Bearer|Basic|Token)\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{8,}/g;
const PREFIXED_RE = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bnpm_[A-Za-z0-9]{36}/g,
];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`(?<![\\w.])${OCTET}(?:\\.${OCTET}){3}(?![\\w.])`, 'g');
const HEX_RE = /\b[0-9a-fA-F]{32,}\b/g;
// '/' is left out on purpose so file paths never merge into one long run; a
// standard base64 secret containing '/' is still caught piecewise when a piece
// is 32+ chars, and the prefixed patterns above catch the common key formats.
const B64_RE = /[A-Za-z0-9+_-]{32,}={0,2}/g;
// Bind-all and loopback addresses identify nobody.
const IP_KEEP_RE = /^(?:0\.0\.0\.0|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|255\.255\.255\.255)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** True when a long [A-Za-z0-9+/_-] run looks like a credential, not an identifier. */
export function looksHighEntropy(run) {
  const s = run.replace(/=+$/, '');
  if (s.length < 32) return false;
  if (UUID_RE.test(s)) return false;
  if (/^[0-9a-fA-F]+$/.test(s)) return true;
  const digits = (s.match(/\d/g) ?? []).length;
  const upper = (s.match(/[A-Z]/g) ?? []).length;
  const lower = (s.match(/[a-z]/g) ?? []).length;
  const symbols = (s.match(/[+/]/g) ?? []).length;
  // Identifiers are mostly letters of one case, with few digits and no +/.
  if (symbols === 0 && (digits < 3 || upper === 0 || lower === 0)) return false;
  // A dashed or underscored slug like some-long-package-name-v2-release-candidate.
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(s) && digits < 6) return false;
  // An identifier made of several short separated chunks (feat_block12_L3x_raw);
  // a random url-safe token of this length rarely holds three separators.
  const chunks = s.split(/[-_]/);
  if (chunks.length >= 4 && chunks.every((c) => c.length <= 12)) return false;
  return entropy(s) >= 4.0;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Other users' home directories (server paths copied into a session): POSIX
// /home/<user> and /Users/<user>, and the Windows forms C:\Users\<user> and
// C:/Users/<user> (a doubled backslash, as inside a string literal in code,
// counts as one separator). The lookbehind keeps URL paths like example.com/home/x.
const OTHER_HOME_RE = /(?<![\w.])\/(?:home|Users)\/[A-Za-z0-9._-]+(?![A-Za-z0-9._-])/g;
const WINDOWS_HOME_RE = /(?<![\w.])[A-Za-z]:(?:\\{1,2}|\/)(?:Users|home)(?:\\{1,2}|\/)[A-Za-z0-9._-]+(?![A-Za-z0-9._-])/g;

/**
 * redactHomePaths(text, { home }) => string
 * The path part of redact(), on its own: it rewrites nothing but home
 * directories, so it is safe on every string of a document (file paths, diff
 * lines, commit shas stay intact). Rules, in order:
 *   1. `home` (os.homedir() by default) -> '~'
 *   2. its encoded transcript-directory form ('/home/alice' -> '-home-alice',
 *      as in ~/.claude/projects/-home-alice-repo) -> '~'
 *   3. any other /home/<user>, /Users/<user>, C:\Users\<user> prefix -> '~'
 * Nothing else is touched. Idempotent.
 */
export function redactHomePaths(text, { home = os.homedir() } = {}) {
  if (text === null || text === undefined) return '';
  let out = String(text);
  if (home && typeof home === 'string' && home !== '/') {
    const h = home.replace(/[\\/]+$/, '');
    if (h) out = out.replace(new RegExp(escapeRe(h) + '(?![A-Za-z0-9_-])', 'g'), '~');
    const enc = h.replace(/[^A-Za-z0-9-]/g, '-');
    if (enc.length > 3) out = out.replace(new RegExp('(?<![A-Za-z0-9])' + escapeRe(enc) + '(?![A-Za-z0-9])', 'g'), '~');
  }
  // Windows first: 'D:/Users/x' would otherwise keep its drive letter.
  out = out.replace(WINDOWS_HOME_RE, '~');
  out = out.replace(OTHER_HOME_RE, '~');
  return out;
}

/**
 * redact(text, { home }) => string
 * Order: PEM blocks, JWTs, Authorization schemes, prefixed API keys, emails,
 * long high-entropy tokens (>=32 hex or base64-ish chars), IPv4, then the
 * home-path rules of redactHomePaths().
 */
export function redact(text, { home = os.homedir() } = {}) {
  if (text === null || text === undefined) return '';
  let out = String(text);

  out = out.replace(PEM_RE, '[REDACTED:private-key]');
  out = out.replace(PEM_OPEN_RE, '[REDACTED:private-key]');
  out = out.replace(JWT_RE, '[REDACTED:jwt]');
  out = out.replace(BEARER_RE, '$1 [REDACTED:token]');
  for (const re of PREFIXED_RE) out = out.replace(re, '[REDACTED:key]');
  out = out.replace(EMAIL_RE, '[REDACTED:email]');
  out = out.replace(HEX_RE, '[REDACTED:hex]');
  out = out.replace(B64_RE, (m) => (looksHighEntropy(m) ? '[REDACTED:token]' : m));
  out = out.replace(IPV4_RE, (m) => (IP_KEEP_RE.test(m) ? m : '[REDACTED:ip]'));

  return redactHomePaths(out, { home });
}
