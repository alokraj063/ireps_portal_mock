/**
 * Mock IREPS server for testing DocLink without access to the real portal.
 *
 *   node test/mock/mock-ireps-server.mjs            (port 8765)
 *   PORT=9000 node test/mock/mock-ireps-server.mjs
 *
 * Behaves like the real portal from the extension's point of view
 * (modelled on the captured viewBills.do HAR):
 *
 *   GET  /epsn/home/showHome.do     Bidder Home Page in the IREPS look (captured
 *                                   layout, fictitious user) when logged in, the
 *                                   login page otherwise; "/" is an alias
 *   GET  /ireps/**                  the portal's real static files (stylesheet,
 *                                   images, jQuery) from test/mock/static, so the
 *                                   fixture pages render like IREPS
 *   GET  /mock/                     mock-only control panel: scenarios, session tools
 *   POST /login                     mock-only: simulates the security-key login
 *                                   (not captured - the real one is a PKI /
 *                                   CRISPKI flow) and sets the SAME session
 *                                   cookies the real portal uses: JSESSIONID in
 *                                   the WebSphere "cacheId+sessionId:clone:clone"
 *                                   format seen in the captures, plus the F5
 *                                   TS01b82797 cookie. Values are random; the
 *                                   server remembers which JSESSIONIDs it issued.
 *   GET  /epsn/home/logout.do       invalidates the session and clears the
 *                                   cookies (captured logout link; "/logout" alias)
 *   GET  /mock/session/expire       invalidates every session server-side but
 *                                   leaves the browser cookie in place - the real
 *                                   "session timed out" case: the cookie is still
 *                                   sent, the portal answers with the login page
 *   POST /epsn/admin/viewBills.do   empty body  -> Bill Status page with the
 *                                   vendorPartyCodeForm, a FRESH fake Struts
 *                                   token, the zone list, searchRange radios,
 *                                   date controls, "Show Results" and the
 *                                   default (Last 90 Days) bill blocks
 *   POST /epsn/admin/viewBills.do   form body   -> requires TOKEN, zone,
 *                                   searchRange, dateFrom, dateTo, submit and
 *                                   searchParam; the token must be one this
 *                                   server issued (single use); returns the
 *                                   matching bill blocks
 *   GET  /epsn/admin/viewBills.do   same as the empty POST (browser link)
 *   GET  /epsn/login.do             login page (target of redirect-login)
 *
 * CRN workflow (modelled on the captured searchPO.do HAR, separate endpoint):
 *
 *   POST /epsn/searchPO.do          searchParam=showPage -> "PO Search" page with
 *                                   searchPOForm, a FRESH fake Struts token, the
 *                                   searchCriteria list (PO … CRN …), the railway
 *                                   list, searchRange radios, recordsPerPage
 *   POST /epsn/searchPO.do          form body -> requires TOKEN (single use), pageNo,
 *                                   searchCriteria ("CRN", "RNOTE" or "MA"),
 *                                   rly, poNo, icNo, dateFrom, dateTo, searchRange,
 *                                   recordsPerPage, submit and the trailing empty
 *                                   searchCriteria; returns the CRN or R-NOTE
 *                                   results table (table#table_id > table#dTbl) in
 *                                   ONE response like the real portal (the R-NOTE
 *                                   layout is an assumption - no capture yet)
 *   POST /epsn/searchPO.do          page-link body (rly, dateFrom, dateTo, pageNo,
 *                                   searchRange, poNo, count, recordsPerPage - no
 *                                   token) -> one result page (scenario crn-paged)
 *   GET  /epsn/searchPO.do          same as searchParam=showPage (browser link)
 *   GET  /ireps/etender/ct/**.pdf   the documents the result tables link to
 *   GET  /mock/ma/**.pdf, /mock/po/**.pdf   MA / PO PDFs of the MA search
 *                                   (small real PDFs; login page without cookie)
 *
 *   MA (searchCriteria=MA): rows modelled on the captured MA table (Sr. No.,
 *   Dept / Rly. Unit, PO No., PO Date, PO_SR, MA No., MA Date, Action(s)); the
 *   default scenario generates 14 MAs dated today .. 3 days ago so the
 *   popup's "today" default finds some; PO links go to /mock/po/<PO>.pdf and
 *   MA links (title="View/Download MA") to /mock/ma/<PO>_<MA>.pdf.
 *
 * Without a JSESSIONID this server issued (no cookie, or an expired one) the
 * portal answers with the login page (HTTP 200, like many Struts applications)
 * unless a scenario overrides it.
 *
 * Scenario override (open in any tab, or curl):
 *
 *   GET /mock/scenario/auto           cookie decides (default), 6 bills
 *   GET /mock/scenario/bills          6 bills (fixture data) regardless of cookie
 *   GET /mock/scenario/large          300 generated bills
 *   GET /mock/scenario/login          always the login page (HTTP 200)
 *   GET /mock/scenario/redirect-login 302 -> /epsn/login.do
 *   GET /mock/scenario/expired        always "session expired" (HTTP 200)
 *   GET /mock/scenario/no-records     authenticated page, zero bill blocks
 *   GET /mock/scenario/token-missing  authenticated page without the TOKEN input
 *   GET /mock/scenario/token-invalid  every search answers "Invalid token"
 *   GET /mock/scenario/http500        HTTP 500
 *   GET /mock/scenario/slow           bills, after a 6 second delay
 *   GET /mock/scenario/legacy         old single-table layout (fallback parser)
 *   GET /mock/scenario/crn-paged      CRN results paginated server-side (recordsPerPage per page, page links)
 *   GET /mock/scenario/crn-large      300 generated CRNs / 120 R-NOTEs / 200 MAs in one response
 *   GET /mock/scenario/ma-pdf-login   every MA/PO PDF URL answers with the login page (session expired mid-download)
 *   GET /mock/scenario/ma-pdf-404     every MA/PO PDF URL answers HTTP 404
 *   GET /mock/status                  current scenario + live session count (JSON)
 *
 * No real session cookie, token or business data is used anywhere here: the
 * JSESSIONID values are random and only mimic the real cookie's shape.
 */

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");
/** Real IREPS static files (stylesheets, images, jQuery) served at their portal paths so mock pages look like the portal. */
const staticRoot = join(here, "static");
const PORT = Number(process.env.PORT || 8765);

const pages = {
  home: readFileSync(join(fixtures, "home-page.html"), "utf8"),
  billPage: readFileSync(join(fixtures, "bill-status-page.html"), "utf8"),
  legacy: readFileSync(join(fixtures, "bill-status-sample.html"), "utf8"),
  login: readFileSync(join(fixtures, "login-page.html"), "utf8"),
  expired: readFileSync(join(fixtures, "session-expired.html"), "utf8"),
  crnSearch: readFileSync(join(fixtures, "crn-search-page.html"), "utf8"),
  crnResults: readFileSync(join(fixtures, "crn-results-page.html"), "utf8"),
  rnoteResults: readFileSync(join(fixtures, "rnote-results-page.html"), "utf8"),
  maResults: readFileSync(join(fixtures, "ma-results-page.html"), "utf8")
};

const FIXTURE_TOKEN_RE = /(name="org\.apache\.struts\.taglib\.html\.TOKEN"\s+value=")[^"]*(")/;
const DATA_START = "<!-- Display Data From here -->";
const DATA_END = "<!-- Display Data Up to here -->";

const pageHead = pages.billPage.slice(0, pages.billPage.indexOf(DATA_START) + DATA_START.length);
const pageTail = pages.billPage.slice(pages.billPage.indexOf(DATA_END));
const fixtureBlocks = pages.billPage.slice(pageHead.length, pages.billPage.indexOf(DATA_END));

/** zone code -> label, read from the fixture's <select name="zone"> so the mock never drifts from it. */
const ZONES = new Map();
for (const m of pages.billPage.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)) ZONES.set(m[1], m[2]);

