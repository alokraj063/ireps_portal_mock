# DocLink — IREPS Document Automation (Chrome Extension, Manifest V3)

DocLink is a Chrome extension for users of the Indian Railways IREPS portal.
Version 1.1.0 implements two independent downloads:

* **Download IREPS Bill Status** (since 1.0.0): retrieves the Bill Status page
  from the user's already-authenticated IREPS browser session, extracts the
  bill records, builds a clean text-based PDF and saves it to
  `Downloads/DocLink/IREPS/`.
* **Download IREPS CRN** and **Download IREPS R-NOTE** (new in 1.1.0): run
  the IREPS *PO Search* (`/epsn/searchPO.do`) for Consignment Receipt Notes
  (`searchCriteria=CRN`) or Receipt Notes (`searchCriteria=RNOTE`) and
  download the complete result table as an Excel workbook (or CSV) into
  `Downloads/DocLink/IREPS/CRN/` or `Downloads/DocLink/IREPS/RNOTE/` -
  DocLink's equivalent of the portal's "Export to Excel" button, but with
  every row, not only the visible page. Both share one PO Search layer;
  only the search criteria, the result parser, the export columns and the
  file name differ. See section 12.
* **Download IREPS MA Copies** (new in 1.1.0): runs the same PO Search for
  Modification Advices (`searchCriteria=MA`), lists the MAs of a chosen MA
  date (default: today), and downloads their actual MA PDF copies from the
  "View/Download MA" links into `Downloads/DocLink/IREPS/MA/<date>/`. See
  section 13.

The **Upload Document** card is present in the UI as a Phase 2 placeholder.

DocLink never asks for, reads, stores or forwards IREPS credentials, security
keys or session cookies. It acts as an authenticated browser client, not as a
credential manager.

---

## 1. What DocLink does

```
User logs into IREPS normally (security key)      <- unchanged, manual
        ↓
Chrome holds the authenticated IREPS session
        ↓
User opens DocLink → Download Bill Status
        ↓
DocLink POSTs viewBills.do (empty body) with credentials: "include"
        ↓
Chrome attaches the IREPS cookies itself
        ↓
DocLink validates the response (login page? session expired? Bill Status form?)
        ↓
DocLink reads the fresh Struts TOKEN from the returned form (memory only)
        ↓
DocLink POSTs viewBills.do again: TOKEN + zone=-1 + searchRange=1 + submit=Show Results
        ↓
Every <table id="table_id"> block is parsed by its header labels
        ↓
PDF generated (selectable text, one card per bill)
        ↓
Saved to Downloads/DocLink/IREPS/IREPS_Bill_Status_YYYY-MM-DD_HH-mm-ss.pdf
```

Values are reproduced exactly as IREPS returned them. Nothing is calculated,
corrected, reconciled or inferred.

---

## 2. Architecture

| Layer | File | Responsibility |
|---|---|---|
| UI | `popup/popup.html`, `popup.css`, `popup.js` | Rendered in Chrome's side panel (docked right, full height; the toolbar icon toggles it). Download cards (Bill Status, CRN), connection indicator, progress, results, login-required view, upload placeholder |
| UI (PO Search) | `popup/popup-documents.js` | Shared CRN / R-NOTE view: railway / PO / date filters, file format, progress, result |
| Orchestration | `background/service-worker.js` | Runs the workflow, tracks job state, relays progress to the popup |
| DOM parsing | `background/offscreen.html`, `offscreen.js` | Offscreen document that owns `DOMParser` (service workers have none) |
| Networking | `services/ireps-api.js` | All IREPS URLs, the two `viewBills.do` requests, form-field constants, date-range validation, error codes |
| Form | `services/ireps-form.js` | Extracts the dynamic Struts TOKEN, zone list and searchRange controls from the page (DOM or regex, so it also runs in the service worker) |
| Flow | `services/bill-status-service.js` | `fetchBillStatus(options)`: page → session check → token → Show Results → parse → validate |
| Session | `services/session-service.js` | Content-based login / session-expired / Bill Status page detection |
| Parsing | `services/bill-parser.js` | Label-driven extraction of every `table#table_id` block (plus legacy table fallback) → structured bills + printable HTML |
| Recon | `services/recon-service.js` | Optional sender (disabled by default); never affects the download |
| PDF | `services/pdf-service.js` | Dependency-free PDF writer (Helvetica, wrapping, page breaks, headers/footers) |
| Download | `services/download-service.js` | `chrome.downloads` with `uniquify` conflict handling |
| Upload | `services/upload-service.js` | Phase 2 placeholder, isolated from the download flow |
| PO Search API | `services/search-po/search-po-api.js` | `/epsn/searchPO.do` requests (showPage, `searchCriteria=<type>` search, page links), document types, error codes, URL resolution |
| PO Search form | `services/search-po/search-po-form.js` | Extracts the Struts TOKEN, railway list, searchCriteria options and searchRange controls from the PO Search page |
| PO Search table | `services/search-po/search-po-table.js` | Generic result-table mechanics: table location by header, cell text, anchors, pagination links, page message |
| PO Search flow | `services/search-po/search-po-service.js` | `searchIrepsDocuments({ criteria })`: page → session → token → search → parse (routed by criteria) → follow result pages |
| PO Search export | `services/search-po/search-po-export.js` | Writes the download file from a header/rows table: Excel (.xlsx) or CSV; no PDF assumed |
| CRN | `services/crn/crn-parser.js`, `crn-export.js`, `crn-service.js` | CRN column map, link classification (CRN / claim / bill PDF), CRN export columns, `searchCrn()` |
| R-NOTE | `services/rnote/rnote-parser.js`, `rnote-export.js`, `rnote-service.js` | Layout-agnostic R-NOTE parser (rawColumns + links + document link detection), R-NOTE export, `searchRnote()` |
| MA | `services/ma/ma-parser.js`, `ma-service.js` | MA table parser (PO link vs `View/Download MA` link), MA-date filter, `searchMa()`, `downloadMaPdfs()` |
| Documents | `services/search-po/document-downloader.js` | Fetches a linked IREPS document with the browser session, verifies it is a PDF (login page → session expired), saves it; batches with limited concurrency |
| UI (MA) | `popup/popup-ma.js` | MA view: date / range / all, railway, PO filter, MA list with selection, Download Selected / All, per-MA status |
| Writers | `utils/xlsx-writer.js`, `utils/zip-writer.js` | Dependency-free Office Open XML workbook + ZIP (store) writers |
| Preview | `pages/preview.html`, `preview.js`, `preview.css` | Printable preview built from structured data; fallback "Print / Save as PDF" and in-page "Download PDF" |
| Utilities | `utils/logger.js`, `sanitizer.js`, `filename.js`, `messages.js` | Redacting logger, HTML sanitisation, file naming, message/stage/error catalogue |

