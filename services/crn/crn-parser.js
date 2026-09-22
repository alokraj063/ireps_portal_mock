/**
 * IREPS CRN (Consignment Receipt Note) search-result parser.
 *
 * Input : raw server-rendered HTML from POST /epsn/searchPO.do with
 *         searchCriteria=CRN (untrusted).
 * Output: structured CRN records, one per result row, plus pagination info.
 *
 * Captured layout (see services/search-po/search-po-table.js for the shared
 * mechanics):
 *
 *   <thead><tr><th>#</th><th>PO No.</th><th>PO Date</th><th>Challan No.</th>
 *     <th>Challan Date</th><th>CRN Type<br>Claim No.</th><th>Rly</th><th>PO Sr</th>
 *     <th>CRN No.</th><th>CRN date</th><th>Approval Date</th><th>CRN Qty</th>
 *     <th>Bill Claim</th><th>Bill Reg No.</th><th>Bill Reg/Sign Date</th>
 *     <th>Invoice No.</th><th>Invoice Date</th><th>CO6 No.</th><th>CO6 Date</th>
 *     <th>CO7 No.</th><th>CO7 Date</th><th>Claim Amount</th><th>Passed Amount</th>
 *     <th>Payment / Return Date</th><th>Return Reason</th><th>Action</th></tr></thead>
 *   <tbody>
 *     <tr><td>1</td><td>PO</td> ... <td><span>Warranty Replacement</span><br>
 *         <a href='/ireps/etender/ct/MMIS/CRC/WAR/.../CLAIM.pdf'>CLAIM</a></td> ...
 *         <td><a href='/ireps/etender/ct/MMIS/CONS/.../CRN_2.pdf'>CRN</a></td> ... </tr>
 *
 * Columns are mapped by header label (in any order); the captured column
 * order is only a fallback when a header cannot be recognised. Values are
 * copied verbatim; nothing is calculated or inferred. Empty cells become
 * null. Links are extracted separately:
 *
 *   crnPdfUrl    from the CRN No. cell     href contains /MMIS/CONS/
 *   claimPdfUrl  from the CRN Type cell    href contains /MMIS/CRC/    (warranty claim)
 *   billPdfUrl   from the Bill Reg No. cell href contains /sbill/      (supplier bill)
 *
 * Requires a DOMParser (offscreen document / tests).
 */

import { stripDangerousNodes } from "../../utils/sanitizer.js";
import { normalizeIrepsValue } from "../bill-parser.js";
import { resolveIrepsUrl } from "../search-po/search-po-api.js";
import {
  normaliseHeaderLabel,
  cellText,
  anchorsOf,
  isHeaderRow,
  locateResultTable,
  extractSearchPoPagination,
  extractSearchPoPageMessage,
  resultEnvelope
} from "../search-po/search-po-table.js";

/** Path markers that identify the PDF links inside the CRN result rows. */
export const CRN_LINK_MARKERS = Object.freeze({
  crnPdf: "/MMIS/CONS/",
  claimPdf: "/MMIS/CRC/",
  billPdf: "/sbill/"
});

/** Output order for records / UI. */
export const CRN_FIELDS = [
  { key: "poNo", label: "PO No." },
  { key: "poDate", label: "PO Date" },
  { key: "challanNo", label: "Challan No." },
  { key: "challanDate", label: "Challan Date" },
  { key: "crnType", label: "CRN Type" },
  { key: "claimNo", label: "Claim No." },
  { key: "railway", label: "Rly" },
  { key: "poSerial", label: "PO Sr" },
  { key: "crnNo", label: "CRN No." },
  { key: "crnDate", label: "CRN Date" },
  { key: "approvalDate", label: "Approval Date" },
  { key: "crnQty", label: "CRN Qty" },
  { key: "billClaimStatus", label: "Bill Claim" },
  { key: "billRegNo", label: "Bill Reg No." },
  { key: "billRegSignDate", label: "Bill Reg/Sign Date" },
  { key: "invoiceNo", label: "Invoice No." },
  { key: "invoiceDate", label: "Invoice Date" },
  { key: "co6No", label: "CO6 No." },
  { key: "co6Date", label: "CO6 Date" },
  { key: "co7No", label: "CO7 No." },
  { key: "co7Date", label: "CO7 Date" },
  { key: "claimAmount", label: "Claim Amount" },
  { key: "passedAmount", label: "Passed Amount" },
  { key: "paymentOrReturnDate", label: "Payment / Return Date" },
  { key: "returnReason", label: "Return Reason" }
];

