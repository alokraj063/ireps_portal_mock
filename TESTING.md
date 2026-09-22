# DocLink — Testing Guide

This guide explains how to test the DocLink Chrome extension step by step.
You do **not** need access to the real IREPS portal for Parts A to C; a local
mock portal is included. Part D covers the real portal once access is
available.

Folder used throughout:

```
/Users/I36260027/Desktop/DocLink Download/doclink-extension
```

Requirements: Google Chrome 116 or newer, Node.js 18 or newer.

---

## Part A — Automated tests (about 10 seconds, no browser setup)

Open Terminal and run:

```bash
cd "/Users/I36260027/Desktop/DocLink Download/doclink-extension"

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --allow-file-access-from-files --virtual-time-budget=20000 \
  --dump-dom "file://$PWD/test/run-tests.html" | grep -o 'DOCLINK_TESTS[^<]*'
```

Expected output:

```
DOCLINK_TESTS 100/100 passed
```

These tests cover the real `viewBills.do` flow with a fake IREPS (empty POST →
token → Show Results → parsed bills, session expired, token missing, HTTP 500,
no records, token retry), form extraction (TOKEN, 35 zones, searchRange
controls, DOM and regex paths), request building (Last 90 Days, date range,
railway zone, 180-day validation), the block parser (REGISTERED / RETURNED /
PASSED / PAYMENT MADE, Reason For Return, Recovery Details, `----` and `NA`,
repeated `table#table_id`, no de-duplication, validation warnings), the legacy
table parser, session detection, the HTML sanitiser, log redaction, filename
format and the PDF writer.

The CRN tests (`test/crn-tests.js`) cover the shared `searchPO.do` flow with a fake
IREPS (`searchParam=showPage` → token → CRN "Show Results" with the exact
captured body including the duplicate `searchCriteria`, session expired,
token missing, HTTP 500, fresh-token retry, no CRNs, IREPS error message),
PO Search form extraction (TOKEN, 41 railways, searchCriteria options,
searchRange labels, DOM and regex paths), request building (PO number / date
range / railway / page size validation, page-link requests), the CRN parser
(Fresh Supply, Warranty Replacement, Warranty & Re-inspection, Not For
Payment / Signed / Paid / CO6 Number Allotted, rows with and without bill
details, `/MMIS/CONS/` vs `/MMIS/CRC/WAR/` vs `/sbill/` links, header order
independence, rows without a CRN number), pagination (25 CRNs over 3
server-side pages), the ZIP and .xlsx writers (package parts, well-formed
XML, escaping, frozen header, auto-filter), the CSV writer and the CRN export
(column set, verbatim values, Info sheet, complete paginated result).

The R-NOTE tests (`test/rnote-tests.js`) cover the same shared flow with
`searchCriteria=RNOTE` (endpoint, POST, fresh token, railway / date / PO /
pageNo / recordsPerPage preserved, unsupported criteria rejected), the
layout-agnostic R-NOTE parser on the assumed fixture (typed fields,
`rawColumns`, links, document link taken from the row - never the CRN path,
unrelated links ignored, missing link handled, columns in any order, the CRN
table not mistaken for an R-NOTE table and vice versa), login-page
detection, the R-NOTE error codes, pagination (25 R-NOTEs over 3 pages) and
the R-NOTE export (page columns + link columns, xlsx sheet "R-NOTE", csv).

To look at a sample PDF produced by the PDF engine:

```bash
node test/make-sample-pdf.mjs ~/Desktop/DocLink-sample.pdf
open ~/Desktop/DocLink-sample.pdf
```

---

## Part B — Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the folder `doclink-extension`.
5. DocLink appears in the list with no errors.
6. Click the puzzle-piece icon in the toolbar and **pin** DocLink.

Whenever you change a file or switch targets (Part C), click the **reload**
icon on the DocLink card in `chrome://extensions`.

---

## Part C — Full workflow test with the mock IREPS portal

The mock portal serves the same page path as IREPS
(`/epsn/admin/viewBills.do`), answers the empty POST with the Bill Status
form and a fresh fake Struts token, validates the "Show Results" POST exactly
like the real form (all seven fields, single-use token, date rules), simulates
the security-key login by issuing the same `JSESSIONID` (+ F5 `TS01b82797`)
cookies the real portal sets (random values, remembered server-side; a cookie it
did not issue, or one expired via `/mock/session/expire`, gets the login page
like the real portal), and can be switched to different
scenarios from its home page.

### C1. Start the mock portal

