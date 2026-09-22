/**
 * IREPS "PO Search" form extraction (shared by the CRN, R-NOTE, ... searches).
 *
 * The authenticated searchPO.do page (POST searchParam=showPage) carries:
 *
 *   <form name="searchPOForm" method="post" action="/epsn/searchPO.do">
 *     <input type="hidden" name="org.apache.struts.taglib.html.TOKEN" value="...">
 *     <input type="hidden" name="pageNo" value="1">
 *     <select name="searchCriteria"> PO | RNOTE | DRR | MA | Rej | CRC | CRN | Conversation </select>
 *     <select name="rly"><option value="-1">All</option>...</select>
 *     <input type="radio" name="searchRange" value="3"> PO No.        <input name="poNo">
 *                                                                     <input name="icNo">
 *     <input type="radio" name="searchRange" value="2"> Select Date   <input name="dateFrom"> <input name="dateTo">
 *     <input type="radio" name="searchRange" value="1" checked> Last 180 Days
 *     <input type="text" name="recordsPerPage" value="20">
 *     <input type="submit" name="submit" value="Show Results">
 *     <input type="hidden" name="searchCriteria">          (second, empty field)
 *   </form>
 *
 * This module reads the dynamic Struts token, the railway list, the
 * searchCriteria options, the searchRange controls and the default
 * recordsPerPage out of that HTML. It never executes IREPS script.
 *
 * Like the Bill Status extractor it works with or without a DOMParser (the
 * service worker has none), and the token is returned to the caller only -
 * never logged or stored.
 *
 * Completely separate from services/ireps-form.js (vendorPartyCodeForm);
 * only the small attribute/entity helpers are shared.
 */

import { normaliseText } from "../../utils/sanitizer.js";
import { STRUTS_TOKEN_FIELD, parseTagAttributes, decodeEntities } from "../ireps-form.js";

export const SEARCH_PO_FORM_NAME = "searchPOForm";
export const SEARCH_PO_FORM_ACTION = "/epsn/searchPO.do";

/** Field names of the searchPOForm, exactly as IREPS posts them. */
export const SEARCH_PO_FORM_FIELDS = Object.freeze({
  TOKEN: STRUTS_TOKEN_FIELD,
  PAGE_NO: "pageNo",
  SEARCH_CRITERIA: "searchCriteria",
  RAILWAY: "rly",
  PO_NO: "poNo",
  IC_NO: "icNo",
  DATE_FROM: "dateFrom",
  DATE_TO: "dateTo",
  SEARCH_RANGE: "searchRange",
  RECORDS_PER_PAGE: "recordsPerPage",
  SUBMIT: "submit"
});

export const ALL_RAILWAYS_VALUE = "-1";

/**
 * @typedef {Object} SearchPoForm
 * @property {boolean} present                 the searchPOForm was found
 * @property {string|null} action              form action attribute
 * @property {string|null} token               dynamic Struts token (memory only)
 * @property {{ value: string, label: string }[]} railways            <select name="rly">
 * @property {{ value: string, label: string, selected: boolean }[]} searchCriteria  <select name="searchCriteria">
 * @property {{ value: string, label: string, checked: boolean }[]} searchRanges
 * @property {string|null} defaultSearchRange  value of the checked searchRange radio
 * @property {string|null} defaultRecordsPerPage value of <input name="recordsPerPage">
 * @property {number} searchCriteriaFieldCount how many controls named searchCriteria exist (select + hidden = 2)
 */

function emptyForm() {
  return {
    present: false,
    action: null,
    token: null,
    railways: [],
    searchCriteria: [],
    searchRanges: [],
    defaultSearchRange: null,
    defaultRecordsPerPage: null,
    searchCriteriaFieldCount: 0
  };
}

/* -------------------------------------------------------------------------- */
/* Regex path (service worker, no DOM)                                        */
/* -------------------------------------------------------------------------- */

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

function locateForm(html) {
  const forms = findAllTags(html, "form");
  const form = forms.find((f) => f.attrs.name === SEARCH_PO_FORM_NAME || (f.attrs.action || "").includes(SEARCH_PO_FORM_ACTION));
  if (!form) return null;
  const close = html.indexOf("</form", form.index);
  return { action: form.attrs.action || null, inner: html.slice(form.index, close === -1 ? html.length : close) };
}

