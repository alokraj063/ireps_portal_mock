/**
 * Browser-side tests for the IREPS form extractor, request builder, bill
 * parser, session detection, Bill Status flow (with a fake fetch), sanitiser
 * and PDF generator. No extension APIs are used, so this runs in a plain tab.
 */

import { parseBillStatus, parseBillBlock, matchFieldKey, normalizeIrepsValue, validateBillStatusRecords, BILL_FIELDS } from "../services/bill-parser.js";
import { validateIrepsSession, isIrepsLoginPage, isIrepsBillStatusPage, isNoRecordsPage, hasBillStatusForm } from "../services/session-service.js";
import { extractBillStatusForm, extractStrutsToken, extractRailwayZones, extractSearchRanges, parseTagAttributes, publicFormInfo } from "../services/ireps-form.js";
import {
  buildBillStatusRequest,
  validateDateRange,
  describeBillStatusRequest,
  describeBillStatusFilter,
  requestIreps,
  loadBillStatusPage,
  BILL_SEARCH_RANGE,
  BILL_SEARCH_MODE,
  BILL_STATUS_FORM_FIELDS,
  IREPS_ERROR,
  IrepsError
} from "../services/ireps-api.js";
import { fetchBillStatus } from "../services/bill-status-service.js";
import { generateBillStatusPdf, __internals as pdfInternals } from "../services/pdf-service.js";
import { sanitiseFragment, escapeHtml } from "../utils/sanitizer.js";
import { buildBillStatusFilename } from "../utils/filename.js";
import { redact } from "../utils/logger.js";
import { describeError } from "../utils/messages.js";
import { runCrnTests } from "./crn-tests.js";
import { runRnoteTests } from "./rnote-tests.js";
import { runMaTests } from "./ma-tests.js";

const results = [];
const list = document.getElementById("results");

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push({ name, ok: true }))
    .catch((error) => results.push({ name, ok: false, error: error && error.stack ? error.stack : String(error) }));
}

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || "values differ"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function rejects(promise, code, message) {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof IrepsError, `${message || "expected IrepsError"}: got ${error && error.stack}`);
    eq(error.code, code, message || "error code");
    return error;
  }
  throw new Error(`${message || "expected rejection"}: promise resolved`);
}

async function fixture(name) {
  const res = await fetch(new URL(`./fixtures/${name}`, import.meta.url));
  return res.text();
}

const FAKE_TOKEN = "FAKE-TOKEN-0123456789abcdef0123456789abcdef";

function bigFixture(count) {
  const rows = [];
  for (let i = 1; i <= count; i++) {
    rows.push(`<tr><td>${i}</td><td>NR/STORES/2026/${String(i).padStart(4, "0")}</td><td>01/01/2026</td><td>INV-${i}</td><td>02/02/2026</td>
      <td>NR</td><td>PARTY ${i}</td><td>V-${i}</td><td>CO6/${i}</td><td>03/03/2026</td><td>${i % 3 === 0 ? "Returned" : "Passed"}</td>
      <td>${i},000.00</td><td>${i},000.00</td><td>0.00</td><td>${i},000.00</td><td>CO7/${i}</td><td>04/04/2026</td><td>05/05/2026</td>
      <td>FA&amp;CAO/NR</td><td>${i % 5 === 0 ? "Recovery line ".repeat(40) : ""}</td><td>${i % 7 === 0 ? "Reason ".repeat(60) : ""}</td></tr>`);
  }
  return `<html><body><h3>Bill Status</h3><table>
    <tr><th>S.No</th><th>Contract No</th><th>Contract Date</th><th>Bill No</th><th>Bill Date</th><th>Zone</th><th>Party Name</th><th>Party Code</th>
    <th>CO6 No</th><th>CO6 Date</th><th>Status</th><th>Bill Amt</th><th>Passed Amt</th><th>Deducted Amt</th><th>Net Amt</th><th>CO7 No</th><th>CO7 Date</th>
    <th>Payment Advice Date</th><th>Accounting Unit</th><th>Recovery Details</th><th>Reason For Return</th></tr>${rows.join("")}</table></body></html>`;
}

/**
 * Fake IREPS: answers the empty POST with `page` (a fresh token per call)
 * and the search POST via `onSearch(body, tokenIssued)`.
 */
function fakeIreps({ page, onSearch }) {
  const calls = [];
  let issued = 0;
  const respond = (html, init = {}) => new Response(html, { status: init.status ?? 200, headers: { "content-type": "text/html; charset=utf-8" } });
  const fetchImpl = async (url, init) => {
    const body = init.body ?? null;
    calls.push({ url: String(url), method: init.method, body, credentials: init.credentials, headers: init.headers });
    if (init.method === "POST" && body === "") {
      issued++;
      return respond(page.replace(FAKE_TOKEN, `TOKEN-${issued}`));
    }
    return onSearch(body, `TOKEN-${issued}`, respond, calls.length);
  };
  return { fetchImpl, calls };
}

const parseHtml = (html, options) => parseBillStatus(html, options);

/* ------------------------------------------------------------- parser (legacy) */

