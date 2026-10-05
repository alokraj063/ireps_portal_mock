/**
 * DocLink logger.
 *
 * Every message is prefixed with "[DocLink]", a time stamp and the part of
 * DocLink that wrote it, and passed through a redaction filter so that a
 * session cookie, JSESSIONID, Authorization header or security-key value can
 * never reach the console or the stored log even by accident.
 *
 * Where to read it
 * ----------------
 * DocLink runs in three separate JavaScript contexts, each with its own
 * DevTools console:
 *
 *   worker  background/service-worker.js  IREPS requests, workflows, downloads
 *   panel   popup/popup.html (side panel) what the user clicks and sees
 *   parser  background/offscreen.html     HTML parsing
 *
 * So that one console shows everything, every entry of level "info" and
 * above is also collected into one stored log (chrome.storage.local, last
 * MAX_ENTRIES entries, survives service-worker restarts and browser
 * restarts). The service worker is the only writer; the panel and parser
 * send their entries to it. The side panel's console (right-click the
 * panel > Inspect) prints the recent history when it opens and then mirrors
 * every new entry from the worker and parser live.
 *
 * Console helpers (in the panel's or the service worker's console):
 *   doclinkLog.dump()       print the stored log as a table (last 200)
 *   doclinkLog.dump(1000)   ... or more
 *   doclinkLog.download()   save the whole log as a .txt file (panel only)
 *   doclinkLog.clear()      empty the stored log
 *
 * Levels: debug < info < warn < error. Set LOG_LEVEL to "warn" for release.
 */

const PREFIX = "[DocLink]";
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Change to "warn" or "error" for production builds. */
const LOG_LEVEL = "debug";
/** Lowest level that is kept in the stored log (debug stays console-only). */
const STORE_LEVEL = "info";

/** chrome.storage.local key of the stored log: { seq: number, entries: LogEntry[] }. */
export const LOG_STORE_KEY = "doclink.log";
/** Message type the panel / parser use to hand their entries to the service worker. */
export const LOG_MESSAGE_TYPE = "DOCLINK_LOG_APPEND";
const MAX_ENTRIES = 1000;
const MAX_DATA_CHARS = 1500;
const FLUSH_DELAY_MS = 250;

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

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

/** Which part of DocLink this module instance runs in. */
function detectContext() {
  try {
    if (typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope) return "worker";
    const path = typeof location !== "undefined" ? location.pathname : "";
    if (path.includes("/background/offscreen")) return "parser";
    if (path.includes("/popup/")) return "panel";
    if (path.includes("/pages/")) return "page";
  } catch {
    /* fall through */
  }
  return "other";
}

const CONTEXT = detectContext();
const HAS_RUNTIME = typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);
const HAS_STORAGE = HAS_RUNTIME && !!(chrome.storage && chrome.storage.local);

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} LogEntry
 * @property {number} [seq]   assigned by the service worker when stored
 * @property {number} t       epoch ms
 * @property {string} level   debug | info | warn | error
 * @property {string} ctx     worker | panel | parser | page | other
 * @property {string} msg
 * @property {unknown} [data] redacted, JSON-safe extra arguments
 */

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

/** "14:03:27.512" local time. */
function clock(t) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Plain, JSON-safe copy of a log argument (Errors keep name, message, code, status, short stack). */
function toPlain(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    const out = { error: value.name, message: value.message };
    for (const key of ["code", "status", "reason", "detail"]) if (value[key] !== undefined && value[key] !== null) out[key] = value[key];
    if (value.cause) out.cause = toPlain(value.cause, depth + 1);
    if (value.stack && depth === 0) out.stack = String(value.stack).split("\n").slice(1, 4).map((l) => l.trim()).join(" | ");
    return out;
  }
  if (typeof value !== "object") return value;
  if (depth > 4) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => toPlain(v, depth + 1));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "function") continue;
    out[key] = toPlain(val, depth + 1);
  }
  return out;
}

