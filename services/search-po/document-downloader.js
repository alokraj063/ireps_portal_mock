/**
 * Generic IREPS document downloader (used by the MA copies feature).
 *
 * IREPS serves the actual documents (MA PDFs, PO PDFs, ...) at the hrefs
 * it prints in the result tables. DocLink fetches such a link with the
 * user's authenticated browser session, verifies that the response really
 * is a PDF and hands the bytes to chrome.downloads.
 *
 * Verification matters because IREPS answers an expired session with an
 * HTML login page and HTTP 200: that must surface as IREPS_SESSION_EXPIRED,
 * never be saved as "<something>.pdf".
 *
 * Batches run with limited concurrency and report Queued / Downloading /
 * Completed / Failed per item. When the session expires mid-batch the
 * remaining items are not attempted and are reported as failed with
 * IREPS_SESSION_EXPIRED so the user can log in again and retry them.
 *
 * Error codes are supplied by the caller so each document type keeps its
 * own vocabulary (IREPS_MA_LINK_NOT_FOUND, IREPS_MA_DOWNLOAD_FAILED,
 * IREPS_MA_INVALID_PDF, ...).
 */

import { IREPS_CONFIG, IREPS_ERROR, IrepsError } from "../ireps-api.js";
import { isIrepsLoginPage } from "../session-service.js";
import { downloadBytes } from "../download-service.js";
import { logger } from "../../utils/logger.js";
import { isIrepsOriginUrl } from "./search-po-api.js";

export const DOCUMENT_DOWNLOAD_CONCURRENCY = 3;

export const DOCUMENT_DOWNLOAD_STATUS = Object.freeze({
  QUEUED: "queued",
  DOWNLOADING: "downloading",
  COMPLETED: "completed",
  FAILED: "failed"
});

const DEFAULT_CODES = Object.freeze({
  LINK_NOT_FOUND: "IREPS_DOCUMENT_LINK_NOT_FOUND",
  DOWNLOAD_FAILED: "IREPS_DOCUMENT_DOWNLOAD_FAILED",
  INVALID_PDF: "IREPS_DOCUMENT_INVALID_PDF",
  SESSION_EXPIRED: IREPS_ERROR.SESSION_EXPIRED
});

const PDF_SIGNATURE = "%PDF-";
/** The PDF header may be preceded by up to 1024 bytes of junk (PDF 1.7, Appendix H). */
const PDF_SIGNATURE_WINDOW = 1024;
const TEXT_PROBE_BYTES = 65536;

/** Does the byte array carry the "%PDF-" signature within the allowed window? */
export function looksLikePdf(bytes) {
  if (!bytes || bytes.length < PDF_SIGNATURE.length) return false;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, PDF_SIGNATURE_WINDOW)));
  return head.includes(PDF_SIGNATURE);
}

function looksLikeHtml(text, contentType) {
  if (/text\/html|application\/xhtml/i.test(contentType || "")) return true;
  return /<\s*(!doctype\s+html|html|head|body|form|table|script)\b/i.test(text);
}

function safePath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/**
 * Fetch one document from IREPS with the browser session and verify it is a PDF.
 *
 * @param {string|null} url   absolute IREPS URL (from a parsed record)
 * @param {{ fetch?: typeof fetch, timeoutMs?: number, codes?: object }} [deps]
 * @returns {Promise<{ bytes: Uint8Array, contentType: string, status: number }>}
 */
