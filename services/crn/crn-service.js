/**
 * CRN (Consignment Receipt Note) search: a thin, typed entry point over the
 * shared PO Search service (services/search-po/search-po-service.js).
 *
 *   const result = await searchCrn({ railway: "-1", pageNo: 1, recordsPerPage: 20 }, { parseHtml });
 *   // == searchIrepsDocuments({ criteria: "CRN", ... }, { parseHtml })
 *
 * Everything that is not CRN-specific (endpoint, session check, Struts
 * token, railway list, date validation, pagination, retry) lives in the
 * shared layer and is identical for R-NOTE.
 */

import { SEARCH_PO_CRITERIA, errorCodesFor } from "../search-po/search-po-api.js";
import { searchIrepsDocuments, validateSearchPoSession, SEARCH_PO_FLOW_STAGES } from "../search-po/search-po-service.js";
import { parseCrnSearchResults } from "./crn-parser.js";

/** Controlled error codes for the CRN flow (mapped to UI text in utils/messages.js). */
export const CRN_ERROR = errorCodesFor(SEARCH_PO_CRITERIA.CRN);
export const CRN_FLOW_STAGES = SEARCH_PO_FLOW_STAGES;
export const validateCrnSession = validateSearchPoSession;

/**
 * @param {import("../search-po/search-po-api.js").SearchPoOptions} [options]
 * @param {import("../search-po/search-po-service.js").SearchIrepsDocumentsDeps} deps
 *        deps.parseHtml defaults to parseCrnSearchResults (needs a DOMParser)
 */
export function searchCrn(options = {}, deps = {}) {
  const parseHtml = deps.parseHtml || ((html, o) => parseCrnSearchResults(html, o));
  return searchIrepsDocuments({ ...options, criteria: SEARCH_PO_CRITERIA.CRN }, { ...deps, parseHtml });
}