Message flow:

```
popup ──CHECK_IREPS_SESSION / DOWNLOAD_IREPS_BILL_STATUS / GET_JOB_STATE──▶ service worker
popup ◀──IREPS_PROGRESS / IREPS_DOWNLOAD_COMPLETE / IREPS_DOWNLOAD_ERROR────── service worker
service worker ──PARSE_BILL_STATUS (html)──▶ offscreen document ──▶ parsed result
```

The job runs in the service worker, so closing the popup does not cancel it.
Reopening the popup restores the current or last state via `GET_JOB_STATE`.

---

## 3. Folder structure

```
doclink-extension/
├── manifest.json
├── background/
│   ├── service-worker.js
│   ├── offscreen.html
│   └── offscreen.js
├── popup/
│   ├── popup.html
│   ├── popup.css
│   ├── popup.js
│   ├── popup-documents.js
│   └── popup-ma.js
├── services/
│   ├── search-po/
│   │   ├── search-po-api.js  search-po-form.js  search-po-table.js  search-po-service.js  search-po-export.js  document-downloader.js
│   ├── crn/
│   │   ├── crn-parser.js  crn-export.js  crn-service.js
│   ├── rnote/
│   │   ├── rnote-parser.js  rnote-export.js  rnote-service.js
│   ├── ma/
│   │   ├── ma-parser.js  ma-service.js
│   ├── ireps-api.js
│   ├── ireps-form.js
│   ├── bill-status-service.js
│   ├── session-service.js
│   ├── bill-parser.js
│   ├── recon-service.js
│   ├── pdf-service.js
│   ├── download-service.js
│   └── upload-service.js
├── pages/
│   ├── preview.html
│   ├── preview.js
│   └── preview.css
├── utils/
│   ├── logger.js
│   ├── sanitizer.js
│   ├── filename.js
│   ├── messages.js
│   ├── xlsx-writer.js
│   └── zip-writer.js
├── assets/
│   ├── icon16.png  icon32.png  icon48.png  icon128.png
├── test/
│   ├── run-tests.html / run-tests.js      (browser test-suite)
│   ├── make-sample-pdf.mjs                (Node: writes a sample PDF)
│   ├── crn-tests.js  rnote-tests.js  ma-tests.js  (CRN / R-NOTE / MA browser tests, run by run-tests.js)
│   ├── mock/                              (mock IREPS server + target switch)
│   └── fixtures/                          (real-layout page, legacy table, login, expired, no-records,
│                                           crn-search-page, crn-results-page, crn-no-records,
│                                           rnote-results-page (assumed layout), ma-results-page HTML)
└── README.md
```

---

## 4. Required permissions

| Permission | Why |
|---|---|
| `downloads` | Save the Bill Status PDF into `Downloads/DocLink/IREPS/`, the CRN / R-NOTE exports (.xlsx/.csv) into `Downloads/DocLink/IREPS/CRN/` and `.../RNOTE/`, and the MA copies into `.../MA/<date>/`, and open the folder |
| `storage` | `chrome.storage.local` for non-sensitive metadata (last download time, filename, record count); `chrome.storage.session` (memory only) for job state and the last parsed result used by the preview |
| `tabs` | Open IREPS / the preview page in a new tab |
| `offscreen` | Create an invisible offscreen document so the parser can use `DOMParser`; MV3 service workers have no DOM |
| host `https://www.ireps.gov.in/*` (or `http://localhost:8765/*` while testing against the mock) | Lets the extension `fetch()` IREPS (viewBills.do and searchPO.do, same origin) with the user's cookies attached by Chrome. Switch with `node test/mock/switch-target.mjs real` / `mock` |

Not requested: `cookies`, `<all_urls>`, `history`, `bookmarks`, `webRequest`,
`debugger`. The extension never reads cookie values.

---

## 5. How IREPS session handling works

DocLink does not track a session id. "Logged in" means one thing only: IREPS
answered the authenticated request with the Bill Status page.

`services/session-service.js`:

* `checkIrepsSession()` performs `POST /epsn/admin/viewBills.do` (empty body)
  and validates the HTML.
* `validateIrepsSession(html, response)` returns `{ authenticated, reason, code }`
  with codes `OK`, `IREPS_SESSION_EXPIRED`, `IREPS_REQUEST_FAILED`,
  `IREPS_INVALID_RESPONSE`.
* `hasBillStatusForm(html)` is the strong check: the page must contain
  `<form name="vendorPartyCodeForm" action="/epsn/admin/viewBills.do">`.
