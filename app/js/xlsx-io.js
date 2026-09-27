// Spreadsheet reading and writing. SheetJS is vendored (vendor/xlsx.mjs) and loaded only when a
// page actually needs it — it's a megabyte, and most visits never touch a spreadsheet.

let xlsxPromise = null;

export function loadXLSX() {
  if (!xlsxPromise) xlsxPromise = import('../vendor/xlsx.mjs');
  return xlsxPromise;
}

export async function readWorkbook(file) {
  const XLSX = await loadXLSX();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { cellDates: true });
  repairRefs(XLSX, wb);
  return { XLSX, wb };
}

// Acumatica's exports write lowercase cell references ("a1") and a broken sheet dimension
// ("1:A137"), which leaves SheetJS seeing nothing. Normalize the references, then recompute each
// sheet's range from the cells actually present.
export function repairRefs(XLSX, wb) {
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    for (const k of Object.keys(ws)) {
      if (k[0] === '!' || !/[a-z]/.test(k)) continue;
      const up = k.toUpperCase();
      if (!(up in ws)) ws[up] = ws[k];
      delete ws[k];
    }
    let r0 = Infinity, c0 = Infinity, r1 = -1, c1 = -1;
    for (const k of Object.keys(ws)) {
      if (k[0] === '!') continue;
      const { r, c } = XLSX.utils.decode_cell(k);
      if (r < r0) r0 = r; if (c < c0) c0 = c;
      if (r > r1) r1 = r; if (c > c1) c1 = c;
    }
    if (r1 >= 0) ws['!ref'] = XLSX.utils.encode_range({ s: { r: r0, c: c0 }, e: { r: r1, c: c1 } });
  }
  return wb;
}

export async function downloadWorkbook(filename, sheets) {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  for (const { name, rows, cols, freeze } of sheets) {
    // A cell may be { v, z } to give it its own number format; other numbers get the accounting one.
    const ws = XLSX.utils.aoa_to_sheet(rows.map((r) => r.map((v) => (v && typeof v === 'object' && 'v' in v ? v.v : v))));
    rows.forEach((r, ri) => r.forEach((v, ci) => {
      const cell = ws[XLSX.utils.encode_cell({ r: ri, c: ci })];
      if (!cell || cell.t !== 'n') return;
      cell.z = v && typeof v === 'object' && v.z ? v.z : '#,##0.00;(#,##0.00);"-"';
    }));
    if (cols) ws['!cols'] = cols.map((wch) => ({ wch }));
    if (freeze) ws['!freeze'] = freeze;
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }
  XLSX.writeFile(wb, filename);
}

// ---- Helpers shared by the parsers -------------------------------------------------------

export function cellAt(XLSX, ws, r, c) {
  return ws[XLSX.utils.encode_cell({ r, c })];
}

export function text(cell) {
  if (!cell || cell.v == null) return '';
  return String(cell.v).trim();
}

export function num(cell) {
  if (!cell || cell.v == null || cell.v === '') return null;
  if (typeof cell.v === 'number') return cell.v;
  const n = Number(String(cell.v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// 'YYYY-MM-DD' from a date cell, a serial number, or a typed date like '8/21/2019'.
export function isoDate(cell) {
  if (!cell || cell.v == null) return null;
  const v = cell.v;
  const fmt = (y, m, d) => (y > 1900 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)
    ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return fmt(v.getFullYear(), v.getMonth() + 1, v.getDate());
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return fmt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return fmt(y, Number(m[1]), Number(m[2]));
  }
  const iso = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? fmt(Number(iso[1]), Number(iso[2]), Number(iso[3])) : null;
}