/** Turn console-style arguments into a stored entry. */
function makeEntry(level, args) {
  const [first, ...rest] = args;
  const msg = typeof first === "string" ? first : "";
  const extra = typeof first === "string" ? rest : args;
  let data;
  if (extra.length) {
    data = redact(toPlain(extra.length === 1 ? extra[0] : extra));
    const text = safeStringify(data);
    if (text.length > MAX_DATA_CHARS) data = `${text.slice(0, MAX_DATA_CHARS)}… (truncated)`;
  }
  return { t: Date.now(), level, ctx: CONTEXT, msg: redact(msg), ...(data !== undefined ? { data } : {}) };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Console prefix of an entry, e.g. "[DocLink] 14:03:27.512 worker ›". */
function prefixOf(entry) {
  return `${PREFIX} ${clock(entry.t)} ${entry.ctx} ›`;
}

/** One-line text form of an entry (for the .txt download). */
export function formatLogEntry(entry) {
  const data = entry.data === undefined ? "" : ` ${typeof entry.data === "string" ? entry.data : safeStringify(entry.data)}`;
  return `${new Date(entry.t).toISOString()} ${entry.level.toUpperCase().padEnd(5)} ${entry.ctx.padEnd(6)} ${entry.msg}${data}`;
}

function printEntry(entry, mirrored = false) {
  const fn = console[entry.level] || console.log;
  const parts = [mirrored ? `${prefixOf(entry)}` : prefixOf(entry), entry.msg];
  if (entry.data !== undefined) parts.push(entry.data);
  try {
    fn(...parts);
  } catch {
    /* logging must never throw */
  }
}

/* -------------------------------------------------------------------------- */
/* Stored log                                                                 */
/* -------------------------------------------------------------------------- */

let pending = [];
let flushTimer = null;
let flushChain = Promise.resolve();

/** Queue entries for the stored log (worker: write; others: send to the worker). */
function enqueue(entry) {
  if (!HAS_RUNTIME) return; // plain test pages, Node
  pending.push(entry);
  // The parser document is closed as soon as a parse finishes, so its
  // entries are handed over immediately instead of batched.
  if (CONTEXT === "parser") return flush();
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

function flush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const batch = pending;
  pending = [];
  if (!batch.length) return;
  if (CONTEXT === "worker") {
    appendLogEntries(batch);
  } else {
    try {
      chrome.runtime.sendMessage({ target: "service-worker", type: LOG_MESSAGE_TYPE, entries: batch }).catch(() => {
        /* worker unreachable: the entries were still printed locally */
      });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Append entries to the stored log (service worker only; serialised so
 * concurrent batches never overwrite each other).
 * @param {LogEntry[]} entries
 */
export function appendLogEntries(entries) {
  if (!HAS_STORAGE || !Array.isArray(entries) || entries.length === 0) return flushChain;
  flushChain = flushChain
    .then(async () => {
      const stored = (await chrome.storage.local.get(LOG_STORE_KEY))[LOG_STORE_KEY] || { seq: 0, entries: [] };
      let seq = Number(stored.seq) || 0;
      const clean = entries
        .filter((e) => e && typeof e.msg === "string")
        .map((e) => ({ t: Number(e.t) || Date.now(), level: String(e.level || "info"), ctx: String(e.ctx || "other"), msg: redact(String(e.msg)).slice(0, 500), ...(e.data !== undefined ? { data: redact(e.data) } : {}), seq: ++seq }));
      const all = [...(stored.entries || []), ...clean].slice(-MAX_ENTRIES);
      await chrome.storage.local.set({ [LOG_STORE_KEY]: { seq, entries: all } });
    })
    .catch(() => {
      /* the stored log is best effort; the console still has every line */
    });
  return flushChain;
}

/**
 * Service worker: accept entries sent by the panel and the parser. Call once
 * at the top level of the service worker.
 */
export function installLogCollector() {
  if (CONTEXT !== "worker" || !HAS_RUNTIME) return;
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === LOG_MESSAGE_TYPE && Array.isArray(message.entries)) {
      appendLogEntries(message.entries.slice(0, 200));
    }
    return false;
  });
}

/** Read the stored log. @returns {Promise<LogEntry[]>} */
export async function readLogEntries() {
  if (!HAS_STORAGE) return [];
  const stored = (await chrome.storage.local.get(LOG_STORE_KEY))[LOG_STORE_KEY];
  return stored && Array.isArray(stored.entries) ? stored.entries : [];
}

/**
 * Side panel: print the recent history once (collapsed) and then mirror
 * every new entry written by the other contexts, so the panel's DevTools
 * console shows the whole DocLink log. Panel entries are already printed by
 * the panel itself and are not repeated.
 * @param {{ history?: number }} [options]
 */
export async function mirrorLogToConsole(options = {}) {
  if (!HAS_STORAGE) return;
  const historyCount = options.history ?? 100;
  let lastSeq = 0;
  try {
    const stored = (await chrome.storage.local.get(LOG_STORE_KEY))[LOG_STORE_KEY] || { seq: 0, entries: [] };
    lastSeq = Number(stored.seq) || 0;
    const recent = (stored.entries || []).slice(-historyCount);
    if (recent.length) {
      console.groupCollapsed(`${PREFIX} Earlier log: last ${recent.length} entries (doclinkLog.dump() for more, doclinkLog.download() to save)`);
      for (const entry of recent) printEntry(entry, true);
      console.groupEnd();
    }
  } catch {
    /* no history */
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[LOG_STORE_KEY]) return;
    const next = changes[LOG_STORE_KEY].newValue;
    if (!next || !Array.isArray(next.entries)) {
      lastSeq = 0; // cleared
      return;
    }
    for (const entry of next.entries) {
      if ((entry.seq || 0) <= lastSeq) continue;
      if (entry.ctx !== CONTEXT) printEntry(entry, true);
    }
    lastSeq = Number(next.seq) || lastSeq;
  });
}

/** `doclinkLog` helpers on the console of the panel / service worker. */
export function installConsoleHelpers() {
  if (!HAS_STORAGE) return;
  const target = typeof self !== "undefined" ? self : globalThis;
  target.doclinkLog = {
    async dump(count = 200) {
      const entries = (await readLogEntries()).slice(-count);
      console.table(entries.map((e) => ({ time: new Date(e.t).toLocaleString(), level: e.level, from: e.ctx, message: e.msg, data: e.data === undefined ? "" : typeof e.data === "string" ? e.data : safeStringify(e.data) })));
      return `${entries.length} entries`;
    },
    async download() {
      if (typeof document === "undefined") return "Run doclinkLog.download() in the side panel's console.";
      const entries = await readLogEntries();
      const text = `DocLink log - ${entries.length} entries - saved ${new Date().toISOString()}\n\n${entries.map(formatLogEntry).join("\n")}\n`;
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `DocLink_log_${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return `${entries.length} entries saved`;
    },
    async clear() {
      await chrome.storage.local.remove(LOG_STORE_KEY);
      return "DocLink log cleared";
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Logger                                                                     */
/* -------------------------------------------------------------------------- */

function emit(level, args) {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;
  let entry;
  try {
    entry = makeEntry(level, args);
  } catch {
    return; /* logging must never throw */
  }
  printEntry(entry);
  if (LEVELS[level] >= LEVELS[STORE_LEVEL]) enqueue(entry);
}

export const logger = {
  debug: (...args) => emit("debug", args),
  info: (...args) => emit("info", args),
  warn: (...args) => emit("warn", args),
  error: (...args) => emit("error", args)
};

export default logger;
