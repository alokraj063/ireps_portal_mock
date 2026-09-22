/**
 * DocLink popup controller.
 *
 * The popup is a thin view: it sends commands to the service worker and
 * renders the progress / result messages it receives back. All IREPS
 * access, parsing and PDF generation happen in the service worker so the
 * job continues even if the popup is closed.
 */

import { MESSAGE_TYPES, TARGETS, STAGES, STORAGE_KEYS, describeError } from "../utils/messages.js";
import { UPLOAD_SOURCES, DOCUMENT_TYPES } from "../services/upload-service.js";
import { formatFriendlyDateTime } from "../utils/filename.js";
import { initDocuments, handleDocumentMessage, restoreDocuments } from "./popup-documents.js";
import { initMa, handleMaMessage, restoreMa } from "./popup-ma.js";

const $ = (id) => document.getElementById(id);

const el = {
  connection: $("connection"),
  connectionText: $("connection-text"),
  viewMain: $("view-main"),
  viewLogin: $("view-login"),
  viewUpload: $("view-upload"),
  viewDocument: $("view-document"),
  viewMa: $("view-ma"),
  options: $("options"),
  optionsSummary: $("options-summary"),
  optRange: Array.from(document.querySelectorAll('input[name="opt-range"]')),
  dateRow: $("date-row"),
  optDateFrom: $("opt-date-from"),
  optDateTo: $("opt-date-to"),
  optZone: $("opt-zone"),
  btnDownload: $("btn-download"),
  btnLabel: document.querySelector("#btn-download .btn-label"),
  progress: $("progress"),
  steps: Array.from(document.querySelectorAll("#steps li")),
  progressMessage: $("progress-message"),
  mainResult: $("main-result"),
  mainResultTitle: $("main-result-title"),
  mainResultSummary: $("main-result-summary"),
  mainResultFilter: $("main-result-filter"),
  mainResultFilename: $("main-result-filename"),
  btnMainShowFile: $("btn-main-show-file"),
  btnMainPreview: $("btn-main-preview"),
  btnMainDismiss: $("btn-main-dismiss"),
  resultError: $("result-error"),
  errorTitle: $("error-title"),
  errorMessage: $("error-message"),
  btnErrorPreview: $("btn-error-preview"),
  btnErrorRetry: $("btn-error-retry"),
  btnUpload: $("btn-upload"),
  loginTitle: $("login-title"),
  loginText: $("login-text"),
  btnOpenIreps: $("btn-open-ireps"),
  btnLoginBack: $("btn-login-back"),
  uploadForm: $("upload-form"),
  uploadSource: $("upload-source"),
  uploadFile: $("upload-file"),
  uploadType: $("upload-type"),
  uploadMessage: $("upload-message"),
  btnUploadBack: $("btn-upload-back"),
  metaLastDownload: $("meta-last-download"),
  metaStatus: $("meta-status")
};

const STAGE_ORDER = ["CHECKING_SESSION", "CONNECTED", "FETCHING", "PROCESSING", "GENERATING_PDF", "DOWNLOADING", "COMPLETE"];
const STEP_FOR_STAGE = {
  CHECKING_SESSION: "CHECKING_SESSION",
  CONNECTED: "CHECKING_SESSION",
  FETCHING: "FETCHING",
  PROCESSING: "PROCESSING",
  GENERATING_PDF: "GENERATING_PDF",
  DOWNLOADING: "DOWNLOADING",
  COMPLETE: "DOWNLOADING"
};
const ALL_ZONES = "-1";

/** chrome.downloads id of the download shown in the bottom result panel. */
let resultDownloadId = null;

/* -------------------------------------------------------------------------- */
/* Messaging                                                                  */
/* -------------------------------------------------------------------------- */

