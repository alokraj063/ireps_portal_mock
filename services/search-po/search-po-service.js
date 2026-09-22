/**
 * Shared PO Search service: runs one document-type search (CRN, R-NOTE, ...)
 * end to end and returns the parsed records of every result page.
 *
 *   const result = await searchIrepsDocuments({ criteria: "CRN", railway: "-1" }, deps);
 *   const result = await searchIrepsDocuments({ criteria: "RNOTE" }, deps);
 *
 * Flow (all requests use the user's authenticated browser session):
 *
 *   POST searchPO.do  searchParam=showPage        -> PO Search page (= the session check)
 *   validate session                               -> IREPS_SESSION_EXPIRED / IREPS_SEARCH_PAGE_FAILED
 *   extract Struts token                           -> IREPS_TOKEN_NOT_FOUND if absent
 *   build "Show Results" form (searchCriteria=X)   -> IREPS_INVALID_REQUEST on bad options
 *   POST searchPO.do                               -> result page
 *   validate response                              -> retry once with a fresh token, else IREPS_<X>_RESULTS_INVALID
 *   parse the result table (type-specific parser)  -> IREPS_<X>_PARSE_FAILED / IREPS_<X>_NOT_FOUND
 *   follow server-side result pages, if any        -> every page is fetched; never silently the first one only
 *
 * The token only ever lives in local variables of this function. The result
 * returned to callers never contains it.
 *
 * Parsing needs a DOMParser, which the service worker does not have, so the
 * parser is injected (`deps.parseHtml(html, { criteria, sourceUrl, startIndex })`):
 * the service worker forwards to the offscreen document, which routes by
 * criteria to parseCrnSearchResults / parseRnoteSearchResults; tests pass
 * the parser directly.
 *
 * Nothing here touches viewBills.do or the Bill Status implementation.
 */

import { IrepsError } from "../ireps-api.js";
import { isIrepsLoginPage, SESSION_EXPIRED_MARKERS } from "../session-service.js";
import { logger } from "../../utils/logger.js";
import {
  SEARCH_PO_CONFIG,
  SEARCH_PO_ERROR,
  errorCodesFor,
  documentTypeFor,
  loadSearchPoPage,
  submitSearchPoSearch,
  buildSearchPoRequest,
  buildSearchPoPageRequest,
  describeSearchPoRequest,
  describeSearchPoFilter
} from "./search-po-api.js";
import { extractSearchPoForm, hasSearchPoForm, publicSearchPoFormInfo } from "./search-po-form.js";
import { extractSearchPoPagination, extractSearchPoPageMessage } from "./search-po-table.js";

/** Progress stage ids emitted through deps.onProgress. */
export const SEARCH_PO_FLOW_STAGES = Object.freeze({
  CHECKING_SESSION: "CHECKING_SESSION",
  CONNECTED: "CONNECTED",
  SEARCHING: "SEARCHING",
  PAGING: "PAGING",
  PARSING: "PARSING"
});

function plainText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Validate a searchPO.do response and decide whether the user is
 * authenticated. "Authenticated" means IREPS answered with the PO Search
 * page (searchPOForm posting to /epsn/searchPO.do). HTTP 200 alone is never
 * trusted: an expired session comes back as a login page with 200.
 *
 * @param {string} html
 * @param {{ ok?: boolean, status?: number, url?: string, redirected?: boolean }} [response]
 * @param {{ notRecognisedCode?: string }} [options]
 * @returns {{ authenticated: boolean, reason: string|null, code: string, status?: number|null }}
 */
export function validateSearchPoSession(html, response = {}, options = {}) {
  const notRecognised = options.notRecognisedCode || SEARCH_PO_ERROR.SEARCH_PAGE_FAILED;
  if (response.status !== undefined && response.ok === false) {
    return { authenticated: false, reason: `IREPS returned HTTP ${response.status}`, code: notRecognised, status: response.status };
  }
  if (!html || html.trim().length === 0) {
    return { authenticated: false, reason: "IREPS returned an empty response", code: notRecognised };
  }
  if (isIrepsLoginPage(html, response)) {
    const text = plainText(html);
    const expired = SESSION_EXPIRED_MARKERS.some((m) => text.includes(m));
    return { authenticated: false, reason: expired ? "IREPS session expired" : "IREPS login required", code: SEARCH_PO_ERROR.SESSION_EXPIRED };
  }
  if (hasSearchPoForm(html)) return { authenticated: true, reason: null, code: "OK" };
  return { authenticated: false, reason: "IREPS response was not recognised as the PO Search page", code: notRecognised };
}

function assertPage(page, notRecognisedCode) {
  const verdict = validateSearchPoSession(page.html, page, { notRecognisedCode });
  if (!verdict.authenticated) {
    throw new IrepsError(verdict.code, verdict.reason || "IREPS session is not active", {
      status: verdict.status,
      detail: verdict.code === SEARCH_PO_ERROR.SESSION_EXPIRED ? null : "the IREPS PO Search page was not recognised"
    });
  }
}

