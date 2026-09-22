/**
 * PO Search document view of the DocLink popup: CRN and R-NOTE downloads.
 *
 * Both document types share one view (the form controls are the same IREPS
 * PO Search controls); the card the user clicked decides the `criteria`
 * sent to the service worker. The popup stays a thin view: it sends
 * SEARCH_PO_LOAD_FORM (railway list + session check) and
 * DOWNLOAD_IREPS_DOCUMENTS { criteria, options } and renders the progress /
 * result / error messages it receives back. The search and the export run
 * in the service worker, so they continue even if the popup is closed;
 * reopening restores the state via GET_DOCUMENT_JOB_STATE.
 *
 * The downloaded file is whatever format the user picked (Excel .xlsx by
 * default, CSV optional) - nothing in this view assumes a PDF.
 */

import { MESSAGE_TYPES, DOCUMENT_STAGES, documentStageLabel, describeError } from "../utils/messages.js";
import { EXPORT_FORMATS } from "../services/search-po/search-po-export.js";
import { SEARCH_PO_DOCUMENT_TYPES, SEARCH_PO_CRITERIA } from "../services/search-po/search-po-api.js";

const $ = (id) => document.getElementById(id);
const ALL_RAILWAYS = "-1";
const STAGE_ORDER = ["CHECKING_SESSION", "CONNECTED", "SEARCHING", "PAGING", "PARSING", "GENERATING_FILE", "DOWNLOADING", "COMPLETE"];
const STEP_FOR_STAGE = {
  CHECKING_SESSION: "CHECKING_SESSION",
  CONNECTED: "CHECKING_SESSION",
  SEARCHING: "SEARCHING",
  PAGING: "SEARCHING",
  PARSING: "PARSING",
  GENERATING_FILE: "GENERATING_FILE",
  DOWNLOADING: "DOWNLOADING",
  COMPLETE: "DOWNLOADING"
};
const INTRO = {
  [SEARCH_PO_CRITERIA.CRN]: "Runs the IREPS PO Search for Consignment Receipt Notes and downloads every result row (like the portal's Export to Excel, but complete).",
  [SEARCH_PO_CRITERIA.RNOTE]: "Runs the IREPS PO Search for Receipt Notes and downloads every result row (like the portal's Export to Excel, but complete)."
};

let ctx = null;
let criteria = SEARCH_PO_CRITERIA.CRN;
const el = {};

function bindElements() {
  Object.assign(el, {
    view: $("view-document"),
    openButtons: Array.from(document.querySelectorAll("button[data-criteria]")),
    title: $("doc-title"),
    intro: $("doc-intro"),
    btnBack: $("btn-doc-back"),
    form: $("doc-form"),
    rly: $("doc-rly"),
    options: $("doc-options"),
    optionsSummary: $("doc-options-summary"),
    po: $("doc-po"),
    dateFrom: $("doc-date-from"),
    dateTo: $("doc-date-to"),
    format: $("doc-format"),
    btnDownload: $("btn-doc-download"),
    btnLabel: $("btn-doc-label"),
    progress: $("doc-progress"),
    steps: Array.from(document.querySelectorAll("#doc-steps li")),
    stepSearch: $("doc-step-search"),
    stepParse: $("doc-step-parse"),
    progressMessage: $("doc-progress-message"),
    resultError: $("doc-result-error"),
    errorTitle: $("doc-error-title"),
    errorMessage: $("doc-error-message"),
    btnOpenIreps: $("btn-doc-open-ireps"),
    btnRetry: $("btn-doc-retry")
  });
}

function typeInfo(c = criteria) {
  return SEARCH_PO_DOCUMENT_TYPES.find((t) => t.criteria === c) || SEARCH_PO_DOCUMENT_TYPES[0];
}

