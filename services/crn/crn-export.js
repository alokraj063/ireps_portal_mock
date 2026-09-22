/**
 * CRN export: the columns of the CRN result table (services/crn/crn-parser.js)
 * handed to the shared table exporter (services/search-po/search-po-export.js).
 *
 * Columns follow the IREPS result table in order, like the portal's own
 * "Export to Excel": the combined "CRN Type / Claim No." column of the page
 * is split into two columns, and the document links IREPS embeds in the
 * table (CRN PDF, claim PDF, bill PDF) are NOT exported - they stay on the
 * parsed records only. Values are copied verbatim; nothing is calculated.
 */

import { buildTableExport, EXPORT_FORMAT, EXPORT_FORMATS, exportFormatInfo } from "../search-po/search-po-export.js";
import { CRN_FIELDS } from "./crn-parser.js";

export const CRN_EXPORT_FORMAT = EXPORT_FORMAT;
export const CRN_EXPORT_FORMATS = EXPORT_FORMATS;
export const crnExportFormatInfo = exportFormatInfo;

/** Columns of the export, in order. `key` refers to the parsed record. */
export const CRN_EXPORT_COLUMNS = Object.freeze([
  { key: "index", label: "#" },
  ...CRN_FIELDS.map((f) => ({ key: f.key, label: f.label }))
]);

/** Header labels + one array per record (strings or null). */
export function crnTable(records) {
  const headers = CRN_EXPORT_COLUMNS.map((c) => c.label);
  const rows = (records || []).map((record) =>
    CRN_EXPORT_COLUMNS.map((c) => {
      const v = record[c.key];
      return v === null || v === undefined ? null : String(v);
    })
  );
  return { headers, rows };
}

/**
 * Build the export file for a CRN search result.
 *
 * @param {{ records: object[], filter?: string, fetchedAt?: string, pagination?: object, warnings?: string[] }} result
 * @param {{ format?: string, now?: Date }} [options]
 * @returns {import("../search-po/search-po-export.js").ExportFile}
 */
export function buildCrnExport(result, options = {}) {
  if (!result || !Array.isArray(result.records)) throw new Error("Invalid CRN search result");
  const { headers, rows } = crnTable(result.records);
  return buildTableExport(
    {
      sheetName: "CRN",
      documentLabel: "Consignment Receipt Note (CRN)",
      sourceLabel: "IREPS - PO Search (/epsn/searchPO.do, searchCriteria=CRN)",
      headers,
      rows,
      filter: result.filter,
      fetchedAt: result.fetchedAt,
      pagesFetched: result.pagination && result.pagination.pagesFetched,
      warnings: result.warnings
    },
    options
  );
}
