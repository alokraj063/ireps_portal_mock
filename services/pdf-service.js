/**
 * PDF service.
 *
 * Generates a real, text-based PDF (selectable text, no screenshots) from the
 * parsed Bill Status result without any third-party library or backend. It
 * is deliberately self-contained so it can run inside the MV3 service
 * worker, which has no DOM.
 *
 * Public API
 *   generateBillStatusPdf(result)  -> Promise<{ bytes: Uint8Array, pageCount: number }>
 *   pdfToDataUrl(bytes)            -> string  (data:application/pdf;base64,...)
 *
 * Replacing the PDF strategy later only requires re-implementing
 * generateBillStatusPdf(); the parser and IREPS modules are untouched.
 *
 * Layout: A4 portrait, one "card" per bill with two label/value columns,
 * long text fields (recovery details, reason for return...) full-width and
 * word-wrapped, page breaks between cards, cards taller than a page split
 * at row boundaries, header and footer repeated on every page.
 */

import { BILL_FIELDS, LONG_TEXT_FIELDS } from "./bill-parser.js";
import { logger } from "../utils/logger.js";

/* -------------------------------------------------------------------------- */
/* Font metrics (Adobe standard 14: Helvetica / Helvetica-Bold, 1/1000 em)    */
/* -------------------------------------------------------------------------- */

const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
  611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584
];

const FONTS = {
  regular: { resource: "F1", baseFont: "Helvetica", widths: HELVETICA },
  bold: { resource: "F2", baseFont: "Helvetica-Bold", widths: HELVETICA_BOLD }
};

/** Characters outside WinAnsi that get a readable substitute. */
const SUBSTITUTIONS = {
  "₹": "Rs.", // ₹
  "–": "-",
  "—": "-",
  "―": "-",
  "‘": "'",
  "’": "'",
  "‚": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "…": "...",
  "•": "-",
  " ": " ",
  " ": " ",
  " ": " ",
  "\t": "    "
};

/**
 * Convert to the subset of characters the standard fonts can encode.
 * Latin-1 stays; other symbols get a textual substitute or "?".
 */
function toWinAnsi(text) {
  let out = "";
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0);
    if (code === 10 || code === 13) out += "\n";
    else if (SUBSTITUTIONS[ch] !== undefined) out += SUBSTITUTIONS[ch];
    else if (code < 32) out += " ";
    else if (code < 127 || (code >= 160 && code <= 255)) out += ch;
    else out += "?";
  }
  return out;
}

function charWidth(ch, font) {
  const code = ch.charCodeAt(0);
  if (code >= 32 && code <= 126) return font.widths[code - 32];
  if (code >= 160) {
    const base = ch.normalize("NFD")[0];
    const baseCode = base.charCodeAt(0);
    if (baseCode >= 32 && baseCode <= 126) return font.widths[baseCode - 32];
  }
  return 556;
}

function textWidth(text, font, size) {
  let w = 0;
  for (const ch of text) w += charWidth(ch, font);
  return (w / 1000) * size;
}

/** Word-wrap a (WinAnsi) string into lines that fit maxWidth. */
function wrapText(text, font, size, maxWidth) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/ +/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    for (let word of words) {
      // Break words that are wider than the column on their own.
      while (textWidth(word, font, size) > maxWidth) {
        let cut = word.length - 1;
        while (cut > 1 && textWidth(word.slice(0, cut), font, size) > maxWidth) cut--;
        const head = word.slice(0, cut);
        if (line) {
          lines.push(line);
          line = "";
        }
        lines.push(head);
        word = word.slice(cut);
      }
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, font, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function escapePdfString(text) {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === "\\" || ch === "(" || ch === ")") out += `\\${ch}`;
    else if (code < 32 || code > 126) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += ch;
  }
  return out;
}

const fmt = (n) => (Math.round(n * 100) / 100).toString();

/* -------------------------------------------------------------------------- */
/* Minimal PDF document model                                                 */
/* -------------------------------------------------------------------------- */