/** Link fields (absolute URLs or null). */
export const CRN_LINK_FIELDS = ["crnPdfUrl", "claimPdfUrl", "billPdfUrl"];

/** Pseudo keys for columns that carry no business data. */
const SERIAL = "_serial";
const ACTION = "_action";

/** Header label (normalised to lower-case alphanumerics) -> record key. */
export const CRN_HEADER_MAP = Object.freeze({
  "": SERIAL,
  sno: SERIAL,
  slno: SERIAL,
  srno: SERIAL,
  pono: "poNo",
  ponumber: "poNo",
  podate: "poDate",
  challanno: "challanNo",
  challannumber: "challanNo",
  challandate: "challanDate",
  crntypeclaimno: "crnType",
  crntype: "crnType",
  claimno: "claimNo",
  rly: "railway",
  railway: "railway",
  railwayzone: "railway",
  posr: "poSerial",
  poserial: "poSerial",
  posrno: "poSerial",
  crnno: "crnNo",
  crnnumber: "crnNo",
  crndate: "crnDate",
  approvaldate: "approvalDate",
  crnqty: "crnQty",
  crnquantity: "crnQty",
  billclaim: "billClaimStatus",
  billclaimstatus: "billClaimStatus",
  billregno: "billRegNo",
  billregsigndate: "billRegSignDate",
  billregdate: "billRegSignDate",
  invoiceno: "invoiceNo",
  invoicedate: "invoiceDate",
  co6no: "co6No",
  co6date: "co6Date",
  co7no: "co7No",
  co7date: "co7Date",
  claimamount: "claimAmount",
  claimamt: "claimAmount",
  passedamount: "passedAmount",
  passedamt: "passedAmount",
  paymentreturndate: "paymentOrReturnDate",
  paymentdate: "paymentOrReturnDate",
  returndate: "paymentOrReturnDate",
  returnreason: "returnReason",
  action: ACTION,
  actions: ACTION
});

/** Captured column order, used only as a fallback for unrecognised headers. */
export const CRN_DEFAULT_COLUMNS = Object.freeze([
  SERIAL, "poNo", "poDate", "challanNo", "challanDate", "crnType", "railway", "poSerial", "crnNo", "crnDate",
  "approvalDate", "crnQty", "billClaimStatus", "billRegNo", "billRegSignDate", "invoiceNo", "invoiceDate",
  "co6No", "co6Date", "co7No", "co7Date", "claimAmount", "passedAmount", "paymentOrReturnDate", "returnReason", ACTION
]);

/** Kept for callers/tests that used the CRN-named helpers. */
export const normaliseCrnLabel = normaliseHeaderLabel;
export const extractCrnPagination = extractSearchPoPagination;
export const extractCrnPageMessage = extractSearchPoPageMessage;

/** @returns {string|null} record key for a header label, null when unknown. */
export function matchCrnHeader(label) {
  const key = normaliseHeaderLabel(label);
  return Object.prototype.hasOwnProperty.call(CRN_HEADER_MAP, key) ? CRN_HEADER_MAP[key] : null;
}

/** Empty record with every documented key present. */
export function createEmptyCrnRecord() {
  const record = { index: 0, id: "" };
  for (const f of CRN_FIELDS) record[f.key] = null;
  for (const k of CRN_LINK_FIELDS) record[k] = null;
  record.extra = {};
  return record;
}

function findLink(anchors, marker, baseUrl) {
  const hit = anchors.find((a) => a.href.includes(marker));
  return hit ? resolveIrepsUrl(hit.href, baseUrl) : null;
}

/**
 * Parse one result row into a record.
 * @param {Element} row
 * @param {(string|null)[]} columns   key per cell index
 * @param {number} ordinal            1-based record index
 * @param {{ baseUrl?: string }} [options]
 * @returns {{ record: object, warnings: string[] }}
 */
