/**
 * IREPS Purchase Order (PO) search-result parser.
 *
 * Input : raw server-rendered HTML from POST /epsn/searchPO.do with
 *         searchCriteria=PO, searchRange=3 (PO No.) - untrusted.
 * Output: one record per PO row (normally exactly one - PO No. is a unique
 *         key), with the PO PDF link.
 *
 * Captured layout (real portal, PO No. search for one PO):
 *
 *   <div id="divResults">
 *     <table id="table_id"><tr><td>
 *       <table class="recordsTbl" id="dTbl2">
 *         <thead><tr class="trHdr"><th>Sr. No.</th><th>Dept / Rly. Unit</th><th>PO No.</th>
 *           <th>PO Date</th><th>Stock/Non-Stock</th><th>PO Value (INR)</th><th>Action(s)</th></tr></thead>
 *         <tbody>
 *           <tr class="trPoRow">
 *             <td>1</td><td>HQ/CR</td>
 *             <td><a href="/ireps/etender/pdfdocs/MMIS/PO/2026/01/<PO>.pdf" title="Click to View/Download PO">…</a></td>
 *             <td>16/01/2026</td><td>S</td><td>830705.84</td>
 *             <td><a title="View/Download PO" href="/ireps/etender/pdfdocs/MMIS/PO/2026/01/<PO>.pdf">…</a>
 *                 <a title="Manage Your Purchase Order" href="#" …>   <a onclick="viewDocAckDetails(...)" …></td>
 *           </tr>
 *
 * The PO document is identified by the anchor title "Click to View/Download PO"
 * (PO No. cell) or "View/Download PO" (Actions cell) - never "the first link
 * in the row" and never "Manage Your Purchase Order" (that opens Dispatch
 * Particulars, not the PO PDF). Requires a DOMParser (offscreen document / tests).
 */

import { stripDangerousNodes } from "../../utils/sanitizer.js";
import { normalizeIrepsValue } from "../bill-parser.js";
import { resolveIrepsUrl } from "../search-po/search-po-api.js";
import { normaliseHeaderLabel, cellText, anchorsOf, isHeaderRow, locateResultTable, resultEnvelope } from "../search-po/search-po-table.js";

export const PO_LINK_TITLES = Object.freeze({
  poPdf: "view/download po",
  poPdfCell: "click to view/download po"
});

/** Typed fields of a PO record. */
export const PO_FIELDS = [
  { key: "serialNo", label: "Sr. No." },
  { key: "railwayUnit", label: "Dept / Rly. Unit" },
  { key: "poNo", label: "PO No." },
  { key: "poDate", label: "PO Date" },
  { key: "stockType", label: "Stock/Non-Stock" },
  { key: "poValue", label: "PO Value (INR)" }
];

const ACTION = "_action";

/** Header label (normalised) -> record key. */
export const PO_HEADER_MAP = Object.freeze({
  srno: "serialNo",
  sno: "serialNo",
  slno: "serialNo",
  "": "serialNo",
  deptrlyunit: "railwayUnit",
  deptrailwayunit: "railwayUnit",
  rlyunit: "railwayUnit",
  railwayunit: "railwayUnit",
  unit: "railwayUnit",
  rly: "railwayUnit",
  pono: "poNo",
  ponumber: "poNo",
  podate: "poDate",
  stocknonstock: "stockType",
  povalueinr: "poValue",
  povalue: "poValue",
  action: ACTION,
  actions: ACTION
});

/** @returns {string|null} record key for a header label, null when unknown. */
export function matchPoHeader(label) {
  const key = normaliseHeaderLabel(label);
  return Object.prototype.hasOwnProperty.call(PO_HEADER_MAP, key) ? PO_HEADER_MAP[key] : null;
}

/** Empty record with every documented key present. */
export function createEmptyPoRecord() {
  const record = { index: 0, id: "" };
  for (const f of PO_FIELDS) record[f.key] = null;
  record.poPdfUrl = null;
  record.links = [];
  record.rawColumns = {};
  return record;
}