Terminal 1 (leave it running):

```bash
cd "/Users/I36260027/Desktop/DocLink Download/doclink-extension"
node test/mock/mock-ireps-server.mjs
```

You should see:

```
[mock-ireps] listening on http://localhost:8765  (scenario: auto)
```

### C2. Point DocLink at the mock portal

Terminal 2:

```bash
cd "/Users/I36260027/Desktop/DocLink Download/doclink-extension"
node test/mock/switch-target.mjs mock
```

This changes only two things: the base URL in `services/ireps-api.js` and
the host permission in `manifest.json`.

Then go to `chrome://extensions` and click **reload** on DocLink.

### C3. Test: logged out (Acceptance Test 2)

1. Open a new tab at http://localhost:8765/ — it shows the IREPS-style login page
   (User Id / Password are decorative; the real portal uses a security key).
2. Click the DocLink toolbar icon.
3. Header should show **IREPS ● Login Required**.
4. Click **Download Bill Status**.

Expected:

- The popup shows **IREPS Login Required** with the four instructions.
- No PDF is created in `Downloads/DocLink/IREPS/`.
- Clicking **Open IREPS** opens the mock home page in a new tab.

### C4. Test: logged in, successful download (Acceptance Test 1)

1. On the mock login page click **Login with security key (simulated)**.
   The Bidder Home Page opens (IREPS look: header, left menu with **View Bills
   Status** and **View & Manage Contracts**) with a green "Logged in" notice. The browser now
   holds a `JSESSIONID` cookie shaped like the real portal's; DocLink never
   reads it, Chrome attaches it to every DocLink request.
2. Open DocLink. Header shows **IREPS ● Connected**.
3. Click **Download Bill Status**.

Expected:

- Stages appear in order: Checking IREPS session → Retrieving Bill Status →
  Processing bills → Generating PDF → Downloading.
- Popup shows **✓ Bill Status downloaded successfully**, "Records found: 6",
  "Search: Last 90 Days, All Zones" and the filename, e.g.
  `IREPS_Bill_Status_2026-09-15_14-05-12.pdf`.
- The mock terminal shows two requests: `POST viewBills.do page` followed by
  `POST viewBills.do search … zone=-1 searchRange=1`.
- Footer shows "Last download" time and "Status: Downloaded successfully".
- The PDF exists in `Downloads/DocLink/IREPS/`. **Show in folder** opens it.

Open the PDF and check:

| Check | Expected |
|---|---|
| Heading | "IREPS BILL STATUS" with Source / Retrieved / Filter "Last 90 Days, All Zones" / Records 6 |
| Bill #1 (REGISTERED) | CO7 No, CO7 Date and Payment Advice Date show "-" (IREPS printed `----` / `NA`) (Acceptance Test 6) |
| Bill #2 (RETURNED) | Bill Number "-", Reason for Return "#VARY IN SCHEDULE B- …" |
| Bill #3 (PAYMENT MADE) | CO7 filled, Recovery Details on three lines (GST TDS DEDUCTION / INCOME TAX / OTHER CHARGES) (Acceptance Test 7) |
| Bill #3 and Bill #6 | Same Bill Number 9001000103 with different statuses — both present, nothing de-duplicated |
| Text | Selectable and searchable (Cmd+F for "13010326020001") |

### C4b. Test: search options

Open **Search options** in the popup (above the Download button).

| Option | Expected |
|---|---|
| Railway Zone = ICF (list comes from the IREPS page, 35 entries) | Mock log shows `zone=13 searchRange=3`; PDF filter "Railway Zone: ICF" |
| Select Date, From 01/08/2026 To 31/08/2026 | Mock log shows `searchRange=2 dateFrom=01/08/2026 dateTo=31/08/2026` |
| Select Date, range longer than 180 days | Popup shows **Invalid search options** before any request is sent |

### C5. Test: download twice (Acceptance Test 8)

Click **Download Bill Status** again.

Expected: a second PDF with a different timestamp. The first file is not
overwritten. (Two downloads within the same second get " (1)" appended.)

### C6. Test: other scenarios (Acceptance Tests 3, 4, 5)

Open the mock control panel at http://localhost:8765/mock/ (also linked from the
foot of every mock page), click a scenario link, then open DocLink and click
**Download Bill Status** (or **Try again**).

