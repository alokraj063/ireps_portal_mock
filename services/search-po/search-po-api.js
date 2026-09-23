/**
 * IREPS "PO Search" (searchPO.do) request layer, shared by every document
 * type that lives behind that page: CRN, R-NOTE, ... (searchCriteria).
 *
 * This is a different IREPS workflow from Bill Status and must never share
 * its endpoint:
 *
 *   Bill Status  ->  POST /epsn/admin/viewBills.do   (services/ireps-api.js)
 *   PO Search    ->  POST /epsn/searchPO.do          (this module)
 *
 * Real flow (from the captured HAR, CRN and MA searches):
 *
 *   1. POST /epsn/searchPO.do                      application/x-www-form-urlencoded
 *        searchParam=showPage
 *        -> HTML "PO Search" page with <form name="searchPOForm"> and a fresh
 *           org.apache.struts.taglib.html.TOKEN
 *   2. POST /epsn/searchPO.do                      application/x-www-form-urlencoded
 *        org.apache.struts.taglib.html.TOKEN=<token from step 1>
 *        &pageNo=1&searchCriteria=<CRN|RNOTE|...>&rly=-1&poNo=&icNo=&dateFrom=&dateTo=
 *        &searchRange=1&recordsPerPage=20&submit=Show+Results&searchCriteria=
 *        -> HTML page with the result table for that document type
 *
 * The captured search body carries TWO fields named searchCriteria (the
 * <select> with the criteria and a trailing empty hidden input). The body is
 * built with URLSearchParams.append() so this is reproduced exactly.
 *
 * Only application-level headers are set; Chrome adds Cookie, Origin,
 * User-Agent, Sec-Fetch-* and friends itself (credentials: "include").
 * The base URL is IREPS_CONFIG.baseUrl from services/ireps-api.js, so the
 * mock/real switch (test/mock/switch-target.mjs) applies here as well.
 */

import { IREPS_CONFIG, IREPS_ERROR, IrepsError, requestIreps, validateDateRange } from "../ireps-api.js";
import { SEARCH_PO_FORM_FIELDS, ALL_RAILWAYS_VALUE } from "./search-po-form.js";

/** Shared configuration. Keep every PO Search URL / constant here. */
export const SEARCH_PO_CONFIG = Object.freeze({
  endpoint: "/epsn/searchPO.do",
  showPageField: "searchParam",
  showPageValue: "showPage",
  submitValue: "Show Results",
  /** The captured, working request used recordsPerPage=20. */
  defaultRecordsPerPage: 20,
  /** The portal accepted recordsPerPage=2000 in a capture (MA search). */
  maxRecordsPerPage: 2000,
  /** Safety limit when following server-side result pages. */
  maxPages: 500,
  /**
   * Sanity limit for the PO No. field. The IREPS input has maxlength="16", but
   * real PO numbers in the results are longer (e.g. RR-PR-WC-2034-25-26-04),
   * so DocLink does not enforce the input's maxlength - only a generous cap.
   */
  maxPoNoLength: 64
});

/**
 * Document types DocLink supports on the PO Search page. `criteria` is the
 * exact <option value> of <select name="searchCriteria">; the labels are the
 * option texts of the captured page.
 */
export const SEARCH_PO_CRITERIA = Object.freeze({
  PO: "PO",
  CRN: "CRN",
  RNOTE: "RNOTE",
  MA: "MA"
});