await test("label matching handles punctuation, units and synonyms", () => {
  eq(matchFieldKey("Contract No."), "contractNo");
  eq(matchFieldKey("Contract No "), "contractNo");
  eq(matchFieldKey("Bill Amt (Rs.)"), "billAmount");
  eq(matchFieldKey("Bill Number "), "billNumber");
  eq(matchFieldKey("PartyCode"), "partyCode");
  eq(matchFieldKey("Payment Advice Date to Bank"), "paymentAdviceDate");
  eq(matchFieldKey("Accounting Unit(Division)"), "accountingUnit");
  eq(matchFieldKey("CO6 No"), "co6No");
  eq(matchFieldKey("CO7 Date"), "co7Date");
  eq(matchFieldKey("Reason For Return"), "reasonForReturn");
  eq(matchFieldKey("Recovery Details"), "recoveryDetails");
  eq(matchFieldKey("S.No"), null);
  eq(matchFieldKey("View"), null);
});

await test("normalizeIrepsValue: placeholders become null, values stay verbatim", () => {
  eq(normalizeIrepsValue("----"), null);
  eq(normalizeIrepsValue("-"), null);
  eq(normalizeIrepsValue(" NA "), null);
  eq(normalizeIrepsValue("na"), null);
  eq(normalizeIrepsValue("N/A"), null);
  eq(normalizeIrepsValue(""), null);
  eq(normalizeIrepsValue(null), null);
  eq(normalizeIrepsValue(" 2968191.9 "), "2968191.9");
  eq(normalizeIrepsValue("PAYMENT MADE"), "PAYMENT MADE");
  eq(normalizeIrepsValue("NAGPUR DIVISION"), "NAGPUR DIVISION");
});

await test("legacy single-table layout still parses (two-row header, colspan, rowspan)", async () => {
  const html = await fixture("bill-status-sample.html");
  const result = parseBillStatus(html, { now: new Date(2026, 8, 15, 12, 30, 42) });
  eq(result.recordCount, 3, "record count");
  eq(result.structure, "table");
  eq(result.blockCount, 0);
  eq(result.filter, "Northern Railway, Last 90 Days");
  const [b1, b2, b3] = result.bills;
  eq(b1.contractNo, "NR/STORES/2026/0451");
  eq(b1.billNumber, "INV-2026-118");
  eq(b1.partyName, "JOULES TO WATTS BUSINESS SOLUTIONS PVT LTD");
  eq(b1.status, "Passed & Paid");
  eq(b1.paymentAdviceDate, "14/07/2026");
  assert(b1.recoveryDetails.includes("LD @ 0.5%") && b1.recoveryDetails.includes("\n"), "recovery details keep line breaks");
  eq(b1.reasonForReturn, null, "empty cell -> null");
  eq(b2.status, "Returned");
  eq(b2.co7No, null);
  assert(b2.reasonForReturn.startsWith("Inspection certificate not attached"), "long reason preserved");
  eq(b3.billAmount, "₹ 78,500.00", "rupee symbol preserved verbatim");
  eq(b3.passedAmount, null, "nbsp cell -> null");
  assert(!result.printableHtml.includes("<script"), "no script in printable html");
  assert(result.printableHtml.includes("&amp;"), "values are escaped");
});

await test("handles a very large legacy table without losing rows", () => {
  const result = parseBillStatus(bigFixture(600));
  eq(result.recordCount, 600);
  eq(result.bills[599].billNumber, "INV-600");
});

await test("key/value layout fallback", () => {
  const html = `<html><body><h2>Bill Status</h2><table>
    <tr><td>Contract No :</td><td>NR/1</td><td>Bill No :</td><td>B-1</td></tr>
    <tr><td>Bill Date</td><td>01/02/2026</td><td>Status</td><td>Passed</td></tr>
    <tr><td>Net Amt</td><td>500.00</td><td>CO6 No</td><td>C6-1</td></tr>
  </table></body></html>`;
  const result = parseBillStatus(html);
  eq(result.recordCount, 1);
  eq(result.structure, "keyValue");
  eq(result.bills[0].contractNo, "NR/1");
  eq(result.bills[0].co6No, "C6-1");
});

await test("unknown columns are kept as extras (legacy layout)", () => {
  const html = `<table><tr><th>Contract No</th><th>Bill No</th><th>Status</th><th>Net Amt</th><th>Cheque No</th></tr>
    <tr><td>C1</td><td>B1</td><td>Paid</td><td>10</td><td>CHQ-77</td></tr></table>`;
  const result = parseBillStatus(html);
  eq(result.recordCount, 1);
  eq(result.bills[0].extra["Cheque No"], "CHQ-77");
});

/* ------------------------------------------------------ parser (real layout) */

await test("real layout: every table#table_id block becomes one record, no de-duplication", async () => {
  const html = await fixture("bill-status-page.html");
  const result = parseBillStatus(html, { now: new Date(2026, 8, 18, 10, 0, 0), filter: "Last 90 Days, All Zones" });
  eq(result.structure, "blocks");
  eq(result.blockCount, 6, "blocks found");
  eq(result.recordCount, 6, "records (bill 3 and bill 6 share a Bill Number and are both kept)");
  eq(result.skippedCount, 0);
  eq(result.filter, "Last 90 Days, All Zones");
  const numbers = result.bills.map((b) => b.billNumber);
  eq(numbers.filter((n) => n === "9001000103").length, 2, "lifecycle duplicate preserved");
  for (const bill of result.bills) for (const f of BILL_FIELDS) assert(f.key in bill, `missing key ${f.key}`);
  assert(!result.printableHtml.includes("<script"), "no script in printable html");
  assert(!result.printableHtml.includes("FAKE-TOKEN"), "token never reaches the printable html");
});

