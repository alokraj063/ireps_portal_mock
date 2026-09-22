/**
 * IREPS session service.
 *
 * DocLink does not track a session id. "Logged in" means exactly one thing:
 * IREPS answered the authenticated request with the Bill Status page
 * (vendorPartyCodeForm posting to /epsn/admin/viewBills.do) instead of a
 * login / session-expired page. The checks below inspect the response
 * content because IREPS (like many Struts applications) can return a login
 * page with HTTP 200 once the session has expired.
 */

import { loadBillStatusPage, IREPS_CONFIG, IREPS_ERROR, IrepsError } from "./ireps-api.js";
import { extractBillStatusForm, BILL_STATUS_FORM_NAME, BILL_STATUS_FORM_ACTION } from "./ireps-form.js";
import { logger } from "../utils/logger.js";

/** Phrases that strongly indicate an expired / invalid session. */
export const SESSION_EXPIRED_MARKERS = [
  "session expired",
  "session has expired",
  "session has been expired",
  "session timed out",
  "session time out",
  "session timeout",
  "invalid session",
  "session is invalid",
  "please login again",
  "please log in again",
  "login again",
  "re-login",
  "relogin"
];

/** Phrases that suggest a login page (weaker, checked when no bill data). */
export const LOGIN_MARKERS = [
  "security key",
  "digital signature",
  "user id",
  "user name",
  "username",
  "password",
  "sign in",
  "signin",
  "login",
  "log in",
  "authentication",
  "authenticate"
];

/** Phrases expected on the authenticated Bill Status page (legacy / fallback). */
export const BILL_STATUS_MARKERS = [
  "view bills",
  "bill status",
  "contract no",
  "contract number",
  "bill no",
  "bill number",
  "co6",
  "co7",
  "payment advice",
  "party name",
  "party code",
  "partycode",
  "accounting unit",
  "passed amt",
  "passed amount",
  "net amt",
  "net amount",
  "railway zone",
  "last 90 days",
  "show results"
];

/** Phrases IREPS shows when the query succeeded but found nothing. */
export const NO_RECORDS_MARKERS = [
  "no record found",
  "no records found",
  "no record(s) found",
  "no bill found",
  "no bills found",
  "no data found",
  "no data available",
  "record not found",
  "records not found"
];