* `isIrepsLoginPage(html)` looks for session-expired phrases, a password
  input, a redirect to a login-looking URL, or login vocabulary in the absence
  of bill data.

HTTP 200 is never trusted on its own: IREPS may return a login page with 200.
Any request in the flow can hit an expired session; the second (search)
response is validated exactly like the first.

The session check result is cached for 20 seconds in service-worker memory so
that opening the popup and clicking Download does not hit IREPS twice; the
page is handed to the download once and then discarded. Cookies are never
read: Chrome attaches them because the extension has host permission for the
IREPS origin and the requests use `credentials: "include"`.

---

## 6. How the Bill Status request works

Captured from the real portal (HAR) and implemented in `services/ireps-api.js`
and `services/bill-status-service.js`:

```
1. POST https://www.ireps.gov.in/epsn/admin/viewBills.do
   Content-Type: application/x-www-form-urlencoded
   (empty body)
   -> HTML: vendorPartyCodeForm, hidden org.apache.struts.taglib.html.TOKEN,
      <select name="zone"> (-1 = All, 01 = CR, 13 = ICF, ...),
      searchRange radios (3 Railway Zone, 2 Select Date, 1 Last 90 Days [default]),
      dateFrom / dateTo, submit "Show Results", hidden searchParam,
      and the default bill blocks

2. POST https://www.ireps.gov.in/epsn/admin/viewBills.do
   Content-Type: application/x-www-form-urlencoded
   org.apache.struts.taglib.html.TOKEN=<token from step 1>
   &zone=-1&searchRange=1&dateFrom=&dateTo=&submit=Show+Results&searchParam=
   -> HTML: one <table id="table_id"> per bill
```

Only `Accept` and `Content-Type` are set by DocLink; Cookie, Origin, Referer,
User-Agent, Sec-Fetch-* etc. are generated by Chrome. `/epsn/searchPO.do`
(seen in another capture) is a different workflow and is not used.

Public API:

```javascript
import { fetchBillStatus } from "./services/bill-status-service.js";

await fetchBillStatus({ mode: "last90Days", zone: "-1" }, { parseHtml });
await fetchBillStatus({ mode: "dateRange", zone: "-1", dateFrom: "01/08/2026", dateTo: "31/08/2026" }, { parseHtml });
await fetchBillStatus({ mode: "railwayZone", zone: "13" }, { parseHtml });
// -> { success: true, request: { mode, zone, ... }, filter, fetchedAt, recordCount, bills, warnings, form: { zones, searchRanges }, parsed }
```

`parseHtml` is injected because the service worker has no DOMParser (it
forwards to the offscreen document; tests pass `parseBillStatus` directly).

Constants (never magic numbers in the code):

```javascript
BILL_SEARCH_RANGE = { LAST_90_DAYS: "1", DATE_RANGE: "2", RAILWAY_ZONE: "3" }
BILL_SEARCH_MODE  = { LAST_90_DAYS: "last90Days", DATE_RANGE: "dateRange", RAILWAY_ZONE: "railwayZone" }
ALL_ZONES = "-1";  MAX_DATE_RANGE_DAYS = 180
```

Date-range requests are validated before anything is sent, with the same
rules as the IREPS page script (both dates, DD/MM/YYYY, From ≤ To, ≤ 180 days).

### Struts TOKEN handling

* The token is read from the returned HTML by `services/ireps-form.js`
  (`extractStrutsToken`) - never hard-coded.
* It lives only in local variables inside `fetchBillStatus()` for the duration
  of the request; it is not logged (the logger redacts `TOKEN=` anyway), not
  stored, and not part of any result, message or PDF.
* Missing token on an otherwise valid page → `IREPS_TOKEN_NOT_FOUND`.
* The token is single-use per page render. If the search response is not the
  Bill Status page (for example the user reloaded IREPS in another tab and
  consumed the token), DocLink loads the page once more, takes the fresh token
  and retries once. A second failure → `IREPS_INVALID_RESPONSE`.

### Error codes

| Code | When | Popup |
|---|---|---|
| `IREPS_SESSION_EXPIRED` | login page / session-expired page / redirect to login (either request) | "IREPS login required" view |
| `IREPS_REQUEST_FAILED` | network error, timeout, HTTP ≠ 2xx | "Unable to retrieve Bill Status" |
| `IREPS_TOKEN_NOT_FOUND` | Bill Status page without the TOKEN input | "IREPS form token not found" |
| `IREPS_INVALID_RESPONSE` | page is neither login nor Bill Status (after one retry) | "Unable to recognise the IREPS response" |
| `IREPS_PARSE_FAILED` | blocks present but unreadable, or parser crashed | "Unable to read the Bill Status records" |
| `IREPS_NO_RECORDS` | authenticated page, zero blocks | "No Bill Records Found" (notice) |
| `IREPS_INVALID_REQUEST` | bad mode / invalid date range | "Invalid search options" (notice) |

---

## 7. How parsing works

`services/bill-parser.js` — `parseBillStatus(html, { filter })`:

1. Parse with `DOMParser` into a detached document; strip `script`, `style`,
   `iframe`, forms, media, event handlers and `javascript:` URLs.
2. `document.querySelectorAll("table#table_id")` — the id is repeated for every
   bill, so `querySelector` would only return the first.
