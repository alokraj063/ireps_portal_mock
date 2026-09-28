/**
 * Offscreen document script.
 *
 * Receives raw IREPS HTML from the service worker, parses it with DOMParser
 * (unavailable in service workers) and returns the structured result.
 * The HTML is parsed into a detached Document; nothing from IREPS is ever
 * inserted into this page, so no IREPS script can execute.
 *
 * Parsers served:
 *   PARSE_BILL_STATUS         -> services/bill-parser.js          (viewBills.do page)
 *   PARSE_SEARCH_PO_RESULTS   -> routed by `criteria`:
 *                                PO    services/po/po-parser.js       (searchPO.do PO results)
 *                                CRN   services/crn/crn-parser.js     (searchPO.do CRN results)
 *                                RNOTE services/rnote/rnote-parser.js (searchPO.do R-NOTE results)
 *                                MA    services/ma/ma-parser.js       (searchPO.do MA results)
 *   PARSE_IC_RESULTS          -> services/inspection-certificate/ic-parser.js
 *                                (vendorInspectionCallList.do results, a different endpoint)
 */

import { parseBillStatus } from "../services/bill-parser.js";
import { parsePoSearchResults } from "../services/po/po-parser.js";
import { parseCrnSearchResults } from "../services/crn/crn-parser.js";
import { parseRnoteSearchResults } from "../services/rnote/rnote-parser.js";
import { parseMaSearchResults } from "../services/ma/ma-parser.js";
import { parseIcSearchResults } from "../services/inspection-certificate/ic-parser.js";
import { SEARCH_PO_CRITERIA } from "../services/search-po/search-po-api.js";

const SEARCH_PO_PARSERS = {
  [SEARCH_PO_CRITERIA.PO]: parsePoSearchResults,
  [SEARCH_PO_CRITERIA.CRN]: parseCrnSearchResults,
  [SEARCH_PO_CRITERIA.RNOTE]: parseRnoteSearchResults,
  [SEARCH_PO_CRITERIA.MA]: parseMaSearchResults
};
import { MESSAGE_TYPES, TARGETS } from "../utils/messages.js";
import { loadIrepsConfig } from "../services/ireps-api.js";
import { logger } from "../utils/logger.js";

/**
 * Parsers resolve relative IREPS links (e.g. "/ireps/etender/...") against
 * IREPS_CONFIG.baseUrl (config.json's target). This is a separate JS context
 * from the service worker, so config.json is read here too, before the
 * first parse call - never assumed to already be loaded.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== TARGETS.OFFSCREEN) return false;

  if (message.type === MESSAGE_TYPES.PARSE_BILL_STATUS) {
    loadIrepsConfig()
      .then(() => parseBillStatus(message.html, { sourceUrl: message.sourceUrl || null, filter: message.filter || undefined }))
      .then((result) => {
        logger.info(`Bills parsed: ${result.recordCount}`, { structure: result.structure, blocks: result.blockCount, skipped: result.skippedCount });
        sendResponse({ ok: true, result });
      })
      .catch((error) => {
        logger.error("Parser failed", error);
        sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
      });
    return true;
  }

  if (message.type === MESSAGE_TYPES.PARSE_SEARCH_PO_RESULTS) {
    const parser = SEARCH_PO_PARSERS[message.criteria];
    if (!parser) {
      sendResponse({ ok: false, error: `UNSUPPORTED_IREPS_SEARCH_TYPE: ${message.criteria}` });
      return false;
    }
    loadIrepsConfig()
      .then(() => parser(message.html, { sourceUrl: message.sourceUrl || null, startIndex: message.startIndex || 1 }))
      .then((result) => {
        logger.info(`${message.criteria} records parsed: ${result.recordCount}`, { structure: result.structure, rows: result.rowCount, skipped: result.skippedCount, pages: result.pagination.maxPage });
        sendResponse({ ok: true, result });
      })
      .catch((error) => {
        logger.error(`${message.criteria} parser failed`, error);
        sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
      });
    return true;
  }

  if (message.type === MESSAGE_TYPES.PARSE_IC_RESULTS) {
    loadIrepsConfig()
      .then(() => parseIcSearchResults(message.html, message.poNo || null, { sourceUrl: message.sourceUrl || null }))
      .then((result) => {
        logger.info(`IC records parsed: ${result.recordCount}`, { structure: result.structure, rows: result.rowCount, filteredOut: result.filteredCount });
        sendResponse({ ok: true, result });
      })
      .catch((error) => {
        logger.error("IC parser failed", error);
        sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
      });
    return true;
  }
  return false;
});
