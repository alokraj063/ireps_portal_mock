/**
 * Browser-side tests for the Modification Advice (MA) copies workflow:
 * searchCriteria=MA request (recordsPerPage 2000 default), the MA parser
 * (PO link vs MA link by anchor title, null normalisation), the MA-date
 * filter, pagination, the PDF downloader (validation, session expiry,
 * concurrency) and file names. Invoked from run-tests.js.
 */

import { IREPS_CONFIG } from "../services/ireps-api.js";
import { SEARCH_PO_CRITERIA, buildSearchPoRequest, documentTypeFor } from "../services/search-po/search-po-api.js";
import { searchIrepsDocuments } from "../services/search-po/search-po-service.js";
import { parseMaSearchResults, matchMaHeader, maDateKey, MA_FIELDS } from "../services/ma/ma-parser.js";
import { searchMa, buildMaDateFilter, maDownloadItems, downloadMaPdf, downloadMaPdfs, todayIreps, MA_ERROR, MA_DATE_MODE, MA_DOWNLOAD_STATUS } from "../services/ma/ma-service.js";
import { fetchIrepsDocument, looksLikePdf } from "../services/search-po/document-downloader.js";
import { buildMaFilename, buildMaDownloadPath } from "../utils/filename.js";
import { describeError, MA_STAGES } from "../utils/messages.js";

const BASE = IREPS_CONFIG.baseUrl;
const EXPECTED_MA_BODY = (token, per = 20) =>
  `org.apache.struts.taglib.html.TOKEN=${token}&pageNo=1&searchCriteria=MA&rly=-1&poNo=&icNo=&dateFrom=&dateTo=&searchRange=1&recordsPerPage=${per}&submit=Show+Results&searchCriteria=`;

function fakePdfBytes(text = "MA") {
  return new TextEncoder().encode(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
}

function fakeIreps({ page, onSearch, onPage, onPdf }) {
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
    if (params.has("count") && onPage) return onPage(params, respond, calls.length);
    return onSearch(body, `TOKEN-${issued}`, respond, calls.length, params);
  };
  return { fetchImpl, calls };
}

function maPageFrom(fixtureHtml, rows, paginationHtml = "") {
  const START = "<!-- MA rows from here -->";
  const END = "<!-- MA rows up to here -->";
  const head = fixtureHtml.slice(0, fixtureHtml.indexOf(START) + START.length);
  const tail = fixtureHtml.slice(fixtureHtml.indexOf(END)).replace("<!-- MA pagination -->", paginationHtml);
  return head + rows + tail;
}

function maRow(i, { maDate = "18/09/2026", withLink = true } = {}) {
  const po = `9925036910${String(i).padStart(4, "0")}`;
  const ma = String(8000 + i).padStart(6, "0");
  return `<tr class="trPoRow"><td>${i}</td><td>HQ/NR</td><td><a href="/ireps/etender/pdfdocs/MMIS/PO/2026/03/${po}.pdf" title="Click to View/Download PO" target="_blank">${po} </a></td>
    <td> 20/07/2026</td><td>null</td><td>${ma}</td><td> ${maDate} </td><td class="dataText">${withLink ? `<a title="View/Download MA" class="linkStyle" href="/ireps/etender/pdfdocs/MMIS/PO/2026/03/${po}_${ma}.pdf" target="_blank"><img src="/x.png"></a>` : ""}
    <a title="Manage Your Purchase Order" href="#" onclick="postRequest('/epsn/x.do?poNo=${po}')"><img src="/y.gif"></a><a onclick="viewDocAckDetails('1');" href="javascript:void(0);"><img src="/z.gif"></a></td></tr>`;
}

function pageLinks(pages, count, per) {
  return Array.from({ length: pages }, (_, k) => k + 1)
    .map((p) => `<a href="#" onclick="postRequest('/epsn/searchPO.do?rly=-1&dateFrom=&dateTo=&pageNo=${p}&searchRange=1&poNo=&count=${count}&recordsPerPage=${per}');">${p}</a>`)
    .join("&nbsp;");
}

