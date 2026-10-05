/**
 * CRN and R-NOTE cards of the DocLink side panel (IREPS PO Search downloads).
 *
 * Each document type has its own card on the main screen, laid out like the
 * Bill Status card: a collapsible "Search options" section (the IREPS PO
 * Search controls: Last 180 Days / Select Date / PO No., Railway, and the
 * export file format), a Download button that starts right away, and the
 * progress and error display inside the card. The card body comes from
 * <template id="tpl-doc-card"> in popup.html; one controller per card.
 *
 * The panel stays a thin view: it sends SEARCH_PO_LOAD_FORM (railway list,
 * loaded the first time a card's options are opened) and
 * DOWNLOAD_IREPS_DOCUMENTS { criteria, options }, and renders the progress /
 * result / error messages it receives back. The search and the export run in
 * the service worker, so they continue even if the panel is closed;
 * reopening restores the state via GET_DOCUMENT_JOB_STATE. Only one PO
 * Search job runs at a time (the portal's single-use form token), so while
 * one card is busy the other card's Download is refused with a clear message.
 *
 * The downloaded file is whatever format the user picked (Excel .xlsx by
 * default, CSV optional) - nothing here assumes a PDF.
 */

import { MESSAGE_TYPES, DOCUMENT_STAGES, documentStageLabel, describeError } from "../utils/messages.js";
import { EXPORT_FORMATS } from "../services/search-po/search-po-export.js";
import { SEARCH_PO_DOCUMENT_TYPES, SEARCH_PO_CRITERIA } from "../services/search-po/search-po-api.js";

const ALL_RAILWAYS = "-1";
/** The document types that have a card here (PO and MA have their own views). */
const CARD_CRITERIA = [SEARCH_PO_CRITERIA.CRN, SEARCH_PO_CRITERIA.RNOTE];
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

let ctx = null;
/** @type {Map<string, DocumentCard>} */
const cards = new Map();
/** Railway list from the IREPS PO Search page, shared by both cards. */
let railways = null;
let railwaysLoading = null;

/** "2026-08-01" (input[type=date]) -> "01/08/2026" (IREPS). */
function toIrepsDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

function formatLabel(value) {
  return (EXPORT_FORMATS.find((f) => f.value === value) || EXPORT_FORMATS[0]).label;
}

/* -------------------------------------------------------------------------- */
/* One card                                                                   */
/* -------------------------------------------------------------------------- */

class DocumentCard {
  /** @param {HTMLElement} root  the <article data-criteria> */
  constructor(root) {
    this.criteria = root.dataset.criteria;
    this.label = (SEARCH_PO_DOCUMENT_TYPES.find((t) => t.criteria === this.criteria) || {}).shortLabel || this.criteria;
    root.append(document.getElementById("tpl-doc-card").content.cloneNode(true));
    const q = (role) => root.querySelector(`[data-role="${role}"]`);
    this.el = {
      root,
      options: q("options"),
      summary: q("summary"),
      ranges: Array.from(root.querySelectorAll('[data-role="range"]')),
      dateRow: q("date-row"),
      dateFrom: q("date-from"),
      dateTo: q("date-to"),
      poRow: q("po-row"),
      po: q("po"),
      rly: q("rly"),
      format: q("format"),
      btnDownload: q("download"),
      btnLabel: q("label"),
      progress: q("progress"),
      steps: Array.from(root.querySelectorAll(".steps li")),
      progressMessage: q("progress-message"),
      error: q("error"),
      errorTitle: q("error-title"),
      errorMessage: q("error-message"),
      btnOpenIreps: q("open-ireps"),
      btnRetry: q("retry")
    };
    const el = this.el;
    // Radio groups need a name unique to this card.
    for (const radio of el.ranges) radio.name = `${this.criteria.toLowerCase()}-range`;
    q("step-search").textContent = `Searching ${this.label}s`;
    q("step-parse").textContent = `Reading ${this.label} records`;
    for (const f of EXPORT_FORMATS) {
      const option = document.createElement("option");
      option.value = f.value;
      option.textContent = f.label;
      el.format.append(option);
    }
    if (railways) this.setRailways(railways);

    const update = () => this.updateSummary();
    for (const radio of el.ranges) radio.addEventListener("change", update);
    for (const input of [el.dateFrom, el.dateTo, el.rly, el.format]) input.addEventListener("change", update);
    el.po.addEventListener("input", update);
    el.options.addEventListener("toggle", () => {
      if (el.options.open) loadRailways();
    });
    el.btnDownload.addEventListener("click", () => this.start());
    el.btnRetry.addEventListener("click", () => this.start());
    el.btnOpenIreps.addEventListener("click", () => ctx.send(MESSAGE_TYPES.OPEN_IREPS));
    this.setBusy(false);
    this.updateSummary();
  }

