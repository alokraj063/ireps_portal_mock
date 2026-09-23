/**
 * Message types, workflow stages and user-facing error texts shared by the
 * popup, the service worker, the offscreen document and the preview page.
 */

export const MESSAGE_TYPES = Object.freeze({
  // popup -> service worker (request / response)
  CHECK_IREPS_SESSION: "CHECK_IREPS_SESSION",
  DOWNLOAD_IREPS_BILL_STATUS: "DOWNLOAD_IREPS_BILL_STATUS",
  GET_JOB_STATE: "GET_JOB_STATE",
  OPEN_IREPS: "OPEN_IREPS",
  OPEN_PREVIEW: "OPEN_PREVIEW",
  UPLOAD_DOCUMENT: "UPLOAD_DOCUMENT",

  // popup -> service worker: PO Search document workflows (CRN, R-NOTE), separate from Bill Status
  SEARCH_PO_LOAD_FORM: "SEARCH_PO_LOAD_FORM",
  DOWNLOAD_IREPS_DOCUMENTS: "DOWNLOAD_IREPS_DOCUMENTS",
  GET_DOCUMENT_JOB_STATE: "GET_DOCUMENT_JOB_STATE",

  // popup -> service worker: MA copies (search, then per-MA PDF downloads)
  MA_SEARCH: "MA_SEARCH",
  MA_DOWNLOAD: "MA_DOWNLOAD",
  GET_MA_STATE: "GET_MA_STATE",
  MA_RESET: "MA_RESET",

  // popup -> service worker: PO / Inspection Certificate download (one PO number, two independent downloads)
  PO_DOWNLOAD: "PO_DOWNLOAD",
  GET_PO_STATE: "GET_PO_STATE",
  IC_DOWNLOAD: "IC_DOWNLOAD",
  GET_IC_STATE: "GET_IC_STATE",

  // service worker -> popup (broadcast)
  IREPS_PROGRESS: "IREPS_PROGRESS",
  IREPS_DOWNLOAD_COMPLETE: "IREPS_DOWNLOAD_COMPLETE",
  IREPS_DOWNLOAD_ERROR: "IREPS_DOWNLOAD_ERROR",
  DOCUMENT_PROGRESS: "DOCUMENT_PROGRESS",
  DOCUMENT_DOWNLOAD_COMPLETE: "DOCUMENT_DOWNLOAD_COMPLETE",
  DOCUMENT_DOWNLOAD_ERROR: "DOCUMENT_DOWNLOAD_ERROR",
  MA_PROGRESS: "MA_PROGRESS",
  MA_SEARCH_COMPLETE: "MA_SEARCH_COMPLETE",
  MA_DOWNLOAD_PROGRESS: "MA_DOWNLOAD_PROGRESS",
  MA_DOWNLOAD_COMPLETE: "MA_DOWNLOAD_COMPLETE",
  MA_ERROR: "MA_ERROR",
  PO_PROGRESS: "PO_PROGRESS",
  PO_DOWNLOAD_COMPLETE: "PO_DOWNLOAD_COMPLETE",
  PO_DOWNLOAD_ERROR: "PO_DOWNLOAD_ERROR",
  IC_PROGRESS: "IC_PROGRESS",
  IC_DOWNLOAD_PROGRESS: "IC_DOWNLOAD_PROGRESS",
  IC_DOWNLOAD_COMPLETE: "IC_DOWNLOAD_COMPLETE",
  IC_DOWNLOAD_ERROR: "IC_DOWNLOAD_ERROR",

  // service worker -> offscreen document
  PARSE_BILL_STATUS: "PARSE_BILL_STATUS",
  PARSE_SEARCH_PO_RESULTS: "PARSE_SEARCH_PO_RESULTS",
  PARSE_IC_RESULTS: "PARSE_IC_RESULTS"
});

/** Routing targets so broadcast messages are only handled where intended. */
export const TARGETS = Object.freeze({
  SERVICE_WORKER: "service-worker",
  OFFSCREEN: "offscreen",
  POPUP: "popup"
});

