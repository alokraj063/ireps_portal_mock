/**
 * Purchase Order (PO) download: search IREPS by PO number and download the
 * PO PDF.
 *
 *   const found = await searchPo("27253922100240", { parseHtml });
 *   // -> the one PO record matching that PO number (IREPS_PO_NOT_FOUND when
 *   //    there is none), with its "Click to View/Download PO" href
 *   const result = await downloadPo("27253922100240", { parseHtml });
 *   // -> Downloads/DocLink/IREPS/PO/PO_27253922100240.pdf
 *
 * Search: the shared PO Search layer (searchIrepsDocuments) with
 * searchCriteria=PO, searchRange=3 (PO No.) - exactly the captured real
 * request (POST /epsn/searchPO.do, mode "poNumber"). IREPS returns "Total 1
 * result(s)" for a PO that exists and is visible to the logged-in vendor.
 *
 * Download: services/search-po/document-downloader.js with PO error codes.
 * Only the "Click to View/Download PO" / "View/Download PO" link is used -
 * never "Manage Your Purchase Order" (that opens Dispatch Particulars).
 *
 * downloadPo() takes a bare PO number, not a DOM element or input field, so
 * the caller (manual entry today, an automatic source later) never needs to
 * know anything about IREPS.
 */

import { IrepsError } from "../ireps-api.js";
import { SEARCH_PO_CRITERIA, errorCodesFor } from "../search-po/search-po-api.js";
import { searchIrepsDocuments, SEARCH_PO_FLOW_STAGES } from "../search-po/search-po-service.js";
import { downloadIrepsDocument } from "../search-po/document-downloader.js";
import { buildPoDownloadPath } from "../../utils/filename.js";
import { parsePoSearchResults } from "./po-parser.js";

/** Controlled error codes for the PO flow (mapped to UI text in utils/messages.js). */
export const PO_ERROR = Object.freeze({
  ...errorCodesFor(SEARCH_PO_CRITERIA.PO),
  LINK_NOT_FOUND: "IREPS_PO_LINK_NOT_FOUND",
  DOWNLOAD_FAILED: "IREPS_PO_DOWNLOAD_FAILED",
  INVALID_PDF: "IREPS_PO_INVALID_PDF"
});
export const PO_FLOW_STAGES = SEARCH_PO_FLOW_STAGES;

const DOWNLOAD_CODES = Object.freeze({
  LINK_NOT_FOUND: PO_ERROR.LINK_NOT_FOUND,
  DOWNLOAD_FAILED: PO_ERROR.DOWNLOAD_FAILED,
  INVALID_PDF: PO_ERROR.INVALID_PDF,
  SESSION_EXPIRED: PO_ERROR.SESSION_EXPIRED
});

/** Trim and validate a PO number; throws IrepsError(IREPS_INVALID_REQUEST) when empty. */
export function normalisePoNumber(poNumber) {
  const poNo = String(poNumber || "").trim();
  if (!poNo) throw new IrepsError(PO_ERROR.INVALID_REQUEST, "PO number is required", { detail: "Please enter a PO Number." });
  return poNo;
}

/**
 * Search IREPS for one PO by number.
 *
 * @param {string} poNumber
 * @param {import("../search-po/search-po-service.js").SearchIrepsDocumentsDeps} [deps]
 *        deps.parseHtml defaults to parsePoSearchResults (needs a DOMParser)
 * @returns {Promise<import("../search-po/search-po-service.js").SearchIrepsDocumentsResult & { record: object }>}
 */
export async function searchPo(poNumber, deps = {}) {
  const poNo = normalisePoNumber(poNumber);
  const parseHtml = deps.parseHtml || ((html, o) => parsePoSearchResults(html, o));
  let result;
  try {
    result = await searchIrepsDocuments({ criteria: SEARCH_PO_CRITERIA.PO, poNo }, { ...deps, parseHtml });
  } catch (error) {
    if (error instanceof IrepsError && error.code === PO_ERROR.NOT_FOUND && !error.detail) {
      throw new IrepsError(error.code, error.message, { status: error.status, detail: poNo });
    }
    throw error;
  }
  // "Total 1 result(s)" is the normal case; when IREPS ever lists more than
  // one row for the same PO No. the first is used and the rest are kept in
  // `records` so callers can see them.
  const record = result.records.find((r) => r.poPdfUrl) || result.records[0];
  return { ...result, record };
}

/** Download item for one PO record. */
export function poDownloadItem(record, poNo) {
  return {
    id: record ? record.id : `po-${poNo}`,
    url: record ? record.poPdfUrl : null,
    path: buildPoDownloadPath(poNo),
    label: `PO ${poNo}`,
    meta: { poNo, poDate: record ? record.poDate : null, railwayUnit: record ? record.railwayUnit : null }
  };
}

/**
 * Search IREPS for a PO number and download its PO PDF.
 *
 * @param {string} poNumber
 * @param {import("../search-po/search-po-service.js").SearchIrepsDocumentsDeps & { fetch?: typeof fetch, saveFile?: Function }} [deps]
 * @returns {Promise<{ success: true, poNumber: string, documentType: "PO", url: string, filename: string, downloadId: number|null, search: object }>}
 */
export async function downloadPo(poNumber, deps = {}) {
  const poNo = normalisePoNumber(poNumber);
  const found = await searchPo(poNo, deps);
  if (!found.record || !found.record.poPdfUrl) {
    throw new IrepsError(PO_ERROR.LINK_NOT_FOUND, `IREPS did not provide a PO PDF link for PO ${poNo}`, { detail: `IREPS did not provide a PO PDF link for PO ${poNo}.` });
  }
  const item = poDownloadItem(found.record, poNo);
  const done = await downloadIrepsDocument(item, { fetch: deps.fetch, saveFile: deps.saveFile, codes: DOWNLOAD_CODES });
  return {
    success: true,
    poNumber: poNo,
    documentType: "PO",
    url: item.url,
    filename: done.filename,
    downloadId: done.downloadId,
    search: found.search
  };
}
