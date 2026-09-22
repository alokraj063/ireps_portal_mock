/**
 * Dependency-free Excel (.xlsx, Office Open XML) and CSV writers.
 *
 * Every cell is written as an inline string so values stay exactly as IREPS
 * printed them (no number conversion that would turn a 14-digit PO number
 * into 7.02E+13, no date guessing). The first row of each sheet is a bold,
 * frozen header row with an auto-filter.
 *
 *   const bytes = buildWorkbook({
 *     sheets: [{ name: "CRN", headers: ["PO No.", ...], rows: [["...", ...], ...] }]
 *   });
 *   // -> Uint8Array of a .xlsx file (open in Excel / LibreOffice / Numbers)
 */

import { buildZip } from "./zip-writer.js";

export const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const CSV_MIME_TYPE = "text/csv";

/** Excel's hard limits. */
const MAX_ROWS = 1048576;
const MAX_COLUMNS = 16384;
const MAX_CELL_CHARS = 32767;
const MAX_SHEET_NAME = 31;

/** Control characters that XML 1.0 forbids (tab, LF and CR are allowed). */
const ILLEGAL_XML_CHARS = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(8) + String.fromCharCode(11) + String.fromCharCode(12) + String.fromCharCode(14) + "-" + String.fromCharCode(31) + "]", "g");

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(ILLEGAL_XML_CHARS, "");
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA" */
export function columnLetter(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function cellValue(value) {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : String(value);
  if (text.length > MAX_CELL_CHARS) text = text.slice(0, MAX_CELL_CHARS);
  return text;
}

function cellXml(ref, value, styleId) {
  const text = cellValue(value);
  const s = styleId ? ` s="${styleId}"` : "";
  if (text === "") return styleId ? `<c r="${ref}"${s}/>` : "";
  const space = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : "";
  return `<c r="${ref}" t="inlineStr"${s}><is><t${space}>${xmlEscape(text)}</t></is></c>`;
}

function sanitiseSheetName(name, index) {
  const cleaned = String(name || `Sheet${index + 1}`).replace(/[\\/?*[\]:]/g, " ").trim().slice(0, MAX_SHEET_NAME);
  return cleaned || `Sheet${index + 1}`;
}

/**
 * @typedef {Object} SheetSpec
 * @property {string} name
 * @property {string[]} headers
 * @property {(string|number|null|undefined)[][]} rows
 * @property {number[]} [columnWidths]   in characters; derived from content when omitted
 * @property {boolean} [autoFilter]      default true when headers exist
 * @property {boolean} [freezeHeader]    default true when headers exist
 */

function sheetXml(spec) {
  const headers = Array.isArray(spec.headers) ? spec.headers : [];
  const rows = Array.isArray(spec.rows) ? spec.rows : [];
  const columnCount = Math.min(MAX_COLUMNS, Math.max(headers.length, ...rows.map((r) => (Array.isArray(r) ? r.length : 0)), 1));
  const totalRows = (headers.length ? 1 : 0) + rows.length;
  if (totalRows > MAX_ROWS) throw new Error(`Sheet "${spec.name}" exceeds ${MAX_ROWS} rows`);

  const widths = [];
  for (let c = 0; c < columnCount; c++) {
    let w = spec.columnWidths && spec.columnWidths[c] ? spec.columnWidths[c] : 0;
    if (!w) {
      let longest = headers[c] ? String(headers[c]).length : 0;
      for (let r = 0; r < Math.min(rows.length, 500); r++) {
        const v = rows[r] && rows[r][c];
        if (v !== null && v !== undefined) longest = Math.max(longest, ...String(v).split("\n").map((l) => l.length));
      }
      w = Math.min(60, Math.max(8, longest + 2));
    }
    widths.push(w);
  }

  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
  const lastRef = `${columnLetter(columnCount - 1)}${Math.max(totalRows, 1)}`;
  xml += `<dimension ref="A1:${lastRef}"/>`;
  const freeze = headers.length && spec.freezeHeader !== false;
  xml += '<sheetViews><sheetView workbookViewId="0">';
  if (freeze) xml += '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>';
  xml += "</sheetView></sheetViews>";
  xml += '<sheetFormatPr defaultRowHeight="15"/>';
  xml += "<cols>" + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("") + "</cols>";
  xml += "<sheetData>";
  let rowNo = 1;
  if (headers.length) {
    xml += `<row r="${rowNo}">` + headers.map((h, c) => cellXml(`${columnLetter(c)}${rowNo}`, h, 1)).join("") + "</row>";
    rowNo++;
  }
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : [];
    let rowXml = "";
    for (let c = 0; c < Math.min(cells.length, columnCount); c++) {
      const v = cells[c];
      const wrap = typeof v === "string" && v.includes("\n");
      rowXml += cellXml(`${columnLetter(c)}${rowNo}`, v, wrap ? 2 : 0);
    }
    xml += `<row r="${rowNo}">${rowXml}</row>`;
    rowNo++;
  }
  xml += "</sheetData>";
  if (headers.length && spec.autoFilter !== false && rows.length) xml += `<autoFilter ref="A1:${columnLetter(columnCount - 1)}${totalRows}"/>`;
  xml += '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>';
  xml += "</worksheet>";
  return xml;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDCEAF7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * Build an .xlsx workbook.
 * @param {{ sheets: SheetSpec[], title?: string, creator?: string, date?: Date }} spec
 * @returns {Uint8Array}
 */
export function buildWorkbook(spec) {
  const sheets = Array.isArray(spec.sheets) && spec.sheets.length ? spec.sheets : [{ name: "Sheet1", headers: [], rows: [] }];
  const date = spec.date instanceof Date ? spec.date : new Date();
  const names = new Set();
  const sheetNames = sheets.map((s, i) => {
    let name = sanitiseSheetName(s.name, i);
    let n = 2;
    while (names.has(name.toLowerCase())) name = `${name.slice(0, MAX_SHEET_NAME - 3)} ${n++}`;
    names.add(name.toLowerCase());
    return name;
  });

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    "</Types>";

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    "</Relationships>";

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    "<bookViews><workbookView/></bookViews><sheets>" +
    sheetNames.map((name, i) => `<sheet name="${xmlEscape(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    "</sheets></workbook>";

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    "</Relationships>";

  const iso = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  const core =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xmlEscape(spec.title || "")}</dc:title><dc:creator>${xmlEscape(spec.creator || "DocLink")}</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>` +
    "</cp:coreProperties>";
  const app =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>DocLink</Application></Properties>';

  const entries = [
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "docProps/core.xml", data: core },
    { name: "docProps/app.xml", data: app },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/styles.xml", data: STYLES_XML },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml({ ...s, name: sheetNames[i] }) }))
  ];
  return buildZip(entries, { date });
}

/**
 * Build a CSV file (UTF-8 with BOM, CRLF, RFC 4180 quoting).
 * @param {string[]} headers
 * @param {(string|number|null|undefined)[][]} rows
 * @returns {Uint8Array}
 */
export function buildCsv(headers, rows) {
  const quote = (v) => {
    const text = cellValue(v);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [];
  if (headers && headers.length) lines.push(headers.map(quote).join(","));
  for (const row of rows || []) lines.push((Array.isArray(row) ? row : []).map(quote).join(","));
  const BOM = String.fromCharCode(0xfeff);
  return new TextEncoder().encode(`${BOM}${lines.join("\r\n")}\r\n`);
}
