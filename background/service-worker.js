/**
 * DocLink service worker (Manifest V3).
 *
 * Orchestrates the Download IREPS Bill Status workflow:
 *
 *   popup click -> POST viewBills.do (empty) -> session validation ->
 *   Struts token -> POST viewBills.do (Show Results) -> parser (offscreen
 *   document) -> validation -> PDF generation -> local download ->
 *   optional Recon Engine -> popup status
 *
 * All real work is delegated to the service modules; this file only wires
 * the steps together, tracks job state and relays progress to the popup.
 *
 * The PO Search document workflows (CRN, R-NOTE) are wired separately below:
 *
 *   popup DOWNLOAD_IREPS_DOCUMENTS { criteria } -> POST searchPO.do
 *   (searchParam=showPage) -> session validation -> Struts token ->
 *   POST searchPO.do (searchCriteria=CRN | RNOTE) -> type-specific parser
 *   (offscreen document) -> every result page -> export file (Excel .xlsx by
 *   default, like the portal's "Export to Excel"; CSV also available) ->
 *   local download into Downloads/DocLink/IREPS/<TYPE>/
 *
 * The MA copies workflow (searchCriteria=MA) downloads the actual MA PDFs:
 *   popup MA_SEARCH -> same PO Search flow -> MA parser -> records filtered by
 *   MA Date -> MA list to the popup; popup MA_DOWNLOAD -> each
 *   "View/Download MA" href fetched with the browser session, verified as PDF,
 *   saved to Downloads/DocLink/IREPS/MA/<date>/MA_<PO>_<MA>.pdf (3 at a time)
 *
 * The PO / Inspection Certificate screen (one PO number, two independent
 * downloads) is wired separately below:
 *   popup PO_DOWNLOAD { poNo } -> same PO Search flow (searchCriteria=PO,
 *   searchRange=3) -> the PO's "Click to View/Download PO" href downloaded
 *   popup IC_DOWNLOAD { poNo } -> POST vendorInspectionCallList.do
 *   (a different endpoint - services/inspection-certificate/) -> every
 *   issued IC of that PO -> each "View/ Download IC PDF" href downloaded
 *
 * It never touches viewBills.do; only the session/network helpers, the
 * offscreen document and chrome.downloads are shared.
 */

import { IREPS_CONFIG, IrepsError, IREPS_ERROR, loadIrepsConfig } from "../services/ireps-api.js";
import { checkIrepsSession } from "../services/session-service.js";
import { extractBillStatusForm, publicFormInfo } from "../services/ireps-form.js";
import { fetchBillStatus } from "../services/bill-status-service.js";
import { generateBillStatusPdf } from "../services/pdf-service.js";
import { downloadPdf } from "../services/download-service.js";
import { sendBillStatusToRecon } from "../services/recon-service.js";
import { uploadDocument } from "../services/upload-service.js";
import { searchIrepsDocuments, validateSearchPoSession, SEARCH_PO_FLOW_STAGES } from "../services/search-po/search-po-service.js";
import { loadSearchPoPage, SEARCH_PO_ERROR, SEARCH_PO_CRITERIA, SEARCH_PO_DOCUMENT_TYPES } from "../services/search-po/search-po-api.js";
import { extractSearchPoForm, publicSearchPoFormInfo } from "../services/search-po/search-po-form.js";
import { EXPORT_FORMAT } from "../services/search-po/search-po-export.js";
import { buildCrnExport } from "../services/crn/crn-export.js";
import { buildRnoteExport } from "../services/rnote/rnote-export.js";
import { searchMa, downloadMaPdfs, MA_ERROR, MA_FLOW_STAGES } from "../services/ma/ma-service.js";
import { downloadBytes } from "../services/download-service.js";
import { downloadPo, PO_ERROR, PO_FLOW_STAGES } from "../services/po/po-service.js";
import { downloadInspectionCertificates, IC_ERROR, IC_FLOW_STAGES } from "../services/inspection-certificate/ic-service.js";
import { buildDocumentExportDownloadPath } from "../utils/filename.js";
import { MESSAGE_TYPES, TARGETS, STAGES, DOCUMENT_STAGES, MA_STAGES, PO_STAGES, IC_STAGES, documentStageLabel, describeError, STORAGE_KEYS, SESSION_KEYS } from "../utils/messages.js";
import { logger } from "../utils/logger.js";

const OFFSCREEN_URL = chrome.runtime.getURL("background/offscreen.html");
const PREVIEW_URL = chrome.runtime.getURL("pages/preview.html");
const SESSION_CHECK_CACHE_MS = 20000;

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

/** @type {{ status: "idle"|"running"|"complete"|"error", stage: string, message: string, detail?: string, error?: object, result?: object, updatedAt: number }} */
let jobState = { status: "idle", stage: STAGES.IDLE.id, message: "", updatedAt: Date.now() };
let jobRunning = false;

/**
 * Cache of the last live session check (public info + the loaded page) so
 * that opening the popup and clicking Download does not hit IREPS twice.
 * The HTML is discarded as soon as it has been used or the cache expires.
 */
let lastSessionCheck = null;

async function setJobState(patch) {
  jobState = { ...jobState, ...patch, updatedAt: Date.now() };
  try {
    await chrome.storage.session.set({ [SESSION_KEYS.JOB_STATE]: jobState });
  } catch (error) {
    logger.debug("Could not persist job state", error);
  }
}

function broadcast(type, payload = {}) {
  chrome.runtime.sendMessage({ target: TARGETS.POPUP, type, ...payload }).catch(() => {
    /* popup is closed; state is still available via GET_JOB_STATE */
  });
}

async function progress(stage, message, detail) {
  const text = message || stage.label;
  await setJobState({ status: "running", stage: stage.id, message: text, detail: detail || "", error: undefined });
  broadcast(MESSAGE_TYPES.IREPS_PROGRESS, { stage: stage.id, message: text, detail: detail || "" });
}

/* -------------------------------------------------------------------------- */
/* Offscreen parsing                                                          */
/* -------------------------------------------------------------------------- */

let offscreenCreating = null;

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL]
  });
  if (contexts.length > 0) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["DOM_PARSER"],
        justification: "Parse the IREPS Bill Status HTML with DOMParser (not available in service workers)."
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }
  await offscreenCreating;
}

