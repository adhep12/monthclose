// A zip file, built in the browser. Files are stored as they are, without compressing them again:
// statements are PDFs and workbooks are already compressed, so it would gain little. Names are
// UTF-8 ("Translation – Hindi" stays as it is).
//   const z = zipWriter(); z.add('Statements/Wise_2026-09.pdf', bytes); const blob = z.blob();

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS date and time, as zip keeps them.
function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

export function zipWriter(now = new Date()) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  const names = new Set();
  let offset = 0;
  const { time, date } = dosTime(now);

  // Two files with the same name in the same folder: the second becomes "name (2).pdf".
  const unique = (path) => {
    if (!names.has(path)) { names.add(path); return path; }
    const m = path.match(/^(.*?)(\.[^./]+)?$/);
    for (let i = 2; ; i++) { const p = `${m[1]} (${i})${m[2] || ''}`; if (!names.has(p)) { names.add(p); return p; } }
  };

  return {
    add(path, data) {
      const bytes = typeof data === 'string' ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
      const name = enc.encode(unique(path));
      const crc = crc32(bytes);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
      local.setUint16(10, time, true); local.setUint16(12, date, true); local.setUint32(14, crc, true);
      local.setUint32(18, bytes.length, true); local.setUint32(22, bytes.length, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true); cen.setUint16(10, 0, true);
      cen.setUint16(12, time, true); cen.setUint16(14, date, true); cen.setUint32(16, crc, true);
      cen.setUint32(20, bytes.length, true); cen.setUint32(24, bytes.length, true); cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      parts.push(new Uint8Array(local.buffer), name, bytes);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + bytes.length;
    },
    get count() { return names.size; },
    // The finished zip, as bytes.
    bytes() {
      const size = central.reduce((n, p) => n + p.length, 0);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); end.setUint16(8, names.size, true); end.setUint16(10, names.size, true);
      end.setUint32(12, size, true); end.setUint32(16, offset, true);
      const all = [...parts, ...central, new Uint8Array(end.buffer)];
      const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of all) { out.set(p, at); at += p.length; }
      return out;
    },
    blob() { return new Blob([this.bytes()], { type: 'application/zip' }); },
  };
}
