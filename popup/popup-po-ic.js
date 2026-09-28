/**
 * PO / Inspection Certificate view of the DocLink popup.
 *
 * One PO Number, two independent downloads:
 *
 *   Download PO                        -> PO_DOWNLOAD { poNo }
 *   Download Inspection Certificate    -> IC_DOWNLOAD { poNo }
 *
 * Both buttons read the same input and use the exact same PO number; the
 * popup never re-asks for it. Today the PO number is typed manually
 * (getManualPoNumber() below); later it can come from a configured source
 * without any other change here, since the service worker only ever
 * receives a bare PO number string (services/po-ic-service.js).
 *
 * Each download runs in the service worker (continues if the popup closes)
 * and is a thin view over PO_DOWNLOAD / IC_DOWNLOAD / GET_PO_STATE /
 * GET_IC_STATE, exactly like the CRN/R-NOTE and MA views.
 */

import { MESSAGE_TYPES, describeError } from "../utils/messages.js";

const $ = (id) => document.getElementById(id);

let ctx = null;
const el = {};

function bindElements() {
  Object.assign(el, {
    view: $("view-po-ic"),
    btnOpen: $("btn-po-ic-open"),
    btnBack: $("btn-po-ic-back"),
    poNumber: $("po-ic-number"),

    btnPoDownload: $("btn-po-download"),
    poDownloadLabel: document.querySelector("#btn-po-download .btn-label"),
    poProgress: $("po-progress"),
    poProgressMessage: $("po-progress-message"),
    poError: $("po-error"),
    poErrorTitle: $("po-error-title"),
    poErrorMessage: $("po-error-message"),
    btnPoOpenIreps: $("btn-po-open-ireps"),
    poResult: $("po-result"),
    poResultTitle: $("po-result-title"),
    poResultFilename: $("po-result-filename"),
    btnPoShowFile: $("btn-po-show-file"),

    btnIcDownload: $("btn-ic-download"),
    icDownloadLabel: document.querySelector("#btn-ic-download .btn-label"),
    icProgress: $("ic-progress"),
    icProgressMessage: $("ic-progress-message"),
    icError: $("ic-error"),
    icErrorTitle: $("ic-error-title"),
    icErrorMessage: $("ic-error-message"),
    btnIcOpenIreps: $("btn-ic-open-ireps"),
    icResult: $("ic-result"),
    icResultTitle: $("ic-result-title"),
    icResultText: $("ic-result-text"),
    icResultFolder: $("ic-result-folder"),
    btnIcShowFolder: $("btn-ic-show-folder"),
    btnIcRetry: $("btn-ic-retry")
  });
}

/** The PO number source for today's manual-entry UI. Replace only this to read it from elsewhere later. */
function getManualPoNumber() {
  return el.poNumber.value.trim();
}

let poDownloadId = null;
let icFolderDownloadId = null;

/* -------------------------------------------------------------------------- */
/* Purchase Order                                                             */
/* -------------------------------------------------------------------------- */

function setPoBusy(busy, label) {
  el.btnPoDownload.disabled = busy;
  el.btnPoDownload.classList.toggle("is-busy", busy);
  el.poDownloadLabel.textContent = label || "Download PO";
}

function resetPoResults() {
  el.poProgress.hidden = true;
  el.poError.hidden = true;
  el.poResult.hidden = true;
}

function renderPoProgress(message) {
  resetPoResults();
  el.poProgress.hidden = false;
  el.poProgressMessage.textContent = message || "";
  setPoBusy(true, message || "Working...");
  ctx.setConnection("connected", "Connected");
}

function renderPoComplete(result) {
  resetPoResults();
  setPoBusy(false);
  ctx.setConnection("connected", "Connected");
  poDownloadId = result.downloadId ?? null;
  el.poResultTitle.textContent = "✓ PO downloaded successfully";
  el.poResultFilename.textContent = result.filename || "";
  el.poResult.hidden = false;
}

function renderPoError(error) {
  const described = error && error.title ? error : describeError((error && error.code) || "UNKNOWN", { detail: error && error.detail, status: error && error.status });
  resetPoResults();
  setPoBusy(false);
  ctx.setConnectionForError(described);
  el.poErrorTitle.textContent = described.title;
  el.poErrorMessage.textContent = described.message;
  el.btnPoOpenIreps.hidden = described.connection !== "login";
  el.poError.classList.toggle("is-notice", described.notice === true);
  el.poError.hidden = false;
}

