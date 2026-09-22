/**
 * IREPS Bill Status parser.
 *
 * Input : raw server-rendered HTML from viewBills.do (untrusted).
 * Output: structured bill records + a clean printable HTML document that is
 *         rebuilt from escaped field values (the IREPS markup itself is
 *         never rendered).
 *
 * Two layouts are understood:
 *
 *  1. The real IREPS page: one <table id="table_id"> per bill (the id is
 *     repeated for every bill). Each block has a contract header row + value
 *     row, a CO6/status header row + value row and optional single-cell
 *     sections "Reason For Return" / "Recovery Details" followed by their
 *     text. See parseBillBlock().
 *
 *  2. Legacy / fallback: one list table with a header row (kept so that
 *     older fixtures and any future tabular layout still parse).
 *
 * Both are label driven: header cells are matched by their text (in any
 * order, with or without punctuation); column positions are never
 * hard-coded. Values are copied verbatim; nothing is calculated, corrected
 * or inferred. Placeholders such as "----" and "NA" become null.
 *
 * Requires a DOMParser. In the extension this runs inside the offscreen
 * document; pass { DOMParser } explicitly in other environments.
 */

import { escapeHtml, normaliseText, stripDangerousNodes } from "../utils/sanitizer.js";
import { formatDisplayTimestamp } from "../utils/filename.js";

/** Order used for output objects and for the PDF. */
export const BILL_FIELDS = [
  { key: "contractNo", label: "Contract No" },
  { key: "contractDate", label: "Contract Date" },
  { key: "billNumber", label: "Bill Number" },
  { key: "billDate", label: "Bill Date" },
  { key: "zone", label: "Railway Zone" },
  { key: "partyName", label: "Party Name" },
  { key: "partyCode", label: "Party Code" },
  { key: "status", label: "Status" },
  { key: "billAmount", label: "Bill Amount" },
  { key: "passedAmount", label: "Passed Amount" },
  { key: "deductedAmount", label: "Deducted Amount" },
  { key: "netAmount", label: "Net Amount" },
  { key: "co6No", label: "CO6 No" },
  { key: "co6Date", label: "CO6 Date" },
  { key: "co7No", label: "CO7 No" },
  { key: "co7Date", label: "CO7 Date" },
  { key: "paymentAdviceDate", label: "Payment Advice Date" },
  { key: "accountingUnit", label: "Accounting Unit" },
  { key: "recoveryDetails", label: "Recovery Details" },
  { key: "reasonForReturn", label: "Reason for Return" }
];

/** Fields whose values may be long free text. Rendered full-width. */
export const LONG_TEXT_FIELDS = new Set(["recoveryDetails", "reasonForReturn", "partyName", "accountingUnit"]);

/** Fields rendered by IREPS as a single-cell section header followed by a text row. */
export const SECTION_FIELDS = new Set(["reasonForReturn", "recoveryDetails"]);

/** Selector for the per-bill blocks on the real IREPS page (the id is repeated). */
export const BILL_BLOCK_SELECTOR = "table#table_id";

/**
 * Normalise a raw IREPS cell value. Placeholders that IREPS prints for
 * "nothing here" ("----", "-", "NA", "N/A") and empty strings become null.
 * Everything else is returned trimmed, otherwise verbatim.
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function normalizeIrepsValue(value) {
  const cleaned = normaliseText(value);
  if (!cleaned) return null;
  if (/^[-–—]+$/.test(cleaned)) return null;
  const upper = cleaned.toUpperCase();
  if (upper === "NA" || upper === "N/A" || upper === "N.A." || upper === "NIL" || upper === "NULL") return null;
  return cleaned;
}

/**
 * Label aliases. Labels are normalised to lower-case alphanumerics before
 * matching ("Contract No." -> "contractno"). Exact matches win; otherwise
 * the longest alias contained in the label wins.
 */