await test("real layout: REGISTERED bill with ---- and NA placeholders", async () => {
  const html = await fixture("bill-status-page.html");
  const b = parseBillStatus(html).bills[0];
  eq(b.contractNo, "13240000000101");
  eq(b.contractDate, "03/08/2024");
  eq(b.billNumber, "9001000101");
  eq(b.billDate, "16/09/2026", "leading whitespace trimmed");
  eq(b.zone, "ICF");
  eq(b.partyName, "SAMPLE RAIL COMPONENTS PRIVATE LIMITED-UNIT 1", "colspan party name");
  eq(b.partyCode, "MM00:001");
  eq(b.co6No, "13010326020001");
  eq(b.co6Date, "18/09/2026");
  eq(b.status, "REGISTERED");
  eq(b.billAmount, "118000");
  eq(b.passedAmount, "118000");
  eq(b.deductedAmount, "0");
  eq(b.netAmount, "118000");
  eq(b.co7No, null, "---- -> null");
  eq(b.co7Date, null, "---- -> null");
  eq(b.paymentAdviceDate, null, "NA -> null");
  eq(b.accountingUnit, "ICF HEADQUARTER");
  eq(b.reasonForReturn, null);
  eq(b.recoveryDetails, null);
  eq(Object.keys(b.extra).length, 0, "no extras");
});

await test("real layout: RETURNED bill with Reason For Return and '-' bill number", async () => {
  const html = await fixture("bill-status-page.html");
  const b = parseBillStatus(html).bills[1];
  eq(b.status, "RETURNED");
  eq(b.billNumber, null, "'-' -> null");
  eq(b.contractNo, "3702WC25000099");
  eq(b.zone, "SCoR");
  eq(b.netAmount, "2968191.9", "decimal amount verbatim");
  eq(b.co7No, null);
  eq(b.paymentAdviceDate, null);
  eq(b.accountingUnit, "VISHAKHAPATNAM DIVISION");
  eq(b.reasonForReturn, "#VARY IN SCHEDULE B- COST OF MATERIAL PLEASE CHECK");
  eq(b.recoveryDetails, null);
});

await test("real layout: PAYMENT MADE bill with Recovery Details (complete multi-line text)", async () => {
  const html = await fixture("bill-status-page.html");
  const b = parseBillStatus(html).bills[2];
  eq(b.status, "PAYMENT MADE");
  eq(b.billNumber, "9001000103");
  eq(b.co7No, "37020126700003");
  eq(b.co7Date, "11/09/2026");
  eq(b.paymentAdviceDate, "11/09/2026");
  eq(b.deductedAmount, "114210.1");
  eq(b.recoveryDetails, "GST TDS DEDUCTION: 52244.1\nINCOME TAX - CONTR (Company): 61648\nOTHER CHARGES: 318");
  eq(b.reasonForReturn, null);
});

await test("real layout: PASSED bill and PAYMENT MADE bill without recovery section", async () => {
  const html = await fixture("bill-status-page.html");
  const { bills } = parseBillStatus(html);
  eq(bills[3].status, "PASSED");
  eq(bills[3].co7No, "01010326700404");
  eq(bills[3].paymentAdviceDate, null, "NA -> null");
  eq(bills[3].zone, "CR");
  eq(bills[4].status, "PAYMENT MADE");
  eq(bills[4].recoveryDetails, null, "optional section absent -> null");
  eq(bills[4].paymentAdviceDate, "04/07/2026");
  eq(bills[5].status, "REGISTERED");
  eq(bills[5].billNumber, "9001000103");
});

await test("parseBillBlock is label driven: sections in any order, nested tables, label/value pairs", () => {
  const doc = new DOMParser().parseFromString(
    `<table id="table_id">
      <tr><th colspan="2">Recovery Details</th></tr>
      <tr><td colspan="2"><table><tr><td>GST TDS</td><td>10</td></tr><tr><td>TDS</td><td>20</td></tr></table></td></tr>
      <tr><th>Status</th><th>Bill Amt</th><th>CO7 No</th></tr>
      <tr><td>PAYMENT MADE</td><td>1,000</td><td>NA</td></tr>
      <tr><td>Contract No</td><td>: C-1</td><td>Bill Number</td><td>B-1</td></tr>
      <tr><td>Reason For Return: sent back for correction</td></tr>
      <tr><td colspan="3">Showing 1 record</td></tr>
    </table>`,
    "text/html"
  );
  const { bill, warnings } = parseBillBlock(doc.querySelector("table#table_id"), 1);
  eq(bill.recoveryDetails, "GST TDS: 10\nTDS: 20", "nested table -> lines");
  eq(bill.status, "PAYMENT MADE");
  eq(bill.billAmount, "1,000");
  eq(bill.co7No, null);
  eq(bill.contractNo, "C-1");
  eq(bill.billNumber, "B-1");
  eq(bill.reasonForReturn, "sent back for correction");
  eq(warnings.length, 0, `warnings: ${warnings.join(" | ")}`);
});