async function send(type, payload = {}) {
  try {
    return await chrome.runtime.sendMessage({ target: TARGETS.SERVICE_WORKER, type, ...payload });
  } catch (error) {
    console.warn("[DocLink] popup message failed", type, error && error.message);
    return null;
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== TARGETS.POPUP) return false;
  if (handleDocumentMessage(message)) return false;
  if (handleMaMessage(message)) return false;
  switch (message.type) {
    case MESSAGE_TYPES.IREPS_PROGRESS:
      renderProgress(message.stage, message.message);
      break;
    case MESSAGE_TYPES.IREPS_DOWNLOAD_COMPLETE:
      renderComplete(message);
      break;
    case MESSAGE_TYPES.IREPS_DOWNLOAD_ERROR:
      renderError(message);
      break;
    default:
      break;
  }
  return false;
});

/* -------------------------------------------------------------------------- */
/* Views                                                                      */
/* -------------------------------------------------------------------------- */

function showView(name) {
  el.viewMain.hidden = name !== "main";
  el.viewLogin.hidden = name !== "login";
  el.viewUpload.hidden = name !== "upload";
  el.viewDocument.hidden = name !== "document";
  el.viewMa.hidden = name !== "ma";
}

/** Shared "IREPS login required" view (used by Bill Status and CRN). */
function showLogin(described) {
  el.loginTitle.textContent = described.title;
  el.loginText.textContent = described.message;
  showView("login");
}

function setConnection(state, text) {
  el.connection.dataset.state = state;
  el.connectionText.textContent = text;
}

function setConnectionForError(described) {
  switch (described.connection) {
    case "login":
      setConnection("login", "Login Required");
      break;
    case "offline":
      setConnection("offline", "Unavailable");
      break;
    case "connected":
      setConnection("connected", "Connected");
      break;
    default:
      break;
  }
}

function setButtonBusy(busy, label) {
  el.btnDownload.disabled = busy;
  el.btnDownload.classList.toggle("is-busy", busy);
  el.btnLabel.textContent = label || "Download Bill Status";
}

/* ------------------------------------------------ shared bottom result panel */

/**
 * Show the details of a completed download (any type) in the panel at the
 * bottom of the main view, and return to the main view.
 * @param {{ title: string, summary?: string, filter?: string, filename?: string, downloadId?: number|null, preview?: boolean }} details
 */
function showResult(details) {
  showView("main");
  resultDownloadId = details.downloadId ?? null;
  el.mainResultTitle.textContent = details.title || "";
  el.mainResultSummary.textContent = details.summary || "";
  el.mainResultFilter.textContent = details.filter || "";
  el.mainResultFilename.textContent = details.filename || "";
  el.btnMainShowFile.hidden = resultDownloadId === null;
  el.btnMainPreview.hidden = details.preview !== true;
  el.mainResult.hidden = false;
  el.mainResult.scrollIntoView({ block: "nearest" });
}

function hideResult() {
  el.mainResult.hidden = true;
  resultDownloadId = null;
}

function resetResults() {
  hideResult();
  el.resultError.hidden = true;
  el.resultError.classList.remove("is-notice");
  el.btnErrorPreview.hidden = true;
}

function renderProgress(stageId, message) {
  showView("main");
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
  if (stageId === "CONNECTED" || index > STAGE_ORDER.indexOf("CONNECTED")) setConnection("connected", "Connected");
}

/** Back to the original main screen (options collapsed) with the details at the bottom. */
function renderComplete(summary) {
  resetResults();
  el.progress.hidden = true;
  el.options.open = false;
  setButtonBusy(false);
  setConnection("connected", "Connected");
  const n = summary.recordCount ?? 0;
  const extras = [];
  if (summary.skippedCount) extras.push(`${summary.skippedCount} incomplete record${summary.skippedCount === 1 ? "" : "s"} skipped`);
  if (summary.reconSent) extras.push("sent to Recon Engine");
  showResult({
    title: "✓ Bill Status downloaded successfully",
    summary: `Records found: ${n}${extras.length ? ` (${extras.join(", ")})` : ""}`,
    filter: summary.filter ? `Search: ${summary.filter}` : "",
    filename: summary.filename || "",
    downloadId: summary.downloadId ?? null,
    preview: true
  });
  refreshMeta();
}