export const SEARCH_PO_DOCUMENT_TYPES = Object.freeze([
  {
    criteria: SEARCH_PO_CRITERIA.PO,
    optionLabel: "PO",
    shortLabel: "PO",
    longLabel: "Purchase Order (PO)",
    filePrefix: "IREPS_PO",
    subfolder: "DocLink/IREPS/PO",
    sheetName: "PO",
    /** captured request: PO No. search (searchRange=3), recordsPerPage=20 */
    defaultRecordsPerPage: 20
  },
  {
    criteria: SEARCH_PO_CRITERIA.CRN,
    optionLabel: "Consignment Receipt Note (CRN)",
    shortLabel: "CRN",
    longLabel: "Consignment Receipt Note (CRN)",
    filePrefix: "IREPS_CRN",
    subfolder: "DocLink/IREPS/CRN",
    sheetName: "CRN",
    /** captured request */
    defaultRecordsPerPage: 20
  },
  {
    criteria: SEARCH_PO_CRITERIA.RNOTE,
    optionLabel: "Receipt Note (R-NOTE)",
    shortLabel: "R-NOTE",
    longLabel: "Receipt Note (R-NOTE)",
    filePrefix: "IREPS_RNOTE",
    subfolder: "DocLink/IREPS/RNOTE",
    sheetName: "R-NOTE",
    defaultRecordsPerPage: 20
  },
  {
    criteria: SEARCH_PO_CRITERIA.MA,
    optionLabel: "Modification Advice (MA)",
    shortLabel: "MA",
    longLabel: "Modification Advice (MA)",
    filePrefix: "IREPS_MA",
    subfolder: "DocLink/IREPS/MA",
    sheetName: "MA",
    /**
     * The captured MA search paginates server-side at 20 per page; the same
     * capture shows recordsPerPage=2000 accepted with all 1,838 rows in one
     * response, so that is the MA default (page links are still followed).
     */
    defaultRecordsPerPage: 2000
  }
]);

/** @returns {typeof SEARCH_PO_DOCUMENT_TYPES[number]} throws IrepsError for an unsupported criteria. */
export function documentTypeFor(criteria) {
  const type = SEARCH_PO_DOCUMENT_TYPES.find((t) => t.criteria === criteria);
  if (!type) throw new IrepsError(SEARCH_PO_ERROR.UNSUPPORTED_CRITERIA, `Unsupported IREPS search type "${criteria}"`, { detail: `unsupported search type "${criteria}"` });
  return type;
}

/**
 * searchRange radio values on the PO Search form. Labels confirmed from the
 * captured page HTML: 3 = "PO No.", 2 = "Select Date", 1 = "Last 180 Days"
 * (checked by default).
 */
export const SEARCH_PO_RANGE = Object.freeze({
  PO_NUMBER: "3",
  DATE_RANGE: "2",
  LAST_180_DAYS: "1"
});

/** DocLink request modes (public API of searchIrepsDocuments). */
export const SEARCH_PO_MODE = Object.freeze({
  LAST_180_DAYS: "last180Days",
  DATE_RANGE: "dateRange",
  PO_NUMBER: "poNumber"
});

const MODE_TO_RANGE = Object.freeze({
  [SEARCH_PO_MODE.LAST_180_DAYS]: SEARCH_PO_RANGE.LAST_180_DAYS,
  [SEARCH_PO_MODE.DATE_RANGE]: SEARCH_PO_RANGE.DATE_RANGE,
  [SEARCH_PO_MODE.PO_NUMBER]: SEARCH_PO_RANGE.PO_NUMBER
});

export const ALL_RAILWAYS = ALL_RAILWAYS_VALUE;

/** Error codes shared by every PO Search document type. */
export const SEARCH_PO_ERROR = Object.freeze({
  SESSION_EXPIRED: IREPS_ERROR.SESSION_EXPIRED, // "IREPS_SESSION_EXPIRED"
  SEARCH_PAGE_FAILED: "IREPS_SEARCH_PAGE_FAILED",
  TOKEN_NOT_FOUND: IREPS_ERROR.TOKEN_NOT_FOUND, // "IREPS_TOKEN_NOT_FOUND"
  INVALID_REQUEST: IREPS_ERROR.INVALID_REQUEST, // "IREPS_INVALID_REQUEST"
  UNSUPPORTED_CRITERIA: "UNSUPPORTED_IREPS_SEARCH_TYPE"
});

/**
 * Document-type specific error codes, e.g. for "CRN":
 * IREPS_CRN_SEARCH_FAILED, IREPS_CRN_RESULTS_INVALID, IREPS_CRN_NOT_FOUND,
 * IREPS_CRN_PARSE_FAILED (and the same with RNOTE).
 * @param {string} criteria
 */
export function errorCodesFor(criteria) {
  const c = String(criteria || "").toUpperCase();
  return Object.freeze({
    ...SEARCH_PO_ERROR,
    SEARCH_FAILED: `IREPS_${c}_SEARCH_FAILED`,
    RESULTS_INVALID: `IREPS_${c}_RESULTS_INVALID`,
    NOT_FOUND: `IREPS_${c}_NOT_FOUND`,
    PARSE_FAILED: `IREPS_${c}_PARSE_FAILED`
  });
}

