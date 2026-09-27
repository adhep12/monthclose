// PDF → lines of text, using the vendored pdf.js — its "legacy" build, which runs in older
// browsers too (the modern build needs JS features some browsers don't have yet). Items on the
// same baseline (±2pt) become one line, left to right. Parsers work on these lines, so they don't depend on pdf.js themselves.

let pdfjsPromise = null;

export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

export async function pdfLines(data, lib) {
  const pdfjs = lib || (await loadPdfjs());
  const task = pdfjs.getDocument({ data, isEvalSupported: false });
  const doc = await task.promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rows = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = it.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) <= 2);
      if (!row) rows.push(row = { y, items: [] });
      row.items.push({ x: it.transform[4], str: it.str.trim() });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      lines.push({ page: p, text: r.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim() });
    }
  }
  await task.destroy();
  return lines;
}