function renderError(error) {
  const described = error && error.title ? error : describeError((error && error.code) || "UNKNOWN");
  el.progress.hidden = true;
  setButtonBusy(false);
  refreshMeta();
  setConnectionForError(described);

  if (described.loginRequired) {
    showLogin(described);
    return;
  }

  showView("main");
  resetResults();
  el.errorTitle.textContent = described.title;
  el.errorMessage.textContent = described.message;
  el.btnErrorPreview.hidden = !described.previewAvailable;
  el.resultError.classList.toggle("is-notice", described.notice === true || described.previewAvailable === true);
  el.resultError.hidden = false;
}

async function refreshMeta() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.LAST_DOWNLOAD);
    const meta = stored[STORAGE_KEYS.LAST_DOWNLOAD] || {};
    el.metaLastDownload.textContent = meta.lastDownloadAt ? formatFriendlyDateTime(meta.lastDownloadAt) : "-";
    el.metaLastDownload.title = meta.lastDownloadFilename || "";
    el.metaStatus.textContent = meta.lastStatus || "-";
  } catch {
    el.metaLastDownload.textContent = "-";
    el.metaStatus.textContent = "-";
  }
}

/* -------------------------------------------------------------------------- */
/* Search options                                                             */
/* -------------------------------------------------------------------------- */

/** "2026-08-01" (input[type=date]) -> "01/08/2026" (IREPS). */
function toIrepsDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

function selectedRange() {
  const checked = el.optRange.find((r) => r.checked);
  return checked ? checked.value : "last90Days";
}

/** Options sent to the service worker. Mirrors the IREPS form semantics. */
function collectOptions() {
  const zone = el.optZone.value || ALL_ZONES;
  if (selectedRange() === "dateRange") {
    return { mode: "dateRange", zone, dateFrom: toIrepsDate(el.optDateFrom.value), dateTo: toIrepsDate(el.optDateTo.value) };
  }
  if (zone !== ALL_ZONES) return { mode: "railwayZone", zone };
  return { mode: "last90Days", zone: ALL_ZONES };
}

function describeOptions(options) {
  const zoneLabel = options.zone === ALL_ZONES ? "All Zones" : el.optZone.selectedOptions[0]?.textContent || options.zone;
  if (options.mode === "dateRange") return `${options.dateFrom || "…"} to ${options.dateTo || "…"}, ${zoneLabel}`;
  if (options.mode === "railwayZone") return `Railway Zone: ${zoneLabel}`;
  return `Last 90 Days, ${zoneLabel}`;
}

function updateOptionsSummary() {
  el.dateRow.hidden = selectedRange() !== "dateRange";
  el.optionsSummary.textContent = describeOptions(collectOptions());
}

