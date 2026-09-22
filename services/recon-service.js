/**
 * Recon Engine sender (optional, disabled by default).
 *
 * Retrieval and sending are deliberately separate: the Bill Status download
 * completes (PDF saved, popup updated) whether or not this module succeeds.
 * The service worker calls sendBillStatusToRecon() after the local download
 * and only logs the outcome.
 *
 * To enable: set RECON_CONFIG.enabled = true, fill in `endpoint`, and add the
 * endpoint origin to manifest.json host_permissions. The payload contains
 * only normalised bill records and request metadata; never the IREPS HTML,
 * the Struts token or any cookie.
 */

import { logger } from "../utils/logger.js";

export const RECON_CONFIG = Object.freeze({
  enabled: false,
  endpoint: "",
  timeoutMs: 30000
});

/**
 * @param {{ request: object, fetchedAt: string, recordCount: number, bills: object[], filter: string }} result
 * @param {{ fetch?: typeof fetch }} [deps]
 * @returns {Promise<{ sent: boolean, skipped?: boolean, status?: number, error?: string }>}
 */
export async function sendBillStatusToRecon(result, deps = {}) {
  if (!RECON_CONFIG.enabled || !RECON_CONFIG.endpoint) return { sent: false, skipped: true };
  const fetchImpl = deps.fetch || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECON_CONFIG.timeoutMs);
  try {
    const response = await fetchImpl(RECON_CONFIG.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "IREPS",
        document: "BILL_STATUS",
        request: result.request,
        filter: result.filter,
        fetchedAt: result.fetchedAt,
        recordCount: result.recordCount,
        bills: result.bills
      }),
      signal: controller.signal
    });
    logger.info("Recon Engine response", { status: response.status });
    return { sent: response.ok, status: response.status };
  } catch (error) {
    logger.warn("Recon Engine unavailable; Bill Status was still downloaded locally", error);
    return { sent: false, error: error && error.message ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
