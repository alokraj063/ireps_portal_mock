/**
 * Filename and date helpers for downloaded documents.
 */

export const DOWNLOAD_SUBFOLDER = "DocLink/IREPS";
export const BILL_STATUS_FILE_PREFIX = "IREPS_Bill_Status";

const pad = (n, width = 2) => String(n).padStart(width, "0");

/**
 * Format a Date as YYYY-MM-DD_HH-mm-ss (local time), safe for filenames.
 * @param {Date} date
 * @returns {string}
 */
export function formatFileTimestamp(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/**
 * Format a Date as DD/MM/YYYY HH:mm:ss (local time) for display in documents.
 * @param {Date} date
 * @returns {string}
 */
export function formatDisplayTimestamp(date = new Date()) {
  return (
    `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Human friendly "15 Sep 2026, 12:20 PM" for the popup.
 * @param {string|number|Date} value
 * @returns {string}
 */
export function formatFriendlyDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let hours = date.getHours();
  const suffix = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${pad(date.getDate())} ${months[date.getMonth()]} ${date.getFullYear()}, ${pad(hours)}:${pad(date.getMinutes())} ${suffix}`;
}

/**
 * Remove characters that are illegal in Windows/macOS filenames.
 * @param {string} name
 * @returns {string}
 */
export function sanitiseFilename(name) {
  return String(name)
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 150);
}

/**
 * Build the bill status PDF name, e.g. IREPS_Bill_Status_2026-09-15_12-30-42.pdf
 * @param {Date} date
 * @returns {string}
 */
export function buildBillStatusFilename(date = new Date()) {
  return sanitiseFilename(`${BILL_STATUS_FILE_PREFIX}_${formatFileTimestamp(date)}.pdf`);
}

/**
 * Relative path (inside the user's Downloads folder) passed to chrome.downloads.
 * @param {Date} date
 * @returns {string}
 */
export function buildBillStatusDownloadPath(date = new Date()) {
  return `${DOWNLOAD_SUBFOLDER}/${buildBillStatusFilename(date)}`;
}

/* -------------------------------------------------------------------------- */
/* PO Search document exports (CRN, R-NOTE)                                   */
/* -------------------------------------------------------------------------- */

export const CRN_DOWNLOAD_SUBFOLDER = "DocLink/IREPS/CRN";
export const CRN_FILE_PREFIX = "IREPS_CRN";
export const RNOTE_DOWNLOAD_SUBFOLDER = "DocLink/IREPS/RNOTE";
export const RNOTE_FILE_PREFIX = "IREPS_RNOTE";

const DOCUMENT_FILE_INFO = {
  CRN: { prefix: CRN_FILE_PREFIX, subfolder: CRN_DOWNLOAD_SUBFOLDER },
  RNOTE: { prefix: RNOTE_FILE_PREFIX, subfolder: RNOTE_DOWNLOAD_SUBFOLDER }
};

function documentFileInfo(criteria) {
  return DOCUMENT_FILE_INFO[String(criteria || "").toUpperCase()] || { prefix: `IREPS_${sanitiseFilename(String(criteria || "DOC")).toUpperCase()}`, subfolder: "DocLink/IREPS" };
}

/**
 * Export file name for a PO Search document type, e.g.
 * IREPS_CRN_2026-09-21_12-30-42.xlsx or IREPS_RNOTE_2026-09-21_12-30-42.csv.
 * The extension follows the export format; nothing here assumes a PDF.
 * @param {string} criteria    "CRN" | "RNOTE"
 * @param {Date} [date]
 * @param {string} [extension] default "xlsx"
 */
export function buildDocumentExportFilename(criteria, date = new Date(), extension = "xlsx") {
  const ext = String(extension || "xlsx").replace(/^[.]/, "").toLowerCase();
  return sanitiseFilename(`${documentFileInfo(criteria).prefix}_${formatFileTimestamp(date)}.${ext}`);
}

/**
 * Relative path (inside the user's Downloads folder) for a document export.
 * @param {string} criteria
 * @param {Date} [date]
 * @param {string} [extension]
 */
export function buildDocumentExportDownloadPath(criteria, date = new Date(), extension = "xlsx") {
  return `${documentFileInfo(criteria).subfolder}/${buildDocumentExportFilename(criteria, date, extension)}`;
}

/* -------------------------------------------------------------------------- */
/* MA (Modification Advice) PDF copies                                        */
/* -------------------------------------------------------------------------- */

export const MA_DOWNLOAD_SUBFOLDER = "DocLink/IREPS/MA";

/**
 * MA_<PO-NO>_<MA-NO>.pdf, e.g. MA_07250369105448_007327.pdf. The PO number
 * is part of the name because MA numbers repeat across POs.
 * @param {string|null|undefined} poNo
 * @param {string|null|undefined} maNo
 */
export function buildMaFilename(poNo, maNo) {
  const po = String(poNo || "").trim() || "unknown-po";
  const ma = String(maNo || "").trim() || "unknown-ma";
  return sanitiseFilename(`MA_${po}_${ma}.pdf`);
}

/**
 * Downloads-relative path for one MA copy, grouped by MA date:
 * DocLink/IREPS/MA/<YYYY-MM-DD>/MA_<PO>_<MA>.pdf ("undated" when the MA Date
 * cell is not a date).
 * @param {{ poNo?: string|null, maNo?: string|null, maDateKey?: string|null }} record
 */
export function buildMaDownloadPath(record) {
  const folder = record && /^\d{4}-\d{2}-\d{2}$/.test(record.maDateKey || "") ? record.maDateKey : "undated";
  return `${MA_DOWNLOAD_SUBFOLDER}/${folder}/${buildMaFilename(record && record.poNo, record && record.maNo)}`;
}

/** CRN convenience wrappers (kept for existing callers/tests). */
export function buildCrnExportFilename(date = new Date(), extension = "xlsx") {
  return buildDocumentExportFilename("CRN", date, extension);
}
export function buildCrnExportDownloadPath(date = new Date(), extension = "xlsx") {
  return buildDocumentExportDownloadPath("CRN", date, extension);
}

/* -------------------------------------------------------------------------- */
/* Purchase Order (PO) PDF                                                    */
/* -------------------------------------------------------------------------- */

export const PO_DOWNLOAD_SUBFOLDER = "DocLink/IREPS/PO";

/** PO_<PO-NO>.pdf, e.g. PO_27253922100240.pdf. */
export function buildPoFilename(poNo) {
  const po = String(poNo || "").trim() || "unknown-po";
  return sanitiseFilename(`PO_${po}.pdf`);
}

/** Downloads-relative path for the PO PDF: DocLink/IREPS/PO/PO_<PO>.pdf. */
export function buildPoDownloadPath(poNo) {
  return `${PO_DOWNLOAD_SUBFOLDER}/${buildPoFilename(poNo)}`;
}

/* -------------------------------------------------------------------------- */
/* Inspection Certificate (IC) PDFs                                           */
/* -------------------------------------------------------------------------- */

export const IC_DOWNLOAD_SUBFOLDER = "DocLink/IREPS/IC";

/**
 * IC_<PO-NO>_<PO-SR>_<CALL-ID>.pdf, or IC_<PO-NO>_<CALL-ID>.pdf when the PO
 * Sr. could not be read from the row.
 * @param {string|null|undefined} poNo
 * @param {string|null|undefined} poSr
 * @param {string|null|undefined} callId
 */
export function buildIcFilename(poNo, poSr, callId) {
  const po = String(poNo || "").trim() || "unknown-po";
  const call = String(callId || "").trim() || "unknown-call";
  const sr = String(poSr || "").trim();
  return sanitiseFilename(sr ? `IC_${po}_${sr}_${call}.pdf` : `IC_${po}_${call}.pdf`);
}

/**
 * Downloads-relative path for one IC copy, grouped by PO number:
 * DocLink/IREPS/IC/<PO>/IC_<PO>_<POSR>_<CALLID>.pdf.
 * @param {{ poNo?: string|null, poSerial?: string|null, callId?: string|null }} record
 */
export function buildIcDownloadPath(record) {
  const po = String((record && record.poNo) || "").trim() || "unknown-po";
  return `${IC_DOWNLOAD_SUBFOLDER}/${sanitiseFilename(po)}/${buildIcFilename(po, record && record.poSerial, record && record.callId)}`;
}