const FIELD_ALIASES = {
  contractNo: ["contractno", "contractnumber", "contract", "contractpono", "pono", "ponumber", "purchaseorderno", "loano", "loanumber"],
  contractDate: ["contractdate", "contractdt", "podate", "loadate", "dateofcontract"],
  billNumber: ["billno", "billnumber", "bill", "invoiceno", "invoicenumber", "vendorbillno", "billinvoiceno", "supplierbillno", "partybillno"],
  billDate: ["billdate", "billdt", "invoicedate", "dateofbill", "vendorbilldate", "supplierbilldate", "partybilldate"],
  zone: ["zone", "railwayzone", "rlyzone", "railway", "rly", "zonalrailway"],
  partyName: ["partyname", "vendorname", "suppliername", "firmname", "nameofparty", "contractorname", "nameoffirm", "nameofvendor", "party"],
  partyCode: ["partycode", "vendorcode", "suppliercode", "firmcode", "contractorcode"],
  co6No: ["co6no", "co6number", "co6", "co6billno", "co6bill", "co6noireps"],
  co6Date: ["co6date", "co6dt", "co6billdate", "dateofco6"],
  status: ["status", "billstatus", "currentstatus", "statusofbill", "presentstatus", "paymentstatus"],
  billAmount: ["billamt", "billamount", "billamtrs", "billamountrs", "amount", "amt", "grossamt", "grossamount", "totalamt", "totalamount", "billvalue", "claimedamt", "claimedamount", "amtclaimed", "amountclaimed", "invoiceamount", "invoiceamt"],
  passedAmount: ["passedamt", "passedamount", "amtpassed", "amountpassed", "passedamtrs", "passedamountrs"],
  deductedAmount: ["deductedamt", "deductedamount", "deduction", "deductions", "deductionamt", "deductionamount", "amtdeducted", "amountdeducted", "deductedamtrs"],
  netAmount: ["netamt", "netamount", "netpayable", "netpayableamt", "netpayableamount", "amtpayable", "amountpayable", "netamtrs", "netamountrs"],
  co7No: ["co7no", "co7number", "co7", "co7billno", "co7bill"],
  co7Date: ["co7date", "co7dt", "co7billdate", "dateofco7"],
  paymentAdviceDate: ["paymentadvicedatetobank", "paymentadvicedate", "paymentadvicedt", "paymentadvice", "advicedatetobank", "datepaymentadvicetobank", "paymentadvisedate", "paymentadvisedatetobank", "paymentdate", "datepaymentadvice"],
  accountingUnit: ["accountingunit", "accountsunit", "accountunit", "acunit", "accountingunitname", "accountingunitcode", "auname"],
  recoveryDetails: ["recoverydetails", "recoverydetail", "recoveries", "recovery", "recoverydetailsifany", "detailsofrecovery"],
  reasonForReturn: ["reasonforreturn", "reasonofreturn", "returnreason", "reasonforreturning", "reasonreturn", "reason", "remarks", "remark"]
};

/** Columns that carry no business data and are dropped silently. */
const IGNORED_LABELS = new Set([
  "slno", "sno", "srno", "serialno", "serialnumber", "sl", "sr", "no", "sn",
  "select", "action", "actions", "view", "print", "download", "details", "viewdetails", "edit", "delete"
]);

const DATE_LIKE = /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/;
const NUMBER_LIKE = /^-?[\d,]+(\.\d+)?$/;

/**
 * @typedef {Object} ParsedBill
 * @property {number} index           1-based order in which it was found
 * @property {string|null} contractNo
 * @property {string|null} contractDate
 * @property {string|null} billDate
 * @property {string|null} billNumber
 * @property {string|null} zone
 * @property {string|null} partyName
 * @property {string|null} partyCode
 * @property {string|null} co6No
 * @property {string|null} co6Date
 * @property {string|null} status
 * @property {string|null} billAmount
 * @property {string|null} passedAmount
 * @property {string|null} deductedAmount
 * @property {string|null} netAmount
 * @property {string|null} co7No
 * @property {string|null} co7Date
 * @property {string|null} paymentAdviceDate
 * @property {string|null} accountingUnit
 * @property {string|null} recoveryDetails
 * @property {string|null} reasonForReturn
 * @property {Record<string,string>} extra   unmapped columns, label -> value
 */

