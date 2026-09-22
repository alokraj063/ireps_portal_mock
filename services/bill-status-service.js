/**
 * Bill Status retrieval service.
 *
 * Wires the IREPS request layer, the form extractor and the parser into the
 * public DocLink API:
 *
 *   const result = await fetchBillStatus({ mode: "last90Days", zone: "-1" }, deps);
 *
 * Flow (all requests use the user's authenticated browser session):
 *
 *   POST viewBills.do (empty body)  -> Bill Status page
 *   validate session                -> IREPS_SESSION_EXPIRED if not authenticated
 *   extract Struts token            -> IREPS_TOKEN_NOT_FOUND if absent
 *   build "Show Results" form       -> IREPS_INVALID_REQUEST on bad options
 *   POST viewBills.do (form)        -> Bill Status results page
 *   validate response               -> retry once with a fresh token, else IREPS_INVALID_RESPONSE
 *   parse every table#table_id      -> IREPS_PARSE_FAILED / IREPS_NO_RECORDS
 *
 * The token only ever lives in local variables of this function. The result
 * returned to callers never contains it.
 *
 * Parsing needs a DOMParser, which the service worker does not have, so the
 * parser is injected (`deps.parseHtml`): the service worker passes a function
 * that forwards to the offscreen document; tests pass parseBillStatus.
 */

import {
  loadBillStatusPage,
  submitBillStatusSearch,
  buildBillStatusRequest,
  describeBillStatusRequest,
  describeBillStatusFilter,
  IREPS_ERROR,
  IrepsError
} from "./ireps-api.js";
import { validateIrepsSession } from "./session-service.js";
import { extractBillStatusForm, publicFormInfo } from "./ireps-form.js";
import { logger } from "../utils/logger.js";

/**
 * @typedef {Object} FetchBillStatusDeps
 * @property {typeof fetch} [fetch]              injectable fetch (tests)
 * @property {(html: string, options: { filter: string, sourceUrl: string|null }) => Promise<object>|object} parseHtml
 * @property {(stage: string, detail?: string) => void} [onProgress]
 * @property {import("./ireps-api.js").IrepsResponse|null} [initialPage]  reuse an already loaded page
 * @property {boolean} [noRetry]                 disable the single fresh-token retry
 */

/**
 * @typedef {Object} BillStatusFetchResult
 * @property {true} success
 * @property {{ mode: string, zone: string, dateFrom?: string, dateTo?: string }} request
 * @property {string} filter
 * @property {string} fetchedAt      ISO timestamp
 * @property {number} recordCount
 * @property {object[]} bills
 * @property {string[]} warnings
 * @property {object} form           zones / searchRange controls (no token)
 * @property {object} parsed         full parser result (bills, printableHtml, ...)
 */

/**
 * Load the page, extract the token, run the search and parse the result.
 *
 * @param {import("./ireps-api.js").BillStatusRequestOptions} [options]
 * @param {FetchBillStatusDeps} deps
 * @returns {Promise<BillStatusFetchResult>}
 */
export async function fetchBillStatus(options = {}, deps = {}) {
  if (typeof deps.parseHtml !== "function") throw new Error("fetchBillStatus requires deps.parseHtml");
  const progress = typeof deps.onProgress === "function" ? deps.onProgress : () => {};
  const requestDeps = { fetch: deps.fetch };

  // Step 1: Bill Status page (also the session check).
  progress("CHECKING_SESSION");
  let page = deps.initialPage || null;
  if (!page) page = await loadBillStatusPage(requestDeps);
  assertAuthenticated(page);
  progress("CONNECTED");

  // Step 2: dynamic Struts token + form metadata (token stays in memory only).
  let form = extractBillStatusForm(page.html);
  if (!form.token) throw new IrepsError(IREPS_ERROR.TOKEN_NOT_FOUND, "Struts token not found on the Bill Status page");
  let request = buildBillStatusRequest(options, form.token);
  page = null;

  // Step 3: Show Results.
  progress("FETCHING");
  let results = await submitBillStatusSearch(request, requestDeps);
  let verdict = validateIrepsSession(results.html, results);
  if (!verdict.authenticated && verdict.code !== IREPS_ERROR.SESSION_EXPIRED && !deps.noRetry) {
    // The Struts token is single-use per page render; if the user reloaded an
    // IREPS page in another tab in between, the token was consumed. Retry once
    // with a fresh page and token.
    logger.warn("Search response not recognised; retrying once with a fresh form token");
    const fresh = await loadBillStatusPage(requestDeps);
    assertAuthenticated(fresh);
    form = extractBillStatusForm(fresh.html);
    if (!form.token) throw new IrepsError(IREPS_ERROR.TOKEN_NOT_FOUND, "Struts token not found on the Bill Status page");
    request = buildBillStatusRequest(options, form.token);
    results = await submitBillStatusSearch(request, requestDeps);
    verdict = validateIrepsSession(results.html, results);
  }
  if (!verdict.authenticated) {
    throw new IrepsError(verdict.code, verdict.reason || "IREPS response not recognised", { status: verdict.status });
  }
  request = { ...request, body: null };

  // Step 4: parse.
  progress("PROCESSING");
  const filter = describeBillStatusFilter(options, form.zones);
  let parsed;
  try {
    parsed = await deps.parseHtml(results.html, { filter, sourceUrl: results.url || null });
  } catch (error) {
    throw new IrepsError(IREPS_ERROR.PARSE_FAILED, "Bill Status HTML could not be parsed", { cause: error });
  }
  results = null;
  if (!parsed || !Array.isArray(parsed.bills)) {
    throw new IrepsError(IREPS_ERROR.PARSE_FAILED, "Parser returned no result");
  }
  if (parsed.recordCount === 0) {
    if (parsed.blockCount > 0) {
      throw new IrepsError(IREPS_ERROR.PARSE_FAILED, `${parsed.blockCount} bill blocks found but none could be read`);
    }
    throw new IrepsError(IREPS_ERROR.NO_RECORDS, "IREPS returned no bill records for the selected search");
  }
  if (parsed.warnings && parsed.warnings.length) {
    logger.info(`Parser warnings: ${parsed.warnings.length}`, parsed.warnings.slice(0, 5));
  }

  return {
    success: true,
    request: describeBillStatusRequest(request),
    filter,
    fetchedAt: new Date().toISOString(),
    recordCount: parsed.recordCount,
    bills: parsed.bills,
    warnings: parsed.warnings || [],
    form: publicFormInfo(form),
    parsed
  };
}

function assertAuthenticated(page) {
  const verdict = validateIrepsSession(page.html, page);
  if (!verdict.authenticated) {
    throw new IrepsError(verdict.code, verdict.reason || "IREPS session is not active", { status: verdict.status });
  }
}
