/**
 * Inspection Certificate (IC) download: find every issued IC of a PO and
 * download each IC PDF.
 *
 *   const found = await searchInspectionCertificates("27253922100240", { parseHtml });
 *   // -> every "Completed / IC Issued" call of that PO (0, 1 or many),
 *   //    success:true even when there are none - a PO with no IC yet is not
 *   //    a failure of the PO
 *   const summary = await downloadInspectionCertificates("27253922100240", { parseHtml });
 *   // -> Downloads/DocLink/IREPS/IC/<PO>/IC_<PO>_<POSR>_<CALLID>.pdf, 3 at a time
 *
 * Search: services/inspection-certificate/ic-api.js + ic-parser.js against
 * POST /epsn/tpi/vendorInspectionCallList.do (Completed / IC Issued tab,
 * activity=searchResult) - a completely different endpoint from PO Search
 * (searchPO.do) and Bill Status (viewBills.do); see ic-api.js.
 *
 * Download: services/search-po/document-downloader.js (generic fetch +
 * verify-as-PDF + save) with IC error codes. Only "View/ Download IC PDF" is
 * used - "View Call Details" is read-only info and "Revalidate IC" is never
 * called (DocLink stays strictly read-only).
 */

import { IrepsError } from "../ireps-api.js";
import { isIrepsLoginPage } from "../session-service.js";
import { downloadIrepsDocuments, DOCUMENT_DOWNLOAD_STATUS } from "../search-po/document-downloader.js";
import { buildIcDownloadPath } from "../../utils/filename.js";
import { loadIcListPage, submitIcSearch, buildIcSearchRequest, IC_ERROR } from "./ic-api.js";
import { extractIcForm, hasIcForm } from "./ic-form.js";
import { parseIcSearchResults } from "./ic-parser.js";

export { IC_ERROR };
export const IC_DOWNLOAD_STATUS = DOCUMENT_DOWNLOAD_STATUS;

/** Progress stage ids emitted through deps.onProgress. */
export const IC_FLOW_STAGES = Object.freeze({
  CHECKING_SESSION: "CHECKING_SESSION",
  CONNECTED: "CONNECTED",
  SEARCHING: "SEARCHING",
  PARSING: "PARSING"
});

const DOWNLOAD_CODES = Object.freeze({
  LINK_NOT_FOUND: IC_ERROR.LINK_NOT_FOUND,
  DOWNLOAD_FAILED: IC_ERROR.DOWNLOAD_FAILED,
  INVALID_PDF: IC_ERROR.INVALID_PDF,
  SESSION_EXPIRED: IC_ERROR.SESSION_EXPIRED
});

/** Validate a vendorInspectionCallList.do response and decide whether the user is authenticated. */
function validateIcSession(html, response = {}, notRecognisedCode = IC_ERROR.LIST_PAGE_FAILED) {
  if (response.status !== undefined && response.ok === false) {
    return { authenticated: false, reason: `IREPS returned HTTP ${response.status}`, code: notRecognisedCode, status: response.status };
  }
  if (!html || html.trim().length === 0) {
    return { authenticated: false, reason: "IREPS returned an empty response", code: notRecognisedCode };
  }
  if (isIrepsLoginPage(html, response)) {
    return { authenticated: false, reason: "IREPS session expired", code: IC_ERROR.SESSION_EXPIRED };
  }
  if (hasIcForm(html)) return { authenticated: true, reason: null, code: "OK" };
  return { authenticated: false, reason: "IREPS response was not recognised as the Inspection Call List page", code: notRecognisedCode };
}

/** Trim and validate a PO number; throws IrepsError(IREPS_INVALID_REQUEST) when empty. */
export function normalisePoNumber(poNumber) {
  const poNo = String(poNumber || "").trim();
  if (!poNo) throw new IrepsError(IC_ERROR.INVALID_REQUEST, "PO number is required", { detail: "Please enter a PO Number." });
  return poNo;
}

/**
 * @typedef {Object} IcSearchResult
 * @property {true} success
 * @property {string} poNumber
 * @property {object[]} certificates   every issued IC of the PO (may be empty)
 * @property {number} count
 * @property {string[]} warnings
 * @property {string} fetchedAt
 */

