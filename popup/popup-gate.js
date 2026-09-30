/**
 * "Go to IREPS and log in" gate of the DocLink side panel.
 *
 * Each tab has its own DocLink panel (see "One side panel per tab" in
 * background/service-worker.js): Chrome hides it when the user switches to
 * another tab and shows it again on return. While the panel is visible its
 * tab is the active tab of its window. While that tab is on the IREPS portal
 * config.json targets (mock on localhost, or the real portal) DocLink's
 * tools are shown; if the tab is anywhere else - DocLink opened there, or
 * the tab navigated away - this gate replaces every view. The views keep
 * their own state underneath, so a running download is intact when the tab
 * returns to IREPS, and no IREPS request (session check included) is made
 * meanwhile.
 *
 * The rule itself lives in utils/url-scope.js (classifyTabUrl) and runs in
 * the service worker, where config.json is loaded (GET_TAB_SCOPE).
 */

import { MESSAGE_TYPES } from "../utils/messages.js";
import { TAB_SCOPE } from "../utils/url-scope.js";
import { logger } from "../utils/logger.js";

const $ = (id) => document.getElementById(id);

const PORTAL_NAMES = { mock: "mock IREPS portal", real: "real IREPS portal", custom: "configured IREPS portal" };

/**
 * @param {{ send: Function, setConnection: Function, onActive: () => void|Promise<void> }} ctx
 *   onActive runs every time the panel's tab becomes the configured portal.
 */

/** The panel's tab right now: the active tab of the panel's window (see initGate). */
export async function currentPanelTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab && typeof tab.id === "number" ? tab.id : null;
  } catch {
    return null;
  }
}
export async function initGate(ctx) {
  const el = {
    body: document.body,
    view: $("view-gate"),
    title: $("gate-title"),
    text: $("gate-text"),
    steps: $("gate-steps"),
    btnOpen: $("btn-gate-open-ireps"),
    portal: $("gate-portal")
  };
  el.btnOpen.addEventListener("click", () => ctx.send(MESSAGE_TYPES.OPEN_IREPS));

  // The panel's window. A tab-specific panel is only visible while its own
  // tab is the active tab of this window, so "the active tab here" *is* the
  // panel's tab whenever the panel is visible. That stays true even when
  // Chrome swaps a tab's id (e.g. typing a URL on the New Tab page), which a
  // tab id remembered at open time would not survive.
  let windowId = null;
  try {
    windowId = (await chrome.windows.getCurrent()).id;
  } catch {
    /* fall back to the last focused window below */
  }

  let active = null; // null until the first evaluation, then true/false
  let sequence = 0; // ignore answers that arrive after a newer tab change

  function show(scope) {
    const portalName = PORTAL_NAMES[scope.target] || PORTAL_NAMES.custom;
    el.portal.textContent = scope.portalUrl ? `DocLink is set to the ${portalName}: ${scope.portalUrl}` : "";
    el.steps.hidden = false;
    el.btnOpen.hidden = false;
    el.btnOpen.textContent = "Open IREPS";

    if (scope.scope === TAB_SCOPE.OTHER_PORTAL) {
      el.title.textContent = `This tab is the ${PORTAL_NAMES[scope.otherPortal]}`;
      el.text.textContent =
        `DocLink is set to the ${portalName} in config.json, so it cannot use this tab's login. ` +
        `Switch to a ${portalName} tab, or set "target": "${scope.otherPortal}" in config.json and reload DocLink.`;
      el.steps.hidden = true;
      el.btnOpen.textContent = `Open the ${portalName}`;
    } else if (scope.scope === TAB_SCOPE.MISCONFIGURED) {
      el.title.textContent = "DocLink configuration error";
      el.text.textContent =
        `config.json points DocLink at ${scope.portalUrl}, but manifest.json does not allow that site (host_permissions). ` +
        "Fix the URL in config.json, then reload DocLink in chrome://extensions.";
      el.steps.hidden = true;
      el.btnOpen.hidden = true;
      el.portal.textContent = "";
    } else {
      el.title.textContent = "Go to IREPS and log in";
      el.text.textContent = "DocLink works only on the IREPS portal. This tab is not an IREPS page.";
    }

    el.view.hidden = false;
    el.body.dataset.gate = "on";
    if (scope.scope === TAB_SCOPE.MISCONFIGURED) ctx.setConnection("offline", "Config error", true);
    else ctx.setConnection("away", "Not on IREPS", true);
  }

  function hide() {
    el.view.hidden = true;
    delete el.body.dataset.gate;
  }

  async function evaluate() {
    const mine = ++sequence;
    let tab = null;
    try {
      [tab] = await chrome.tabs.query(windowId === null ? { active: true, lastFocusedWindow: true } : { active: true, windowId });
    } catch {
      /* no tab: treated as "not IREPS" */
    }
    const scope = (await ctx.send(MESSAGE_TYPES.GET_TAB_SCOPE, { url: tab ? tab.url || tab.pendingUrl || "" : "" })) || { scope: TAB_SCOPE.NOT_IREPS };
    if (mine !== sequence) return;

    const host = (() => {
      try {
        return tab && tab.url ? new URL(tab.url).host || tab.url.split(":")[0] : "(no page)";
      } catch {
        return "(no page)";
      }
    })();
    if (scope.scope === TAB_SCOPE.ACTIVE_PORTAL) {
      hide();
      if (active !== true) {
        logger.info(`Panel: DocLink active on ${host}`);
        active = true;
        await ctx.onActive();
      }
    } else {
      if (active !== false) logger.info(`Panel: not on the configured IREPS portal (${scope.scope}, ${host}); showing the gate`);
      active = false;
      show(scope);
    }
  }

  // Re-check only while the panel is on screen: when it is hidden its tab is
  // not the active one, and nothing it shows is seen anyway. Coming back
  // (visibilitychange) re-checks immediately.
  const visible = () => document.visibilityState === "visible";
  document.addEventListener("visibilitychange", () => {
    if (visible()) evaluate();
  });
  chrome.tabs.onActivated.addListener((info) => {
    if (visible() && (windowId === null || info.windowId === windowId)) evaluate();
  });
  chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
    if (!visible() || !tab.active || (windowId !== null && tab.windowId !== windowId)) return;
    if (change.url !== undefined || change.status === "complete") evaluate();
  });
  chrome.tabs.onReplaced.addListener(() => {
    if (visible()) evaluate();
  });

  await evaluate();
}