  selectedRange() {
    const checked = this.el.ranges.find((r) => r.checked);
    return checked ? checked.value : "last180Days";
  }

  collectOptions() {
    const el = this.el;
    const railway = el.rly.value || ALL_RAILWAYS;
    const format = el.format.value || EXPORT_FORMATS[0].value;
    const range = this.selectedRange();
    if (range === "poNumber") return { mode: "poNumber", railway, poNo: el.po.value.trim(), format };
    if (range === "dateRange") return { mode: "dateRange", railway, dateFrom: toIrepsDate(el.dateFrom.value), dateTo: toIrepsDate(el.dateTo.value), format };
    return { mode: "last180Days", railway, format };
  }

  describeOptions(options) {
    const rly = options.railway === ALL_RAILWAYS ? "All Railways" : this.el.rly.selectedOptions[0]?.textContent || options.railway;
    const fmt = formatLabel(options.format).replace(/\s*\(.*\)$/, ""); // "Excel (.xlsx)" -> "Excel" (fits the summary line)
    if (options.mode === "poNumber") return `PO No. ${options.poNo || "…"}, ${rly} · ${fmt}`;
    if (options.mode === "dateRange") return `${options.dateFrom || "…"} to ${options.dateTo || "…"}, ${rly} · ${fmt}`;
    return `Last 180 Days, ${rly} · ${fmt}`;
  }

  updateSummary() {
    const range = this.selectedRange();
    this.el.dateRow.hidden = range !== "dateRange";
    this.el.poRow.hidden = range !== "poNumber";
    this.el.summary.textContent = this.describeOptions(this.collectOptions());
  }

  /** Fill the railway list from the IREPS PO Search form (values come from the page, never hard-coded). */
  setRailways(list) {
    const select = this.el.rly;
    const current = select.value;
    select.replaceChildren();
    for (const r of list) {
      const option = document.createElement("option");
      option.value = r.value;
      option.textContent = r.label;
      select.append(option);
    }
    select.value = list.some((r) => r.value === current) ? current : ALL_RAILWAYS;
    this.updateSummary();
  }

  setBusy(busy, text) {
    this.el.btnDownload.disabled = busy;
    this.el.btnDownload.classList.toggle("is-busy", busy);
    this.el.btnLabel.textContent = text || `Download ${this.label}`;
  }

  clearError() {
    this.el.error.hidden = true;
    this.el.error.classList.remove("is-notice");
    this.el.btnOpenIreps.hidden = true;
  }

  renderProgress(stageId, message) {
    ctx.showView("main");
    this.clearError();
    const el = this.el;
    el.progress.hidden = false;
    const index = STAGE_ORDER.indexOf(stageId);
    const activeStep = STEP_FOR_STAGE[stageId];
    el.steps.forEach((li) => {
      const stepIndex = STAGE_ORDER.indexOf(li.dataset.stage);
      li.classList.toggle("is-active", li.dataset.stage === activeStep && stageId !== "COMPLETE");
      li.classList.toggle("is-done", stepIndex < index && li.dataset.stage !== activeStep);
    });
    el.progressMessage.textContent = message || "";
    this.setBusy(true, message || "Working...");
    if (index >= STAGE_ORDER.indexOf("CONNECTED")) ctx.setConnection("connected", "Connected");
  }

  /** Options collapse again; the details go to the main screen's bottom result panel (like Bill Status). */
  renderComplete(summary) {
    this.clearError();
    this.el.progress.hidden = true;
    this.el.options.open = false;
    this.setBusy(false);
    ctx.setConnection("connected", "Connected");
    if (summary.form && summary.form.railways) shareRailways(summary.form.railways);
    const n = summary.recordCount ?? 0;
    const pages = summary.pagesFetched > 1 ? ` across ${summary.pagesFetched} result pages` : "";
    ctx.showView("main");
    ctx.showResult({
      title: `✓ ${this.label} export downloaded successfully`,
      summary: `${this.label} records exported: ${n}${pages} (${formatLabel(summary.format)})`,
      filter: summary.filter ? `Search: ${summary.filter}` : "",
      filename: summary.filename || "",
      downloadId: summary.downloadId ?? null
    });
  }