3. `parseBillBlock(table)` classifies rows by content, never by position:
   * a row whose cells are all field labels (e.g. `Contract No | Contract Date |
     Bill Number | Bill Date | Zone | Party Name | PartyCode`, or `CO6 No |
     CO6 Date | Status | Bill Amt | Passed Amt | Deducted Amt | Net Amt | CO7 No |
     CO7 Date | Payment Advice Date to Bank | Accounting Unit(Division)`) is a
     header; the next row holds the values, mapped column by column;
   * a single-cell `Reason For Return` / `Recovery Details` row is a section
     header; the next row's complete text is stored (`<br>` → newline, nested
     tables → one line per row);
   * `Label | value` cell pairs are read as key/value; nested tables are walked
     with the same rules.
   Labels are normalised ("Accounting Unit(Division)" → `accountingunit`) and
   matched against alias lists (`Payment Advice Date to Bank` →
   `paymentAdviceDate`, `PartyCode` → `partyCode`).
4. `normalizeIrepsValue()` turns `----`, `-`, `NA`, `N/A` and empty cells into
   `null`; every other value is kept verbatim as a string (amounts are not
   converted, nothing is calculated).
5. `validateBillStatusRecords()` keeps every block that has a Bill Number
   and/or a Contract No, sets aside the rest, and produces warnings such as
   "Bill record 47 is missing Bill Number.". Nothing is de-duplicated: a bill
   appears once per lifecycle status (REGISTERED, RETURNED, PASSED, PAYMENT
   MADE, CO7 DONE, ...) exactly as IREPS lists it.
6. If no `table#table_id` exists, the legacy single-table / key-value parsers
   are tried (kept for older layouts).

Result:

```javascript
{
  title: "IREPS Bill Status",
  generatedAt, retrievedAt, source: "IREPS", sourceUrl,
  filter: "Last 90 Days, All Zones",
  recordCount: 2129, blockCount: 2129, skippedCount: 0,
  bills: [ { index, contractNo, contractDate, billNumber, billDate, zone,
             partyName, partyCode, co6No, co6Date, status, billAmount,
             passedAmount, deductedAmount, netAmount, co7No, co7Date,
             paymentAdviceDate, accountingUnit, recoveryDetails,
             reasonForReturn, extra: {} } ],
  extraColumns, structure: "blocks" | "table" | "keyValue" | "none",
  pageMessage, warnings, printableHtml
}
```

Verified against the captured real page (6.8 MB, 2,129 blocks): 2,129
records, 0 skipped, all 20 fields populated where IREPS shows them.

---

## 8. How PDF generation works

`services/pdf-service.js` writes the PDF directly (no library, no backend,
no screenshots):

* A4 portrait, Helvetica / Helvetica-Bold (standard PDF fonts, text is
  selectable and searchable).
* Title block with Source / Retrieved / Filter / Records.
* One card per bill: two label/value columns, long fields (Party Name,
  Accounting Unit, Recovery Details, Reason for Return, extra columns)
  full-width and word-wrapped.
* Cards move to the next page when they do not fit; cards taller than a page
  split at row boundaries; a single row taller than a page splits by line
  with its label repeated and the header marked "(continued)".
* Running header and "Page X of Y" footer on every page.
* Streams are Flate-compressed with `CompressionStream` when available.

`generateBillStatusPdf(result)` → `{ bytes, pageCount }`. The bytes are
handed to `chrome.downloads.download` as a `data:` URL (service workers have
no `URL.createObjectURL`).

Fallback: if PDF generation or the download fails, the popup offers
**Open printable preview** (`pages/preview.html`), which renders the same
data from `chrome.storage.session` and provides **Download PDF** (in-page
generation) and **Print / Save as PDF**.

---

## 9. Loading the unpacked extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `doclink-extension/` folder
5. Login to IREPS at https://www.ireps.gov.in/ with your normal security key
6. Open DocLink from the toolbar
7. Click **Download Bill Status**

Requires Chrome 116 or newer (offscreen documents + `chrome.runtime.getContexts`).

---

## 10. Testing

### Automated tests (no extension APIs required)

```bash
# Browser suite — parser, session detection, sanitiser, logger redaction, PDF writer
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --allow-file-access-from-files --virtual-time-budget=20000 \
  --dump-dom "file://$PWD/test/run-tests.html" | grep -o 'DOCLINK_TESTS[^<]*'
# → DOCLINK_TESTS 43/43 passed

# Sample PDF for visual inspection
node test/make-sample-pdf.mjs /tmp/sample.pdf
```

You can also open `test/run-tests.html` in Chrome started with
`--allow-file-access-from-files`.

### Testing without access to IREPS (mock portal)

`test/mock/mock-ireps-server.mjs` is a local stand-in for the portal. It
serves the same path (`/epsn/admin/viewBills.do`), issues a fresh fake Struts
token per page, requires the exact form fields on the search POST (single-use
token), uses a cookie to simulate the security-key login, and can be switched
between scenarios (`auto`, `bills`, `large`, `login`, `redirect-login`,
`expired`, `no-records`, `token-missing`, `token-invalid`, `http500`, `slow`,
`legacy`) from its home page.

```bash
node test/mock/mock-ireps-server.mjs        # terminal 1, http://localhost:8765
node test/mock/switch-target.mjs mock       # points baseUrl + host_permissions at it
# chrome://extensions -> reload DocLink
# open http://localhost:8765/ -> Login -> open DocLink -> Download Bill Status
node test/mock/switch-target.mjs real       # switch back before real use
```

### Manual acceptance tests