async function closeOffscreenDocument() {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* already closed */
  }
}

/** Number of parse calls currently using the offscreen document (Bill Status + CRN). */
let offscreenUsers = 0;

/** Run fn() with the offscreen document open; close it when the last user finishes. */
async function withOffscreen(fn) {
  await ensureOffscreenDocument();
  offscreenUsers++;
  try {
    return await fn();
  } finally {
    offscreenUsers--;
    if (offscreenUsers === 0) await closeOffscreenDocument();
  }
}

/**
 * @param {string} html
 * @param {{ filter?: string, sourceUrl?: string|null }} options
 * @returns {Promise<import("../services/bill-parser.js").BillStatusResult>}
 */
async function parseInOffscreen(html, options = {}) {
  return withOffscreen(async () => {
    const response = await chrome.runtime.sendMessage({
      target: TARGETS.OFFSCREEN,
      type: MESSAGE_TYPES.PARSE_BILL_STATUS,
      html,
      filter: options.filter || "",
      sourceUrl: options.sourceUrl || null
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "Parser returned no result");
    }
    return response.result;
  });
}

/**
 * PO Search results (CRN / R-NOTE) are parsed by the type-specific parser in
 * the same offscreen document; `criteria` selects it.
 * @param {string} html
 * @param {{ criteria: string, sourceUrl?: string|null, startIndex?: number }} options
 */
async function parseSearchPoInOffscreen(html, options = {}) {
  return withOffscreen(async () => {
    const response = await chrome.runtime.sendMessage({
      target: TARGETS.OFFSCREEN,
      type: MESSAGE_TYPES.PARSE_SEARCH_PO_RESULTS,
      criteria: options.criteria,
      html,
      sourceUrl: options.sourceUrl || null,
      startIndex: options.startIndex || 1
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : `${options.criteria} parser returned no result`);
    }
    return response.result;
  });
}

/**
 * Inspection Certificate results (vendorInspectionCallList.do) are parsed by
 * their own parser in the offscreen document - a different endpoint from PO
 * Search, so this is a separate bridge from parseSearchPoInOffscreen.
 * @param {string} html
 * @param {string} poNo
 * @param {{ sourceUrl?: string|null }} [options]
 */
async function parseIcInOffscreen(html, poNo, options = {}) {
  return withOffscreen(async () => {
    const response = await chrome.runtime.sendMessage({
      target: TARGETS.OFFSCREEN,
      type: MESSAGE_TYPES.PARSE_IC_RESULTS,
      html,
      poNo,
      sourceUrl: options.sourceUrl || null
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "IC parser returned no result");
    }
    return response.result;
  });
}

/* -------------------------------------------------------------------------- */
/* Session check                                                              */
/* -------------------------------------------------------------------------- */

async function performSessionCheck({ useCache = true } = {}) {
  if (useCache && lastSessionCheck && Date.now() - lastSessionCheck.at < SESSION_CHECK_CACHE_MS) {
    return lastSessionCheck.result;
  }
  const result = await checkIrepsSession();
  lastSessionCheck = { at: Date.now(), result };
  return result;
}

/** Session info for the popup: never the HTML, never the token. */
function publicSessionInfo(result) {
  const form = result.authenticated && result.html ? publicFormInfo(extractBillStatusForm(result.html)) : null;
  return {
    authenticated: result.authenticated,
    code: result.code,
    reason: result.reason,
    detail: result.detail ?? null,
    status: result.status ?? null,
    form
  };
}

/** Take (and clear) a recently loaded Bill Status page so the download can reuse it. */
function takeCachedPage() {
  if (!lastSessionCheck) return null;
  const fresh = Date.now() - lastSessionCheck.at < SESSION_CHECK_CACHE_MS;
  const page = fresh && lastSessionCheck.result.authenticated ? lastSessionCheck.result.response : null;
  lastSessionCheck = null;
  return page;
}

/* -------------------------------------------------------------------------- */
/* Download workflow                                                          */
/* -------------------------------------------------------------------------- */

class WorkflowError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "WorkflowError";
    this.code = code;
    this.details = details;
  }
}

const STAGE_FOR_PROGRESS = {
  CHECKING_SESSION: STAGES.CHECKING_SESSION,
  CONNECTED: STAGES.CONNECTED,
  FETCHING: STAGES.FETCHING,
  PROCESSING: STAGES.PROCESSING
};

/**
 * @param {{ mode?: string, zone?: string, dateFrom?: string, dateTo?: string }} options
 */
async function runDownloadWorkflow(options) {
  const startedAt = new Date();

  // Steps 1-4: session, token, search, parse (services/bill-status-service.js).
  await progress(STAGES.CHECKING_SESSION);
  let fetched;
  try {
    fetched = await fetchBillStatus(options, {
      initialPage: takeCachedPage(),
      parseHtml: (html, parseOptions) => parseInOffscreen(html, parseOptions),
      onProgress: (stage) => {
        const s = STAGE_FOR_PROGRESS[stage];
        if (s) progress(s);
      }
    });
  } catch (error) {
    if (error instanceof IrepsError) {
      throw new WorkflowError(error.code, { status: error.status, detail: error.detail });
    }
    throw error;
  }
  const result = fetched.parsed;
  await progress(STAGES.PROCESSING, `Processing ${result.recordCount} bills...`);

  // Keep the parsed result (memory-only) so the preview page can render it.
  // The printable HTML is rebuilt by the preview from the records, so it is
  // not stored (it can be several MB for a full Bill Status page).
  try {
    await chrome.storage.session.set({ [SESSION_KEYS.LAST_RESULT]: { ...result, printableHtml: "" } });
  } catch (error) {
    logger.warn("Could not store parsed result for preview", error);
  }

  // Step 5: PDF.
  await progress(STAGES.GENERATING_PDF);
  let pdf;
  try {
    pdf = await generateBillStatusPdf(result);
  } catch (error) {
    logger.error("PDF generation failed", error);
    throw new WorkflowError("PDF_ERROR");
  }

  // Step 6: local download.
  await progress(STAGES.DOWNLOADING);
  let download;
  try {
    download = await downloadPdf(pdf.bytes, { date: startedAt });
  } catch (error) {
    logger.error("Download failed", error);
    throw new WorkflowError("DOWNLOAD_ERROR");
  }

  // Step 7 (optional): Recon Engine. Never affects the download outcome.
  let recon = { sent: false, skipped: true };
  try {
    recon = await sendBillStatusToRecon(fetched);
  } catch (error) {
    logger.warn("Recon Engine send failed", error);
  }

  const summary = {
    downloadId: download.downloadId,
    filename: download.filename,
    recordCount: result.recordCount,
    skippedCount: result.skippedCount || 0,
    warningCount: (result.warnings || []).length,
    pageCount: pdf.pageCount,
    request: fetched.request,
    filter: fetched.filter,
    fetchedAt: fetched.fetchedAt,
    reconSent: recon.sent === true,
    downloadedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({
    [STORAGE_KEYS.LAST_DOWNLOAD]: {
      lastDownloadAt: summary.downloadedAt,
      lastDownloadFilename: summary.filename,
      lastRecordCount: summary.recordCount,
      lastFilter: summary.filter,
      lastStatus: "Downloaded successfully"
    }
  });
  return summary;
}

/** Update only the status line shown at the bottom of the popup. */
async function recordLastStatus(status) {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.LAST_DOWNLOAD);
    const previous = stored[STORAGE_KEYS.LAST_DOWNLOAD] || {};
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_DOWNLOAD]: { ...previous, lastStatus: status } });
  } catch (error) {
    logger.debug("Could not record status", error);
  }
}

