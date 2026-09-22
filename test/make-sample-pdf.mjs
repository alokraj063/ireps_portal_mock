/**
 * Node helper: parse the sample fixture (via a tiny DOM shim is not
 * available in Node, so we build the parsed result directly) and write a
 * sample PDF for visual inspection.
 *
 *   node test/make-sample-pdf.mjs /path/to/out.pdf
 */

import { writeFileSync } from "node:fs";
import { generateBillStatusPdf } from "../services/pdf-service.js";
import { createEmptyBill } from "../services/bill-parser.js";
import { formatDisplayTimestamp } from "../utils/filename.js";

const out = process.argv[2] || "sample.pdf";

const bills = [];
const base = {
  contractNo: "NR/STORES/2026/0451",
  contractDate: "12/03/2026",
  billNumber: "INV-2026-118",
  billDate: "02/07/2026",
  zone: "NR",
  partyName: "JOULES TO WATTS BUSINESS SOLUTIONS PVT LTD",
  partyCode: "V-118822",
  status: "Passed & Paid",
  billAmount: "12,45,600.00",
  passedAmount: "12,20,000.00",
  deductedAmount: "25,600.00",
  netAmount: "12,20,000.00",
  co6No: "CO6/NR/4521",
  co6Date: "05/07/2026",
  co7No: "CO7/NR/8891",
  co7Date: "10/07/2026",
  paymentAdviceDate: "14/07/2026",
  accountingUnit: "FA&CAO/NR/DELHI",
  recoveryDetails: "LD @ 0.5% for delayed supply: 6,228.00\nIncome Tax TDS: 12,456.00\nSecurity Deposit: 6,916.00",
  reasonForReturn: null
};
for (let i = 1; i <= 7; i++) {
  const bill = Object.assign(createEmptyBill(), base, { index: i, billNumber: `INV-2026-${117 + i}` });
  if (i === 2) {
    Object.assign(bill, {
      status: "Returned",
      passedAmount: null,
      deductedAmount: null,
      netAmount: null,
      co7No: null,
      co7Date: null,
      paymentAdviceDate: null,
      recoveryDetails: null,
      reasonForReturn:
        "Inspection certificate not attached. Please resubmit the bill with RITES inspection certificate and consignee receipt note (CRN) duly signed by the consignee. Bill returned vide letter no. NR/ACC/2026/771 dated 25/07/2026."
    });
  }
  if (i === 3) {
    bill.billAmount = "₹ 78,500.00";
    bill.status = "Under Process";
    bill.recoveryDetails = "Very long recovery detail line with amount 1,234.56 and reference NR/REC/2026/0001. ".repeat(60);
    bill.extra = { "Cheque No": "CHQ-000771" };
  }
  bills.push(bill);
}

const now = new Date(2026, 8, 15, 12, 30, 42);
const result = {
  title: "IREPS Bill Status",
  generatedAt: now.toISOString(),
  retrievedAt: formatDisplayTimestamp(now),
  source: "IREPS",
  sourceUrl: null,
  filter: "Last 90 Days",
  recordCount: bills.length,
  bills,
  extraColumns: ["Cheque No"],
  structure: "table",
  pageMessage: null,
  warnings: [],
  printableHtml: ""
};

const pdf = await generateBillStatusPdf(result);
writeFileSync(out, pdf.bytes);
console.log(`wrote ${out}: ${pdf.bytes.length} bytes, ${pdf.pageCount} pages`);