| # | Scenario | Expected |
|---|---|---|
| 1 | Logged into IREPS, click Download Bill Status | Stages run through; "✓ Download Complete", N records, filename shown; PDF in `Downloads/DocLink/IREPS/` |
| 2 | Logged out | No PDF; "IREPS Login Required" view with Open IREPS button |
| 3 | Session expired (login page returned with HTTP 200) | "IREPS Session Expired"; no PDF of the login page |
| 4 | IREPS returns HTTP 5xx (e.g. simulate with DevTools request blocking / override) | "Unable to Retrieve Bill Status — IREPS returned HTTP 500"; button usable again |
| 5 | Very large Bill Status | All rows in the PDF (browser test covers 600 rows) |
| 6 | Bills with missing fields | Missing values shown as "-" |
| 7 | Long Recovery Details | Text wraps, splits across pages with label repeated |
| 8 | Download twice | Two files (timestamp differs; same-second collisions get " (1)") |

Simulating 2–4 locally: use DevTools → Network → request blocking or a local
override of `viewBills.do` with `test/fixtures/login-page.html`,
`session-expired.html`, or a 500 response.

---

## 11. Security notes

* No credential, cookie, token or session id is read, stored, logged or put in
  a URL. The Struts TOKEN is held in memory only for the duration of one
  request. The logger (`utils/logger.js`) additionally redacts anything that
  looks like `Cookie:`, `JSESSIONID=`, `Authorization:`, `TOKEN=` or passwords.
* Network calls are restricted to `IREPS_CONFIG.baseUrl`; `buildIrepsUrl`
  refuses any other origin.
* IREPS HTML is parsed in an offscreen document into a detached DOM and
  never inserted into an extension page. Popup and preview build their DOM
  from structured data with `textContent`.
* Manifest CSP: `script-src 'self'; object-src 'none'`.
* Only business metadata (last download time, filename, record count, status)
  is stored in `chrome.storage.local`. The parsed bill data for the preview
  lives in `chrome.storage.session` (memory, cleared when Chrome closes).

---

## 12. Assumptions

* `POST /epsn/admin/viewBills.do` with an empty body returns the Bill Status
  page with a fresh Struts token for an authenticated session (as captured).
  Submitting `TOKEN + zone=-1 + searchRange=1 + submit=Show Results` to the
  same URL returns the Last 90 Days records for all zones.
* The exact HTML IREPS returns for "no records" and for an expired session was
  not in the capture. An authenticated page with the form but zero
  `table#table_id` blocks is reported as `IREPS_NO_RECORDS`; login pages are
  detected by password fields / login vocabulary / session-expired phrases.
* Struts token reuse: if IREPS rejects a consumed token with a page that is
  neither login nor Bill Status, DocLink retries once with a fresh token.
* Amounts are kept as the strings IREPS prints (e.g. `2968191.9`); a Bill
  Number of `-` is treated as missing (IREPS prints it for some RETURNED bills).
* Fetches from the extension carry `Origin: chrome-extension://…`. Struts does
  not check Origin; if the portal's edge (F5) ever rejects it, a
  `declarativeNetRequest` header rule would be the next step.
* Times in filenames and the PDF are the user's local time.

## 13. Known limitations

* Standard PDF fonts cover Latin-1 only. `₹` is rendered as "Rs.", typographic
  dashes/quotes as ASCII, and other scripts (e.g. Devanagari) as "?". The
  parsed data and the HTML preview keep the original characters.
* The session check loads the full Bill Status page (~7 MB on the real
  portal; there is no lighter IREPS endpoint); the result is cached for 20 s.
* Recovery Details is stored as the complete text ("GST TDS DEDUCTION: …\n…");
  structured deduction categories are not extracted yet.
* Recon Engine sending is a disabled stub (`services/recon-service.js`).

## 14. Future upload implementation (Phase 2)

`services/upload-service.js` exposes `uploadDocument(request)` returning
`{ ok, message }`. The popup's Upload view already collects Source
(SharePoint / OneDrive / Local), Select Document and Document Type and posts
`UPLOAD_DOCUMENT` to the service worker. Implementing SharePoint / OneDrive
access and the IREPS upload workflow touches only that module (plus any new
permissions it requires). Scheduled downloads and automatic login are explicitly out of scope; Recon
Engine sending is available as an optional, disabled-by-default step.

---

## 12. PO Search downloads: CRN and R-NOTE

CRN and R-NOTE are two document types of the same IREPS *PO Search*
workflow, which is separate from Bill Status and never touches `viewBills.do`:

```
Bill Status  ->  POST /epsn/admin/viewBills.do        (sections 5-8)   -> generated PDF
CRN          ->  POST /epsn/searchPO.do  searchCriteria=CRN            -> Excel export of the result table
R-NOTE       ->  POST /epsn/searchPO.do  searchCriteria=RNOTE          -> Excel export of the result table
```

On the portal the result page (PO Search → *Consignment Receipt Note (CRN)*
or *Receipt Note (R-NOTE)* → Show Results) is a DataTables grid showing 10
rows at a time with an **Export to Excel** button. DocLink reproduces that
export from the server response itself, so all rows (2,022 CRNs in the
capture) are included, not just the visible page. DocLink's download layer
is format-agnostic: the export is an `.xlsx` workbook by default, `.csv`
optionally; nothing in the flow assumes a PDF.

### Shared layer (services/search-po/)

```
               IREPS PO Search (/epsn/searchPO.do)
                            │
        search-po-api / -form / -table / -service / -export
                            │
              ┌─────────────┴─────────────┐
             CRN                        R-NOTE
      searchCriteria=CRN           searchCriteria=RNOTE
      crn-parser.js                rnote-parser.js
      crn-export.js                rnote-export.js
      IREPS_CRN_<ts>.xlsx          IREPS_RNOTE_<ts>.xlsx
```

Shared: endpoint, POST, authenticated session (`credentials: "include"`),
`searchParam=showPage`, Struts token extraction, railway list, PO / date /
searchRange / pageNo / recordsPerPage handling, 180-day validation,
pagination, single fresh-token retry, session-expiry handling, Excel/CSV
writing. Different: `searchCriteria`, the result parser, the export columns,
the file name and the error codes (`IREPS_CRN_*` vs `IREPS_RNOTE_*`).