/** Only accept the documented option keys from the popup. */
function sanitiseOptions(raw) {
  const options = raw && typeof raw === "object" ? raw : {};
  const out = {};
  if (typeof options.mode === "string") out.mode = options.mode;
  if (typeof options.zone === "string") out.zone = options.zone;
  if (typeof options.dateFrom === "string") out.dateFrom = options.dateFrom;
  if (typeof options.dateTo === "string") out.dateTo = options.dateTo;
  return out;
}

async function startDownloadJob(rawOptions) {
  if (jobRunning) return { started: false, error: describeError("BUSY") };
  jobRunning = true;
  const options = sanitiseOptions(rawOptions);
  logger.info("Download workflow started", { mode: options.mode || "last90Days", zone: options.zone || "-1" });

  (async () => {
    try {
      const summary = await runDownloadWorkflow(options);
      await setJobState({ status: "complete", stage: STAGES.COMPLETE.id, message: STAGES.COMPLETE.label, result: summary, error: undefined });
      broadcast(MESSAGE_TYPES.IREPS_DOWNLOAD_COMPLETE, summary);
      logger.info("Download workflow complete", summary);
    } catch (error) {
      const code = error instanceof WorkflowError ? error.code : "UNKNOWN";
      const described = describeError(code, error instanceof WorkflowError ? error.details : {});
      if (code === "UNKNOWN") logger.error("Download workflow failed", error);
      else logger.warn("Download workflow stopped", { code });
      if (code === IREPS_ERROR.SESSION_EXPIRED) lastSessionCheck = null;
      await recordLastStatus(described.title);
      await setJobState({ status: "error", stage: STAGES.ERROR.id, message: described.title, error: described, result: undefined });
      broadcast(MESSAGE_TYPES.IREPS_DOWNLOAD_ERROR, described);
    } finally {
      jobRunning = false;
    }
  })();

  return { started: true };
}


/* -------------------------------------------------------------------------- */
/* PO Search document workflows: CRN, R-NOTE (separate from Bill Status)      */
/* -------------------------------------------------------------------------- */

const EXPORT_BUILDERS = {
  [SEARCH_PO_CRITERIA.CRN]: buildCrnExport,
  [SEARCH_PO_CRITERIA.RNOTE]: buildRnoteExport
};
const LAST_DOWNLOAD_KEYS = {
  [SEARCH_PO_CRITERIA.CRN]: STORAGE_KEYS.LAST_CRN_DOWNLOAD,
  [SEARCH_PO_CRITERIA.RNOTE]: STORAGE_KEYS.LAST_RNOTE_DOWNLOAD
};

/**
 * One job state per document type, so a CRN result stays visible while an
 * R-NOTE download runs. Only one PO Search job runs at a time (the portal's
 * single-use token makes parallel searches pointless).
 * @type {Record<string, { status: "idle"|"running"|"complete"|"error", stage: string, message: string, detail?: string, result?: object, error?: object, updatedAt: number }>}
 */
const documentJobs = {};
let documentJobRunning = null; // criteria of the running job, or null
/** Cache of the last PO Search form load (railway list) - never the HTML or the token. */
let lastSearchPoFormCheck = null;

function documentJob(criteria) {
  if (!documentJobs[criteria]) documentJobs[criteria] = { status: "idle", stage: DOCUMENT_STAGES.IDLE.id, message: "", updatedAt: Date.now() };
  return documentJobs[criteria];
}

function typeLabel(criteria) {
  const type = SEARCH_PO_DOCUMENT_TYPES.find((t) => t.criteria === criteria);
  return type ? type.shortLabel : criteria;
}

async function setDocumentJob(criteria, patch) {
  documentJobs[criteria] = { ...documentJob(criteria), ...patch, criteria, updatedAt: Date.now() };
  try {
    await chrome.storage.session.set({ [SESSION_KEYS.DOCUMENT_JOBS]: documentJobs });
  } catch (error) {
    logger.debug("Could not persist document job state", error);
  }
}

async function documentProgress(criteria, stage, message, detail) {
  const text = message || documentStageLabel(stage, typeLabel(criteria));
  await setDocumentJob(criteria, { status: "running", stage: stage.id, message: text, detail: detail || "", error: undefined });
  broadcast(MESSAGE_TYPES.DOCUMENT_PROGRESS, { criteria, stage: stage.id, message: text, detail: detail || "" });
}

const DOCUMENT_STAGE_FOR_PROGRESS = {
  [SEARCH_PO_FLOW_STAGES.CHECKING_SESSION]: DOCUMENT_STAGES.CHECKING_SESSION,
  [SEARCH_PO_FLOW_STAGES.CONNECTED]: DOCUMENT_STAGES.CONNECTED,
  [SEARCH_PO_FLOW_STAGES.SEARCHING]: DOCUMENT_STAGES.SEARCHING,
  [SEARCH_PO_FLOW_STAGES.PAGING]: DOCUMENT_STAGES.PAGING,
  [SEARCH_PO_FLOW_STAGES.PARSING]: DOCUMENT_STAGES.PARSING
};