/** Workflow stages in order. `label` is what the popup displays. */
export const STAGES = Object.freeze({
  IDLE: { id: "IDLE", label: "" },
  CHECKING_SESSION: { id: "CHECKING_SESSION", label: "Checking IREPS session..." },
  CONNECTED: { id: "CONNECTED", label: "Connecting to IREPS..." },
  FETCHING: { id: "FETCHING", label: "Retrieving Bill Status..." },
  PROCESSING: { id: "PROCESSING", label: "Processing bills..." },
  GENERATING_PDF: { id: "GENERATING_PDF", label: "Generating PDF..." },
  DOWNLOADING: { id: "DOWNLOADING", label: "Downloading..." },
  COMPLETE: { id: "COMPLETE", label: "Bill Status downloaded successfully" },
  ERROR: { id: "ERROR", label: "Error" }
});

/**
 * PO Search document workflow stages (CRN, R-NOTE), independent of the Bill
 * Status stages above. `{type}` is replaced with the document label.
 */
export const DOCUMENT_STAGES = Object.freeze({
  IDLE: { id: "IDLE", label: "" },
  CHECKING_SESSION: { id: "CHECKING_SESSION", label: "Checking IREPS session..." },
  CONNECTED: { id: "CONNECTED", label: "Loading IREPS PO Search..." },
  SEARCHING: { id: "SEARCHING", label: "Searching {type}s..." },
  PAGING: { id: "PAGING", label: "Loading {type} result pages..." },
  PARSING: { id: "PARSING", label: "Reading {type} records..." },
  GENERATING_FILE: { id: "GENERATING_FILE", label: "Building the export file..." },
  DOWNLOADING: { id: "DOWNLOADING", label: "Downloading..." },
  COMPLETE: { id: "COMPLETE", label: "{type} export downloaded successfully" },
  ERROR: { id: "ERROR", label: "Error" }
});

/** MA copies workflow stages. */
export const MA_STAGES = Object.freeze({
  IDLE: { id: "IDLE", label: "" },
  CHECKING_SESSION: { id: "CHECKING_SESSION", label: "Checking IREPS session..." },
  CONNECTED: { id: "CONNECTED", label: "Loading IREPS PO Search..." },
  SEARCHING: { id: "SEARCHING", label: "Searching Modification Advices..." },
  PAGING: { id: "PAGING", label: "Loading MA result pages..." },
  PARSING: { id: "PARSING", label: "Reading MA records..." },
  READY: { id: "READY", label: "MA results ready" },
  DOWNLOADING: { id: "DOWNLOADING", label: "Downloading MA copies..." },
  COMPLETE: { id: "COMPLETE", label: "MA download finished" },
  ERROR: { id: "ERROR", label: "Error" }
});

/** Single Purchase Order (PO) download workflow stages. */
export const PO_STAGES = Object.freeze({
  IDLE: { id: "IDLE", label: "" },
  CHECKING_SESSION: { id: "CHECKING_SESSION", label: "Checking IREPS session..." },
  CONNECTED: { id: "CONNECTED", label: "Loading IREPS PO Search..." },
  SEARCHING: { id: "SEARCHING", label: "Searching PO..." },
  PARSING: { id: "PARSING", label: "Reading PO details..." },
  DOWNLOADING: { id: "DOWNLOADING", label: "Downloading PO..." },
  COMPLETE: { id: "COMPLETE", label: "PO downloaded successfully" },
  ERROR: { id: "ERROR", label: "Error" }
});

/** Inspection Certificate (IC) download workflow stages (search, then per-IC PDF downloads). */
export const IC_STAGES = Object.freeze({
  IDLE: { id: "IDLE", label: "" },
  CHECKING_SESSION: { id: "CHECKING_SESSION", label: "Checking IREPS session..." },
  CONNECTED: { id: "CONNECTED", label: "Loading IREPS Inspection Call List..." },
  SEARCHING: { id: "SEARCHING", label: "Searching issued ICs..." },
  PARSING: { id: "PARSING", label: "Reading IC records..." },
  DOWNLOADING: { id: "DOWNLOADING", label: "Downloading Inspection Certificates..." },
  COMPLETE: { id: "COMPLETE", label: "IC download finished" },
  ERROR: { id: "ERROR", label: "Error" }
});

/** Stage label with the document type filled in ("CRN", "R-NOTE"). */
export function documentStageLabel(stage, typeLabel) {
  return String(stage.label || "").replace(/\{type\}/g, typeLabel || "document");
}