/**
 * Find every issued Inspection Certificate of a PO. A PO with zero issued
 * ICs is a successful result (`certificates: [], count: 0`), never an error.
 *
 * @param {string} poNumber
 * @param {{ fetch?: typeof fetch, parseHtml?: Function, onProgress?: (stage: string) => void }} [deps]
 *        deps.parseHtml defaults to parseIcSearchResults (needs a DOMParser)
 * @returns {Promise<IcSearchResult>}
 */
export async function searchInspectionCertificates(poNumber, deps = {}) {
  const poNo = normalisePoNumber(poNumber);
  const progress = typeof deps.onProgress === "function" ? deps.onProgress : () => {};
  const parseHtml = deps.parseHtml || ((html, options) => parseIcSearchResults(html, poNo, options));
  const requestDeps = { fetch: deps.fetch };

  progress(IC_FLOW_STAGES.CHECKING_SESSION);
  const listPage = await loadIcListPage(requestDeps);
  const listVerdict = validateIcSession(listPage.html, listPage);
  if (!listVerdict.authenticated) {
    throw new IrepsError(listVerdict.code, listVerdict.reason || "IREPS session is not active", { status: listVerdict.status });
  }
  progress(IC_FLOW_STAGES.CONNECTED);

  const formState = extractIcForm(listPage.html);
  if (!formState.token) throw new IrepsError(IC_ERROR.TOKEN_NOT_FOUND, "Struts token not found on the Inspection Call List page");

  progress(IC_FLOW_STAGES.SEARCHING);
  const request = buildIcSearchRequest(formState, poNo);
  const results = await submitIcSearch(request, requestDeps);
  const verdict = validateIcSession(results.html, results, IC_ERROR.RESULTS_INVALID);
  if (!verdict.authenticated) {
    throw new IrepsError(verdict.code, verdict.reason || "IREPS response not recognised", { status: verdict.status });
  }

  progress(IC_FLOW_STAGES.PARSING);
  let parsed;
  try {
    parsed = await parseHtml(results.html, { sourceUrl: results.url || null });
  } catch (error) {
    throw new IrepsError(IC_ERROR.PARSE_FAILED, "IC results HTML could not be parsed", { cause: error });
  }
  if (!parsed || !Array.isArray(parsed.records)) throw new IrepsError(IC_ERROR.PARSE_FAILED, "Parser returned no result");

  return {
    success: true,
    poNumber: poNo,
    certificates: parsed.records,
    count: parsed.records.length,
    warnings: parsed.warnings || [],
    fetchedAt: new Date().toISOString()
  };
}

/** Download items for a set of IC records (records without a link are kept so they can be reported as failed). */
export function icDownloadItems(records, poNo) {
  return (records || []).map((r) => ({
    id: r.id,
    url: r.icPdfUrl || null,
    path: buildIcDownloadPath({ poNo: r.poNo || poNo, poSerial: r.poSerial, callId: r.callId }),
    label: `IC ${r.callId || "?"} (PO Sr. ${r.poSerial || "?"})`,
    meta: { callId: r.callId, poNo: r.poNo || poNo, poSerial: r.poSerial, icDate: r.icDate }
  }));
}

/**
 * @typedef {Object} IcDownloadResult
 * @property {true} success
 * @property {string} poNumber
 * @property {number} count            certificates found
 * @property {import("../search-po/document-downloader.js").DocumentBatchSnapshot & { startedAt: string, finishedAt: string }} downloads
 */

/**
 * Search IREPS for every issued IC of a PO and download each IC PDF.
 * A PO with zero issued ICs succeeds with an empty download batch.
 *
 * @param {string} poNumber
 * @param {{ fetch?: typeof fetch, parseHtml?: Function, saveFile?: Function, concurrency?: number,
 *          onProgress?: (stage: string) => void, onDownloadProgress?: (snapshot: object) => void }} [deps]
 * @returns {Promise<IcDownloadResult>}
 */
export async function downloadInspectionCertificates(poNumber, deps = {}) {
  const found = await searchInspectionCertificates(poNumber, deps);
  const items = icDownloadItems(found.certificates, found.poNumber);
  const downloads = await downloadIrepsDocuments(items, {
    fetch: deps.fetch,
    saveFile: deps.saveFile,
    concurrency: deps.concurrency,
    codes: DOWNLOAD_CODES,
    onProgress: deps.onDownloadProgress
  });
  return { success: true, poNumber: found.poNumber, count: found.count, downloads };
}