/* -------------------------------------------------------------------------- */
/* URL helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a link found in the IREPS HTML against the configured IREPS base
 * URL (never by string concatenation). Relative links such as
 * "/ireps/etender/ct/MMIS/CONS/..." become absolute IREPS URLs. IREPS
 * sometimes prints absolute http:// links for its own host; those are
 * aligned with the configured scheme so the browser session applies.
 *
 * @param {string} href
 * @param {string} [baseUrl]   defaults to IREPS_CONFIG.baseUrl
 * @returns {string|null}      absolute URL, or null when the href is unusable
 */
export function resolveIrepsUrl(href, baseUrl = IREPS_CONFIG.baseUrl) {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed === "#" || /^(javascript|data|vbscript|about):/i.test(trimmed)) return null;
  let url;
  let base;
  try {
    base = new URL(baseUrl);
    url = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === base.hostname && url.protocol !== base.protocol) {
    url.protocol = base.protocol;
    url.port = base.port;
  }
  return url.href;
}

/**
 * Is this absolute URL on the configured IREPS origin?
 * @param {string} url
 */
export function isIrepsOriginUrl(url, baseUrl = IREPS_CONFIG.baseUrl) {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Re-label a transport failure (IREPS_REQUEST_FAILED) with a step code. */
function rewrapTransportError(error, code, message) {
  if (error instanceof IrepsError && error.code === IREPS_ERROR.REQUEST_FAILED) {
    return new IrepsError(code, message, { status: error.status, reason: error.reason, detail: error.detail, cause: error });
  }
  return error;
}

/* -------------------------------------------------------------------------- */
/* Step 1 - load the PO Search page (form + fresh token)                      */
/* -------------------------------------------------------------------------- */

/**
 * POST /epsn/searchPO.do with searchParam=showPage, exactly like the portal
 * does when the user opens "PO Search". The response carries the search
 * form and the dynamic Struts token.
 *
 * @param {{ fetch?: typeof fetch }} [deps]
 * @returns {Promise<import("../ireps-api.js").IrepsResponse>}
 */
export async function loadSearchPoPage(deps = {}) {
  const body = new URLSearchParams();
  body.set(SEARCH_PO_CONFIG.showPageField, SEARCH_PO_CONFIG.showPageValue);
  try {
    return await requestIreps({ path: SEARCH_PO_CONFIG.endpoint, method: "POST", body: body.toString() }, deps);
  } catch (error) {
    throw rewrapTransportError(error, SEARCH_PO_ERROR.SEARCH_PAGE_FAILED, "Unable to load the IREPS PO Search page");
  }
}

/* -------------------------------------------------------------------------- */
/* Step 2 - build and submit the "Show Results" request                       */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} SearchPoOptions
 * @property {"last180Days"|"dateRange"|"poNumber"} [mode]  inferred from the other fields when omitted
 * @property {string} [railway]        rly value from the form ("-1" = All, default)
 * @property {string} [poNo]           PO number (poNumber mode)
 * @property {string} [dateFrom]       DD/MM/YYYY (dateRange mode)
 * @property {string} [dateTo]         DD/MM/YYYY (dateRange mode)
 * @property {number|string} [pageNo]  default 1
 * @property {number|string} [recordsPerPage]  default 20 (captured request)
 */

/**
 * @typedef {Object} SearchPoRequest
 * @property {string} criteria        "CRN" | "RNOTE" | ...
 * @property {string} mode
 * @property {string} railway
 * @property {string} poNo
 * @property {string} dateFrom
 * @property {string} dateTo
 * @property {string} searchRange
 * @property {number} pageNo
 * @property {number} recordsPerPage
 * @property {string} body            url-encoded form body (contains the token)
 */

function toPositiveInt(value, fallback, name, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || (max && n > max)) {
    throw new IrepsError(SEARCH_PO_ERROR.INVALID_REQUEST, `Invalid ${name} "${value}"`, {
      detail: max ? `${name} must be a whole number between 1 and ${max}.` : `${name} must be a whole number of 1 or more.`
    });
  }
  return n;
}