async function startPoDownload() {
  const poNo = getManualPoNumber();
  if (!poNo) {
    renderPoError(describeError("IREPS_INVALID_REQUEST", { detail: "Please enter a PO Number." }));
    return;
  }
  renderPoProgress("Searching PO...");
  const response = await ctx.send(MESSAGE_TYPES.PO_DOWNLOAD, { poNo });
  if (!response) renderPoError(describeError("NO_BACKGROUND_RESPONSE", { detail: "no reply to the PO download request" }));
  else if (response.started === false) renderPoError(response.error || describeError("PO_BUSY"));
}

async function refreshPoState() {
  const state = await ctx.send(MESSAGE_TYPES.GET_PO_STATE);
  if (!state || state.status === "idle") {
    resetPoResults();
    setPoBusy(false);
    return state;
  }
  if (state.poNumber && !el.poNumber.value) el.poNumber.value = state.poNumber;
  if (state.status === "running") renderPoProgress(state.message);
  else if (state.status === "complete" && state.result) renderPoComplete(state.result);
  else if (state.status === "error" && state.error) renderPoError(state.error);
  return state;
}

/* -------------------------------------------------------------------------- */
/* Inspection Certificate                                                     */
/* -------------------------------------------------------------------------- */

function setIcBusy(busy, label) {
  el.btnIcDownload.disabled = busy;
  el.btnIcDownload.classList.toggle("is-busy", busy);
  el.icDownloadLabel.textContent = label || "Download Inspection Certificate";
}

function resetIcResults() {
  el.icProgress.hidden = true;
  el.icError.hidden = true;
  el.icResult.hidden = true;
}

function renderIcProgress(message) {
  resetIcResults();
  el.icProgress.hidden = false;
  el.icProgressMessage.textContent = message || "";
  setIcBusy(true, message || "Working...");
  ctx.setConnection("connected", "Connected");
}

/** Failed items worth retrying (a row without an IC link never succeeds). */
function retryableIcFailures(downloads) {
  return ((downloads && downloads.items) || []).filter((i) => i.status === "failed" && !(i.error && i.error.code === "IREPS_IC_LINK_NOT_FOUND"));
}

function renderIcDownloading(message, downloads) {
  resetIcResults();
  el.icProgress.hidden = false;
  const d = downloads;
  el.icProgressMessage.textContent = d ? `${message} (${d.completed + d.failed} of ${d.total})` : message || "";
  setIcBusy(true, "Downloading...");
  ctx.setConnection("connected", "Connected");
}

function renderIcComplete(message, count, downloads) {
  resetIcResults();
  setIcBusy(false);
  ctx.setConnection("connected", "Connected");
  el.icResultTitle.textContent = count === 0 ? "No Inspection Certificates found" : downloads.failed === 0 ? `✓ ${downloads.completed} Inspection Certificate${downloads.completed === 1 ? "" : "s"} downloaded` : `${downloads.completed} downloaded, ${downloads.failed} failed`;
  el.icResultText.textContent =
    count === 0
      ? "No issued Inspection Certificates were found for this PO."
      : downloads.failed === 0
      ? "All issued Inspection Certificates were saved."
      : "Hover a failed item, or use Retry, to see why.";
  const folders = new Set((downloads && downloads.items ? downloads.items : []).filter((i) => i.status === "completed" && i.path).map((i) => i.path.split("/").slice(0, -1).join("/")));
  el.icResultFolder.textContent = count === 0 ? "" : folders.size === 1 ? `Downloads/${Array.from(folders)[0]}/` : "Downloads/DocLink/IREPS/IC/<PO>/";
  const first = ((downloads && downloads.items) || []).find((i) => i.status === "completed" && i.downloadId !== null && i.downloadId !== undefined);
  icFolderDownloadId = first ? first.downloadId : null;
  el.btnIcShowFolder.hidden = icFolderDownloadId === null;
  el.btnIcRetry.hidden = !downloads || retryableIcFailures(downloads).length === 0;
  el.icResult.hidden = false;
}

function renderIcError(error) {
  const described = error && error.title ? error : describeError((error && error.code) || "UNKNOWN", { detail: error && error.detail, status: error && error.status });
  resetIcResults();
  setIcBusy(false);
  ctx.setConnectionForError(described);
  el.icErrorTitle.textContent = described.title;
  el.icErrorMessage.textContent = described.message;
  el.btnIcOpenIreps.hidden = described.connection !== "login";
  el.icError.classList.toggle("is-notice", described.notice === true);
  el.icError.hidden = false;
}

