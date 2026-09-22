/**
 * IREPS API module.
 *
 * All network access to IREPS lives here. Nothing else in the extension
 * knows a URL or an HTTP method. Requests are executed by Chrome with the
 * user's existing authenticated browser session (credentials: "include");
 * DocLink never reads, stores or forwards the session cookie itself.
 *
 * Real Bill Status flow (from the captured HAR):
 *
 *   1. POST /epsn/admin/viewBills.do            empty body
 *        -> HTML page with <form name="vendorPartyCodeForm"> and a fresh
 *           org.apache.struts.taglib.html.TOKEN
 *   2. POST /epsn/admin/viewBills.do            application/x-www-form-urlencoded
 *        org.apache.struts.taglib.html.TOKEN=<token from step 1>
 *        zone=-1  searchRange=1  dateFrom=  dateTo=  submit=Show Results  searchParam=
 *        -> HTML page with one <table id="table_id"> per bill
 *
 * Only application-level headers are set; Chrome adds Cookie, Origin,
 * User-Agent, Sec-Fetch-* and friends itself. The session is the portal's
 * own JSESSIONID (+ F5 TS01b82797) cookie pair that the security-key login
 * sets in the browser; DocLink never reads it, Chrome attaches it because
 * requests are made with credentials: "include". The mock portal issues
 * cookies of the same names and shape, so nothing here changes between them.
 *
 * Switching between the mock portal and the real portal changes ONLY
 * IREPS_CONFIG.baseUrl (and manifest host_permissions):
 *   node test/mock/switch-target.mjs mock | real
 */

import { logger } from "../utils/logger.js";
import { STRUTS_TOKEN_FIELD, ALL_ZONES_VALUE } from "./ireps-form.js";

/** Base configuration. Keep every IREPS URL here. */
export const IREPS_CONFIG = Object.freeze({
  baseUrl: "http://localhost:8765",
  /** The portal's home page (captured: GET /epsn/home/showHome.do); "Open IREPS" lands here. */
  homePath: "/epsn/home/showHome.do",
  billStatusEndpoint: "/epsn/admin/viewBills.do",
  /** Abort a request after this many milliseconds (the real page is ~7 MB). */
  timeoutMs: 120000,
  /** Reject absurdly small responses as "not a bill status page". */
  minimumHtmlLength: 200
});

/** searchRange radio values on the IREPS form. */
export const BILL_SEARCH_RANGE = Object.freeze({
  LAST_90_DAYS: "1",
  DATE_RANGE: "2",
  RAILWAY_ZONE: "3"
});

/** DocLink request modes (public API of fetchBillStatus). */
export const BILL_SEARCH_MODE = Object.freeze({
  LAST_90_DAYS: "last90Days",
  DATE_RANGE: "dateRange",
  RAILWAY_ZONE: "railwayZone"
});

const MODE_TO_RANGE = Object.freeze({
  [BILL_SEARCH_MODE.LAST_90_DAYS]: BILL_SEARCH_RANGE.LAST_90_DAYS,
  [BILL_SEARCH_MODE.DATE_RANGE]: BILL_SEARCH_RANGE.DATE_RANGE,
  [BILL_SEARCH_MODE.RAILWAY_ZONE]: BILL_SEARCH_RANGE.RAILWAY_ZONE
});

/** Field names of the vendorPartyCodeForm (exactly as IREPS posts them). */
export const BILL_STATUS_FORM_FIELDS = Object.freeze({
  TOKEN: STRUTS_TOKEN_FIELD,
  ZONE: "zone",
  SEARCH_RANGE: "searchRange",
  DATE_FROM: "dateFrom",
  DATE_TO: "dateTo",
  SUBMIT: "submit",
  SEARCH_PARAM: "searchParam"
});

export const SHOW_RESULTS_VALUE = "Show Results";
export const ALL_ZONES = ALL_ZONES_VALUE;
/** IREPS' own validateDateRange() rejects ranges longer than this. */
export const MAX_DATE_RANGE_DAYS = 180;