export function parseCrnRow(row, columns, ordinal = 1, options = {}) {
  const record = createEmptyCrnRecord();
  record.index = ordinal;
  const warnings = [];
  const cells = Array.from(row.cells);

  cells.forEach((cell, i) => {
    const key = columns[i] ?? (i < CRN_DEFAULT_COLUMNS.length ? CRN_DEFAULT_COLUMNS[i] : `extra:column${i + 1}`);
    if (key === SERIAL || key === ACTION) return;
    const text = cellText(cell);
    const anchors = anchorsOf(cell);

    if (key === "crnType") {
      // "<span>Warranty Replacement</span><br><a href='/MMIS/CRC/WAR/...'>CLAIM</a>"
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      const claimAnchor = anchors.find((a) => a.href.includes(CRN_LINK_MARKERS.claimPdf)) || anchors.find((a) => a.href && a.href !== "#");
      record.crnType = normalizeIrepsValue(lines[0] || "");
      const claimText = claimAnchor && claimAnchor.text ? claimAnchor.text : lines.length > 1 ? lines.slice(1).join(" ") : "";
      record.claimNo = normalizeIrepsValue(claimText);
      record.claimPdfUrl = claimAnchor ? resolveIrepsUrl(claimAnchor.href, options.baseUrl) : null;
      return;
    }
    if (key === "crnNo") {
      record.crnNo = normalizeIrepsValue(text);
      record.crnPdfUrl = findLink(anchors, CRN_LINK_MARKERS.crnPdf, options.baseUrl);
      if (!record.crnPdfUrl && anchors.some((a) => a.href && a.href !== "#")) {
        warnings.push(`CRN row ${ordinal}: the CRN No. link is not a CRN PDF (${CRN_LINK_MARKERS.crnPdf} missing).`);
      }
      return;
    }
    if (key === "billRegNo") {
      record.billRegNo = normalizeIrepsValue(text);
      record.billPdfUrl = findLink(anchors, CRN_LINK_MARKERS.billPdf, options.baseUrl) || null;
      if (!record.billPdfUrl) {
        const real = anchors.find((a) => a.href && a.href !== "#" && /\.pdf(\?|$)/i.test(a.href));
        if (real) record.billPdfUrl = resolveIrepsUrl(real.href, options.baseUrl);
      }
      return;
    }
    if (key.startsWith("extra:")) {
      const value = normalizeIrepsValue(text);
      if (value !== null) record.extra[key.slice(6)] = value;
      return;
    }
    record[key] = normalizeIrepsValue(text);
  });

  return { record, warnings };
}

/**
 * @typedef {Object} CrnSearchResults
 * @property {"IREPS CRN Search"} title
 * @property {"table"|"none"} structure
 * @property {string[]} headerLabels
 * @property {number} rowCount
 * @property {number} recordCount
 * @property {number} skippedCount
 * @property {object[]} records
 * @property {string[]} warnings
 * @property {ReturnType<typeof extractSearchPoPagination>} pagination
 * @property {string|null} pageMessage
 */

/**
 * Parse the CRN search result HTML.
 *
 * @param {string} html
 * @param {{ DOMParser?: typeof DOMParser, baseUrl?: string, sourceUrl?: string|null, startIndex?: number }} [options]
 * @returns {CrnSearchResults}
 */
export function parseCrnSearchResults(html, options = {}) {
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

  const located = locateResultTable(doc, { matchHeader: matchCrnHeader, requiredKeys: ["crnNo"], minColumns: 5 });
  if (located) {
    const { table, headerRow, keys, labels } = located;
    const columns = keys.map((key, i) => {
      if (key !== null) return key;
      // Unknown header: fall back to the captured position when the shape matches.
      if (keys.length === CRN_DEFAULT_COLUMNS.length) return CRN_DEFAULT_COLUMNS[i];
      return `extra:${labels[i] || `column${i + 1}`}`;
    });
    let ordinal = startIndex;
    for (const row of Array.from(table.rows)) {
      if (row === headerRow || isHeaderRow(row, matchCrnHeader)) continue;
      const cells = Array.from(row.cells);
      if (cells.length < 5) continue; // spacer / message rows
      rowCount++;
      const { record, warnings: rowWarnings } = parseCrnRow(row, columns, ordinal, { baseUrl: options.baseUrl });
      warnings.push(...rowWarnings);
      if (!record.crnNo && !record.crnPdfUrl) {
        skipped++;
        warnings.push(`CRN row ${rowCount} has no CRN number and was skipped.`);
        continue;
      }
      if (!record.crnPdfUrl) warnings.push(`CRN ${record.crnNo}: no PDF link in the CRN No. column.`);
      record.id = `crn-${ordinal}`;
      records.push(record);
      ordinal++;
    }
  }

  return resultEnvelope("IREPS CRN Search", source, {
    sourceUrl: options.sourceUrl,
    structure: located ? "table" : "none",
    headerLabels: located ? located.labels : [],
    rowCount,
    skippedCount: skipped,
    records,
    warnings
  });
}
