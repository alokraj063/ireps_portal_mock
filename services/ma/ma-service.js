/**
 * Modification Advice (MA) copies: search + PDF download.
 *
 *   const found = await searchMa({ dateMode: "date", date: "21/09/2026" }, { parseHtml });
 *   // -> every MA whose "MA Date" is 21/09/2026 (client-side filter over the
 *   //    IREPS result), each with its "View/Download MA" href
 *   const summary = await downloadMaPdfs(found.records, { onProgress });
 *   // -> Downloads/DocLink/IREPS/MA/2026-09-21/MA_<PO>_<MA>.pdf, 3 at a time
 *
 * Search: the shared PO Search layer (searchIrepsDocuments) with
 * searchCriteria=MA. The captured portal paginates MA server-side at 20 per
 * page but accepted recordsPerPage=2000 and returned all 1,838 rows in one
 * response, so 2000 is the MA default (pagination is still followed if the
 * portal ever prints page links). The IREPS date-range filter is not used
 * for the date selection because its semantics (PO date vs MA date) are not
 * confirmed; instead the "Last 180 Days" result is filtered here by the
 * "MA Date" column. A PO number, when given, is sent to IREPS as usual.
 *
 * Download: services/search-po/document-downloader.js with MA error codes.
 * Only `maPdfUrl` (title="View/Download MA") is downloaded - never the PO
 * PDF, the Manage PO link or the acknowledgement link.
 */

import { IrepsError, parseIrepsDate, validateDateRange } from "../ireps-api.js";
import { SEARCH_PO_CRITERIA, errorCodesFor } from "../search-po/search-po-api.js";
import { searchIrepsDocuments, SEARCH_PO_FLOW_STAGES } from "../search-po/search-po-service.js";
import { downloadIrepsDocuments, downloadIrepsDocument, DOCUMENT_DOWNLOAD_STATUS } from "../search-po/document-downloader.js";
import { buildMaDownloadPath } from "../../utils/filename.js";
import { parseMaSearchResults, maDateKey } from "./ma-parser.js";

/** Controlled error codes for the MA flow (mapped to UI text in utils/messages.js). */
export const MA_ERROR = Object.freeze({
  ...errorCodesFor(SEARCH_PO_CRITERIA.MA),
  LINK_NOT_FOUND: "IREPS_MA_LINK_NOT_FOUND",
  DOWNLOAD_FAILED: "IREPS_MA_DOWNLOAD_FAILED",
  INVALID_PDF: "IREPS_MA_INVALID_PDF"
});
export const MA_FLOW_STAGES = SEARCH_PO_FLOW_STAGES;
export const MA_DOWNLOAD_STATUS = DOCUMENT_DOWNLOAD_STATUS;

/** How the MA list is narrowed by "MA Date". */
export const MA_DATE_MODE = Object.freeze({
  DATE: "date", // one day (default: today)
  RANGE: "dateRange", // from .. to
  ALL: "all" // everything IREPS returned (Last 180 Days)
});

const DOWNLOAD_CODES = Object.freeze({
  LINK_NOT_FOUND: MA_ERROR.LINK_NOT_FOUND,
  DOWNLOAD_FAILED: MA_ERROR.DOWNLOAD_FAILED,
  INVALID_PDF: MA_ERROR.INVALID_PDF,
  SESSION_EXPIRED: MA_ERROR.SESSION_EXPIRED
});

/**
 * @typedef {Object} MaSearchOptions
 * @property {string} [railway]        "-1" = All (default)
 * @property {string} [poNo]           optional PO number (sent to IREPS)
 * @property {"date"|"dateRange"|"all"} [dateMode]   default "date"
 * @property {string} [date]           DD/MM/YYYY (dateMode "date"); default today
 * @property {string} [dateFrom]       DD/MM/YYYY (dateMode "dateRange")
 * @property {string} [dateTo]         DD/MM/YYYY (dateMode "dateRange")
 * @property {number|string} [recordsPerPage]  default 2000 (verified on the portal)
 */

/** Today as DD/MM/YYYY (local time). */
export function todayIreps(now = new Date()) {
  return `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}`;
}

/**
 * Validate the date selection and return a predicate over MA records plus
 * a human-readable description. Throws IrepsError(IREPS_INVALID_REQUEST).
 * @param {MaSearchOptions} options
 */
