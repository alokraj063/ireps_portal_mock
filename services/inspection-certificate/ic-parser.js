/**
 * IREPS Inspection Certificate (IC) search-result parser.
 *
 * Input : raw server-rendered HTML from POST
 *         /epsn/tpi/vendorInspectionCallList.do (activity=searchResult,
 *         status=I / Completed / IC Issued) - untrusted.
 * Output: one record per inspection call row, with the IC PDF link.
 *
 * Captured layout (real portal, PO No. search, one PO with 4 issued ICs):
 *
 *   <table class="lightGrayTbl table-hover">
 *     <tr><th>Call Date</th><th>TPI Agency</th><th>PO No. / Date</th><th>Call Id</th>
 *         <th>PO Sr.</th><th>PL No: Description</th><th>Type</th><th>Offer Qty.</th>
 *         <th>Registration Date</th><th>Inspection Start Date</th><th>IC Date</th>
 *         <th>Passed Qty.</th><th>Call Status</th><th>Actions</th></tr>
 *     <tr>
 *       <td rowspan="4">05/05/2026</td>                          <!-- Call Date -->
 *       <td rowspan="4">TUV INDIA PVT LTD.-MUMBAI</td>           <!-- TPI Agency -->
 *       <td rowspan="4"><a href="#" onclick="viewPastCall(...)">27253922100240<br /> dt. 16/01/2026</a></td>
 *       <td>6038184070</td>  <!-- Call Id -->
 *       <td><a href="#" onclick="...">001</a></td>  <!-- PO Sr. -->
 *       <td>29160030: KIT FOR UNLOADER EXHAUST VALVE ...</td>
 *       <td>Product - Final Product Inspection</td>
 *       <td>106</td> <td>08/05/2026</td> <td>07/05/2026</td> <td>07/05/2026</td> <td>106</td>
 *       <td>Completed (IC Issued)</td>
 *       <td>
 *         <a href="#" onclick="viewCall(...)" title=""><img title="View Call Details"></a>
 *         <a href="/ireps/etender/ct/tpi/ic/052026/3480517.pdf" target="_blank" title="View/ Download IC PDF">...</a>
 *         <a href="#" onclick="icRevaidate('3480517');">...</a>
 *       </td>
 *     </tr>
 *     <tr> <!-- rows 2-4: same PO, no rowspan cells - only Call Id .. Actions --> </tr>
 *
 * IREPS groups every row of the same call date / PO under one <tr rowspan="N">
 * for the first three columns (Call Date, TPI Agency, PO No. / Date); the
 * DOM therefore does NOT repeat those cells on the following rows. This
 * parser tracks the "current group" values and applies them to every row
 * that is missing its own leading cells, so every IC of a multi-IC PO is
 * still fully described (never only the first).
 *
 * The IC document is identified by the anchor title "View/ Download IC PDF"
 * - never "View Call Details" (read-only info) and never "Revalidate IC"
 * (DocLink's downloader stays strictly read-only and never calls it).
 * Requires a DOMParser (offscreen document / tests).
 */

import { stripDangerousNodes } from "../../utils/sanitizer.js";
import { normalizeIrepsValue } from "../bill-parser.js";
import { normaliseText } from "../../utils/sanitizer.js";
import { resolveIcUrl } from "./ic-api.js";
import { normaliseHeaderLabel, cellText, anchorsOf, isHeaderRow, locateResultTable, resultEnvelope } from "../search-po/search-po-table.js";

export const IC_LINK_TITLE = "view/ download ic pdf";

/** The three leading columns IREPS groups with rowspan (in header order). */
const GROUPED_KEYS = ["callDate", "tpiAgency", "poNoDate"];

/** Header label (normalised) -> record key. */
export const IC_HEADER_MAP = Object.freeze({
  calldate: "callDate",
  tpiagency: "tpiAgency",
  ponodate: "poNoDate",
  callid: "callId",
  posr: "poSerial",
  plnodescription: "plDescription",
  type: "inspectionType",
  offerqty: "offerQty",
  registrationdate: "registrationDate",
  inspectionstartdate: "inspectionStartDate",
  icdate: "icDate",
  passedqty: "passedQty",
  callstatus: "callStatus",
  action: "_action",
  actions: "_action"
});

/** @returns {string|null} record key for a header label, null when unknown. */
export function matchIcHeader(label) {
  const key = normaliseHeaderLabel(label);
  return Object.prototype.hasOwnProperty.call(IC_HEADER_MAP, key) ? IC_HEADER_MAP[key] : null;
}

/** Typed fields of an IC record (excluding the compound poNoDate, split below). */
export const IC_FIELDS = [
  "callDate",
  "tpiAgency",
  "poNo",
  "poDate",
  "callId",
  "poSerial",
  "plDescription",
  "inspectionType",
  "offerQty",
  "registrationDate",
  "inspectionStartDate",
  "icDate",
  "passedQty",
  "callStatus"
];

function createEmptyIcRecord() {
  const record = { index: 0, id: "" };
  for (const key of IC_FIELDS) record[key] = null;
  record.icPdfUrl = null;
  record.links = [];
  record.rawColumns = {};
  return record;
}

/** "27253922100240\ndt. 16/01/2026" -> { poNo, poDate }. */
function splitPoNoDate(text) {
  const value = normalizeIrepsValue(text);
  if (!value) return { poNo: null, poDate: null };
  const lines = normaliseText(value).split("\n");
  const poNo = normalizeIrepsValue(lines[0]);
  const dateMatch = /dt\.?\s*(.+)$/i.exec(lines[1] || "");
  const poDate = dateMatch ? normalizeIrepsValue(dateMatch[1]) : normalizeIrepsValue(lines[1]);
  return { poNo, poDate };
}