function optionsOfSelect(scopeHtml, name) {
  const selectRe = /<select\b[^>]*>([\s\S]*?)<\/select>/gi;
  let sm;
  while ((sm = selectRe.exec(scopeHtml))) {
    const attrs = parseTagAttributes(sm[0].slice(0, sm[0].indexOf(">") + 1));
    if (attrs.name !== name) continue;
    const options = [];
    const optRe = /<option\b([^>]*)>([\s\S]*?)(?=<option\b|<\/select|$)/gi;
    let om;
    while ((om = optRe.exec(sm[1]))) {
      const oa = parseTagAttributes(`<option ${om[1]}>`);
      const label = normaliseText(decodeEntities(om[2].replace(/<\/option>/i, "").replace(/<[^>]+>/g, " ")));
      options.push({ value: oa.value !== undefined ? oa.value : label, label, selected: "selected" in oa });
    }
    return options;
  }
  return [];
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
    } else if (name === SEARCH_PO_FORM_FIELDS.SEARCH_RANGE) {
      const value = input.attrs.value ?? "";
      const checked = "checked" in input.attrs;
      const after = scope.slice(input.index + input.tag.length, input.index + input.tag.length + 200);
      const label = normaliseText(decodeEntities(after.replace(/<[^>]+>/g, " ")).split(/\n/)[0] || "");
      result.searchRanges.push({ value, label: label.split(/\s{2,}/)[0].trim(), checked });
      if (checked && result.defaultSearchRange === null) result.defaultSearchRange = value;
    } else if (name === SEARCH_PO_FORM_FIELDS.RECORDS_PER_PAGE && result.defaultRecordsPerPage === null) {
      result.defaultRecordsPerPage = input.attrs.value !== undefined ? String(input.attrs.value).trim() : null;
    } else if (name === SEARCH_PO_FORM_FIELDS.SEARCH_CRITERIA) {
      result.searchCriteriaFieldCount++;
    }
  }
  for (const select of findAllTags(scope, "select")) {
    if (select.attrs.name === SEARCH_PO_FORM_FIELDS.SEARCH_CRITERIA) result.searchCriteriaFieldCount++;
  }

  result.railways = optionsOfSelect(scope, SEARCH_PO_FORM_FIELDS.RAILWAY).map(({ value, label }) => ({ value, label }));
  result.searchCriteria = optionsOfSelect(scope, SEARCH_PO_FORM_FIELDS.SEARCH_CRITERIA);
  return result;
}

/* -------------------------------------------------------------------------- */
/* DOM path (offscreen document / tests)                                      */
/* -------------------------------------------------------------------------- */

function extractWithDom(html, Parser) {
  const doc = new Parser().parseFromString(String(html || ""), "text/html");
  const result = emptyForm();
  const form =
    doc.querySelector(`form[name="${SEARCH_PO_FORM_NAME}"]`) ||
    Array.from(doc.querySelectorAll("form")).find((f) => (f.getAttribute("action") || "").includes(SEARCH_PO_FORM_ACTION)) ||
    null;
  const scope = form || doc;
  result.present = !!form;
  result.action = form ? form.getAttribute("action") : null;

  const tokenInput = scope.querySelector(`input[name="${STRUTS_TOKEN_FIELD}"]`);
  const token = tokenInput ? (tokenInput.getAttribute("value") || "").trim() : "";
  result.token = token || null;

  for (const option of Array.from(scope.querySelectorAll(`select[name="${SEARCH_PO_FORM_FIELDS.RAILWAY}"] option`))) {
    const label = normaliseText(option.textContent);
    result.railways.push({ value: option.hasAttribute("value") ? option.getAttribute("value") : label, label });
  }
  for (const option of Array.from(scope.querySelectorAll(`select[name="${SEARCH_PO_FORM_FIELDS.SEARCH_CRITERIA}"] option`))) {
    const label = normaliseText(option.textContent);
    result.searchCriteria.push({
      value: option.hasAttribute("value") ? option.getAttribute("value") : label,
      label,
      selected: option.hasAttribute("selected")
    });
  }
  result.searchCriteriaFieldCount = scope.querySelectorAll(`[name="${SEARCH_PO_FORM_FIELDS.SEARCH_CRITERIA}"]`).length;

  for (const radio of Array.from(scope.querySelectorAll(`input[name="${SEARCH_PO_FORM_FIELDS.SEARCH_RANGE}"]`))) {
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

  const rpp = scope.querySelector(`input[name="${SEARCH_PO_FORM_FIELDS.RECORDS_PER_PAGE}"]`);
  result.defaultRecordsPerPage = rpp && rpp.hasAttribute("value") ? (rpp.getAttribute("value") || "").trim() : null;
  return result;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Extract the PO Search form (token, railways, criteria, searchRange controls).
 *
 * @param {string} html
 * @param {{ DOMParser?: typeof DOMParser|null }} [options]  pass `DOMParser: null`
 *        to force the regex path even where a DOMParser exists.
 * @returns {SearchPoForm}
 */
export function extractSearchPoForm(html, options = {}) {
  const Parser = options.DOMParser === undefined ? globalThis.DOMParser : options.DOMParser;
  return Parser ? extractWithDom(html, Parser) : extractWithRegex(html);
}

/** @returns {string|null} the dynamic Struts token of the searchPOForm, or null. */
export function extractSearchPoStrutsToken(html, options = {}) {
  return extractSearchPoForm(html, options).token;
}

/** @returns {{ value: string, label: string }[]} railways as listed by IREPS ("-1" = All). */
export function extractSearchPoRailways(html, options = {}) {
  return extractSearchPoForm(html, options).railways;
}

/**
 * Strong structural check: the page contains
 * <form name="searchPOForm" ... action="/epsn/searchPO.do">.
 * @param {string} html
 */
export function hasSearchPoForm(html) {
  const source = String(html || "");
  if (!source.includes(SEARCH_PO_FORM_NAME) && !source.includes(SEARCH_PO_FORM_ACTION)) return false;
  return extractSearchPoForm(source, { DOMParser: null }).present;
}

/**
 * The form without the token, safe to hand to the popup / storage.
 * @param {SearchPoForm} form
 */
export function publicSearchPoFormInfo(form) {
  return {
    present: form.present,
    railways: form.railways.map((r) => ({ value: r.value, label: r.label })),
    searchCriteria: form.searchCriteria.map((c) => ({ value: c.value, label: c.label, selected: c.selected })),
    searchRanges: form.searchRanges.map((r) => ({ value: r.value, label: r.label, checked: r.checked })),
    defaultSearchRange: form.defaultSearchRange,
    defaultRecordsPerPage: form.defaultRecordsPerPage
  };
}