### Flow

```
User logs into IREPS normally (security key)                      <- unchanged, manual
        ↓
DocLink popup -> Download IREPS CRN  (or Download IREPS R-NOTE) -> Download
        ↓
POST /epsn/searchPO.do        searchParam=showPage          (credentials: "include")
        ↓  "PO Search" page: <form name="searchPOForm">, fresh Struts TOKEN, railway list
DocLink validates the page (login page? expired? searchPOForm present?)
        ↓
POST /epsn/searchPO.do        TOKEN + pageNo=1 + searchCriteria=CRN|RNOTE + rly + poNo + icNo
                              + dateFrom + dateTo + searchRange + recordsPerPage
                              + submit=Show Results + searchCriteria=        (see below)
        ↓  HTML: <table id="table_id"> > <table id="dTbl"> with one row per document
type-specific parser: header-driven mapping, links classified
        ↓  server-side page links present?  -> every page is fetched (never only page 1)
export: Excel workbook (data sheet + sheet "Info") or CSV
        ↓
Saved as Downloads/DocLink/IREPS/CRN/IREPS_CRN_YYYY-MM-DD_HH-mm-ss.xlsx
      or Downloads/DocLink/IREPS/RNOTE/IREPS_RNOTE_YYYY-MM-DD_HH-mm-ss.xlsx
```

### The exact request (from the captured HAR; R-NOTE differs only in the criteria)

```
POST https://www.ireps.gov.in/epsn/searchPO.do
Content-Type: application/x-www-form-urlencoded

org.apache.struts.taglib.html.TOKEN=<fresh token from the showPage response>
&pageNo=1
&searchCriteria=CRN            <- RNOTE for Receipt Notes
&rly=-1
&poNo=
&icNo=
&dateFrom=
&dateTo=
&searchRange=1
&recordsPerPage=20
&submit=Show+Results
&searchCriteria=
```

`searchCriteria` appears twice because the IREPS form has a `<select
name="searchCriteria">` (`CRN` / `RNOTE` / …) **and** a trailing hidden
`<input name="searchCriteria">` that is empty. `buildSearchPoRequest()`
builds the body with `URLSearchParams.append()` in exactly this order.

Form semantics (labels confirmed from the page HTML):

| Field | Values |
|---|---|
| `searchCriteria` | `<option value="CRN">Consignment Receipt Note (CRN)</option>`, `<option value="RNOTE">Receipt Note (R-NOTE)</option>` (also PO, DRR, MA, Rej, CRC, Conversation - not implemented) |
| `rly` | `-1` = All, otherwise the railway code from `<select name="rly">` (read from the page, never hard-coded) |
| `searchRange` | `3` = PO No. (needs `poNo`), `2` = Select Date (`dateFrom`/`dateTo`, DD/MM/YYYY, ≤ 180 days), `1` = Last 180 Days (default, the captured request) |
| `pageNo` / `recordsPerPage` | `1` / `20` in the captured request; `recordsPerPage` is a free text field and the portal accepted `2000` in another capture |
| `poNo`, `icNo`, `dateFrom`, `dateTo` | empty unless the corresponding mode is used |

Public API:

```javascript
import { searchIrepsDocuments } from "./services/search-po/search-po-service.js";
import { searchCrn } from "./services/crn/crn-service.js";
import { searchRnote } from "./services/rnote/rnote-service.js";
import { buildCrnExport } from "./services/crn/crn-export.js";
import { buildRnoteExport } from "./services/rnote/rnote-export.js";

// generic (the service worker uses this; parseHtml is routed by criteria in the offscreen document)
const result = await searchIrepsDocuments({ criteria: "RNOTE", railway: "-1", pageNo: 1, recordsPerPage: 20 }, { parseHtml });
// -> { success: true, criteria: "RNOTE", documentType, search: { criteria, mode, railway, pageNo, recordsPerPage, pagesFetched },
//      filter, fetchedAt, recordCount, records, headerLabels, warnings, form, pagination }

// typed wrappers (default parser included)
await searchCrn({ poNo: "RR-PR-WC-2034-25-26-04" });                                        // searchCriteria=CRN, searchRange=3
await searchRnote({ dateFrom: "01/08/2026", dateTo: "31/08/2026", railway: "01" });         // searchCriteria=RNOTE, searchRange=2

const file = buildRnoteExport(result);                   // { bytes, mimeType, extension: "xlsx", recordCount, columnCount }
const csv = buildCrnExport(crnResult, { format: "csv" });
```

### CRN records and export

Parsed CRN record (values verbatim; `nil`, `NA`, `----` and empty cells → `null`):

```javascript
{
  index: 1, id: "crn-1",
  poNo: "RR-PR-WC-2034-25-26-04", poDate: "31/01/2026",
  challanNo: "SSE.LHB.LTT.WAR.FAIVELEY", challanDate: "12/09/2026",
  crnType: "Warranty Replacement", claimNo: "013833-26-10276",
  railway: "CR", poSerial: "143",
  crnNo: "013833-26-23416", crnDate: "12/09/2026", approvalDate: "18/09/2026", crnQty: "1",
  billClaimStatus: "Not For Payment",
  billRegNo: null, billRegSignDate: null, invoiceNo: null, invoiceDate: null,
  co6No: null, co6Date: null, co7No: null, co7Date: null,
  claimAmount: null, passedAmount: null, paymentOrReturnDate: null, returnReason: null,
  crnPdfUrl:   "https://www.ireps.gov.in/ireps/etender/ct/MMIS/CONS/2026/01/…/013833-26-23416_2.pdf",
  claimPdfUrl: "https://www.ireps.gov.in/ireps/etender/ct/MMIS/CRC/WAR/2026/01/…/013833-26-10276.pdf",
  billPdfUrl:  null,
  extra: {}
}
```

