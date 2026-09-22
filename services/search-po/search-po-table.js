/**
 * Shared helpers for the result tables of the IREPS PO Search page.
 *
 * Every document type (CRN, R-NOTE, ...) renders its results the same way:
 *
 *   <div id="divResults">
 *     <table id="table_id"><tr><td>
 *       <table class="recordsTbl" id="dTbl">
 *         <thead><tr><th>#</th><th>PO No.</th> ... </tr></thead>
 *         <tbody><tr><td>1</td> ... </tr></tbody>
 *       </table>
 *     </td></tr></table>
 *     ... optional server-side page links:
 *     onclick="postRequest('/epsn/searchPO.do?rly=-1&...&pageNo=2&...&count=1720&recordsPerPage=20');"
 *
 * The column set differs per document type, so the type-specific parsers
 * (services/crn/crn-parser.js, services/rnote/rnote-parser.js) own the
 * header maps; this module owns the generic mechanics: locating the table,
 * reading cell text (with <br> -> newline), collecting anchors, and the
 * regex-based pagination / message extraction that also runs without a DOM.
 */

import { normaliseText } from "../../utils/sanitizer.js";
import { decodeEntities } from "../ireps-form.js";

/** "CRN Type<br>Claim No." -> "crntypeclaimno" */
export function normaliseHeaderLabel(text) {
  return normaliseText(text)
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

/** Text of a cell with <br> and block boundaries turned into newlines. */
export function cellText(cell) {
  const parts = [];
  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) parts.push(child.nodeValue);
      else if (child.nodeType === 1) {
        const tag = child.tagName;
        if (tag === "BR") parts.push("\n");
        else if (tag === "TABLE" || tag === "TR" || tag === "DIV" || tag === "P" || tag === "LI") {
          parts.push("\n");
          walk(child);
          parts.push("\n");
        } else walk(child);
      }
    }
  };
  walk(cell);
  return normaliseText(parts.join(""));
}

/**
 * Every anchor of a cell: { href (as written), text, title }.
 * "#" / javascript: hrefs are kept so callers can tell "no document" from
 * "document link"; use resolveIrepsUrl() to turn href into an absolute URL.
 */
export function anchorsOf(cell) {
  return Array.from(cell.querySelectorAll("a[href]")).map((a) => ({
    href: (a.getAttribute("href") || "").trim(),
    text: normaliseText(a.textContent),
    title: normaliseText(a.getAttribute("title") || "")
  }));
}

/**
 * Header row detection: all cells are <th>, or most cells match the
 * type-specific header matcher.
 * @param {Element} row
 * @param {(label: string) => string|null} matchHeader
 */
export function isHeaderRow(row, matchHeader) {
  const cells = Array.from(row.cells || []);
  if (cells.length === 0) return false;
  if (cells.every((c) => c.tagName === "TH")) return true;
  let matched = 0;
  for (const c of cells) if (matchHeader(c.textContent) !== null) matched++;
  return matched >= Math.max(3, Math.ceil(cells.length * 0.6));
}

/**
 * Find the result table of a document type.
 *
 * @param {Document} doc
 * @param {{ matchHeader: (label: string) => string|null, requiredKeys?: string[], minColumns?: number }} options
 *        matchHeader maps a header label to a record key (or null); the
 *        table must contain every key in requiredKeys (any of them when the
 *        array is prefixed with "any:").
 * @returns {{ table: Element, headerRow: Element, labels: string[], keys: (string|null)[] }|null}
 */
