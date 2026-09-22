/**
 * Browser-side tests for the CRN (Consignment Receipt Note) workflow:
 * PO Search form extraction, CRN request building (duplicate searchCriteria),
 * result parsing (all CRN types, links), pagination, the searchCrn flow with
 * a fake IREPS, and the Excel / CSV export (zip + xlsx writers). No extension
 * APIs are used. Invoked from run-tests.js.
 */

import { IREPS_CONFIG, IREPS_ERROR } from "../services/ireps-api.js";
import {
  extractSearchPoForm,
  extractSearchPoStrutsToken,
  extractSearchPoRailways,
  hasSearchPoForm,
  publicSearchPoFormInfo,
  SEARCH_PO_FORM_FIELDS
} from "../services/search-po/search-po-form.js";
import {
  SEARCH_PO_CONFIG,
  SEARCH_PO_CRITERIA,
  SEARCH_PO_RANGE,
  SEARCH_PO_MODE,
  buildSearchPoRequest,
  buildSearchPoPageRequest,
  describeSearchPoRequest,
  describeSearchPoFilter,
  inferSearchPoMode,
  loadSearchPoPage,
  resolveIrepsUrl,
  isIrepsOriginUrl
} from "../services/search-po/search-po-api.js";
import { parseCrnSearchResults, extractCrnPagination, extractCrnPageMessage, matchCrnHeader, CRN_FIELDS, CRN_LINK_FIELDS } from "../services/crn/crn-parser.js";
import { searchCrn, validateCrnSession, CRN_ERROR } from "../services/crn/crn-service.js";

// CRN-flavoured aliases over the shared PO Search layer (what the CRN feature uses).
const CRN_CONFIG = SEARCH_PO_CONFIG;
const CRN_SEARCH_RANGE = SEARCH_PO_RANGE;
const CRN_SEARCH_MODE = SEARCH_PO_MODE;
const CRN_FORM_FIELDS = SEARCH_PO_FORM_FIELDS;
const extractCrnForm = extractSearchPoForm;
const extractCrnStrutsToken = extractSearchPoStrutsToken;
const extractCrnRailways = extractSearchPoRailways;
const hasCrnSearchForm = hasSearchPoForm;
const publicCrnFormInfo = publicSearchPoFormInfo;
const buildCrnSearchRequest = (options, token) => buildSearchPoRequest(SEARCH_PO_CRITERIA.CRN, options, token);
const buildCrnPageRequest = (link) => buildSearchPoPageRequest(link, CRN_ERROR.RESULTS_INVALID);
const describeCrnRequest = (request) => describeSearchPoRequest(SEARCH_PO_CRITERIA.CRN, request);
const describeCrnFilter = (request, railways) => describeSearchPoFilter({ ...request, criteria: SEARCH_PO_CRITERIA.CRN }, railways);
const inferCrnSearchMode = inferSearchPoMode;
const loadCrnSearchPage = loadSearchPoPage;
import { buildCrnExport, crnTable, CRN_EXPORT_COLUMNS, CRN_EXPORT_FORMAT, CRN_EXPORT_FORMATS } from "../services/crn/crn-export.js";
import { buildZip, crc32 } from "../utils/zip-writer.js";
import { buildWorkbook, buildCsv, columnLetter, XLSX_MIME_TYPE } from "../utils/xlsx-writer.js";
import { buildCrnExportFilename, buildCrnExportDownloadPath } from "../utils/filename.js";
import { describeError } from "../utils/messages.js";

const BASE = IREPS_CONFIG.baseUrl;
const EXPECTED_BODY = (token) =>
  `org.apache.struts.taglib.html.TOKEN=${token}&pageNo=1&searchCriteria=CRN&rly=-1&poNo=&icNo=&dateFrom=&dateTo=&searchRange=1&recordsPerPage=20&submit=Show+Results&searchCriteria=`;

/**
 * Fake IREPS for the CRN flow: answers "searchParam=showPage" with the search
 * page (fresh token per call), page-link POSTs (body has count=) via onPage
 * and every other POST via onSearch.
 */