/** Decide the searchRange mode from the supplied fields when none is given. */
export function inferSearchPoMode(options = {}) {
  if (options.mode) return options.mode;
  if (options.poNo && String(options.poNo).trim()) return SEARCH_PO_MODE.PO_NUMBER;
  if ((options.dateFrom && String(options.dateFrom).trim()) || (options.dateTo && String(options.dateTo).trim())) return SEARCH_PO_MODE.DATE_RANGE;
  return SEARCH_PO_MODE.LAST_180_DAYS;
}

/**
 * Build the form body for the "Show Results" request of one document type in
 * the exact field order the browser posts it (captured HAR), including the
 * second, empty searchCriteria field. Throws IrepsError(IREPS_INVALID_REQUEST)
 * for an unknown mode, a missing PO number, an invalid date range or an
 * invalid page size, and UNSUPPORTED_IREPS_SEARCH_TYPE for an unknown criteria.
 *
 * @param {string} criteria   "CRN" | "RNOTE"
 * @param {SearchPoOptions} options
 * @param {string} token      dynamic Struts token from loadSearchPoPage()
 * @returns {SearchPoRequest}
 */
export function buildSearchPoRequest(criteria, options = {}, token) {
  documentTypeFor(criteria);
  const mode = inferSearchPoMode(options);
  const searchRange = MODE_TO_RANGE[mode];
  if (!searchRange) {
    throw new IrepsError(SEARCH_PO_ERROR.INVALID_REQUEST, `Unknown search mode "${mode}"`, { detail: "unknown search mode" });
  }
  if (typeof token !== "string" || token.trim() === "") {
    throw new IrepsError(SEARCH_PO_ERROR.TOKEN_NOT_FOUND, "A Struts token is required to build the request");
  }

  const railway = options.railway === undefined || options.railway === null || options.railway === "" ? ALL_RAILWAYS : String(options.railway);
  let poNo = "";
  let dateFrom = "";
  let dateTo = "";
  if (mode === SEARCH_PO_MODE.PO_NUMBER) {
    poNo = String(options.poNo || "").trim();
    if (!poNo) throw new IrepsError(SEARCH_PO_ERROR.INVALID_REQUEST, "PO number missing", { detail: "Please enter PO No!" });
    if (poNo.length > SEARCH_PO_CONFIG.maxPoNoLength) {
      throw new IrepsError(SEARCH_PO_ERROR.INVALID_REQUEST, "PO number too long", { detail: `PO No. must not exceed ${SEARCH_PO_CONFIG.maxPoNoLength} characters.` });
    }
  } else if (mode === SEARCH_PO_MODE.DATE_RANGE) {
    const verdict = validateDateRange(options.dateFrom, options.dateTo);
    if (!verdict.ok) throw new IrepsError(SEARCH_PO_ERROR.INVALID_REQUEST, verdict.error, { detail: verdict.error });
    dateFrom = String(options.dateFrom).trim();
    dateTo = String(options.dateTo).trim();
  }
  const pageNo = toPositiveInt(options.pageNo, 1, "pageNo");
  const recordsPerPage = toPositiveInt(options.recordsPerPage, SEARCH_PO_CONFIG.defaultRecordsPerPage, "recordsPerPage", SEARCH_PO_CONFIG.maxRecordsPerPage);

  // append(), never set(): the captured body has searchCriteria twice.
  const body = new URLSearchParams();
  body.append(SEARCH_PO_FORM_FIELDS.TOKEN, token);
  body.append(SEARCH_PO_FORM_FIELDS.PAGE_NO, String(pageNo));
  body.append(SEARCH_PO_FORM_FIELDS.SEARCH_CRITERIA, criteria);
  body.append(SEARCH_PO_FORM_FIELDS.RAILWAY, railway);
  body.append(SEARCH_PO_FORM_FIELDS.PO_NO, poNo);
  body.append(SEARCH_PO_FORM_FIELDS.IC_NO, "");
  body.append(SEARCH_PO_FORM_FIELDS.DATE_FROM, dateFrom);
  body.append(SEARCH_PO_FORM_FIELDS.DATE_TO, dateTo);
  body.append(SEARCH_PO_FORM_FIELDS.SEARCH_RANGE, searchRange);
  body.append(SEARCH_PO_FORM_FIELDS.RECORDS_PER_PAGE, String(recordsPerPage));
  body.append(SEARCH_PO_FORM_FIELDS.SUBMIT, SEARCH_PO_CONFIG.submitValue);
  body.append(SEARCH_PO_FORM_FIELDS.SEARCH_CRITERIA, "");

  return { criteria, mode, railway, poNo, dateFrom, dateTo, searchRange, pageNo, recordsPerPage, body: body.toString() };
}