/**
 * @typedef {Object} BillStatusResult
 * @property {string} title
 * @property {string} generatedAt      ISO timestamp
 * @property {string} retrievedAt      display timestamp (DD/MM/YYYY HH:mm:ss)
 * @property {string} source
 * @property {string|null} sourceUrl
 * @property {string} filter
 * @property {number} recordCount
 * @property {ParsedBill[]} bills
 * @property {string[]} extraColumns   ordered labels of unmapped columns
 * @property {"blocks"|"table"|"keyValue"|"text"|"none"} structure
 * @property {number} blockCount       number of table#table_id blocks found
 * @property {number} skippedCount     blocks without Bill Number and Contract No
 * @property {string|null} pageMessage message such as "No records found"
 * @property {string[]} warnings
 * @property {string} printableHtml
 */

/* -------------------------------------------------------------------------- */
/* Label matching                                                             */
/* -------------------------------------------------------------------------- */

/** "Bill Amt. (Rs.)" -> "billamt" */
export function normaliseLabel(text) {
  return normaliseText(text)
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(in\s+)?(rs\.?|inr|rupees)\b/g, " ")
    .replace(/₹/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

const ALIAS_INDEX = (() => {
  const exact = new Map();
  const partial = [];
  for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      if (!exact.has(alias)) exact.set(alias, key);
      if (alias.length >= 5) partial.push({ alias, key });
    }
  }
  partial.sort((a, b) => b.alias.length - a.alias.length);
  return { exact, partial };
})();

/**
 * Map a header label to a bill field key, or null.
 * @param {string} label
 * @returns {string|null}
 */
export function matchFieldKey(label) {
  const norm = normaliseLabel(label);
  if (!norm || norm.length > 80) return null;
  if (IGNORED_LABELS.has(norm)) return null;
  if (ALIAS_INDEX.exact.has(norm)) return ALIAS_INDEX.exact.get(norm);
  for (const { alias, key } of ALIAS_INDEX.partial) {
    if (norm.includes(alias)) return key;
  }
  return null;
}

function looksLikeValue(text) {
  const t = normaliseText(text);
  return DATE_LIKE.test(t) || NUMBER_LIKE.test(t.replace(/\s/g, ""));
}

/* -------------------------------------------------------------------------- */
/* Table grid extraction                                                      */
/* -------------------------------------------------------------------------- */

function directRows(table) {
  const rows = [];
  for (const child of Array.from(table.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "tr") rows.push(child);
    else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      for (const tr of Array.from(child.children)) {
        if (tr.tagName.toLowerCase() === "tr") rows.push(tr);
      }
    }
  }
  return rows;
}

function directCells(tr) {
  return Array.from(tr.children).filter((c) => /^t[dh]$/i.test(c.tagName));
}

function cellText(cell) {
  // Preserve line breaks so multi-line recovery details keep their structure.
  const clone = cell.cloneNode(true);
  for (const br of Array.from(clone.querySelectorAll("br"))) br.replaceWith("\n");
  for (const block of Array.from(clone.querySelectorAll("p,div,li,tr"))) block.append("\n");
  return normaliseText(clone.textContent);
}

/**
 * Expand a table into a rectangular grid of { text, isHeader } cells,
 * honouring colspan and rowspan.
 */
function buildGrid(table) {
  const rows = directRows(table);
  const grid = [];
  const pending = new Map(); // "row,col" -> cell (from rowspan)

  rows.forEach((tr, r) => {
    const out = [];
    let c = 0;
    const cells = directCells(tr);
    const place = (cell) => {
      while (pending.has(`${r},${c}`)) {
        out[c] = pending.get(`${r},${c}`);
        pending.delete(`${r},${c}`);
        c++;
      }
      const colspan = Math.max(1, Math.min(50, parseInt(cell.getAttribute("colspan") || "1", 10) || 1));
      const rowspan = Math.max(1, Math.min(200, parseInt(cell.getAttribute("rowspan") || "1", 10) || 1));
      const entry = {
        text: cellText(cell),
        isHeader: cell.tagName.toLowerCase() === "th",
        colspan,
        hasNestedTable: !!cell.querySelector("table")
      };
      for (let i = 0; i < colspan; i++) {
        out[c] = entry;
        for (let k = 1; k < rowspan; k++) pending.set(`${r + k},${c}`, entry);
        c++;
      }
    };
    cells.forEach(place);
    while (pending.has(`${r},${c}`)) {
      out[c] = pending.get(`${r},${c}`);
      pending.delete(`${r},${c}`);
      c++;
    }
    grid.push(out);
  });

  const width = Math.max(0, ...grid.map((row) => row.length));
  for (const row of grid) {
    for (let i = 0; i < width; i++) if (!row[i]) row[i] = { text: "", isHeader: false, colspan: 1 };
  }
  return grid;
}

