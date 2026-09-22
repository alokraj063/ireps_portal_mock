/**
 * IREPS R-NOTE (Receipt Note) search-result parser.
 *
 * Input : raw server-rendered HTML from POST /epsn/searchPO.do with
 *         searchCriteria=RNOTE (untrusted).
 * Output: one record per result row, plus pagination info.
 *
 * What is confirmed from the captured PO Search page: R-NOTE is
 * <option value="RNOTE">Receipt Note (R-NOTE)</option> of the same
 * searchPOForm, with the same railway / PO / date controls. What is NOT
 * captured yet is an R-NOTE result page, so this parser makes no assumption
 * about the column set or the document link path:
 *
 *   - the result table is located by its header row (a "R-Note No." style
 *     column must exist), never by position;
 *   - every column is kept verbatim in `rawColumns` (header label -> text)
 *     so that nothing is lost while the real layout is being confirmed;
 *   - well-known labels are additionally mapped to typed fields (poNo,
 *     rnoteNo, rnoteDate, ...);
 *   - every anchor of a row is kept in `links` (text, title, absolute URL,
 *     column) and the R-NOTE document link is chosen from them by header
 *     context and anchor text/title - not by the CRN's /MMIS/CONS/ rule.
 *
 * Requires a DOMParser (offscreen document / tests).
 */

import { stripDangerousNodes } from "../../utils/sanitizer.js";
import { normalizeIrepsValue } from "../bill-parser.js";
import { resolveIrepsUrl } from "../search-po/search-po-api.js";
import { normaliseHeaderLabel, cellText, anchorsOf, isHeaderRow, locateResultTable, resultEnvelope } from "../search-po/search-po-table.js";

/** Typed fields (mapped when the header is recognised); everything else stays in rawColumns. */
export const RNOTE_FIELDS = [
  { key: "poNo", label: "PO No." },
  { key: "poDate", label: "PO Date" },
  { key: "railway", label: "Rly" },
  { key: "poSerial", label: "PO Sr" },
  { key: "rnoteNo", label: "R-Note No." },
  { key: "rnoteDate", label: "R-Note Date" },
  { key: "challanNo", label: "Challan No." },
  { key: "challanDate", label: "Challan Date" },
  { key: "invoiceNo", label: "Invoice No." },
  { key: "invoiceDate", label: "Invoice Date" },
  { key: "quantity", label: "Quantity" },
  { key: "status", label: "Status" }
];

const SERIAL = "_serial";
const ACTION = "_action";

/** Header label (normalised) -> record key. Unknown labels stay raw-only. */
export const RNOTE_HEADER_MAP = Object.freeze({
  "": SERIAL,
  sno: SERIAL,
  slno: SERIAL,
  srno: SERIAL,
  pono: "poNo",
  ponumber: "poNo",
  podate: "poDate",
  rly: "railway",
  railway: "railway",
  railwayzone: "railway",
  posr: "poSerial",
  poserial: "poSerial",
  posrno: "poSerial",
  rnoteno: "rnoteNo",
  rnotenumber: "rnoteNo",
  receiptnoteno: "rnoteNo",
  receiptnotenumber: "rnoteNo",
  rnno: "rnoteNo",
  rnotedate: "rnoteDate",
  receiptnotedate: "rnoteDate",
  rndate: "rnoteDate",
  challanno: "challanNo",
  challannumber: "challanNo",
  challandate: "challanDate",
  invoiceno: "invoiceNo",
  invoicedate: "invoiceDate",
  qty: "quantity",
  quantity: "quantity",
  qtyreceived: "quantity",
  quantityreceived: "quantity",
  receivedqty: "quantity",
  acceptedqty: "quantity",
  status: "status",
  rnotestatus: "status",
  action: ACTION,
  actions: ACTION
});

/** Anchor texts/titles that are NOT the R-NOTE document (portal navigation, related documents). */
const UNRELATED_LINK = /manage|purchase order|bill|acknowledg|challan|invoice|inspection|claim|view po|dispatch/i;

/** @returns {string|null} record key for a header label, null when unknown. */
export function matchRnoteHeader(label) {
  const key = normaliseHeaderLabel(label);
  if (Object.prototype.hasOwnProperty.call(RNOTE_HEADER_MAP, key)) return RNOTE_HEADER_MAP[key];
  // "R-Note No. / Date" style labels that contain the word but were not listed.
  if (/r?note/.test(key) && /no|number/.test(key) && !/date/.test(key)) return "rnoteNo";
  if (/r?note/.test(key) && /date/.test(key)) return "rnoteDate";
  return null;
}