/**
 * Business-friendly error catalogue keyed by error code.
 *
 * `message` may contain "{detail}" which is substituted with a short,
 * user-safe detail supplied by the workflow (for example
 * "IREPS returned HTTP 500"). `connection` drives the header indicator.
 */
export const ERROR_CATALOG = Object.freeze({
  IREPS_SESSION_EXPIRED: {
    title: "IREPS login required",
    message: "Your IREPS session is not active.\n\nPlease log in to IREPS in this Chrome browser, then return to DocLink and try again.",
    loginRequired: true,
    connection: "login"
  },
  IREPS_REQUEST_FAILED: {
    title: "Unable to retrieve Bill Status",
    message: "DocLink could not complete the request to IREPS ({detail}). Check your network connection and try again.",
    connection: "offline"
  },
  IREPS_TOKEN_NOT_FOUND: {
    title: "IREPS form token not found",
    message: "The IREPS Bill Status page did not contain the expected form token. Reload IREPS, then try again.",
    connection: "offline"
  },
  IREPS_INVALID_RESPONSE: {
    title: "Unable to recognise the IREPS response",
    message: "IREPS did not return the Bill Status page. The page structure may have changed, or IREPS reported an error.",
    connection: "offline"
  },
  IREPS_PARSE_FAILED: {
    title: "Unable to read the Bill Status records",
    message: "IREPS returned the Bill Status page, but DocLink could not extract the bill records from it.",
    connection: "connected"
  },
  IREPS_NO_RECORDS: {
    title: "No Bill Records Found",
    message: "IREPS returned successfully, but no bill records were available for the selected search.",
    notice: true,
    connection: "connected"
  },
  IREPS_INVALID_REQUEST: {
    title: "Invalid search options",
    message: "{detail}",
    notice: true
  },
  PDF_ERROR: {
    title: "Bill Status Retrieved",
    message: "However, DocLink could not generate the PDF.",
    previewAvailable: true,
    connection: "connected"
  },
  DOWNLOAD_ERROR: {
    title: "PDF Generated",
    message: "However, Chrome could not save the file. Check your download settings and retry.",
    previewAvailable: true,
    connection: "connected"
  },
  BUSY: {
    title: "Download Already Running",
    message: "Please wait for the current download to finish."
  },

  /* ------------------------------------------------ PO Search documents */
  IREPS_SEARCH_PAGE_FAILED: {
    title: "Unable to open IREPS PO Search",
    message: "DocLink could not load the IREPS PO Search page ({detail}). Check your network connection and try again.",
    connection: "offline"
  },
  UNSUPPORTED_IREPS_SEARCH_TYPE: {
    title: "Unsupported IREPS search type",
    message: "DocLink does not know this PO Search document type ({detail})."
  },
  IREPS_CRN_SEARCH_FAILED: {
    title: "Unable to search CRNs",
    message: "DocLink could not complete the CRN search request to IREPS ({detail}). Check your network connection and try again.",
    connection: "offline"
  },
  IREPS_CRN_RESULTS_INVALID: {
    title: "Unable to recognise the CRN results",
    message: "IREPS did not return the CRN search results page ({detail}). The page structure may have changed, or IREPS reported an error.",
    connection: "connected"
  },
  IREPS_CRN_NOT_FOUND: {
    title: "No CRNs Found",
    message: "IREPS returned successfully, but no Consignment Receipt Notes matched the selected search.",
    notice: true,
    connection: "connected"
  },
  IREPS_CRN_PARSE_FAILED: {
    title: "Unable to read the CRN records",
    message: "IREPS returned the CRN results page, but DocLink could not extract the CRN records from it.",
    connection: "connected"
  },
  IREPS_RNOTE_SEARCH_FAILED: {
    title: "Unable to search R-NOTEs",
    message: "DocLink could not complete the R-NOTE search request to IREPS ({detail}). Check your network connection and try again.",
    connection: "offline"
  },
  IREPS_RNOTE_RESULTS_INVALID: {
    title: "Unable to recognise the R-NOTE results",
    message: "IREPS did not return the R-NOTE search results page ({detail}). The page structure may have changed, or IREPS reported an error.",
    connection: "connected"
  },
  IREPS_RNOTE_NOT_FOUND: {
    title: "No R-NOTEs Found",
    message: "IREPS returned successfully, but no Receipt Notes matched the selected search.",
    notice: true,
    connection: "connected"
  },
  IREPS_RNOTE_PARSE_FAILED: {
    title: "Unable to read the R-NOTE records",
    message: "IREPS returned the R-NOTE results page, but DocLink could not extract the Receipt Note records from it.",
    connection: "connected"
  },
  IREPS_MA_SEARCH_FAILED: {
    title: "Unable to search Modification Advices",
    message: "DocLink could not complete the MA search request to IREPS ({detail}). Check your network connection and try again.",
    connection: "offline"
  },
  IREPS_MA_RESULTS_INVALID: {
    title: "Unable to recognise the MA results",
    message: "IREPS did not return the Modification Advice results page ({detail}). The page structure may have changed, or IREPS reported an error.",
    connection: "connected"
  },
  IREPS_MA_NOT_FOUND: {
    title: "No MA copies found",
    message: "No Modification Advice matched the selection: {detail}.",
    notice: true,
    connection: "connected"
  },
  IREPS_MA_PARSE_FAILED: {
    title: "Unable to read the MA records",
    message: "IREPS returned the Modification Advice results page, but DocLink could not extract the MA records from it.",
    connection: "connected"
  },
  IREPS_MA_LINK_NOT_FOUND: {
    title: "MA copy link not found",
    message: "IREPS did not provide a \"View/Download MA\" link for this Modification Advice ({detail}).",
    connection: "connected"
  },
  IREPS_MA_DOWNLOAD_FAILED: {
    title: "MA copy download failed",
    message: "DocLink could not download the MA PDF from IREPS ({detail}).",
    connection: "connected"
  },
  IREPS_MA_INVALID_PDF: {
    title: "MA copy not valid",
    message: "IREPS did not return a PDF for this Modification Advice ({detail}). Nothing was saved.",
    connection: "connected"
  },
  MA_SESSION_EXPIRED_DURING_DOWNLOAD: {
    title: "IREPS session expired",
    message: "Your IREPS session has expired.\n\nPlease log in again and retry the MA download.",
    connection: "login"
  },
  MA_BUSY: {
    title: "MA Task Already Running",
    message: "Please wait for the current MA search or download to finish."
  },
  MA_NO_SELECTION: {
    title: "No MA selected",
    message: "Select at least one Modification Advice, or use Download All.",
    notice: true
  },
  DOCUMENT_EXPORT_ERROR: {
    title: "Records retrieved",
    message: "However, DocLink could not build the export file.",
    connection: "connected"
  },
  DOCUMENT_DOWNLOAD_ERROR: {
    title: "Export generated",
    message: "However, Chrome could not save the file. Check your download settings and retry.",
    connection: "connected"
  },
  DOCUMENT_BUSY: {
    title: "Download Already Running",
    message: "Please wait for the current CRN / R-NOTE download to finish."
  },

  /* ------------------------------------------------------- PO download */
  IREPS_PO_SEARCH_FAILED: {
    title: "Unable to search for the PO",
    message: "DocLink could not complete the PO search request to IREPS ({detail}). Check your network connection and try again.",
    connection: "offline"
  },
  IREPS_PO_RESULTS_INVALID: {
    title: "Unable to recognise the PO results",
    message: "IREPS did not return the PO search results page ({detail}). The page structure may have changed, or IREPS reported an error.",
    connection: "connected"
  },
  IREPS_PO_NOT_FOUND: {
    title: "Purchase Order not found",
    message: "Purchase Order {detail} was not found (or is not visible to your IREPS account).",
    notice: true,
    connection: "connected"
  },
  IREPS_PO_PARSE_FAILED: {
    title: "Unable to read the PO details",
    message: "IREPS returned the PO search results page, but DocLink could not extract the PO details from it.",
    connection: "connected"
  },
  IREPS_PO_LINK_NOT_FOUND: {
    title: "PO document link not found",
    message: "IREPS did not provide a \"View/Download PO\" link for this Purchase Order ({detail}).",
    connection: "connected"
  },
  IREPS_PO_DOWNLOAD_FAILED: {
    title: "PO download failed",
    message: "DocLink could not download the PO PDF from IREPS ({detail}).",
    connection: "connected"
  },
  IREPS_PO_INVALID_PDF: {
    title: "PO document not valid",
    message: "IREPS did not return a PDF for this Purchase Order ({detail}). Nothing was saved.",
    connection: "connected"
  },
  PO_BUSY: {
    title: "PO Download Already Running",
    message: "Please wait for the current PO download to finish."
  },

  /* --------------------------------------- Inspection Certificate (IC) */
  IREPS_IC_SEARCH_FAILED: {
    title: "Unable to search Inspection Certificates",
    message: "DocLink could not complete the Inspection Certificate search request to IREPS ({detail}). Check your network connection and try again.",
    connection: "offline"
  },
  IREPS_IC_RESULTS_INVALID: {
    title: "Unable to recognise the IC results",
    message: "IREPS did not return the Inspection Call List results page ({detail}). The page structure may have changed, or IREPS reported an error.",
    connection: "connected"
  },
  IREPS_IC_TOKEN_NOT_FOUND: {
    title: "IREPS form token not found",
    message: "The IREPS Inspection Call List page did not contain the expected form token. Reload IREPS, then try again.",
    connection: "offline"
  },
  IREPS_IC_PARSE_FAILED: {
    title: "Unable to read the IC records",
    message: "IREPS returned the Inspection Call List results page, but DocLink could not extract the IC records from it.",
    connection: "connected"
  },
  IREPS_IC_LINK_NOT_FOUND: {
    title: "IC copy link not found",
    message: "IREPS did not provide a \"View/ Download IC PDF\" link for this Inspection Certificate ({detail}).",
    connection: "connected"
  },
  IREPS_IC_DOWNLOAD_FAILED: {
    title: "IC copy download failed",
    message: "DocLink could not download the Inspection Certificate PDF from IREPS ({detail}).",
    connection: "connected"
  },
  IREPS_IC_INVALID_PDF: {
    title: "IC copy not valid",
    message: "IREPS did not return a PDF for this Inspection Certificate ({detail}). Nothing was saved.",
    connection: "connected"
  },
  IC_SESSION_EXPIRED_DURING_DOWNLOAD: {
    title: "IREPS session expired",
    message: "Your IREPS session has expired.\n\nPlease log in again and retry the IC download.",
    connection: "login"
  },
  IC_BUSY: {
    title: "IC Download Already Running",
    message: "Please wait for the current Inspection Certificate download to finish."
  },
  NO_BACKGROUND_RESPONSE: {
    title: "DocLink Needs a Reload",
    message: "DocLink's background service did not answer ({detail}). Open chrome://extensions, click the reload icon on the DocLink card, then retry."
  },
  UNKNOWN: {
    title: "Something Went Wrong",
    message: "DocLink could not complete the download ({detail}). Please retry."
  }
});