await test("validation: incomplete block is skipped with a warning, others kept", () => {
  const good = { billNumber: "B-1", contractNo: "C-1", status: "REGISTERED" };
  const noBillNo = { billNumber: null, contractNo: "C-2", status: "RETURNED" };
  const noStatus = { billNumber: "B-3", contractNo: "C-3", status: null };
  const empty = { billNumber: null, contractNo: null, status: null };
  const v = validateBillStatusRecords([good, noBillNo, noStatus, empty]);
  eq(v.validRecords.length, 3);
  eq(v.skippedRecords.length, 1);
  assert(v.warnings.includes("Bill record 2 is missing Bill Number."), v.warnings.join(" | "));
  assert(v.warnings.includes("Bill record 3 is missing Status."), v.warnings.join(" | "));
  assert(v.warnings.some((w) => w.startsWith("Bill record 4 is missing both")), v.warnings.join(" | "));

  const html = `<html><body><form name="vendorPartyCodeForm" action="/epsn/admin/viewBills.do"></form>
    <table id="table_id"><tr><th>Contract No</th><th>Bill Number</th></tr><tr><td>----</td><td>----</td></tr></table>
    <table id="table_id"><tr><th>Contract No</th><th>Bill Number</th></tr><tr><td>C-9</td><td>B-9</td></tr></table></body></html>`;
  const result = parseBillStatus(html);
  eq(result.blockCount, 2);
  eq(result.recordCount, 1);
  eq(result.skippedCount, 1);
  eq(result.bills[0].billNumber, "B-9");
});

/* ------------------------------------------------------------ form extraction */

for (const [label, options] of [
  ["DOM path", {}],
  ["regex path (service worker)", { DOMParser: null }]
]) {
  await test(`form extraction (${label}): token, zones, searchRange controls`, async () => {
    const html = await fixture("bill-status-page.html");
    const form = extractBillStatusForm(html, options);
    eq(form.present, true);
    eq(form.action, "/epsn/admin/viewBills.do");
    eq(form.token, FAKE_TOKEN);
    eq(extractStrutsToken(html, options), FAKE_TOKEN);

    const zones = extractRailwayZones(html, options);
    eq(zones.length, 35, "zone count");
    eq(zones[0].value, "-1");
    eq(zones[0].label, "All");
    eq(zones.find((z) => z.value === "01").label, "CR");
    eq(zones.find((z) => z.value === "13").label, "ICF");
    eq(zones.find((z) => z.value === "37").label, "SCoR");

    const ranges = extractSearchRanges(html, options);
    eq(ranges.map((r) => r.value).join(","), "3,2,1");
    eq(ranges.map((r) => r.label).join("|"), "Railway Zone|Select Date|Last 90 Days");
    eq(form.defaultSearchRange, "1", "Last 90 Days is the default");
    eq(ranges.find((r) => r.value === "1").checked, true);
    eq(ranges.find((r) => r.value === "2").checked, false);

    const pub = publicFormInfo(form);
    assert(!("token" in pub), "public form info has no token");
    assert(!JSON.stringify(pub).includes(FAKE_TOKEN), "token not serialised");
  });

  await test(`form extraction (${label}): missing token -> null, login page -> not present`, async () => {
    const html = (await fixture("bill-status-page.html")).replace(/<input type="hidden" name="org\.apache\.struts\.taglib\.html\.TOKEN"[^>]*>/, "");
    const form = extractBillStatusForm(html, options);
    eq(form.present, true);
    eq(form.token, null);
    eq(form.zones.length, 35, "zones still extracted");
    const login = extractBillStatusForm(await fixture("login-page.html"), options);
    eq(login.present, false);
    eq(login.token, null);
    eq(login.zones.length, 0);
  });
}

await test("tag attribute parser tolerates quotes, no-value attributes and entities", () => {
  const a = parseTagAttributes(`<input type=hidden name='x' value="a&amp;b" checked disabled/>`);
  eq(a.type, "hidden");
  eq(a.name, "x");
  eq(a.value, "a&b");
  assert("checked" in a && "disabled" in a);
});

/* ------------------------------------------------------------ request building */

await test("request building: Last 90 Days + All Zones (default)", () => {
  const req = buildBillStatusRequest({}, "TOK-1");
  eq(req.mode, "last90Days");
  eq(req.searchRange, BILL_SEARCH_RANGE.LAST_90_DAYS);
  eq(req.body, "org.apache.struts.taglib.html.TOKEN=TOK-1&zone=-1&searchRange=1&dateFrom=&dateTo=&submit=Show+Results&searchParam=");
  const params = new URLSearchParams(req.body);
  eq(params.get(BILL_STATUS_FORM_FIELDS.TOKEN), "TOK-1");
  eq(params.get("zone"), "-1");
  eq(params.get("searchRange"), "1");
  eq(params.get("dateFrom"), "");
  eq(params.get("dateTo"), "");
  eq(params.get("submit"), "Show Results");
  eq(params.get("searchParam"), "");
  eq(Array.from(params.keys()).length, 7, "exactly the seven form fields");

  const same = buildBillStatusRequest({ mode: BILL_SEARCH_MODE.LAST_90_DAYS, zone: "-1" }, "TOK-1");
  eq(same.body, req.body);
});