function textOf(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function countMarkers(text, markers) {
  return markers.filter((m) => text.includes(m)).length;
}

function hasPasswordField(html) {
  return /<input[^>]+type\s*=\s*["']?password/i.test(html || "");
}

function urlLooksLikeLogin(url) {
  if (!url) return false;
  try {
    const path = new URL(url).pathname.toLowerCase();
    return /login|logon|signin|session|expired|timeout|error/.test(path);
  } catch {
    return false;
  }
}

/**
 * Strong structural check: the real page contains
 * <form name="vendorPartyCodeForm" ... action="/epsn/admin/viewBills.do">.
 * @param {string} html
 */
export function hasBillStatusForm(html) {
  const source = String(html || "");
  if (!source.includes(BILL_STATUS_FORM_NAME) || !source.includes(BILL_STATUS_FORM_ACTION)) return false;
  return extractBillStatusForm(source, { DOMParser: null }).present;
}

/**
 * Does this HTML look like the IREPS login (or session expired) page?
 * @param {string} html
 * @param {{ url?: string, redirected?: boolean }} [response]
 * @returns {boolean}
 */
export function isIrepsLoginPage(html, response = {}) {
  const text = textOf(html);
  if (countMarkers(text, SESSION_EXPIRED_MARKERS) > 0) return true;
  if (hasPasswordField(html)) return true;
  if (response.redirected && urlLooksLikeLogin(response.url)) return true;
  if (hasBillStatusForm(html)) return false;
  const billScore = countMarkers(text, BILL_STATUS_MARKERS);
  const loginScore = countMarkers(text, LOGIN_MARKERS);
  // Authenticated pages usually still carry a "Logout" link and a few login
  // words in menus; only treat it as a login page when bill data is absent.
  return billScore < 2 && loginScore >= 2;
}

/**
 * Does this HTML look like the authenticated Bill Status page?
 * @param {string} html
 * @returns {boolean}
 */
export function isIrepsBillStatusPage(html) {
  if (!html || html.length < IREPS_CONFIG.minimumHtmlLength) return false;
  const text = textOf(html);
  if (countMarkers(text, SESSION_EXPIRED_MARKERS) > 0) return false;
  if (hasPasswordField(html)) return false;
  if (hasBillStatusForm(html)) return true;
  // Legacy layouts (no vendorPartyCodeForm): rely on vocabulary.
  return countMarkers(text, BILL_STATUS_MARKERS) >= 2;
}

/**
 * Does the page say "no records" for the selected period?
 * @param {string} html
 */
export function isNoRecordsPage(html) {
  return countMarkers(textOf(html), NO_RECORDS_MARKERS) > 0;
}

/**
 * Validate an IREPS response and decide whether the user is authenticated.
 *
 * @param {string} html
 * @param {{ ok?: boolean, status?: number, url?: string, redirected?: boolean }} [response]
 * @returns {{ authenticated: boolean, reason: string|null, code: SessionCode, status?: number|null }}
 */
export function validateIrepsSession(html, response = {}) {
  if (response.status !== undefined && response.ok === false) {
    return {
      authenticated: false,
      reason: `IREPS returned HTTP ${response.status}`,
      code: IREPS_ERROR.REQUEST_FAILED,
      status: response.status
    };
  }
  if (!html || html.trim().length === 0) {
    return { authenticated: false, reason: "IREPS returned an empty response", code: IREPS_ERROR.INVALID_RESPONSE };
  }
  if (isIrepsLoginPage(html, response)) {
    const expired = countMarkers(textOf(html), SESSION_EXPIRED_MARKERS) > 0;
    return {
      authenticated: false,
      reason: expired ? "IREPS session expired" : "IREPS login required",
      code: IREPS_ERROR.SESSION_EXPIRED
    };
  }
  if (isIrepsBillStatusPage(html)) {
    return { authenticated: true, reason: null, code: "OK" };
  }
  return {
    authenticated: false,
    reason: "IREPS response was not recognised as the Bill Status page",
    code: IREPS_ERROR.INVALID_RESPONSE
  };
}

/**
 * Perform a live check against IREPS using the browser session: load the
 * Bill Status page (POST, empty body) and validate it. The HTML is returned
 * so the caller can extract the Struts token without a second request.
 *
 * @param {{ fetch?: typeof fetch }} [deps]
 * @returns {Promise<SessionCheckResult>}
 */
export async function checkIrepsSession(deps = {}) {
  logger.info("Checking IREPS session");
  try {
    const response = await loadBillStatusPage(deps);
    const verdict = validateIrepsSession(response.html, response);
    logger.info("Session check result", { code: verdict.code, status: response.status });
    return {
      ...verdict,
      status: response.status,
      html: verdict.authenticated ? response.html : null,
      response
    };
  } catch (error) {
    if (error instanceof IrepsError) {
      logger.warn("Session check failed", { code: error.code, reason: error.reason, status: error.status });
      return {
        authenticated: false,
        reason: error.message,
        code: error.code,
        requestReason: error.reason,
        detail: error.detail,
        status: error.status,
        html: null,
        response: null
      };
    }
    logger.error("Unexpected session check failure", error);
    return {
      authenticated: false,
      reason: "Unexpected error while contacting IREPS",
      code: IREPS_ERROR.REQUEST_FAILED,
      requestReason: "unknown",
      detail: null,
      status: null,
      html: null,
      response: null
    };
  }
}

/**
 * @typedef {"OK"|"IREPS_SESSION_EXPIRED"|"IREPS_REQUEST_FAILED"|"IREPS_INVALID_RESPONSE"} SessionCode
 *
 * @typedef {Object} SessionCheckResult
 * @property {boolean} authenticated
 * @property {string|null} reason
 * @property {SessionCode} code
 * @property {number|null} status
 * @property {string|null} html   Bill Status HTML when authenticated
 * @property {import("./ireps-api.js").IrepsResponse|null} response
 */