export function locateResultTable(doc, options) {
  const matchHeader = options.matchHeader;
  const required = Array.isArray(options.requiredKeys) ? options.requiredKeys : [];
  const minColumns = options.minColumns || 3;
  const candidates = [];
  for (const table of Array.from(doc.querySelectorAll("table"))) {
    const rows = Array.from(table.rows || []);
    const headerRow = rows.find((r) => Array.from(r.cells).length >= minColumns && isHeaderRow(r, matchHeader));
    if (!headerRow) continue;
    const labels = Array.from(headerRow.cells).map((c) => c.textContent);
    const keys = labels.map(matchHeader);
    if (required.length && !required.every((k) => keys.includes(k))) continue;
    const dataRows = rows.filter((r) => r !== headerRow && Array.from(r.cells).length >= minColumns).length;
    const score = keys.filter((k) => k && !k.startsWith("_")).length + (/^dTbl/.test(table.id || "") ? 100 : 0) + (table.closest && table.closest("#divResults") ? 10 : 0) + Math.min(dataRows, 5);
    candidates.push({ table, headerRow, labels: labels.map((l) => normaliseText(l)), keys, score });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return { table: best.table, headerRow: best.headerRow, labels: best.labels, keys: best.keys };
}

/**
 * Server-side pagination links rendered by IREPS:
 *   onclick="postRequest('/epsn/searchPO.do?rly=-1&dateFrom=&dateTo=&pageNo=2&searchRange=1&poNo=&count=1720&recordsPerPage=20');"
 * For the captured CRN search IREPS returned every row in one response and
 * no such links (the table is paged client-side by DataTables); the MA
 * search in the same capture did return them, so both cases are handled.
 *
 * @param {string} html
 * @returns {{ serverPaginated: boolean, pageNumbers: number[], maxPage: number, totalCount: number|null,
 *            reportedTotal: number|null, links: Record<number, { pageNo: number, params: [string, string][] }> }}
 */
export function extractSearchPoPagination(html) {
  const source = String(html || "");
  const links = {};
  const re = /postRequest\(\s*['"]\/epsn\/searchPO\.do\?([^'"]*)['"]/g;
  let m;
  let totalCount = null;
  while ((m = re.exec(source))) {
    const params = [];
    for (const pair of decodeEntities(m[1]).split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
      const value = eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
      params.push([key, value]);
    }
    const pageNo = Number((params.find(([k]) => k === "pageNo") || [])[1]);
    const count = Number((params.find(([k]) => k === "count") || [])[1]);
    if (Number.isFinite(count) && count > 0) totalCount = count;
    if (Number.isInteger(pageNo) && pageNo > 0 && !links[pageNo]) links[pageNo] = { pageNo, params };
  }
  const pageNumbers = Object.keys(links).map(Number).sort((a, b) => a - b);
  const totalMatch = /Total\s+(\d+)\s+result\(s\)/i.exec(source);
  return {
    serverPaginated: pageNumbers.length > 0,
    pageNumbers,
    maxPage: pageNumbers.length ? pageNumbers[pageNumbers.length - 1] : 1,
    totalCount,
    reportedTotal: totalMatch ? Number(totalMatch[1]) : null,
    links
  };
}

/** Text of <span class="errorStyle">...</span> when IREPS printed a message there. */
export function extractSearchPoPageMessage(html) {
  const m = /<span[^>]*class=["']errorStyle["'][^>]*>([\s\S]*?)<\/span>/i.exec(String(html || ""));
  if (!m) return null;
  const text = normaliseText(decodeEntities(m[1].replace(/<[^>]+>/g, " ")));
  return text || null;
}

/**
 * Common result envelope for the type-specific parsers.
 * @param {string} title
 * @param {string} source
 * @param {object} fields
 */
export function resultEnvelope(title, source, fields) {
  return {
    title,
    generatedAt: new Date().toISOString(),
    source: "IREPS",
    sourceUrl: fields.sourceUrl || null,
    structure: fields.structure,
    headerLabels: fields.headerLabels || [],
    rowCount: fields.rowCount || 0,
    recordCount: fields.records ? fields.records.length : 0,
    skippedCount: fields.skippedCount || 0,
    records: fields.records || [],
    warnings: fields.warnings || [],
    pagination: extractSearchPoPagination(source),
    pageMessage: extractSearchPoPageMessage(source)
  };
}