/** Only accept the documented option keys from the popup. */
function sanitiseDocumentOptions(raw) {
  const options = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const key of ["mode", "railway", "poNo", "dateFrom", "dateTo"]) {
    if (typeof options[key] === "string") out[key] = options[key].trim();
  }
  if (options.pageNo !== undefined && Number.isFinite(Number(options.pageNo))) out.pageNo = Number(options.pageNo);
  if (options.recordsPerPage !== undefined && Number.isFinite(Number(options.recordsPerPage))) out.recordsPerPage = Number(options.recordsPerPage);
  out.format = Object.values(EXPORT_FORMAT).includes(options.format) ? options.format : EXPORT_FORMAT.XLSX;
  return out;
}

/**
 * Load the PO Search page once to (a) confirm the session and (b) hand the
 * popup the railway list. Cached for a few seconds like the Bill Status check.
 */
async function loadSearchPoFormInfo({ useCache = true } = {}) {
  if (useCache && lastSearchPoFormCheck && Date.now() - lastSearchPoFormCheck.at < SESSION_CHECK_CACHE_MS) return lastSearchPoFormCheck.result;
  let result;
  try {
    const page = await loadSearchPoPage();
    const verdict = validateSearchPoSession(page.html, page);
    result = {
      authenticated: verdict.authenticated,
      code: verdict.code,
      reason: verdict.reason,
      status: page.status,
      form: verdict.authenticated ? publicSearchPoFormInfo(extractSearchPoForm(page.html)) : null
    };
  } catch (error) {
    const code = error instanceof IrepsError ? error.code : "UNKNOWN";
    result = { authenticated: false, code, reason: error.message, detail: error instanceof IrepsError ? error.detail : null, status: error.status ?? null, form: null };
  }
  lastSearchPoFormCheck = { at: Date.now(), result };
  return result;
}

/**
 * Search one document type and download the result table as a file
 * (DocLink's version of the portal's "Export to Excel" - every row, not only
 * the visible page).
 * @param {string} criteria   "CRN" | "RNOTE"
 * @param {{ format: string, mode?: string, railway?: string, poNo?: string, dateFrom?: string, dateTo?: string, recordsPerPage?: number }} options
 */
async function runDocumentDownloadWorkflow(criteria, options) {
  const startedAt = new Date();
  const { format, ...searchOptions } = options;
  const label = typeLabel(criteria);

  // Steps 1-5: page, session, token, search, parse, further result pages (shared layer).
  await documentProgress(criteria, DOCUMENT_STAGES.CHECKING_SESSION);
  let result;
  try {
    result = await searchIrepsDocuments({ ...searchOptions, criteria }, {
      parseHtml: (html, parseOptions) => parseSearchPoInOffscreen(html, parseOptions),
      onProgress: (stage, detail) => {
        const s = DOCUMENT_STAGE_FOR_PROGRESS[stage];
        if (!s) return;
        if (stage === SEARCH_PO_FLOW_STAGES.PAGING && detail) {
          const [n, m] = String(detail).split("/");
          documentProgress(criteria, s, `Loading ${label} result page ${n} of ${m}...`, detail);
        } else documentProgress(criteria, s);
      }
    });
  } catch (error) {
    if (error instanceof IrepsError) throw new WorkflowError(error.code, { status: error.status, detail: error.detail });
    throw error;
  }
  lastSearchPoFormCheck = { at: Date.now(), result: { authenticated: true, code: "OK", reason: null, status: 200, form: result.form } };

  // Step 6: export file (xlsx / csv) via the type-specific column set. No PDF is assumed.
  await documentProgress(criteria, DOCUMENT_STAGES.GENERATING_FILE, `Building the ${format === EXPORT_FORMAT.CSV ? "CSV" : "Excel"} file (${result.recordCount} ${label} records)...`);
  let file;
  try {
    const build = EXPORT_BUILDERS[criteria];
    if (!build) throw new Error(`No export builder for ${criteria}`);
    file = build(result, { format, now: startedAt });
  } catch (error) {
    logger.error(`${criteria} export generation failed`, error);
    throw new WorkflowError("DOCUMENT_EXPORT_ERROR");
  }

  // Step 7: local download.
  await documentProgress(criteria, DOCUMENT_STAGES.DOWNLOADING);
  let download;
  try {
    download = await downloadBytes(file.bytes, { path: buildDocumentExportDownloadPath(criteria, startedAt, file.extension), mimeType: file.mimeType });
  } catch (error) {
    logger.error(`${criteria} download failed`, error);
    throw new WorkflowError("DOCUMENT_DOWNLOAD_ERROR");
  }

  const summary = {
    criteria,
    typeLabel: label,
    downloadId: download.downloadId,
    filename: download.filename,
    format: file.format,
    recordCount: result.recordCount,
    columnCount: file.columnCount,
    warningCount: (result.warnings || []).length,
    pagesFetched: result.pagination.pagesFetched,
    search: result.search,
    filter: result.filter,
    fetchedAt: result.fetchedAt,
    form: result.form,
    downloadedAt: new Date().toISOString()
  };
  const key = LAST_DOWNLOAD_KEYS[criteria];
  if (key) {
    await chrome.storage.local.set({
      [key]: {
        lastDownloadAt: summary.downloadedAt,
        lastDownloadFilename: summary.filename,
        lastRecordCount: summary.recordCount,
        lastFilter: summary.filter,
        lastStatus: "Downloaded successfully"
      }
    });
  }
  return summary;
}