export function buildMaDateFilter(options = {}) {
  const mode = options.dateMode || MA_DATE_MODE.DATE;
  if (mode === MA_DATE_MODE.ALL) return { mode, label: "All MA dates (Last 180 Days)", matches: () => true };
  if (mode === MA_DATE_MODE.DATE) {
    const date = String(options.date || todayIreps()).trim();
    const key = maDateKey(date);
    if (!key) throw new IrepsError(MA_ERROR.INVALID_REQUEST, `Invalid MA date "${date}"`, { detail: "MA Date must be a valid date in DD/MM/YYYY format." });
    return { mode, date, label: `MA Date ${date}`, matches: (r) => r.maDateKey === key };
  }
  if (mode === MA_DATE_MODE.RANGE) {
    const verdict = validateDateRange(options.dateFrom, options.dateTo);
    if (!verdict.ok) throw new IrepsError(MA_ERROR.INVALID_REQUEST, verdict.error, { detail: verdict.error });
    const from = parseIrepsDate(options.dateFrom).getTime();
    const to = parseIrepsDate(options.dateTo).getTime();
    return {
      mode,
      dateFrom: String(options.dateFrom).trim(),
      dateTo: String(options.dateTo).trim(),
      label: `MA Date ${String(options.dateFrom).trim()} to ${String(options.dateTo).trim()}`,
      matches: (r) => {
        const d = parseIrepsDate(r.maDate);
        return !!d && d.getTime() >= from && d.getTime() <= to;
      }
    };
  }
  throw new IrepsError(MA_ERROR.INVALID_REQUEST, `Unknown MA date mode "${mode}"`, { detail: "unknown date selection" });
}

/**
 * Search MAs and narrow them by MA Date.
 *
 * @param {MaSearchOptions} [options]
 * @param {import("../search-po/search-po-service.js").SearchIrepsDocumentsDeps} [deps]
 *        deps.parseHtml defaults to parseMaSearchResults (needs a DOMParser)
 * @returns {Promise<import("../search-po/search-po-service.js").SearchIrepsDocumentsResult & {
 *   allRecordCount: number, dateFilter: { mode: string, label: string, date?: string, dateFrom?: string, dateTo?: string },
 *   downloadable: number }>}
 */
export async function searchMa(options = {}, deps = {}) {
  const dateFilter = buildMaDateFilter(options); // validate before any request
  const parseHtml = deps.parseHtml || ((html, o) => parseMaSearchResults(html, o));
  const serverOptions = {
    criteria: SEARCH_PO_CRITERIA.MA,
    railway: options.railway,
    recordsPerPage: options.recordsPerPage
  };
  // IREPS' own date filter is not used (semantics unconfirmed); a PO number is.
  if (options.poNo && String(options.poNo).trim()) serverOptions.poNo = String(options.poNo).trim();

  const result = await searchIrepsDocuments(serverOptions, { ...deps, parseHtml });
  const all = result.records;
  const records = all.filter(dateFilter.matches);
  if (records.length === 0) {
    throw new IrepsError(MA_ERROR.NOT_FOUND, `No MA matched ${dateFilter.label}`, {
      detail: `${dateFilter.label} (IREPS returned ${all.length} MA${all.length === 1 ? "" : "s"} for ${result.filter})`
    });
  }
  const { mode, label, date, dateFrom, dateTo } = dateFilter;
  return {
    ...result,
    records,
    recordCount: records.length,
    allRecordCount: all.length,
    downloadable: records.filter((r) => r.maPdfUrl).length,
    dateFilter: { mode, label, date, dateFrom, dateTo },
    filter: `${label}; IREPS search: ${result.filter}`
  };
}

/** Download items for a set of MA records (records without a link are kept so they can be reported as failed). */
export function maDownloadItems(records) {
  return (records || []).map((r) => ({
    id: r.id,
    url: r.maPdfUrl || null,
    path: buildMaDownloadPath(r),
    label: `MA ${r.maNo || "?"} (PO ${r.poNo || "?"})`,
    meta: { maNo: r.maNo, poNo: r.poNo, maDate: r.maDate, railwayUnit: r.railwayUnit }
  }));
}

/**
 * Download one MA PDF (never the PO PDF).
 * @param {object} record
 * @param {{ fetch?: typeof fetch, saveFile?: Function }} [options]
 */
export function downloadMaPdf(record, options = {}) {
  const [item] = maDownloadItems([record]);
  return downloadIrepsDocument(item, { ...options, codes: DOWNLOAD_CODES });
}

/**
 * Download the MA PDFs of several records with limited concurrency.
 * @param {object[]} records
 * @param {{ concurrency?: number, fetch?: typeof fetch, saveFile?: Function, onProgress?: Function }} [options]
 */
export function downloadMaPdfs(records, options = {}) {
  return downloadIrepsDocuments(maDownloadItems(records), { ...options, codes: DOWNLOAD_CODES });
}