function rowScore(row) {
  const keys = new Set();
  for (const cell of row) {
    const key = matchFieldKey(cell.text);
    if (key) keys.add(key);
  }
  return keys.size;
}

function isHeaderLike(row) {
  if (!row || row.length === 0) return false;
  const nonEmpty = row.filter((c) => c.text);
  if (nonEmpty.length === 0) return false;
  if (nonEmpty.every((c) => c.isHeader)) return true;
  if (nonEmpty.some((c) => looksLikeValue(c.text))) return false;
  return rowScore(row) >= 1;
}

function sameRow(a, b) {
  return a.length === b.length && a.every((cell, i) => cell === b[i] || cell.text === b[i].text);
}

/**
 * Try to interpret one table as a Bill Status list.
 * @returns {{ bills: object[], extraColumns: string[] }|null}
 */
function parseListTable(table) {
  const grid = buildGrid(table);
  if (grid.length < 2) return null;

  let headerIndex = -1;
  let best = 0;
  grid.forEach((row, i) => {
    const score = rowScore(row);
    if (score > best) {
      best = score;
      headerIndex = i;
    }
  });
  if (headerIndex < 0 || best < 3) return null;

  const header = grid[headerIndex];
  const above = headerIndex > 0 && isHeaderLike(grid[headerIndex - 1]) ? grid[headerIndex - 1] : null;
  let dataStart = headerIndex + 1;
  let below = null;
  if (grid[dataStart] && isHeaderLike(grid[dataStart]) && !sameRow(grid[dataStart], header)) {
    below = grid[dataStart];
    dataStart += 1;
  }

  // Resolve each column to a field key using the most specific label.
  const columns = header.map((cell, c) => {
    const own = cell.text;
    const candidates = [];
    if (below && below[c].text && below[c].text !== own) candidates.push(`${own} ${below[c].text}`);
    if (above && above[c].text && above[c].text !== own) candidates.push(`${above[c].text} ${own}`);
    candidates.push(own);
    if (below && below[c].text && below[c].text !== own) candidates.push(below[c].text);

    let key = null;
    let label = own;
    for (const candidate of candidates) {
      const k = matchFieldKey(candidate);
      if (k) {
        key = k;
        label = normaliseText(candidate);
        break;
      }
    }
    if (!label && above) label = normaliseText(above[c].text);
    return { key, label };
  });

  // De-duplicate keys: the first column wins, later ones become extras.
  const seen = new Set();
  for (const col of columns) {
    if (col.key && seen.has(col.key)) col.key = null;
    else if (col.key) seen.add(col.key);
    if (!col.key && IGNORED_LABELS.has(normaliseLabel(col.label))) col.ignored = true;
  }

  const extraColumns = [];
  const bills = [];
  for (let r = dataStart; r < grid.length; r++) {
    const row = grid[r];
    if (sameRow(row, header) || rowScore(row) >= Math.max(3, best - 1)) continue; // repeated header
    const nonEmpty = row.filter((c) => c.text);
    if (nonEmpty.length === 0) continue;
    const distinct = new Set(row.map((c) => c));
    if (distinct.size === 1) continue; // one cell spanning the row: note / pagination / "no records"

    const bill = createEmptyBill();
    let hasKnownValue = false;
    columns.forEach((col, c) => {
      const value = row[c] ? row[c].text : "";
      if (col.key) {
        bill[col.key] = value === "" ? null : value;
        if (value !== "") hasKnownValue = true;
      } else if (!col.ignored && col.label && value !== "") {
        const label = normaliseText(col.label);
        bill.extra[label] = bill.extra[label] ? `${bill.extra[label]} ${value}` : value;
        if (!extraColumns.includes(label)) extraColumns.push(label);
      }
    });
    if (hasKnownValue) bills.push(bill);
  }

  return { bills, extraColumns };
}