async function startDocumentDownloadJob(rawCriteria, rawOptions) {
  const criteria = SEARCH_PO_DOCUMENT_TYPES.some((t) => t.criteria === rawCriteria) ? rawCriteria : null;
  if (!criteria) return { started: false, error: describeError(SEARCH_PO_ERROR.UNSUPPORTED_CRITERIA, { detail: String(rawCriteria) }) };
  if (documentJobRunning) return { started: false, error: describeError("DOCUMENT_BUSY") };
  documentJobRunning = criteria;
  const options = sanitiseDocumentOptions(rawOptions);
  logger.info(`${criteria} download started`, { mode: options.mode || "(inferred)", railway: options.railway || "-1", format: options.format });

  (async () => {
    try {
      const summary = await runDocumentDownloadWorkflow(criteria, options);
      const doneLabel = documentStageLabel(DOCUMENT_STAGES.COMPLETE, typeLabel(criteria));
      await setDocumentJob(criteria, { status: "complete", stage: DOCUMENT_STAGES.COMPLETE.id, message: doneLabel, result: summary, error: undefined });
      broadcast(MESSAGE_TYPES.DOCUMENT_DOWNLOAD_COMPLETE, summary);
      logger.info(`${criteria} download complete`, { records: summary.recordCount, pages: summary.pagesFetched, filename: summary.filename });
    } catch (error) {
      const code = error instanceof WorkflowError ? error.code : "UNKNOWN";
      const described = { ...describeError(code, error instanceof WorkflowError ? error.details : {}), criteria };
      if (code === "UNKNOWN") logger.error(`${criteria} workflow failed`, error);
      else logger.warn(`${criteria} workflow stopped`, { code });
      if (code === SEARCH_PO_ERROR.SESSION_EXPIRED) {
        lastSessionCheck = null;
        lastSearchPoFormCheck = null;
      }
      await setDocumentJob(criteria, { status: "error", stage: DOCUMENT_STAGES.ERROR.id, message: described.title, error: described, result: undefined });
      broadcast(MESSAGE_TYPES.DOCUMENT_DOWNLOAD_ERROR, described);
    } finally {
      documentJobRunning = null;
    }
  })();

  return { started: true };
}


/* -------------------------------------------------------------------------- */
/* MA copies workflow (search + per-MA PDF downloads)                         */
/* -------------------------------------------------------------------------- */

/**
 * @type {{ status: "idle"|"searching"|"ready"|"downloading"|"complete"|"error", stage: string, message: string,
 *          detail?: string, search?: object|null, filter?: string|null, dateFilter?: object|null, fetchedAt?: string|null,
 *          recordCount: number, allRecordCount: number, records: object[], form?: object|null, warnings?: string[],
 *          pagination?: object|null, downloads?: object|null, error?: object|null, updatedAt: number }}
 */
let maState = emptyMaState();
let maRunning = false;
let maRestored = false;

function emptyMaState() {
  return {
    status: "idle",
    stage: MA_STAGES.IDLE.id,
    message: "",
    detail: "",
    search: null,
    filter: null,
    dateFilter: null,
    fetchedAt: null,
    recordCount: 0,
    allRecordCount: 0,
    records: [],
    form: null,
    warnings: [],
    pagination: null,
    downloads: null,
    error: null,
    updatedAt: Date.now()
  };
}

async function setMaState(patch) {
  maState = { ...maState, ...patch, updatedAt: Date.now() };
  try {
    await chrome.storage.session.set({ [SESSION_KEYS.MA_STATE]: maState });
  } catch (error) {
    logger.debug("Could not persist MA state with records; storing without them", error);
    try {
      await chrome.storage.session.set({ [SESSION_KEYS.MA_STATE]: { ...maState, records: [], recordsDropped: true } });
    } catch (inner) {
      logger.debug("Could not persist MA state", inner);
    }
  }
}

/** Reload the MA state after a service-worker restart (memory-only storage). */
async function restoreMaState() {
  if (maRestored) return;
  maRestored = true;
  if (maState.status !== "idle") return;
  try {
    const stored = await chrome.storage.session.get(SESSION_KEYS.MA_STATE);
    const saved = stored[SESSION_KEYS.MA_STATE];
    if (saved && saved.status && saved.status !== "idle") {
      if (saved.status === "searching") {
        const described = describeError("UNKNOWN");
        maState = { ...emptyMaState(), status: "error", stage: MA_STAGES.ERROR.id, error: described, message: described.title };
      } else if (saved.status === "downloading") {
        maState = { ...saved, status: "ready", stage: MA_STAGES.READY.id, message: `${saved.recordCount} MA(s) found`, records: saved.records || [] };
      } else {
        maState = { ...saved, records: saved.records || [] };
      }
    }
  } catch (error) {
    logger.debug("Could not restore MA state", error);
  }
}

function maProgress(stage, message, detail) {
  const text = message || stage.label;
  setMaState({ status: maState.status === "downloading" ? "downloading" : "searching", stage: stage.id, message: text, detail: detail || "", error: null });
  broadcast(MESSAGE_TYPES.MA_PROGRESS, { stage: stage.id, message: text, detail: detail || "", status: maState.status });
}

const MA_STAGE_FOR_PROGRESS = {
  [MA_FLOW_STAGES.CHECKING_SESSION]: MA_STAGES.CHECKING_SESSION,
  [MA_FLOW_STAGES.CONNECTED]: MA_STAGES.CONNECTED,
  [MA_FLOW_STAGES.SEARCHING]: MA_STAGES.SEARCHING,
  [MA_FLOW_STAGES.PAGING]: MA_STAGES.PAGING,
  [MA_FLOW_STAGES.PARSING]: MA_STAGES.PARSING
};

/** Only accept the documented MA option keys from the popup. */
function sanitiseMaOptions(raw) {
  const options = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const key of ["railway", "poNo", "dateMode", "date", "dateFrom", "dateTo"]) {
    if (typeof options[key] === "string") out[key] = options[key].trim();
  }
  if (options.recordsPerPage !== undefined && Number.isFinite(Number(options.recordsPerPage))) out.recordsPerPage = Number(options.recordsPerPage);
  return out;
}

/** Short, redaction-safe description of an unexpected error for the popup (no IREPS data is ever in these messages). */
function errorDetail(error) {
  const text = error && error.message ? String(error.message) : String(error || "unexpected error");
  return text.replace(/\s+/g, " ").trim().slice(0, 160) || "unexpected error";
}

function maErrorFrom(error) {
  if (error instanceof IrepsError) return describeError(error.code, { status: error.status, detail: error.detail });
  logger.error("MA workflow failed", error);
  return describeError("UNKNOWN", { detail: errorDetail(error) });
}

