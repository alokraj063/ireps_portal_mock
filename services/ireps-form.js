/**
 * IREPS Bill Status form extraction.
 *
 * The authenticated viewBills.do page carries the search form:
 *
 *   <form name="vendorPartyCodeForm" method="post" action="/epsn/admin/viewBills.do">
 *     <input type="hidden" name="org.apache.struts.taglib.html.TOKEN" value="...">
 *     <input type="radio" name="searchRange" value="3"> Railway Zone
 *     <select name="zone"><option value="-1">All</option>...</select>
 *     <input type="radio" name="searchRange" value="2"> Select Date
 *     <input type="text" name="dateFrom"> <input type="text" name="dateTo">
 *     <input type="radio" name="searchRange" value="1" checked> Last 90 Days
 *     <input type="submit" name="submit" value="Show Results">
 *     <input type="hidden" name="searchParam" id="searchParam">
 *   </form>
 *
 * This module reads the dynamic Struts token, the zone list and the
 * searchRange controls out of that HTML. It never executes IREPS script.
 *
 * It works with or without a DOMParser: the service worker has none, so a
 * tolerant tag scanner is used there; the offscreen document and the test
 * page use the DOM path. Both paths are covered by the test-suite.
 *
 * The token is returned to the caller only; it is never logged or stored.
 */

import { normaliseText } from "../utils/sanitizer.js";

export const STRUTS_TOKEN_FIELD = "org.apache.struts.taglib.html.TOKEN";
export const BILL_STATUS_FORM_NAME = "vendorPartyCodeForm";
export const BILL_STATUS_FORM_ACTION = "/epsn/admin/viewBills.do";
export const ZONE_FIELD = "zone";
export const SEARCH_RANGE_FIELD = "searchRange";
export const ALL_ZONES_VALUE = "-1";

/**
 * @typedef {Object} BillStatusForm
 * @property {boolean} present            the vendorPartyCodeForm was found
 * @property {string|null} action         form action attribute
 * @property {string|null} token          dynamic Struts token (memory only)
 * @property {{ value: string, label: string }[]} zones
 * @property {{ value: string, label: string, checked: boolean }[]} searchRanges
 * @property {string|null} defaultSearchRange  value of the checked searchRange radio
 */