/* -------------------------------------------------------------------------- */
/* Real IREPS layout: one <table id="table_id"> per bill                      */
/* -------------------------------------------------------------------------- */

const SECTION_INLINE = /^([^:]{3,40}?)\s*:\s*([\s\S]+)$/;

/** Text of a cell for free-text sections: nested table rows become lines. */
function sectionText(cell) {
  const nested = cell.querySelector("table");
  if (!nested) return cellText(cell);
  const lines = [];
  for (const tr of Array.from(cell.querySelectorAll("tr"))) {
    const parts = directCells(tr)
      .filter((c) => !c.querySelector("table"))
      .map((c) => cellText(c))
      .filter(Boolean);
    if (parts.length) lines.push(parts.join(": "));
  }
  return normaliseText(lines.join("\n"));
}

function directNestedTables(cell) {
  const out = [];
  const visit = (node) => {
    for (const child of Array.from(node.children)) {
      if (child.tagName.toLowerCase() === "table") out.push(child);
      else visit(child);
    }
  };
  visit(cell);
  return out;
}

/**
 * Parse one bill block. Rows are classified by their content, never by
 * position:
 *   - a row whose cells are all field labels  -> header; the next row holds the values
 *   - a single-cell "Reason For Return" / "Recovery Details" row -> section; the
 *     next row holds the complete text
 *   - "Label" / "value" cell pairs in one row -> key/value
 * Nested tables are walked with the same rules; anything else is ignored.
 *
 * @param {Element} table
 * @param {number} ordinal   1-based position of the block (for warnings)
 * @returns {{ bill: ParsedBill, warnings: string[] }}
 */
export function parseBillBlock(table, ordinal = 1) {
  const bill = createEmptyBill();
  const warnings = [];
  const state = { pendingHeader: null, pendingSection: null };

  const assign = (key, value) => {
    const normalised = normalizeIrepsValue(value);
    if (bill[key] === null || bill[key] === undefined) {
      bill[key] = normalised;
    } else if (normalised !== null && normalised !== bill[key]) {
      warnings.push(`Bill record ${ordinal}: "${key}" appears twice with different values; the first value was kept.`);
    }
  };

  const walk = (tbl) => {
    for (const tr of directRows(tbl)) {
      const cells = directCells(tr);
      if (cells.length === 0) continue;

      if (state.pendingSection) {
        const key = state.pendingSection;
        state.pendingSection = null;
        assign(key, cells.map(sectionText).filter(Boolean).join("\n"));
        continue;
      }

      if (state.pendingHeader) {
        const header = state.pendingHeader;
        state.pendingHeader = null;
        const values = cells.map((c) => (c.querySelector("table") ? sectionText(c) : cellText(c)));
        if (values.length !== header.length) {
          warnings.push(`Bill record ${ordinal}: header has ${header.length} columns but the value row has ${values.length}.`);
        }
        header.forEach((key, i) => {
          if (key && i < values.length) assign(key, values[i]);
        });
        continue;
      }

      const texts = cells.map((c) => (c.querySelector("table") ? null : cellText(c)));
      const keys = texts.map((t) => (t === null ? null : matchFieldKey(t)));
      const labelCount = keys.filter(Boolean).length;
      const nonEmpty = texts.filter((t) => t !== null && t !== "").length;
      const allTh = cells.every((c) => c.tagName.toLowerCase() === "th");

      if (cells.length === 1) {
        const text = texts[0];
        const key = keys[0];
        if (text === null) {
          for (const nested of directNestedTables(cells[0])) walk(nested);
          continue;
        }
        if (key && SECTION_FIELDS.has(key)) {
          const inline = SECTION_INLINE.exec(text);
          if (inline && matchFieldKey(inline[1]) === key) assign(key, inline[2]);
          else state.pendingSection = key;
          continue;
        }
        if (key && allTh) {
          state.pendingHeader = [key];
          continue;
        }
        const inline = SECTION_INLINE.exec(text);
        const inlineKey = inline ? matchFieldKey(inline[1]) : null;
        if (inlineKey && !looksLikeValue(inline[1])) assign(inlineKey, inline[2]);
        continue;
      }

      if (labelCount >= 2 && (allTh || labelCount === nonEmpty) && !texts.some((t) => t && looksLikeValue(t))) {
        state.pendingHeader = keys;
        continue;
      }

      let pairs = 0;
      for (let i = 0; i < cells.length - 1; i++) {
        if (keys[i] && texts[i + 1] !== null && !keys[i + 1]) {
          const value = texts[i + 1].replace(/^[:\-]\s*/, "");
          assign(keys[i], value);
          pairs++;
          i++;
        }
      }
      if (pairs > 0) continue;

      for (const cell of cells) {
        if (cell.querySelector("table")) for (const nested of directNestedTables(cell)) walk(nested);
      }
    }
  };

  walk(table);
  if (state.pendingSection) warnings.push(`Bill record ${ordinal}: "${state.pendingSection}" section has no text row.`);
  return { bill, warnings };
}