export async function runMaTests({ test, assert, eq, rejects, fixture }) {
  const searchPage = await fixture("crn-search-page.html");
  const maPage = await fixture("ma-results-page.html");
  const crnPage = await fixture("crn-results-page.html");
  const loginPage = await fixture("login-page.html");
  const expiredPage = await fixture("session-expired.html");
  const parseHtml = (html, o) => parseMaSearchResults(html, o);

  /* ------------------------------------------------------------ request */

  await test("MA request: searchCriteria=MA on the shared SearchPO body; recordsPerPage 2000 by default, 20 when asked", async () => {
    eq(documentTypeFor("MA").optionLabel, "Modification Advice (MA)");
    eq(documentTypeFor("MA").defaultRecordsPerPage, 2000);
    const req = buildSearchPoRequest("MA", {}, "TOK-1");
    eq(req.body, EXPECTED_MA_BODY("TOK-1", 20), "builder default is the captured 20");
    const p = new URLSearchParams(req.body);
    eq(JSON.stringify(p.getAll("searchCriteria")), JSON.stringify(["MA", ""]));
    eq(p.get("rly"), "-1");
    eq(p.get("pageNo"), "1");
    eq(p.get("submit"), "Show Results");

    const { fetchImpl, calls } = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond(maPage) });
    await searchIrepsDocuments({ criteria: "MA" }, { fetch: fetchImpl, parseHtml });
    eq(calls[1].body, EXPECTED_MA_BODY("TOKEN-1", 2000), "the MA service default is the verified 2000 per page");
    await searchIrepsDocuments({ criteria: "MA", recordsPerPage: 20, railway: "03" }, { fetch: fetchImpl, parseHtml });
    const q = new URLSearchParams(calls[3].body);
    eq(q.get("recordsPerPage"), "20");
    eq(q.get("rly"), "03");
    assert(calls.every((c) => c.url.endsWith("/epsn/searchPO.do") && c.method === "POST"), "same endpoint, POST");
  });

  /* ------------------------------------------------------------- parser */

  await test("MA parser: header matching", () => {
    eq(matchMaHeader("Sr. No."), "serialNo");
    eq(matchMaHeader("Dept / Rly. Unit"), "railwayUnit");
    eq(matchMaHeader("PO No."), "poNo");
    eq(matchMaHeader("PO Date"), "poDate");
    eq(matchMaHeader("PO_SR"), "poSerial");
    eq(matchMaHeader("MA No."), "maNo");
    eq(matchMaHeader("MA Date"), "maDate");
    eq(matchMaHeader("Action(s)"), "_action");
    eq(matchMaHeader("Something"), null);
    eq(maDateKey("18/09/2026"), "2026-09-18");
    eq(maDateKey("null"), null);
  });

  await test("MA parser: real layout -> records; PO link and MA link kept apart by anchor title; null/NA/---- -> null", () => {
    const result = parseMaSearchResults(maPage, { sourceUrl: `${BASE}/epsn/searchPO.do` });
    eq(result.title, "IREPS MA Search");
    eq(result.structure, "table");
    eq(result.headerLabels.join("|"), "Sr. No.|Dept / Rly. Unit|PO No.|PO Date|PO_SR|MA No.|MA Date|Action(s)");
    eq(result.rowCount, 6);
    eq(result.recordCount, 6);
    eq(result.skippedCount, 0);
    for (const r of result.records) for (const f of MA_FIELDS) assert(f.key in r, `missing key ${f.key}`);
    const [r1, , r3, r4, , r6] = result.records;
    eq(r1.id, "ma-1");
    eq(r1.serialNo, "1");
    eq(r1.railwayUnit, "HQ/NR");
    eq(r1.poNo, "07250369100001", "trailing space in the anchor text trimmed");
    eq(r1.poDate, "20/07/2026");
    eq(r1.poSerial, null, 'literal "null" -> null');
    eq(r1.maNo, "007001", "MA number kept verbatim with leading zeros");
    eq(r1.maDate, "18/09/2026", "surrounding whitespace trimmed");
    eq(r1.maDateKey, "2026-09-18");
    eq(r1.poPdfUrl, `${BASE}/ireps/etender/pdfdocs/MMIS/PO/2026/03/07250369100001.pdf`, "PO document from the PO No. cell");
    eq(r1.maPdfUrl, `${BASE}/ireps/etender/pdfdocs/MMIS/PO/2026/03/07250369100001_007001.pdf`, 'MA document from title="View/Download MA"');
    assert(r1.maPdfUrl !== r1.poPdfUrl, "two different documents");
    eq(r1.links.length, 3, "PO, MA, Manage PO (the javascript: acknowledgement link is stripped by the sanitiser)");
    eq(r1.links.filter((l) => l.url).length, 2, "href=# resolves to no URL");
    eq(r1.rawColumns["Dept / Rly. Unit"], "HQ/NR");
    eq(r3.poSerial, null, "NA -> null");
    eq(r4.poSerial, null, "---- -> null");
    eq(r4.maDate, "17/09/2026");
    eq(r6.maNo, "003006");
    eq(r6.maPdfUrl, null, "row without a View/Download MA link");
    assert(r6.poPdfUrl, "…but the PO link is still there and was not mistaken for the MA");
    assert(result.warnings.some((w) => w.includes("003006") && w.includes("View/Download MA")), result.warnings.join(" | "));
    assert(!JSON.stringify(result).includes("FAKE-TOKEN"), "token never reaches the parsed result");
    eq(parseMaSearchResults(crnPage).structure, "none", "the CRN table is not an MA table");
  });

  await test("MA parser: never the first link in the row; columns by label in any order", () => {
    const html = `<table id="dTbl2"><thead><tr><th>MA No.</th><th>Action(s)</th><th>PO No.</th><th>MA Date</th></tr></thead><tbody>
      <tr><td>000123</td><td><a href="/ireps/etender/pdfdocs/MMIS/PO/2026/01/P1.pdf" title="Click to View/Download PO">PO</a><a href="/ireps/etender/pdfdocs/MMIS/PO/2026/01/P1_000123.pdf" title="View/Download MA">MA</a></td><td>P1</td><td>01/09/2026</td></tr>
      <tr><td>000124</td><td><a href="/x/other.pdf" title="Something else">x</a></td><td>P2</td><td>bad date</td></tr></tbody></table>`;
    const result = parseMaSearchResults(html);
    eq(result.recordCount, 2);
    assert(result.records[0].maPdfUrl.endsWith("/P1_000123.pdf"), "MA link chosen by title even when the PO link comes first in the Action cell");
    assert(result.records[0].poPdfUrl.endsWith("/P1.pdf"), "PO link chosen by its title when the PO No. cell has no anchor");
    eq(result.records[1].maPdfUrl, null, "unrelated link is not an MA link");
    eq(result.records[1].maDateKey, null);
    assert(result.warnings.some((w) => w.includes("000124") && w.includes("not a DD/MM/YYYY")), result.warnings.join(" | "));
  });

  /* --------------------------------------------------------- date filter */

  await test("MA date filter: single date (default today), range, all; invalid input rejected before any request", async () => {
    const today = buildMaDateFilter({});
    eq(today.mode, MA_DATE_MODE.DATE);
    eq(today.date, todayIreps());
    const one = buildMaDateFilter({ dateMode: "date", date: "18/09/2026" });
    eq(one.label, "MA Date 18/09/2026");
    eq(one.matches({ maDateKey: "2026-09-18" }), true);
    eq(one.matches({ maDateKey: "2026-09-17" }), false);
    const range = buildMaDateFilter({ dateMode: "dateRange", dateFrom: "16/09/2026", dateTo: "17/09/2026" });
    eq(range.matches({ maDate: "17/09/2026" }), true);
    eq(range.matches({ maDate: "18/09/2026" }), false);
    eq(range.matches({ maDate: null }), false);
    eq(buildMaDateFilter({ dateMode: "all" }).matches({}), true);
    for (const bad of [{ dateMode: "date", date: "2026-09-18" }, { dateMode: "dateRange", dateFrom: "01/01/2026", dateTo: "01/12/2026" }, { dateMode: "weird" }]) {
      let err = null;
      try {
        buildMaDateFilter(bad);
      } catch (e) {
        err = e;
      }
      eq(err && err.code, MA_ERROR.INVALID_REQUEST, JSON.stringify(bad));
    }
    const calls = [];
    await rejects(searchMa({ dateMode: "date", date: "nope" }, { fetch: async () => calls.push(1) && new Response("x"), parseHtml }), MA_ERROR.INVALID_REQUEST);
    eq(calls.length, 0, "nothing sent for an invalid date");
  });

  await test("searchMa: IREPS 'Last 180 Days' search, then the MA Date filter picks the day's MAs (PO number goes to IREPS)", async () => {
    const stages = [];
    const { fetchImpl, calls } = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond(maPage) });
    const result = await searchMa({ dateMode: "date", date: "18/09/2026" }, { fetch: fetchImpl, parseHtml, onProgress: (s) => stages.push(s) });
    eq(calls.length, 2);
    eq(calls[1].body, EXPECTED_MA_BODY("TOKEN-1", 2000), "no IREPS date filter, Last 180 Days");
    eq(stages.join(","), "CHECKING_SESSION,CONNECTED,SEARCHING,PARSING");
    eq(result.criteria, "MA");
    eq(result.allRecordCount, 6);
    eq(result.recordCount, 2, "two MAs dated 18/09/2026");
    eq(result.records.map((r) => r.maNo).join(","), "007001,002002");
    eq(result.downloadable, 2);
    eq(result.dateFilter.label, "MA Date 18/09/2026");
    assert(result.filter.startsWith("MA Date 18/09/2026; IREPS search: Last 180 Days, All Railways"), result.filter);

    const day15 = await searchMa({ dateMode: "date", date: "15/09/2026" }, { fetch: fetchImpl, parseHtml });
    eq(day15.recordCount, 2);
    eq(day15.downloadable, 1, "one of the two 15/09 MAs has no link");

    const range = await searchMa({ dateMode: "dateRange", dateFrom: "16/09/2026", dateTo: "18/09/2026" }, { fetch: fetchImpl, parseHtml });
    eq(range.recordCount, 4);
    const all = await searchMa({ dateMode: "all", railway: "03" }, { fetch: fetchImpl, parseHtml });
    eq(all.recordCount, 6);
    eq(new URLSearchParams(calls[calls.length - 1].body).get("rly"), "03");

    await searchMa({ dateMode: "all", poNo: "07250369100001" }, { fetch: fetchImpl, parseHtml });
    const q = new URLSearchParams(calls[calls.length - 1].body);
    eq(q.get("searchRange"), "3");
    eq(q.get("poNo"), "07250369100001");

    const e = await rejects(searchMa({ dateMode: "date", date: "01/01/2026" }, { fetch: fetchImpl, parseHtml }), MA_ERROR.NOT_FOUND, "no MA on that day");
    assert(e.detail.includes("MA Date 01/01/2026") && e.detail.includes("6 MAs"), e.detail);
  });

  await test("searchMa: login page, HTTP errors, unrecognised page, empty table map to MA codes", async () => {
    await rejects(searchMa({}, { fetch: async () => new Response(loginPage, { status: 200 }), parseHtml }), MA_ERROR.SESSION_EXPIRED);
    await rejects(searchMa({}, { fetch: async () => new Response("err", { status: 500 }), parseHtml }), MA_ERROR.SEARCH_PAGE_FAILED);
    const s500 = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond("err", { status: 500 }) });
    await rejects(searchMa({}, { fetch: s500.fetchImpl, parseHtml }), "IREPS_MA_SEARCH_FAILED");
    const bad = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond("<html><body><h2>Invalid Token</h2></body></html>") });
    await rejects(searchMa({}, { fetch: bad.fetchImpl, parseHtml }), "IREPS_MA_RESULTS_INVALID");
    eq(bad.calls.length, 4, "one fresh-token retry");
    const empty = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond(maPageFrom(maPage, "")) });
    await rejects(searchMa({ dateMode: "all" }, { fetch: empty.fetchImpl, parseHtml }), "IREPS_MA_NOT_FOUND");
    const crash = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond(maPage) });
    await rejects(
      searchMa({}, {
        fetch: crash.fetchImpl,
        parseHtml: () => {
          throw new Error("boom");
        }
      }),
      "IREPS_MA_PARSE_FAILED"
    );
  });

  await test("searchMa pagination: 20-per-page pages with links are all fetched before the date filter", async () => {
    const per = 10;
    const total = 25;
    const pageRows = (n) => {
      let rows = "";
      for (let i = (n - 1) * per + 1; i <= Math.min(total, n * per); i++) rows += maRow(i, { maDate: i % 2 ? "18/09/2026" : "17/09/2026" });
      return rows;
    };
    const page = (n) => maPageFrom(maPage, pageRows(n), pageLinks(3, total, per));
    const { fetchImpl, calls } = fakeIreps({
      page: searchPage,
      onSearch: (b, t, respond) => respond(page(1)),
      onPage: (params, respond) => respond(page(Number(params.get("pageNo"))))
    });
    const result = await searchMa({ dateMode: "date", date: "18/09/2026", recordsPerPage: per }, { fetch: fetchImpl, parseHtml });
    eq(calls.length, 4, "page, search, page 2, page 3");
    eq(calls[2].body, `rly=-1&dateFrom=&dateTo=&pageNo=2&searchRange=1&poNo=&count=${total}&recordsPerPage=${per}`);
    eq(result.allRecordCount, total);
    eq(result.recordCount, 13, "odd rows are dated 18/09");
    eq(result.pagination.pagesFetched, 3);
    eq(result.records[12].maNo, "008025");
  });

  /* --------------------------------------------------------- downloader */

  await test("MA file names: MA_<PO>_<MA>.pdf inside a folder named after the MA date", () => {
    eq(buildMaFilename("07250369105448", "007327"), "MA_07250369105448_007327.pdf");
    eq(buildMaFilename("a/b:c", "1*2"), "MA_a_b_c_1_2.pdf");
    eq(buildMaDownloadPath({ poNo: "07250369105448", maNo: "007327", maDateKey: "2026-09-18" }), "DocLink/IREPS/MA/2026-09-18/MA_07250369105448_007327.pdf");
    eq(buildMaDownloadPath({ poNo: "P", maNo: "M", maDateKey: null }), "DocLink/IREPS/MA/undated/MA_P_M.pdf");
    const items = maDownloadItems(parseMaSearchResults(maPage).records);
    eq(items[0].path, "DocLink/IREPS/MA/2026-09-18/MA_07250369100001_007001.pdf");
    eq(items[0].label, "MA 007001 (PO 07250369100001)");
    eq(items[5].url, null, "row without an MA link is still listed so it can be reported");
  });

  await test("fetchIrepsDocument: valid PDF ok; login HTML -> IREPS_SESSION_EXPIRED; 404 / 500 / other HTML / non-PDF -> MA download errors", async () => {
    const url = `${BASE}/ireps/etender/pdfdocs/MMIS/PO/2026/03/P_M.pdf`;
    const codes = { LINK_NOT_FOUND: MA_ERROR.LINK_NOT_FOUND, DOWNLOAD_FAILED: MA_ERROR.DOWNLOAD_FAILED, INVALID_PDF: MA_ERROR.INVALID_PDF };
    const seen = [];
    const ok = await fetchIrepsDocument(url, {
      codes,
      fetch: async (u, init) => {
        seen.push({ u: String(u), init });
        return new Response(fakePdfBytes(), { status: 200, headers: { "content-type": "application/pdf" } });
      }
    });
    assert(looksLikePdf(ok.bytes), "PDF bytes returned");
    eq(seen[0].init.method, "GET");
    eq(seen[0].init.credentials, "include");
    assert(!("Cookie" in seen[0].init.headers), "no Cookie header set by DocLink");
    const html = (body, status = 200) => async () => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
    await rejects(fetchIrepsDocument(url, { codes, fetch: html(loginPage) }), MA_ERROR.SESSION_EXPIRED, "login page with HTTP 200 is never saved as a PDF");
    await rejects(fetchIrepsDocument(url, { codes, fetch: html(expiredPage) }), MA_ERROR.SESSION_EXPIRED);
    const e404 = await rejects(fetchIrepsDocument(url, { codes, fetch: html("<html><body><h1>HTTP Status 404</h1></body></html>", 404) }), MA_ERROR.DOWNLOAD_FAILED);
    eq(e404.status, 404);
    await rejects(fetchIrepsDocument(url, { codes, fetch: html("<html><body>oops</body></html>", 500) }), MA_ERROR.DOWNLOAD_FAILED);
    await rejects(fetchIrepsDocument(url, { codes, fetch: html("<html><head><title>Error</title></head><body><h2>Document temporarily unavailable</h2></body></html>") }), MA_ERROR.INVALID_PDF);
    await rejects(fetchIrepsDocument(url, { codes, fetch: async () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6]), { status: 200, headers: { "content-type": "application/pdf" } }) }), MA_ERROR.INVALID_PDF);
    await rejects(fetchIrepsDocument("https://evil.example/x.pdf", { codes, fetch: html("x") }), MA_ERROR.LINK_NOT_FOUND, "non-IREPS origin refused");
    await rejects(fetchIrepsDocument(null, { codes, fetch: html("x") }), MA_ERROR.LINK_NOT_FOUND);
  });

  await test("downloadMaPdf: downloads the MA link, never the PO link; missing link -> IREPS_MA_LINK_NOT_FOUND", async () => {
    const records = parseMaSearchResults(maPage).records;
    const fetched = [];
    const saved = [];
    const fetchImpl = async (url) => {
      fetched.push(String(url));
      return new Response(fakePdfBytes(), { status: 200, headers: { "content-type": "application/pdf" } });
    };
    const saveFile = async (bytes, path) => {
      saved.push(path);
      return { downloadId: saved.length, filename: path.split("/").pop(), path };
    };
    const done = await downloadMaPdf(records[0], { fetch: fetchImpl, saveFile });
    eq(fetched[0], records[0].maPdfUrl);
    assert(fetched[0] !== records[0].poPdfUrl && fetched[0].endsWith("_007001.pdf"), "MA document, not the PO document");
    eq(done.path, "DocLink/IREPS/MA/2026-09-18/MA_07250369100001_007001.pdf");
    eq(done.filename, "MA_07250369100001_007001.pdf");
    await rejects(downloadMaPdf(records[5], { fetch: fetchImpl, saveFile }), MA_ERROR.LINK_NOT_FOUND);
    eq(fetched.length, 1, "nothing fetched for the row without a link");
  });

  await test("downloadMaPdfs: limited concurrency, per-MA status, failures isolated, session expiry stops the batch", async () => {
    const records = parseMaSearchResults(maPage).records;
    let active = 0;
    let maxActive = 0;
    const fetchImpl = async (url) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (String(url).includes("_002003")) return new Response("<html><body><h1>HTTP Status 404</h1></body></html>", { status: 404, headers: { "content-type": "text/html" } });
      return new Response(fakePdfBytes(), { status: 200, headers: { "content-type": "application/pdf" } });
    };
    const saveFile = async (bytes, path) => ({ downloadId: path.length, filename: path.split("/").pop(), path });
    const snapshots = [];
    const summary = await downloadMaPdfs(records, { fetch: fetchImpl, saveFile, concurrency: 3, onProgress: (s) => snapshots.push(s) });
    assert(maxActive <= 3 && maxActive >= 2, `concurrency between 2 and 3 (saw ${maxActive})`);
    eq(summary.total, 6);
    eq(summary.completed, 4);
    eq(summary.failed, 2);
    const byMa = Object.fromEntries(summary.items.map((i) => [i.meta.maNo, i]));
    eq(byMa["007001"].status, MA_DOWNLOAD_STATUS.COMPLETED);
    eq(byMa["007001"].filename, "MA_07250369100001_007001.pdf");
    eq(byMa["002003"].status, MA_DOWNLOAD_STATUS.FAILED);
    eq(byMa["002003"].error.code, MA_ERROR.DOWNLOAD_FAILED);
    eq(byMa["002003"].error.status, 404);
    eq(byMa["003006"].error.code, MA_ERROR.LINK_NOT_FOUND);
    eq(snapshots[0].queued, 6);
    assert(snapshots.some((s) => s.downloading > 0), "Downloading state reported");

    let n = 0;
    const expiring = async () => {
      n++;
      if (n >= 2) return new Response(loginPage, { status: 200, headers: { "content-type": "text/html" } });
      return new Response(fakePdfBytes(), { status: 200, headers: { "content-type": "application/pdf" } });
    };
    const s2 = await downloadMaPdfs(records.slice(0, 5), { fetch: expiring, saveFile, concurrency: 1 });
    eq(s2.sessionExpired, true);
    eq(s2.completed, 1);
    eq(n, 2, "no requests after the session expired");
    eq(s2.items[2].error.code, MA_ERROR.SESSION_EXPIRED);
    eq(s2.items[2].error.skipped, true);
    const msg = describeError("MA_SESSION_EXPIRED_DURING_DOWNLOAD");
    assert(msg.message.includes("log in again") && msg.message.includes("retry the MA download"), msg.message);
  });

  await test("MA stages and error catalogue", () => {
    eq(MA_STAGES.SEARCHING.label, "Searching Modification Advices...");
    eq(describeError("IREPS_MA_SEARCH_FAILED", { status: 503 }).title, "Unable to search Modification Advices");
    eq(describeError("IREPS_MA_RESULTS_INVALID").title, "Unable to recognise the MA results");
    eq(describeError("IREPS_MA_NOT_FOUND", { detail: "MA Date 21/09/2026" }).message, "No Modification Advice matched the selection: MA Date 21/09/2026.");
    eq(describeError("IREPS_MA_NOT_FOUND").notice, true);
    eq(describeError("IREPS_MA_PARSE_FAILED").title, "Unable to read the MA records");
    eq(describeError("IREPS_MA_LINK_NOT_FOUND").title, "MA copy link not found");
    eq(describeError("IREPS_MA_DOWNLOAD_FAILED", { status: 404 }).message.includes("HTTP 404"), true);
    eq(describeError("IREPS_MA_INVALID_PDF").title, "MA copy not valid");
    eq(describeError("MA_BUSY").title, "MA Task Already Running");
    eq(describeError("MA_NO_SELECTION").notice, true);
    eq(describeError(SEARCH_PO_CRITERIA.MA === "MA" ? "IREPS_SESSION_EXPIRED" : "x").loginRequired, true);
  });
}
