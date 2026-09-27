// Works out what an uploaded file is and parses it. Everything is read in the browser.

import { pdfLines } from './pdf-text.js';
import { looksLikeCass, parseCassStatement } from './poc/cass.js';
import { detectIntrafi, parseCdarsStatement, parseIcsStatement, parseIntrafiExport } from './cd/intrafi.js';
import { looksLikeStripeMonthly, parseStripeMonthly } from './poc/stripe.js';
import { readWorkbook } from './xlsx-io.js';
import { detectBank, parseWise, parsePaypal, parseKeybank } from './poc/banks.js';

export const ACCEPT = '.pdf,.csv,.xlsx,application/pdf,text/csv';

export async function readStatementFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) {
    const lines = await pdfLines(await file.arrayBuffer());
    // A scanned statement is just pictures of pages — there's no text in it to read.
    if (!lines.length) throw new Error('This PDF is a scanned image, so there’s no text in it to read. Download the statement again from online banking (the electronic statement, not a scan or an image copy), or type the figures in.');
    if (looksLikeCass(lines)) return { type: 'cass', data: parseCassStatement(lines) };
    const k = detectIntrafi(lines);
    if (k === 'cdars') return { type: 'cdars', data: parseCdarsStatement(lines) };
    if (k === 'ics') return { type: 'ics', data: parseIcsStatement(lines) };
    const b = detectBank(lines);
    if (b === 'wise') return { type: 'bank', data: parseWise(lines) };
    if (b === 'paypal') return { type: 'bank', data: parsePaypal(lines) };
    if (b === 'keybank') return { type: 'bank', data: parseKeybank(lines) };
    throw new Error('I don’t recognize this PDF yet. Send it my way and I’ll add a reader for it.');
  }
  if (name.endsWith('.csv')) {
    const t = await file.text();
    if (looksLikeStripeMonthly(t)) return { type: 'stripe', data: parseStripeMonthly(t) };
    throw new Error('I don’t recognize this CSV yet.');
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const { XLSX, wb } = await readWorkbook(file);
    return { type: 'intrafi-export', data: parseIntrafiExport(XLSX, wb) };
  }
  throw new Error('Upload a PDF, CSV or Excel file.');
}