| Scenario link | Expected popup result | PDF created? |
|---|---|---|
| `large` | "Records found: 300". PDF contains Bill #1 … Bill #300 with no truncation (Test 5) | Yes |
| `expired` | **IREPS login required** view (Test 3) | No |
| `login` | **IREPS login required** view | No |
| `redirect-login` | **IREPS login required** view (302 to the login page) | No |
| `no-records` | **No Bill Records Found** notice | No |
| `token-missing` | **IREPS form token not found** | No |
| `token-invalid` | **Unable to recognise the IREPS response** (DocLink retried once with a fresh token; mock log shows two rejected searches) | No |
| `http500` | **Unable to retrieve Bill Status** — "…(IREPS returned HTTP 500)…". Button is usable again (Test 4) | No |
| `slow` | Progress stays on "Retrieving Bill Status…" about 6 seconds, then completes | Yes |
| `legacy` | Old single-table layout still downloads (3 records) | Yes |
| `auto` | Back to normal cookie-driven behaviour | — |
| `/mock/session/expire` (link on the home page) | Session timed out server-side while the browser still holds the cookie: **IREPS login required** view; log in again on the mock to continue | No |

Network failure: stop the mock server with **Ctrl+C** in Terminal 1, then
click Download. Expected: **Unable to retrieve Bill Status** — "…(IREPS could
not be reached). Check your network connection and try again." Restart the
server afterwards.

### C7. Test: popup closed during a download

1. Set scenario `slow`, click **Download Bill Status**, then click anywhere
   outside the popup to close it.
2. Wait 15 seconds (two slow requests) and open the popup again.

Expected: the popup shows **✓ Bill Status downloaded successfully** and the
PDF was saved even though the popup was closed.

### C8. Test: printable preview

After any successful download, click **Open printable preview**.

Expected: a new tab with the same bills rendered as cards. **Download PDF**
saves another copy; **Print / Save as PDF** opens Chrome's print dialog.

### C9. Test: upload placeholder

1. In the popup click **Upload Document**.
2. Choose a Source, pick any file, choose a Document Type, click **Upload**.

Expected: "Upload integration will be implemented in Phase 2." No network
request is made.

### C9b. CRN download with the mock portal

The mock also serves the CRN workflow: `POST /epsn/searchPO.do` with
`searchParam=showPage` returns the PO Search page with a fresh token, and the
CRN search (`searchCriteria=CRN`) is validated exactly like the real form
(all fields, duplicate `searchCriteria`, single-use token) and answered with
the CRN result table.

1. Make sure the mock shows "Logged in" and scenario `auto`.
2. Open DocLink and click **Download CRN** on the *Download IREPS CRN* card.
   The header shows **Connected** and the Railway list is filled from the
   mock's PO Search page (All, Banaras Locomotive Works, … 41 entries).
3. Click **Download CRN** (defaults: All, Last 180 Days, Excel).

Expected:

- Steps run through: Checking IREPS session → Searching CRNs → Reading CRN
  records → Building the export file → Downloading, then
  **✓ CRN export downloaded successfully**, "CRN records exported: 8 (Excel
  (.xlsx))", "Search: Last 180 Days, All Railways" and the filename, e.g.
  `IREPS_CRN_2026-09-21_12-30-42.xlsx`.
- Mock terminal: `POST searchPO.do page` followed by
  `POST searchPO.do search  criteria=CRN| rly=-1 searchRange=1 pageNo=1 recordsPerPage=20`.
- The file is in `Downloads/DocLink/IREPS/CRN/`; **Show in folder** opens it.

Open the workbook and check:

| Check | Expected |
|---|---|
| Sheet "CRN" | Bold, frozen header row with a filter; 8 data rows; 26 columns from `#` to `Return Reason` (no link columns, like the portal's export) |
| Row 1 | RR-PR-WC-1001-25-26-01, Warranty Replacement, Claim No. 013801-26-10001, CR, CRN No. 013801-26-20001, Not For Payment |
| Row 3 | Fresh Supply, Signed, Bill Reg No. 9001000203, Claim Amount 125000.8 (text, exactly as printed) |
| Row 6 | Challan No. empty (IREPS printed `nil`), Return Reason "# PO Modification Required. Kindly attach M.A. for DP extension." |
| Sheet "Info" | Source, Retrieved, Filter, Records 8, Result pages fetched 1, a warning for row 8 |

4. Search options → File format = CSV (.csv) → **Download CRN**: a `.csv`
   with the same 26 columns and 8 rows (UTF-8, opens in Excel).
5. Search options: Railway = Central Railway → mock log `rly=01`, 2 records.
   PO Number `LR-SCR-2026-0003` → `searchRange=3`, 1 record. From/To dates
   inside 180 days → `searchRange=2`. A range over 180 days is rejected in
   the popup before any request.

| Scenario link | Then | Expected |
|---|---|---|
| `crn-paged` | Download CRN | Mock log shows the search followed by two page-link POSTs (`pageNo=2`, `pageNo=3`, no token); "CRN records exported: 47 across 3 result pages"; the workbook has 47 rows |
| `crn-large` | Download CRN | 300 rows in the workbook, `#` runs 1…300 |
| `no-records` | Download CRN | **No CRNs Found** notice; no file |
| `expired` / `login` | Download CRN | **IREPS login required** view; no request beyond the first |
| `token-missing` | Download CRN | **IREPS form token not found** |
| `token-invalid` | Download CRN | **Unable to recognise the CRN results** (two rejected searches in the mock log = one retry) |
| `http500` | Download CRN | **Unable to open IREPS PO Search — (IREPS returned HTTP 500)** |
| `slow` | Download CRN | Progress stays on "Searching CRNs…" about 12 seconds, then completes |
| Logged out (click Logout on the mock) | Download CRN | **IREPS login required**; no file |

6. Close the popup during a `slow` **Download CRN** and reopen it: the CRN
   view is restored with the progress, and the file is saved even though
   the popup was closed.

### C9c. R-NOTE download with the mock portal

R-NOTE uses the same PO Search flow; the mock answers `searchCriteria=RNOTE`
with an **assumed** R-NOTE table (the real layout is not captured yet):
`#, PO No., PO Date, Rly, PO Sr, R-Note No., R-Note Date, Challan No.,
Challan Date, Invoice No., Invoice Date, Qty Received, Status, Action`, with
fake document links under `/ireps/etender/ct/MOCK/RNOTE/…`.

1. Logged in on the mock, scenario `auto`. Open DocLink → **Download R-NOTE**
   on the *Download IREPS R-NOTE* card; the view title reads **IREPS R-NOTE
   Download** and the Railway list is filled.
2. Click **Download R-NOTE**.

Expected:

- Steps "Checking IREPS session → Searching R-NOTEs → Reading R-NOTE
  records → Building the export file → Downloading", then **✓ R-NOTE export
  downloaded successfully**, "R-NOTE records exported: 3 (Excel (.xlsx))".
- Mock terminal: `POST searchPO.do page` then
  `POST searchPO.do search  criteria=RNOTE| rly=-1 searchRange=1 pageNo=1 recordsPerPage=20`.
- `Downloads/DocLink/IREPS/RNOTE/IREPS_RNOTE_<timestamp>.xlsx`: sheet
  "R-NOTE" with 3 rows and 15 columns (the 13 page columns, then *R-Note
  Document Link* and *Other Links*). Row 1: RN-013801-26-40001, CR, Accepted,
  document link filled. Row 2: bill link listed under *Other Links*, not as
  the document. Row 3: RN-013803-26-40003, Rejected, document link empty,
  and a warning on the "Info" sheet.
3. The CRN scenarios of C9b (`crn-paged`, `crn-large`, `no-records`,
   `expired`, `token-invalid`, `http500`, `slow`) behave the same for
   R-NOTE (`crn-paged` → "47 across 3 result pages", `crn-large` → 120 rows).
4. Start a `slow` R-NOTE download, go **Back**, open **Download CRN** and
   click **Download CRN**: **Download Already Running** is shown until the
   R-NOTE job finishes (one PO Search job at a time).

### C9d. MA copies with the mock portal

The mock answers `searchCriteria=MA` with an MA table modelled on the real
capture. In scenario `auto` it generates 14 MAs dated today, yesterday and
the two days before (so the popup's default "today" finds some), with PO
links `/mock/po/<PO>.pdf` and MA links `/mock/ma/<PO>_<MA>.pdf`
(title="View/Download MA"). Every 9th MA has no MA link.

1. Logged in on the mock, scenario `auto`. Open DocLink → **Download MA**.
   The view shows *MA Date: Single date* with today's date preselected and
   the Railway list filled.
2. Click **Search MAs**.

Expected: "MA Results (N of 14)" with only today's MAs, each showing MA
number, PO, unit, PO date and MA date. Mock log:
`POST searchPO.do search  criteria=MA| rly=-1 searchRange=1 pageNo=1 recordsPerPage=2000`.

3. Tick two MAs → **Download Selected (2)**: chips go Queued → Downloading →
   Completed; "✓ 2 MA copies downloaded"; files
   `MA_<PO>_<MA>.pdf` in `Downloads\DocLink\IREPS\MA\<today YYYY-MM-DD>\`.
   Each PDF opens and reads "MODIFICATION ADVICE".
4. **Download All**: all of today's MAs; an MA without a link shows Failed
   with the tooltip "MA copy link not found".
5. Date range covering the last 4 days → 14 results; *All (Last 180 Days)*
   → 14; a date with no MA → **No MA copies found** with the count IREPS
   returned.

| Scenario link | Then | Expected |
|---|---|---|
| `crn-large` | Search MAs (All) | 200 MAs, Download All runs 3 at a time |
| `ma-pdf-login` | Download All | First PDF fails with the session message, the rest are not attempted; **IREPS session expired — Please log in again and retry the MA download.** and **Retry failed downloads** |
| `ma-pdf-404` | Download All | Every MA Failed, tooltip "IREPS returned HTTP 404"; nothing saved |
| `expired` / `login` | Search MAs | **IREPS login required** view |
| `http500` | Search MAs | **Unable to open IREPS PO Search** |

6. Close the popup during a Download All and reopen it: the MA view is
   restored with live chips.

### C10. Switch back to the real portal

When finished with the mock:

```bash
cd "/Users/I36260027/Desktop/DocLink Download/doclink-extension"
node test/mock/switch-target.mjs real
```

Then reload DocLink on `chrome://extensions`. Verify with:

```bash
node test/mock/switch-target.mjs status
# baseUrl: https://www.ireps.gov.in
# host_permissions: ["https://www.ireps.gov.in/*"]
```

---

## Part D — Test with the real IREPS portal (when access is available)

1. Point DocLink at the real portal:

   ```bash
   cd "/Users/I36260027/Desktop/DocLink Download/doclink-extension"
   node test/mock/switch-target.mjs real
   node test/mock/switch-target.mjs status
   # baseUrl: https://www.ireps.gov.in
   # host_permissions: ["https://www.ireps.gov.in/*"]
   ```

   Then reload DocLink on `chrome://extensions`. Nothing else changes: the
   path `/epsn/admin/viewBills.do`, the form fields and the parser are the
   same as for the mock.
2. Open https://www.ireps.gov.in/ and log in with your security key as usual.
3. Open DocLink. Header should show **IREPS ● Connected** and the Railway
   Zone list under **Search options** should contain the real zones (All,
   BLW, CLW, … WR).
4. Click **Download Bill Status** (default: Last 90 Days, All Zones).
5. In the service-worker console you should see two requests:

   ```
   [DocLink] IREPS request started {method: "POST", path: "/epsn/admin/viewBills.do", bodyBytes: 0}
   [DocLink] Response status: 200 {htmlBytes: 6864525, …}
   [DocLink] IREPS request started {method: "POST", path: "/epsn/admin/viewBills.do", bodyBytes: 1xx}
   [DocLink] Response status: 200 …
   [DocLink] Bills parsed: 2129 {structure: "blocks", blocks: 2129, skipped: 0}
   ```
6. Compare the PDF against the IREPS Bill Status screen (or the portal's own
   "Download as Excel"):
   - the record count equals the number of bill blocks on the page,
   - Contract No, Bill Number, CO6/CO7, amounts and dates match exactly,
   - `----` / `NA` show as "-",
   - RETURNED bills carry their Reason For Return, PAYMENT MADE bills their
     Recovery Details lines.
7. Try **Search options** → Railway Zone = one zone, and Select Date with a
   range inside 180 days; compare with the same search on the portal.
8. Log out of IREPS, click Download again: expect **IREPS login required**
   and no PDF.
9. CRN: open **Download IREPS CRN → Download CRN**. The service-worker
   console shows `POST /epsn/searchPO.do` (bodyBytes 20 =
   `searchParam=showPage`) followed by `POST /epsn/searchPO.do`
   (bodyBytes ≈ 190) and `CRNs parsed: N`. N must equal the "Showing 1 to
   10 of N entries" count under the portal's own CRN result table (2,022 in
   the capture). Compare the workbook with the portal's **Export to Excel**
   file: same rows, same values (DocLink additionally splits CRN Type /
   Claim No. into two columns).
10. R-NOTE: open **Download IREPS R-NOTE → Download R-NOTE**. The console
    shows the same two `POST /epsn/searchPO.do` requests and
    `RNOTE records parsed: N`. Compare the workbook with the portal's
    PO Search → Receipt Note (R-NOTE) table and its Export to Excel. Because
    the R-NOTE layout was never captured, check the column headers and the
    *R-Note Document Link* column first; if a column is missing or the link
    is wrong, save the result page (HTML only, TOKEN removed) so the R-NOTE
    header map (`services/rnote/rnote-parser.js`) and the fixture can be
    aligned. **Unable to read the R-NOTE records** means no "R-Note No."
    style column was recognised.
11. MA: open **Download MA**, keep today's date, **Search MAs**. The console
    shows the two `POST /epsn/searchPO.do` requests (the second with
    `recordsPerPage=2000`) and `MA records parsed: N` where N must equal
    "Total N result(s)" on the portal's MA search. The list must contain
    exactly the MAs whose *MA Date* column reads today. Tick one and
    **Download Selected (1)**: the saved `MA_<PO>_<MA>.pdf` must be the same
    document the portal opens from that row's "View/Download MA" icon (not
    the PO PDF opened from the PO number). If it fails with **MA copy not
    valid**, capture a HAR of clicking that icon on the portal.

