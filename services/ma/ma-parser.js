/**
 * IREPS Modification Advice (MA) search-result parser.
 *
 * Input : raw server-rendered HTML from POST /epsn/searchPO.do with
 *         searchCriteria=MA (untrusted).
 * Output: one record per MA row, with the PO PDF link and the MA PDF link
 *         kept apart.
 *
 * Captured layout (recordsPerPage=2000 response, 1,838 rows):
 *
 *   <table id="table_id"><tr><td><table class="recordsTbl" id="dTbl2">
 *     <thead><tr class="trHdr"><th>Sr. No.</th><th>Dept / Rly. Unit</th><th>PO No.</th>
 *       <th>PO Date</th><th>PO_SR</th><th>MA No.</th><th>MA Date</th><th>Action(s)</th></tr></thead>
 *     <tbody>
 *       <tr class="trPoRow">
 *         <td>1</td><td>HQ/NR</td>
 *         <td><a href="/ireps/etender/pdfdocs/MMIS/PO/2026/03/<PO>.pdf" title="Click to View/Download PO">…</a></td>
 *         <td>20/07/2026</td><td>null</td><td>007327</td><td>18/09/2026</td>
 *         <td><a title="View/Download MA" href="/ireps/etender/pdfdocs/MMIS/PO/2026/03/<PO>_<MA>.pdf">…</a>
 *             <a title="Manage Your Purchase Order" href="#" …>   <a href="javascript:void(0);" …></td>
 *       </tr>
 *
 * The MA document is identified by the anchor title "View/Download MA" -
 * never "the first link in the row" (that is the PO). The PO document is
 * the anchor in the PO No. cell / title "Click to View/Download PO". Both
 * hrefs are used exactly as returned (resolved with URL()); the
 * /ireps/etender/pdfdocs/MMIS/PO/<year>/<month>/<PO>_<MA>.pdf pattern is
 * only used for a warning, never to build a path.
 *
 * Values are copied verbatim; the literal "null", "nil", "NA", "----" and
 * empty cells become null. Requires a DOMParser (offscreen document / tests).
 */

import { stripDangerousNodes } from "../../utils/sanitizer.js";
import { normalizeIrepsValue } from "../bill-parser.js";
import { parseIrepsDate } from "../ireps-api.js";
import { resolveIrepsUrl } from "../search-po/search-po-api.js";
import { normaliseHeaderLabel, cellText, anchorsOf, isHeaderRow, locateResultTable, resultEnvelope } from "../search-po/search-po-table.js";

export const MA_LINK_TITLES = Object.freeze({
  maPdf: "view/download ma",
  poPdf: "click to view/download po"
});

/** Typed fields of an MA record. */
export const MA_FIELDS = [
  { key: "serialNo", label: "Sr. No." },
  { key: "railwayUnit", label: "Dept / Rly. Unit" },
  { key: "poNo", label: "PO No." },
  { key: "poDate", label: "PO Date" },
  { key: "poSerial", label: "PO_SR" },
  { key: "maNo", label: "MA No." },
  { key: "maDate", label: "MA Date" }
];

const ACTION = "_action";

/** Header label (normalised) -> record key. */
export const MA_HEADER_MAP = Object.freeze({
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
  posr: "poSerial",
  poserial: "poSerial",
  posrno: "poSerial",
  mano: "maNo",
  manumber: "maNo",
  modificationadviceno: "maNo",
  madate: "maDate",
  modificationadvicedate: "maDate",
  action: ACTION,
  actions: ACTION
});

/** @returns {string|null} record key for a header label, null when unknown. */
export function matchMaHeader(label) {
  const key = normaliseHeaderLabel(label);
  return Object.prototype.hasOwnProperty.call(MA_HEADER_MAP, key) ? MA_HEADER_MAP[key] : null;
}