/**
 * Build the request for one further result page, mirroring the portal's own
 * page links. IREPS renders them as
 *   postRequest('/epsn/searchPO.do?rly=-1&dateFrom=&dateTo=&pageNo=2&searchRange=1&poNo=&count=1720&recordsPerPage=20')
 * and postRequest.js turns the query string into hidden fields of a POST
 * form (no token, no searchCriteria). The parameters are re-posted exactly
 * in the order the link lists them.
 *
 * @param {{ pageNo: number, params: [string, string][] }} pageLink  from extractSearchPoPagination()
 * @param {string} [notRecognisedCode]  error code when the link is unusable
 * @returns {{ pageNo: number, body: string }}
 */
export function buildSearchPoPageRequest(pageLink, notRecognisedCode = "IREPS_SEARCH_PAGE_FAILED") {
  if (!pageLink || !Array.isArray(pageLink.params) || pageLink.params.length === 0) {
    throw new IrepsError(notRecognisedCode, "Page link without parameters");
  }
  const body = new URLSearchParams();
  for (const [key, value] of pageLink.params) body.append(key, value);
  return { pageNo: Number(pageLink.pageNo), body: body.toString() };
}

/**
 * POST a built request to searchPO.do.
 * @param {{ body: string }} request
 * @param {{ fetch?: typeof fetch }} [deps]
 * @param {string} [failureCode]   e.g. IREPS_CRN_SEARCH_FAILED
 * @returns {Promise<import("../ireps-api.js").IrepsResponse>}
 */
export async function submitSearchPoSearch(request, deps = {}, failureCode = "IREPS_SEARCH_PAGE_FAILED") {
  try {
    return await requestIreps({ path: SEARCH_PO_CONFIG.endpoint, method: "POST", body: request.body }, deps);
  } catch (error) {
    throw rewrapTransportError(error, failureCode, "Search request to IREPS failed");
  }
}

/* -------------------------------------------------------------------------- */
/* Descriptions (never contain the token)                                     */
/* -------------------------------------------------------------------------- */

/**
 * The request description that may be shown to the user / stored.
 * @param {string} criteria
 * @param {Partial<SearchPoRequest>|SearchPoOptions} request
 */
export function describeSearchPoRequest(criteria, request = {}) {
  const mode = inferSearchPoMode(request);
  const railway = request.railway === undefined || request.railway === null || request.railway === "" ? ALL_RAILWAYS : String(request.railway);
  const out = { criteria, mode, railway };
  if (mode === SEARCH_PO_MODE.PO_NUMBER) out.poNo = String(request.poNo || "").trim();
  if (mode === SEARCH_PO_MODE.DATE_RANGE) {
    out.dateFrom = request.dateFrom || "";
    out.dateTo = request.dateTo || "";
  }
  out.pageNo = Number(request.pageNo) || 1;
  out.recordsPerPage = Number(request.recordsPerPage) || SEARCH_PO_CONFIG.defaultRecordsPerPage;
  return out;
}

/**
 * Human readable filter text ("Last 180 Days, All Railways").
 * @param {Partial<SearchPoRequest>|SearchPoOptions} request
 * @param {{ value: string, label: string }[]} [railways]
 */
export function describeSearchPoFilter(request = {}, railways = []) {
  const d = describeSearchPoRequest(request.criteria || "", request);
  const railwayLabel = d.railway === ALL_RAILWAYS ? "All Railways" : (railways.find((r) => r.value === d.railway) || {}).label || `Railway ${d.railway}`;
  if (d.mode === SEARCH_PO_MODE.PO_NUMBER) return `PO No. ${d.poNo}, ${railwayLabel}`;
  if (d.mode === SEARCH_PO_MODE.DATE_RANGE) return `${d.dateFrom} to ${d.dateTo}, ${railwayLabel}`;
  return `Last 180 Days, ${railwayLabel}`;
}
