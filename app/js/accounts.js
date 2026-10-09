// Account names, so the app can say "2033 Prepaid Rent - OneStory" rather than a bare "2033" when
// it explains where the GL put something. Built in from the chart of accounts as of October 2026;
// an uploaded chart of accounts (Acumatica's Chart of Accounts export) or trial balance replaces
// them (saved in the fa-config settings' accountNames, shared with the JE exports).

import { cellAt, text } from './xlsx-io.js';

const BUILT_IN = {
  1010: 'General Operating', 1012: 'Paypal Checking', 1013: 'Wise', 1015: 'Stripe Checking',
  1020: 'Cash - Pass Through Agency Gift', 1025: 'Petty Cash', 1030: 'NCF Giving Fund', 1040: 'Pangea Hedge',
  1060: 'KeyBank Money Market', 1061: 'KeyBank Checking', 1100: 'Cass - General Operating',
  1110: 'OneStory Marshall - Cass Operating', 1111: 'OneStory Marshall - Cass Savings',
  1120: 'Cass - Money Market', 1130: 'Cass - Incoming Wire Sweep', 1140: 'Cass - Outgoing Wire Sweep',
  1150: 'Cass - Certificate of Deposit', 1160: 'Cass - ICS Account', 1170: 'Investment Fund - Fidelity',
  1171: 'Investment Fund - Tschetter Group', 1200: 'Bank Transfer - Cash Clearing Account',
  1201: 'Cash in Transit', 1210: 'Accounts Receivable', 1211: 'Salary Advance Receivable',
  1220: 'Contributions Receivable', 1250: 'Book Sale Revenue Receivable', 1275: 'Prepaid Expenses',
  1300: 'Produced Videos', 1310: 'Video Amortization', 1320: 'App', 1321: 'App Amortization',
  1330: 'Website Domains', 1500: 'Inventory - Coffee Table Books', 1501: 'Inventory - Heaven & Earth',
  1502: 'Inventory -  USB sticks', 1503: 'Inventory - TShirts', 1504: 'Inventory - Posters',
  1505: 'Inventory - Poster Books', 1506: 'Inventory - Mugs', 1530: 'OneStory Marshall Building',
  1531: 'OneStory Land', 1532: 'OneStory Building Improvements', 1533: 'OneStory CIP', 1540: 'Equipment',
  1541: 'Equipment - A/D', 1550: 'Pre-paid rent Imago', 1551: '2019 Pre-Paid Rent',
  1552: 'Imago Facilities Improvement', 1553: 'Imago Facilities Improvement - A/D',
  1555: 'Office Space & Commons A', 1556: 'Office Space & Commons A - A/D', 1560: 'Recording Studio',
  1561: 'Recording Studio - A/D', 1570: 'Imago Kitchen Buildout LHI', 1571: 'Commons B - A/D',
  1572: 'Sound Stage', 1573: 'Sound Stage - A/D', 1574: 'West Conference Room Buildout',
  1575: 'West Conf Room - A/D', 1576: 'Room 202 - T.I.', 1577: 'Room 202 - A/D',
  1578: 'Room 202 - Prepaid Rent', 1580: 'Server - on site', 1581: 'Server on site - A/D',
  1600: 'Right of Use Asset (lease)', 1601: 'Accumulated Right of Use Amort', 2010: 'Accounts Payable',
  2020: 'Umpqua CC', 2030: 'KeyBank CC', 2031: 'Property Tax Payable - OneStory',
  2032: 'Rent Security Deposit - OneStory', 2033: 'Prepaid Rent - OneStory', 2040: 'Key2Purchase CC',
  2041: 'Agency Funds Payable', 2042: 'Sales Tax Payable', 2043: 'FSA Withholdings Payable', 2044: 'Na',
  2045: 'Cassbank CC', 2046: 'Divvy CC', 2050: 'Accrued Payroll', 2051: 'Accrued Contractor Payments',
  2052: 'Accrued Search Time & Other Current Liab.', 2055: 'Accrued 401(k)',
  2060: 'Restricted Deferred Revenue', 2100: 'Long-Term Lease Liability',
  2110: 'Long-Term Sabbatical Liability', 3001: 'Net Assets', 3031: 'Property Tax Payable - OneStory',
  3100: 'Net Assets Current', 3200: 'Net Assets Restricted - Temporarily', 4010: 'Checks',
  4012: 'Paypal Giving', 4015: 'Stripe Donations', 4017: 'Translation Support', 4018: 'Wire Donation',
  4020: 'Classroom Contribution', 4025: 'App Funding', 4030: 'Rental Income - OneStory Marshall',
  4050: 'Interest Income', 4060: 'Unrealized Gain (loss) on Investment', 4070: 'Rent Income',
  4075: 'Merchandise Sales', 4076: 'Ads Income', 4077: 'CC Rewards', 4080: 'Kickstarter (Coffee Table Book',
  4081: 'Coffee Table Book Sales', 4082: 'Poster Sales', 4083: 'Thumb Drive Sales',
  4084: 'Poster Book Sales', 4085: 'Mug Sales', 4090: 'Cash Discount Account', 4095: 'Adsense',
  4099: 'Video Sales', 7210: 'Payroll', 7211: 'Payroll Advance Exp', 7215: 'Payroll Tax',
  7220: 'Health/Dental', 7225: '401(k) Cont', 7500: 'Top Level Demand', 7625: 'Contractors',
  7630: 'Strategic Partnership & Program', 7676: 'Accidental Credit Card Purchase', 7725: 'Discretionary',
  7766: 'Incomplete Needs Reclass', 7999: 'Depreciation', 8010: 'Read Scripture Illustration',
  8013: 'Staff Hospitality', 8014: 'Staff Care', 8015: 'Learning Stipend', 8016: 'Retreats',
  8017: 'Camp Vocation', 8020: 'Flagship', 8021: 'Outside Studio', 8022: 'Flagship', 8023: 'App Development',
  8024: 'Data Development', 8025: 'People Equipping Staff', 8026: 'Sharing Non', 8027: 'Outreach Materials',
  8028: 'R&D', 8029: 'Translation', 8030: 'Software', 8031: 'Website Development', 8032: 'Board',
  8033: 'Maintenance (prior Content Writing)', 8034: 'Brotherhood Insurance', 8035: 'Rent',
  8036: 'Events and Conferences', 8037: 'Utilities', 8038: 'Gifts', 8039: 'Facility Improvement',
  8040: 'Sharing English', 8041: 'Imago Facility Improvements', 8042: 'Communications',
  8043: 'Sponsors/Convenings', 8044: 'Monday Lunches', 8045: 'Samples - Merchandise',
  8046: 'Research Cohort', 8047: 'Meals and Entertainment', 8048: 'Cleaning', 8049: 'Equipment',
  8050: 'Furniture', 8051: 'Office Supplies', 8052: 'Books', 8053: 'Moving Cost',
  8054: 'Mobile Phone Reimburse', 8055: 'CPA Fees', 8056: 'Parking', 8057: 'Prayer Support',
  8058: 'Lawyer Fees', 8059: 'Benevolence', 8060: 'Advancement/Development', 8061: 'Generosity Match',
  8062: 'Learn.Bible Platform', 8063: 'Copyright', 8064: 'Onboarding & Offboarding',
  8065: 'Sales Use Tax Expense', 8070: 'Bank Fees', 8115: 'Writer', 8119: 'Annual Production',
  8120: 'Editor', 8121: 'Illustration', 8124: 'Hosting/Lodging', 8125: 'Travel Flight', 8126: 'Travel Hotel',
  8127: 'Travel Ground Transportation', 8128: 'Travel Meals', 8150: 'Postage', 8262: 'Web & Data Hosting',
  8264: 'Web Design', 8590: 'CC Fees', 8600: '401K Fee’s', 8700: 'Miscellaneous', 8766: 'Damaged Inventory',
  8800: 'Video Cap P/T', 8801: 'App Capitalization P/T', 8805: 'Video Amort', 8806: 'App Amortization',
  8990: 'Gain/Loss on Disposal of Assets', 8998: 'Interest Expense (Lease)', 8999: 'Investment Loss/(Gain)',
  9000: 'Coffee Table Book', 9001: 'Heaven & Earth', 9002: 'Posters', 9003: 'USB Sticks',
  9004: 'Poster Books', 9005: 'Miir Cup', 9010: 'Apparel', 9011: 'Accessories', 9012: 'Samples',
  9013: 'Rite in the Rain Notebook', 9014: 'Packaging', 9015: 'Stickers', 9050: 'Shipping',
};

