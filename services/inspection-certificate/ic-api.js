/**
 * IREPS "Inspection Call List" (vendorInspectionCallList.do) request layer.
 *
 * This is a different IREPS workflow from Bill Status and PO Search and must
 * never share their endpoints:
 *
 *   Bill Status   ->  POST /epsn/admin/viewBills.do            (services/ireps-api.js)
 *   PO Search     ->  POST /epsn/searchPO.do                   (services/search-po/search-po-api.js)
 *   Inspection    ->  POST /epsn/tpi/vendorInspectionCallList.do (this module)
 *   Certificates
 *
 * Real flow (from the captured HAR, "My Inspection Calls" -> Completed / IC
 * Issued -> search by PO number):
 *
 *   1. POST /epsn/tpi/vendorInspectionCallList.do  callType=I&status=I
 *        -> HTML "Inspection Call List" page (Completed / IC Issued tab) with
 *           <form name="inspectionCallForm">, a fresh Struts token and the
 *           portal's current dateFrom/dateTo/dateFromIC/dateToIC defaults
 *   2. POST /epsn/tpi/vendorInspectionCallList.do  application/x-www-form-urlencoded
 *        org.apache.struts.taglib.html.TOKEN=<token from step 1>
 *        &pageNo=1&totalRecords=<from step 1>&callType=I&status=I&poNo=<PO>
 *        &inspAgency=-1&plNo=&inspOfficial=&poSr=
 *        &dateFrom=<from step 1>&dateTo=<from step 1>&dateFromIC=<from step 1>&dateToIC=<from step 1>
 *        &stage=-1&activity=searchResult&statusSelected=Completed / IC Issued
 *        -> HTML page with the IC result table for that PO (every issued IC)
 *
 * The date fields are never hard-coded: they are read from step 1's own form
 * and echoed back unchanged, exactly like the captured request. Only poNo is
 * overridden with the user's PO number.
 *
 * Only application-level headers are set; Chrome adds Cookie, Origin,
 * User-Agent, Sec-Fetch-* and friends itself (credentials: "include").
 * The base URL is IREPS_CONFIG.baseUrl, so the mock/real switch
 * (test/mock/switch-target.mjs) applies here as well.
 */

import { IREPS_CONFIG, IREPS_ERROR, IrepsError, requestIreps } from "../ireps-api.js";
import { IC_FORM_FIELDS, IC_CALL_TYPE, IC_STATUS, IC_STATUS_SELECTED_LABEL, ALL_INSPECTION_AGENCIES, ALL_STAGES } from "./ic-form.js";

/** Shared configuration. Keep every Inspection Call List URL / constant here. */
export const IC_CONFIG = Object.freeze({
  endpoint: "/epsn/tpi/vendorInspectionCallList.do",
  activityValue: "searchResult",
  /** Sanity limit for the PO No. field (mirrors search-po-api.js). */
  maxPoNoLength: 64
});

/** Controlled error codes for the IC flow (mapped to UI text in utils/messages.js). */
export const IC_ERROR = Object.freeze({
  SESSION_EXPIRED: IREPS_ERROR.SESSION_EXPIRED,
  LIST_PAGE_FAILED: "IREPS_IC_SEARCH_FAILED",
  TOKEN_NOT_FOUND: "IREPS_IC_TOKEN_NOT_FOUND",
  INVALID_REQUEST: IREPS_ERROR.INVALID_REQUEST,
  SEARCH_FAILED: "IREPS_IC_SEARCH_FAILED",
  RESULTS_INVALID: "IREPS_IC_RESULTS_INVALID",
  PARSE_FAILED: "IREPS_IC_PARSE_FAILED",
  LINK_NOT_FOUND: "IREPS_IC_LINK_NOT_FOUND",
  DOWNLOAD_FAILED: "IREPS_IC_DOWNLOAD_FAILED",
  INVALID_PDF: "IREPS_IC_INVALID_PDF"
});

/** Re-label a transport failure (IREPS_REQUEST_FAILED) with a step code. */
function rewrapTransportError(error, code, message) {
  if (error instanceof IrepsError && error.code === IREPS_ERROR.REQUEST_FAILED) {
    return new IrepsError(code, message, { status: error.status, reason: error.reason, detail: error.detail, cause: error });
  }
  return error;
}

/**
 * POST /epsn/tpi/vendorInspectionCallList.do with callType=I&status=I, exactly
 * like the portal does when the vendor opens "My Inspection Calls" ->
 * Completed / IC Issued. The response carries the search form, the dynamic
 * Struts token and the portal's current date defaults.
 *
 * @param {{ fetch?: typeof fetch }} [deps]
 * @returns {Promise<import("../ireps-api.js").IrepsResponse>}
 */