/**
 * @typedef {Object} SearchIrepsDocumentsDeps
 * @property {typeof fetch} [fetch]               injectable fetch (tests)
 * @property {(html: string, options: { criteria: string, sourceUrl: string|null, startIndex: number }) => Promise<object>|object} parseHtml
 * @property {(stage: string, detail?: string) => void} [onProgress]
 * @property {boolean} [noRetry]                  disable the single fresh-token retry
 * @property {boolean} [fetchAllPages]            follow server-side result pages (default true)
 * @property {number} [maxPages]                  safety limit for page following
 */

/**
 * @typedef {Object} SearchIrepsDocumentsResult
 * @property {true} success
 * @property {string} criteria      "CRN" | "RNOTE"
 * @property {object} documentType  entry of SEARCH_PO_DOCUMENT_TYPES
 * @property {object} search        { criteria, mode, railway, poNo?, dateFrom?, dateTo?, pageNo, recordsPerPage, pagesFetched }
 * @property {string} filter        "Last 180 Days, All Railways"
 * @property {string} fetchedAt     ISO timestamp
 * @property {number} recordCount
 * @property {object[]} records
 * @property {string[]} headerLabels  column labels of the result table (first page)
 * @property {string[]} warnings
 * @property {object} form          railways / criteria / searchRange controls (no token)
 * @property {{ serverPaginated: boolean, pagesFetched: number, pageCount: number, totalCount: number|null }} pagination
 */

/**
 * Load the PO Search page, extract the token, run the search for one
 * document type and parse every result page.
 *
 * @param {import("./search-po-api.js").SearchPoOptions & { criteria: string }} options
 * @param {SearchIrepsDocumentsDeps} deps
 * @returns {Promise<SearchIrepsDocumentsResult>}
 */
