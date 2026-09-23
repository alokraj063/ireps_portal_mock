/**
 * Browser-side tests for the R-NOTE (Receipt Note) workflow on the shared PO
 * Search layer: searchCriteria=RNOTE request, the layout-agnostic R-NOTE
 * parser (rawColumns, links, document link detection), pagination, error
 * mapping and the Excel/CSV export. Invoked from run-tests.js.
 */

import { IREPS_CONFIG } from "../services/ireps-api.js";
import { SEARCH_PO_CRITERIA, SEARCH_PO_ERROR, buildSearchPoRequest, errorCodesFor, documentTypeFor, SEARCH_PO_DOCUMENT_TYPES } from "../services/search-po/search-po-api.js";
import { searchIrepsDocuments } from "../services/search-po/search-po-service.js";
import { parseRnoteSearchResults, matchRnoteHeader, pickRnoteDocumentLink, RNOTE_FIELDS } from "../services/rnote/rnote-parser.js";
import { searchRnote, RNOTE_ERROR } from "../services/rnote/rnote-service.js";
import { buildRnoteExport, rnoteTable, RNOTE_EXTRA_COLUMNS } from "../services/rnote/rnote-export.js";
import { parseCrnSearchResults } from "../services/crn/crn-parser.js";
import { buildDocumentExportFilename, buildDocumentExportDownloadPath } from "../utils/filename.js";
import { describeError, DOCUMENT_STAGES, documentStageLabel } from "../utils/messages.js";

const BASE = IREPS_CONFIG.baseUrl;
const EXPECTED_RNOTE_BODY = (token) =>
  `org.apache.struts.taglib.html.TOKEN=${token}&pageNo=1&searchCriteria=RNOTE&rly=-1&poNo=&icNo=&dateFrom=&dateTo=&searchRange=1&recordsPerPage=20&submit=Show+Results&searchCriteria=`;