let scenario = "auto";
/** The portal keeps the last searchCriteria server-side; page links post without it. */
let lastSearchCriteria = "CRN";

/* -------------------------------------------------------------------------- */
/* Session cookies (same names and shape as the real portal)                  */
/* -------------------------------------------------------------------------- */

/**
 * The captures show two cookies on every authenticated request:
 *   JSESSIONID=0003gdeFyvROQQGUoP7WKy_ddfs:1886tt34a:1886tsaig   (WebSphere:
 *     4-digit cache id + 23-char session id + ":cloneId:cloneId")
 *   TS01b82797=01ee28b444...                                      (F5 BIG-IP)
 * The mock issues cookies of exactly that shape (random values) so DocLink
 * and the mock exchange the same session the real portal would.
 */
const SESSION_COOKIE = "JSESSIONID";
const LB_COOKIE = "TS01b82797";
const CLONE_IDS = ["1886tsaig", "1886tt34a", "1886tujvp"];
/** JSESSIONID values this server issued and has not invalidated. */
const liveSessions = new Set();

function base64UrlId(bytes) {
  return randomBytes(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function issueSession() {
  const cacheId = String(Math.floor(Math.random() * 6)).padStart(4, "0");
  const sessionId = base64UrlId(17).slice(0, 23);
  const clones = [...CLONE_IDS].sort(() => Math.random() - 0.5).slice(0, 2);
  const value = `${cacheId}${sessionId}:${clones[0]}:${clones[1]}`;
  liveSessions.add(value);
  return value;
}

function parseCookies(req) {
  const out = new Map();
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

/** Logged in = the request carries a JSESSIONID this server issued and has not expired. */
function hasSession(req) {
  const id = parseCookies(req).get(SESSION_COOKIE);
  return Boolean(id && liveSessions.has(id));
}

function sessionCookies(value) {
  return [`${SESSION_COOKIE}=${value}; Path=/; HttpOnly`, `${LB_COOKIE}=01${randomBytes(30).toString("hex")}; Path=/`];
}

function clearedSessionCookies() {
  return [`${SESSION_COOKIE}=; Path=/; Max-Age=0`, `${LB_COOKIE}=; Path=/; Max-Age=0`];
}

/* -------------------------------------------------------------------------- */
/* Struts-like single-use tokens                                              */
/* -------------------------------------------------------------------------- */

const issuedTokens = [];
function issueToken() {
  const token = randomBytes(16).toString("hex");
  issuedTokens.push(token);
  while (issuedTokens.length > 10) issuedTokens.shift();
  return token;
}
function consumeToken(token) {
  const i = issuedTokens.indexOf(token);
  if (i === -1) return false;
  issuedTokens.splice(i, 1);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Bill data (fictitious)                                                     */
/* -------------------------------------------------------------------------- */

const STATUSES = ["REGISTERED", "RETURNED", "PAYMENT MADE", "PASSED"];
const ZONE_CODES = ["13", "37", "01", "03", "08"]; // ICF, SCoR, CR, NR, WR

function generatedBills(count) {
  const bills = [];
  for (let i = 1; i <= count; i++) {
    const status = STATUSES[i % STATUSES.length];
    const zoneCode = ZONE_CODES[i % ZONE_CODES.length];
    const day = String((i % 28) + 1).padStart(2, "0");
    const month = String(((i % 3) + 7)).padStart(2, "0"); // 07..09 (inside "last 90 days" of Sep 2026)
    const amount = 100000 + i * 1234;
    const paid = status === "PAYMENT MADE" || status === "PASSED";
    bills.push({
      contractNo: `${zoneCode}24${String(i).padStart(10, "0")}`,
      contractDate: "03/08/2024",
      billNumber: status === "RETURNED" ? "-" : `9001${String(i).padStart(6, "0")}`,
      billDate: `${day}/${month}/2026`,
      zoneCode,
      partyName: "SAMPLE RAIL COMPONENTS PRIVATE LIMITED-UNIT 1",
      partyCode: "MM00:001",
      co6No: `${zoneCode}010326${String(i).padStart(6, "0")}`,
      co6Date: `${day}/${month}/2026`,
      status,
      billAmount: String(amount),
      passedAmount: String(amount),
      deductedAmount: paid ? String(Math.round(amount * 0.02)) : "0",
      netAmount: paid ? String(amount - Math.round(amount * 0.02)) : String(amount),
      co7No: paid ? `${zoneCode}010326700${String(i).padStart(3, "0")}` : "----",
      co7Date: paid ? `${day}/${month}/2026` : "----",
      paymentAdviceDate: status === "PAYMENT MADE" ? `${day}/${month}/2026` : "NA",
      accountingUnit: `${ZONES.get(zoneCode)} HEADQUARTER`,
      reasonForReturn: status === "RETURNED" ? `BILL RETURNED: DOCUMENT ${i} MISSING. PLEASE RESUBMIT WITH CRN.` : null,
      recoveryDetails: status === "PAYMENT MADE" && i % 2 === 0 ? `GST TDS DEDUCTION: ${Math.round(amount * 0.01)}<br>INCOME TAX - CONTR (Company): ${Math.round(amount * 0.01)}<br>OTHER CHARGES: 318` : null
    });
  }
  return bills;
}

function renderBlock(b) {
  const section = (title, colour, text) =>
    text
      ? `
						  		 <tr>
						  		 	<th colspan="11" style="background-color: ${colour};">${title}</th>
						  		 </tr>
						  		 <tr>
						  		 	<td colspan="11">${text}</td>
						  		 </tr>
`
      : "";
  const td = (v) => `<td class="dataText" style="text-align:left;padding-left:10px"> ${v}</td>`;
  return `
							    <tr><td>
							    <table><tr><td>&nbsp;</td></tr><tr><td>&nbsp;</td></tr></table>
							     <table class="boxStyle"  width="100%" border="1" cellspacing="0" id="table_id" >
							   <tr height="30px"  style="background-color: #DCEAF7;">
							   <th>Contract No </th>
							 <th>Contract Date</th>
							   <th>Bill Number </th>
							    <th>Bill Date </th>
							    <th>Zone </th>
							    <th colspan="5">Party Name </th>
							     <th>PartyCode</th>
							   </tr>
							   <tr>
							   <td>${b.contractNo}</td>
							   <td>${b.contractDate}</td>
							   <td>${b.billNumber}</td>
							    <td> ${b.billDate}</td>
							   <td>${ZONES.get(b.zoneCode) || b.zoneCode}</td>
							   <td colspan="5">${b.partyName}</td>
							   <td>${b.partyCode}</td>

							   </tr>

							    <tr style="background-color: #FFF3CD;">
<!-- 						   			<th width="5%"  style="text-align:center;">S.No</FONT></th>
 -->						   	<th width="15%" style="text-align:left;padding-left:10px">CO6 No</th>
						   			<th width="10%" style="text-align:left;padding-left:10px">CO6 Date</th>
						   			<th width="10%" style="text-align:left;padding-left:10px">Status</th>
						   			<th width="10%" style="text-align:left;padding-left:10px">Bill Amt</th>
						   			<th width="10%" style="text-align:left;padding-left:10px">Passed Amt</th>
						   			<th width="10%" style="text-align:left;padding-left:10px">Deducted Amt</th>
						   			<th width="10%" style="text-align:left;padding-left:10px">Net Amt</th>
						   			<th width="10%" style="text-align:left;padding-left:10px">CO7 No</th>
						   			<th width="15%" style="text-align:left;padding-left:10px">CO7 Date</th>
							   <th>Payment Advice Date to Bank</th>
							     <th>Accounting Unit(Division)</th>
						  	    </tr>
								<tr>
						         	 ${td(b.co6No)}
						         	 ${td(b.co6Date)}
						         	 ${td(b.status)}
						         	 ${td(b.billAmount)}
						         	 ${td(b.passedAmount)}
						         	 ${td(b.deductedAmount)}
						         	 ${td(b.netAmount)}
						         	 ${td(b.co7No)}
						         	 ${td(b.co7Date)}
							   <td>${b.paymentAdviceDate}</td>
							     <td>${b.accountingUnit}</td>
						       </tr>
${section("Reason For Return", "#F8D7DA", b.reasonForReturn)}${section("Recovery Details", "#F5C6CB", b.recoveryDetails)}
						  		 </table>
`;
}

/* -------------------------------------------------------------------------- */
/* Page rendering                                                             */
/* -------------------------------------------------------------------------- */

function renderBillPage({ blocksHtml, token = issueToken(), message = "", withToken = true }) {
  let head = pageHead.replace(FIXTURE_TOKEN_RE, `$1${token}$2`);
  if (!withToken) head = head.replace(/<input type="hidden" name="org\.apache\.struts\.taglib\.html\.TOKEN"[^>]*>/, "");
  if (message) head = head.replace('<span class="errorStyle"></span>', `<span class="errorStyle">${message}</span>`);
  return head + blocksHtml + pageTail;
}

function parseDate(text) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text || "");
  return m ? new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))) : null;
}

