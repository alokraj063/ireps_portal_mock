/**
 * IREPS "Inspection Call List" (vendorInspectionCallList.do) form extraction.
 *
 * The authenticated page (POST callType=I&status=I) carries:
 *
 *   <form name="inspectionCallForm" method="post" action="/epsn/tpi/vendorInspectionCallList.do">
 *     <input type="hidden" name="org.apache.struts.taglib.html.TOKEN" value="...">
 *     <input type="hidden" name="totalRecords" value="...">
 *     <input type="hidden" name="callType" value="I">
 *     <select name="status"><option value="I">Completed / IC Issued</option></select>
 *     <input name="poNo">
 *     <select name="inspAgency"><option value="-1">Select</option>...</select>
 *     <input name="plNo"> <input name="inspOfficial"> <input name="poSr">
 *     <input name="dateFrom" value="01/01/2025"> <input name="dateTo" value="18/09/2026">
 *     <input name="dateFromIC" value="01/01/2025"> <input name="dateToIC" value="18/09/2026">
 *     <select name="stage"><option value="-1">All</option>...</select>
 *     <input type="hidden" name="statusSelected" ...>
 *   </form>
 *
 * This module reads the dynamic Struts token and the current/default form
 * values (dateFrom/dateTo/dateFromIC/dateToIC, totalRecords, inspAgency
 * options) so a PO search can preserve the portal's own defaults and only
 * override poNo - the same "load, then reuse the form's own values" approach
 * as services/ireps-form.js and services/search-po/search-po-form.js.
 *
 * Works with or without a DOMParser (the service worker has none); the token
 * is returned to the caller only - never logged or stored.
 */

import { normaliseText } from "../../utils/sanitizer.js";
import { STRUTS_TOKEN_FIELD, parseTagAttributes, decodeEntities } from "../ireps-form.js";

export const IC_FORM_NAME = "inspectionCallForm";
export const IC_FORM_ACTION = "/epsn/tpi/vendorInspectionCallList.do";

/** Field names of the inspectionCallForm, exactly as IREPS posts them. */
export const IC_FORM_FIELDS = Object.freeze({
  TOKEN: STRUTS_TOKEN_FIELD,
  PAGE_NO: "pageNo",
  TOTAL_RECORDS: "totalRecords",
  CALL_TYPE: "callType",
  STATUS: "status",
  PO_NO: "poNo",
  INSP_AGENCY: "inspAgency",
  PL_NO: "plNo",
  INSP_OFFICIAL: "inspOfficial",
  PO_SR: "poSr",
  DATE_FROM: "dateFrom",
  DATE_TO: "dateTo",
  DATE_FROM_IC: "dateFromIC",
  DATE_TO_IC: "dateToIC",
  STAGE: "stage",
  ACTIVITY: "activity",
  STATUS_SELECTED: "statusSelected"
});

/** "Completed / IC Issued" tab (the only status DocLink downloads from). */
export const IC_CALL_TYPE = "I";
export const IC_STATUS = "I";
export const IC_STATUS_SELECTED_LABEL = "Completed / IC Issued";
export const ALL_INSPECTION_AGENCIES = "-1";
export const ALL_STAGES = "-1";

/**
 * @typedef {Object} IcForm
 * @property {boolean} present                 the inspectionCallForm was found
 * @property {string|null} action
 * @property {string|null} token                dynamic Struts token (memory only)
 * @property {string|null} totalRecords
 * @property {string|null} dateFrom
 * @property {string|null} dateTo
 * @property {string|null} dateFromIC
 * @property {string|null} dateToIC
 * @property {string|null} statusSelected
 * @property {{ value: string, label: string }[]} inspectionAgencies
 * @property {{ value: string, label: string }[]} stages
 */