  renderError(error) {
    const described = error && error.title ? error : describeError((error && error.code) || "UNKNOWN");
    const el = this.el;
    el.progress.hidden = true;
    this.setBusy(false);
    ctx.setConnectionForError(described);
    if (described.loginRequired) {
      ctx.showLogin(described);
      return;
    }
    ctx.showView("main");
    el.errorTitle.textContent = described.title;
    el.errorMessage.textContent = described.message;
    el.btnOpenIreps.hidden = described.connection !== "login";
    el.error.classList.toggle("is-notice", described.notice === true);
    el.error.hidden = false;
    el.error.scrollIntoView({ block: "nearest" });
  }

  async start() {
    const options = this.collectOptions();
    if (options.mode === "dateRange" && (!options.dateFrom || !options.dateTo)) {
      this.el.options.open = true;
      this.renderError(describeError("IREPS_INVALID_REQUEST", { detail: "Please choose both From and To dates for the date range search." }));
      return;
    }
    if (options.mode === "poNumber" && !options.poNo) {
      this.el.options.open = true;
      this.renderError(describeError("IREPS_INVALID_REQUEST", { detail: "Please enter a PO Number." }));
      return;
    }
    ctx.hideResult();
    this.el.options.open = false;
    this.renderProgress("CHECKING_SESSION", documentStageLabel(DOCUMENT_STAGES.CHECKING_SESSION, this.label));
    const response = await ctx.send(MESSAGE_TYPES.DOWNLOAD_IREPS_DOCUMENTS, { criteria: this.criteria, options });
    if (!response) this.renderError(describeError("UNKNOWN"));
    else if (response.started === false) this.renderError(response.error || describeError("DOCUMENT_BUSY"));
  }
}

/* -------------------------------------------------------------------------- */
/* Railway list (shared)                                                      */
/* -------------------------------------------------------------------------- */

function shareRailways(list) {
  if (!Array.isArray(list) || list.length === 0) return;
  railways = list;
  for (const card of cards.values()) card.setRailways(list);
}

/** Load the PO Search form once (railways + session state); cached by the service worker for a few seconds. */
function loadRailways() {
  if (railways || railwaysLoading) return railwaysLoading;
  railwaysLoading = (async () => {
    const info = await ctx.send(MESSAGE_TYPES.SEARCH_PO_LOAD_FORM, { force: false });
    if (info && info.authenticated) {
      ctx.setConnection("connected", "Connected");
      if (info.form && info.form.railways) shareRailways(info.form.railways);
    } else if (info) {
      ctx.setConnectionForError(describeError(info.code || "UNKNOWN", { status: info.status, detail: info.detail }));
    }
  })().finally(() => {
    railwaysLoading = null;
  });
  return railwaysLoading;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @param {{ send: Function, showView: Function, setConnection: Function, setConnectionForError: Function, showLogin: Function, showResult: Function, hideResult: Function }} context
 */
export function initDocuments(context) {
  ctx = context;
  for (const root of document.querySelectorAll("article.doc-card[data-criteria]")) {
    if (CARD_CRITERIA.includes(root.dataset.criteria)) cards.set(root.dataset.criteria, new DocumentCard(root));
  }
}

/** Route document broadcasts from the service worker to their card. Returns true when handled. */
export function handleDocumentMessage(message) {
  const card = cards.get(message.criteria);
  switch (message.type) {
    case MESSAGE_TYPES.DOCUMENT_PROGRESS:
      if (card) card.renderProgress(message.stage, message.message);
      return true;
    case MESSAGE_TYPES.DOCUMENT_DOWNLOAD_COMPLETE:
      if (card) card.renderComplete(message);
      return true;
    case MESSAGE_TYPES.DOCUMENT_DOWNLOAD_ERROR:
      if (card) card.renderError(message);
      return true;
    default:
      return false;
  }
}

/**
 * Called once when the panel starts on an IREPS tab. Restores a running
 * CRN / R-NOTE job into its card, or a recently finished one into the main
 * screen's bottom result panel / the card's error box; returns true when it did.
 */
export async function restoreDocuments() {
  let restored = false;
  for (const [criteria, card] of cards) {
    const state = await ctx.send(MESSAGE_TYPES.GET_DOCUMENT_JOB_STATE, { criteria });
    if (!state || state.status === "idle") continue;
    const fresh = Date.now() - (state.updatedAt || 0) < 10 * 60 * 1000;
    if (state.status === "running") {
      card.renderProgress(state.stage, state.message);
      restored = true;
    } else if (fresh && state.status === "complete" && state.result) {
      card.renderComplete(state.result);
      restored = true;
    } else if (fresh && state.status === "error" && state.error && !state.error.loginRequired) {
      card.renderError(state.error);
      restored = true;
    }
  }
  return restored;
}