export async function fetchIrepsDocument(url, deps = {}) {
  const CODES = { ...DEFAULT_CODES, ...(deps.codes || {}) };
  if (!url) throw new IrepsError(CODES.LINK_NOT_FOUND, "Record has no document link", { detail: "IREPS did not provide a link" });
  if (!isIrepsOriginUrl(url)) {
    throw new IrepsError(CODES.LINK_NOT_FOUND, "Document link points outside the IREPS origin", { detail: "the link does not point to IREPS" });
  }
  const fetchImpl = deps.fetch || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs || IREPS_CONFIG.timeoutMs);

  logger.info("IREPS document request started", { path: safePath(url) });
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      headers: { Accept: "application/pdf,*/*;q=0.8" },
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    const timeout = error && error.name === "AbortError";
    throw new IrepsError(CODES.DOWNLOAD_FAILED, timeout ? "IREPS did not respond in time" : "Unable to reach IREPS", {
      reason: timeout ? "timeout" : "network",
      detail: timeout ? "IREPS did not respond in time" : "IREPS could not be reached",
      cause: error
    });
  }

  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    clearTimeout(timer);
    throw new IrepsError(CODES.DOWNLOAD_FAILED, "Document response could not be read", {
      reason: "network",
      status: response.status,
      detail: "the IREPS response could not be read",
      cause: error
    });
  }
  clearTimeout(timer);
  const contentType = response.headers.get("content-type") || "";
  logger.info(`IREPS document response status: ${response.status}`, { bytes: bytes.length, contentType, finalPath: safePath(response.url) });

  if (!response.ok) {
    throw new IrepsError(CODES.DOWNLOAD_FAILED, `IREPS returned HTTP ${response.status}`, {
      reason: "http",
      status: response.status,
      detail: `IREPS returned HTTP ${response.status}`
    });
  }
  if (looksLikePdf(bytes)) return { bytes, contentType, status: response.status };

  // Not a PDF. Distinguish "session expired" from "something else".
  const probe = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, TEXT_PROBE_BYTES)));
  if (looksLikeHtml(probe, contentType)) {
    if (isIrepsLoginPage(probe, { url: response.url, redirected: response.redirected })) {
      throw new IrepsError(CODES.SESSION_EXPIRED, "IREPS answered the document request with its login page", { status: response.status });
    }
    throw new IrepsError(CODES.INVALID_PDF, "IREPS returned an HTML page instead of the PDF", {
      status: response.status,
      detail: "IREPS returned a web page instead of the PDF"
    });
  }
  throw new IrepsError(CODES.INVALID_PDF, `Response is not a PDF (content-type ${contentType || "unknown"})`, {
    status: response.status,
    detail: "the file returned by IREPS is not a PDF"
  });
}

/**
 * @typedef {Object} DownloadItem
 * @property {string} id
 * @property {string|null} url      absolute IREPS URL of the document
 * @property {string} path          Downloads-relative target path (…/name.pdf)
 * @property {string} [label]       shown in progress / logs (e.g. "MA 007327")
 * @property {object} [meta]        anything the caller wants echoed back
 */

/**
 * Download one document: fetch, verify, save.
 * @param {DownloadItem} item
 * @param {{ fetch?: typeof fetch, saveFile?: (bytes: Uint8Array, path: string) => Promise<{ downloadId?: number, filename?: string, path?: string }>, codes?: object }} [options]
 */
export async function downloadIrepsDocument(item, options = {}) {
  const CODES = { ...DEFAULT_CODES, ...(options.codes || {}) };
  const { bytes } = await fetchIrepsDocument(item.url, { fetch: options.fetch, codes: CODES });
  const saveFile = options.saveFile || ((data, target) => downloadBytes(data, { path: target, mimeType: "application/pdf" }));
  let saved;
  try {
    saved = await saveFile(bytes, item.path);
  } catch (error) {
    logger.error("Document could not be saved", error);
    throw new IrepsError(CODES.DOWNLOAD_FAILED, "Chrome could not save the PDF", { detail: "Chrome could not save the file", cause: error });
  }
  return {
    id: item.id,
    url: item.url,
    path: item.path,
    filename: (saved && saved.filename) || item.path.split("/").pop(),
    downloadId: saved && saved.downloadId !== undefined ? saved.downloadId : null,
    bytes: bytes.length
  };
}