/**
 * Parse every <table id="table_id"> block of the page.
 * @param {Document} doc
 * @returns {{ bills: ParsedBill[], warnings: string[], blockCount: number }}
 */
export function parseBillBlocks(doc) {
  const blocks = Array.from(doc.querySelectorAll(BILL_BLOCK_SELECTOR));
  const bills = [];
  const warnings = [];
  blocks.forEach((table, i) => {
    const parsed = parseBillBlock(table, i + 1);
    bills.push(parsed.bill);
    warnings.push(...parsed.warnings);
  });
  return { bills, warnings, blockCount: blocks.length };
}

/**
 * Lightweight validation. A record normally carries a Bill Number and/or a
 * Contract No; records with neither are set aside with a warning instead of
 * failing the whole response. Nothing is de-duplicated: the same bill may
 * legitimately appear once per lifecycle status.
 *
 * @param {ParsedBill[]} records
 * @param {{ maxWarnings?: number }} [options]
 * @returns {{ validRecords: ParsedBill[], skippedRecords: ParsedBill[], warnings: string[] }}
 */
export function validateBillStatusRecords(records, options = {}) {
  const maxWarnings = options.maxWarnings ?? 200;
  const validRecords = [];
  const skippedRecords = [];
  const warnings = [];
  const warn = (text) => {
    if (warnings.length < maxWarnings) warnings.push(text);
  };
  records.forEach((bill, i) => {
    const n = i + 1;
    if (!bill.billNumber && !bill.contractNo) {
      skippedRecords.push(bill);
      warn(`Bill record ${n} is missing both Bill Number and Contract No and was skipped.`);
      return;
    }
    if (!bill.billNumber) warn(`Bill record ${n} is missing Bill Number.`);
    if (!bill.status) warn(`Bill record ${n} is missing Status.`);
    validRecords.push(bill);
  });
  const total = records.length - validRecords.length;
  if (warnings.length >= maxWarnings) warnings.push(`Further warnings were truncated (${records.length} records checked, ${total} skipped).`);
  return { validRecords, skippedRecords, warnings };
}

/* -------------------------------------------------------------------------- */
/* Key / value layouts                                                        */
/* -------------------------------------------------------------------------- */

function parseKeyValueTables(doc) {
  const bill = createEmptyBill();
  let found = 0;
  for (const table of Array.from(doc.querySelectorAll("table"))) {
    for (const tr of directRows(table)) {
      const cells = directCells(tr);
      for (let i = 0; i < cells.length - 1; i++) {
        const key = matchFieldKey(cellText(cells[i]));
        if (!key || bill[key] !== null) continue;
        const next = cells[i + 1];
        if (next.querySelector("table")) continue;
        const value = cellText(next).replace(/^[:\-]\s*/, "");
        if (value && !matchFieldKey(value)) {
          bill[key] = value;
          found++;
          i++;
        }
      }
    }
  }
  return found >= 3 ? bill : null;
}