/** "18/09/2026" -> "2026-09-18" (used for date filtering and the download folder); null when not a date. */
export function maDateKey(text) {
  const d = parseIrepsDate(text);
  if (!d) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Empty record with every documented key present. */
export function createEmptyMaRecord() {
  const record = { index: 0, id: "" };
  for (const f of MA_FIELDS) record[f.key] = null;
  record.maDateKey = null;
  record.poPdfUrl = null;
  record.maPdfUrl = null;
  record.links = [];
  record.rawColumns = {};
  return record;
}

const MA_PATH_PATTERN = /\/pdfdocs\/MMIS\/PO\/\d{4}\/\d{2}\/[^/]+_[^/]+\.pdf$/i;

/**
 * Parse one MA row.
 * @param {Element} row
 * @param {{ labels: string[], keys: (string|null)[] }} header
 * @param {number} ordinal
 * @param {{ baseUrl?: string }} [options]
 * @returns {{ record: object, warnings: string[] }}
 */
export function parseMaRow(row, header, ordinal = 1, options = {}) {
  const record = createEmptyMaRecord();
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

  // MA document: identified by its anchor title, anywhere in the row.
  const maAnchor = record.links.find((l) => l.title.toLowerCase() === MA_LINK_TITLES.maPdf) || record.links.find((l) => l.title.toLowerCase().includes("download ma"));
  record.maPdfUrl = maAnchor ? maAnchor.url : null;
  // PO document: the anchor in the PO No. cell, or the "Click to View/Download PO" title.
  const poAnchor = record.links.find((l) => l.key === "poNo" && l.url) || record.links.find((l) => l.title.toLowerCase() === MA_LINK_TITLES.poPdf);
  record.poPdfUrl = poAnchor ? poAnchor.url : null;
  if (record.maPdfUrl && record.poPdfUrl && record.maPdfUrl === record.poPdfUrl) {
    warnings.push(`MA row ${ordinal}: the MA link and the PO link point to the same document.`);
  }
  if (record.maPdfUrl && !MA_PATH_PATTERN.test(new URL(record.maPdfUrl).pathname) && !/\/mock\//i.test(record.maPdfUrl)) {
    warnings.push(`MA row ${ordinal}: the MA link does not follow the usual /pdfdocs/MMIS/PO/<year>/<month>/<PO>_<MA>.pdf pattern.`);
  }
  record.maDateKey = maDateKey(record.maDate);
  return { record, warnings };
}

/**
 * Parse the MA search result HTML.
 *
 * @param {string} html
 * @param {{ DOMParser?: typeof DOMParser, baseUrl?: string, sourceUrl?: string|null, startIndex?: number }} [options]
 * @returns {ReturnType<typeof resultEnvelope>}
 */
export function parseMaSearchResults(html, options = {}) {
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

  const located = locateResultTable(doc, { matchHeader: matchMaHeader, requiredKeys: ["maNo"], minColumns: 4 });
  if (located) {
    const { table, headerRow, keys, labels } = located;
    let ordinal = startIndex;
    for (const row of Array.from(table.rows)) {
      if (row === headerRow || isHeaderRow(row, matchMaHeader)) continue;
      const cells = Array.from(row.cells);
      if (cells.length < 4) continue; // spacer / message rows
      rowCount++;
      const { record, warnings: rowWarnings } = parseMaRow(row, { labels, keys }, ordinal, { baseUrl: options.baseUrl });
      warnings.push(...rowWarnings);
      if (!record.maNo && !record.maPdfUrl) {
        skipped++;
        warnings.push(`MA row ${rowCount} has no MA number and was skipped.`);
        continue;
      }
      if (!record.maPdfUrl) warnings.push(`MA ${record.maNo} (PO ${record.poNo || "?"}): no "View/Download MA" link in the row.`);
      if (!record.maDateKey) warnings.push(`MA ${record.maNo}: MA Date "${record.maDate || ""}" is not a DD/MM/YYYY date.`);
      record.id = `ma-${ordinal}`;
      records.push(record);
      ordinal++;
    }
  }

  return resultEnvelope("IREPS MA Search", source, {
    sourceUrl: options.sourceUrl,
    structure: located ? "table" : "none",
    headerLabels: located ? located.labels : [],
    rowCount,
    skippedCount: skipped,
    records,
    warnings
  });
}