await test("request building: date range and railway zone modes", () => {
  const dr = buildBillStatusRequest({ mode: "dateRange", dateFrom: "01/08/2026", dateTo: "31/08/2026" }, "TOK-2");
  const p = new URLSearchParams(dr.body);
  eq(p.get("searchRange"), "2");
  eq(p.get("dateFrom"), "01/08/2026");
  eq(p.get("dateTo"), "31/08/2026");
  eq(p.get("zone"), "-1");
  eq(p.get("submit"), "Show Results");

  const rz = buildBillStatusRequest({ mode: "railwayZone", zone: "13" }, "TOK-3");
  const q = new URLSearchParams(rz.body);
  eq(q.get("searchRange"), "3");
  eq(q.get("zone"), "13");
  eq(q.get("dateFrom"), "");

  const described = describeBillStatusRequest(dr);
  eq(JSON.stringify(described), JSON.stringify({ mode: "dateRange", zone: "-1", dateFrom: "01/08/2026", dateTo: "31/08/2026" }));
  assert(!JSON.stringify(described).includes("TOK-2"), "description never contains the token");
  eq(describeBillStatusFilter({}), "Last 90 Days, All Zones");
  eq(describeBillStatusFilter({ mode: "railwayZone", zone: "13" }, [{ value: "13", label: "ICF" }]), "Railway Zone: ICF");
  eq(describeBillStatusFilter({ mode: "dateRange", dateFrom: "01/08/2026", dateTo: "31/08/2026" }), "01/08/2026 to 31/08/2026, All Zones");
});

await test("request building: invalid mode / missing token are rejected", () => {
  let err = null;
  try {
    buildBillStatusRequest({ mode: "everything" }, "T");
  } catch (e) {
    err = e;
  }
  eq(err && err.code, IREPS_ERROR.INVALID_REQUEST);
  err = null;
  try {
    buildBillStatusRequest({}, "");
  } catch (e) {
    err = e;
  }
  eq(err && err.code, IREPS_ERROR.TOKEN_NOT_FOUND);
});

await test("date range validation mirrors IREPS rules (format, order, 180 days)", () => {
  eq(validateDateRange("01/08/2026", "31/08/2026").ok, true);
  eq(validateDateRange("", "31/08/2026").ok, false, "missing from");
  eq(validateDateRange("01/08/2026", "").ok, false, "missing to");
  eq(validateDateRange("1/8/2026", "31/08/2026").ok, false, "not 10 characters");
  eq(validateDateRange("2026-08-01", "2026-08-31").ok, false, "wrong format");
  eq(validateDateRange("31/02/2026", "31/03/2026").ok, false, "impossible date");
  assert(/earlier/.test(validateDateRange("31/08/2026", "01/08/2026").error), "from after to");
  eq(validateDateRange("01/01/2026", "30/06/2026").ok, true, "180 days is allowed");
  assert(/180 days/.test(validateDateRange("01/01/2026", "01/07/2026").error), "181 days rejected");
  let err = null;
  try {
    buildBillStatusRequest({ mode: "dateRange", dateFrom: "31/08/2026", dateTo: "01/08/2026" }, "T");
  } catch (e) {
    err = e;
  }
  eq(err && err.code, IREPS_ERROR.INVALID_REQUEST, "invalid range never builds a request");
});

/* ---------------------------------------------------------- session detection */

await test("session validation: bill page, login page, expired page, redirect, http error", async () => {
  const bill = await fixture("bill-status-page.html");
  const login = await fixture("login-page.html");
  const expired = await fixture("session-expired.html");

  eq(hasBillStatusForm(bill), true);
  eq(isIrepsBillStatusPage(bill), true);
  eq(isIrepsLoginPage(bill), false);
  eq(validateIrepsSession(bill, { ok: true, status: 200 }).authenticated, true);
  eq(validateIrepsSession(bill, { ok: true, status: 200 }).code, "OK");

  eq(isIrepsLoginPage(login), true);
  eq(validateIrepsSession(login, { ok: true, status: 200 }).code, IREPS_ERROR.SESSION_EXPIRED);
  eq(validateIrepsSession(expired, { ok: true, status: 200 }).code, IREPS_ERROR.SESSION_EXPIRED);
  eq(validateIrepsSession(bill, { ok: true, status: 200, redirected: true, url: "https://www.ireps.gov.in/epsn/login.do" }).code, IREPS_ERROR.SESSION_EXPIRED);
  eq(validateIrepsSession(bill, { ok: false, status: 500 }).code, IREPS_ERROR.REQUEST_FAILED);
  eq(validateIrepsSession("<html><body>Hello</body></html>", { ok: true, status: 200 }).code, IREPS_ERROR.INVALID_RESPONSE);
  eq(validateIrepsSession("", { ok: true, status: 200 }).code, IREPS_ERROR.INVALID_RESPONSE);
});

await test("no-records page is authenticated, has zero blocks and a page message", async () => {
  const html = await fixture("no-records.html");
  eq(validateIrepsSession(html, { ok: true, status: 200 }).authenticated, true);
  assert(isNoRecordsPage(html), "no-records marker detected");
  const result = parseBillStatus(html);
  eq(result.recordCount, 0);
  eq(result.blockCount, 0);
  assert(result.pageMessage && result.pageMessage.includes("no records found"), "page message");
});

/* ------------------------------------------------------------ request layer */