export async function loadIcListPage(deps = {}) {
  const body = new URLSearchParams();
  body.set(IC_FORM_FIELDS.CALL_TYPE, IC_CALL_TYPE);
  body.set(IC_FORM_FIELDS.STATUS, IC_STATUS);
  try {
    return await requestIreps({ path: IC_CONFIG.endpoint, method: "POST", body: body.toString() }, deps);
  } catch (error) {
    throw rewrapTransportError(error, IC_ERROR.LIST_PAGE_FAILED, "Unable to load the IREPS Inspection Call List page");
  }
}

/**
 * @typedef {Object} IcFormState  the values read from loadIcListPage() (never the HTML)
 * @property {string} token
 * @property {string|null} totalRecords
 * @property {string|null} dateFrom
 * @property {string|null} dateTo
 * @property {string|null} dateFromIC
 * @property {string|null} dateToIC
 */

/**
 * Build the "Show Results" request for one PO number, preserving the
 * portal's own current date defaults (never hard-coded).
 *
 * @param {IcFormState} formState  from extractIcForm() on loadIcListPage()'s HTML
 * @param {string} poNumber
 * @returns {{ poNo: string, body: string }}
 */
export function buildIcSearchRequest(formState, poNumber) {
  if (!formState || typeof formState.token !== "string" || formState.token.trim() === "") {
    throw new IrepsError(IC_ERROR.TOKEN_NOT_FOUND, "A Struts token is required to build the request");
  }
  const poNo = String(poNumber || "").trim();
  if (!poNo) throw new IrepsError(IC_ERROR.INVALID_REQUEST, "PO number missing", { detail: "Please enter PO No!" });
  if (poNo.length > IC_CONFIG.maxPoNoLength) {
    throw new IrepsError(IC_ERROR.INVALID_REQUEST, "PO number too long", { detail: `PO No. must not exceed ${IC_CONFIG.maxPoNoLength} characters.` });
  }

  const body = new URLSearchParams();
  body.set(IC_FORM_FIELDS.TOKEN, formState.token);
  body.set(IC_FORM_FIELDS.PAGE_NO, "1");
  body.set(IC_FORM_FIELDS.TOTAL_RECORDS, formState.totalRecords ?? "0");
  body.set(IC_FORM_FIELDS.CALL_TYPE, IC_CALL_TYPE);
  body.set(IC_FORM_FIELDS.STATUS, IC_STATUS);
  body.set(IC_FORM_FIELDS.PO_NO, poNo);
  body.set(IC_FORM_FIELDS.INSP_AGENCY, ALL_INSPECTION_AGENCIES);
  body.set(IC_FORM_FIELDS.PL_NO, "");
  body.set(IC_FORM_FIELDS.INSP_OFFICIAL, "");
  body.set(IC_FORM_FIELDS.PO_SR, "");
  body.set(IC_FORM_FIELDS.DATE_FROM, formState.dateFrom ?? "");
  body.set(IC_FORM_FIELDS.DATE_TO, formState.dateTo ?? "");
  body.set(IC_FORM_FIELDS.DATE_FROM_IC, formState.dateFromIC ?? "");
  body.set(IC_FORM_FIELDS.DATE_TO_IC, formState.dateToIC ?? "");
  body.set(IC_FORM_FIELDS.STAGE, ALL_STAGES);
  body.set(IC_FORM_FIELDS.ACTIVITY, IC_CONFIG.activityValue);
  body.set(IC_FORM_FIELDS.STATUS_SELECTED, IC_STATUS_SELECTED_LABEL);

  return { poNo, body: body.toString() };
}

/**
 * POST a built request to vendorInspectionCallList.do.
 * @param {{ body: string }} request
 * @param {{ fetch?: typeof fetch }} [deps]
 * @returns {Promise<import("../ireps-api.js").IrepsResponse>}
 */
export async function submitIcSearch(request, deps = {}) {
  try {
    return await requestIreps({ path: IC_CONFIG.endpoint, method: "POST", body: request.body }, deps);
  } catch (error) {
    throw rewrapTransportError(error, IC_ERROR.SEARCH_FAILED, "IC search request to IREPS failed");
  }
}

/** Is this absolute URL on the configured IREPS origin? (mirrors search-po-api.js) */
export function isIrepsOriginUrl(url, baseUrl = IREPS_CONFIG.baseUrl) {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Resolve a link found in the IC HTML against the configured IREPS base URL.
 * @param {string} href
 * @param {string} [baseUrl]
 */
export function resolveIcUrl(href, baseUrl = IREPS_CONFIG.baseUrl) {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed === "#" || /^(javascript|data|vbscript|about):/i.test(trimmed)) return null;
  try {
    const base = new URL(baseUrl);
    const url = new URL(trimmed, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname === base.hostname && url.protocol !== base.protocol) {
      url.protocol = base.protocol;
      url.port = base.port;
    }
    return url.href;
  } catch {
    return null;
  }
}
