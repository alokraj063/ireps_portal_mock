/**
 * Browser-side tests for the Inspection Certificate (IC) download workflow:
 * vendorInspectionCallList.do form extraction (token, date defaults), the
 * exact captured search request body, the IC parser (rowspan-grouped Call
 * Date / TPI Agency / PO No. columns, "View/ Download IC PDF" vs "View Call
 * Details" vs "Revalidate IC"), a PO with zero ICs (success, not an error),
 * session expiry and the batch downloader. Invoked from run-tests.js.
 */

import { IREPS_CONFIG } from "../services/ireps-api.js";
import { extractIcForm, hasIcForm, IC_FORM_FIELDS, IC_CALL_TYPE, IC_STATUS } from "../services/inspection-certificate/ic-form.js";
import { loadIcListPage, buildIcSearchRequest, submitIcSearch, IC_CONFIG, IC_ERROR } from "../services/inspection-certificate/ic-api.js";
import { parseIcSearchResults, matchIcHeader, IC_LINK_TITLE } from "../services/inspection-certificate/ic-parser.js";
import { searchInspectionCertificates, downloadInspectionCertificates, icDownloadItems } from "../services/inspection-certificate/ic-service.js";
import { buildIcFilename, buildIcDownloadPath } from "../utils/filename.js";
import { describeError, IC_STAGES } from "../utils/messages.js";

const BASE = IREPS_CONFIG.baseUrl;
const FAKE_TOKEN = "FAKE-TOKEN-0123456789abcdef0123456789abcdef";
const EXPECTED_IC_BODY = (token, totalRecords = "5336") =>
  `org.apache.struts.taglib.html.TOKEN=${token}&pageNo=1&totalRecords=${totalRecords}&callType=I&status=I&poNo=27253922100240&inspAgency=-1&plNo=&inspOfficial=&poSr=&dateFrom=01%2F01%2F2025&dateTo=18%2F09%2F2026&dateFromIC=01%2F01%2F2025&dateToIC=18%2F09%2F2026&stage=-1&activity=searchResult&statusSelected=Completed+%2F+IC+Issued`;

function fakePdfBytes(text = "IC") {
  return new TextEncoder().encode(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
}

/** Fake IREPS for the vendorInspectionCallList.do flow: first POST (no token) -> list page; second POST (has token) -> onSearch. */
function fakeIc({ listPage, onSearch, onPdf }) {
  const calls = [];
  let issued = 0;
  const respond = (html, init = {}) => new Response(html, { status: init.status ?? 200, headers: { "content-type": init.contentType || "text/html; charset=utf-8" } });
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ?? null;
    calls.push({ url: String(url), method: init.method || "GET", body, credentials: init.credentials, headers: init.headers || {} });
    if ((init.method || "GET") === "GET") return onPdf ? onPdf(String(url), respond, calls.length) : respond("no", { status: 404 });
    const params = new URLSearchParams(body || "");
    if (!params.has(IC_FORM_FIELDS.TOKEN)) {
      issued++;
      return respond(listPage.replace(FAKE_TOKEN, `TOKEN-${issued}`));
    }
    return onSearch(body, `TOKEN-${issued}`, respond, calls.length, params);
  };
  return { fetchImpl, calls };
}

