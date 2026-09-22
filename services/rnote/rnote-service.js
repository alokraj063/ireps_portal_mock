/**
 * R-NOTE (Receipt Note) search: a thin, typed entry point over the shared PO
 * Search service (services/search-po/search-po-service.js).
 *
 *   const result = await searchRnote({ railway: "-1" }, { parseHtml });
 *   // == searchIrepsDocuments({ criteria: "RNOTE", ... }, { parseHtml })
 *
 * The only differences from CRN are searchCriteria=RNOTE, the result parser
 * (services/rnote/rnote-parser.js), the export columns and the file name.
 */

import { SEARCH_PO_CRITERIA, errorCodesFor } from "../search-po/search-po-api.js";
import { searchIrepsDocuments, validateSearchPoSession, SEARCH_PO_FLOW_STAGES } from "../search-po/search-po-service.js";
import { parseRnoteSearchResults } from "./rnote-parser.js";

/** Controlled error codes for the R-NOTE flow (mapped to UI text in utils/messages.js). */
export const RNOTE_ERROR = errorCodesFor(SEARCH_PO_CRITERIA.RNOTE);
export const RNOTE_FLOW_STAGES = SEARCH_PO_FLOW_STAGES;
export const validateRnoteSession = validateSearchPoSession;

/**
 * @param {import("../search-po/search-po-api.js").SearchPoOptions} [options]
 * @param {import("../search-po/search-po-service.js").SearchIrepsDocumentsDeps} deps
 *        deps.parseHtml defaults to parseRnoteSearchResults (needs a DOMParser)
 */
export function searchRnote(options = {}, deps = {}) {
  const parseHtml = deps.parseHtml || ((html, o) => parseRnoteSearchResults(html, o));
  return searchIrepsDocuments({ ...options, criteria: SEARCH_PO_CRITERIA.RNOTE }, { ...deps, parseHtml });
}