/** Apply the submitted search to a list of bill objects (generated data). */
function filterBills(bills, form) {
  if (form.searchRange === "3") return bills.filter((b) => form.zone === "-1" || b.zoneCode === form.zone);
  if (form.searchRange === "2") {
    const from = parseDate(form.dateFrom);
    const to = parseDate(form.dateTo);
    return bills.filter((b) => {
      const d = parseDate(b.billDate);
      return d && from && to && d >= from && d <= to;
    });
  }
  return bills;
}

function blocksFor(form) {
  const search = form || { searchRange: "1", zone: "-1", dateFrom: "", dateTo: "" };
  if (scenario === "no-records") return "";
  if (scenario === "large") return filterBills(generatedBills(300), search).map(renderBlock).join("");
  if (search.searchRange === "1") return fixtureBlocks;
  // Fixture blocks are static HTML; for zone / date searches use the same
  // six bills as data so filtering behaves like the real portal.
  const six = generatedBills(6);
  return filterBills(six, search).map(renderBlock).join("");
}

const REQUIRED_FIELDS = ["org.apache.struts.taglib.html.TOKEN", "zone", "searchRange", "dateFrom", "dateTo", "submit", "searchParam"];

function validateSearch(form) {
  const missing = REQUIRED_FIELDS.filter((f) => !form.has(f));
  if (missing.length) return `Missing form field(s): ${missing.join(", ")}`;
  if (form.get("submit") !== "Show Results") return `Unexpected submit value "${form.get("submit")}"`;
  if (!["1", "2", "3"].includes(form.get("searchRange"))) return `Unexpected searchRange "${form.get("searchRange")}"`;
  if (form.get("searchRange") === "2") {
    const from = form.get("dateFrom");
    const to = form.get("dateTo");
    if (from.length !== 10) return "Please enter From Date!";
    if (to.length !== 10) return "Please enter To Date!";
    const dFrom = parseDate(from);
    const dTo = parseDate(to);
    if (!dFrom || !dTo) return "Dates must be DD/MM/YYYY";
    if (dFrom > dTo) return "From Date must be earlier than To Date!";
    if (Math.ceil((dTo - dFrom) / 86400000) > 180) return "Selected Date Range should be within 180 days.";
  }
  return null;
}


/* -------------------------------------------------------------------------- */
/* CRN data (fictitious) and page rendering                                   */
/* -------------------------------------------------------------------------- */

const CRN_ROWS_START = "<!-- CRN rows from here -->";
const CRN_ROWS_END = "<!-- CRN rows up to here -->";
const CRN_PAGINATION_SLOT = "<!-- CRN pagination -->";

const crnResultsHead = pages.crnResults.slice(0, pages.crnResults.indexOf(CRN_ROWS_START) + CRN_ROWS_START.length);
const crnResultsTail = pages.crnResults.slice(pages.crnResults.indexOf(CRN_ROWS_END));
const crnFixtureRows = pages.crnResults.slice(crnResultsHead.length, pages.crnResults.indexOf(CRN_ROWS_END));

/** rly code -> short label shown in the "Rly" column (fictitious but plausible). */
const CRN_RAILWAYS = [
  { code: "01", short: "CR" },
  { code: "13", short: "NWR" },
  { code: "07", short: "SCR" },
  { code: "04", short: "NER" },
  { code: "06", short: "SR" },
  { code: "05", short: "NFR" },
  { code: "09", short: "WR" }
];
const CRN_TYPES = ["Fresh Supply", "Fresh Supply", "Warranty Replacement", "Fresh Supply", "Warranty & Re-inspection"];
const BILL_CLAIMS = ["Paid", "Signed", "Not For Payment", "CO6 Number Allotted", "Not For Payment"];

/** Fixture rows as data (so filters work the same way for fixture and generated rows). */
const CRN_FIXTURE_DATA = [
  { poNo: "RR-PR-WC-1001-25-26-01", poDate: "31/01/2026", rly: "01", crnNo: "013801-26-20001", crnDate: "12/09/2026" },
  { poNo: "70220028100002", poDate: "13/12/2025", rly: "13", crnNo: "013802-26-20002", crnDate: "17/09/2026" },
  { poNo: "LR-SCR-2026-0003", poDate: "27/10/2025", rly: "07", crnNo: "013803-26-20003", crnDate: "16/09/2026" },
  { poNo: "05220028100004", poDate: "20/05/2026", rly: "05", crnNo: "013804-26-20004", crnDate: "04/09/2026" },
  { poNo: "04220028100005", poDate: "22/08/2025", rly: "04", crnNo: "013805-26-20005", crnDate: "17/09/2026" },
  { poNo: "06220028100006", poDate: "02/11/2025", rly: "06", crnNo: "013806-26-20006", crnDate: "17/09/2026" },
  { poNo: "RR-PR-WC-1007-25-26-07", poDate: "14/02/2026", rly: "01", crnNo: "013807-26-20007", crnDate: "01/09/2026" },
  { poNo: "09220028100008", poDate: "05/03/2026", rly: "09", crnNo: "013808-26-20008", crnDate: "15/09/2026" }
];