/**
 * Parse one PO row.
 * @param {Element} row
 * @param {{ labels: string[], keys: (string|null)[] }} header
 * @param {number} ordinal
 * @param {{ baseUrl?: string }} [options]
 * @returns {{ record: object, warnings: string[] }}
 */
export function parsePoRow(row, header, ordinal = 1, options = {}) {
  const record = createEmptyPoRecord();
  record.index = ordinal;
  const warnings = [];
  const cells = Array.from(row.cells);

  cells.forEach((cell, i) => {
    const label = header.labels[i] !== undefined ? header.labels[i] : `Column ${i + 1}`;
    const key = header.keys[i] !== undefined ? header.keys[i] : null;
    const text = cellText(cell);
    const value = normalizeIrepsValue(text);
    for (const a of anchorsOf(cell)) {
      record.links.push({ text: a.text, title: a.title, href: a.href, url: resolveIrepsUrl(a.href, options.baseUrl), column: label, key });
    }
    if (key === ACTION) return;
    record.rawColumns[label || "#"] = value;
    if (key) record[key] = value;
  });

  // PO document: identified by its anchor title, anywhere in the row -
  // never "Manage Your Purchase Order" (Dispatch Particulars) or the
  // acknowledgement javascript: link.
  const poAnchor =
    record.links.find((l) => l.title.toLowerCase() === PO_LINK_TITLES.poPdf) ||
    record.links.find((l) => l.title.toLowerCase() === PO_LINK_TITLES.poPdfCell) ||
    record.links.find((l) => l.key === "poNo" && l.url);
  record.poPdfUrl = poAnchor ? poAnchor.url : null;
  if (!record.poPdfUrl) warnings.push(`PO row ${ordinal} (${record.poNo || "?"}): no "View/Download PO" link in the row.`);
  return { record, warnings };
}

/**
 * Parse the PO search result HTML.
 *
 * @param {string} html
 * @param {{ DOMParser?: typeof DOMParser, baseUrl?: string, sourceUrl?: string|null, startIndex?: number }} [options]
 * @returns {ReturnType<typeof resultEnvelope>}
 */
export function parsePoSearchResults(html, options = {}) {
  const Parser = options.DOMParser || globalThis.DOMParser;
  if (!Parser) throw new Error("DOMParser is not available in this context");
  const source = String(html || "");
  const doc = new Parser().parseFromString(source, "text/html");
  stripDangerousNodes(doc);

  const warnings = [];
  const records = [];
  let rowCount = 0;
  let skipped = 0;
  const startIndex = Number(options.startIndex) > 0 ? Number(options.startIndex) : 1;

  const located = locateResultTable(doc, { matchHeader: matchPoHeader, requiredKeys: ["poNo"], minColumns: 4 });
  if (located) {
    const { table, headerRow, keys, labels } = located;
    let ordinal = startIndex;
    for (const row of Array.from(table.rows)) {
      if (row === headerRow || isHeaderRow(row, matchPoHeader)) continue;
      const cells = Array.from(row.cells);
      if (cells.length < 4) continue; // spacer / message rows
      rowCount++;
      const { record, warnings: rowWarnings } = parsePoRow(row, { labels, keys }, ordinal, { baseUrl: options.baseUrl });
      warnings.push(...rowWarnings);
      if (!record.poNo) {
        skipped++;
        warnings.push(`PO row ${rowCount} has no PO number and was skipped.`);
        continue;
      }
      record.id = `po-${ordinal}`;
      records.push(record);
      ordinal++;
    }
  }

  return resultEnvelope("IREPS PO Search", source, {
    sourceUrl: options.sourceUrl,
    structure: located ? "table" : "none",
    headerLabels: located ? located.labels : [],
    rowCount,
    skippedCount: skipped,
    records,
    warnings
  });
}