async function startMaSearch(rawOptions) {
  await restoreMaState();
  if (maRunning) return { started: false, error: describeError("MA_BUSY") };
  maRunning = true;
  const options = sanitiseMaOptions(rawOptions);
  logger.info("MA search started", { railway: options.railway || "-1", dateMode: options.dateMode || "date", date: options.date || "(today)", poNo: options.poNo ? "yes" : "no" });

  (async () => {
    try {
      maState = { ...emptyMaState(), status: "searching" };
      maProgress(MA_STAGES.CHECKING_SESSION);
      const result = await searchMa(options, {
        parseHtml: (html, parseOptions) => parseSearchPoInOffscreen(html, parseOptions),
        onProgress: (stage, detail) => {
          const s = MA_STAGE_FOR_PROGRESS[stage];
          if (!s) return;
          if (stage === MA_FLOW_STAGES.PAGING && detail) {
            const [n, m] = String(detail).split("/");
            maProgress(s, `Loading MA result page ${n} of ${m}...`, detail);
          } else maProgress(s);
        }
      });
      await setMaState({
        status: "ready",
        stage: MA_STAGES.READY.id,
        message: `${result.recordCount} MA${result.recordCount === 1 ? "" : "s"} found`,
        detail: "",
        search: result.search,
        filter: result.filter,
        dateFilter: result.dateFilter,
        fetchedAt: result.fetchedAt,
        recordCount: result.recordCount,
        allRecordCount: result.allRecordCount,
        records: result.records,
        form: result.form,
        warnings: result.warnings.slice(0, 50),
        pagination: result.pagination,
        downloads: null,
        error: null
      });
      lastSearchPoFormCheck = { at: Date.now(), result: { authenticated: true, code: "OK", reason: null, status: 200, form: result.form } };
      broadcast(MESSAGE_TYPES.MA_SEARCH_COMPLETE, publicMaState());
      logger.info("MA search complete", { matched: result.recordCount, total: result.allRecordCount, pages: result.pagination.pagesFetched, filter: result.filter });
    } catch (error) {
      const described = maErrorFrom(error);
      if (described.code === MA_ERROR.SESSION_EXPIRED) {
        lastSessionCheck = null;
        lastSearchPoFormCheck = null;
      }
      logger.warn("MA search stopped", { code: described.code });
      await setMaState({ status: "error", stage: MA_STAGES.ERROR.id, message: described.title, error: described, records: [], recordCount: 0, downloads: null });
      broadcast(MESSAGE_TYPES.MA_ERROR, { ...described, phase: "search" });
    } finally {
      maRunning = false;
    }
  })();

  return { started: true };
}

/**
 * @param {string[]|"all"} selection   record ids to download, or "all"
 */
async function startMaDownload(selection) {
  await restoreMaState();
  if (maRunning) return { started: false, error: describeError("MA_BUSY") };
  if (!Array.isArray(maState.records) || maState.records.length === 0) return { started: false, error: describeError(MA_ERROR.NOT_FOUND, { detail: "no MA list loaded" }) };
  const wanted = selection === "all" ? null : new Set(Array.isArray(selection) ? selection.map(String) : []);
  const records = wanted ? maState.records.filter((r) => wanted.has(String(r.id))) : maState.records;
  if (records.length === 0) return { started: false, error: describeError("MA_NO_SELECTION") };

  maRunning = true;
  logger.info("MA download started", { count: records.length });
  (async () => {
    try {
      await setMaState({ status: "downloading", stage: MA_STAGES.DOWNLOADING.id, message: `Downloading ${records.length} MA cop${records.length === 1 ? "y" : "ies"}...`, error: null });
      broadcast(MESSAGE_TYPES.MA_PROGRESS, { stage: MA_STAGES.DOWNLOADING.id, message: maState.message, status: "downloading" });
      const summary = await downloadMaPdfs(records, {
        onProgress: (snapshot) => {
          maState = { ...maState, downloads: snapshot, updatedAt: Date.now() };
          broadcast(MESSAGE_TYPES.MA_DOWNLOAD_PROGRESS, { downloads: snapshot });
        }
      });
      const described = summary.sessionExpired ? describeError("MA_SESSION_EXPIRED_DURING_DOWNLOAD") : null;
      if (summary.sessionExpired) {
        lastSessionCheck = null;
        lastSearchPoFormCheck = null;
      }
      await setMaState({
        status: "complete",
        stage: MA_STAGES.COMPLETE.id,
        message: `${summary.completed} of ${summary.total} MA cop${summary.total === 1 ? "y" : "ies"} downloaded`,
        downloads: summary,
        error: described
      });
      await chrome.storage.local.set({
        [STORAGE_KEYS.LAST_MA_DOWNLOAD]: {
          lastDownloadAt: summary.finishedAt,
          lastCompleted: summary.completed,
          lastFailed: summary.failed,
          lastTotal: summary.total,
          lastFilter: maState.filter,
          lastStatus: summary.failed ? `${summary.completed} downloaded, ${summary.failed} failed` : "Downloaded successfully"
        }
      });
      broadcast(MESSAGE_TYPES.MA_DOWNLOAD_COMPLETE, { downloads: summary, error: described, message: maState.message });
      logger.info("MA download finished", { completed: summary.completed, failed: summary.failed, sessionExpired: summary.sessionExpired });
    } catch (error) {
      const described = maErrorFrom(error);
      await setMaState({ status: "ready", stage: MA_STAGES.READY.id, message: described.title, error: described });
      broadcast(MESSAGE_TYPES.MA_ERROR, { ...described, phase: "download" });
    } finally {
      maRunning = false;
    }
  })();
  return { started: true };
}

/** State handed to the popup (records included; never HTML or tokens). */
function publicMaState() {
  return { ...maState, running: maRunning };
}

