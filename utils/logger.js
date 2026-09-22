/**
 * DocLink logger.
 *
 * Every message is prefixed with "[DocLink]" and passed through a redaction
 * filter so that a session cookie, JSESSIONID, Authorization header or
 * security-key value can never reach the console even by accident.
 *
 * Levels: debug < info < warn < error. Set LOG_LEVEL to "warn" for release.
 */

const PREFIX = "[DocLink]";
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Change to "warn" or "error" for production builds. */
const LOG_LEVEL = "debug";

/**
 * Patterns that must never be printed. Each match is replaced with a marker.
 * These are deliberately broad: a false positive costs nothing, a false
 * negative leaks a credential.
 */
const REDACTION_PATTERNS = [
  /(cookie\s*[:=]\s*)[^\n]*/gi,
  /(set-cookie\s*[:=]\s*)[^\n]*/gi,
  /(jsessionid\s*[:=]\s*)[^;\s&"']*/gi,
  /(authorization\s*[:=]\s*)[^\n]*/gi,
  /(bearer\s+)[a-z0-9\-._~+/]+=*/gi,
  /(x-csrf-token\s*[:=]\s*)[^\n]*/gi,
  /((?:password|passwd|pwd|securitykey|security-key|token)\s*[:=]\s*)[^\s&"']*/gi
];

const SENSITIVE_KEY = /cookie|session|token|authorization|password|secret|key/i;

/**
 * Redact sensitive material from any loggable value.
 * @param {unknown} value
 * @returns {unknown}
 */
export function redact(value) {
  if (typeof value === "string") {
    return REDACTION_PATTERNS.reduce(
      (text, pattern) => text.replace(pattern, "$1[REDACTED]"),
      value
    );
  }
  if (value instanceof Error) {
    return `${value.name}: ${redact(value.message)}`;
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(val);
    }
    return out;
  }
  return value;
}

function emit(level, args) {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;
  const fn = console[level] || console.log;
  try {
    fn(PREFIX, ...args.map(redact));
  } catch {
    /* logging must never throw */
  }
}

export const logger = {
  debug: (...args) => emit("debug", args),
  info: (...args) => emit("info", args),
  warn: (...args) => emit("warn", args),
  error: (...args) => emit("error", args)
};

export default logger;