function generatedCrns(count) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    const railway = CRN_RAILWAYS[i % CRN_RAILWAYS.length];
    const typeIndex = i % CRN_TYPES.length;
    const day = String((i % 28) + 1).padStart(2, "0");
    const month = String(((i % 3) + 7)).padStart(2, "0"); // Jul..Sep 2026, inside "Last 180 Days"
    const crnNo = `0138${String(i % 100).padStart(2, "0")}-26-${String(30000 + i).padStart(5, "0")}`;
    const claimNo = `0138${String(i % 100).padStart(2, "0")}-26-${String(10000 + i).padStart(5, "0")}`;
    const warranty = CRN_TYPES[typeIndex].startsWith("Warranty");
    out.push({
      serial: i,
      poNo: warranty ? `RR-PR-WC-${2000 + i}-25-26-${String(i % 12 + 1).padStart(2, "0")}` : `${railway.code}2200281${String(i).padStart(5, "0")}`,
      poDate: `${day}/0${(i % 6) + 1}/2026`,
      challanNo: warranty ? "SSE.SAMPLE.DEPOT.WAR.VENDOR" : String(4000 + i),
      challanDate: `${day}/${month}/2026`,
      crnType: CRN_TYPES[typeIndex],
      claimNo: warranty ? claimNo : null,
      rly: railway.code,
      rlyShort: railway.short,
      poSerial: String((i % 5) + 1).padStart(3, "0"),
      crnNo,
      crnDate: `${day}/${month}/2026`,
      approvalDate: `${day}/${month}/2026`,
      crnQty: String((i % 20) + 1),
      billClaim: BILL_CLAIMS[typeIndex],
      billRegNo: warranty ? null : `90010${String(i).padStart(5, "0")}`,
      amount: String(10000 + i * 37)
    });
  }
  return out;
}

function renderCrnRow(r) {
  const pd = (v) => `<td class="payDtlCls1">${v ?? ""}</td>`;
  const typeCell = r.claimNo
    ? `<span style='color:red;'>${r.crnType}</span><br><a href='/ireps/etender/ct/MMIS/CRC/WAR/2026/${r.rly}/${10000 + r.serial}/${r.claimNo}.pdf' target='_blank'>${r.claimNo}</span>`
    : `<span style='color:blue;'>${r.crnType}</span><br>`;
  const billCell = r.billRegNo
    ? `<a href="/ireps/etender/ct/sbill/2026/SAMPLE_833_${r.billRegNo}.pdf" title="Click here to View / Download Bill PDF" target="_blank"> ${r.billRegNo}</a>`
    : `<a href="#" onclick="postRequestNewWindow('/epsn/ct/generateBillPreview.do?billRegNo=')" title="Click Here to View / Sign & Submit Draft Supplier Bill" ></a>`;
  const paid = r.billClaim === "Paid";
  const co6 = paid || r.billClaim === "CO6 Number Allotted";
  return `
									<tr>
										<td>${r.serial}</td>
										<td>${r.poNo}</td>
										<td>${r.poDate}</td>
										<td>${r.challanNo}</td>
										<td>${r.challanDate}</td>
										<td>${typeCell}</td>
										<td>${r.rlyShort}</td>
										<td>${r.poSerial}</td>
										<td><a href='/ireps/etender/ct/MMIS/CONS/2026/${r.rly}/${20000 + r.serial}/${r.crnNo}_1.pdf' target="_blank">${r.crnNo}</a></td>
										<td>${r.crnDate}</td>
										<td>${r.approvalDate}</td>
										<td>${r.crnQty}</td>
										<td class="searchDtlCls">
											${r.billClaim === "Not For Payment" ? "<span style='color: red;'>Not For Payment</span>" : r.billClaim}
										</td>
										<td class="payDtlCls1">
											${billCell}
										</td>
										${pd(r.billRegNo ? r.crnDate : "")}${pd(r.billRegNo ? r.challanNo : "")}${pd(r.billRegNo ? r.challanDate : "")}
										${pd(co6 ? `${r.rly}010326${String(r.serial).padStart(6, "0")}` : "")}${pd(co6 ? r.approvalDate : "")}
										${pd(paid ? `${r.rly}010326700${String(r.serial).padStart(3, "0")}` : "")}${pd(paid ? r.approvalDate : "")}
										${pd(r.billRegNo ? r.amount : "")}${pd(paid ? r.amount : r.billRegNo ? "0" : "")}${pd(paid ? r.approvalDate : "")}${pd("")}
										<td>
											<a title="Manage Your Purchase Order" class="linkStyle" href="#" onclick="postRequest('/epsn/dispatchParticulars/showDispatchParticular.do?rly=${r.rly}&poKey=${10000 + r.serial}&poNo=${r.poNo}')" >
												<img src="/ireps/images/common/icon_view.gif" alt="Manage Your Purchase Order" height="15" width="15" border="0" class="linkStyle" />
											</a>
										</td>
									</tr>
`;
}

/** Apply the submitted CRN search (rly / date range / PO number) to a data list. */
function filterCrns(list, form) {
  let out = list;
  if (form.rly && form.rly !== "-1") out = out.filter((r) => r.rly === form.rly);
  if (form.searchRange === "3") out = out.filter((r) => r.poNo === form.poNo);
  if (form.searchRange === "2") {
    const from = parseDate(form.dateFrom);
    const to = parseDate(form.dateTo);
    out = out.filter((r) => {
      const d = parseDate(r.crnDate);
      return d && from && to && d >= from && d <= to;
    });
  }
  return out;
}

/** Fixture rows are static HTML; select them by the same rules using CRN_FIXTURE_DATA. */
function fixtureRowsFor(form) {
  const keep = new Set(filterCrns(CRN_FIXTURE_DATA, form).map((r) => r.crnNo));
  const rows = crnFixtureRows.split(/(?=\n\s*<tr>)/).filter((chunk) => /<tr>/.test(chunk));
  return rows.filter((chunk) => Array.from(keep).some((no) => chunk.includes(no))).join("");
}

function renderCrnPagination(form, pageNo, pageCount, total) {
  if (pageCount <= 1) return "";
  const link = (p, text, colour) =>
    `<a href="#" style="color: ${colour}; text-decoration: underline; text-align: right;" onclick="postRequest('/epsn/searchPO.do?rly=${form.rly}&dateFrom=${form.dateFrom}&dateTo=${form.dateTo}&pageNo=${p}&searchRange=${form.searchRange}&poNo=${form.poNo}&count=${total}&recordsPerPage=${form.recordsPerPage}');">${text}</a>&nbsp;`;
  let html = "";
  for (let p = 1; p <= pageCount; p++) html += link(p, String(p), p === pageNo ? "#FF3333" : "#0033FF");
  if (pageNo < pageCount) html += link(pageNo + 1, '<font color="#0033FF">next</font>', "#0033FF");
  return html;
}

/**
 * Render the CRN results page for a search. Like the real portal the default
 * behaviour returns every matching row in one response (client-side
 * DataTables paging); scenario "crn-paged" paginates server-side instead.
 */
function renderCrnResults(form, { token = issueToken(), message = "" } = {}) {
  let head = crnResultsHead.replace(FIXTURE_TOKEN_RE, `$1${token}$2`);
  if (message) head = head.replace('<span class="errorStyle"></span>', `<span class="errorStyle">${message}</span>`);
  let tail = crnResultsTail;

  let rowsHtml = "";
  let total = 0;
  if (scenario === "no-records") {
    rowsHtml = "";
  } else if (scenario === "crn-large" || scenario === "crn-paged") {
    const all = filterCrns(generatedCrns(scenario === "crn-large" ? 300 : 47), form);
    total = all.length;
    let slice = all;
    if (scenario === "crn-paged") {
      const per = Math.max(1, Number(form.recordsPerPage) || 20);
      const pageNo = Math.max(1, Number(form.pageNo) || 1);
      const pageCount = Math.max(1, Math.ceil(total / per));
      slice = all.slice((pageNo - 1) * per, pageNo * per);
      tail = tail.replace(CRN_PAGINATION_SLOT, renderCrnPagination({ ...form, recordsPerPage: per }, pageNo, pageCount, total));
    }
    rowsHtml = slice.map((r, i) => renderCrnRow({ ...r, serial: scenario === "crn-paged" ? r.serial : i + 1 })).join("");
  } else {
    rowsHtml = fixtureRowsFor(form);
  }
  return head + rowsHtml + tail;
}

/* ------------------------------------------------------------------ RNOTE */