class PdfPage {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.ops = [];
  }
  /** y is measured from the top of the page (baseline for text). */
  text(x, yTop, str, { font = FONTS.regular, size = 9, color = [0, 0, 0], align = "left", maxWidth = null } = {}) {
    let text = str;
    let xPos = x;
    if (align !== "left" && maxWidth !== null) {
      const w = textWidth(text, font, size);
      if (align === "right") xPos = x + maxWidth - w;
      else if (align === "center") xPos = x + (maxWidth - w) / 2;
    }
    this.ops.push(
      `BT /${font.resource} ${fmt(size)} Tf ${fmt(color[0])} ${fmt(color[1])} ${fmt(color[2])} rg ` +
        `1 0 0 1 ${fmt(xPos)} ${fmt(this.height - yTop)} Tm (${escapePdfString(text)}) Tj ET`
    );
  }
  rect(x, yTop, w, h, { fill = null, stroke = null, lineWidth = 0.5 } = {}) {
    const y = this.height - yTop - h;
    if (fill) {
      this.ops.push(`${fmt(fill[0])} ${fmt(fill[1])} ${fmt(fill[2])} rg ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re f`);
    }
    if (stroke) {
      this.ops.push(
        `${fmt(stroke[0])} ${fmt(stroke[1])} ${fmt(stroke[2])} RG ${fmt(lineWidth)} w ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re S`
      );
    }
  }
  line(x1, y1Top, x2, y2Top, { color = [0, 0, 0], lineWidth = 0.5 } = {}) {
    this.ops.push(
      `${fmt(color[0])} ${fmt(color[1])} ${fmt(color[2])} RG ${fmt(lineWidth)} w ${fmt(x1)} ${fmt(this.height - y1Top)} m ${fmt(
        x2
      )} ${fmt(this.height - y2Top)} l S`
    );
  }
}

async function deflate(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (error) {
    logger.debug("Flate compression unavailable, writing uncompressed streams", error);
    return null;
  }
}

function latin1Bytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function pdfDate(date) {
  const p = (n) => String(n).padStart(2, "0");
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `D:${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(
    date.getMinutes()
  )}${p(date.getSeconds())}${sign}${p(Math.floor(a / 60))}'${p(a % 60)}'`;
}

/**
 * Serialise pages into PDF bytes.
 * @param {PdfPage[]} pages
 * @param {{ title?: string, subject?: string, compress?: boolean }} meta
 */