/**
 * Parse one IC row, applying the carried rowspan-group values (Call Date,
 * TPI Agency, PO No. / Date) when the row itself does not carry them.
 *
 * @param {Element} row
 * @param {{ labels: string[], keys: (string|null)[] }} header
 * @param {object} group  mutable { values: Record<string,string|null> } carried across rows
 * @param {number} ordinal
 * @param {{ baseUrl?: string }} [options]
 * @returns {{ record: object, warnings: string[] }}
 */
export function parseIcRow(row, header, group, ordinal = 1, options = {}) {
  const record = createEmptyIcRecord();
  record.index = ordinal;
  const warnings = [];
  const cells = Array.from(row.cells);
  const missing = header.keys.length - cells.length; // leading grouped columns this row does not repeat

  if (missing > 0) {
    for (const key of GROUPED_KEYS.slice(0, missing)) {
      if (key === "poNoDate") {
        record.poNo = group.values.poNo ?? null;
        record.poDate = group.values.poDate ?? null;
      } else {
        record[key] = group.values[key] ?? null;
      }
    }
  }

  cells.forEach((cell, i) => {
    const offset = missing > 0 ? missing : 0;
    const key = header.keys[i + offset] !== undefined ? header.keys[i + offset] : null;
    const label = header.labels[i + offset] !== undefined ? header.labels[i + offset] : `Column ${i + offset + 1}`;
    const text = cellText(cell);
    for (const a of anchorsOf(cell)) {
      record.links.push({ text: a.text, title: a.title, href: a.href, url: resolveIcUrl(a.href, options.baseUrl), column: label, key });
    }
    if (key === "_action") return;
    if (key === "poNoDate") {
      const { poNo, poDate } = splitPoNoDate(text);
      record.poNo = poNo;
      record.poDate = poDate;
      record.rawColumns[label || "#"] = normalizeIrepsValue(text);
      return;
    }
    const value = normalizeIrepsValue(text);
    record.rawColumns[label || "#"] = value;
    if (key) record[key] = value;
  });

  // Refresh the carried group values whenever this row supplied them itself.
  if (missing === 0) {
    group.values.callDate = record.callDate;
    group.values.tpiAgency = record.tpiAgency;
    group.values.poNo = record.poNo;
    group.values.poDate = record.poDate;
  }

  const icAnchor = record.links.find((l) => l.title.toLowerCase() === IC_LINK_TITLE);
  record.icPdfUrl = icAnchor ? icAnchor.url : null;
  if (!record.icPdfUrl) warnings.push(`IC row ${ordinal} (Call Id ${record.callId || "?"}): no "View/ Download IC PDF" link in the row.`);
  return { record, warnings };
}

/**
 * Parse the IC search result HTML and keep only the records that match the
 * expected PO number (IREPS already filters server-side by poNo, but the
 * portal has been known to echo unrelated rows on malformed searches, so
 * this is checked here too - "where practical" per the PO No. cell).
 *
 * @param {string} html
 * @param {string|null} [expectedPoNumber]
 * @param {{ DOMParser?: typeof DOMParser, baseUrl?: string, sourceUrl?: string|null, startIndex?: number }} [options]
 * @returns {ReturnType<typeof resultEnvelope> & { filteredCount: number }}
 */
export function parseIcSearchResults(html, expectedPoNumber = null, options = {}) {
  const Parser = options.DOMParser || globalThis.DOMParser;
  if (!Parser) throw new Error("DOMParser is not available in this context");
  const source = String(html || "");
  const doc = new Parser().parseFromString(source, "text/html");
  stripDangerousNodes(doc);

  const warnings = [];
  const records = [];
  let rowCount = 0;
  let filteredOut = 0;
  const startIndex = Number(options.startIndex) > 0 ? Number(options.startIndex) : 1;
  const wantPo = expectedPoNumber ? String(expectedPoNumber).trim() : null;

  const located = locateResultTable(doc, { matchHeader: matchIcHeader, requiredKeys: ["callId"], minColumns: 8 });
  if (located) {
    const { table, headerRow, keys, labels } = located;
    const group = { values: {} };
    let ordinal = startIndex;
    for (const row of Array.from(table.rows)) {
      if (row === headerRow || isHeaderRow(row, matchIcHeader)) continue;
      const cells = Array.from(row.cells);
      if (cells.length < 6) continue; // spacer / message rows
      rowCount++;
      const { record, warnings: rowWarnings } = parseIcRow(row, { labels, keys }, group, ordinal, { baseUrl: options.baseUrl });
      warnings.push(...rowWarnings);
      if (!record.callId) continue; // unreadable row, not counted as a record
      if (wantPo && record.poNo && record.poNo !== wantPo) {
        filteredOut++;
        continue;
      }
      record.id = `ic-${record.callId}`;
      records.push(record);
      ordinal++;
    }
  }

  return {
    ...resultEnvelope("IREPS Inspection Call List", source, {
      sourceUrl: options.sourceUrl,
      structure: located ? "table" : "none",
      headerLabels: located ? located.labels : [],
      rowCount,
      skippedCount: filteredOut,
      records,
      warnings
    }),
    filteredCount: filteredOut
  };
}