const RNOTE_ROWS_START = "<!-- RNOTE rows from here -->";
const RNOTE_ROWS_END = "<!-- RNOTE rows up to here -->";
const RNOTE_PAGINATION_SLOT = "<!-- RNOTE pagination -->";
const rnoteResultsHead = pages.rnoteResults.slice(0, pages.rnoteResults.indexOf(RNOTE_ROWS_START) + RNOTE_ROWS_START.length);
const rnoteResultsTail = pages.rnoteResults.slice(pages.rnoteResults.indexOf(RNOTE_ROWS_END));
const rnoteFixtureRows = pages.rnoteResults.slice(rnoteResultsHead.length, pages.rnoteResults.indexOf(RNOTE_ROWS_END));

const RNOTE_FIXTURE_DATA = [
  { poNo: "RR-PR-WC-1001-25-26-01", rly: "01", rnoteNo: "RN-013801-26-40001", crnDate: "10/09/2026" },
  { poNo: "70220028100002", rly: "13", rnoteNo: "RN-013802-26-40002", crnDate: "11/09/2026" },
  { poNo: "LR-SCR-2026-0003", rly: "07", rnoteNo: "RN-013803-26-40003", crnDate: "12/09/2026" }
];
const RNOTE_STATUSES = ["Accepted", "Accepted", "Partially Accepted", "Rejected"];

function generatedRnotes(count) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    const railway = CRN_RAILWAYS[i % CRN_RAILWAYS.length];
    const day = String((i % 28) + 1).padStart(2, "0");
    const month = String(((i % 3) + 7)).padStart(2, "0");
    out.push({
      serial: i,
      poNo: `${railway.code}2200281${String(i).padStart(5, "0")}`,
      poDate: `${day}/0${(i % 6) + 1}/2026`,
      rly: railway.code,
      rlyShort: railway.short,
      poSerial: String((i % 5) + 1).padStart(3, "0"),
      rnoteNo: `RN-0138${String(i % 100).padStart(2, "0")}-26-${String(40000 + i)}`,
      crnDate: `${day}/${month}/2026`, // date used by the shared filter (R-Note Date)
      challanNo: String(4000 + i),
      challanDate: `${day}/${month}/2026`,
      invoiceNo: i % 4 ? String(3000 + i) : "",
      invoiceDate: i % 4 ? `${day}/${month}/2026` : "",
      qty: String((i % 20) + 1),
      status: RNOTE_STATUSES[i % RNOTE_STATUSES.length]
    });
  }
  return out;
}

function renderRnoteRow(r) {
  return `
									<tr>
										<td>${r.serial}</td>
										<td>${r.poNo}</td>
										<td>${r.poDate}</td>
										<td>${r.rlyShort}</td>
										<td>${r.poSerial}</td>
										<td><a href='/ireps/etender/ct/MOCK/RNOTE/2026/${r.rly}/${40000 + r.serial}/${r.rnoteNo}.pdf' target="_blank">${r.rnoteNo}</a></td>
										<td>${r.crnDate}</td>
										<td>${r.challanNo}</td>
										<td>${r.challanDate}</td>
										<td>${r.invoiceNo}</td>
										<td>${r.invoiceDate}</td>
										<td>${r.qty}</td>
										<td>${r.status}</td>
										<td>
											<a title="Manage Your Purchase Order" class="linkStyle" href="#" onclick="postRequest('/epsn/dispatchParticulars/showDispatchParticular.do?rly=${r.rly}&poKey=${10000 + r.serial}&poNo=${r.poNo}')" >
												<img src="/ireps/images/common/icon_view.gif" alt="Manage Your Purchase Order" height="15" width="15" border="0" class="linkStyle" />
											</a>
										</td>
									</tr>
`;
}

function rnoteFixtureRowsFor(form) {
  const keep = new Set(filterCrns(RNOTE_FIXTURE_DATA, form).map((r) => r.rnoteNo));
  const rows = rnoteFixtureRows.split(/(?=\n\s*<tr>)/).filter((chunk) => /<tr>/.test(chunk));
  return rows.filter((chunk) => Array.from(keep).some((no) => chunk.includes(no))).join("");
}

/** R-NOTE results page (assumed layout); same scenarios as CRN. */
function renderRnoteResults(form, { token = issueToken(), message = "" } = {}) {
  let head = rnoteResultsHead.replace(FIXTURE_TOKEN_RE, `$1${token}$2`);
  if (message) head = head.replace('<span class="errorStyle"></span>', `<span class="errorStyle">${message}</span>`);
  let tail = rnoteResultsTail;
  let rowsHtml = "";
  if (scenario === "no-records") {
    rowsHtml = "";
  } else if (scenario === "crn-large" || scenario === "crn-paged") {
    const all = filterCrns(generatedRnotes(scenario === "crn-large" ? 120 : 47), form);
    const total = all.length;
    let slice = all;
    if (scenario === "crn-paged") {
      const per = Math.max(1, Number(form.recordsPerPage) || 20);
      const pageNo = Math.max(1, Number(form.pageNo) || 1);
      const pageCount = Math.max(1, Math.ceil(total / per));
      slice = all.slice((pageNo - 1) * per, pageNo * per);
      tail = tail.replace(RNOTE_PAGINATION_SLOT, renderCrnPagination({ ...form, recordsPerPage: per }, pageNo, pageCount, total));
    }
    rowsHtml = slice.map((r, i) => renderRnoteRow({ ...r, serial: scenario === "crn-paged" ? r.serial : i + 1 })).join("");
  } else {
    rowsHtml = rnoteFixtureRowsFor(form);
  }
  return head + rowsHtml + tail;
}

/* --------------------------------------------------------------------- MA */

const MA_ROWS_START = "<!-- MA rows from here -->";
const MA_ROWS_END = "<!-- MA rows up to here -->";
const MA_PAGINATION_SLOT = "<!-- MA pagination -->";
const maResultsHead = pages.maResults.slice(0, pages.maResults.indexOf(MA_ROWS_START) + MA_ROWS_START.length);
const maResultsTail = pages.maResults.slice(pages.maResults.indexOf(MA_ROWS_END));

const MA_UNITS = ["HQ/NR", "HQ/SECR", "HQ/ECR", "HQ/NER", "GSD/R/SECR", "ELS/KJGY/NR", "HQ/SCR"];

function ddmmyyyy(d) {
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

/** count MAs, dated today .. (spreadDays-1) days ago (so "today" finds some). */
function generatedMas(count, spreadDays = 4) {
  const out = [];
  const today = new Date();
  for (let i = 1; i <= count; i++) {
    const railway = CRN_RAILWAYS[i % CRN_RAILWAYS.length];
    const maDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (i % spreadDays));
    const poDate = new Date(maDate.getFullYear(), maDate.getMonth() - 2, (i % 27) + 1);
    out.push({
      serial: i,
      unit: MA_UNITS[i % MA_UNITS.length],
      poNo: `${railway.code}2503691${String(i).padStart(5, "0")}`,
      poDate: ddmmyyyy(poDate),
      rly: railway.code,
      maNo: String(7000 + i).padStart(6, "0"),
      crnDate: ddmmyyyy(maDate), // date used by the shared filter (MA Date)
      maLink: i % 9 !== 0
    });
  }
  return out;
}

