/**
 * Browser-side tests for the Purchase Order (PO) download workflow:
 * searchCriteria=PO / searchRange=3 (PO No.) request on the shared SearchPO
 * body, the PO parser (PO PDF link vs "Manage Your Purchase Order"), PO not
 * found, session expiry and the PDF downloader. Invoked from run-tests.js.
 */

import { IREPS_CONFIG } from "../services/ireps-api.js";
import { SEARCH_PO_CRITERIA, buildSearchPoRequest, documentTypeFor } from "../services/search-po/search-po-api.js";
import { searchIrepsDocuments } from "../services/search-po/search-po-service.js";
import { parsePoSearchResults, matchPoHeader, PO_FIELDS } from "../services/po/po-parser.js";
import { searchPo, downloadPo, poDownloadItem, PO_ERROR } from "../services/po/po-service.js";
import { fetchIrepsDocument } from "../services/search-po/document-downloader.js";
import { buildPoFilename, buildPoDownloadPath } from "../utils/filename.js";
import { describeError, PO_STAGES } from "../utils/messages.js";

const BASE = IREPS_CONFIG.baseUrl;
const EXPECTED_PO_BODY = (token, poNo = "27253922100240") =>
  `org.apache.struts.taglib.html.TOKEN=${token}&pageNo=1&searchCriteria=PO&rly=-1&poNo=${poNo}&icNo=&dateFrom=&dateTo=&searchRange=3&recordsPerPage=20&submit=Show+Results&searchCriteria=`;

function fakePdfBytes(text = "PO") {
  return new TextEncoder().encode(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
}

function fakeIreps({ page, onSearch, onPdf }) {
  const calls = [];
  let issued = 0;
  const respond = (html, init = {}) => new Response(html, { status: init.status ?? 200, headers: { "content-type": init.contentType || "text/html; charset=utf-8" } });
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ?? null;
    calls.push({ url: String(url), method: init.method || "GET", body, credentials: init.credentials, headers: init.headers || {} });
    if ((init.method || "GET") === "GET") return onPdf ? onPdf(String(url), respond, calls.length) : respond("no", { status: 404 });
    const params = new URLSearchParams(body || "");
    if (params.get("searchParam") === "showPage") {
      issued++;
      return respond(page.replace("FAKE-TOKEN-0123456789abcdef0123456789abcdef", `TOKEN-${issued}`));
    }
    return onSearch(body, `TOKEN-${issued}`, respond, calls.length, params);
  };
  return { fetchImpl, calls };
}

const PO_ROWS_START = "<!-- PO rows from here -->";
const PO_ROWS_END = "<!-- PO rows up to here -->";

/** Splice custom row HTML into the real PO Search page shell (form + token stay intact). */
function poPageWithRows(fixtureHtml, rowsHtml, total = 1) {
  const head = fixtureHtml.slice(0, fixtureHtml.indexOf(PO_ROWS_START) + PO_ROWS_START.length).replace("Total 1 result(s)", `Total ${total} result(s)`);
  const tail = fixtureHtml.slice(fixtureHtml.indexOf(PO_ROWS_END));
  return head + rowsHtml + tail;
}

/** A PO results page with zero rows (structure kept, table empty). */
function noPoResults(fixtureHtml) {
  return poPageWithRows(fixtureHtml, "", 0);
}