await test("requestIreps: POST with empty body sets the form content type and includes credentials", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  const res = await loadBillStatusPage({ fetch: fetchImpl });
  eq(res.status, 200);
  eq(seen.length, 1);
  assert(seen[0].url.endsWith("/epsn/admin/viewBills.do"), seen[0].url);
  eq(seen[0].init.method, "POST");
  eq(seen[0].init.body, "");
  eq(seen[0].init.credentials, "include");
  eq(seen[0].init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert(!("Cookie" in seen[0].init.headers) && !("Origin" in seen[0].init.headers), "browser-controlled headers are not set");
  assert(!("html" in seen[0].init), "no headers leak into the response object");
  assert(!("headers" in res), "response object carries no headers");
});

await test("requestIreps: HTTP 500, network failure and timeout map to IREPS_REQUEST_FAILED", async () => {
  const e1 = await rejects(
    requestIreps({ path: "/epsn/admin/viewBills.do", method: "POST", body: "" }, { fetch: async () => new Response("boom", { status: 500 }) }),
    IREPS_ERROR.REQUEST_FAILED
  );
  eq(e1.status, 500);
  eq(e1.reason, "http");
  const e2 = await rejects(
    requestIreps({ path: "/epsn/admin/viewBills.do" }, {
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      }
    }),
    IREPS_ERROR.REQUEST_FAILED
  );
  eq(e2.reason, "network");
  const e3 = await rejects(
    requestIreps({ path: "/epsn/admin/viewBills.do" }, {
      fetch: async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
    }),
    IREPS_ERROR.REQUEST_FAILED
  );
  eq(e3.reason, "timeout");
});

/* ------------------------------------------------------- Bill Status flow */

await test("fetchBillStatus: load page -> fresh token -> Show Results -> parsed bills (token never exposed)", async () => {
  const page = await fixture("bill-status-page.html");
  const stages = [];
  const { fetchImpl, calls } = fakeIreps({
    page,
    onSearch: (body, token, respond) => {
      const p = new URLSearchParams(body);
      if (p.get(BILL_STATUS_FORM_FIELDS.TOKEN) !== token) return respond("<html><body><h2>Invalid Token</h2></body></html>");
      return respond(page);
    }
  });
  const result = await fetchBillStatus({ mode: "last90Days", zone: "-1" }, { fetch: fetchImpl, parseHtml, onProgress: (s) => stages.push(s) });

  eq(calls.length, 2, "exactly two requests");
  eq(calls[0].method, "POST");
  eq(calls[0].body, "", "first request has an empty body");
  eq(calls[1].method, "POST");
  eq(calls[1].body, "org.apache.struts.taglib.html.TOKEN=TOKEN-1&zone=-1&searchRange=1&dateFrom=&dateTo=&submit=Show+Results&searchParam=");
  eq(calls[1].headers["Content-Type"], "application/x-www-form-urlencoded");
  eq(stages.join(","), "CHECKING_SESSION,CONNECTED,FETCHING,PROCESSING");

  eq(result.success, true);
  eq(result.recordCount, 6);
  eq(result.bills.length, 6);
  eq(JSON.stringify(result.request), JSON.stringify({ mode: "last90Days", zone: "-1" }));
  eq(result.filter, "Last 90 Days, All Zones");
  eq(result.form.zones.length, 35);
  assert(typeof result.fetchedAt === "string" && !Number.isNaN(Date.parse(result.fetchedAt)), "fetchedAt is ISO");
  assert(!JSON.stringify(result).includes("TOKEN-1"), "result never contains the Struts token");
});

await test("fetchBillStatus: date range and railway zone requests carry the right fields", async () => {
  const page = await fixture("bill-status-page.html");
  const { fetchImpl, calls } = fakeIreps({ page, onSearch: (body, token, respond) => respond(page) });
  await fetchBillStatus({ mode: "dateRange", dateFrom: "01/08/2026", dateTo: "31/08/2026" }, { fetch: fetchImpl, parseHtml });
  let p = new URLSearchParams(calls[1].body);
  eq(p.get("searchRange"), "2");
  eq(p.get("dateFrom"), "01/08/2026");
  eq(p.get("dateTo"), "31/08/2026");
  const r = await fetchBillStatus({ mode: "railwayZone", zone: "13" }, { fetch: fetchImpl, parseHtml });
  p = new URLSearchParams(calls[3].body);
  eq(p.get("searchRange"), "3");
  eq(p.get("zone"), "13");
  eq(r.filter, "Railway Zone: ICF", "zone label resolved from the page");
  await rejects(fetchBillStatus({ mode: "dateRange", dateFrom: "01/01/2026", dateTo: "01/12/2026" }, { fetch: fetchImpl, parseHtml }), IREPS_ERROR.INVALID_REQUEST);
});

await test("fetchBillStatus: login page -> IREPS_SESSION_EXPIRED (no search attempted)", async () => {
  const login = await fixture("login-page.html");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init);
    return new Response(login, { status: 200, headers: { "content-type": "text/html" } });
  };
  await rejects(fetchBillStatus({}, { fetch: fetchImpl, parseHtml }), IREPS_ERROR.SESSION_EXPIRED);
  eq(calls.length, 1, "stops after the first request");

  const expired = await fixture("session-expired.html");
  await rejects(fetchBillStatus({}, { fetch: async () => new Response(expired, { status: 200 }), parseHtml }), IREPS_ERROR.SESSION_EXPIRED);
});

await test("fetchBillStatus: session expiring between the two requests -> IREPS_SESSION_EXPIRED", async () => {
  const page = await fixture("bill-status-page.html");
  const login = await fixture("login-page.html");
  const { fetchImpl, calls } = fakeIreps({ page, onSearch: (body, token, respond) => respond(login) });
  await rejects(fetchBillStatus({}, { fetch: fetchImpl, parseHtml }), IREPS_ERROR.SESSION_EXPIRED);
  eq(calls.length, 2, "no retry for an expired session");
});