/**
 * Build the user-facing error payload for a code.
 * @param {string} code
 * @param {{ status?: number|null, detail?: string|null }} [details]
 */
export function describeError(code, details = {}) {
  const entry = ERROR_CATALOG[code] || ERROR_CATALOG.UNKNOWN;
  const detail = details.detail || (details.status ? `IREPS returned HTTP ${details.status}` : "") || "request failed";
  return {
    code: ERROR_CATALOG[code] ? code : "UNKNOWN",
    title: entry.title,
    message: entry.message.replace("{detail}", detail),
    loginRequired: entry.loginRequired === true,
    previewAvailable: entry.previewAvailable === true,
    notice: entry.notice === true,
    connection: entry.connection || null
  };
}

/** chrome.storage.local keys (non-sensitive metadata only). */
export const STORAGE_KEYS = Object.freeze({
  LAST_DOWNLOAD: "doclink.lastDownload",
  LAST_CRN_DOWNLOAD: "doclink.lastCrnDownload",
  LAST_RNOTE_DOWNLOAD: "doclink.lastRnoteDownload",
  LAST_MA_DOWNLOAD: "doclink.lastMaDownload",
  LAST_PO_DOWNLOAD: "doclink.lastPoDownload",
  LAST_IC_DOWNLOAD: "doclink.lastIcDownload"
});

/** chrome.storage.session keys (memory only, cleared when Chrome closes). */
export const SESSION_KEYS = Object.freeze({
  JOB_STATE: "doclink.jobState",
  LAST_RESULT: "doclink.lastBillStatusResult",
  DOCUMENT_JOBS: "doclink.documentJobs",
  MA_STATE: "doclink.maState",
  PO_STATE: "doclink.poState",
  IC_STATE: "doclink.icState"
});