export async function runPoTests({ test, assert, eq, rejects, fixture }) {
  const searchPage = await fixture("crn-search-page.html");
  const poPage = await fixture("po-results-page.html");
  const loginPage = await fixture("login-page.html");
  const expiredPage = await fixture("session-expired.html");
  const parseHtml = (html, o) => parsePoSearchResults(html, o);

  /* ------------------------------------------------------------ request */

  await test("PO request: searchCriteria=PO, searchRange=3 (PO No.) on the shared SearchPO body - matches the captured real request", async () => {
    eq(documentTypeFor("PO").optionLabel, "PO");
    eq(documentTypeFor("PO").defaultRecordsPerPage, 20);
    const req = buildSearchPoRequest("PO", { poNo: "27253922100240" }, "TOK-1");
    eq(req.body, EXPECTED_PO_BODY("TOK-1"), "matches the captured real POST body field-for-field");
    eq(req.searchRange, "3");
    const p = new URLSearchParams(req.body);
    eq(JSON.stringify(p.getAll("searchCriteria")), JSON.stringify(["PO", ""]));

    const { fetchImpl, calls } = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond(poPage) });
    await searchIrepsDocuments({ criteria: "PO", poNo: "27253922100240" }, { fetch: fetchImpl, parseHtml });
    eq(calls[1].body, EXPECTED_PO_BODY("TOKEN-1"));
    assert(calls.every((c) => c.url.endsWith("/epsn/searchPO.do") && c.method === "POST"), "same endpoint, POST");
  });

  /* ------------------------------------------------------------- parser */

  await test("PO parser: header matching for the captured columns", () => {
    eq(matchPoHeader("Sr. No."), "serialNo");
    eq(matchPoHeader("Dept / Rly. Unit"), "railwayUnit");
    eq(matchPoHeader("PO No."), "poNo");
    eq(matchPoHeader("PO Date"), "poDate");
    eq(matchPoHeader("Stock/Non-Stock"), "stockType");
    eq(matchPoHeader("PO Value (INR)"), "poValue");
    eq(matchPoHeader("Action(s)"), "_action");
    eq(matchPoHeader("Something"), null);
  });

  await test("PO parser: real layout -> one record, PO PDF link from the PO No. cell, never 'Manage Your Purchase Order'", () => {
    const result = parsePoSearchResults(poPage, { sourceUrl: `${BASE}/epsn/searchPO.do` });
    eq(result.title, "IREPS PO Search");
    eq(result.structure, "table");
    eq(result.headerLabels.join("|"), "Sr. No.|Dept / Rly. Unit|PO No.|PO Date|Stock/Non-Stock|PO Value (INR)|Action(s)");
    eq(result.rowCount, 1);
    eq(result.recordCount, 1);
    for (const f of PO_FIELDS) assert(f.key in result.records[0], `missing key ${f.key}`);
    const r = result.records[0];
    eq(r.id, "po-1");
    eq(r.serialNo, "1");
    eq(r.railwayUnit, "HQ/CR");
    eq(r.poNo, "27253922100240", "trailing space in the anchor text trimmed");
    eq(r.poDate, "16/01/2026");
    eq(r.stockType, "S");
    eq(r.poValue, "830705.84");
    eq(r.poPdfUrl, `${BASE}/ireps/etender/pdfdocs/MMIS/PO/2026/01/27253922100240.pdf`);
    assert(!r.links.some((l) => l.title.toLowerCase() === "manage your purchase order" && l.url === r.poPdfUrl), "Manage Your Purchase Order is never mistaken for the PO PDF");
    const manageLink = r.links.find((l) => l.title.toLowerCase() === "manage your purchase order");
    assert(manageLink && !manageLink.url, "the Manage link (href=#) resolves to no URL");
    assert(!JSON.stringify(result).includes("FAKE-TOKEN"), "token never reaches the parsed result");
  });

  await test("PO parser: title match works from either anchor (PO No. cell or Actions cell); no link -> warning", () => {
    const html = `<table id="dTbl2"><thead><tr><th>Sr. No.</th><th>Dept / Rly. Unit</th><th>PO No.</th><th>PO Date</th><th>Action(s)</th></tr></thead><tbody>
      <tr><td>1</td><td>HQ/CR</td><td><a href="/ireps/etender/pdfdocs/MMIS/PO/2026/01/P1.pdf" title="Click to View/Download PO">P1</a></td><td>01/01/2026</td><td></td></tr>
      <tr><td>2</td><td>HQ/CR</td><td>P2</td><td>01/01/2026</td><td><a href="/ireps/etender/pdfdocs/MMIS/PO/2026/01/P2.pdf" title="View/Download PO">x</a></td></tr>
      <tr><td>3</td><td>HQ/CR</td><td>P3</td><td>01/01/2026</td><td><a href="#" title="Manage Your Purchase Order">x</a></td></tr>
    </tbody></table>`;
    const result = parsePoSearchResults(html);
    eq(result.recordCount, 3);
    assert(result.records[0].poPdfUrl.endsWith("/P1.pdf"), "PO No. cell title");
    assert(result.records[1].poPdfUrl.endsWith("/P2.pdf"), "Actions cell title");
    eq(result.records[2].poPdfUrl, null, "Manage Your Purchase Order is not a PO PDF link");
    assert(result.warnings.some((w) => w.includes("P3") && w.includes("View/Download PO")), result.warnings.join(" | "));
  });

  /* --------------------------------------------------------- searchPo/downloadPo */

  await test("searchPo: finds the one PO record with its PO PDF href", async () => {
    const { fetchImpl, calls } = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond(poPage) });
    const stages = [];
    const found = await searchPo("27253922100240", { fetch: fetchImpl, parseHtml, onProgress: (s) => stages.push(s) });
    eq(calls.length, 2);
    eq(stages.join(","), "CHECKING_SESSION,CONNECTED,SEARCHING,PARSING");
    eq(found.record.poNo, "27253922100240");
    eq(found.record.poPdfUrl, `${BASE}/ireps/etender/pdfdocs/MMIS/PO/2026/01/27253922100240.pdf`);
    eq(found.recordCount, 1);

    await rejects(searchPo("  "), PO_ERROR.INVALID_REQUEST, "empty PO number rejected before any request");
    await rejects(searchPo(""), PO_ERROR.INVALID_REQUEST);
  });

  await test("searchPo: PO not found -> IREPS_PO_NOT_FOUND with the PO number as detail", async () => {
    const { fetchImpl } = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond(noPoResults(poPage)) });
    const e = await rejects(searchPo("99999999999999", { fetch: fetchImpl, parseHtml }), PO_ERROR.NOT_FOUND);
    eq(e.detail, "99999999999999");
    const described = describeError(e.code, { detail: e.detail });
    eq(described.message, "Purchase Order 99999999999999 was not found (or is not visible to your IREPS account).");
  });

  await test("searchPo: login page, HTTP errors, unrecognised page map to PO codes", async () => {
    await rejects(searchPo("27253922100240", { fetch: async () => new Response(loginPage, { status: 200 }), parseHtml }), PO_ERROR.SESSION_EXPIRED);
    await rejects(searchPo("27253922100240", { fetch: async () => new Response(expiredPage, { status: 200 }), parseHtml }), PO_ERROR.SESSION_EXPIRED);
    await rejects(searchPo("27253922100240", { fetch: async () => new Response("err", { status: 500 }), parseHtml }), PO_ERROR.SEARCH_PAGE_FAILED);
    const s500 = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond("err", { status: 500 }) });
    await rejects(searchPo("27253922100240", { fetch: s500.fetchImpl, parseHtml }), PO_ERROR.SEARCH_FAILED);
    const bad = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond("<html><body><h2>Invalid Token</h2></body></html>") });
    await rejects(searchPo("27253922100240", { fetch: bad.fetchImpl, parseHtml }), PO_ERROR.RESULTS_INVALID);
    eq(bad.calls.length, 4, "one fresh-token retry");
  });

  await test("PO file names: PO_<PO>.pdf inside Downloads/DocLink/IREPS/PO/", () => {
    eq(buildPoFilename("27253922100240"), "PO_27253922100240.pdf");
    eq(buildPoFilename("a/b:c"), "PO_a_b_c.pdf");
    eq(buildPoDownloadPath("27253922100240"), "DocLink/IREPS/PO/PO_27253922100240.pdf");
    const record = parsePoSearchResults(poPage).records[0];
    const item = poDownloadItem(record, "27253922100240");
    eq(item.path, "DocLink/IREPS/PO/PO_27253922100240.pdf");
    eq(item.url, record.poPdfUrl);
    eq(item.label, "PO 27253922100240");
  });

  await test("downloadPo: search + download the PO PDF (never 'Manage Your Purchase Order'); missing link -> IREPS_PO_LINK_NOT_FOUND", async () => {
    const { fetchImpl: searchFetch } = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond(poPage) });
    const fetched = [];
    const saved = [];
    const combinedFetch = async (url, init) => {
      if ((init && init.method) === "POST") return searchFetch(url, init);
      fetched.push(String(url));
      return new Response(fakePdfBytes(), { status: 200, headers: { "content-type": "application/pdf" } });
    };
    const saveFile = async (bytes, path) => {
      saved.push(path);
      return { downloadId: saved.length, filename: path.split("/").pop(), path };
    };
    const result = await downloadPo("27253922100240", { fetch: combinedFetch, parseHtml, saveFile });
    eq(result.success, true);
    eq(result.poNumber, "27253922100240");
    eq(result.documentType, "PO");
    eq(fetched[0], `${BASE}/ireps/etender/pdfdocs/MMIS/PO/2026/01/27253922100240.pdf`);
    eq(result.filename, "PO_27253922100240.pdf");
    eq(saved[0], "DocLink/IREPS/PO/PO_27253922100240.pdf");

    const noLinkRow = `<tr class="trPoRow"><td>1</td><td>HQ/CR</td><td>27253922100240</td><td>16/01/2026</td><td>S</td><td>830705.84</td><td></td></tr>`;
    const noLinkPage = poPageWithRows(poPage, noLinkRow);
    const { fetchImpl: noLinkFetch } = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond(noLinkPage) });
    await rejects(downloadPo("27253922100240", { fetch: noLinkFetch, parseHtml }), PO_ERROR.LINK_NOT_FOUND);
  });

  await test("fetchIrepsDocument (PO codes): login HTML mid-download -> IREPS_SESSION_EXPIRED, not saved as a PDF", async () => {
    const url = `${BASE}/ireps/etender/pdfdocs/MMIS/PO/2026/01/27253922100240.pdf`;
    const codes = { LINK_NOT_FOUND: PO_ERROR.LINK_NOT_FOUND, DOWNLOAD_FAILED: PO_ERROR.DOWNLOAD_FAILED, INVALID_PDF: PO_ERROR.INVALID_PDF, SESSION_EXPIRED: PO_ERROR.SESSION_EXPIRED };
    await rejects(fetchIrepsDocument(url, { codes, fetch: async () => new Response(loginPage, { status: 200, headers: { "content-type": "text/html" } }) }), PO_ERROR.SESSION_EXPIRED);
    const ok = await fetchIrepsDocument(url, { codes, fetch: async () => new Response(fakePdfBytes(), { status: 200, headers: { "content-type": "application/pdf" } }) });
    assert(ok.bytes.length > 0);
  });

  await test("PO stages and error catalogue", () => {
    eq(PO_STAGES.SEARCHING.label, "Searching PO...");
    eq(describeError("IREPS_PO_SEARCH_FAILED", { status: 503 }).message.includes("HTTP 503"), true);
    eq(describeError("IREPS_PO_NOT_FOUND").notice, true);
    eq(describeError("IREPS_PO_LINK_NOT_FOUND").title, "PO document link not found");
    eq(describeError("IREPS_PO_DOWNLOAD_FAILED", { status: 404 }).message.includes("HTTP 404"), true);
    eq(describeError("IREPS_PO_INVALID_PDF").title, "PO document not valid");
    eq(describeError("PO_BUSY").title, "PO Download Already Running");
    eq(SEARCH_PO_CRITERIA.PO, "PO");
  });
}