function renderMaRow(r) {
  return `
									<tr style="line-height: 26px;" class="trPoRow">
										<td class="searchDtlCls">${r.serial}</td>
										<td class="searchDtlCls">${r.unit}</td>
										<td class="searchDtlCls">
											<a href="/mock/po/${r.poNo}.pdf" title="Click to View/Download PO" target="_blank">${r.poNo} </a>
										</td>
										<td> ${r.poDate}</td>
										<td class="searchDtlCls">null</td>
										<td class="searchDtlCls">${r.maNo}</td>
										<td class="searchDtlCls"> ${r.crnDate} </td>
										<td class="dataText">
											${r.maLink ? `<a title="View/Download MA" class="linkStyle" href="/mock/ma/${r.poNo}_${r.maNo}.pdf" target="_blank" >
												<img src="/ireps/images/common/View Negotiattion Details.png" alt="View/Download" height="15" width="15" border="0" class="linkStyle" />
											</a>` : ""}
											<a title="Manage Your Purchase Order" class="linkStyle" href="#" onclick="postRequest('/epsn/dispatchParticulars/showDispatchParticular.do?rly=${r.rly}&poKey=1${r.serial}000&poNo=${r.poNo}')" >
												<img src="/ireps/images/common/icon_view.gif" alt="Manage Your Purchase Order" height="15" width="15" border="0" class="linkStyle" />
											</a>
											<a onclick="viewDocAckDetails('1${r.serial}000');" href="javascript:void(0);">
												<img width="15" height="15" title="View Document Acknowledgement Details" alt="Click here to View Document Acknowledgement Details." src="/ireps/images/common/viewpayment.gif" border="0">
											</a>
										</td>
									</tr>
`;
}

/** MA results page: like the real portal, recordsPerPage decides server-side paging. */
function renderMaResults(form, { token = issueToken(), message = "" } = {}) {
  let head = maResultsHead.replace(FIXTURE_TOKEN_RE, `$1${token}$2`);
  if (message) head = head.replace('<span class="errorStyle"></span>', `<span class="errorStyle">${message}</span>`);
  let tail = maResultsTail;
  let rowsHtml = "";
  if (scenario !== "no-records") {
    const all = filterCrns(generatedMas(scenario === "crn-large" ? 200 : scenario === "crn-paged" ? 47 : 14, scenario === "crn-large" ? 12 : 4), form);
    const total = all.length;
    const per = Math.max(1, Number(form.recordsPerPage) || 20);
    const pageNo = Math.max(1, Number(form.pageNo) || 1);
    const pageCount = Math.max(1, Math.ceil(total / per));
    const slice = all.slice((pageNo - 1) * per, pageNo * per);
    if (pageCount > 1) tail = tail.replace(MA_PAGINATION_SLOT, renderCrnPagination({ ...form, recordsPerPage: per }, pageNo, pageCount, total));
    head = head.replace(/Total \d+ result\(s\)/, `Total ${total} result(s)`);
    rowsHtml = slice.map(renderMaRow).join("");
  }
  return head + rowsHtml + tail;
}

function renderCrnSearchPage({ token = issueToken(), withToken = true } = {}) {
  let page = pages.crnSearch.replace(FIXTURE_TOKEN_RE, `$1${token}$2`);
  if (!withToken) page = page.replace(/<input type="hidden" name="org\.apache\.struts\.taglib\.html\.TOKEN"[^>]*>/, "");
  return page;
}

const CRN_REQUIRED_FIELDS = [
  "org.apache.struts.taglib.html.TOKEN",
  "pageNo",
  "searchCriteria",
  "rly",
  "poNo",
  "icNo",
  "dateFrom",
  "dateTo",
  "searchRange",
  "recordsPerPage",
  "submit"
];