/** Public, user-safe error info for one failed item. */
function describeFailure(error, CODES) {
  if (error instanceof IrepsError) return { code: error.code, detail: error.detail || null, status: error.status ?? null };
  return { code: CODES.DOWNLOAD_FAILED, detail: null, status: null };
}

/**
 * Download several documents with limited concurrency.
 *
 * @param {DownloadItem[]} items
 * @param {{ concurrency?: number, fetch?: typeof fetch, saveFile?: Function, codes?: object,
 *          onProgress?: (snapshot: DocumentBatchSnapshot) => void }} [options]
 * @returns {Promise<DocumentBatchSnapshot & { startedAt: string, finishedAt: string }>}
 */
export async function downloadIrepsDocuments(items, options = {}) {
  const CODES = { ...DEFAULT_CODES, ...(options.codes || {}) };
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || DOCUMENT_DOWNLOAD_CONCURRENCY, 5));
  const list = Array.isArray(items) ? items : [];
  const startedAt = new Date().toISOString();

  const states = list.map((item) => ({
    id: item.id,
    label: item.label || item.id,
    meta: item.meta || null,
    path: item.path,
    status: DOCUMENT_DOWNLOAD_STATUS.QUEUED,
    filename: null,
    downloadId: null,
    error: null
  }));
  let sessionExpired = false;
  let cursor = 0;

  const snapshot = () => ({
    total: states.length,
    queued: states.filter((i) => i.status === DOCUMENT_DOWNLOAD_STATUS.QUEUED).length,
    downloading: states.filter((i) => i.status === DOCUMENT_DOWNLOAD_STATUS.DOWNLOADING).length,
    completed: states.filter((i) => i.status === DOCUMENT_DOWNLOAD_STATUS.COMPLETED).length,
    failed: states.filter((i) => i.status === DOCUMENT_DOWNLOAD_STATUS.FAILED).length,
    sessionExpired,
    items: states.map((i) => ({ ...i }))
  });
  const notify = () => {
    if (typeof options.onProgress === "function") {
      try {
        options.onProgress(snapshot());
      } catch (error) {
        logger.debug("Progress callback failed", error);
      }
    }
  };

  const worker = async () => {
    while (cursor < list.length) {
      const index = cursor++;
      const item = list[index];
      const state = states[index];
      if (sessionExpired) {
        state.status = DOCUMENT_DOWNLOAD_STATUS.FAILED;
        state.error = { code: CODES.SESSION_EXPIRED, detail: "not attempted: IREPS session expired", status: null, skipped: true };
        continue;
      }
      state.status = DOCUMENT_DOWNLOAD_STATUS.DOWNLOADING;
      notify();
      try {
        const done = await downloadIrepsDocument(item, { fetch: options.fetch, saveFile: options.saveFile, codes: CODES });
        state.status = DOCUMENT_DOWNLOAD_STATUS.COMPLETED;
        state.filename = done.filename;
        state.downloadId = done.downloadId;
      } catch (error) {
        state.status = DOCUMENT_DOWNLOAD_STATUS.FAILED;
        state.error = describeFailure(error, CODES);
        if (state.error.code === CODES.SESSION_EXPIRED) sessionExpired = true;
        logger.warn("Document download failed", { label: state.label, code: state.error.code, status: state.error.status });
      }
      notify();
    }
  };

  notify();
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, () => worker()));
  const summary = snapshot();
  logger.info("Document batch finished", { total: summary.total, completed: summary.completed, failed: summary.failed, sessionExpired });
  return { ...summary, startedAt, finishedAt: new Date().toISOString() };
}

/**
 * @typedef {Object} DocumentBatchSnapshot
 * @property {number} total
 * @property {number} queued
 * @property {number} downloading
 * @property {number} completed
 * @property {number} failed
 * @property {boolean} sessionExpired
 * @property {{ id: string, label: string, meta: object|null, path: string, status: string, filename: string|null, downloadId: number|null, error: { code: string, detail: string|null, status: number|null, skipped?: boolean }|null }[]} items
 */