await test("fetchBillStatus: Bill Status page without the token -> IREPS_TOKEN_NOT_FOUND", async () => {
  const page = (await fixture("bill-status-page.html")).replace(/<input type="hidden" name="org\.apache\.struts\.taglib\.html\.TOKEN"[^>]*>/, "");
  const { fetchImpl, calls } = fakeIreps({ page, onSearch: (body, token, respond) => respond(page) });
  await rejects(fetchBillStatus({}, { fetch: fetchImpl, parseHtml }), IREPS_ERROR.TOKEN_NOT_FOUND);
  eq(calls.length, 1, "no search without a token");
});

await test("fetchBillStatus: HTTP 500 -> IREPS_REQUEST_FAILED, no records -> IREPS_NO_RECORDS", async () => {
  await rejects(fetchBillStatus({}, { fetch: async () => new Response("err", { status: 500 }), parseHtml }), IREPS_ERROR.REQUEST_FAILED);
  const page = await fixture("bill-status-page.html");
  const empty = await fixture("no-records.html");
  const { fetchImpl } = fakeIreps({ page, onSearch: (body, token, respond) => respond(empty) });
  await rejects(fetchBillStatus({}, { fetch: fetchImpl, parseHtml }), IREPS_ERROR.NO_RECORDS);
});

await test("fetchBillStatus: unrecognised search response is retried once with a fresh token", async () => {
  const page = await fixture("bill-status-page.html");
  let searches = 0;
  const { fetchImpl, calls } = fakeIreps({
    page,
    onSearch: (body, token, respond) => {
      searches++;
      if (searches === 1) return respond("<html><body><h2>Invalid Token</h2><p>Please try again.</p></body></html>");
      return respond(page);
    }
  });
  const result = await fetchBillStatus({}, { fetch: fetchImpl, parseHtml });
  eq(calls.length, 4, "page, search, page, search");
  assert(calls[3].body.includes("TOKEN=TOKEN-2"), "second attempt uses the new token");
  eq(result.recordCount, 6);

  const always = fakeIreps({ page, onSearch: (body, token, respond) => respond("<html><body><h2>Invalid Token</h2></body></html>") });
  await rejects(fetchBillStatus({}, { fetch: always.fetchImpl, parseHtml }), IREPS_ERROR.INVALID_RESPONSE);
  eq(always.calls.length, 4);
});

await test("fetchBillStatus: blocks present but unreadable -> IREPS_PARSE_FAILED; parser crash -> IREPS_PARSE_FAILED", async () => {
  const page = await fixture("bill-status-page.html");
  const garbage = `<html><body><form name="vendorPartyCodeForm" action="/epsn/admin/viewBills.do"><input type="hidden" name="org.apache.struts.taglib.html.TOKEN" value="x"></form>
    <table id="table_id"><tr><td>nothing</td></tr></table></body></html>`;
  const { fetchImpl } = fakeIreps({ page, onSearch: (body, token, respond) => respond(garbage) });
  await rejects(fetchBillStatus({}, { fetch: fetchImpl, parseHtml }), IREPS_ERROR.PARSE_FAILED);
  const crash = fakeIreps({ page, onSearch: (body, token, respond) => respond(page) });
  await rejects(
    fetchBillStatus({}, {
      fetch: crash.fetchImpl,
      parseHtml: () => {
        throw new Error("boom");
      }
    }),
    IREPS_ERROR.PARSE_FAILED
  );
});

/* --------------------------------------------------------------- messages */

await test("error catalogue maps IREPS codes to user messages", () => {
  const s = describeError(IREPS_ERROR.SESSION_EXPIRED);
  eq(s.loginRequired, true);
  eq(s.title, "IREPS login required");
  assert(s.message.includes("log in to IREPS in this Chrome browser"), s.message);
  const r = describeError(IREPS_ERROR.REQUEST_FAILED, { status: 503 });
  assert(r.message.includes("IREPS returned HTTP 503"), r.message);
  eq(describeError(IREPS_ERROR.NO_RECORDS).notice, true);
  eq(describeError(IREPS_ERROR.TOKEN_NOT_FOUND).title, "IREPS form token not found");
  eq(describeError("nonsense").code, "UNKNOWN");
});

/* ------------------------------------------------------------- utilities */