function emptyForm() {
  return {
    present: false,
    action: null,
    token: null,
    totalRecords: null,
    dateFrom: null,
    dateTo: null,
    dateFromIC: null,
    dateToIC: null,
    statusSelected: null,
    inspectionAgencies: [],
    stages: []
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
  const form = forms.find((f) => f.attrs.name === IC_FORM_NAME || (f.attrs.action || "").includes(IC_FORM_ACTION));
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
      options.push({ value: oa.value !== undefined ? oa.value : label, label });
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
    if (name === IC_FORM_FIELDS.TOKEN && !result.token) {
      result.token = input.attrs.value ? input.attrs.value.trim() : null;
    } else if (name === IC_FORM_FIELDS.TOTAL_RECORDS && result.totalRecords === null) {
      result.totalRecords = input.attrs.value !== undefined ? String(input.attrs.value).trim() : null;
    } else if (name === IC_FORM_FIELDS.DATE_FROM && result.dateFrom === null) {
      result.dateFrom = input.attrs.value !== undefined ? String(input.attrs.value).trim() : null;
    } else if (name === IC_FORM_FIELDS.DATE_TO && result.dateTo === null) {
      result.dateTo = input.attrs.value !== undefined ? String(input.attrs.value).trim() : null;
    } else if (name === IC_FORM_FIELDS.DATE_FROM_IC && result.dateFromIC === null) {
      result.dateFromIC = input.attrs.value !== undefined ? String(input.attrs.value).trim() : null;
    } else if (name === IC_FORM_FIELDS.DATE_TO_IC && result.dateToIC === null) {
      result.dateToIC = input.attrs.value !== undefined ? String(input.attrs.value).trim() : null;
    } else if (name === IC_FORM_FIELDS.STATUS_SELECTED && result.statusSelected === null) {
      result.statusSelected = input.attrs.value !== undefined ? String(input.attrs.value).trim() : null;
    }
  }

  result.inspectionAgencies = optionsOfSelect(scope, IC_FORM_FIELDS.INSP_AGENCY);
  result.stages = optionsOfSelect(scope, IC_FORM_FIELDS.STAGE);
  return result;
}

/* -------------------------------------------------------------------------- */
/* DOM path (offscreen document / tests)                                      */
/* -------------------------------------------------------------------------- */

function extractWithDom(html, Parser) {
  const doc = new Parser().parseFromString(String(html || ""), "text/html");
  const result = emptyForm();
  const form =
    doc.querySelector(`form[name="${IC_FORM_NAME}"]`) ||
    Array.from(doc.querySelectorAll("form")).find((f) => (f.getAttribute("action") || "").includes(IC_FORM_ACTION)) ||
    null;
  const scope = form || doc;
  result.present = !!form;
  result.action = form ? form.getAttribute("action") : null;

  const value = (name) => {
    const el = scope.querySelector(`[name="${name}"]`);
    return el && el.hasAttribute("value") ? (el.getAttribute("value") || "").trim() : null;
  };
  result.token = value(IC_FORM_FIELDS.TOKEN);
  result.totalRecords = value(IC_FORM_FIELDS.TOTAL_RECORDS);
  result.dateFrom = value(IC_FORM_FIELDS.DATE_FROM);
  result.dateTo = value(IC_FORM_FIELDS.DATE_TO);
  result.dateFromIC = value(IC_FORM_FIELDS.DATE_FROM_IC);
  result.dateToIC = value(IC_FORM_FIELDS.DATE_TO_IC);
  result.statusSelected = value(IC_FORM_FIELDS.STATUS_SELECTED);

  for (const option of Array.from(scope.querySelectorAll(`select[name="${IC_FORM_FIELDS.INSP_AGENCY}"] option`))) {
    result.inspectionAgencies.push({ value: option.hasAttribute("value") ? option.getAttribute("value") : normaliseText(option.textContent), label: normaliseText(option.textContent) });
  }
  for (const option of Array.from(scope.querySelectorAll(`select[name="${IC_FORM_FIELDS.STAGE}"] option`))) {
    result.stages.push({ value: option.hasAttribute("value") ? option.getAttribute("value") : normaliseText(option.textContent), label: normaliseText(option.textContent) });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Extract the Inspection Call List form (token, dates, dropdown options).
 *
 * @param {string} html
 * @param {{ DOMParser?: typeof DOMParser|null }} [options]  pass `DOMParser: null`
 *        to force the regex path even where a DOMParser exists.
 * @returns {IcForm}
 */
export function extractIcForm(html, options = {}) {
  const Parser = options.DOMParser === undefined ? globalThis.DOMParser : options.DOMParser;
  return Parser ? extractWithDom(html, Parser) : extractWithRegex(html);
}

/** @returns {string|null} the dynamic Struts token of the inspectionCallForm, or null. */
export function extractIcStrutsToken(html, options = {}) {
  return extractIcForm(html, options).token;
}

/**
 * Strong structural check: the page contains
 * <form name="inspectionCallForm" ... action="/epsn/tpi/vendorInspectionCallList.do">.
 * @param {string} html
 */
export function hasIcForm(html) {
  const source = String(html || "");
  if (!source.includes(IC_FORM_NAME) && !source.includes(IC_FORM_ACTION)) return false;
  return extractIcForm(source, { DOMParser: null }).present;
}

/**
 * The form without the token, safe to hand to the popup / storage.
 * @param {IcForm} form
 */
export function publicIcFormInfo(form) {
  return {
    present: form.present,
    inspectionAgencies: form.inspectionAgencies.map((a) => ({ value: a.value, label: a.label })),
    stages: form.stages.map((s) => ({ value: s.value, label: s.label }))
  };
}