/* -------------------------------------------------------------------------- */
/* Small HTML helpers (no DOM required)                                       */
/* -------------------------------------------------------------------------- */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decode the handful of entities that appear in attribute values / labels. */
export function decodeEntities(text) {
  return String(text || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Parse the attributes of one tag ("<input type=hidden name='x' value=\"y\">"). */
export function parseTagAttributes(tag) {
  const attrs = {};
  const re = /([^\s=/<>"']+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const body = tag.replace(/^<\s*[a-zA-Z][\w:-]*/, "").replace(/\/?>$/, "");
  let m;
  while ((m = re.exec(body))) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

function stripComments(html) {
  return String(html || "").replace(/<!--[\s\S]*?-->/g, "");
}

function findAllTags(html, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ index: m.index, tag: m[0], attrs: parseTagAttributes(m[0]) });
  return out;
}

/* -------------------------------------------------------------------------- */
/* Regex path (service worker)                                                */
/* -------------------------------------------------------------------------- */

function locateForm(html) {
  const forms = findAllTags(html, "form");
  const form = forms.find((f) => f.attrs.name === BILL_STATUS_FORM_NAME || (f.attrs.action || "").includes(BILL_STATUS_FORM_ACTION));
  if (!form) return null;
  const close = html.indexOf("</form", form.index);
  return {
    action: form.attrs.action || null,
    inner: html.slice(form.index, close === -1 ? html.length : close)
  };
}

function extractWithRegex(html) {
  const clean = stripComments(html);
  const form = locateForm(clean);
  const scope = form ? form.inner : clean;
  const result = emptyForm();
  result.present = !!form;
  result.action = form ? form.action : null;

  for (const input of findAllTags(scope, "input")) {
    const name = input.attrs.name;
    if (name === STRUTS_TOKEN_FIELD && !result.token) {
      result.token = input.attrs.value ? input.attrs.value.trim() : null;
    } else if (name === SEARCH_RANGE_FIELD) {
      const value = input.attrs.value ?? "";
      const checked = "checked" in input.attrs;
      const after = scope.slice(input.index + input.tag.length, input.index + input.tag.length + 200);
      const label = normaliseText(decodeEntities(after.replace(/<[^>]+>/g, " ")).split(/\n/)[0] || "");
      result.searchRanges.push({ value, label: label.split(/\s{2,}/)[0].trim(), checked });
      if (checked && result.defaultSearchRange === null) result.defaultSearchRange = value;
    }
  }

  const selectRe = /<select\b[^>]*>([\s\S]*?)<\/select>/gi;
  let sm;
  while ((sm = selectRe.exec(scope))) {
    const attrs = parseTagAttributes(sm[0].slice(0, sm[0].indexOf(">") + 1));
    if (attrs.name !== ZONE_FIELD) continue;
    const optRe = /<option\b([^>]*)>([\s\S]*?)(?=<option\b|<\/select|$)/gi;
    let om;
    while ((om = optRe.exec(sm[1]))) {
      const oa = parseTagAttributes(`<option ${om[1]}>`);
      const label = normaliseText(decodeEntities(om[2].replace(/<\/option>/i, "").replace(/<[^>]+>/g, " ")));
      result.zones.push({ value: oa.value !== undefined ? oa.value : label, label });
    }
    break;
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* DOM path (offscreen document / tests)                                      */
/* -------------------------------------------------------------------------- */

function extractWithDom(html, Parser) {
  const doc = new Parser().parseFromString(String(html || ""), "text/html");
  const result = emptyForm();
  const form =
    doc.querySelector(`form[name="${BILL_STATUS_FORM_NAME}"]`) ||
    Array.from(doc.querySelectorAll("form")).find((f) => (f.getAttribute("action") || "").includes(BILL_STATUS_FORM_ACTION)) ||
    null;
  const scope = form || doc;
  result.present = !!form;
  result.action = form ? form.getAttribute("action") : null;

  const tokenInput = scope.querySelector(`input[name="${STRUTS_TOKEN_FIELD}"]`);
  const token = tokenInput ? (tokenInput.getAttribute("value") || "").trim() : "";
  result.token = token || null;

  for (const option of Array.from(scope.querySelectorAll(`select[name="${ZONE_FIELD}"] option`))) {
    const label = normaliseText(option.textContent);
    result.zones.push({ value: option.hasAttribute("value") ? option.getAttribute("value") : label, label });
  }

  for (const radio of Array.from(scope.querySelectorAll(`input[name="${SEARCH_RANGE_FIELD}"]`))) {
    const value = radio.getAttribute("value") ?? "";
    const checked = radio.hasAttribute("checked");
    let label = "";
    let node = radio.nextSibling;
    while (node && !label) {
      if (node.nodeType === 3) label = normaliseText(node.textContent);
      else if (node.nodeType === 1 && node.tagName !== "INPUT") label = normaliseText(node.textContent);
      node = node.nextSibling;
    }
    result.searchRanges.push({ value, label, checked });
    if (checked && result.defaultSearchRange === null) result.defaultSearchRange = value;
  }
  return result;
}

function emptyForm() {
  return { present: false, action: null, token: null, zones: [], searchRanges: [], defaultSearchRange: null };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Extract the Bill Status form (token, zones, searchRange controls).
 *
 * @param {string} html
 * @param {{ DOMParser?: typeof DOMParser|null }} [options]  pass `DOMParser: null`
 *        to force the regex path even where a DOMParser exists.
 * @returns {BillStatusForm}
 */
export function extractBillStatusForm(html, options = {}) {
  const Parser = options.DOMParser === undefined ? globalThis.DOMParser : options.DOMParser;
  return Parser ? extractWithDom(html, Parser) : extractWithRegex(html);
}

/** @returns {string|null} the dynamic Struts token, or null when absent. */
export function extractStrutsToken(html, options = {}) {
  return extractBillStatusForm(html, options).token;
}

/** @returns {{ value: string, label: string }[]} zones as listed by IREPS ("-1" = All). */
export function extractRailwayZones(html, options = {}) {
  return extractBillStatusForm(html, options).zones;
}

/** @returns {{ value: string, label: string, checked: boolean }[]} searchRange radio controls. */
export function extractSearchRanges(html, options = {}) {
  return extractBillStatusForm(html, options).searchRanges;
}

/**
 * The form without the token, safe to hand to the popup / storage.
 * @param {BillStatusForm} form
 */
export function publicFormInfo(form) {
  return {
    present: form.present,
    zones: form.zones.map((z) => ({ value: z.value, label: z.label })),
    searchRanges: form.searchRanges.map((r) => ({ value: r.value, label: r.label, checked: r.checked })),
    defaultSearchRange: form.defaultSearchRange
  };
}