let names = { ...BUILT_IN };

// Called with the saved names once a page has loaded its settings.
export function setAccountNames(saved = {}) {
  names = { ...BUILT_IN, ...Object.fromEntries(Object.entries(saved).filter(([, v]) => v)) };
}

export const accountTitle = (a) => names[a] || '';
// "2033 Prepaid Rent - OneStory", or the number alone for an account the chart doesn't name.
export const acct = (a) => `${a} ${names[a] || ''}`.trim();

// Acumatica's Chart of Accounts export: a header row with Account and Description, one row per
// account. { '2033': 'Prepaid Rent - OneStory', … }
export function parseChartOfAccounts(XLSX, wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws?.['!ref']) throw new Error('This sheet is empty.');
  const range = XLSX.utils.decode_range(ws['!ref']);
  const at = (r, c) => text(cellAt(XLSX, ws, r, c));
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 20); r++) {
    let ac = -1, dc = -1;
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (/^account$/i.test(at(r, c))) ac = c;
      if (/^description$/i.test(at(r, c))) dc = c;
    }
    if (ac < 0 || dc < 0) continue;
    const out = {};
    for (let rr = r + 1; rr <= range.e.r; rr++) {
      const a = at(rr, ac), d = at(rr, dc);
      if (/^\d{3,6}$/.test(a) && d) out[a] = d;
    }
    if (!Object.keys(out).length) break;
    return out;
  }
  throw new Error('This doesn’t look like a Chart of Accounts export (no Account / Description header).');
}