If the popup shows **Unable to recognise the IREPS response** on the real
portal, save the IREPS page (right-click → Save As → "Webpage, HTML Only"),
remove the TOKEN value, and share it so the detection in
`services/session-service.js` / the parser in `services/bill-parser.js` can be
adjusted. **IREPS form token not found** means the page no longer carries
`org.apache.struts.taglib.html.TOKEN` inside `vendorPartyCodeForm`.

---

## Where to look when something fails

- **"DocLink Needs a Reload"** (or, before 1.1.0, a bare "Something Went
  Wrong") right after Search MAs: Chrome is still running an old background
  service worker. Popup pages are read from disk every time they open, but
  the service worker is cached until the extension is reloaded, so an old
  worker does not answer the new MA messages. Click **reload** on the
  DocLink card in `chrome://extensions` and retry. "Something Went Wrong"
  now shows the underlying error in brackets for genuine failures.
- The MA search reached the mock only if the mock terminal prints
  `POST searchPO.do search ... criteria=MA`; a page-only line means the
  extension stopped before submitting the search.
- `chrome://extensions` → DocLink card → **Errors** button (load-time
  errors) and **service worker** link (runtime console).
- The service worker console prints lines such as:

  ```
  [DocLink] Checking IREPS session
  [DocLink] IREPS request started {method: "POST", path: "/epsn/admin/viewBills.do", bodyBytes: 0}
  [DocLink] Response status: 200 {htmlBytes: …}
  [DocLink] IREPS request started {method: "POST", path: "/epsn/admin/viewBills.do", bodyBytes: 1xx}
  [DocLink] Bills parsed: 6 {structure: "blocks", blocks: 6, skipped: 0}
  [DocLink] Download complete
  ```

  Cookies, session ids and the Struts token are never printed; the logger
  redacts them automatically.
- Popup console: right-click inside the popup → **Inspect**.
- Downloads: `chrome://downloads` shows whether Chrome blocked or
  interrupted the file.

---

## Acceptance checklist

| # | Test | How | Pass? |
|---|---|---|---|
| 1 | Logged in → PDF downloaded | C4 / D | ☐ |
| 2 | Logged out → "IREPS Login Required", no PDF | C3 | ☐ |
| 3 | Session expired → recognised, no login page saved as PDF | C6 `expired` | ☐ |
| 4 | HTTP error → meaningful message, extension still usable | C6 `http500` | ☐ |
| 5 | Very large Bill Status → all records in PDF | C6 `large` | ☐ |
| 6 | Missing fields → "-" shown, no crash | C4 Bill #2 | ☐ |
| 7 | Long Recovery Details → wraps, nothing clipped | C4 Bill #2, `large` bills 5, 10, … | ☐ |
| 8 | Download twice → two separate files | C5 | ☐ |
| 9 | CRN: search → complete result table saved as .xlsx (or .csv) | C9b / D9 | ☐ |
| 10 | CRN: logged out / expired → login view, no file | C9b `expired` | ☐ |
| 11 | CRN: paginated results → every page in the workbook | C9b `crn-paged` | ☐ |
| 12 | R-NOTE: search → result table saved as .xlsx with page columns + document links | C9c / D10 | ☐ |
| 13 | MA: today's MAs listed, MA copies (not PO PDFs) saved under the date folder | C9d / D11 | ☐ |
| 14 | MA: session expiry during PDF download → session message, nothing saved as .pdf | C9d `ma-pdf-login` | ☐ |
