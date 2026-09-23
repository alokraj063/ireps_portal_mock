/**
 * PO Document Service: the single entry point that turns a bare PO number
 * into IREPS downloads, independent of where that PO number came from.
 *
 *   DocLink UI (manual input today, an automatic source later)
 *          |
 *          | PO Number
 *          v
 *   processPoNumber(poNumber, { downloadPo, downloadIc })
 *          |
 *    +-----+-----+
 *    |           |
 *    v           v
 *  downloadPo  downloadInspectionCertificates
 *
 * The manual "Download PO" / "Download Inspection Certificate" buttons and a
 * future automatic PO discovery loop call the exact same functions here -
 * nothing in this module or below it knows whether the PO number was typed
 * by a user or read from a configured source.
 */

import { downloadPo } from "./po/po-service.js";
import { downloadInspectionCertificates } from "./inspection-certificate/ic-service.js";

/**
 * @typedef {Object} ProcessPoNumberOptions
 * @property {boolean} [downloadPo]   default true
 * @property {boolean} [downloadIc]   default true
 */

/**
 * Download the requested documents for one PO number.
 *
 * @param {string} poNumber
 * @param {ProcessPoNumberOptions} [options]
 * @param {object} [deps]  forwarded to downloadPo() / downloadInspectionCertificates()
 * @returns {Promise<{ poNumber: string, po: object|null, inspectionCertificates: object|null }>}
 */
export async function processPoNumber(poNumber, options = {}, deps = {}) {
  const wantPo = options.downloadPo !== false;
  const wantIc = options.downloadIc !== false;
  const [po, inspectionCertificates] = await Promise.all([
    wantPo ? downloadPo(poNumber, deps) : Promise.resolve(null),
    wantIc ? downloadInspectionCertificates(poNumber, deps) : Promise.resolve(null)
  ]);
  return { poNumber, po, inspectionCertificates };
}

/**
 * Download the PO and every issued Inspection Certificate of one PO number.
 * @param {string} poNumber
 * @param {object} [deps]
 */
export function downloadPoAndIc(poNumber, deps = {}) {
  return processPoNumber(poNumber, { downloadPo: true, downloadIc: true }, deps);
}