/** Switch the shared view to one document type (labels only; the form stays). */
function applyCriteria(next) {
  criteria = SEARCH_PO_DOCUMENT_TYPES.some((t) => t.criteria === next) ? next : SEARCH_PO_CRITERIA.CRN;
  const label = typeInfo().shortLabel;
  el.title.textContent = `IREPS ${label} Download`;
  el.intro.textContent = INTRO[criteria] || INTRO[SEARCH_PO_CRITERIA.CRN];
  el.btnLabel.textContent = `Download ${label}`;
  el.stepSearch.textContent = `Searching ${label}s`;
  el.stepParse.textContent = `Reading ${label} records`;
  el.view.dataset.criteria = criteria;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/** "2026-08-01" (input[type=date]) -> "01/08/2026" (IREPS). */
function toIrepsDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

function collectOptions() {
  const railway = el.rly.value || ALL_RAILWAYS;
  const format = el.format.value || EXPORT_FORMATS[0].value;
  const poNo = el.po.value.trim();
  const dateFrom = toIrepsDate(el.dateFrom.value);
  const dateTo = toIrepsDate(el.dateTo.value);
  if (poNo) return { mode: "poNumber", railway, poNo, format };
  if (dateFrom || dateTo) return { mode: "dateRange", railway, dateFrom, dateTo, format };
  return { mode: "last180Days", railway, format };
}

function describeOptions(options) {
  const rlyLabel = options.railway === ALL_RAILWAYS ? "All Railways" : el.rly.selectedOptions[0]?.textContent || options.railway;
  const fmt = (EXPORT_FORMATS.find((f) => f.value === options.format) || EXPORT_FORMATS[0]).label;
  if (options.mode === "poNumber") return `PO No. ${options.poNo}, ${rlyLabel} · ${fmt}`;
  if (options.mode === "dateRange") return `${options.dateFrom || "…"} to ${options.dateTo || "…"}, ${rlyLabel} · ${fmt}`;
  return `Last 180 Days, ${rlyLabel} · ${fmt}`;
}

function updateOptionsSummary() {
  el.optionsSummary.textContent = describeOptions(collectOptions());
}

function populateFormats() {
  el.format.replaceChildren();
  for (const f of EXPORT_FORMATS) {
    const option = document.createElement("option");
    option.value = f.value;
    option.textContent = f.label;
    el.format.append(option);
  }
}

/** Fill the railway list from the IREPS PO Search form (values come from the page, never hard-coded). */
function populateRailways(railways) {
  if (!Array.isArray(railways) || railways.length === 0) return;
  const current = el.rly.value;
  el.rly.replaceChildren();
  for (const r of railways) {
    const option = document.createElement("option");
    option.value = r.value;
    option.textContent = r.label;
    el.rly.append(option);
  }
  el.rly.value = railways.some((r) => r.value === current) ? current : ALL_RAILWAYS;
  updateOptionsSummary();
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function setButtonBusy(busy, label) {
  el.btnDownload.disabled = busy;
  el.btnDownload.classList.toggle("is-busy", busy);
  el.btnLabel.textContent = label || `Download ${typeInfo().shortLabel}`;
}

function resetResults() {
  ctx.hideResult();
  el.resultError.hidden = true;
  el.resultError.classList.remove("is-notice");
  el.btnOpenIreps.hidden = true;
}

function renderProgress(stageId, message) {
  ctx.showView("document");
  resetResults();
  el.progress.hidden = false;
  const index = STAGE_ORDER.indexOf(stageId);
  const activeStep = STEP_FOR_STAGE[stageId];
  el.steps.forEach((li) => {
    const stepIndex = STAGE_ORDER.indexOf(li.dataset.stage);
    li.classList.toggle("is-active", li.dataset.stage === activeStep && stageId !== "COMPLETE");
    li.classList.toggle("is-done", stepIndex < index && li.dataset.stage !== activeStep);
  });
  el.progressMessage.textContent = message || "";
  setButtonBusy(true, message || "Working...");
  if (index >= STAGE_ORDER.indexOf("CONNECTED")) ctx.setConnection("connected", "Connected");
}

/** Back to the main screen with the details in the bottom result panel. */
function renderComplete(summary) {
  resetResults();
  el.progress.hidden = true;
  el.options.open = false;
  setButtonBusy(false);
  ctx.setConnection("connected", "Connected");
  if (summary.form && summary.form.railways) populateRailways(summary.form.railways);
  const label = typeInfo().shortLabel;
  const n = summary.recordCount ?? 0;
  const pages = summary.pagesFetched > 1 ? ` across ${summary.pagesFetched} result pages` : "";
  const fmt = (EXPORT_FORMATS.find((f) => f.value === summary.format) || EXPORT_FORMATS[0]).label;
  ctx.showResult({
    title: `✓ ${label} export downloaded successfully`,
    summary: `${label} records exported: ${n}${pages} (${fmt})`,
    filter: summary.filter ? `Search: ${summary.filter}` : "",
    filename: summary.filename || "",
    downloadId: summary.downloadId ?? null
  });
}

function renderError(error) {
  const described = error && error.title ? error : describeError((error && error.code) || "UNKNOWN");
  el.progress.hidden = true;
  setButtonBusy(false);
  ctx.setConnectionForError(described);
  if (described.loginRequired) {
    ctx.showLogin(described);
    return;
  }
  ctx.showView("document");
  resetResults();
  el.errorTitle.textContent = described.title;
  el.errorMessage.textContent = described.message;
  el.btnOpenIreps.hidden = described.connection !== "login";
  el.resultError.classList.toggle("is-notice", described.notice === true);
  el.resultError.hidden = false;
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

async function loadForm(force = false) {
  const info = await ctx.send(MESSAGE_TYPES.SEARCH_PO_LOAD_FORM, { force });
  if (!info) {
    ctx.setConnection("offline", "Unavailable");
    return null;
  }
  if (info.authenticated) {
    ctx.setConnection("connected", "Connected");
    if (info.form && info.form.railways) populateRailways(info.form.railways);
  } else {
    const described = describeError(info.code || "UNKNOWN", { status: info.status, detail: info.detail });
    ctx.setConnectionForError(described);
    if (described.loginRequired) ctx.showLogin(described);
  }
  return info;
}

async function openView(next) {
  applyCriteria(next);
  ctx.showView("document");
  el.resultError.hidden = true;
  el.resultError.classList.remove("is-notice");
  el.btnOpenIreps.hidden = true;
  el.progress.hidden = true;
  setButtonBusy(false);
  updateOptionsSummary();
  const state = await ctx.send(MESSAGE_TYPES.GET_DOCUMENT_JOB_STATE, { criteria });
  if (state && state.running && state.running !== criteria) {
    renderError(describeError("DOCUMENT_BUSY"));
  } else if (state && state.status === "running") {
    renderProgress(state.stage, state.message);
    return;
  }
  await loadForm(false);
}

async function startDownload(event) {
  if (event) event.preventDefault();
  const options = collectOptions();
  if (options.mode === "dateRange" && (!options.dateFrom || !options.dateTo)) {
    renderError(describeError("IREPS_INVALID_REQUEST", { detail: "Please choose both From and To dates for the date range search." }));
    return;
  }
  resetResults();
  el.options.open = false;
  renderProgress("CHECKING_SESSION", documentStageLabel(DOCUMENT_STAGES.CHECKING_SESSION, typeInfo().shortLabel));
  const response = await ctx.send(MESSAGE_TYPES.DOWNLOAD_IREPS_DOCUMENTS, { criteria, options });
  if (!response) renderError(describeError("UNKNOWN"));
  else if (response.started === false) renderError(response.error || describeError("DOCUMENT_BUSY"));
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @param {{ send: Function, showView: Function, setConnection: Function, setConnectionForError: Function, showLogin: Function, showResult: Function, hideResult: Function }} context
 */
export function initDocuments(context) {
  ctx = context;
  bindElements();
  populateFormats();
  for (const button of el.openButtons) button.addEventListener("click", () => openView(button.dataset.criteria));
  el.btnBack.addEventListener("click", () => ctx.showView("main"));
  el.form.addEventListener("submit", startDownload);
  el.btnRetry.addEventListener("click", startDownload);
  el.rly.addEventListener("change", updateOptionsSummary);
  el.po.addEventListener("input", updateOptionsSummary);
  el.dateFrom.addEventListener("change", updateOptionsSummary);
  el.dateTo.addEventListener("change", updateOptionsSummary);
  el.format.addEventListener("change", updateOptionsSummary);
  el.btnOpenIreps.addEventListener("click", () => ctx.send(MESSAGE_TYPES.OPEN_IREPS));
  applyCriteria(SEARCH_PO_CRITERIA.CRN);
  updateOptionsSummary();
}

/** Route document broadcasts from the service worker. Returns true when handled. */
export function handleDocumentMessage(message) {
  switch (message.type) {
    case MESSAGE_TYPES.DOCUMENT_PROGRESS:
      if (message.criteria && message.criteria !== criteria) applyCriteria(message.criteria);
      renderProgress(message.stage, message.message);
      return true;
    case MESSAGE_TYPES.DOCUMENT_DOWNLOAD_COMPLETE:
      if (message.criteria && message.criteria !== criteria) applyCriteria(message.criteria);
      renderComplete(message);
      return true;
    case MESSAGE_TYPES.DOCUMENT_DOWNLOAD_ERROR:
      if (message.criteria && message.criteria !== criteria) applyCriteria(message.criteria);
      renderError(message);
      return true;
    default:
      return false;
  }
}

/**
 * Called once at popup start-up. Restores a running CRN / R-NOTE job into the
 * document view, or a recently finished one into the main view's bottom
 * result panel; returns true when it did.
 */
export async function restoreDocuments() {
  for (const type of SEARCH_PO_DOCUMENT_TYPES) {
    const state = await ctx.send(MESSAGE_TYPES.GET_DOCUMENT_JOB_STATE, { criteria: type.criteria });
    if (!state || state.status === "idle") continue;
    const fresh = Date.now() - (state.updatedAt || 0) < 10 * 60 * 1000;
    if (state.status === "running") {
      applyCriteria(type.criteria);
      renderProgress(state.stage, state.message);
      return true;
    }
    if (!fresh) continue;
    if (state.status === "complete" && state.result) {
      applyCriteria(type.criteria);
      renderComplete(state.result);
      return true;
    }
    if (state.status === "error" && state.error) {
      applyCriteria(type.criteria);
      renderError(state.error);
      return true;
    }
  }
  return false;
}