export async function runIcTests({ test, assert, eq, rejects, fixture }) {
  const listPage = await fixture("ic-list-page.html");
  const resultsPage = await fixture("ic-results-page.html");
  const loginPage = await fixture("login-page.html");
  const parseHtml = (html, options) => parseIcSearchResults(html, "27253922100240", options);

  /* ------------------------------------------------------------ form */

  await test("IC form extraction: token, totalRecords, date defaults and dropdown options (DOM and regex paths)", async () => {
    for (const options of [{}, { DOMParser: null }]) {
      const form = extractIcForm(listPage, options);
      eq(form.present, true);
      eq(form.token, FAKE_TOKEN);
      eq(form.totalRecords, "5336");
      eq(form.dateFrom, "01/01/2025");
      eq(form.dateTo, "18/09/2026");
      eq(form.dateFromIC, "01/01/2025");
      eq(form.dateToIC, "18/09/2026");
      eq(form.inspectionAgencies.length, 6, "Select + 5 agencies");
      eq(form.inspectionAgencies[0].value, "-1");
      eq(form.stages.length, 5, "All + 4 stages");
      eq(form.stages.find((s) => s.value === "1").label, "Stage Inspection I");
    }
    eq(hasIcForm(listPage), true);
    eq(hasIcForm(loginPage), false);
    eq(hasIcForm(resultsPage), true, "the results page carries the same form");
    const noToken = listPage.replace(/<input type="hidden" name="org\.apache\.struts\.taglib\.html\.TOKEN"[^>]*>/, "");
    eq(extractIcForm(noToken).token, null);
  });

  /* -------------------------------------------------------------- api */

  await test("loadIcListPage: POST callType=I&status=I, form content type, credentials included", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(listPage, { status: 200, headers: { "content-type": "text/html" } });
    };
    const res = await loadIcListPage({ fetch: fetchImpl });
    eq(res.status, 200);
    assert(seen[0].url.endsWith(IC_CONFIG.endpoint));
    eq(seen[0].init.method, "POST");
    eq(seen[0].init.body, "callType=I&status=I");
    eq(seen[0].init.credentials, "include");
    eq(seen[0].init.headers["Content-Type"], "application/x-www-form-urlencoded");
  });

  await test("buildIcSearchRequest: matches the captured real request exactly (dates from the loaded form, poNo overridden)", () => {
    const formState = extractIcForm(listPage);
    const req = buildIcSearchRequest(formState, "27253922100240");
    eq(req.poNo, "27253922100240");
    eq(req.body, EXPECTED_IC_BODY(FAKE_TOKEN));
    const p = new URLSearchParams(req.body);
    eq(p.get(IC_FORM_FIELDS.CALL_TYPE), IC_CALL_TYPE);
    eq(p.get(IC_FORM_FIELDS.STATUS), IC_STATUS);
    eq(p.get(IC_FORM_FIELDS.ACTIVITY), "searchResult");
    eq(p.get(IC_FORM_FIELDS.STATUS_SELECTED), "Completed / IC Issued");

    let err = null;
    try {
      buildIcSearchRequest(formState, "");
    } catch (e) {
      err = e;
    }
    eq(err && err.code, IC_ERROR.INVALID_REQUEST, "empty PO number rejected");
    err = null;
    try {
      buildIcSearchRequest({ token: "" }, "27253922100240");
    } catch (e) {
      err = e;
    }
    eq(err && err.code, IC_ERROR.TOKEN_NOT_FOUND);
  });

  await test("submitIcSearch: POSTs to vendorInspectionCallList.do", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(resultsPage, { status: 200 });
    };
    await submitIcSearch({ body: "x=1" }, { fetch: fetchImpl });
    assert(seen[0].url.endsWith(IC_CONFIG.endpoint));
    eq(seen[0].init.method, "POST");
    eq(seen[0].init.body, "x=1");
  });

  /* ---------------------------------------------------------- parser */

  await test("IC parser: header matching for every captured column", () => {
    eq(matchIcHeader("Call Date"), "callDate");
    eq(matchIcHeader("TPI Agency"), "tpiAgency");
    eq(matchIcHeader("PO No. / Date"), "poNoDate");
    eq(matchIcHeader("Call Id"), "callId");
    eq(matchIcHeader("PO Sr."), "poSerial");
    eq(matchIcHeader("PL No: Description"), "plDescription");
    eq(matchIcHeader("Type"), "inspectionType");
    eq(matchIcHeader("Offer Qty."), "offerQty");
    eq(matchIcHeader("Registration Date"), "registrationDate");
    eq(matchIcHeader("Inspection Start Date"), "inspectionStartDate");
    eq(matchIcHeader("IC Date"), "icDate");
    eq(matchIcHeader("Passed Qty."), "passedQty");
    eq(matchIcHeader("Call Status"), "callStatus");
    eq(matchIcHeader("Actions"), "_action");
    eq(matchIcHeader("Something"), null);
  });

  await test("IC parser: real layout -> all 4 ICs of the PO, rowspan-grouped Call Date/TPI Agency/PO No. carried to every row", () => {
    const result = parseIcSearchResults(resultsPage, null);
    eq(result.title, "IREPS Inspection Call List");
    eq(result.structure, "table");
    eq(result.rowCount, 4);
    eq(result.recordCount, 4, "never only the first IC of a multi-IC PO");
    const [r1, r2, r3, r4] = result.records;
    for (const r of [r1, r2, r3, r4]) {
      eq(r.callDate, "05/05/2026", "carried from the rowspan cell");
      eq(r.tpiAgency, "TUV INDIA PVT LTD.-MUMBAI");
      eq(r.poNo, "27253922100240");
      eq(r.poDate, "16/01/2026");
      eq(r.callStatus, "Completed (IC Issued)");
    }
    eq(r1.callId, "6038184070");
    eq(r1.poSerial, "001");
    eq(r1.icPdfUrl, `${BASE}/ireps/etender/ct/tpi/ic/052026/3480517.pdf`);
    eq(r1.id, "ic-6038184070");
    eq(r2.callId, "3778184071");
    eq(r2.poSerial, "002");
    eq(r2.icPdfUrl, `${BASE}/ireps/etender/ct/tpi/ic/052026/2975517.pdf`);
    eq(r3.icPdfUrl, `${BASE}/ireps/etender/ct/tpi/ic/052026/6691517.pdf`);
    eq(r4.icPdfUrl, `${BASE}/ireps/etender/ct/tpi/ic/052026/8794517.pdf`);
    assert(!JSON.stringify(result).includes("FAKE-TOKEN"), "token never reaches the parsed result");
  });

  await test("IC parser: 'View Call Details' and 'Revalidate IC' are never mistaken for the IC PDF link", () => {
    const result = parseIcSearchResults(resultsPage, null);
    for (const r of result.records) {
      // "View Call Details" and "Revalidate IC" carry their title on the removed <img>, not the anchor itself
      for (const l of r.links) {
        if (l.title.toLowerCase() === IC_LINK_TITLE) assert(l.url && l.url.includes("/ct/tpi/ic/"), "the IC PDF link points at the IC path");
        else assert(l.title.toLowerCase() !== IC_LINK_TITLE, "no other link carries the IC PDF title");
      }
      assert(r.icPdfUrl.includes("/ct/tpi/ic/"), "icPdfUrl always the IC path, never viewCall/icRevaidate");
    }
  });

  await test("IC parser: filters by expected PO number where practical; a PO with zero rows parses to zero records", () => {
    const filtered = parseIcSearchResults(resultsPage, "27253922100240");
    eq(filtered.recordCount, 4);
    eq(filtered.filteredCount, 0);
    const mismatched = parseIcSearchResults(resultsPage, "00000000000000");
    eq(mismatched.recordCount, 0, "every row filtered out for a different PO");
    eq(mismatched.filteredCount, 4);
    const empty = parseIcSearchResults(`<html><body><form name="inspectionCallForm" action="/epsn/tpi/vendorInspectionCallList.do"></form></body></html>`, "27253922100240");
    eq(empty.structure, "none");
    eq(empty.recordCount, 0);
  });

  /* --------------------------------------------------- search / download */

  await test("searchInspectionCertificates: finds all 4 issued ICs of the PO (session check -> token -> search -> parse)", async () => {
    const stages = [];
    const { fetchImpl, calls } = fakeIc({ listPage, onSearch: (b, t, respond) => respond(resultsPage) });
    const found = await searchInspectionCertificates("27253922100240", { fetch: fetchImpl, parseHtml, onProgress: (s) => stages.push(s) });
    eq(calls.length, 2, "list page, then the search");
    eq(calls[1].body, EXPECTED_IC_BODY("TOKEN-1"));
    eq(stages.join(","), "CHECKING_SESSION,CONNECTED,SEARCHING,PARSING");
    eq(found.success, true);
    eq(found.poNumber, "27253922100240");
    eq(found.count, 4);
    eq(found.certificates.length, 4);

    await rejects(searchInspectionCertificates(""), IC_ERROR.INVALID_REQUEST);
  });

  await test("searchInspectionCertificates: a PO with zero issued ICs succeeds with an empty list (not a failure)", async () => {
    const emptyResults = resultsPage.replace(/<!-- IC rows from here -->[\s\S]*<!-- IC rows up to here -->/, "").replace('value="4" id="totalRecords"', 'value="0" id="totalRecords"');
    const { fetchImpl } = fakeIc({ listPage, onSearch: (b, t, respond) => respond(emptyResults) });
    const found = await searchInspectionCertificates("00000000000000", { fetch: fetchImpl, parseHtml: (html, o) => parseIcSearchResults(html, "00000000000000", o) });
    eq(found.success, true);
    eq(found.count, 0);
    eq(found.certificates.length, 0);
  });

  await test("searchInspectionCertificates: login page, HTTP errors, missing token map to IC codes", async () => {
    await rejects(searchInspectionCertificates("27253922100240", { fetch: async () => new Response(loginPage, { status: 200 }), parseHtml }), IC_ERROR.SESSION_EXPIRED);
    await rejects(searchInspectionCertificates("27253922100240", { fetch: async () => new Response("err", { status: 500 }), parseHtml }), IC_ERROR.LIST_PAGE_FAILED);
    const s500 = fakeIc({ listPage, onSearch: (b, t, respond) => respond("err", { status: 500 }) });
    await rejects(searchInspectionCertificates("27253922100240", { fetch: s500.fetchImpl, parseHtml }), IC_ERROR.SEARCH_FAILED);
    const expiredMidway = fakeIc({ listPage, onSearch: (b, t, respond) => respond(loginPage) });
    await rejects(searchInspectionCertificates("27253922100240", { fetch: expiredMidway.fetchImpl, parseHtml }), IC_ERROR.SESSION_EXPIRED);
    const noToken = listPage.replace(/<input type="hidden" name="org\.apache\.struts\.taglib\.html\.TOKEN"[^>]*>/, "");
    const noTokenIreps = fakeIc({ listPage: noToken, onSearch: (b, t, respond) => respond(resultsPage) });
    await rejects(searchInspectionCertificates("27253922100240", { fetch: noTokenIreps.fetchImpl, parseHtml }), IC_ERROR.TOKEN_NOT_FOUND);
  });

  await test("IC file names: IC_<PO>_<POSR>_<CALLID>.pdf grouped under Downloads/DocLink/IREPS/IC/<PO>/", () => {
    eq(buildIcFilename("27253922100240", "001", "6038184070"), "IC_27253922100240_001_6038184070.pdf");
    eq(buildIcFilename("27253922100240", null, "6038184070"), "IC_27253922100240_6038184070.pdf", "no PO Sr. -> shorter name");
    eq(buildIcDownloadPath({ poNo: "27253922100240", poSerial: "001", callId: "6038184070" }), "DocLink/IREPS/IC/27253922100240/IC_27253922100240_001_6038184070.pdf");
    const records = parseIcSearchResults(resultsPage, "27253922100240").records;
    const items = icDownloadItems(records, "27253922100240");
    eq(items[0].path, "DocLink/IREPS/IC/27253922100240/IC_27253922100240_001_6038184070.pdf");
    eq(items[0].url, records[0].icPdfUrl);
    eq(items[0].label, "IC 6038184070 (PO Sr. 001)");
  });

  await test("downloadInspectionCertificates: downloads every issued IC (never only the first), limited concurrency, per-item status", async () => {
    const { fetchImpl: searchFetch } = fakeIc({ listPage, onSearch: (b, t, respond) => respond(resultsPage) });
    const fetched = [];
    let active = 0;
    let maxActive = 0;
    const fetch = async (url, init) => {
      if ((init && init.method) === "POST") return searchFetch(url, init);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      fetched.push(String(url));
      if (String(url).includes("2975517")) return new Response("<html><body><h1>HTTP Status 404</h1></body></html>", { status: 404, headers: { "content-type": "text/html" } });
      return new Response(fakePdfBytes(), { status: 200, headers: { "content-type": "application/pdf" } });
    };
    const saveFile = async (bytes, path) => ({ downloadId: path.length, filename: path.split("/").pop(), path });
    const snapshots = [];
    const result = await downloadInspectionCertificates("27253922100240", { fetch, parseHtml, saveFile, onDownloadProgress: (s) => snapshots.push(s) });
    eq(result.success, true);
    eq(result.count, 4);
    eq(fetched.length, 4, "all 4 ICs downloaded, not only the first");
    eq(result.downloads.total, 4);
    eq(result.downloads.completed, 3);
    eq(result.downloads.failed, 1);
    assert(maxActive <= 3 && maxActive >= 2, `expected concurrency 2-3, saw ${maxActive}`);
    eq(snapshots[0].total, 4, "first snapshot announces the count before any download starts");
    const failed = result.downloads.items.find((i) => i.status === "failed");
    eq(failed.error.status, 404);
  });

  await test("downloadInspectionCertificates: session expiry mid-batch stops remaining downloads", async () => {
    const { fetchImpl: searchFetch } = fakeIc({ listPage, onSearch: (b, t, respond) => respond(resultsPage) });
    let n = 0;
    const fetch = async (url, init) => {
      if ((init && init.method) === "POST") return searchFetch(url, init);
      n++;
      if (n >= 2) return new Response(loginPage, { status: 200, headers: { "content-type": "text/html" } });
      return new Response(fakePdfBytes(), { status: 200, headers: { "content-type": "application/pdf" } });
    };
    const saveFile = async (bytes, path) => ({ downloadId: 1, filename: path.split("/").pop(), path });
    const result = await downloadInspectionCertificates("27253922100240", { fetch, parseHtml, saveFile, concurrency: 1 });
    eq(result.downloads.sessionExpired, true);
    eq(result.downloads.completed, 1);
    const skipped = result.downloads.items.filter((i) => i.error && i.error.skipped);
    assert(skipped.length >= 1, "remaining items marked skipped, never attempted");
  });

  await test("downloadInspectionCertificates: a PO with zero ICs succeeds with an empty download batch", async () => {
    const emptyResults = resultsPage.replace(/<!-- IC rows from here -->[\s\S]*<!-- IC rows up to here -->/, "");
    const { fetchImpl } = fakeIc({ listPage, onSearch: (b, t, respond) => respond(emptyResults) });
    const result = await downloadInspectionCertificates("00000000000000", { fetch: fetchImpl, parseHtml: (html, o) => parseIcSearchResults(html, "00000000000000", o) });
    eq(result.success, true);
    eq(result.count, 0);
    eq(result.downloads.total, 0);
    eq(result.downloads.completed, 0);
  });

  await test("IC stages and error catalogue", () => {
    eq(IC_STAGES.SEARCHING.label, "Searching issued ICs...");
    eq(describeError("IREPS_IC_SEARCH_FAILED", { status: 503 }).message.includes("HTTP 503"), true);
    eq(describeError("IREPS_IC_RESULTS_INVALID").title, "Unable to recognise the IC results");
    eq(describeError("IREPS_IC_LINK_NOT_FOUND").title, "IC copy link not found");
    eq(describeError("IREPS_IC_DOWNLOAD_FAILED", { status: 404 }).message.includes("HTTP 404"), true);
    eq(describeError("IREPS_IC_INVALID_PDF").title, "IC copy not valid");
    eq(describeError("IC_SESSION_EXPIRED_DURING_DOWNLOAD").message.includes("retry the IC download"), true);
    eq(describeError("IC_BUSY").title, "IC Download Already Running");
  });
}