/** Controlled error codes for the Bill Status flow (mapped to UI text in utils/messages.js). */
export const IREPS_ERROR = Object.freeze({
  SESSION_EXPIRED: "IREPS_SESSION_EXPIRED",
  REQUEST_FAILED: "IREPS_REQUEST_FAILED",
  TOKEN_NOT_FOUND: "IREPS_TOKEN_NOT_FOUND",
  INVALID_RESPONSE: "IREPS_INVALID_RESPONSE",
  PARSE_FAILED: "IREPS_PARSE_FAILED",
  NO_RECORDS: "IREPS_NO_RECORDS",
  INVALID_REQUEST: "IREPS_INVALID_REQUEST"
});

/** Error raised for every failed or rejected IREPS interaction. */
export class IrepsError extends Error {
  /**
   * @param {string} code      one of IREPS_ERROR
   * @param {string} message   developer message (never shown raw to the user)
   * @param {{ status?: number|null, reason?: string, detail?: string, cause?: unknown }} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "IrepsError";
    this.code = code;
    this.status = details.status ?? null;
    this.reason = details.reason ?? null; // "network" | "timeout" | "http" | ...
    this.detail = details.detail ?? null; // short user-safe detail
    this.cause = details.cause;
  }
}

/* -------------------------------------------------------------------------- */
/* Low level request                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build an absolute IREPS URL and refuse anything outside the configured origin.
 * @param {string} path
 * @returns {string}
 */
export function buildIrepsUrl(path) {
  const url = new URL(path, IREPS_CONFIG.baseUrl);
  if (url.origin !== new URL(IREPS_CONFIG.baseUrl).origin) {
    throw new Error("Refusing to call a non-IREPS origin");
  }
  return url.toString();
}

/**
 * Perform one request with the browser session. Returns the response text
 * plus minimal metadata; never returns headers, so cookies cannot leak.
 *
 * @param {{ path: string, method?: string, body?: string|null }} request
 * @param {{ fetch?: typeof fetch }} [deps]  injectable fetch for tests
 * @returns {Promise<IrepsResponse>}
 */
export async function requestIreps(request, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const method = (request.method || "GET").toUpperCase();
  const url = buildIrepsUrl(request.path);

  /** @type {RequestInit} */
  const init = {
    method,
    credentials: "include",
    cache: "no-store",
    redirect: "follow",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  };
  if (method === "POST") {
    // The captured initial request is a POST with Content-Length: 0 and this
    // content type; the search request carries the url-encoded form.
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = request.body == null ? "" : String(request.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IREPS_CONFIG.timeoutMs);
  init.signal = controller.signal;

  logger.info("IREPS request started", { method, path: request.path, bodyBytes: init.body ? init.body.length : 0 });
  const startedAt = Date.now();

  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    clearTimeout(timer);
    if (error && error.name === "AbortError") {
      throw new IrepsError(IREPS_ERROR.REQUEST_FAILED, "IREPS did not respond in time", {
        reason: "timeout",
        detail: "IREPS did not respond in time",
        cause: error
      });
    }
    throw new IrepsError(IREPS_ERROR.REQUEST_FAILED, "Unable to reach IREPS", {
      reason: "network",
      detail: "IREPS could not be reached",
      cause: error
    });
  }

  let html = "";
  try {
    html = await response.text();
  } catch (error) {
    clearTimeout(timer);
    throw new IrepsError(IREPS_ERROR.REQUEST_FAILED, "IREPS response could not be read", {
      reason: "network",
      status: response.status,
      detail: "the IREPS response could not be read",
      cause: error
    });
  }
  clearTimeout(timer);

  logger.info(`Response status: ${response.status}`, { htmlBytes: html.length, ms: Date.now() - startedAt, finalPath: safePath(response.url) });

  if (!response.ok) {
    throw new IrepsError(IREPS_ERROR.REQUEST_FAILED, `IREPS returned HTTP ${response.status}`, {
      reason: "http",
      status: response.status,
      detail: `IREPS returned HTTP ${response.status}`
    });
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    redirected: response.redirected,
    contentType: response.headers.get("content-type") || "",
    html
  };
}

/* -------------------------------------------------------------------------- */
/* Step 1 - load the Bill Status page (form + fresh token)                    */
/* -------------------------------------------------------------------------- */

/**
 * POST /epsn/admin/viewBills.do with an empty body, exactly like the portal
 * does when the user opens "View Bills". The response carries the search
 * form, the dynamic Struts token and the default (Last 90 Days) records.
 *
 * @param {{ fetch?: typeof fetch }} [deps]
 * @returns {Promise<IrepsResponse>}
 */
export function loadBillStatusPage(deps = {}) {
  return requestIreps({ path: IREPS_CONFIG.billStatusEndpoint, method: "POST", body: "" }, deps);
}

/* -------------------------------------------------------------------------- */
/* Date range validation (mirrors IREPS validateDateRange())                  */
/* -------------------------------------------------------------------------- */

const DDMMYYYY = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/**
 * Parse "DD/MM/YYYY" into a UTC Date, or null when the text is not a real date.
 * @param {string} text
 * @returns {Date|null}
 */
export function parseIrepsDate(text) {
  const m = DDMMYYYY.exec(String(text || "").trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

/**
 * Same rules as the IREPS page script: both dates present, 10 characters in
 * DD/MM/YYYY, From not after To, span not more than 180 days.
 *
 * @param {string} dateFrom
 * @param {string} dateTo
 * @returns {{ ok: boolean, error: string|null }}
 */
export function validateDateRange(dateFrom, dateTo) {
  const from = String(dateFrom || "").trim();
  const to = String(dateTo || "").trim();
  if (from.length !== 10) return { ok: false, error: "Please enter From Date (DD/MM/YYYY)." };
  if (to.length !== 10) return { ok: false, error: "Please enter To Date (DD/MM/YYYY)." };
  const dFrom = parseIrepsDate(from);
  const dTo = parseIrepsDate(to);
  if (!dFrom) return { ok: false, error: "From Date must be a valid date in DD/MM/YYYY format." };
  if (!dTo) return { ok: false, error: "To Date must be a valid date in DD/MM/YYYY format." };
  if (dFrom > dTo) return { ok: false, error: "From Date must be earlier than To Date." };
  const days = Math.ceil(Math.abs(dTo.getTime() - dFrom.getTime()) / (1000 * 3600 * 24));
  if (days > MAX_DATE_RANGE_DAYS) return { ok: false, error: `Selected Date Range should be within ${MAX_DATE_RANGE_DAYS} days.` };
  return { ok: true, error: null };
}

/* -------------------------------------------------------------------------- */
/* Step 2 - build and submit the "Show Results" request                       */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} BillStatusRequestOptions
 * @property {"last90Days"|"dateRange"|"railwayZone"} [mode]  default last90Days
 * @property {string} [zone]       zone value from the form ("-1" = All, default)
 * @property {string} [dateFrom]   DD/MM/YYYY (dateRange mode)
 * @property {string} [dateTo]     DD/MM/YYYY (dateRange mode)
 */

/**
 * @typedef {Object} BillStatusRequest
 * @property {string} mode
 * @property {string} zone
 * @property {string} searchRange
 * @property {string} dateFrom
 * @property {string} dateTo
 * @property {string} body           url-encoded form body (contains the token)
 */

/**
 * Build the form body for "Show Results". Throws IrepsError
 * (IREPS_INVALID_REQUEST) for an unknown mode or an invalid date range.
 *
 * @param {BillStatusRequestOptions} options
 * @param {string} token   dynamic Struts token from loadBillStatusPage()
 * @returns {BillStatusRequest}
 */
export function buildBillStatusRequest(options = {}, token) {
  const mode = options.mode || BILL_SEARCH_MODE.LAST_90_DAYS;
  const searchRange = MODE_TO_RANGE[mode];
  if (!searchRange) {
    throw new IrepsError(IREPS_ERROR.INVALID_REQUEST, `Unknown Bill Status mode "${mode}"`, { detail: "unknown search mode" });
  }
  if (typeof token !== "string" || token.trim() === "") {
    throw new IrepsError(IREPS_ERROR.TOKEN_NOT_FOUND, "A Struts token is required to build the request");
  }

  const zone = options.zone === undefined || options.zone === null || options.zone === "" ? ALL_ZONES : String(options.zone);
  let dateFrom = "";
  let dateTo = "";
  if (mode === BILL_SEARCH_MODE.DATE_RANGE) {
    const verdict = validateDateRange(options.dateFrom, options.dateTo);
    if (!verdict.ok) throw new IrepsError(IREPS_ERROR.INVALID_REQUEST, verdict.error, { detail: verdict.error });
    dateFrom = String(options.dateFrom).trim();
    dateTo = String(options.dateTo).trim();
  }

  const body = new URLSearchParams();
  body.set(BILL_STATUS_FORM_FIELDS.TOKEN, token);
  body.set(BILL_STATUS_FORM_FIELDS.ZONE, zone);
  body.set(BILL_STATUS_FORM_FIELDS.SEARCH_RANGE, searchRange);
  body.set(BILL_STATUS_FORM_FIELDS.DATE_FROM, dateFrom);
  body.set(BILL_STATUS_FORM_FIELDS.DATE_TO, dateTo);
  body.set(BILL_STATUS_FORM_FIELDS.SUBMIT, SHOW_RESULTS_VALUE);
  body.set(BILL_STATUS_FORM_FIELDS.SEARCH_PARAM, "");

  return { mode, zone, searchRange, dateFrom, dateTo, body: body.toString() };
}

/**
 * The request description that may be shown to the user / stored. Never
 * contains the token.
 * @param {BillStatusRequest|BillStatusRequestOptions} request
 */
export function describeBillStatusRequest(request) {
  const mode = request.mode || BILL_SEARCH_MODE.LAST_90_DAYS;
  const zone = request.zone === undefined || request.zone === null || request.zone === "" ? ALL_ZONES : String(request.zone);
  const out = { mode, zone };
  if (mode === BILL_SEARCH_MODE.DATE_RANGE) {
    out.dateFrom = request.dateFrom || "";
    out.dateTo = request.dateTo || "";
  }
  return out;
}

/**
 * Human readable filter text for documents ("Last 90 Days, All Zones").
 * @param {BillStatusRequestOptions} request
 * @param {{ value: string, label: string }[]} [zones]
 */
export function describeBillStatusFilter(request, zones = []) {
  const described = describeBillStatusRequest(request);
  const zoneLabel = described.zone === ALL_ZONES ? "All Zones" : (zones.find((z) => z.value === described.zone) || {}).label || `Zone ${described.zone}`;
  if (described.mode === BILL_SEARCH_MODE.DATE_RANGE) return `${described.dateFrom} to ${described.dateTo}, ${zoneLabel}`;
  if (described.mode === BILL_SEARCH_MODE.RAILWAY_ZONE) return `Railway Zone: ${zoneLabel}`;
  return `Last 90 Days, ${zoneLabel}`;
}

/**
 * POST the built form to viewBills.do ("Show Results").
 * @param {BillStatusRequest} request
 * @param {{ fetch?: typeof fetch }} [deps]
 * @returns {Promise<IrepsResponse>}
 */
export function submitBillStatusSearch(request, deps = {}) {
  return requestIreps({ path: IREPS_CONFIG.billStatusEndpoint, method: "POST", body: request.body }, deps);
}

/** Path portion of a URL for logging (never the query string). */
function safePath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/**
 * @typedef {Object} IrepsResponse
 * @property {boolean} ok
 * @property {number} status
 * @property {string} statusText
 * @property {string} url          final URL after redirects
 * @property {boolean} redirected
 * @property {string} contentType
 * @property {string} html
 */