Sheet **CRN** (bold, frozen header with auto-filter), one row per CRN:

```
# | PO No. | PO Date | Challan No. | Challan Date | CRN Type | Claim No. | Rly | PO Sr | CRN No. | CRN Date |
Approval Date | CRN Qty | Bill Claim | Bill Reg No. | Bill Reg/Sign Date | Invoice No. | Invoice Date |
CO6 No. | CO6 Date | CO7 No. | CO7 Date | Claim Amount | Passed Amount | Payment / Return Date | Return Reason
```

The columns follow the captured IREPS table in order, like the portal's own
Export to Excel; the combined "CRN Type / Claim No." cell is split into two
columns. The document links IREPS embeds in the table (`crnPdfUrl`,
`claimPdfUrl`, `billPdfUrl`) stay on the parsed records but are not
exported.

### R-NOTE records and export (layout not captured yet)

What is confirmed: R-NOTE is `<option value="RNOTE">Receipt Note (R-NOTE)</option>`
of the same searchPOForm with the same controls, so the request side is
identical to CRN apart from the criteria. What is **not** captured yet is an
R-NOTE result page. The R-NOTE parser therefore assumes nothing about the
columns or the document link path:

* the result table is located by its header row (a "R-Note No." style column
  must exist), never by position;
* every column is kept verbatim in `rawColumns` (header label → text) so no
  data is lost while the real layout is confirmed;
* well-known labels are also mapped to typed fields;
* every anchor of a row is kept in `links` (text, title, absolute URL,
  column), and the R-NOTE document link is chosen from them by header context
  (an anchor in the R-Note No. column) or anchor text/title ("R-Note",
  "Receipt Note") - never by the CRN's `/MMIS/CONS/` rule, and never a
  Manage PO / bill / acknowledgement link.

```javascript
{
  index: 1, id: "rnote-1",
  poNo: "RR-PR-WC-1001-25-26-01", poDate: "31/01/2026", railway: "CR", poSerial: "143",
  rnoteNo: "RN-013801-26-40001", rnoteDate: "10/09/2026",
  challanNo: "…", challanDate: "05/09/2026", invoiceNo: "4471", invoiceDate: "02/09/2026",
  quantity: "12", status: "Accepted",
  documentUrl: "https://www.ireps.gov.in/ireps/etender/ct/…/RN-013801-26-40001.pdf",   // href exactly as returned
  documentLink: { text, title, url, column: "R-Note No." },
  links: [ { text, title, href, url, column, key }, … ],                                // every anchor of the row
  rawColumns: { "#": "1", "PO No.": "…", "R-Note No.": "…", … }                         // every page column
}
```

Sheet **R-NOTE**: the page's own column labels in page order (from
`rawColumns`, Action column dropped), then `R-Note Document Link` and
`Other Links`. `test/fixtures/rnote-results-page.html` is a clearly marked
*assumed* layout (CRN page frame + plausible R-NOTE columns, fake
`/ireps/etender/ct/MOCK/RNOTE/…` links) used by the mock and the tests.
When a real R-NOTE result page is captured, compare it with the fixture; the
parser should already cope, and `RNOTE_HEADER_MAP` in
`services/rnote/rnote-parser.js` is where new labels get their typed field.

Sheet **Info** (both types): document, source, retrieval time, filter,
record count, result pages fetched, and any parser warnings.

The workbook is written by `utils/xlsx-writer.js` (Office Open XML, inline
strings so a 14-digit PO number is not turned into `7.02E+13`) on top of
`utils/zip-writer.js` (ZIP, store method, CRC-32) - no library, no backend.
CSV output is UTF-8 with BOM and CRLF line ends.

### Pagination

The captured CRN response returned all 2,022 rows in a single page (the
table is paged client-side by DataTables; IREPS printed no server page links
even with `recordsPerPage=20`). The MA search in the same capture *was*
paginated server-side with links of the form
`postRequest('/epsn/searchPO.do?rly=-1&dateFrom=&dateTo=&pageNo=2&searchRange=1&poNo=&count=1720&recordsPerPage=20')`.
The shared layer handles both: `extractSearchPoPagination()` detects such
links, and `searchIrepsDocuments()` re-posts each page's parameters exactly
like the portal's `postRequest.js` does (no token) until every page is
fetched. A partial list is never exported silently: a failing page fails the
download.

### Error codes

| Code | When |
|---|---|
| `IREPS_SESSION_EXPIRED` | login / expired page at any step |
| `IREPS_SEARCH_PAGE_FAILED` | showPage request failed (network/HTTP) or the response is not the PO Search page |
| `IREPS_TOKEN_NOT_FOUND` | PO Search page without the TOKEN input |
| `UNSUPPORTED_IREPS_SEARCH_TYPE` | a criteria other than CRN / RNOTE was requested |
| `IREPS_CRN_SEARCH_FAILED` / `IREPS_RNOTE_SEARCH_FAILED` | search request failed (network/HTTP) |
| `IREPS_CRN_RESULTS_INVALID` / `IREPS_RNOTE_RESULTS_INVALID` | search response not recognised (after one fresh-token retry), IREPS error message, or a missing result page |
| `IREPS_CRN_NOT_FOUND` / `IREPS_RNOTE_NOT_FOUND` | zero records for the search (notice) |
| `IREPS_CRN_PARSE_FAILED` / `IREPS_RNOTE_PARSE_FAILED` | rows present but unreadable / parser crashed |
| `IREPS_INVALID_REQUEST` | bad options (missing PO number, invalid date range, page size) |
| `DOCUMENT_EXPORT_ERROR` | records retrieved but the file could not be built |
| `DOCUMENT_DOWNLOAD_ERROR` | file built but Chrome could not save it |