function fakeCrnIreps({ page, onSearch, onPage }) {
  const calls = [];
  let issued = 0;
  const respond = (html, init = {}) => new Response(html, { status: init.status ?? 200, headers: { "content-type": init.contentType || "text/html; charset=utf-8" } });
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ?? null;
    calls.push({ url: String(url), method: init.method || "GET", body, credentials: init.credentials, headers: init.headers || {} });
    if ((init.method || "GET") === "GET") return respond("<html><body>unexpected GET</body></html>", { status: 404 });
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

const parseHtml = (html, options) => parseCrnSearchResults(html, options);

/** Build a CRN results page from the fixture's head/tail with generated rows. */
function crnPageFrom(fixtureHtml, rows, paginationHtml = "") {
  const START = "<!-- CRN rows from here -->";
  const END = "<!-- CRN rows up to here -->";
  const head = fixtureHtml.slice(0, fixtureHtml.indexOf(START) + START.length);
  const tail = fixtureHtml.slice(fixtureHtml.indexOf(END)).replace("<!-- CRN pagination -->", paginationHtml);
  return head + rows + tail;
}

function crnRow(i, { type = "Fresh Supply", claim = null, withLink = true } = {}) {
  const no = `9999${String(i).padStart(2, "0")}-26-${String(50000 + i)}`;
  const typeCell = claim
    ? `<span style='color:red;'>${type}</span><br><a href='/ireps/etender/ct/MMIS/CRC/WAR/2026/01/${i}/${claim}.pdf' target='_blank'>${claim}</span>`
    : `<span style='color:blue;'>${type}</span><br>`;
  const crnCell = withLink ? `<a href='/ireps/etender/ct/MMIS/CONS/2026/01/${i}/${no}_1.pdf' target="_blank">${no}</a>` : no;
  const pd = '<td class="payDtlCls1"></td>';
  return `<tr><td>${i}</td><td>PO-${i}</td><td>01/01/2026</td><td>CH-${i}</td><td>02/01/2026</td><td>${typeCell}</td><td>CR</td><td>001</td>
    <td>${crnCell}</td><td>03/01/2026</td><td>04/01/2026</td><td>1</td><td class="searchDtlCls"> Signed </td>${pd.repeat(12)}<td> </td></tr>`;
}

function pageLinks(pages, count, per) {
  return Array.from({ length: pages }, (_, k) => k + 1)
    .map((p) => `<a href="#" onclick="postRequest('/epsn/searchPO.do?rly=-1&dateFrom=&dateTo=&pageNo=${p}&searchRange=1&poNo=&count=${count}&recordsPerPage=${per}');">${p}</a>`)
    .join("&nbsp;");
}

export async function runCrnTests({ test, assert, eq, rejects, fixture, FAKE_TOKEN }) {
  const searchPage = await fixture("crn-search-page.html");
  const resultsPage = await fixture("crn-results-page.html");
  const noRecordsPage = await fixture("crn-no-records.html");
  const loginPage = await fixture("login-page.html");
  const expiredPage = await fixture("session-expired.html");
  const billPage = await fixture("bill-status-page.html");

  /* ------------------------------------------------------ form extraction */

  for (const [label, options] of [
    ["DOM path", {}],
    ["regex path (service worker)", { DOMParser: null }]
  ]) {
    await test(`CRN form extraction (${label}): token, railways, criteria, searchRange, recordsPerPage`, () => {
      const form = extractCrnForm(searchPage, options);
      eq(form.present, true);
      eq(form.action, "/epsn/searchPO.do");
      eq(form.token, FAKE_TOKEN, "dynamic token read from the page");
      eq(extractCrnStrutsToken(searchPage, options), FAKE_TOKEN);

      const railways = extractCrnRailways(searchPage, options);
      eq(railways.length, 41, "railway count");
      eq(railways[0].value, "-1");
      eq(railways[0].label, "All");
      eq(railways.find((r) => r.value === "01").label, "Central Railway");
      eq(railways.find((r) => r.value === "13").label, "North Western Railway");

      eq(form.searchCriteria.length, 8, "searchCriteria options");
      eq(form.searchCriteria.find((c) => c.value === "CRN").label, "Consignment Receipt Note (CRN)");
      eq(form.searchCriteria.find((c) => c.selected).value, "PO", "PO is preselected on the search page");
      eq(form.searchCriteriaFieldCount, 2, "select + hidden field both named searchCriteria");

      eq(form.searchRanges.map((r) => r.value).join(","), "3,2,1");
      eq(form.searchRanges.map((r) => r.label).join("|"), "PO No.|Select Date|Last 180 Days");
      eq(form.defaultSearchRange, "1", "Last 180 Days is the default");
      eq(form.defaultRecordsPerPage, "20");

      const pub = publicCrnFormInfo(form);
      assert(!("token" in pub), "public form info has no token");
      assert(!JSON.stringify(pub).includes(FAKE_TOKEN), "token not serialised");
    });

    await test(`CRN form extraction (${label}): missing token -> null; login page -> not present`, () => {
      const stripped = searchPage.replace(/<input type="hidden" name="org\.apache\.struts\.taglib\.html\.TOKEN"[^>]*>/, "");
      const form = extractCrnForm(stripped, options);
      eq(form.present, true);
      eq(form.token, null);
      eq(form.railways.length, 41);
      const login = extractCrnForm(loginPage, options);
      eq(login.present, false);
      eq(login.token, null);
      const bill = extractCrnForm(billPage, options);
      eq(bill.present, false, "the Bill Status form is not the CRN form");
    });
  }

  await test("hasCrnSearchForm: PO Search / CRN results pages yes, login / Bill Status pages no", () => {
    eq(hasCrnSearchForm(searchPage), true);
    eq(hasCrnSearchForm(resultsPage), true);
    eq(hasCrnSearchForm(loginPage), false);
    eq(hasCrnSearchForm(billPage), false);
    eq(hasCrnSearchForm(""), false);
  });

  /* ----------------------------------------------------- request building */

  await test("CRN request: captured field order, searchCriteria=CRN, rly=-1, pageNo=1, recordsPerPage=20, duplicate searchCriteria", () => {
    const req = buildCrnSearchRequest({}, "TOK-1");
    eq(req.body, EXPECTED_BODY("TOK-1"));
    eq(req.criteria, "CRN");
    eq(req.mode, CRN_SEARCH_MODE.LAST_180_DAYS);
    eq(req.searchRange, CRN_SEARCH_RANGE.LAST_180_DAYS);
    eq(req.pageNo, 1);
    eq(req.recordsPerPage, 20);
    const p = new URLSearchParams(req.body);
    eq(p.get(CRN_FORM_FIELDS.TOKEN), "TOK-1");
    eq(p.get("pageNo"), "1");
    eq(p.get("rly"), "-1");
    eq(p.get("poNo"), "");
    eq(p.get("icNo"), "");
    eq(p.get("dateFrom"), "");
    eq(p.get("dateTo"), "");
    eq(p.get("searchRange"), "1");
    eq(p.get("recordsPerPage"), "20");
    eq(p.get("submit"), "Show Results");
    eq(JSON.stringify(p.getAll("searchCriteria")), JSON.stringify(["CRN", ""]), "searchCriteria appears twice: CRN first, empty hidden field last");
    eq(Array.from(p.keys()).length, 12, "twelve form fields");
    eq(Array.from(p.keys()).pop(), "searchCriteria", "the empty searchCriteria is the last field");
    const same = buildCrnSearchRequest({ mode: "last180Days", railway: "-1", pageNo: 1, recordsPerPage: 20 }, "TOK-1");
    eq(same.body, req.body);
  });

  await test("CRN request: PO number, date range, railway, page size and inferred modes", () => {
    const po = buildCrnSearchRequest({ poNo: " 70220028100002 ", railway: "13" }, "T");
    let p = new URLSearchParams(po.body);
    eq(po.mode, CRN_SEARCH_MODE.PO_NUMBER, "PO number implies searchRange 3");
    eq(p.get("searchRange"), "3");
    eq(p.get("poNo"), "70220028100002");
    eq(p.get("rly"), "13");
    eq(p.get("dateFrom"), "");

    const dr = buildCrnSearchRequest({ dateFrom: "01/08/2026", dateTo: "31/08/2026" }, "T");
    p = new URLSearchParams(dr.body);
    eq(dr.mode, CRN_SEARCH_MODE.DATE_RANGE);
    eq(p.get("searchRange"), "2");
    eq(p.get("dateFrom"), "01/08/2026");
    eq(p.get("dateTo"), "31/08/2026");
    eq(p.get("poNo"), "");

    const big = buildCrnSearchRequest({ pageNo: 3, recordsPerPage: 2000 }, "T");
    p = new URLSearchParams(big.body);
    eq(p.get("pageNo"), "3");
    eq(p.get("recordsPerPage"), "2000");
    eq(inferCrnSearchMode({}), "last180Days");
    eq(inferCrnSearchMode({ poNo: "x" }), "poNumber");
    eq(inferCrnSearchMode({ dateTo: "01/01/2026" }), "dateRange");

    const described = describeCrnRequest(dr);
    eq(JSON.stringify(described), JSON.stringify({ criteria: "CRN", mode: "dateRange", railway: "-1", dateFrom: "01/08/2026", dateTo: "31/08/2026", pageNo: 1, recordsPerPage: 20 }));
    assert(!JSON.stringify(described).includes("TOKEN"), "description never contains the token");
    eq(describeCrnFilter({}), "Last 180 Days, All Railways");
    eq(describeCrnFilter({ poNo: "PO-1", railway: "13" }, [{ value: "13", label: "North Western Railway" }]), "PO No. PO-1, North Western Railway");
    eq(describeCrnFilter({ dateFrom: "01/08/2026", dateTo: "31/08/2026" }), "01/08/2026 to 31/08/2026, All Railways");
  });

  await test("CRN request: invalid options are rejected before anything is sent", () => {
    const codeOf = (fn) => {
      try {
        fn();
      } catch (e) {
        return e.code;
      }
      return null;
    };
    eq(codeOf(() => buildCrnSearchRequest({}, "")), CRN_ERROR.TOKEN_NOT_FOUND);
    eq(codeOf(() => buildCrnSearchRequest({ mode: "everything" }, "T")), CRN_ERROR.INVALID_REQUEST);
    eq(codeOf(() => buildCrnSearchRequest({ mode: "poNumber" }, "T")), CRN_ERROR.INVALID_REQUEST, "PO mode without PO number");
    eq(codeOf(() => buildCrnSearchRequest({ poNo: "x".repeat(65) }, "T")), CRN_ERROR.INVALID_REQUEST, "absurdly long PO number");
    eq(buildCrnSearchRequest({ poNo: "RR-PR-WC-2034-25-26-04" }, "T").poNo, "RR-PR-WC-2034-25-26-04", "22-character warranty PO numbers are accepted");
    eq(codeOf(() => buildCrnSearchRequest({ dateFrom: "01/01/2026", dateTo: "01/12/2026" }, "T")), CRN_ERROR.INVALID_REQUEST, "range > 180 days");
    eq(codeOf(() => buildCrnSearchRequest({ dateFrom: "01/08/2026" }, "T")), CRN_ERROR.INVALID_REQUEST, "missing To date");
    eq(codeOf(() => buildCrnSearchRequest({ recordsPerPage: 0 }, "T")), CRN_ERROR.INVALID_REQUEST);
    eq(codeOf(() => buildCrnSearchRequest({ recordsPerPage: CRN_CONFIG.maxRecordsPerPage + 1 }, "T")), CRN_ERROR.INVALID_REQUEST);
    eq(codeOf(() => buildCrnSearchRequest({ pageNo: "abc" }, "T")), CRN_ERROR.INVALID_REQUEST);
  });

  await test("page-link requests mirror the portal's postRequest() parameters in order (no token)", () => {
    const pag = extractCrnPagination(searchPage);
    eq(pag.serverPaginated, true);
    eq(pag.pageNumbers.join(","), "1,2,3");
    eq(pag.maxPage, 3);
    eq(pag.totalCount, 42);
    eq(pag.reportedTotal, 42);
    const req = buildCrnPageRequest(pag.links[2]);
    eq(req.pageNo, 2);
    eq(req.body, "rly=-1&dateFrom=&dateTo=&pageNo=2&searchRange=1&poNo=&count=42&recordsPerPage=20");
    assert(!req.body.includes("TOKEN"), "page links carry no token, exactly like the portal");
    let err = null;
    try {
      buildCrnPageRequest({ pageNo: 2, params: [] });
    } catch (e) {
      err = e;
    }
    eq(err && err.code, CRN_ERROR.RESULTS_INVALID);
  });

  await test("resolveIrepsUrl resolves against the IREPS base with URL(), never by concatenation", () => {
    eq(resolveIrepsUrl("/ireps/etender/ct/MMIS/CONS/2026/01/1/X_2.pdf"), `${BASE}/ireps/etender/ct/MMIS/CONS/2026/01/1/X_2.pdf`);
    eq(resolveIrepsUrl("/x.pdf", "https://www.ireps.gov.in"), "https://www.ireps.gov.in/x.pdf");
    eq(resolveIrepsUrl("http://www.ireps.gov.in/ireps/etender/ct/sbill/1/a.pdf", "https://www.ireps.gov.in"), "https://www.ireps.gov.in/ireps/etender/ct/sbill/1/a.pdf", "scheme aligned with the configured base");
    eq(resolveIrepsUrl("#"), null);
    eq(resolveIrepsUrl(""), null);
    eq(resolveIrepsUrl("javascript:void(0)"), null);
    eq(resolveIrepsUrl(null), null);
    eq(isIrepsOriginUrl(`${BASE}/ireps/x.pdf`), true);
    eq(isIrepsOriginUrl("https://evil.example/ireps/x.pdf"), false);
  });

  /* ------------------------------------------------------------- parser */

  await test("CRN parser: header matching for every captured column", () => {
    eq(matchCrnHeader("#"), "_serial");
    eq(matchCrnHeader("PO No."), "poNo");
    eq(matchCrnHeader("CRN Type\nClaim No."), "crnType");
    eq(matchCrnHeader("CRN TypeClaim No."), "crnType");
    eq(matchCrnHeader("Rly"), "railway");
    eq(matchCrnHeader("PO Sr"), "poSerial");
    eq(matchCrnHeader("CRN No."), "crnNo");
    eq(matchCrnHeader("CRN date"), "crnDate");
    eq(matchCrnHeader("Bill Claim"), "billClaimStatus");
    eq(matchCrnHeader("Bill Reg/Sign Date"), "billRegSignDate");
    eq(matchCrnHeader("Payment / Return Date"), "paymentOrReturnDate");
    eq(matchCrnHeader("Return Reason"), "returnReason");
    eq(matchCrnHeader("Action"), "_action");
    eq(matchCrnHeader("Something Else"), null);
  });

  await test("CRN parser: real layout -> one record per row, every field present, links classified", () => {
    const result = parseCrnSearchResults(resultsPage, { sourceUrl: `${BASE}/epsn/searchPO.do` });
    eq(result.structure, "table");
    eq(result.headerLabels.length, 26, "26 columns");
    eq(result.rowCount, 8);
    eq(result.recordCount, 8);
    eq(result.skippedCount, 0);
    eq(result.pagination.serverPaginated, false, "the captured CRN response has no server-side page links");
    eq(result.pageMessage, null);
    for (const r of result.records) {
      for (const f of CRN_FIELDS) assert(f.key in r, `missing key ${f.key}`);
      for (const k of CRN_LINK_FIELDS) assert(k in r, `missing link key ${k}`);
      assert(!(r.crnPdfUrl || "").includes("/MMIS/CRC/"), "claim path never taken as the CRN PDF");
      assert(!(r.claimPdfUrl || "").includes("/MMIS/CONS/"), "CRN path never taken as the claim PDF");
      assert(!(r.billPdfUrl || "").includes("/MMIS/"), "bill link never confused with MMIS documents");
    }
    eq(new Set(result.records.map((r) => r.id)).size, 8, "unique ids");
    eq(result.records[0].id, "crn-1");
    eq(result.records.map((r) => r.index).join(","), "1,2,3,4,5,6,7,8");
    assert(!JSON.stringify(result).includes("FAKE-TOKEN"), "token never reaches the parsed result");
  });

  await test("CRN parser: Warranty Replacement row (claim link, draft bill link, Not For Payment)", () => {
    const r = parseCrnSearchResults(resultsPage).records[0];
    eq(r.poNo, "RR-PR-WC-1001-25-26-01");
    eq(r.poDate, "31/01/2026");
    eq(r.challanNo, "SSE.SAMPLE.DEPOT.WAR.VENDOR", "trailing space trimmed");
    eq(r.challanDate, "12/09/2026");
    eq(r.crnType, "Warranty Replacement");
    eq(r.claimNo, "013801-26-10001");
    eq(r.claimPdfUrl, `${BASE}/ireps/etender/ct/MMIS/CRC/WAR/2026/01/10001/013801-26-10001.pdf`);
    eq(r.railway, "CR", "stray </span> in the claim anchor does not swallow the next cell");
    eq(r.poSerial, "143");
    eq(r.crnNo, "013801-26-20001");
    eq(r.crnPdfUrl, `${BASE}/ireps/etender/ct/MMIS/CONS/2026/01/20001/013801-26-20001_2.pdf`);
    eq(r.crnDate, "12/09/2026");
    eq(r.approvalDate, "18/09/2026");
    eq(r.crnQty, "1");
    eq(r.billClaimStatus, "Not For Payment");
    eq(r.billRegNo, null, "draft bill link has no number");
    eq(r.billPdfUrl, null, 'href="#" is not a PDF link');
    eq(r.invoiceNo, null);
    eq(r.claimAmount, null);
    eq(r.returnReason, null);
    eq(Object.keys(r.extra).length, 0);
  });

  await test("CRN parser: Warranty & Re-inspection row (entity decoded, bill PDF link with empty text)", () => {
    const r = parseCrnSearchResults(resultsPage).records[1];
    eq(r.crnType, "Warranty & Re-inspection");
    eq(r.claimNo, "013802-26-10002");
    assert(r.claimPdfUrl.includes("/MMIS/CRC/WAR/"), r.claimPdfUrl);
    eq(r.railway, "NWR");
    eq(r.crnNo, "013802-26-20002");
    assert(r.crnPdfUrl.endsWith("/MMIS/CONS/2026/13/20002/013802-26-20002_1.pdf"), r.crnPdfUrl);
    eq(r.billClaimStatus, "Not For Payment");
    eq(r.billRegNo, null, "anchor text empty -> null (not fabricated)");
    assert(r.billPdfUrl && r.billPdfUrl.includes("/sbill/") && r.billPdfUrl.startsWith("http"), `bill pdf kept separately: ${r.billPdfUrl}`);
  });

  await test("CRN parser: Fresh Supply rows (Signed / Paid / CO6 Number Allotted / return reason / nil)", () => {
    const [, , r3, r4, r5, r6] = parseCrnSearchResults(resultsPage).records;
    eq(r3.crnType, "Fresh Supply");
    eq(r3.claimNo, null);
    eq(r3.claimPdfUrl, null);
    eq(r3.billClaimStatus, "Signed");
    eq(r3.billRegNo, "9001000203");
    eq(r3.billRegSignDate, "18/09/2026");
    eq(r3.invoiceNo, "4471");
    eq(r3.invoiceDate, "02/09/2026");
    eq(r3.co6No, null);
    eq(r3.claimAmount, "125000.8", "amount verbatim");
    eq(r3.passedAmount, "0", "zero kept as text");
    eq(r3.crnQty, "12");
    eq(r3.challanNo, "4471", "leading whitespace trimmed");

    eq(r4.billClaimStatus, "Paid");
    eq(r4.co6No, "05010326000004");
    eq(r4.co6Date, "16/09/2026");
    eq(r4.co7No, "05010326700004");
    eq(r4.co7Date, "16/09/2026");
    eq(r4.claimAmount, "98000.5");
    eq(r4.passedAmount, "98000.5");
    eq(r4.paymentOrReturnDate, "16/09/2026");
    eq(r4.returnReason, null);

    eq(r5.billClaimStatus, "CO6 Number Allotted");
    eq(r5.co6No, "04010326000005");
    eq(r5.co7No, null);
    eq(r5.passedAmount, null);

    eq(r6.challanNo, null, "IREPS placeholder 'nil' -> null");
    eq(r6.billClaimStatus, "Signed");
    eq(r6.paymentOrReturnDate, "10/09/2026");
    eq(r6.returnReason, "# PO Modification Required. Kindly attach M.A. for DP extension.");
  });

  await test("CRN parser: CRN without a PDF link is kept with a warning; second warranty CRN keeps its own PDF", () => {
    const result = parseCrnSearchResults(resultsPage);
    const r7 = result.records[6];
    eq(r7.crnNo, "013807-26-20007");
    assert(r7.crnPdfUrl.endsWith("_3.pdf"), r7.crnPdfUrl);
    eq(r7.claimNo, "861A-26-10007");
    const r8 = result.records[7];
    eq(r8.crnNo, "013808-26-20008");
    eq(r8.crnPdfUrl, null);
    eq(r8.approvalDate, null, "empty cell -> null");
    assert(result.warnings.some((w) => w.includes("013808-26-20008") && w.includes("no PDF link")), result.warnings.join(" | "));
  });

  await test("CRN parser: columns are mapped by header label, not position; unknown headers become extras", () => {
    const html = `<table id="dTbl"><thead><tr><th>CRN No.</th><th>Rly</th><th>Bill Claim</th><th>PO No.</th><th>Cheque No</th><th>CRN Type<br>Claim No.</th></tr></thead>
      <tbody><tr><td><a href='/ireps/etender/ct/MMIS/CONS/2026/01/1/A-26-1_1.pdf'>A-26-1</a></td><td>WR</td><td>Paid</td><td>PO-9</td><td>CHQ-1</td><td><span>Fresh Supply</span><br></td></tr></tbody></table>`;
    const result = parseCrnSearchResults(html);
    eq(result.recordCount, 1);
    const r = result.records[0];
    eq(r.crnNo, "A-26-1");
    eq(r.railway, "WR");
    eq(r.billClaimStatus, "Paid");
    eq(r.poNo, "PO-9");
    eq(r.crnType, "Fresh Supply");
    eq(r.extra["Cheque No"], "CHQ-1");
    assert(r.crnPdfUrl.endsWith("/MMIS/CONS/2026/01/1/A-26-1_1.pdf"));

    const none = parseCrnSearchResults("<html><body><table><tr><th>PO No.</th><th>PO Date</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>");
    eq(none.structure, "none", "a table without a CRN No. column is not the CRN table");
    eq(none.recordCount, 0);
  });

  await test("CRN parser: rows without a CRN number are skipped; no-records page parses to zero", () => {
    const html = `<table id="dTbl"><thead><tr><th>#</th><th>PO No.</th><th>CRN No.</th><th>Rly</th><th>Bill Claim</th></tr></thead>
      <tbody><tr><td>1</td><td>PO-1</td><td></td><td>CR</td><td>Paid</td></tr>
      <tr><td>2</td><td>PO-2</td><td><a href='/ireps/etender/ct/MMIS/CONS/1/B-1_1.pdf'>B-1</a></td><td>CR</td><td>Paid</td></tr></tbody></table>`;
    const result = parseCrnSearchResults(html);
    eq(result.rowCount, 2);
    eq(result.recordCount, 1);
    eq(result.skippedCount, 1);
    eq(result.records[0].crnNo, "B-1");
    assert(result.warnings.some((w) => w.includes("row 1")), result.warnings.join(" | "));

    const empty = parseCrnSearchResults(noRecordsPage);
    eq(empty.structure, "table");
    eq(empty.rowCount, 0);
    eq(empty.recordCount, 0);
  });

  await test("pagination extraction: none on the CRN response, page links + count on paginated pages, error message", () => {
    const none = extractCrnPagination(resultsPage);
    eq(none.serverPaginated, false);
    eq(none.maxPage, 1);
    eq(none.pageNumbers.length, 0);
    eq(none.reportedTotal, 0, "IREPS prints 'Total 0 result(s)' even with rows (DataTables hides it)");
    const paged = extractCrnPagination(`<td>${pageLinks(3, 25, 10)}</td>`);
    eq(paged.serverPaginated, true);
    eq(paged.maxPage, 3);
    eq(paged.totalCount, 25);
    eq(paged.links[3].params.map(([k, v]) => `${k}=${v}`).join("&"), "rly=-1&dateFrom=&dateTo=&pageNo=3&searchRange=1&poNo=&count=25&recordsPerPage=10");
    eq(extractCrnPageMessage('<span class="errorStyle">Please enter PO No!</span>'), "Please enter PO No!");
    eq(extractCrnPageMessage(resultsPage), null);
  });

  /* ------------------------------------------------------ session checks */

  await test("validateCrnSession: PO Search page ok, login/expired -> IREPS_SESSION_EXPIRED, wrong page / HTTP error -> step code", () => {
    eq(validateCrnSession(searchPage, { ok: true, status: 200 }).authenticated, true);
    eq(validateCrnSession(resultsPage, { ok: true, status: 200 }).code, "OK");
    eq(validateCrnSession(loginPage, { ok: true, status: 200 }).code, CRN_ERROR.SESSION_EXPIRED);
    eq(validateCrnSession(expiredPage, { ok: true, status: 200 }).code, CRN_ERROR.SESSION_EXPIRED);
    eq(validateCrnSession(searchPage, { ok: true, status: 200, redirected: true, url: "https://www.ireps.gov.in/epsn/login.do" }).code, CRN_ERROR.SESSION_EXPIRED);
    eq(validateCrnSession(billPage, { ok: true, status: 200 }).code, CRN_ERROR.SEARCH_PAGE_FAILED, "Bill Status page is not the PO Search page");
    eq(validateCrnSession(billPage, { ok: true, status: 200 }, { notRecognisedCode: CRN_ERROR.RESULTS_INVALID }).code, CRN_ERROR.RESULTS_INVALID);
    eq(validateCrnSession(searchPage, { ok: false, status: 500 }).status, 500);
    eq(validateCrnSession("", { ok: true, status: 200 }).authenticated, false);
  });

  /* ------------------------------------------------------- request layer */

  await test("loadCrnSearchPage: POST searchPO.do with searchParam=showPage, form content type, credentials included", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(searchPage, { status: 200, headers: { "content-type": "text/html" } });
    };
    const res = await loadCrnSearchPage({ fetch: fetchImpl });
    eq(res.status, 200);
    eq(seen.length, 1);
    assert(seen[0].url.endsWith("/epsn/searchPO.do"), seen[0].url);
    assert(!seen[0].url.includes("viewBills"), "never the Bill Status endpoint");
    eq(seen[0].init.method, "POST");
    eq(seen[0].init.body, "searchParam=showPage");
    eq(seen[0].init.credentials, "include");
    eq(seen[0].init.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert(!("Cookie" in seen[0].init.headers), "no Cookie header is set by DocLink");
    const e = await rejects(loadCrnSearchPage({ fetch: async () => new Response("boom", { status: 503 }) }), CRN_ERROR.SEARCH_PAGE_FAILED);
    eq(e.status, 503);
  });

  /* --------------------------------------------------------- search flow */

  await test("searchCrn: showPage -> fresh token -> CRN Show Results -> parsed records (token never exposed)", async () => {
    const stages = [];
    const { fetchImpl, calls } = fakeCrnIreps({
      page: searchPage,
      onSearch: (body, token, respond) => {
        const p = new URLSearchParams(body);
        if (p.get(CRN_FORM_FIELDS.TOKEN) !== token) return respond("<html><body><h2>Invalid Token</h2></body></html>");
        return respond(resultsPage);
      }
    });
    const result = await searchCrn({ railway: "-1", pageNo: 1, recordsPerPage: 20 }, { fetch: fetchImpl, parseHtml, onProgress: (s) => stages.push(s) });

    eq(calls.length, 2, "exactly two requests");
    assert(calls.every((c) => c.url.endsWith("/epsn/searchPO.do")), "only searchPO.do is used");
    eq(calls[0].method, "POST");
    eq(calls[0].body, "searchParam=showPage");
    eq(calls[1].method, "POST");
    eq(calls[1].body, EXPECTED_BODY("TOKEN-1"), "exact captured CRN request with the dynamic token");
    eq(calls[1].headers["Content-Type"], "application/x-www-form-urlencoded");
    eq(calls[1].credentials, "include");
    eq(stages.join(","), "CHECKING_SESSION,CONNECTED,SEARCHING,PARSING");

    eq(result.success, true);
    eq(result.recordCount, 8);
    eq(result.records.length, 8);
    eq(JSON.stringify(result.search), JSON.stringify({ criteria: "CRN", mode: "last180Days", railway: "-1", pageNo: 1, recordsPerPage: 20, pagesFetched: 1 }));
    eq(result.filter, "Last 180 Days, All Railways");
    eq(result.form.railways.length, 41);
    eq(result.pagination.serverPaginated, false);
    eq(result.pagination.pagesFetched, 1);
    assert(typeof result.fetchedAt === "string" && !Number.isNaN(Date.parse(result.fetchedAt)), "fetchedAt is ISO");
    assert(!JSON.stringify(result).includes("TOKEN-1"), "result never contains the Struts token");
    eq(result.records[0].crnPdfUrl, `${BASE}/ireps/etender/ct/MMIS/CONS/2026/01/20001/013801-26-20001_2.pdf`);
  });

  await test("searchCrn: railway / PO number / date range options reach the form", async () => {
    const { fetchImpl, calls } = fakeCrnIreps({ page: searchPage, onSearch: (body, token, respond) => respond(resultsPage) });
    const r1 = await searchCrn({ railway: "13" }, { fetch: fetchImpl, parseHtml });
    let p = new URLSearchParams(calls[1].body);
    eq(p.get("rly"), "13");
    eq(p.get("searchRange"), "1");
    eq(r1.filter, "Last 180 Days, North Western Railway", "railway label resolved from the page");

    await searchCrn({ poNo: "RR-PR-WC-1001-25-26-01" }, { fetch: fetchImpl, parseHtml });
    p = new URLSearchParams(calls[3].body);
    eq(p.get("searchRange"), "3");
    eq(p.get("poNo"), "RR-PR-WC-1001-25-26-01");
    eq(p.getAll("searchCriteria").join("|"), "CRN|");

    await searchCrn({ dateFrom: "01/08/2026", dateTo: "31/08/2026", recordsPerPage: 500 }, { fetch: fetchImpl, parseHtml });
    p = new URLSearchParams(calls[5].body);
    eq(p.get("searchRange"), "2");
    eq(p.get("dateFrom"), "01/08/2026");
    eq(p.get("dateTo"), "31/08/2026");
    eq(p.get("recordsPerPage"), "500");

    await rejects(searchCrn({ dateFrom: "01/01/2026", dateTo: "01/12/2026" }, { fetch: fetchImpl, parseHtml }), CRN_ERROR.INVALID_REQUEST);
    eq(calls.length, 7, "invalid range: page loaded, no search sent");
  });

  await test("searchCrn: login page -> IREPS_SESSION_EXPIRED (no search attempted); expiry between requests", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(init);
      return new Response(loginPage, { status: 200, headers: { "content-type": "text/html" } });
    };
    await rejects(searchCrn({}, { fetch: fetchImpl, parseHtml }), CRN_ERROR.SESSION_EXPIRED);
    eq(calls.length, 1, "stops after the first request");
    await rejects(searchCrn({}, { fetch: async () => new Response(expiredPage, { status: 200 }), parseHtml }), CRN_ERROR.SESSION_EXPIRED);

    const between = fakeCrnIreps({ page: searchPage, onSearch: (body, token, respond) => respond(loginPage) });
    await rejects(searchCrn({}, { fetch: between.fetchImpl, parseHtml }), CRN_ERROR.SESSION_EXPIRED);
    eq(between.calls.length, 2, "no retry for an expired session");
  });

  await test("searchCrn: token missing, HTTP errors, unrecognised page, retry once with a fresh token", async () => {
    const noToken = searchPage.replace(/<input type="hidden" name="org\.apache\.struts\.taglib\.html\.TOKEN"[^>]*>/, "");
    const t = fakeCrnIreps({ page: noToken, onSearch: (body, token, respond) => respond(resultsPage) });
    await rejects(searchCrn({}, { fetch: t.fetchImpl, parseHtml }), CRN_ERROR.TOKEN_NOT_FOUND);
    eq(t.calls.length, 1, "no search without a token");

    const e500 = await rejects(searchCrn({}, { fetch: async () => new Response("err", { status: 500 }), parseHtml }), CRN_ERROR.SEARCH_PAGE_FAILED);
    eq(e500.status, 500);
    const s500 = fakeCrnIreps({ page: searchPage, onSearch: (body, token, respond) => respond("err", { status: 500 }) });
    const e2 = await rejects(searchCrn({}, { fetch: s500.fetchImpl, parseHtml }), CRN_ERROR.SEARCH_FAILED);
    eq(e2.status, 500);

    await rejects(searchCrn({}, { fetch: async () => new Response(billPage, { status: 200 }), parseHtml }), CRN_ERROR.SEARCH_PAGE_FAILED, "Bill Status page instead of PO Search");

    let searches = 0;
    const retry = fakeCrnIreps({
      page: searchPage,
      onSearch: (body, token, respond) => {
        searches++;
        if (searches === 1) return respond("<html><body><h2>Invalid Token</h2><p>Please try again.</p></body></html>");
        return respond(resultsPage);
      }
    });
    const result = await searchCrn({}, { fetch: retry.fetchImpl, parseHtml });
    eq(retry.calls.length, 4, "page, search, page, search");
    assert(retry.calls[3].body.includes("TOKEN=TOKEN-2"), "second attempt uses the new token");
    eq(result.recordCount, 8);

    const always = fakeCrnIreps({ page: searchPage, onSearch: (body, token, respond) => respond("<html><body><h2>Invalid Token</h2></body></html>") });
    await rejects(searchCrn({}, { fetch: always.fetchImpl, parseHtml }), CRN_ERROR.RESULTS_INVALID);
    eq(always.calls.length, 4);
  });

  await test("searchCrn: no CRNs -> IREPS_CRN_NOT_FOUND; IREPS message without table -> RESULTS_INVALID; parser crash -> PARSE_FAILED", async () => {
    const empty = fakeCrnIreps({ page: searchPage, onSearch: (body, token, respond) => respond(noRecordsPage) });
    await rejects(searchCrn({}, { fetch: empty.fetchImpl, parseHtml }), CRN_ERROR.NOT_FOUND);

    const withMessage = searchPage.replace('<span class="errorStyle"></span>', '<span class="errorStyle">Please enter PO No!</span>');
    const msg = fakeCrnIreps({ page: searchPage, onSearch: (body, token, respond) => respond(withMessage) });
    const e = await rejects(searchCrn({}, { fetch: msg.fetchImpl, parseHtml, noRetry: true }), CRN_ERROR.RESULTS_INVALID);
    assert(e.detail.includes("Please enter PO No!"), e.detail);

    const crash = fakeCrnIreps({ page: searchPage, onSearch: (body, token, respond) => respond(resultsPage) });
    await rejects(
      searchCrn({}, {
        fetch: crash.fetchImpl,
        parseHtml: () => {
          throw new Error("boom");
        }
      }),
      CRN_ERROR.PARSE_FAILED
    );
  });

  await test("searchCrn pagination: every server-side result page is fetched via the portal's page-link POSTs", async () => {
    const per = 10;
    const total = 25;
    const pageRows = (pageNo) => {
      const from = (pageNo - 1) * per + 1;
      const to = Math.min(total, pageNo * per);
      let rows = "";
      for (let i = from; i <= to; i++) rows += crnRow(i, i % 4 === 0 ? { type: "Warranty Replacement", claim: `CL-${i}` } : {});
      return rows;
    };
    const page = (n) => crnPageFrom(resultsPage, pageRows(n), pageLinks(3, total, per));
    const stages = [];
    const { fetchImpl, calls } = fakeCrnIreps({
      page: searchPage,
      onSearch: (body, token, respond) => respond(page(1)),
      onPage: (params, respond) => respond(page(Number(params.get("pageNo"))))
    });
    const result = await searchCrn({ recordsPerPage: per }, { fetch: fetchImpl, parseHtml, onProgress: (s, d) => stages.push(d ? `${s}:${d}` : s) });
    eq(calls.length, 4, "page, search, page 2, page 3");
    eq(calls[2].body, `rly=-1&dateFrom=&dateTo=&pageNo=2&searchRange=1&poNo=&count=${total}&recordsPerPage=${per}`);
    eq(calls[3].body, `rly=-1&dateFrom=&dateTo=&pageNo=3&searchRange=1&poNo=&count=${total}&recordsPerPage=${per}`);
    assert(!calls[2].body.includes("TOKEN"), "page links post without a token, like the portal");
    eq(result.recordCount, total, "all 25 CRNs across 3 pages");
    eq(result.records.map((r) => r.index).join(","), Array.from({ length: total }, (_, i) => i + 1).join(","), "continuous indexes");
    eq(new Set(result.records.map((r) => r.id)).size, total, "unique ids across pages");
    eq(result.records[24].crnNo, "999925-26-50025");
    eq(result.pagination.serverPaginated, true);
    eq(result.pagination.pagesFetched, 3);
    eq(result.pagination.pageCount, 3);
    eq(result.pagination.totalCount, total);
    eq(result.search.pagesFetched, 3);
    eq(stages.join(","), "CHECKING_SESSION,CONNECTED,SEARCHING,PARSING,PAGING:2/3,PAGING:3/3");

    const firstOnly = fakeCrnIreps({ page: searchPage, onSearch: (body, token, respond) => respond(page(1)), onPage: (params, respond) => respond(page(Number(params.get("pageNo")))) });
    const partial = await searchCrn({ recordsPerPage: per }, { fetch: firstOnly.fetchImpl, parseHtml, fetchAllPages: false });
    eq(partial.recordCount, per, "fetchAllPages:false keeps page 1 only (explicit opt-out)");
    eq(partial.pagination.pagesFetched, 1);

    const expiring = fakeCrnIreps({ page: searchPage, onSearch: (body, token, respond) => respond(page(1)), onPage: (params, respond) => respond(loginPage) });
    await rejects(searchCrn({ recordsPerPage: per }, { fetch: expiring.fetchImpl, parseHtml }), CRN_ERROR.SESSION_EXPIRED, "session expiring on page 2 fails the whole search");

    const limited = fakeCrnIreps({ page: searchPage, onSearch: (body, token, respond) => respond(page(1)), onPage: (params, respond) => respond(page(Number(params.get("pageNo")))) });
    const capped = await searchCrn({ recordsPerPage: per }, { fetch: limited.fetchImpl, parseHtml, maxPages: 2 });
    eq(capped.recordCount, 20);
    assert(capped.warnings.some((w) => w.includes("safety limit")), capped.warnings.join(" | "));
  });

  /* ---------------------------------------------------- zip / xlsx writers */

  /** Read the (STORE-method) entries back out of a zip built by buildZip. */
  function readZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder();
    const entries = [];
    let pos = 0;
    while (pos + 4 <= bytes.length && view.getUint32(pos, true) === 0x04034b50) {
      const method = view.getUint16(pos + 8, true);
      const crc = view.getUint32(pos + 14, true);
      const size = view.getUint32(pos + 18, true);
      const nameLen = view.getUint16(pos + 26, true);
      const extraLen = view.getUint16(pos + 28, true);
      const name = decoder.decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
      const data = bytes.subarray(pos + 30 + nameLen + extraLen, pos + 30 + nameLen + extraLen + size);
      entries.push({ name, method, crc, size, text: decoder.decode(data) });
      pos += 30 + nameLen + extraLen + size;
    }
    const central = view.getUint32(pos, true) === 0x02014b50;
    const eocdPos = bytes.length - 22;
    const eocd = view.getUint32(eocdPos, true) === 0x06054b50 ? { count: view.getUint16(eocdPos + 10, true), centralOffset: view.getUint32(eocdPos + 16, true) } : null;
    return { entries, central, eocd, centralAt: pos };
  }

  await test("zip writer: valid local headers, central directory, CRC-32, UTF-8 names", () => {
    eq(crc32(new TextEncoder().encode("123456789")), 0xcbf43926, "CRC-32 check value");
    eq(crc32(new Uint8Array(0)), 0);
    const bytes = buildZip([
      { name: "a.txt", data: "hello" },
      { name: "dir/b.xml", data: new TextEncoder().encode("<x>ü</x>") }
    ], { date: new Date(2026, 8, 21, 12, 30, 42) });
    eq(bytes[0], 0x50, "PK signature");
    eq(bytes[1], 0x4b);
    const zip = readZip(bytes);
    eq(zip.entries.length, 2);
    eq(zip.entries[0].name, "a.txt");
    eq(zip.entries[0].method, 0, "stored, not compressed");
    eq(zip.entries[0].text, "hello");
    eq(zip.entries[0].crc, crc32(new TextEncoder().encode("hello")));
    eq(zip.entries[1].name, "dir/b.xml");
    eq(zip.entries[1].text, "<x>ü</x>");
    eq(zip.central, true, "central directory follows the entries");
    eq(zip.eocd.count, 2, "end of central directory lists both entries");
    eq(zip.eocd.centralOffset, zip.centralAt, "central directory offset is correct");
  });

  await test("xlsx writer: package parts, inline strings, escaping, frozen header, auto-filter, column letters", () => {
    eq(columnLetter(0), "A");
    eq(columnLetter(25), "Z");
    eq(columnLetter(26), "AA");
    eq(columnLetter(28), "AC");
    const bytes = buildWorkbook({
      title: "T <1>",
      date: new Date(2026, 8, 21, 12, 30, 42),
      sheets: [
        { name: "CRN", headers: ["PO No.", "Note & \"more\""], rows: [["70220028102047", "line 1\nline <2>"], [null, " padded "]] },
        { name: "Info", headers: ["Field", "Value"], rows: [["Records", "2"]], autoFilter: false, freezeHeader: false }
      ]
    });
    const zip = readZip(bytes);
    const names = zip.entries.map((e) => e.name);
    for (const part of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "docProps/core.xml", "docProps/app.xml"]) {
      assert(names.includes(part), `missing package part ${part}`);
    }
    for (const entry of zip.entries) {
      const doc = new DOMParser().parseFromString(entry.text, "application/xml");
      assert(!doc.querySelector("parsererror"), `${entry.name} is not well-formed XML: ${entry.text.slice(0, 200)}`);
    }
    const workbook = zip.entries.find((e) => e.name === "xl/workbook.xml").text;
    assert(workbook.includes('<sheet name="CRN" sheetId="1" r:id="rId1"/>') && workbook.includes('<sheet name="Info" sheetId="2" r:id="rId2"/>'), workbook);
    const sheet = zip.entries.find((e) => e.name === "xl/worksheets/sheet1.xml").text;
    assert(sheet.includes('<c r="A1" t="inlineStr" s="1"><is><t>PO No.</t></is></c>'), "bold header cell");
    assert(sheet.includes("Note &amp; &quot;more&quot;"), "escaped header");
    assert(sheet.includes('<c r="A2" t="inlineStr"><is><t>70220028102047</t></is></c>'), "PO number kept as text, not a number");
    assert(sheet.includes('<c r="B2" t="inlineStr" s="2"><is><t xml:space="preserve">line 1\nline &lt;2&gt;</t></is></c>'), "multi-line cell wraps and escapes");
    assert(!sheet.includes('r="A3"'), "null cell is omitted");
    assert(sheet.includes('<t xml:space="preserve"> padded </t>'), "surrounding whitespace preserved");
    assert(sheet.includes('state="frozen"') && sheet.includes('<autoFilter ref="A1:B3"/>'), "frozen header + filter on the data sheet");
    const info = zip.entries.find((e) => e.name === "xl/worksheets/sheet2.xml").text;
    assert(!info.includes("frozen") && !info.includes("autoFilter"), "Info sheet has neither");
    assert(zip.entries.find((e) => e.name === "docProps/core.xml").text.includes("<dc:title>T &lt;1&gt;</dc:title>"), "title escaped");
  });

  await test("csv writer: BOM, CRLF, RFC 4180 quoting", () => {
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buildCsv(["A", "B"], [["1,2", 'say "hi"'], [null, "multi\nline"]]));
    eq(text.charCodeAt(0), 0xfeff, "BOM");
    eq(text.slice(1), 'A,B\r\n"1,2","say ""hi"""\r\n,"multi\nline"\r\n');
  });

  /* -------------------------------------------------------------- export */

  await test("CRN export: columns follow the IREPS table, split type/claim, links appended; values verbatim", () => {
    const records = parseCrnSearchResults(resultsPage).records;
    const { headers, rows } = crnTable(records);
    eq(headers.join("|"), "#|PO No.|PO Date|Challan No.|Challan Date|CRN Type|Claim No.|Rly|PO Sr|CRN No.|CRN Date|Approval Date|CRN Qty|Bill Claim|Bill Reg No.|Bill Reg/Sign Date|Invoice No.|Invoice Date|CO6 No.|CO6 Date|CO7 No.|CO7 Date|Claim Amount|Passed Amount|Payment / Return Date|Return Reason");
    assert(!headers.some((h) => /link/i.test(h)), "no link columns in the export (matches the portal's Export to Excel)");
    assert(!JSON.stringify(rows).includes("/MMIS/") && !JSON.stringify(rows).includes("/sbill/"), "no URLs in the exported rows");
    eq(headers.length, CRN_EXPORT_COLUMNS.length);
    eq(rows.length, 8);
    eq(rows[0][0], "1");
    eq(rows[0][1], "RR-PR-WC-1001-25-26-01");
    eq(rows[0][5], "Warranty Replacement");
    eq(rows[0][6], "013801-26-10001");
    eq(rows[0][9], "013801-26-20001");
    eq(rows[0][13], "Not For Payment");
    eq(rows[0][14], null, "empty cell stays empty");
    eq(rows[0].length, 26, "26 columns per row");
    eq(rows[2][22], "125000.8", "amount verbatim");
    eq(rows[3][20], "05010326700004", "CO7 No. verbatim, no numeric conversion");
    eq(rows[3][21], "16/09/2026", "CO7 Date");
    eq(rows[5][25], "# PO Modification Required. Kindly attach M.A. for DP extension.");
  });

  await test("CRN export: xlsx workbook with every record + Info sheet; csv alternative; format list", () => {
    const records = parseCrnSearchResults(resultsPage).records;
    const result = { records, filter: "Last 180 Days, All Railways", fetchedAt: "2026-09-21T07:00:42.000Z", pagination: { pagesFetched: 1 }, warnings: ["CRN 013808-26-20008: no PDF link in the CRN No. column."] };
    const xlsx = buildCrnExport(result, { now: new Date(2026, 8, 21, 12, 30, 42) });
    eq(xlsx.format, "xlsx");
    eq(xlsx.extension, "xlsx");
    eq(xlsx.mimeType, XLSX_MIME_TYPE);
    eq(xlsx.recordCount, 8);
    eq(xlsx.columnCount, 26);
    eq(xlsx.bytes[0], 0x50, "zip container");
    const zip = readZip(xlsx.bytes);
    const sheet = zip.entries.find((e) => e.name === "xl/worksheets/sheet1.xml").text;
    eq((sheet.match(/<row /g) || []).length, 9, "header + 8 CRN rows");
    assert(sheet.includes("<t>013801-26-20001</t>") && sheet.includes("<t>013808-26-20008</t>"), "first and last CRN present");
    assert(sheet.includes("<t>Warranty &amp; Re-inspection</t>"), "ampersand escaped");
    assert(!sheet.includes("FAKE-TOKEN"), "token never reaches the file");
    const info = zip.entries.find((e) => e.name === "xl/worksheets/sheet2.xml").text;
    assert(info.includes("<t>Last 180 Days, All Railways</t>") && info.includes("<t>8</t>") && info.includes("searchCriteria=CRN"), "Info sheet carries filter, count, source");
    assert(info.includes("no PDF link"), "warnings listed on the Info sheet");

    const csv = buildCrnExport(result, { format: CRN_EXPORT_FORMAT.CSV });
    eq(csv.extension, "csv");
    eq(csv.mimeType, "text/csv");
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(csv.bytes);
    assert(text.startsWith("﻿#,PO No.,PO Date,"), text.slice(0, 40));
    eq(text.trim().split("\r\n").length, 9, "header + 8 rows");
    assert(text.includes('"# PO Modification Required. Kindly attach M.A. for DP extension."') || text.includes("# PO Modification Required. Kindly attach M.A. for DP extension."), "return reason present");

    eq(buildCrnExport(result, { format: "pdf" }).format, "xlsx", "unknown format falls back to xlsx (nothing assumes a PDF)");
    eq(CRN_EXPORT_FORMATS.map((f) => f.value).join(","), "xlsx,csv");
    let err = null;
    try {
      buildCrnExport(null);
    } catch (e) {
      err = e;
    }
    assert(err, "invalid result rejected");
  });

  await test("CRN export: a large paginated result (all pages) lands completely in the workbook", () => {
    const per = 10;
    const total = 25;
    let rows = "";
    for (let i = 1; i <= total; i++) rows += crnRow(i);
    const parsed = parseCrnSearchResults(crnPageFrom(resultsPage, rows));
    const file = buildCrnExport({ records: parsed.records, filter: "x", pagination: { pagesFetched: Math.ceil(total / per) } });
    const sheet = readZip(file.bytes).entries.find((e) => e.name === "xl/worksheets/sheet1.xml").text;
    eq((sheet.match(/<row /g) || []).length, total + 1);
    assert(sheet.includes("<t>999925-26-50025</t>"), "last CRN of the last page present");
  });

  /* ------------------------------------------------------------- misc */

  await test("CRN export filenames and error catalogue", () => {
    eq(buildCrnExportFilename(new Date(2026, 8, 21, 12, 30, 42)), "IREPS_CRN_2026-09-21_12-30-42.xlsx");
    eq(buildCrnExportFilename(new Date(2026, 8, 21, 12, 30, 42), "csv"), "IREPS_CRN_2026-09-21_12-30-42.csv");
    eq(buildCrnExportFilename(new Date(2026, 8, 21, 12, 30, 42), ".XLSX"), "IREPS_CRN_2026-09-21_12-30-42.xlsx");
    eq(buildCrnExportDownloadPath(new Date(2026, 8, 21, 12, 30, 42)), "DocLink/IREPS/CRN/IREPS_CRN_2026-09-21_12-30-42.xlsx");

    eq(describeError(CRN_ERROR.SEARCH_PAGE_FAILED, { status: 500 }).title, "Unable to open IREPS PO Search");
    assert(describeError(CRN_ERROR.SEARCH_PAGE_FAILED, { status: 500 }).message.includes("HTTP 500"));
    eq(describeError(CRN_ERROR.SEARCH_FAILED).title, "Unable to search CRNs");
    eq(describeError(CRN_ERROR.RESULTS_INVALID).title, "Unable to recognise the CRN results");
    eq(describeError(CRN_ERROR.NOT_FOUND).notice, true);
    eq(describeError(CRN_ERROR.PARSE_FAILED).title, "Unable to read the CRN records");
    eq(describeError(CRN_ERROR.SESSION_EXPIRED).loginRequired, true, "shared session code");
    eq(describeError(CRN_ERROR.TOKEN_NOT_FOUND).code, IREPS_ERROR.TOKEN_NOT_FOUND);
    eq(describeError("DOCUMENT_EXPORT_ERROR").title, "Records retrieved");
    eq(describeError("DOCUMENT_DOWNLOAD_ERROR").title, "Export generated");
    eq(describeError("DOCUMENT_BUSY").title, "Download Already Running");
  });
}