async function serialisePdf(pages, meta = {}) {
  const objects = []; // index+1 = object number; each is Uint8Array body (without "n 0 obj")
  const add = (body) => {
    objects.push(body instanceof Uint8Array ? body : latin1Bytes(body));
    return objects.length;
  };
  const concat = (parts) => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };

  const catalogId = add("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = add("PLACEHOLDER"); // filled in below
  const fontRegularId = add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS.regular.baseFont} /Encoding /WinAnsiEncoding >>`);
  const fontBoldId = add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS.bold.baseFont} /Encoding /WinAnsiEncoding >>`);
  const resources = `<< /Font << /${FONTS.regular.resource} ${fontRegularId} 0 R /${FONTS.bold.resource} ${fontBoldId} 0 R >> >>`;

  const pageIds = [];
  for (const page of pages) {
    const raw = latin1Bytes(page.ops.join("\n"));
    const compressed = meta.compress === false ? null : await deflate(raw);
    const data = compressed || raw;
    const filter = compressed ? " /Filter /FlateDecode" : "";
    const contentId = add(
      concat([latin1Bytes(`<< /Length ${data.length}${filter} >>\nstream\n`), data, latin1Bytes("\nendstream")])
    );
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${fmt(page.width)} ${fmt(page.height)}] /Resources ${resources} /Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  }
  objects[pagesId - 1] = latin1Bytes(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`
  );

  const infoId = add(
    `<< /Title (${escapePdfString(toWinAnsi(meta.title || "Document"))}) /Subject (${escapePdfString(
      toWinAnsi(meta.subject || "")
    )}) /Producer (DocLink Chrome Extension) /Creator (DocLink) /CreationDate (${pdfDate(new Date())}) >>`
  );

  const parts = [latin1Bytes("%PDF-1.4\n%âãÏÓ\n")];
  let offset = parts[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const head = latin1Bytes(`${i + 1} 0 obj\n`);
    const tail = latin1Bytes("\nendobj\n");
    parts.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  });
  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(latin1Bytes(xref));
  return concat(parts);
}

/* -------------------------------------------------------------------------- */
/* Bill Status layout                                                         */
/* -------------------------------------------------------------------------- */

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { top: 48, right: 40, bottom: 44, left: 40 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;
const COLORS = {
  text: [0.1, 0.1, 0.12],
  muted: [0.42, 0.45, 0.5],
  label: [0.3, 0.33, 0.38],
  rule: [0.78, 0.8, 0.84],
  cardBorder: [0.82, 0.84, 0.87],
  cardHead: [0.93, 0.95, 0.97],
  accent: [0.07, 0.29, 0.55],
  white: [1, 1, 1]
};
const BODY_SIZE = 8.6;
const LINE_HEIGHT = 11;
const LABEL_WIDTH = 100;
const CELL_PAD = 4;
const CARD_HEAD_HEIGHT = 18;
const CARD_GAP = 12;
const HEADER_HEIGHT = 26; // repeated running header on every page
const FOOTER_HEIGHT = 20;

const display = (v) => (v === null || v === undefined || String(v).trim() === "" ? "-" : String(v));

/** Group the bill fields into visual rows: pairs of half-width cells or one full-width cell. */
function buildCardRows(bill) {
  const fieldLabel = Object.fromEntries(BILL_FIELDS.map((f) => [f.key, f.label]));
  const pairs = [
    ["contractNo", "contractDate"],
    ["billNumber", "billDate"],
    ["zone", "partyCode"],
    ["partyName"],
    ["status"],
    ["billAmount", "passedAmount"],
    ["deductedAmount", "netAmount"],
    ["co6No", "co6Date"],
    ["co7No", "co7Date"],
    ["paymentAdviceDate"],
    ["accountingUnit"],
    ["recoveryDetails"],
    ["reasonForReturn"]
  ];
  const rows = pairs.map((keys) =>
    keys.map((key) => ({ label: fieldLabel[key], value: display(bill[key]), long: LONG_TEXT_FIELDS.has(key) || keys.length === 1 }))
  );
  for (const [label, value] of Object.entries(bill.extra || {})) {
    rows.push([{ label, value: display(value), long: true }]);
  }
  return rows;
}

/** Pre-measure a row: wrap every cell and compute its height. */
function measureRow(cells) {
  const halfWidth = CONTENT_WIDTH / 2;
  const measured = cells.map((cell, i) => {
    const cellWidth = cells.length === 1 ? CONTENT_WIDTH : halfWidth;
    const labelLines = wrapText(toWinAnsi(cell.label) + ":", FONTS.bold, BODY_SIZE, LABEL_WIDTH - CELL_PAD);
    const valueLines = wrapText(toWinAnsi(cell.value), FONTS.regular, BODY_SIZE, cellWidth - LABEL_WIDTH - CELL_PAD * 2);
    return { ...cell, x: i * halfWidth, width: cellWidth, labelLines, valueLines };
  });
  const lines = Math.max(1, ...measured.map((c) => Math.max(c.labelLines.length, c.valueLines.length)));
  return { cells: measured, height: lines * LINE_HEIGHT + CELL_PAD * 2 };
}

/**
 * Split a measured row after `lineCount` value lines. The label is repeated
 * on the continuation so the reader always knows what the text belongs to.
 */
function splitRow(row, lineCount) {
  const head = { cells: [], height: 0 };
  const tail = { cells: [], height: 0 };
  let headLines = 1;
  let tailLines = 1;
  for (const cell of row.cells) {
    const first = cell.valueLines.slice(0, lineCount);
    const rest = cell.valueLines.slice(lineCount);
    head.cells.push({ ...cell, valueLines: first });
    tail.cells.push({ ...cell, valueLines: rest });
    headLines = Math.max(headLines, cell.labelLines.length, first.length);
    tailLines = Math.max(tailLines, cell.labelLines.length, rest.length);
  }
  head.height = headLines * LINE_HEIGHT + CELL_PAD * 2;
  tail.height = tailLines * LINE_HEIGHT + CELL_PAD * 2;
  return [head, tail];
}

class BillStatusLayout {
  constructor(result) {
    this.result = result;
    this.pages = [];
    this.page = null;
    this.y = 0;
    this.maxY = PAGE.height - MARGIN.bottom - FOOTER_HEIGHT;
  }

  newPage() {
    this.page = new PdfPage(PAGE.width, PAGE.height);
    this.pages.push(this.page);
    this.y = MARGIN.top;
    if (this.pages.length > 1) this.drawRunningHeader();
  }

  drawRunningHeader() {
    const p = this.page;
    p.text(MARGIN.left, this.y, "IREPS BILL STATUS", { font: FONTS.bold, size: 9, color: COLORS.accent });
    p.text(MARGIN.left, this.y, `Retrieved ${toWinAnsi(this.result.retrievedAt)}  |  ${toWinAnsi(this.result.filter)}`, {
      size: 8,
      color: COLORS.muted,
      align: "right",
      maxWidth: CONTENT_WIDTH
    });
    p.line(MARGIN.left, this.y + 6, PAGE.width - MARGIN.right, this.y + 6, { color: COLORS.rule });
    this.y += HEADER_HEIGHT;
  }

  drawTitleBlock() {
    const p = this.page;
    p.text(MARGIN.left, this.y + 14, "IREPS BILL STATUS", { font: FONTS.bold, size: 18, color: COLORS.accent });
    this.y += 24;
    p.text(MARGIN.left, this.y + 8, "Bill Status report generated from the authenticated IREPS session", {
      size: 8.5,
      color: COLORS.muted
    });
    this.y += 16;
    p.line(MARGIN.left, this.y, PAGE.width - MARGIN.right, this.y, { color: COLORS.accent, lineWidth: 1 });
    this.y += 10;

    const meta = [
      ["Source", "Indian Railways IREPS"],
      ["Retrieved", this.result.retrievedAt],
      ["Filter", this.result.filter],
      ["Records", String(this.result.recordCount)]
    ];
    const colWidth = CONTENT_WIDTH / 2;
    meta.forEach(([label, value], i) => {
      const x = MARGIN.left + (i % 2) * colWidth;
      const y = this.y + Math.floor(i / 2) * 13 + 9;
      p.text(x, y, `${label}:`, { font: FONTS.bold, size: 8.6, color: COLORS.label });
      p.text(x + 58, y, toWinAnsi(value), { size: 8.6, color: COLORS.text });
    });
    this.y += 13 * 2 + 8;
    p.line(MARGIN.left, this.y, PAGE.width - MARGIN.right, this.y, { color: COLORS.rule });
    this.y += 12;
  }

  drawCardHead(bill, continued) {
    const p = this.page;
    p.rect(MARGIN.left, this.y, CONTENT_WIDTH, CARD_HEAD_HEIGHT, { fill: COLORS.cardHead, stroke: COLORS.cardBorder });
    const title = `Bill #${bill.index}${continued ? " (continued)" : ""}`;
    p.text(MARGIN.left + 6, this.y + 12.5, title, { font: FONTS.bold, size: 9.5, color: COLORS.accent });
    const status = toWinAnsi(`Status: ${display(bill.status)}`);
    const statusLines = wrapText(status, FONTS.bold, 8.6, CONTENT_WIDTH * 0.55);
    p.text(MARGIN.left + 6, this.y + 12.5, statusLines[0], {
      font: FONTS.bold,
      size: 8.6,
      color: COLORS.text,
      align: "right",
      maxWidth: CONTENT_WIDTH - 12
    });
    this.y += CARD_HEAD_HEIGHT;
  }

  drawRow(row) {
    const p = this.page;
    p.rect(MARGIN.left, this.y, CONTENT_WIDTH, row.height, { stroke: COLORS.cardBorder });
    for (const cell of row.cells) {
      const x = MARGIN.left + cell.x;
      if (cell.x > 0) p.line(x, this.y, x, this.y + row.height, { color: COLORS.cardBorder });
      cell.labelLines.forEach((line, i) => {
        p.text(x + CELL_PAD, this.y + CELL_PAD + LINE_HEIGHT * (i + 1) - 3, line, {
          font: FONTS.bold,
          size: BODY_SIZE,
          color: COLORS.label
        });
      });
      cell.valueLines.forEach((line, i) => {
        p.text(x + LABEL_WIDTH + CELL_PAD, this.y + CELL_PAD + LINE_HEIGHT * (i + 1) - 3, line, {
          size: BODY_SIZE,
          color: COLORS.text
        });
      });
    }
    this.y += row.height;
  }

  drawBill(bill) {
    const rows = buildCardRows(bill).map(measureRow);
    const total = CARD_HEAD_HEIGHT + rows.reduce((n, r) => n + r.height, 0);
    const available = this.maxY - this.y;
    const pageCapacity = this.maxY - (MARGIN.top + HEADER_HEIGHT);

    if (total > available && total <= pageCapacity) this.newPage();
    // Never leave a card header orphaned at the bottom of a page.
    else if (rows.length && this.y + CARD_HEAD_HEIGHT + Math.min(rows[0].height, 3 * LINE_HEIGHT) > this.maxY) this.newPage();

    this.drawCardHead(bill, false);
    for (const row of rows) {
      let remaining = row;
      for (;;) {
        const space = this.maxY - this.y;
        if (remaining.height <= space) {
          this.drawRow(remaining);
          break;
        }
        // Row does not fit. Either move it to a fresh page, or when it is
        // taller than a page, draw as many lines as fit and continue the
        // remaining lines on the next page (labels repeated).
        const linesThatFit = Math.floor((space - CELL_PAD * 2) / LINE_HEIGHT);
        const rowLines = Math.round((remaining.height - CELL_PAD * 2) / LINE_HEIGHT);
        if (linesThatFit >= 3 && rowLines > linesThatFit) {
          const [head, tail] = splitRow(remaining, linesThatFit);
          this.drawRow(head);
          remaining = tail;
        }
        this.newPage();
        this.drawCardHead(bill, true);
      }
    }
    this.y += CARD_GAP;
  }

  drawEmptyState() {
    const p = this.page;
    p.rect(MARGIN.left, this.y, CONTENT_WIDTH, 48, { fill: COLORS.cardHead, stroke: COLORS.cardBorder });
    p.text(MARGIN.left + 10, this.y + 18, "No Bill Records Found", { font: FONTS.bold, size: 11, color: COLORS.accent });
    const msg = toWinAnsi(
      this.result.pageMessage || "IREPS returned successfully, but no bill records were available for the selected period."
    );
    const lines = wrapText(msg, FONTS.regular, BODY_SIZE, CONTENT_WIDTH - 20);
    lines.slice(0, 2).forEach((line, i) => p.text(MARGIN.left + 10, this.y + 32 + i * LINE_HEIGHT, line, { size: BODY_SIZE }));
    this.y += 60;
  }

  drawFooters() {
    const total = this.pages.length;
    this.pages.forEach((p, i) => {
      const y = PAGE.height - MARGIN.bottom + 4;
      p.line(MARGIN.left, y - 10, PAGE.width - MARGIN.right, y - 10, { color: COLORS.rule });
      p.text(MARGIN.left, y, "Generated by DocLink  |  Values reproduced exactly as returned by IREPS", { size: 7.5, color: COLORS.muted });
      p.text(MARGIN.left, y, `Page ${i + 1} of ${total}`, { size: 7.5, color: COLORS.muted, align: "right", maxWidth: CONTENT_WIDTH });
    });
  }

  render() {
    this.newPage();
    this.drawTitleBlock();
    if (this.result.bills.length === 0) {
      this.drawEmptyState();
    } else {
      for (const bill of this.result.bills) this.drawBill(bill);
    }
    this.drawFooters();
    return this.pages;
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @param {import("./bill-parser.js").BillStatusResult} result
 * @param {{ compress?: boolean }} [options]
 * @returns {Promise<{ bytes: Uint8Array, pageCount: number }>}
 */
export async function generateBillStatusPdf(result, options = {}) {
  if (!result || !Array.isArray(result.bills)) throw new Error("Invalid bill status result");
  const pages = new BillStatusLayout(result).render();
  const bytes = await serialisePdf(pages, {
    title: `IREPS Bill Status - ${result.retrievedAt}`,
    subject: `IREPS Bill Status, ${result.recordCount} record(s), filter: ${result.filter}`,
    compress: options.compress
  });
  logger.info("PDF generated", { pages: pages.length, bytes: bytes.length });
  return { bytes, pageCount: pages.length };
}

/**
 * Encode PDF bytes as a data: URL for chrome.downloads (service workers have
 * no URL.createObjectURL).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function pdfToDataUrl(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:application/pdf;base64,${btoa(binary)}`;
}

/** Exposed for tests. */
export const __internals = { wrapText, textWidth, toWinAnsi, FONTS };