/** Empty record with every documented key present. */
export function createEmptyRnoteRecord() {
  const record = { index: 0, id: "" };
  for (const f of RNOTE_FIELDS) record[f.key] = null;
  record.documentUrl = null;
  record.documentLink = null;
  record.links = [];
  record.rawColumns = {};
  return record;
}

/**
 * Pick the R-NOTE document link among a row's anchors:
 *   1. an anchor inside the R-Note No. column,
 *   2. an anchor whose text/title mentions "R-Note" / "Receipt Note",
 *   3. otherwise none (never a Manage PO / bill / acknowledgement link).
 * @param {{ text: string, title: string, href: string, url: string|null, column: string, key: string|null }[]} links
 */
export function pickRnoteDocumentLink(links) {
  const usable = links.filter((l) => l.url);
  const inNumberColumn = usable.find((l) => l.key === "rnoteNo");
  if (inNumberColumn) return inNumberColumn;
  const byText = usable.find((l) => /r-?\s?note|receipt\s?note/i.test(`${l.text} ${l.title}`) && !UNRELATED_LINK.test(`${l.text} ${l.title}`));
  return byText || null;
}

/**
 * Parse one result row into a record.
 * @param {Element} row
 * @param {{ labels: string[], keys: (string|null)[] }} header
 * @param {number} ordinal
 * @param {{ baseUrl?: string }} [options]
 * @returns {{ record: object, warnings: string[] }}
 */
export function parseRnoteRow(row, header, ordinal = 1, options = {}) {
  const record = createEmptyRnoteRecord();
  record.index = ordinal;
  const warnings = [];
  const cells = Array.from(row.cells);

  cells.forEach((cell, i) => {
    const label = header.labels[i] !== undefined ? header.labels[i] : `Column ${i + 1}`;
    const key = header.keys[i] !== undefined ? header.keys[i] : null;
    const text = cellText(cell);
    const value = normalizeIrepsValue(text);
    for (const a of anchorsOf(cell)) {
      const url = resolveIrepsUrl(a.href, options.baseUrl);
      record.links.push({ text: a.text, title: a.title, href: a.href, url, column: label, key });
    }
    if (key === ACTION) return;
    const rawLabel = label || "#";
    record.rawColumns[rawLabel in record.rawColumns ? `${rawLabel} (${i + 1})` : rawLabel] = value;
    if (key && key !== SERIAL) record[key] = value;
  });

  const document = pickRnoteDocumentLink(record.links);
  record.documentLink = document ? { text: document.text, title: document.title, url: document.url, column: document.column } : null;
  record.documentUrl = document ? document.url : null;
  return { record, warnings };
}

/**
 * Parse the R-NOTE search result HTML.
 *
 * @param {string} html
 * @param {{ DOMParser?: typeof DOMParser, baseUrl?: string, sourceUrl?: string|null, startIndex?: number }} [options]
 * @returns {ReturnType<typeof resultEnvelope>}
 */
export function parseRnoteSearchResults(html, options = {}) {
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

  const located = locateResultTable(doc, { matchHeader: matchRnoteHeader, requiredKeys: ["rnoteNo"], minColumns: 3 });
  if (located) {
    const { table, headerRow, keys, labels } = located;
    let ordinal = startIndex;
    for (const row of Array.from(table.rows)) {
      if (row === headerRow || isHeaderRow(row, matchRnoteHeader)) continue;
      const cells = Array.from(row.cells);
      if (cells.length < 3) continue; // spacer / message rows
      rowCount++;
      const { record, warnings: rowWarnings } = parseRnoteRow(row, { labels, keys }, ordinal, { baseUrl: options.baseUrl });
      warnings.push(...rowWarnings);
      const hasData = Object.values(record.rawColumns).some((v) => v !== null);
      if (!record.rnoteNo && !hasData) {
        skipped++;
        warnings.push(`R-NOTE row ${rowCount} is empty and was skipped.`);
        continue;
      }
      if (!record.rnoteNo) warnings.push(`R-NOTE row ${rowCount} has no R-Note number.`);
      if (!record.documentUrl) warnings.push(`R-NOTE ${record.rnoteNo || `row ${rowCount}`}: no document link found in the row.`);
      record.id = `rnote-${ordinal}`;
      records.push(record);
      ordinal++;
    }
  }

  return resultEnvelope("IREPS R-NOTE Search", source, {
    sourceUrl: options.sourceUrl,
    structure: located ? "table" : "none",
    headerLabels: located ? located.labels : [],
    rowCount,
    skippedCount: skipped,
    records,
    warnings
  });
}