/** Validate exactly what the real searchPOForm posts (captured HAR). */
function validateCrnSearch(form) {
  const missing = CRN_REQUIRED_FIELDS.filter((f) => !form.has(f));
  if (missing.length) return `Missing form field(s): ${missing.join(", ")}`;
  const criteria = form.getAll("searchCriteria");
  if (criteria.length !== 2 || criteria[1] !== "") return `Expected searchCriteria twice (select + empty hidden field), got ${JSON.stringify(criteria)}`;
  if (!["CRN", "RNOTE", "MA"].includes(criteria[0])) return `This mock only serves searchCriteria=CRN, RNOTE or MA (got "${criteria[0]}")`;
  if (form.get("submit") !== "Show Results") return `Unexpected submit value "${form.get("submit")}"`;
  if (!["1", "2", "3"].includes(form.get("searchRange"))) return `Unexpected searchRange "${form.get("searchRange")}"`;
  if (!/^\d+$/.test(form.get("pageNo"))) return `Unexpected pageNo "${form.get("pageNo")}"`;
  if (!/^\d+$/.test(form.get("recordsPerPage"))) return `Unexpected recordsPerPage "${form.get("recordsPerPage")}"`;
  if (form.get("searchRange") === "3" && !form.get("poNo")) return "Please enter PO No!";
  if (form.get("searchRange") === "2") {
    const from = form.get("dateFrom");
    const to = form.get("dateTo");
    if (from.length !== 10) return "Please enter From Date!";
    if (to.length !== 10) return "Please enter To Date!";
    const dFrom = parseDate(from);
    const dTo = parseDate(to);
    if (!dFrom || !dTo) return "Dates must be DD/MM/YYYY";
    if (dFrom > dTo) return "From Date must be earlier than To Date!";
    if (Math.ceil((dTo - dFrom) / 86400000) > 180) return "Selected Date Range should be within 180 days.";
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Tiny PDF generator (valid, single page, selectable text)                   */
/* -------------------------------------------------------------------------- */

function tinyPdf(lines) {
  const esc = (t) => String(t).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  let content = "BT /F1 14 Tf 60 780 Td 18 TL\n";
  for (const line of lines) content += `(${esc(line)}) Tj T*\n`;
  content += "ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

/** The real pages carry this inline; the sanitised fixtures do not, so the mock adds it for the IREPS look (DocLink never reads styles). */
const HEADER_STYLE = "<style>.gradientClass{background:#0073B0;background:linear-gradient(to right,#0b3d91 0%,#0073B0 60%,#1e88c7 100%);}</style>";

function html(res, status, body, headers = {}) {
  if (typeof body === "string" && body.includes('class="gradientClass"') && !body.includes(".gradientClass{")) body = body.replace(/<head>/i, `<head>${HEADER_STYLE}`);
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
  });
}

const SCENARIOS = ["auto", "bills", "large", "login", "redirect-login", "expired", "no-records", "token-missing", "token-invalid", "http500", "slow", "legacy"];
const CRN_SCENARIOS = ["crn-paged", "crn-large", "ma-pdf-login", "ma-pdf-404"];
const MOCK_USER = "MOCK USER, SAMPLE RAIL COMPONENTS PRIVATE LIMITED-UNIT 1 (IREPS ID-&nbsp;833)";

/** The scenario notice shown on every mock page while a test scenario other than "auto" is active. */
function scenarioNotice() {
  if (scenario === "auto") return "";
  return `<div class="mockNotice warn">&#9888; Test scenario <b>${scenario}</b> is active: IREPS pages are answering abnormally on purpose (DocLink error testing). <a href="/mock/scenario/auto">Switch back to normal (auto)</a></div>`;
}

/** Left-menu block in the style of the captured Bidder Home Page. */
function menuSection(title, links) {
  const rows = links.map(([href, text]) => `<tr><td width="10px;"><li style="list-style-type:square;"></li></td><td><a href="${href}" title="${text}" class="linkStyle">${text}</a></td></tr>`).join("");
  return `<tr><td width="212" height="26" valign="top"><table width="100%" border="0" cellpadding="0" cellspacing="5" class="bg_white"><tr><td width="356" valign="top" class="fontSet1" height="26">${title}</td></tr></table></td></tr>
<tr><td valign="top" class="boxStyle1"><table width="100%" class="nit_summary1" cellspacing="0" cellpadding="0">${rows}</table></td></tr>
<tr><td width="212" height="26" valign="top">&nbsp;</td></tr>`;
}

/** Bidder Home Page (logged in) or the login page (logged out), IREPS look. */
function homePage(loggedIn) {
  if (!loggedIn) return pages.login.replace('<div class="mockLoginBox">', `${scenarioNotice()}<div class="mockLoginBox">`);
  const main = `
<table width="100%" border="0" cellpadding="0" cellspacing="0"><tr>
  <td width="230" valign="top">
    <table width="100%" border="0" cellpadding="0" cellspacing="0">
      ${menuSection("Documents", [["/epsn/works/docrepository.do?activity=display", "Upload/View My Documents"], ["/epsn/works/irepsDocuments.do?activity=display", "View IREPS Documents"]])}
      ${menuSection("Pending Bills", [["/epsn/admin/vendorPartyCode.do", "Map Accounts Deptt Party Code"], ["/epsn/admin/viewBills.do", "View Bills Status"]])}
      ${menuSection("Contracts", [["/epsn/searchPO.do?searchParam=showPage", "View &amp; Manage Contracts"]])}
    </table>
  </td>
  <td valign="top" style="padding-left:20px;">
    <div class="mockNotice ok">&#10003; Logged in &mdash; the browser now holds the portal's <code>JSESSIONID</code> session cookie (mock value). DocLink shows <b>IREPS &#9679; Connected</b>.</div>
    <fieldset class="fieldsetStyle"><legend class="legendStyle">DocLink workflows start here</legend>
      <table cellpadding="4">
        <tr><td class="formLabel">Bill Status</td><td><a class="linkStyle" href="/epsn/admin/viewBills.do">View Bills Status</a> &rarr; <code>POST /epsn/admin/viewBills.do</code></td></tr>
        <tr><td class="formLabel">CRN / R-NOTE / MA</td><td><a class="linkStyle" href="/epsn/searchPO.do?searchParam=showPage">View &amp; Manage Contracts (PO Search)</a> &rarr; <code>POST /epsn/searchPO.do</code></td></tr>
      </table>
    </fieldset>
  </td>
</tr></table>`;
  return pages.home
    .replace("<!--MOCK:WELCOME-->", MOCK_USER)
    .replace("<!--MOCK:TOPLINK-->", '<a href="/epsn/home/logout.do" style="color:white;font-weight:bold" title="Logout">Logout</a>')
    .replace("<!--MOCK:NOTICE-->", scenarioNotice())
    .replace("<!--MOCK:MAIN-->", main);
}

/** Mock-only control panel: scenarios and session tools (kept off the portal-look pages so they are not clicked by accident). */
function controlPanel(loggedIn) {
  const links = (list) => list.map((x) => `<a href="/mock/scenario/${x}"${x === scenario ? ' style="font-weight:bold;background:#fff4dc"' : ""}>${x}</a>`).join(" &middot; ");
  return `<!DOCTYPE html><html><head><title>Mock IREPS - control panel</title>
  <style>body{font-family:sans-serif;max-width:720px;margin:40px auto;color:#1c2430}a{color:#124a8c}code{background:#eef2f7;padding:2px 5px;border-radius:4px}.warn{background:#fff4dc;border:1px solid #9a6200;padding:8px 12px;border-radius:6px}</style></head>
  <body>
  <h1>Mock IREPS &mdash; control panel</h1>
  <p><a href="/epsn/home/showHome.do">&larr; Back to the mock portal</a></p>
  <p>Session: <strong>${loggedIn ? "logged in" : "logged out"}</strong> &middot; live sessions: ${liveSessions.size} &middot; scenario: <code>${scenario}</code></p>
  ${scenario === "auto" ? "" : '<p class="warn">A test scenario is active: portal pages answer abnormally on purpose. <a href="/mock/scenario/auto">back to auto</a></p>'}
  <h3>Session tools</h3>
  <p>${loggedIn ? '<a href="/epsn/home/logout.do">Logout</a> &middot; <a href="/mock/session/expire">Expire session server-side (browser keeps the cookie)</a>' : '<form method="post" action="/login" style="display:inline"><button type="submit">Login with security key (simulated)</button></form>'}</p>
  <h3>Bill Status scenarios (for DocLink error testing)</h3>
  <p>${links(SCENARIOS)}</p>
  <h3>CRN / MA scenarios</h3>
  <p>${links(CRN_SCENARIOS)} &middot; <a href="/mock/scenario/auto">back to auto</a></p>
  <p><a href="/mock/status">/mock/status</a> (JSON)</p>
  </body></html>`;
}

const STATIC_TYPES = { ".css": "text/css", ".js": "application/javascript", ".gif": "image/gif", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon" };

/** Serve a real IREPS static file (test/mock/static) at its portal path; false when not one of ours. */
function serveStatic(path, res) {
  if (!path.startsWith("/ireps/")) return false;
  const rel = decodeURIComponent(path).replace(/\.\.+/g, "");
  const file = join(staticRoot, rel);
  const ext = rel.slice(rel.lastIndexOf("."));
  if (!file.startsWith(staticRoot) || !STATIC_TYPES[ext] || !existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { "Content-Type": STATIC_TYPES[ext], "Cache-Control": "max-age=3600" });
  res.end(readFileSync(file));
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === "/" || path === "/epsn/home/showHome.do") return html(res, 200, homePage(hasSession(req)));
  if (path === "/mock" || path === "/mock/") return html(res, 200, controlPanel(hasSession(req)));
  if (serveStatic(path, res)) return;

  if (path === "/login" && req.method === "POST") {
    const id = issueSession();
    console.log(`[mock-ireps] login -> JSESSIONID issued (live sessions: ${liveSessions.size})`);
    return html(res, 302, "", { "Set-Cookie": sessionCookies(id), Location: "/epsn/home/showHome.do" });
  }
  if (path === "/logout" || path === "/epsn/home/logout.do") {
    liveSessions.delete(parseCookies(req).get(SESSION_COOKIE));
    console.log(`[mock-ireps] logout (live sessions: ${liveSessions.size})`);
    return html(res, 302, "", { "Set-Cookie": clearedSessionCookies(), Location: "/epsn/home/showHome.do" });
  }
  if (path === "/mock/session/expire") {
    liveSessions.clear();
    console.log("[mock-ireps] all sessions expired server-side (browser cookies untouched)");
    return html(res, 302, "", { Location: "/epsn/home/showHome.do" });
  }
  if (path === "/epsn/login.do") return html(res, 200, homePage(false));

  if (path.startsWith("/mock/scenario/")) {
    scenario = path.split("/").pop();
    console.log(`[mock-ireps] scenario -> ${scenario}`);
    return html(res, 302, "", { Location: "/mock/" });
  }
  if (path === "/mock/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ scenario, issuedTokens: issuedTokens.length, liveSessions: liveSessions.size, sessionCookie: SESSION_COOKIE }));
  }

  if (path === "/epsn/admin/viewBills.do") {
    const body = req.method === "POST" ? await readBody(req) : "";
    const form = body ? new URLSearchParams(body) : null;
    const kind = form ? "search" : "page";
    console.log(
      `[mock-ireps] ${req.method} viewBills.do ${kind}  scenario=${scenario} cookie=${hasSession(req) ? "yes" : "no"}` +
        (form ? `  zone=${form.get("zone")} searchRange=${form.get("searchRange")} dateFrom=${form.get("dateFrom")} dateTo=${form.get("dateTo")}` : "")
    );

    switch (scenario) {
      case "login":
        return html(res, 200, pages.login);
      case "redirect-login":
        return html(res, 302, "", { Location: "/epsn/login.do" });
      case "expired":
        return html(res, 200, pages.expired);
      case "http500":
        return html(res, 500, "<html><body><h1>HTTP Status 500 - Internal Server Error</h1></body></html>");
      case "legacy":
        return html(res, 200, pages.legacy);
      case "auto":
        if (!hasSession(req)) return html(res, 200, pages.login);
        break;
      default:
        break;
    }

    if (kind === "page") {
      const page = renderBillPage({ blocksHtml: blocksFor(null), withToken: scenario !== "token-missing" });
      if (scenario === "slow") return setTimeout(() => html(res, 200, page), 6000);
      return html(res, 200, page);
    }

    // Search request: validate exactly what the real form posts.
    const error = validateSearch(form);
    if (error) {
      console.log(`[mock-ireps] search rejected: ${error}`);
      return html(res, 200, renderBillPage({ blocksHtml: "", message: error }));
    }
    const token = form.get("org.apache.struts.taglib.html.TOKEN");
    if (scenario === "token-invalid" || !consumeToken(token)) {
      console.log("[mock-ireps] search rejected: invalid or reused token");
      return html(
        res,
        200,
        "<html><head><title>Error</title></head><body><h2>Invalid Token</h2><p>The form was already submitted or the page was reloaded. Please try again.</p></body></html>"
      );
    }
    const params = { zone: form.get("zone"), searchRange: form.get("searchRange"), dateFrom: form.get("dateFrom"), dateTo: form.get("dateTo") };
    const page = renderBillPage({ blocksHtml: blocksFor(params) });
    if (scenario === "slow") return setTimeout(() => html(res, 200, page), 6000);
    return html(res, 200, page);
  }

  /* ------------------------------------------------------------- CRN */

  if (path === "/epsn/searchPO.do") {
    const body = req.method === "POST" ? await readBody(req) : "";
    const form = new URLSearchParams(body);
    const kind = req.method !== "POST" || form.get("searchParam") === "showPage" || body === "" ? "page" : form.has("count") ? "pagelink" : "search";
    console.log(
      `[mock-ireps] ${req.method} searchPO.do ${kind}  scenario=${scenario} cookie=${hasSession(req) ? "yes" : "no"}` +
        (kind !== "page" ? `  criteria=${form.getAll("searchCriteria").join("|")} rly=${form.get("rly")} searchRange=${form.get("searchRange")} pageNo=${form.get("pageNo")} recordsPerPage=${form.get("recordsPerPage")} poNo=${form.get("poNo")} dateFrom=${form.get("dateFrom")} dateTo=${form.get("dateTo")}` : "")
    );

    switch (scenario) {
      case "login":
        return html(res, 200, pages.login);
      case "redirect-login":
        return html(res, 302, "", { Location: "/epsn/login.do" });
      case "expired":
        return html(res, 200, pages.expired);
      case "http500":
        return html(res, 500, "<html><body><h1>HTTP Status 500 - Internal Server Error</h1></body></html>");
      case "auto":
      case "crn-paged":
      case "crn-large":
      case "ma-pdf-login":
      case "ma-pdf-404":
        if (!hasSession(req)) return html(res, 200, pages.login);
        break;
      default:
        break;
    }

    if (kind === "page") {
      const page = renderCrnSearchPage({ withToken: scenario !== "token-missing" });
      if (scenario === "slow") return setTimeout(() => html(res, 200, page), 6000);
      return html(res, 200, page);
    }

    if (kind === "pagelink") {
      // The portal's own page links post without a token (postRequest.js).
      const params = {
        rly: form.get("rly") || "-1",
        searchRange: form.get("searchRange") || "1",
        poNo: form.get("poNo") || "",
        dateFrom: form.get("dateFrom") || "",
        dateTo: form.get("dateTo") || "",
        pageNo: form.get("pageNo") || "1",
        recordsPerPage: form.get("recordsPerPage") || "20"
      };
      return html(res, 200, lastSearchCriteria === "RNOTE" ? renderRnoteResults(params) : lastSearchCriteria === "MA" ? renderMaResults(params) : renderCrnResults(params));
    }

    const error = validateCrnSearch(form);
    if (error) {
      console.log(`[mock-ireps] CRN search rejected: ${error}`);
      return html(res, 200, renderCrnSearchPage().replace('<span class="errorStyle"></span>', `<span class="errorStyle">${error}</span>`));
    }
    const token = form.get("org.apache.struts.taglib.html.TOKEN");
    if (scenario === "token-invalid" || !consumeToken(token)) {
      console.log("[mock-ireps] CRN search rejected: invalid or reused token");
      return html(
        res,
        200,
        "<html><head><title>Error</title></head><body><h2>Invalid Token</h2><p>The form was already submitted or the page was reloaded. Please try again.</p></body></html>"
      );
    }
    const params = {
      rly: form.get("rly"),
      searchRange: form.get("searchRange"),
      poNo: form.get("poNo"),
      dateFrom: form.get("dateFrom"),
      dateTo: form.get("dateTo"),
      pageNo: form.get("pageNo"),
      recordsPerPage: form.get("recordsPerPage")
    };
    lastSearchCriteria = form.get("searchCriteria");
    const page = lastSearchCriteria === "RNOTE" ? renderRnoteResults(params) : lastSearchCriteria === "MA" ? renderMaResults(params) : renderCrnResults(params);
    if (scenario === "slow") return setTimeout(() => html(res, 200, page), 6000);
    return html(res, 200, page);
  }

  if (/^\/(ireps\/etender\/ct\/(MMIS\/CONS|MMIS\/CRC\/WAR|MOCK\/RNOTE|sbill)|ireps\/etender\/pdfdocs\/MMIS\/PO|mock\/ma|mock\/po)\/.+\.pdf$/.test(path)) {
    const file = decodeURIComponent(path.split("/").pop());
    const flavour = path.includes("/MMIS/CONS/") ? "CRN" : path.includes("/MMIS/CRC/") ? "WARRANTY CLAIM" : path.includes("/MOCK/RNOTE/") ? "RECEIPT NOTE (MOCK)" : path.includes("/mock/ma/") || /_\d+\.pdf$/.test(path) && path.includes("/pdfdocs/") ? "MODIFICATION ADVICE" : path.includes("/mock/po/") || path.includes("/pdfdocs/") ? "PURCHASE ORDER" : "SUPPLIER BILL";
    if (scenario === "ma-pdf-login") return html(res, 200, pages.login);
    if (scenario === "ma-pdf-404") return html(res, 404, "<html><body><h1>HTTP Status 404 - Not Found</h1></body></html>");
    console.log(`[mock-ireps] GET pdf ${flavour} ${file}  scenario=${scenario} cookie=${hasSession(req) ? "yes" : "no"}`);
    if (!hasSession(req)) return html(res, 200, pages.login);
    const pdf = tinyPdf([`INDIAN RAILWAYS E-PROCUREMENT SYSTEM (MOCK)`, `${flavour}`, `Document: ${file.replace(/\.pdf$/i, "")}`, `Generated by the DocLink mock server for testing.`]);
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": pdf.length, "Content-Disposition": `inline; filename="${file}"`, "Cache-Control": "no-store" });
    if (scenario === "slow") return setTimeout(() => res.end(pdf), 2000);
    return res.end(pdf);
  }

  html(res, 404, "<html><body>Not found</body></html>");
});

server.listen(PORT, () => {
  console.log(`[mock-ireps] listening on http://localhost:${PORT}  (scenario: ${scenario})`);
  console.log(`[mock-ireps] point DocLink at it with:  node test/mock/switch-target.mjs mock`);
});