await test("sanitiser removes scripts, handlers and javascript urls", () => {
  const dirty = `<div onclick="x()"><script>alert(1)</script><a href="javascript:void(0)">a</a><p>ok</p><iframe src="x"></iframe></div>`;
  const clean = sanitiseFragment(dirty);
  assert(!/script|iframe|onclick|javascript:/i.test(clean), `unsafe content survived: ${clean}`);
  assert(clean.includes("<p>ok</p>"), "safe content kept");
  eq(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

await test("logger redacts cookies, session ids and Struts tokens", () => {
  const out = redact("Cookie: JSESSIONID=ABC123; path=/");
  assert(!out.includes("ABC123"), out);
  const tok = redact("org.apache.struts.taglib.html.TOKEN=deadbeef&zone=-1");
  assert(!tok.includes("deadbeef"), tok);
  const obj = redact({ status: 200, cookie: "JSESSIONID=XYZ", nested: { token: "t", size: 5 } });
  eq(obj.cookie, "[REDACTED]");
  eq(obj.nested.token, "[REDACTED]");
  eq(obj.nested.size, 5);
});

await test("filename format", () => {
  eq(buildBillStatusFilename(new Date(2026, 8, 15, 12, 30, 42)), "IREPS_Bill_Status_2026-09-15_12-30-42.pdf");
});

/* ------------------------------------------------------------------- PDF */

await test("PDF: text wrapping never exceeds width and long words are broken", () => {
  const { wrapText, textWidth, FONTS } = pdfInternals;
  const lines = wrapText("word ".repeat(80) + "x".repeat(400), FONTS.regular, 8.6, 200);
  for (const line of lines) assert(textWidth(line, FONTS.regular, 8.6) <= 200.01, `line too wide: ${line}`);
  assert(lines.length > 5, "wrapped into multiple lines");
});

await test("PDF generation: valid structure, all records present, selectable text", async () => {
  const result = parseBillStatus(bigFixture(120), { now: new Date(2026, 8, 15, 12, 30, 42) });
  const pdf = await generateBillStatusPdf(result, { compress: false });
  const text = new TextDecoder("latin1").decode(pdf.bytes);
  assert(text.startsWith("%PDF-1.4"), "pdf header");
  assert(text.trimEnd().endsWith("%%EOF"), "pdf trailer");
  assert(pdf.pageCount > 20, `expected many pages, got ${pdf.pageCount}`);
  eq((text.match(/\/Type \/Page\b/g) || []).length, pdf.pageCount, "page objects");
  assert(text.includes("(INV-1)") && text.includes("(INV-120)"), "first and last bill present");
  assert(text.includes(`Page ${pdf.pageCount} of ${pdf.pageCount}`), "footer page numbers");
  const xrefPos = text.lastIndexOf("\nxref\n") + 1;
  const startxref = parseInt(text.slice(text.lastIndexOf("startxref") + 9).trim(), 10);
  eq(startxref, xrefPos, "startxref offset");
  const entries = text.slice(xrefPos).split("\n").slice(2).filter((l) => / n $/.test(l) || / n$/.test(l));
  entries.forEach((entry, i) => {
    const offset = parseInt(entry.slice(0, 10), 10);
    assert(text.slice(offset, offset + 12).startsWith(`${i + 1} 0 obj`), `xref entry ${i + 1} wrong (offset ${offset})`);
  });
});

await test("PDF generation from the real layout fixture includes every bill and the recovery lines", async () => {
  const html = await fixture("bill-status-page.html");
  const result = parseBillStatus(html, { filter: "Last 90 Days, All Zones" });
  const pdf = await generateBillStatusPdf(result, { compress: false });
  const text = new TextDecoder("latin1").decode(pdf.bytes);
  assert(text.includes("(13240000000101)"), "first contract present");
  assert(text.includes("(GST TDS DEDUCTION: 52244.1)"), "recovery line present");
  assert(text.includes("(#VARY IN SCHEDULE B- COST OF MATERIAL PLEASE CHECK)"), "reason present");
  assert(text.includes("Last 90 Days, All Zones"), "filter present");
  assert(!text.includes("FAKE-TOKEN"), "token never reaches the PDF");
});

await test("PDF generation: compressed output and empty result", async () => {
  const result = parseBillStatus("<html><body><h3>Bill Status</h3><p>No records found</p></body></html>");
  const pdf = await generateBillStatusPdf(result);
  eq(pdf.pageCount, 1);
  const text = new TextDecoder("latin1").decode(pdf.bytes);
  assert(text.includes("/FlateDecode"), "compressed streams used when CompressionStream exists");
});

await test("PDF generation: long recovery details wrap and cards split across pages", async () => {
  const html = `<table><tr><th>Contract No</th><th>Bill No</th><th>Status</th><th>Net Amt</th><th>Recovery Details</th></tr>
    <tr><td>C1</td><td>B1</td><td>Returned</td><td>10</td><td>${"Very long recovery detail line number N with amount 1,234.56. ".repeat(200)}</td></tr></table>`;
  const result = parseBillStatus(html);
  const pdf = await generateBillStatusPdf(result, { compress: false });
  const text = new TextDecoder("latin1").decode(pdf.bytes);
  assert(pdf.pageCount >= 2, `expected the card to split, got ${pdf.pageCount} page(s)`);
  assert(text.includes("\\(continued\\)"), "continued header present");
});

/* ------------------------------------------------------------------- CRN */

await runCrnTests({ test, assert, eq, rejects, fixture, FAKE_TOKEN });
await runRnoteTests({ test, assert, eq, rejects, fixture, FAKE_TOKEN });
await runMaTests({ test, assert, eq, rejects, fixture, FAKE_TOKEN });

/* ---------------------------------------------------------------- report */

for (const r of results) {
  const li = document.createElement("li");
  li.className = r.ok ? "pass" : "fail";
  li.textContent = `${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok ? "" : `\n${r.error}`}`;
  list.append(li);
}
const failed = results.filter((r) => !r.ok).length;
document.getElementById("summary").textContent = `DOCLINK_TESTS ${results.length - failed}/${results.length} passed${failed ? ` (${failed} FAILED)` : ""}`;
document.body.dataset.done = "1";