/** Fill the zone list from the IREPS form (values come from the page, never hard-coded). */
function populateZones(zones) {
  if (!Array.isArray(zones) || zones.length === 0) return;
  const current = el.optZone.value;
  el.optZone.replaceChildren();
  for (const zone of zones) {
    const option = document.createElement("option");
    option.value = zone.value;
    option.textContent = zone.label;
    el.optZone.append(option);
  }
  el.optZone.value = zones.some((z) => z.value === current) ? current : ALL_ZONES;
  updateOptionsSummary();
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

async function checkSession(force = false) {
  setConnection("checking", "Checking…");
  const info = await send(MESSAGE_TYPES.CHECK_IREPS_SESSION, { force });
  if (!info) {
    setConnection("offline", "Unavailable");
    return null;
  }
  if (info.authenticated) {
    setConnection("connected", "Connected");
    if (info.form && info.form.zones) populateZones(info.form.zones);
  } else {
    setConnectionForError(describeError(info.code || "UNKNOWN"));
    if (!el.connection.dataset.state || el.connection.dataset.state === "checking") setConnection("offline", "Unavailable");
  }
  return info;
}

async function startDownload() {
  const options = collectOptions();
  if (options.mode === "dateRange" && (!options.dateFrom || !options.dateTo)) {
    renderError(describeError("IREPS_INVALID_REQUEST", { detail: "Please choose both From and To dates for the date range search." }));
    return;
  }
  resetResults();
  el.options.open = false;
  renderProgress("CHECKING_SESSION", STAGES.CHECKING_SESSION.label);
  const response = await send(MESSAGE_TYPES.DOWNLOAD_IREPS_BILL_STATUS, { options });
  if (!response) {
    renderError(describeError("UNKNOWN"));
  } else if (response.started === false) {
    renderError(response.error || describeError("BUSY"));
  }
}

async function restoreJobState() {
  const state = await send(MESSAGE_TYPES.GET_JOB_STATE);
  if (!state || state.status === "idle") return false;
  const fresh = Date.now() - (state.updatedAt || 0) < 10 * 60 * 1000;
  if (state.status === "running") {
    renderProgress(state.stage, state.message);
    return true;
  }
  if (!fresh) return false;
  if (state.status === "complete" && state.result) {
    renderComplete(state.result);
    return true;
  }
  if (state.status === "error" && state.error) {
    renderError(state.error);
    return true;
  }
  return false;
}

function populateUploadForm() {
  for (const source of UPLOAD_SOURCES) {
    const option = document.createElement("option");
    option.value = source.value;
    option.textContent = source.label;
    el.uploadSource.append(option);
  }
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select Type";
  el.uploadType.append(placeholder);
  for (const type of DOCUMENT_TYPES) {
    const option = document.createElement("option");
    option.value = type.value;
    option.textContent = type.label;
    el.uploadType.append(option);
  }
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

el.btnDownload.addEventListener("click", startDownload);
el.btnErrorRetry.addEventListener("click", startDownload);
el.btnOpenIreps.addEventListener("click", () => send(MESSAGE_TYPES.OPEN_IREPS));
el.btnLoginBack.addEventListener("click", () => {
  showView("main");
  checkSession(true);
});
el.btnMainPreview.addEventListener("click", () => send(MESSAGE_TYPES.OPEN_PREVIEW));
el.btnErrorPreview.addEventListener("click", () => send(MESSAGE_TYPES.OPEN_PREVIEW));
el.btnMainShowFile.addEventListener("click", () => {
  if (resultDownloadId !== null) chrome.downloads.show(resultDownloadId);
});
el.btnMainDismiss.addEventListener("click", hideResult);

for (const radio of el.optRange) radio.addEventListener("change", updateOptionsSummary);
el.optZone.addEventListener("change", updateOptionsSummary);
el.optDateFrom.addEventListener("change", updateOptionsSummary);
el.optDateTo.addEventListener("change", updateOptionsSummary);

el.btnUpload.addEventListener("click", () => {
  el.uploadMessage.hidden = true;
  showView("upload");
});
el.btnUploadBack.addEventListener("click", () => showView("main"));
el.uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = el.uploadFile.files && el.uploadFile.files[0];
  const response = await send(MESSAGE_TYPES.UPLOAD_DOCUMENT, {
    request: {
      source: el.uploadSource.value,
      documentType: el.uploadType.value,
      file: file ? { name: file.name, size: file.size, type: file.type } : null
    }
  });
  el.uploadMessage.textContent = (response && response.message) || "Upload integration will be implemented in Phase 2.";
  el.uploadMessage.hidden = false;
});

(async function init() {
  populateUploadForm();
  updateOptionsSummary();
  refreshMeta();
  initDocuments({ send, showView, setConnection, setConnectionForError, showLogin, showResult, hideResult });
  initMa({ send, showView, setConnection, setConnectionForError, showLogin });
  const restored = await restoreJobState();
  const documentRestored = restored ? false : await restoreDocuments();
  const maRestored = restored || documentRestored ? false : await restoreMa();
  if (!restored && !documentRestored && !maRestored) showView("main");
  const state = await send(MESSAGE_TYPES.GET_JOB_STATE);
  if (!state || state.status !== "running") {
    if (restored && state && state.status === "error" && state.error && state.error.loginRequired) {
      setConnection("login", "Login Required");
    } else {
      await checkSession(false);
    }
  }
})();
