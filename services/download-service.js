/**
 * Download service.
 *
 * Hands generated PDF bytes to chrome.downloads. Files land in
 * Downloads/DocLink/IREPS/ and are never overwritten (conflictAction:
 * "uniquify" appends " (1)", " (2)", ... when a name already exists).
 */

import { buildBillStatusDownloadPath, buildBillStatusFilename } from "../utils/filename.js";
import { pdfToDataUrl } from "./pdf-service.js";
import { logger } from "../utils/logger.js";

export class DownloadError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "DownloadError";
    this.cause = cause;
  }
}

/**
 * Start a local download of the PDF and wait until Chrome reports that it
 * has completed (or failed).
 *
 * @param {Uint8Array} bytes
 * @param {{ date?: Date, saveAs?: boolean }} [options]
 * @returns {Promise<{ downloadId: number, filename: string, path: string }>}
 */
export async function downloadPdf(bytes, options = {}) {
  const date = options.date || new Date();
  const filename = buildBillStatusFilename(date);
  const path = buildBillStatusDownloadPath(date);
  const url = pdfToDataUrl(bytes);

  logger.info("Starting download", { path, bytes: bytes.length });

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url,
      filename: path,
      conflictAction: "uniquify",
      saveAs: options.saveAs === true
    });
  } catch (error) {
    throw new DownloadError("Chrome refused to start the download", error);
  }
  if (downloadId === undefined) {
    throw new DownloadError(chrome.runtime.lastError?.message || "Chrome did not start the download");
  }

  const finalPath = await waitForDownload(downloadId);
  const finalName = finalPath ? finalPath.split(/[\\/]/).pop() : filename;
  logger.info("Download complete", { downloadId, filename: finalName });
  return { downloadId, filename: finalName, path };
}

/**
 * Encode arbitrary bytes as a data: URL for chrome.downloads (service
 * workers have no URL.createObjectURL).
 * @param {Uint8Array} bytes
 * @param {string} [mimeType]
 * @returns {string}
 */
export function bytesToDataUrl(bytes, mimeType = "application/octet-stream") {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/**
 * Save already-downloaded bytes (for example a CRN PDF fetched from IREPS)
 * under a caller-supplied Downloads-relative path. Same conflict handling
 * and completion tracking as downloadPdf(); the Bill Status path is
 * untouched.
 *
 * @param {Uint8Array} bytes
 * @param {{ path: string, mimeType?: string, saveAs?: boolean }} options
 * @returns {Promise<{ downloadId: number, filename: string, path: string }>}
 */
export async function downloadBytes(bytes, options) {
  if (!options || !options.path) throw new DownloadError("A download path is required");
  const path = options.path;
  const url = bytesToDataUrl(bytes, options.mimeType || "application/octet-stream");
  logger.info("Starting download", { path, bytes: bytes.length });

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url,
      filename: path,
      conflictAction: "uniquify",
      saveAs: options.saveAs === true
    });
  } catch (error) {
    throw new DownloadError("Chrome refused to start the download", error);
  }
  if (downloadId === undefined) {
    throw new DownloadError(chrome.runtime.lastError?.message || "Chrome did not start the download");
  }
  const finalPath = await waitForDownload(downloadId);
  const finalName = finalPath ? finalPath.split(/[\\/]/).pop() : path.split("/").pop();
  logger.info("Download complete", { downloadId, filename: finalName });
  return { downloadId, filename: finalName, path };
}

/**
 * Resolve when the download completes; reject if Chrome interrupts it.
 * Uses onChanged when available and polls as a fallback so a missed event
 * cannot hang the workflow.
 * @param {number} downloadId
 * @returns {Promise<string|null>} final filename reported by Chrome
 */
function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(onChanged);
      fn(value);
    };

    const inspect = (item) => {
      if (!item) return;
      if (item.state === "complete") finish(resolve, item.filename || null);
      else if (item.state === "interrupted") finish(reject, new DownloadError(`Download interrupted (${item.error || "unknown"})`));
    };

    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      chrome.downloads.search({ id: downloadId }).then((items) => inspect(items[0])).catch(() => {});
    };
    chrome.downloads.onChanged.addListener(onChanged);

    const poll = setInterval(() => {
      chrome.downloads.search({ id: downloadId }).then((items) => inspect(items[0])).catch(() => {});
    }, 750);

    const timeout = setTimeout(() => {
      // A very large file may still be writing; report success with the
      // requested name rather than blocking the user.
      finish(resolve, null);
    }, 60000);
  });
}