async function resetMaState() {
  await restoreMaState();
  if (maRunning) return { ok: false, error: describeError("MA_BUSY") };
  maState = emptyMaState();
  try {
    await chrome.storage.session.remove(SESSION_KEYS.MA_STATE);
  } catch {
    /* ignore */
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* PO / Inspection Certificate download (one PO number, two independent jobs) */
/* -------------------------------------------------------------------------- */

/** @type {{ status: "idle"|"running"|"complete"|"error", stage: string, message: string, poNumber?: string|null, result?: object, error?: object|null, updatedAt: number }} */
let poState = { status: "idle", stage: PO_STAGES.IDLE.id, message: "", poNumber: null, updatedAt: Date.now() };
let poRunning = false;

/**
 * @type {{ status: "idle"|"searching"|"downloading"|"complete"|"error", stage: string, message: string,
 *          poNumber?: string|null, count: number, downloads?: object|null, error?: object|null, updatedAt: number }}
 */
let icState = { status: "idle", stage: IC_STAGES.IDLE.id, message: "", poNumber: null, count: 0, downloads: null, error: null, updatedAt: Date.now() };
let icRunning = false;

async function setPoState(patch) {
  poState = { ...poState, ...patch, updatedAt: Date.now() };
  try {
    await chrome.storage.session.set({ [SESSION_KEYS.PO_STATE]: poState });
  } catch (error) {
    logger.debug("Could not persist PO state", error);
  }
}

async function setIcState(patch) {
  icState = { ...icState, ...patch, updatedAt: Date.now() };
  try {
    await chrome.storage.session.set({ [SESSION_KEYS.IC_STATE]: icState });
  } catch (error) {
    logger.debug("Could not persist IC state", error);
  }
}

const PO_STAGE_FOR_PROGRESS = {
  [PO_FLOW_STAGES.CHECKING_SESSION]: PO_STAGES.CHECKING_SESSION,
  [PO_FLOW_STAGES.CONNECTED]: PO_STAGES.CONNECTED,
  [PO_FLOW_STAGES.SEARCHING]: PO_STAGES.SEARCHING,
  [PO_FLOW_STAGES.PARSING]: PO_STAGES.PARSING
};
const IC_STAGE_FOR_PROGRESS = {
  [IC_FLOW_STAGES.CHECKING_SESSION]: IC_STAGES.CHECKING_SESSION,
  [IC_FLOW_STAGES.CONNECTED]: IC_STAGES.CONNECTED,
  [IC_FLOW_STAGES.SEARCHING]: IC_STAGES.SEARCHING,
  [IC_FLOW_STAGES.PARSING]: IC_STAGES.PARSING
};

/** Only accept a trimmed PO number string from the popup. */
function sanitisePoNumber(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

async function startPoDownload(rawPoNo) {
  if (poRunning) return { started: false, error: describeError("PO_BUSY") };
  const poNo = sanitisePoNumber(rawPoNo);
  if (!poNo) return { started: false, error: describeError("IREPS_INVALID_REQUEST", { detail: "Please enter a PO Number." }) };
  poRunning = true;
  logger.info("PO download started", { poNo });

  (async () => {
    try {
      await setPoState({ status: "running", stage: PO_STAGES.CHECKING_SESSION.id, message: PO_STAGES.CHECKING_SESSION.label, poNumber: poNo, error: null, result: undefined });
      broadcast(MESSAGE_TYPES.PO_PROGRESS, { poNumber: poNo, stage: PO_STAGES.CHECKING_SESSION.id, message: PO_STAGES.CHECKING_SESSION.label });
      const result = await downloadPo(poNo, {
        parseHtml: (html, options) => parseSearchPoInOffscreen(html, { ...options, criteria: SEARCH_PO_CRITERIA.PO }),
        onProgress: (stage) => {
          const s = PO_STAGE_FOR_PROGRESS[stage];
          if (!s) return;
          setPoState({ stage: s.id, message: s.label });
          broadcast(MESSAGE_TYPES.PO_PROGRESS, { poNumber: poNo, stage: s.id, message: s.label });
        }
      });
      await setPoState({ status: "complete", stage: PO_STAGES.COMPLETE.id, message: PO_STAGES.COMPLETE.label, result, error: null });
      await chrome.storage.local.set({
        [STORAGE_KEYS.LAST_PO_DOWNLOAD]: { lastDownloadAt: new Date().toISOString(), lastDownloadFilename: result.filename, lastPoNumber: poNo, lastStatus: "Downloaded successfully" }
      });
      broadcast(MESSAGE_TYPES.PO_DOWNLOAD_COMPLETE, { poNumber: poNo, ...result });
      logger.info("PO download complete", { poNo, filename: result.filename });
    } catch (error) {
      const described = error instanceof IrepsError ? describeError(error.code, { status: error.status, detail: error.detail }) : describeError("UNKNOWN", { detail: errorDetail(error) });
      if (!(error instanceof IrepsError)) logger.error("PO download failed", error);
      else logger.warn("PO download stopped", { code: error.code });
      if (described.code === PO_ERROR.SESSION_EXPIRED) lastSessionCheck = null;
      await setPoState({ status: "error", stage: PO_STAGES.ERROR.id, message: described.title, error: described, result: undefined });
      broadcast(MESSAGE_TYPES.PO_DOWNLOAD_ERROR, { poNumber: poNo, ...described });
    } finally {
      poRunning = false;
    }
  })();

  return { started: true };
}

async function startIcDownload(rawPoNo) {
  if (icRunning) return { started: false, error: describeError("IC_BUSY") };
  const poNo = sanitisePoNumber(rawPoNo);
  if (!poNo) return { started: false, error: describeError("IREPS_INVALID_REQUEST", { detail: "Please enter a PO Number." }) };
  icRunning = true;
  logger.info("IC download started", { poNo });

  (async () => {
    try {
      await setIcState({ status: "searching", stage: IC_STAGES.CHECKING_SESSION.id, message: IC_STAGES.CHECKING_SESSION.label, poNumber: poNo, count: 0, downloads: null, error: null });
      broadcast(MESSAGE_TYPES.IC_PROGRESS, { poNumber: poNo, stage: IC_STAGES.CHECKING_SESSION.id, message: IC_STAGES.CHECKING_SESSION.label, status: "searching" });
      let announcedCount = false;
      const result = await downloadInspectionCertificates(poNo, {
        parseHtml: (html, options) => parseIcInOffscreen(html, poNo, options),
        onProgress: (stage) => {
          const s = IC_STAGE_FOR_PROGRESS[stage];
          if (!s) return;
          setIcState({ stage: s.id, message: s.label });
          broadcast(MESSAGE_TYPES.IC_PROGRESS, { poNumber: poNo, stage: s.id, message: s.label, status: "searching" });
        },
        onDownloadProgress: (snapshot) => {
          if (!announcedCount) {
            announcedCount = true;
            const label = `${snapshot.total} issued Inspection Certificate${snapshot.total === 1 ? "" : "s"} found`;
            setIcState({ status: "downloading", stage: IC_STAGES.DOWNLOADING.id, message: snapshot.total ? `Downloading ${label}...` : "No issued Inspection Certificates were found for this PO.", count: snapshot.total, downloads: snapshot });
            broadcast(MESSAGE_TYPES.IC_PROGRESS, { poNumber: poNo, stage: IC_STAGES.DOWNLOADING.id, message: label, status: "downloading" });
          } else {
            icState = { ...icState, downloads: snapshot, updatedAt: Date.now() };
          }
          broadcast(MESSAGE_TYPES.IC_DOWNLOAD_PROGRESS, { poNumber: poNo, downloads: snapshot });
        }
      });
      const described = result.downloads.sessionExpired ? describeError("IC_SESSION_EXPIRED_DURING_DOWNLOAD") : null;
      if (result.downloads.sessionExpired) lastSessionCheck = null;
      const message =
        result.count === 0
          ? "No issued Inspection Certificates were found for this PO."
          : `${result.downloads.completed} of ${result.downloads.total} Inspection Certificate${result.downloads.total === 1 ? "" : "s"} downloaded`;
      await setIcState({ status: "complete", stage: IC_STAGES.COMPLETE.id, message, count: result.count, downloads: result.downloads, error: described });
      await chrome.storage.local.set({
        [STORAGE_KEYS.LAST_IC_DOWNLOAD]: {
          lastDownloadAt: result.downloads.finishedAt,
          lastPoNumber: poNo,
          lastCount: result.count,
          lastCompleted: result.downloads.completed,
          lastFailed: result.downloads.failed,
          lastStatus: result.downloads.failed ? `${result.downloads.completed} downloaded, ${result.downloads.failed} failed` : message
        }
      });
      broadcast(MESSAGE_TYPES.IC_DOWNLOAD_COMPLETE, { poNumber: poNo, count: result.count, downloads: result.downloads, error: described, message });
      logger.info("IC download finished", { poNo, count: result.count, completed: result.downloads.completed, failed: result.downloads.failed });
    } catch (error) {
      const described = error instanceof IrepsError ? describeError(error.code, { status: error.status, detail: error.detail }) : describeError("UNKNOWN", { detail: errorDetail(error) });
      if (!(error instanceof IrepsError)) logger.error("IC download failed", error);
      else logger.warn("IC download stopped", { code: error.code });
      if (described.code === IC_ERROR.SESSION_EXPIRED) lastSessionCheck = null;
      await setIcState({ status: "error", stage: IC_STAGES.ERROR.id, message: described.title, error: described });
      broadcast(MESSAGE_TYPES.IC_DOWNLOAD_ERROR, { poNumber: poNo, ...described });
    } finally {
      icRunning = false;
    }
  })();

  return { started: true };
}

/* -------------------------------------------------------------------------- */
/* Message router                                                             */
/* -------------------------------------------------------------------------- */

const handlers = {
  [MESSAGE_TYPES.CHECK_IREPS_SESSION]: async (message) => {
    const result = await performSessionCheck({ useCache: !message.force });
    return publicSessionInfo(result);
  },
  [MESSAGE_TYPES.DOWNLOAD_IREPS_BILL_STATUS]: (message) => startDownloadJob(message.options),
  [MESSAGE_TYPES.GET_JOB_STATE]: () => jobState,
  [MESSAGE_TYPES.OPEN_IREPS]: async () => {
    await chrome.tabs.create({ url: `${IREPS_CONFIG.baseUrl}${IREPS_CONFIG.homePath}` });
    return { ok: true };
  },
  [MESSAGE_TYPES.OPEN_PREVIEW]: async () => {
    await chrome.tabs.create({ url: PREVIEW_URL });
    return { ok: true };
  },
  [MESSAGE_TYPES.UPLOAD_DOCUMENT]: (message) => uploadDocument(message.request || {}),

  // PO Search document workflows (CRN, R-NOTE)
  [MESSAGE_TYPES.SEARCH_PO_LOAD_FORM]: (message) => loadSearchPoFormInfo({ useCache: !message.force }),
  [MESSAGE_TYPES.DOWNLOAD_IREPS_DOCUMENTS]: (message) => startDocumentDownloadJob(message.criteria, message.options),
  [MESSAGE_TYPES.GET_DOCUMENT_JOB_STATE]: (message) => ({ ...documentJob(message.criteria), criteria: message.criteria, running: documentJobRunning }),

  // MA copies
  [MESSAGE_TYPES.MA_SEARCH]: (message) => startMaSearch(message.options),
  [MESSAGE_TYPES.MA_DOWNLOAD]: (message) => startMaDownload(message.ids),
  [MESSAGE_TYPES.GET_MA_STATE]: async () => {
    await restoreMaState();
    return publicMaState();
  },
  [MESSAGE_TYPES.MA_RESET]: () => resetMaState(),

  // PO / Inspection Certificate (one PO number, two independent downloads)
  [MESSAGE_TYPES.PO_DOWNLOAD]: (message) => startPoDownload(message.poNo),
  [MESSAGE_TYPES.GET_PO_STATE]: () => ({ ...poState, running: poRunning }),
  [MESSAGE_TYPES.IC_DOWNLOAD]: (message) => startIcDownload(message.poNo),
  [MESSAGE_TYPES.GET_IC_STATE]: () => ({ ...icState, running: icRunning })
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  if (message.target && message.target !== TARGETS.SERVICE_WORKER) return false;
  const handler = handlers[message.type];
  if (!handler) return false;

  // config.json (mock vs. real IREPS) is read once per service-worker
  // lifetime, before the first request it can affect; the listener itself
  // stays registered synchronously above so no wake-up event is missed.
  loadIrepsConfig()
    .then(() => handler(message))
    .then((response) => sendResponse(response ?? { ok: true }))
    .catch((error) => {
      logger.error(`Handler ${message.type} failed`, error);
      sendResponse({ ok: false, error: describeError("UNKNOWN", { detail: errorDetail(error) }) });
    });
  return true; // keep the channel open for the async response
});

/**
 * The UI lives in Chrome's side panel (docked to the right edge, full height,
 * the page content shrinks to make room) rather than a floating popup.
 * Clicking the toolbar icon opens/closes it. Called at top level so it also
 * applies after every service-worker restart.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
  logger.warn("Could not configure side panel behaviour", error);
});

chrome.runtime.onInstalled.addListener((details) => {
  logger.info(`DocLink installed (${details.reason})`);
});

chrome.runtime.onStartup.addListener(() => {
  logger.debug("Service worker started");
});