async function startIcDownload() {
  const poNo = getManualPoNumber();
  if (!poNo) {
    renderIcError(describeError("IREPS_INVALID_REQUEST", { detail: "Please enter a PO Number." }));
    return;
  }
  renderIcProgress("Searching issued ICs...");
  const response = await ctx.send(MESSAGE_TYPES.IC_DOWNLOAD, { poNo });
  if (!response) renderIcError(describeError("NO_BACKGROUND_RESPONSE", { detail: "no reply to the IC download request" }));
  else if (response.started === false) renderIcError(response.error || describeError("IC_BUSY"));
}

async function refreshIcState() {
  const state = await ctx.send(MESSAGE_TYPES.GET_IC_STATE);
  if (!state || state.status === "idle") {
    resetIcResults();
    setIcBusy(false);
    return state;
  }
  if (state.poNumber && !el.poNumber.value) el.poNumber.value = state.poNumber;
  if (state.status === "searching") renderIcProgress(state.message);
  else if (state.status === "downloading") renderIcDownloading(state.message, state.downloads);
  else if (state.status === "complete") renderIcComplete(state.message, state.count, state.downloads);
  else if (state.status === "error" && state.error) renderIcError(state.error);
  return state;
}

/* -------------------------------------------------------------------------- */
/* View lifecycle                                                             */
/* -------------------------------------------------------------------------- */

async function openView() {
  ctx.showView("po-ic");
  await Promise.all([refreshPoState(), refreshIcState()]);
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @param {{ send: Function, showView: Function, setConnection: Function, setConnectionForError: Function }} context
 */
export function initPoIc(context) {
  ctx = context;
  bindElements();
  el.btnOpen.addEventListener("click", openView);
  el.btnBack.addEventListener("click", () => ctx.showView("main"));
  el.btnPoDownload.addEventListener("click", startPoDownload);
  el.btnIcDownload.addEventListener("click", startIcDownload);
  el.btnPoOpenIreps.addEventListener("click", () => ctx.send(MESSAGE_TYPES.OPEN_IREPS));
  el.btnIcOpenIreps.addEventListener("click", () => ctx.send(MESSAGE_TYPES.OPEN_IREPS));
  el.btnPoShowFile.addEventListener("click", () => {
    if (poDownloadId !== null) chrome.downloads.show(poDownloadId);
  });
  el.btnIcShowFolder.addEventListener("click", () => {
    if (icFolderDownloadId !== null) chrome.downloads.show(icFolderDownloadId);
  });
  el.btnIcRetry.addEventListener("click", startIcDownload);
}

/** Route PO / IC broadcasts from the service worker. Returns true when handled. */
export function handlePoIcMessage(message) {
  switch (message.type) {
    case MESSAGE_TYPES.PO_PROGRESS:
      if (!el.view.hidden) renderPoProgress(message.message);
      return true;
    case MESSAGE_TYPES.PO_DOWNLOAD_COMPLETE:
      if (!el.view.hidden) renderPoComplete(message);
      return true;
    case MESSAGE_TYPES.PO_DOWNLOAD_ERROR:
      if (!el.view.hidden) renderPoError(message);
      return true;
    case MESSAGE_TYPES.IC_PROGRESS:
      if (!el.view.hidden) {
        if (message.status === "downloading") renderIcDownloading(message.message, null);
        else renderIcProgress(message.message);
      }
      return true;
    case MESSAGE_TYPES.IC_DOWNLOAD_PROGRESS:
      if (!el.view.hidden) renderIcDownloading("Downloading Inspection Certificates...", message.downloads);
      return true;
    case MESSAGE_TYPES.IC_DOWNLOAD_COMPLETE:
      if (!el.view.hidden) renderIcComplete(message.message, message.count, message.downloads);
      return true;
    case MESSAGE_TYPES.IC_DOWNLOAD_ERROR:
      if (!el.view.hidden) renderIcError(message);
      return true;
    default:
      return false;
  }
}

/** Called once at popup start-up. Opens the PO/IC view when either job is still running. */
export async function restorePoIc() {
  const [po, ic] = await Promise.all([ctx.send(MESSAGE_TYPES.GET_PO_STATE), ctx.send(MESSAGE_TYPES.GET_IC_STATE)]);
  const poRunning = po && po.status === "running";
  const icRunning = ic && (ic.status === "searching" || ic.status === "downloading");
  if (!poRunning && !icRunning) return false;
  ctx.showView("po-ic");
  if (po && po.poNumber) el.poNumber.value = po.poNumber;
  else if (ic && ic.poNumber) el.poNumber.value = ic.poNumber;
  if (poRunning) renderPoProgress(po.message);
  if (icRunning) {
    if (ic.status === "downloading") renderIcDownloading(ic.message, ic.downloads);
    else renderIcProgress(ic.message);
  }
  return true;
}