### Security

The PO Search flows follow the same rules as Bill Status: no cookie,
JSESSIONID or token is read, stored, logged or sent anywhere. The Struts
token exists only in local variables inside `searchIrepsDocuments()`. The
Recon Engine sender is not called for CRN or R-NOTE data.

---

## 13. MA copies download (Modification Advice)

MA is the third document type on the PO Search page (`searchCriteria=MA`)
and reuses the whole shared layer of section 12. The difference is what is
downloaded: not the result table, but the **MA PDF copies** that IREPS links
from each row, grouped by MA date.

### Flow

```
DocLink popup -> Download MA -> MA Date (default today) [or range / all], Railway, optional PO -> Search MAs
        ↓
POST /epsn/searchPO.do  searchParam=showPage           (session check + fresh Struts TOKEN)
POST /epsn/searchPO.do  searchCriteria=MA  rly=-1  searchRange=1  pageNo=1  recordsPerPage=2000  submit=Show Results
        ↓  HTML: <table id="table_id"> > <table id="dTbl2">, one <tr class="trPoRow"> per MA
parseMaSearchResults(): Sr. No. | Dept / Rly. Unit | PO No. | PO Date | PO_SR | MA No. | MA Date | Action(s)
        ↓  server page links present? -> every page is fetched
DocLink keeps the rows whose "MA Date" matches the selection and lists them
        ↓  user: Download Selected / Download All
GET <href of a[title="View/Download MA"]>   with the browser session, 3 at a time, verified as %PDF-
        ↓
Downloads/DocLink/IREPS/MA/<YYYY-MM-DD of the MA date>/MA_<PO-NO>_<MA-NO>.pdf
```

### The captured MA request

Identical to the CRN request of section 12 with `searchCriteria=MA`. The
capture shows the portal paginating MA server-side at `recordsPerPage=20`
(1,838 results, 92 pages of `postRequest(...)` links) **and** accepting
`recordsPerPage=2000` with all 1,838 rows in one response. DocLink therefore
sends 2000 for MA by default and still follows page links if any appear.

The IREPS "Select Date" filter is **not** used for the MA date selection,
because the capture does not show whether it filters by PO date or MA date.
DocLink searches "Last 180 Days" and filters the parsed rows by the MA Date
column itself (a PO number, when entered, is sent to IREPS as `searchRange=3`).

### Parsed MA record (values verbatim; `null`, `nil`, `NA`, `----` → null)

```javascript
{
  index: 1, id: "ma-1",
  serialNo: "1", railwayUnit: "HQ/NR",
  poNo: "07250369105448", poDate: "20/07/2026", poSerial: null,
  maNo: "007327", maDate: "18/09/2026", maDateKey: "2026-09-18",
  poPdfUrl: "https://www.ireps.gov.in/ireps/etender/pdfdocs/MMIS/PO/2026/03/07250369105448.pdf",         // PO document
  maPdfUrl: "https://www.ireps.gov.in/ireps/etender/pdfdocs/MMIS/PO/2026/03/07250369105448_007327.pdf",  // MA copy
  links: [ { text, title, href, url, column, key }, … ],                 // every anchor of the row
  rawColumns: { "Sr. No.": "1", "Dept / Rly. Unit": "HQ/NR", … }
}
```

Link detection: the MA copy is the anchor with `title="View/Download MA"`
(anywhere in the row); the PO document is the anchor in the PO No. cell or
the one titled "Click to View/Download PO". "Manage Your Purchase Order"
(`href="#"`) and the acknowledgement link (`javascript:`) are never
documents. Hrefs are used exactly as returned; the
`/pdfdocs/MMIS/PO/<year>/<month>/<PO>_<MA>.pdf` pattern only triggers a
warning when it does not match.

### Download

`document-downloader.js` performs `GET` with `credentials: "include"` on
the IREPS origin only and checks the `%PDF-` signature. A login/expired
page answered with HTTP 200 becomes `IREPS_SESSION_EXPIRED` ("Your IREPS
session has expired. Please log in again and retry the MA download."), any
other non-PDF `IREPS_MA_INVALID_PDF`; nothing that is not a PDF is saved.
Batches run 3 downloads at a time with Queued / Downloading / Completed /
Failed per MA; after a session expiry the remaining MAs are not attempted
and can be retried with **Retry failed downloads**. Files are named
`MA_<PO-NO>_<MA-NO>.pdf` (sanitised) because MA numbers repeat across POs,
and grouped in a folder per MA date.

### MA error codes

| Code | When |
|---|---|
| `IREPS_MA_SEARCH_FAILED` / `IREPS_MA_RESULTS_INVALID` / `IREPS_MA_PARSE_FAILED` | as for CRN (section 12) |
| `IREPS_MA_NOT_FOUND` | no MA matched the date selection (the message says how many IREPS returned) |
| `IREPS_MA_LINK_NOT_FOUND` | the row has no "View/Download MA" link, or it points outside IREPS |
| `IREPS_MA_DOWNLOAD_FAILED` | network error, HTTP ≠ 2xx, or Chrome could not save the file |
| `IREPS_MA_INVALID_PDF` | IREPS returned something that is not a PDF (and not a login page) |
| `IREPS_SESSION_EXPIRED` | login / expired page at any step, including a PDF request |