function parseLabelledText(doc) {
  const bill = createEmptyBill();
  let found = 0;
  const candidates = Array.from(doc.querySelectorAll("td,th,li,p,div,span,label,dt,dd,b,strong"));
  for (const el of candidates) {
    if (el.children.length > 3) continue;
    const text = normaliseText(el.textContent);
    if (!text || text.length > 400) continue;
    const m = text.match(/^([A-Za-z0-9 .\/()#]+?)\s*[:\-]\s*(.+)$/);
    if (!m) continue;
    const key = matchFieldKey(m[1]);
    if (key && bill[key] === null && m[2].trim()) {
      bill[key] = m[2].trim();
      found++;
    }
  }
  return found >= 3 ? bill : null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export function createEmptyBill() {
  const bill = { index: 0 };
  for (const f of BILL_FIELDS) bill[f.key] = null;
  bill.extra = {};
  return bill;
}

function detectFilter(doc) {
  const selects = Array.from(doc.querySelectorAll("select"));
  const parts = [];
  for (const select of selects) {
    const name = `${select.getAttribute("name") || ""} ${select.getAttribute("id") || ""}`.toLowerCase();
    if (!/date|range|period|zone|rly|days/.test(name)) continue;
    const opt = select.querySelector("option[selected]") || select.options?.[select.selectedIndex];
    const text = opt ? normaliseText(opt.textContent) : "";
    if (text && !/^select/i.test(text) && !/^-+$/.test(text)) parts.push(text);
  }
  if (parts.length) return parts.join(", ");
  const checked = doc.querySelector("input[type=radio][checked]");
  if (checked) {
    const id = checked.getAttribute("id");
    const label = id ? doc.querySelector(`label[for="${id}"]`) : checked.closest("label");
    const text = label ? normaliseText(label.textContent) : "";
    if (text) return text;
  }
  if (/last\s*90\s*days/i.test(doc.body?.textContent || "")) return "Last 90 Days";
  return "Default (Last 90 Days)";
}

function detectPageMessage(doc) {
  const text = normaliseText(doc.body?.textContent || "").toLowerCase();
  const m = text.match(/(no (?:bill )?records?\(?s?\)? (?:found|available)[^.]*|no data (?:found|available)[^.]*|records? not found[^.]*)/);
  return m ? m[1].trim() : null;
}

/**
 * Parse the IREPS Bill Status HTML.
 *
 * @param {string} html
 * @param {{ DOMParser?: typeof DOMParser, sourceUrl?: string, now?: Date, filter?: string }} [options]
 *        `filter` overrides the filter text detected from the page (the
 *        service worker passes the request it actually sent).
 * @returns {BillStatusResult}
 */
export function parseBillStatus(html, options = {}) {
  const Parser = options.DOMParser || globalThis.DOMParser;
  if (!Parser) throw new Error("DOMParser is not available in this context");
  const now = options.now || new Date();
  const warnings = [];

  const doc = new Parser().parseFromString(String(html || ""), "text/html");
  const filter = options.filter || detectFilter(doc);
  const pageMessage = detectPageMessage(doc);
  stripDangerousNodes(doc);

  let bills = [];
  let extraColumns = [];
  let structure = "none";
  let blockCount = 0;
  let skippedCount = 0;

  // Layout 1: the real IREPS page, one <table id="table_id"> per bill.
  const blocks = parseBillBlocks(doc);
  blockCount = blocks.blockCount;
  if (blocks.blockCount > 0) {
    structure = "blocks";
    const validation = validateBillStatusRecords(blocks.bills);
    bills = validation.validRecords;
    skippedCount = validation.skippedRecords.length;
    warnings.push(...blocks.warnings, ...validation.warnings);
  }

  // Layout 2: a single list table (legacy / fallback). Prefer the largest
  // bill-like table; never mix records from tables nested inside each other.
  if (bills.length === 0 && blockCount === 0) {
    const tables = Array.from(doc.querySelectorAll("table"));
    const tableResults = [];
    for (const table of tables) {
      const parsed = parseListTable(table);
      if (parsed) tableResults.push({ table, ...parsed });
    }
    tableResults.sort((a, b) => b.bills.length - a.bills.length);
    const used = [];
    for (const result of tableResults) {
      if (used.some((t) => t.contains(result.table) || result.table.contains(t))) continue;
      used.push(result.table);
      bills.push(...result.bills);
      for (const label of result.extraColumns) if (!extraColumns.includes(label)) extraColumns.push(label);
    }
    if (tableResults.length > 0) structure = "table";

    if (bills.length === 0) {
      const kv = parseKeyValueTables(doc) || parseLabelledText(doc);
      if (kv) {
        bills = [kv];
        structure = structure === "table" ? "table" : "keyValue";
      }
    }
    for (const bill of bills) {
      for (const f of BILL_FIELDS) bill[f.key] = normalizeIrepsValue(bill[f.key]);
    }
  }
  if (bills.length === 0 && structure === "none" && !pageMessage) {
    warnings.push("No bill table or labelled bill fields were recognised in the IREPS page.");
  }

  bills.forEach((bill, i) => {
    bill.index = i + 1;
  });

  const result = {
    title: "IREPS Bill Status",
    generatedAt: now.toISOString(),
    retrievedAt: formatDisplayTimestamp(now),
    source: "IREPS",
    sourceUrl: options.sourceUrl || null,
    filter,
    recordCount: bills.length,
    blockCount,
    skippedCount,
    bills,
    extraColumns,
    structure,
    pageMessage,
    warnings,
    printableHtml: ""
  };
  result.printableHtml = buildPrintableHtml(result);
  return result;
}

/* -------------------------------------------------------------------------- */
/* Printable HTML (used by the preview page / print-to-PDF fallback)          */
/* -------------------------------------------------------------------------- */

const display = (value) => (value === null || value === undefined || value === "" ? "-" : value);

/**
 * Build a self-contained HTML fragment from parsed data. Every value is
 * escaped, so no IREPS markup reaches the document.
 * @param {BillStatusResult} result
 * @returns {string}
 */
export function buildPrintableHtml(result) {
  const meta = `
    <section class="meta">
      <div><span class="k">Source:</span> Indian Railways IREPS</div>
      <div><span class="k">Retrieved:</span> ${escapeHtml(result.retrievedAt)}</div>
      <div><span class="k">Filter:</span> ${escapeHtml(result.filter)}</div>
      <div><span class="k">Records:</span> ${escapeHtml(result.recordCount)}</div>
    </section>`;

  let body = "";
  if (result.bills.length === 0) {
    body = `<section class="empty"><h2>No Bill Records Found</h2><p>${escapeHtml(
      result.pageMessage || "IREPS returned successfully, but no bill records were available for the selected period."
    )}</p></section>`;
  } else {
    body = result.bills
      .map((bill) => {
        const rows = BILL_FIELDS.map((f) => {
          const long = LONG_TEXT_FIELDS.has(f.key) ? " long" : "";
          return `<div class="row${long}"><div class="label">${escapeHtml(f.label)}:</div><div class="value">${escapeHtml(
            display(bill[f.key])
          )}</div></div>`;
        });
        for (const [label, value] of Object.entries(bill.extra || {})) {
          rows.push(
            `<div class="row long"><div class="label">${escapeHtml(label)}:</div><div class="value">${escapeHtml(display(value))}</div></div>`
          );
        }
        return `<article class="bill">
          <header class="bill-head"><span>Bill #${bill.index}</span><span class="status">${escapeHtml(display(bill.status))}</span></header>
          <div class="grid">${rows.join("")}</div>
        </article>`;
      })
      .join("\n");
  }

  return `<div class="doc">
    <h1>IREPS BILL STATUS</h1>
    ${meta}
    ${body}
    <footer class="doc-footer">Generated by DocLink from the authenticated IREPS session. Values are reproduced exactly as returned by IREPS.</footer>
  </div>`;
}