export async function searchIrepsDocuments(options = {}, deps = {}) {
  if (typeof deps.parseHtml !== "function") throw new Error("searchIrepsDocuments requires deps.parseHtml");
  const { criteria, ...searchOptions } = options;
  const documentType = documentTypeFor(criteria);
  const CODES = errorCodesFor(criteria);
  const progress = typeof deps.onProgress === "function" ? deps.onProgress : () => {};
  const requestDeps = { fetch: deps.fetch };
  const fetchAllPages = deps.fetchAllPages !== false;
  const maxPages = Number(deps.maxPages) > 0 ? Number(deps.maxPages) : SEARCH_PO_CONFIG.maxPages;

  // Step 1: PO Search page (also the session check).
  progress(SEARCH_PO_FLOW_STAGES.CHECKING_SESSION);
  let page = await loadSearchPoPage(requestDeps);
  assertPage(page, CODES.SEARCH_PAGE_FAILED);
  progress(SEARCH_PO_FLOW_STAGES.CONNECTED);

  // Step 2: dynamic Struts token + form metadata (token stays in memory only).
  let form = extractSearchPoForm(page.html);
  if (!form.token) throw new IrepsError(CODES.TOKEN_NOT_FOUND, "Struts token not found on the PO Search page");
  if (searchOptions.recordsPerPage === undefined || searchOptions.recordsPerPage === null || searchOptions.recordsPerPage === "") {
    searchOptions.recordsPerPage = documentType.defaultRecordsPerPage || SEARCH_PO_CONFIG.defaultRecordsPerPage;
  }
  let request = buildSearchPoRequest(criteria, searchOptions, form.token);
  page = null;

  // Step 3: "Show Results" for this criteria.
  progress(SEARCH_PO_FLOW_STAGES.SEARCHING);
  let results = await submitSearchPoSearch(request, requestDeps, CODES.SEARCH_FAILED);
  let verdict = validateSearchPoSession(results.html, results, { notRecognisedCode: CODES.RESULTS_INVALID });
  if (!verdict.authenticated && verdict.code !== CODES.SESSION_EXPIRED && !deps.noRetry) {
    // Single-use token consumed elsewhere (e.g. the user reloaded IREPS in
    // another tab)? Load a fresh page + token and retry exactly once.
    logger.warn(`${criteria} search response not recognised; retrying once with a fresh form token`);
    const fresh = await loadSearchPoPage(requestDeps);
    assertPage(fresh, CODES.SEARCH_PAGE_FAILED);
    form = extractSearchPoForm(fresh.html);
    if (!form.token) throw new IrepsError(CODES.TOKEN_NOT_FOUND, "Struts token not found on the PO Search page");
    request = buildSearchPoRequest(criteria, searchOptions, form.token);
    results = await submitSearchPoSearch(request, requestDeps, CODES.SEARCH_FAILED);
    verdict = validateSearchPoSession(results.html, results, { notRecognisedCode: CODES.RESULTS_INVALID });
  }
  if (!verdict.authenticated) {
    throw new IrepsError(verdict.code, verdict.reason || "IREPS response not recognised", {
      status: verdict.status,
      detail: verdict.code === CODES.SESSION_EXPIRED ? null : `the ${documentType.shortLabel} results page was not recognised`
    });
  }
  request = { ...request, body: null };

  // Step 4: parse the first (possibly only) page.
  progress(SEARCH_PO_FLOW_STAGES.PARSING);
  const filter = describeSearchPoFilter(request, form.railways);
  const firstPage = await parsePage(results, deps, criteria, 1, CODES);
  results = null;

  const records = [...firstPage.records];
  const warnings = [...firstPage.warnings];
  const headerLabels = Array.isArray(firstPage.headerLabels) ? firstPage.headerLabels : [];
  let pagesFetched = 1;
  const pagination = firstPage.pagination || extractSearchPoPagination("");
  const pageCount = pagination.serverPaginated ? Math.min(pagination.maxPage, maxPages) : 1;

  if (firstPage.structure === "none") {
    const message = firstPage.pageMessage;
    if (message) {
      throw new IrepsError(CODES.RESULTS_INVALID, `IREPS reported: ${message}`, { detail: `IREPS reported: ${message.slice(0, 160)}` });
    }
  } else if (firstPage.rowCount > 0 && firstPage.recordCount === 0) {
    throw new IrepsError(CODES.PARSE_FAILED, `${firstPage.rowCount} ${documentType.shortLabel} rows found but none could be read`);
  }

  // Step 5: further server-side pages. Every page is fetched or the whole
  // search fails - a partial list is never returned silently.
  if (fetchAllPages && pagination.serverPaginated && pageCount > 1) {
    for (let pageNo = 2; pageNo <= pageCount; pageNo++) {
      progress(SEARCH_PO_FLOW_STAGES.PAGING, `${pageNo}/${pageCount}`);
      const link = pagination.links[pageNo] || derivePageLink(pagination, pageNo, CODES);
      const pageRequest = buildSearchPoPageRequest(link, CODES.RESULTS_INVALID);
      const response = await submitSearchPoSearch(pageRequest, requestDeps, CODES.SEARCH_FAILED);
      const pageVerdict = validateSearchPoSession(response.html, response, { notRecognisedCode: CODES.RESULTS_INVALID });
      if (!pageVerdict.authenticated) {
        throw new IrepsError(pageVerdict.code, pageVerdict.reason || `Result page ${pageNo} not recognised`, {
          status: pageVerdict.status,
          detail: pageVerdict.code === CODES.SESSION_EXPIRED ? null : `result page ${pageNo} of ${pageCount} was not recognised`
        });
      }
      const parsed = await parsePage(response, deps, criteria, records.length + 1, CODES);
      if (parsed.structure === "none" && parsed.rowCount === 0) {
        throw new IrepsError(CODES.RESULTS_INVALID, `Result page ${pageNo} contained no results table`, {
          detail: `result page ${pageNo} of ${pageCount} had no results table`
        });
      }
      records.push(...parsed.records);
      warnings.push(...parsed.warnings);
      pagesFetched++;
    }
    if (pagination.maxPage > pageCount) warnings.push(`Only the first ${pageCount} of ${pagination.maxPage} result pages were fetched (safety limit).`);
  }

  if (records.length === 0) {
    throw new IrepsError(CODES.NOT_FOUND, `IREPS returned no ${documentType.shortLabel} records for the selected search`);
  }
  if (warnings.length) logger.info(`${criteria} parser warnings: ${warnings.length}`, warnings.slice(0, 5));

  return {
    success: true,
    criteria,
    documentType,
    search: { ...describeSearchPoRequest(criteria, request), pagesFetched },
    filter,
    fetchedAt: new Date().toISOString(),
    recordCount: records.length,
    records,
    headerLabels,
    warnings,
    form: publicSearchPoFormInfo(form),
    pagination: {
      serverPaginated: pagination.serverPaginated,
      pagesFetched,
      pageCount,
      totalCount: pagination.totalCount
    }
  };
}

async function parsePage(response, deps, criteria, startIndex, CODES) {
  let parsed;
  try {
    parsed = await deps.parseHtml(response.html, { criteria, sourceUrl: response.url || null, startIndex });
  } catch (error) {
    throw new IrepsError(CODES.PARSE_FAILED, `${criteria} results HTML could not be parsed`, { cause: error });
  }
  if (!parsed || !Array.isArray(parsed.records)) throw new IrepsError(CODES.PARSE_FAILED, "Parser returned no result");
  if (!parsed.pagination) parsed.pagination = extractSearchPoPagination(response.html);
  if (parsed.pageMessage === undefined) parsed.pageMessage = extractSearchPoPageMessage(response.html);
  return parsed;
}

/** When a page has no explicit link (e.g. "next" only), reuse page 1's parameters with a new pageNo. */
function derivePageLink(pagination, pageNo, CODES) {
  const template = pagination.links[pagination.pageNumbers[0]];
  if (!template) throw new IrepsError(CODES.RESULTS_INVALID, `No link for result page ${pageNo}`);
  return { pageNo, params: template.params.map(([k, v]) => (k === "pageNo" ? [k, String(pageNo)] : [k, v])) };
}