function fakeIreps({ page, onSearch, onPage }) {
  const calls = [];
  let issued = 0;
  const respond = (html, init = {}) => new Response(html, { status: init.status ?? 200, headers: { "content-type": "text/html; charset=utf-8" } });
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ?? null;
    calls.push({ url: String(url), method: init.method || "GET", body, credentials: init.credentials, headers: init.headers || {} });
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

const parseHtml = (html, options) => parseRnoteSearchResults(html, options);

function rnotePageFrom(fixtureHtml, rows, paginationHtml = "") {
  const START = "<!-- RNOTE rows from here -->";
  const END = "<!-- RNOTE rows up to here -->";
  const head = fixtureHtml.slice(0, fixtureHtml.indexOf(START) + START.length);
  const tail = fixtureHtml.slice(fixtureHtml.indexOf(END)).replace("<!-- RNOTE pagination -->", paginationHtml);
  return head + rows + tail;
}

function rnoteRow(i, { withLink = true } = {}) {
  const no = `RN-8888${String(i).padStart(2, "0")}-26-${String(60000 + i)}`;
  const cell = withLink ? `<a href='/ireps/etender/ct/MOCK/RNOTE/2026/01/${i}/${no}.pdf' target="_blank">${no}</a>` : no;
  return `<tr><td>${i}</td><td>PO-${i}</td><td>01/01/2026</td><td>CR</td><td>001</td><td>${cell}</td><td>03/01/2026</td><td>CH-${i}</td><td>02/01/2026</td><td></td><td></td><td>${i}</td><td>Accepted</td><td> </td></tr>`;
}

function pageLinks(pages, count, per) {
  return Array.from({ length: pages }, (_, k) => k + 1)
    .map((p) => `<a href="#" onclick="postRequest('/epsn/searchPO.do?rly=-1&dateFrom=&dateTo=&pageNo=${p}&searchRange=1&poNo=&count=${count}&recordsPerPage=${per}');">${p}</a>`)
    .join("&nbsp;");
}

/** Read the (STORE-method) entries back out of a zip built by buildZip. */
function readZipTexts(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const out = {};
  let pos = 0;
  while (pos + 4 <= bytes.length && view.getUint32(pos, true) === 0x04034b50) {
    const size = view.getUint32(pos + 18, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const name = decoder.decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
    out[name] = decoder.decode(bytes.subarray(pos + 30 + nameLen + extraLen, pos + 30 + nameLen + extraLen + size));
    pos += 30 + nameLen + extraLen + size;
  }
  return out;
}

export async function runRnoteTests({ test, assert, eq, rejects, fixture }) {
  const searchPage = await fixture("crn-search-page.html");
  const rnotePage = await fixture("rnote-results-page.html");
  const crnPage = await fixture("crn-results-page.html");
  const loginPage = await fixture("login-page.html");

  /* ------------------------------------------------------- shared layer */

  await test("PO Search document types: PO, CRN and RNOTE are known, anything else is UNSUPPORTED_IREPS_SEARCH_TYPE", () => {
    eq(SEARCH_PO_DOCUMENT_TYPES.map((t) => t.criteria).join(","), "PO,CRN,RNOTE,MA");
    eq(documentTypeFor("RNOTE").optionLabel, "Receipt Note (R-NOTE)");
    eq(documentTypeFor("RNOTE").shortLabel, "R-NOTE");
    let err = null;
    try {
      documentTypeFor("DRR");
    } catch (e) {
      err = e;
    }
    eq(err && err.code, SEARCH_PO_ERROR.UNSUPPORTED_CRITERIA);
    err = null;
    try {
      buildSearchPoRequest("DRR", {}, "T");
    } catch (e) {
      err = e;
    }
    eq(err && err.code, "UNSUPPORTED_IREPS_SEARCH_TYPE");
    const codes = errorCodesFor("RNOTE");
    eq(codes.SEARCH_FAILED, "IREPS_RNOTE_SEARCH_FAILED");
    eq(codes.RESULTS_INVALID, "IREPS_RNOTE_RESULTS_INVALID");
    eq(codes.NOT_FOUND, "IREPS_RNOTE_NOT_FOUND");
    eq(codes.PARSE_FAILED, "IREPS_RNOTE_PARSE_FAILED");
    eq(codes.SESSION_EXPIRED, "IREPS_SESSION_EXPIRED");
    eq(RNOTE_ERROR.NOT_FOUND, "IREPS_RNOTE_NOT_FOUND");
  });

  await test("RNOTE request: same SearchPO body as CRN with searchCriteria=RNOTE; filters preserved", () => {
    const req = buildSearchPoRequest("RNOTE", {}, "TOK-1");
    eq(req.body, EXPECTED_RNOTE_BODY("TOK-1"));
    eq(req.criteria, "RNOTE");
    const p = new URLSearchParams(req.body);
    eq(JSON.stringify(p.getAll("searchCriteria")), JSON.stringify(["RNOTE", ""]), "duplicate searchCriteria preserved");
    const crn = buildSearchPoRequest("CRN", {}, "TOK-1");
    eq(crn.body.replace("searchCriteria=CRN", "searchCriteria=RNOTE"), req.body, "only the criteria differs from the CRN request");

    const full = buildSearchPoRequest("RNOTE", { railway: "13", dateFrom: "01/08/2026", dateTo: "31/08/2026", pageNo: 2, recordsPerPage: 50 }, "T");
    const q = new URLSearchParams(full.body);
    eq(q.get("rly"), "13");
    eq(q.get("searchRange"), "2");
    eq(q.get("dateFrom"), "01/08/2026");
    eq(q.get("dateTo"), "31/08/2026");
    eq(q.get("pageNo"), "2");
    eq(q.get("recordsPerPage"), "50");
    const po = buildSearchPoRequest("RNOTE", { poNo: "70220028100002" }, "T");
    eq(new URLSearchParams(po.body).get("searchRange"), "3");
    let err = null;
    try {
      buildSearchPoRequest("RNOTE", { dateFrom: "01/01/2026", dateTo: "01/12/2026" }, "T");
    } catch (e) {
      err = e;
    }
    eq(err && err.code, SEARCH_PO_ERROR.INVALID_REQUEST, "180-day rule shared with CRN");
  });

  /* ------------------------------------------------------------- parser */

  await test("RNOTE parser: header matching, including unlisted 'Receipt Note …' labels", () => {
    eq(matchRnoteHeader("R-Note No."), "rnoteNo");
    eq(matchRnoteHeader("Receipt Note Number"), "rnoteNo");
    eq(matchRnoteHeader("RNote Date"), "rnoteDate");
    eq(matchRnoteHeader("Receipt Note Date"), "rnoteDate");
    eq(matchRnoteHeader("Qty Received"), "quantity");
    eq(matchRnoteHeader("PO No."), "poNo");
    eq(matchRnoteHeader("Rly"), "railway");
    eq(matchRnoteHeader("Action"), "_action");
    eq(matchRnoteHeader("Something Else"), null);
  });

  await test("RNOTE parser: assumed layout -> records with typed fields, rawColumns and links; document link from the row, not the CRN rule", () => {
    const result = parseRnoteSearchResults(rnotePage, { sourceUrl: `${BASE}/epsn/searchPO.do` });
    eq(result.title, "IREPS R-NOTE Search");
    eq(result.structure, "table");
    eq(result.headerLabels.length, 14);
    eq(result.rowCount, 3);
    eq(result.recordCount, 3);
    eq(result.skippedCount, 0);
    for (const r of result.records) {
      for (const f of RNOTE_FIELDS) assert(f.key in r, `missing key ${f.key}`);
      assert("documentUrl" in r && Array.isArray(r.links) && r.rawColumns && typeof r.rawColumns === "object", "envelope keys");
      assert(!(r.documentUrl || "").includes("/MMIS/CONS/"), "CRN path never assumed for R-NOTE");
    }
    const [r1, r2, r3] = result.records;
    eq(r1.id, "rnote-1");
    eq(r1.poNo, "RR-PR-WC-1001-25-26-01");
    eq(r1.poDate, "31/01/2026");
    eq(r1.railway, "CR");
    eq(r1.poSerial, "143");
    eq(r1.rnoteNo, "RN-013801-26-40001");
    eq(r1.rnoteDate, "10/09/2026");
    eq(r1.challanNo, "SSE.SAMPLE.DEPOT.WAR.VENDOR");
    eq(r1.invoiceNo, "4471");
    eq(r1.quantity, "12");
    eq(r1.status, "Accepted");
    eq(r1.documentUrl, `${BASE}/ireps/etender/ct/MOCK/RNOTE/2026/01/40001/RN-013801-26-40001.pdf`, "href taken from the R-Note No. anchor");
    eq(r1.documentLink.column, "R-Note No.");
    eq(r1.links.length, 2, "R-Note link + Manage PO link");
    eq(r1.links[1].url, null, 'href="#" (Manage PO) resolves to no URL');
    eq(Object.keys(r1.rawColumns).join("|"), "#|PO No.|PO Date|Rly|PO Sr|R-Note No.|R-Note Date|Challan No.|Challan Date|Invoice No.|Invoice Date|Qty Received|Status", "every page column kept verbatim (Action dropped)");
    eq(r1.rawColumns["Qty Received"], "12");

    eq(r2.rnoteNo, "RN-013802-26-40002");
    eq(r2.invoiceNo, null, "empty cell -> null");
    eq(r2.status, "Partially Accepted");
    assert(r2.documentUrl.endsWith("/MOCK/RNOTE/2026/13/40002/RN-013802-26-40002.pdf"), r2.documentUrl);
    assert(r2.links.some((l) => l.url && l.url.includes("/sbill/")), "bill link kept in links");
    assert(!r2.documentUrl.includes("/sbill/"), "bill link never taken as the R-NOTE document");

    eq(r3.rnoteNo, "RN-013803-26-40003");
    eq(r3.documentUrl, null, "no anchor -> no document link");
    eq(r3.challanNo, null, "IREPS placeholder 'nil' -> null");
    eq(r3.status, "Rejected");
    assert(result.warnings.some((w) => w.includes("RN-013803-26-40003") && w.includes("no document link")), result.warnings.join(" | "));
    assert(!JSON.stringify(result).includes("FAKE-TOKEN"), "token never reaches the parsed result");
  });

  await test("RNOTE parser: columns mapped by label in any order; unknown columns preserved; document link by anchor text", () => {
    const html = `<table id="dTbl"><thead><tr><th>Receipt Note No</th><th>Status</th><th>PO No.</th><th>Gate Entry No</th><th>Documents</th></tr></thead>
      <tbody><tr><td>RN-1</td><td>Accepted</td><td>PO-9</td><td>GE-77</td>
      <td><a href="/x/bill.pdf" title="Bill PDF">Bill</a> <a href="/ireps/etender/ct/MOCK/RNOTE/1/RN-1.pdf" title="View R-Note">View</a></td></tr></tbody></table>`;
    const result = parseRnoteSearchResults(html);
    eq(result.recordCount, 1);
    const r = result.records[0];
    eq(r.rnoteNo, "RN-1");
    eq(r.status, "Accepted");
    eq(r.poNo, "PO-9");
    eq(r.rawColumns["Gate Entry No"], "GE-77", "unmapped column kept in rawColumns");
    assert(r.documentUrl.endsWith("/MOCK/RNOTE/1/RN-1.pdf"), `document chosen by title 'View R-Note': ${r.documentUrl}`);
    eq(r.links.length, 2);

    const links = [
      { text: "Manage Your Purchase Order", title: "", url: "https://x/po", key: "_action" },
      { text: "Bill", title: "Click here to View / Download Bill PDF", url: "https://x/bill.pdf", key: null }
    ];
    eq(pickRnoteDocumentLink(links), null, "unrelated links are never the R-NOTE document");

    const none = parseRnoteSearchResults(crnPage);
    eq(none.structure, "none", "the CRN table is not an R-NOTE table");
    eq(none.recordCount, 0);
    const crn = parseCrnSearchResults(rnotePage);
    eq(crn.structure, "none", "and the R-NOTE table is not a CRN table");
  });

  /* --------------------------------------------------------- search flow */

  await test("searchRnote: showPage -> fresh token -> searchCriteria=RNOTE -> parsed records (shared flow)", async () => {
    const stages = [];
    const { fetchImpl, calls } = fakeIreps({
      page: searchPage,
      onSearch: (body, token, respond, n, params) => {
        if (params.get("org.apache.struts.taglib.html.TOKEN") !== token) return respond("<html><body><h2>Invalid Token</h2></body></html>");
        if (params.get("searchCriteria") !== "RNOTE") return respond(crnPage);
        return respond(rnotePage);
      }
    });
    const result = await searchRnote({ railway: "-1" }, { fetch: fetchImpl, onProgress: (s) => stages.push(s) });
    eq(calls.length, 2);
    assert(calls.every((c) => c.url.endsWith("/epsn/searchPO.do") && c.method === "POST"), "same endpoint, POST");
    eq(calls[0].body, "searchParam=showPage");
    eq(calls[1].body, EXPECTED_RNOTE_BODY("TOKEN-1"));
    eq(calls[1].credentials, "include");
    eq(stages.join(","), "CHECKING_SESSION,CONNECTED,SEARCHING,PARSING");
    eq(result.criteria, "RNOTE");
    eq(result.documentType.shortLabel, "R-NOTE");
    eq(result.recordCount, 3);
    eq(result.records[0].rnoteNo, "RN-013801-26-40001");
    eq(result.headerLabels.length, 14);
    eq(result.search.criteria, "RNOTE");
    eq(result.filter, "Last 180 Days, All Railways");
    eq(result.form.railways.length, 41);
    assert(!JSON.stringify(result).includes("TOKEN-1"), "token never in the result");

    // The generic entry point behaves identically.
    const generic = await searchIrepsDocuments({ criteria: "RNOTE", railway: "01" }, { fetch: fetchImpl, parseHtml });
    eq(generic.recordCount, 3);
    eq(new URLSearchParams(calls[3].body).get("rly"), "01");
  });

  await test("searchRnote: login page, HTTP errors, unrecognised page, no records, parser crash map to R-NOTE codes", async () => {
    await rejects(searchRnote({}, { fetch: async () => new Response(loginPage, { status: 200 }) }), RNOTE_ERROR.SESSION_EXPIRED);
    const e500 = await rejects(searchRnote({}, { fetch: async () => new Response("err", { status: 500 }) }), RNOTE_ERROR.SEARCH_PAGE_FAILED);
    eq(e500.status, 500);
    const s500 = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond("err", { status: 500 }) });
    await rejects(searchRnote({}, { fetch: s500.fetchImpl }), "IREPS_RNOTE_SEARCH_FAILED");
    const bad = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond("<html><body><h2>Invalid Token</h2></body></html>") });
    await rejects(searchRnote({}, { fetch: bad.fetchImpl }), "IREPS_RNOTE_RESULTS_INVALID");
    eq(bad.calls.length, 4, "one fresh-token retry, like CRN");
    const empty = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond(rnotePageFrom(rnotePage, "")) });
    await rejects(searchRnote({}, { fetch: empty.fetchImpl }), "IREPS_RNOTE_NOT_FOUND");
    const crash = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond(rnotePage) });
    await rejects(
      searchRnote({}, {
        fetch: crash.fetchImpl,
        parseHtml: () => {
          throw new Error("boom");
        }
      }),
      "IREPS_RNOTE_PARSE_FAILED"
    );
    const between = fakeIreps({ page: searchPage, onSearch: (b, t, respond) => respond(loginPage) });
    await rejects(searchRnote({}, { fetch: between.fetchImpl }), RNOTE_ERROR.SESSION_EXPIRED, "session expiring between the two requests");
  });

  await test("searchRnote pagination: every server-side page is fetched via the portal's page-link POSTs", async () => {
    const per = 10;
    const total = 25;
    const pageRows = (pageNo) => {
      let rows = "";
      for (let i = (pageNo - 1) * per + 1; i <= Math.min(total, pageNo * per); i++) rows += rnoteRow(i, { withLink: i % 5 !== 0 });
      return rows;
    };
    const page = (n) => rnotePageFrom(rnotePage, pageRows(n), pageLinks(3, total, per));
    const { fetchImpl, calls } = fakeIreps({
      page: searchPage,
      onSearch: (b, t, respond) => respond(page(1)),
      onPage: (params, respond) => respond(page(Number(params.get("pageNo"))))
    });
    const result = await searchRnote({ recordsPerPage: per }, { fetch: fetchImpl });
    eq(calls.length, 4, "page, search, page 2, page 3");
    eq(calls[2].body, `rly=-1&dateFrom=&dateTo=&pageNo=2&searchRange=1&poNo=&count=${total}&recordsPerPage=${per}`);
    eq(result.recordCount, total);
    eq(result.records.map((r) => r.index).join(","), Array.from({ length: total }, (_, i) => i + 1).join(","));
    eq(new Set(result.records.map((r) => r.id)).size, total);
    eq(result.records[24].rnoteNo, "RN-888825-26-60025");
    eq(result.records.filter((r) => !r.documentUrl).length, 5, "rows without a document link are kept (not invented)");
    eq(result.pagination.pagesFetched, 3);
    eq(result.search.pagesFetched, 3);
  });

  /* -------------------------------------------------------------- export */

  await test("RNOTE export: page columns in page order + document link + other links; xlsx and csv", () => {
    const parsed = parseRnoteSearchResults(rnotePage);
    const { headers, rows } = rnoteTable(parsed.records, parsed.headerLabels);
    eq(headers.join("|"), `#|PO No.|PO Date|Rly|PO Sr|R-Note No.|R-Note Date|Challan No.|Challan Date|Invoice No.|Invoice Date|Qty Received|Status|${RNOTE_EXTRA_COLUMNS.join("|")}`);
    eq(rows.length, 3);
    eq(rows[0][0], "1");
    eq(rows[0][5], "RN-013801-26-40001");
    eq(rows[0][12], "Accepted");
    assert(rows[0][13].endsWith("/MOCK/RNOTE/2026/01/40001/RN-013801-26-40001.pdf"), "document link column");
    eq(rows[0][14], null, "Manage PO (href=#) is not a link");
    assert(rows[1][14] && rows[1][14].includes("/sbill/") && rows[1][14].startsWith("Bill:"), `other links listed: ${rows[1][14]}`);
    eq(rows[2][7], null, "nil -> empty");
    eq(rows[2][13], null, "no document link -> empty");

    const result = { records: parsed.records, headerLabels: parsed.headerLabels, filter: "Last 180 Days, All Railways", fetchedAt: "2026-09-21T07:00:42.000Z", pagination: { pagesFetched: 1 }, warnings: parsed.warnings };
    const xlsx = buildRnoteExport(result, { now: new Date(2026, 8, 21, 12, 30, 42) });
    eq(xlsx.extension, "xlsx");
    eq(xlsx.recordCount, 3);
    eq(xlsx.columnCount, 15);
    const parts = readZipTexts(xlsx.bytes);
    assert(parts["xl/workbook.xml"].includes('<sheet name="R-NOTE" sheetId="1"'), "data sheet is named R-NOTE");
    const sheet = parts["xl/worksheets/sheet1.xml"];
    eq((sheet.match(/<row /g) || []).length, 4, "header + 3 rows");
    assert(sheet.includes("<t>RN-013803-26-40003</t>") && sheet.includes("<t>Partially Accepted</t>"), "values present");
    assert(parts["xl/worksheets/sheet2.xml"].includes("searchCriteria=RNOTE"), "Info sheet names the R-NOTE source");
    const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buildRnoteExport(result, { format: "csv" }).bytes);
    assert(csv.startsWith("﻿#,PO No.,PO Date,Rly,"), csv.slice(0, 40));
    eq(csv.trim().split("\r\n").length, 4);

    // Without headerLabels the columns are derived from the records.
    const derived = rnoteTable(parsed.records);
    eq(derived.headers.join("|"), headers.join("|"));
  });

  await test("RNOTE file names, stages and error catalogue", () => {
    eq(buildDocumentExportFilename("RNOTE", new Date(2026, 8, 21, 12, 30, 42)), "IREPS_RNOTE_2026-09-21_12-30-42.xlsx");
    eq(buildDocumentExportFilename("RNOTE", new Date(2026, 8, 21, 12, 30, 42), "csv"), "IREPS_RNOTE_2026-09-21_12-30-42.csv");
    eq(buildDocumentExportDownloadPath("RNOTE", new Date(2026, 8, 21, 12, 30, 42)), "DocLink/IREPS/RNOTE/IREPS_RNOTE_2026-09-21_12-30-42.xlsx");
    eq(buildDocumentExportDownloadPath("CRN", new Date(2026, 8, 21, 12, 30, 42)), "DocLink/IREPS/CRN/IREPS_CRN_2026-09-21_12-30-42.xlsx");
    eq(documentStageLabel(DOCUMENT_STAGES.SEARCHING, "R-NOTE"), "Searching R-NOTEs...");
    eq(documentStageLabel(DOCUMENT_STAGES.COMPLETE, "CRN"), "CRN export downloaded successfully");
    eq(describeError("IREPS_RNOTE_SEARCH_FAILED", { status: 503 }).title, "Unable to search R-NOTEs");
    eq(describeError("IREPS_RNOTE_RESULTS_INVALID").title, "Unable to recognise the R-NOTE results");
    eq(describeError("IREPS_RNOTE_NOT_FOUND").notice, true);
    eq(describeError("IREPS_RNOTE_PARSE_FAILED").title, "Unable to read the R-NOTE records");
    eq(describeError("UNSUPPORTED_IREPS_SEARCH_TYPE", { detail: "DRR" }).message.includes("DRR"), true);
    eq(describeError("DOCUMENT_EXPORT_ERROR").title, "Records retrieved");
    eq(describeError("DOCUMENT_BUSY").title, "Download Already Running");
    eq(describeError(SEARCH_PO_CRITERIA.RNOTE === "RNOTE" ? "IREPS_SESSION_EXPIRED" : "x").loginRequired, true);
  });
}
