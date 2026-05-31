/**
 * xlsx-min.js — Minimal XLSX reader and writer, no dependencies.
 *
 * Public API:
 *   generateXLSX(rows)             → Blob (.xlsx)
 *   readXLSX(arrayBuffer)          → Promise<string[][]>
 *   parseCSVText(text)             → string[][]
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════════════════
   CRC32 TABLE
   ═══════════════════════════════════════════════════════════════════════════════ */
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   STRING ↔ BYTES
   ═══════════════════════════════════════════════════════════════════════════════ */
function strToUtf8(str) {
  const enc = new TextEncoder();
  return enc.encode(str);
}

function utf8ToStr(buf) {
  const dec = new TextDecoder('utf-8');
  return dec.decode(buf);
}

function u32LE(n) {
  return [(n) & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}

function u16LE(n) {
  return [(n) & 0xff, (n >> 8) & 0xff];
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ZIP WRITER (STORE only — no compression)
   ═══════════════════════════════════════════════════════════════════════════════ */
function buildZip(files) {
  // files: [{name, data: Uint8Array}]
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = strToUtf8(file.name);
    const data = file.data instanceof Uint8Array ? file.data : strToUtf8(file.data);
    const crc = crc32(data);
    const size = data.length;

    // Local file header
    const lh = [
      0x50, 0x4b, 0x03, 0x04, // signature
      ...u16LE(20),             // version needed
      ...u16LE(0),              // general purpose bit flag
      ...u16LE(0),              // compression method: STORE
      ...u16LE(0),              // last mod time
      ...u16LE(0),              // last mod date
      ...u32LE(crc),            // crc-32
      ...u32LE(size),           // compressed size
      ...u32LE(size),           // uncompressed size
      ...u16LE(nameBytes.length),
      ...u16LE(0),              // extra field length
      ...nameBytes,
      ...data
    ];

    // Central directory header
    const cd = [
      0x50, 0x4b, 0x01, 0x02, // signature
      ...u16LE(20),             // version made by
      ...u16LE(20),             // version needed
      ...u16LE(0),              // general purpose bit flag
      ...u16LE(0),              // compression method: STORE
      ...u16LE(0),              // last mod time
      ...u16LE(0),              // last mod date
      ...u32LE(crc),
      ...u32LE(size),
      ...u32LE(size),
      ...u16LE(nameBytes.length),
      ...u16LE(0),              // extra field length
      ...u16LE(0),              // file comment length
      ...u16LE(0),              // disk number start
      ...u16LE(0),              // internal file attr
      ...u32LE(0),              // external file attr
      ...u32LE(offset),         // relative offset of local header
      ...nameBytes
    ];

    localHeaders.push(new Uint8Array(lh));
    centralHeaders.push(new Uint8Array(cd));
    offset += lh.length;
  }

  const centralOffset = offset;
  const centralSize = centralHeaders.reduce((s, h) => s + h.length, 0);

  const eocd = [
    0x50, 0x4b, 0x05, 0x06, // signature
    ...u16LE(0),              // disk number
    ...u16LE(0),              // disk with central dir
    ...u16LE(files.length),   // entries on disk
    ...u16LE(files.length),   // total entries
    ...u32LE(centralSize),
    ...u32LE(centralOffset),
    ...u16LE(0)               // comment length
  ];

  const parts = [...localHeaders, ...centralHeaders, new Uint8Array(eocd)];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }

  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   XML HELPERS
   ═══════════════════════════════════════════════════════════════════════════════ */
function xmlEsc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colName(idx) {
  // 0 → A, 25 → Z, 26 → AA …
  let name = '';
  let n = idx;
  while (true) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return name;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   XLSX WRITER
   ═══════════════════════════════════════════════════════════════════════════════ */
/**
 * generateXLSX(rows) — rows is an array of arrays (first row = headers).
 * Returns a Blob representing a valid .xlsx file.
 */
function generateXLSX(rows) {
  // Build shared strings table
  const sharedStrings = [];
  const ssMap = new Map();

  function ssIdx(val) {
    const s = val == null ? '' : String(val);
    if (ssMap.has(s)) return ssMap.get(s);
    const idx = sharedStrings.length;
    sharedStrings.push(s);
    ssMap.set(s, idx);
    return idx;
  }

  // Build sheet XML cells
  const rowXmls = rows.map((row, ri) => {
    const cells = (row || []).map((cell, ci) => {
      const ref = colName(ci) + (ri + 1);
      const val = cell == null ? '' : cell;
      // Numbers: store as number; everything else as shared string
      if (typeof val === 'number' && isFinite(val)) {
        return `<c r="${ref}"><v>${val}</v></c>`;
      }
      const si = ssIdx(String(val));
      return `<c r="${ref}" t="s"><v>${si}</v></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/sheet">
  <sheetData>${rowXmls}</sheetData>
</worksheet>`;

  const ssXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/sheet" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">
${sharedStrings.map(s => `<si><t xml:space="preserve">${xmlEsc(s)}</t></si>`).join('\n')}
</sst>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const relsRoot = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/sheet" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/sheet">
  <fonts><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`;

  const files = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: relsRoot },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
    { name: 'xl/sharedStrings.xml', data: ssXml },
    { name: 'xl/styles.xml', data: styles }
  ];

  const zipBytes = buildZip(files);
  return new Blob([zipBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ZIP READER
   ═══════════════════════════════════════════════════════════════════════════════ */
function readZipEntries(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const files = {};

  // Find End of Central Directory record by scanning from end
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP file');

  const entryCount    = view.getUint16(eocdOffset + 8, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);

  let cdPos = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(cdPos, true) !== 0x02014b50) break;
    const compression   = view.getUint16(cdPos + 10, true);
    const compressedSz  = view.getUint32(cdPos + 20, true);
    const uncompressedSz = view.getUint32(cdPos + 24, true);
    const nameLen       = view.getUint16(cdPos + 28, true);
    const extraLen      = view.getUint16(cdPos + 30, true);
    const commentLen    = view.getUint16(cdPos + 32, true);
    const localOffset   = view.getUint32(cdPos + 42, true);
    const name          = utf8ToStr(bytes.subarray(cdPos + 46, cdPos + 46 + nameLen));

    // Locate local file header
    const lhNameLen  = view.getUint16(localOffset + 26, true);
    const lhExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart  = localOffset + 30 + lhNameLen + lhExtraLen;
    const compressedData = bytes.subarray(dataStart, dataStart + compressedSz);

    files[name] = { compression, compressedData, uncompressedSize: uncompressedSz };

    cdPos += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function decompressEntry(entry) {
  if (entry.compression === 0) {
    // STORE — no compression
    return entry.compressedData;
  } else if (entry.compression === 8) {
    // DEFLATE — use DecompressionStream
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    writer.write(entry.compressedData);
    writer.close();

    const chunks = [];
    let totalLen = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLen += value.length;
    }

    const out = new Uint8Array(totalLen);
    let pos = 0;
    for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.length; }
    return out;
  } else {
    throw new Error('Unsupported ZIP compression method: ' + entry.compression);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   XML PARSER (minimal, tag-soup)
   ═══════════════════════════════════════════════════════════════════════════════ */
function parseXmlText(xml) {
  // Returns { tag, attrs, children, text } tree — good enough for OOXML
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  return dom;
}

function getAttr(el, name) {
  // Try with and without namespace
  return el.getAttribute(name) || el.getAttributeNS(null, name) || '';
}

/* ═══════════════════════════════════════════════════════════════════════════════
   XLSX READER
   ═══════════════════════════════════════════════════════════════════════════════ */
/**
 * readXLSX(arrayBuffer) — parses first sheet of an XLSX file.
 * Returns Promise<string[][]>
 */
async function readXLSX(arrayBuffer) {
  const entries = readZipEntries(arrayBuffer);

  // Helper: get decompressed text of a zip entry (case-insensitive path lookup)
  async function getText(path) {
    const key = Object.keys(entries).find(k => k.toLowerCase() === path.toLowerCase());
    if (!key) return null;
    const bytes = await decompressEntry(entries[key]);
    return utf8ToStr(bytes);
  }

  // 1. Parse shared strings
  const ssText = await getText('xl/sharedStrings.xml');
  const sharedStrings = [];
  if (ssText) {
    const doc = parseXmlText(ssText);
    const siEls = doc.getElementsByTagNameNS('*', 'si');
    for (const si of siEls) {
      // Collect all <t> text nodes within this <si>
      const tEls = si.getElementsByTagNameNS('*', 't');
      let s = '';
      for (const t of tEls) s += (t.textContent || '');
      sharedStrings.push(s);
    }
  }

  // 2. Find sheet1
  const sheetText = await getText('xl/worksheets/sheet1.xml');
  if (!sheetText) return [];

  const doc = parseXmlText(sheetText);
  const rowEls = doc.getElementsByTagNameNS('*', 'row');

  const result = [];

  for (const rowEl of rowEls) {
    const rowIdx = parseInt(getAttr(rowEl, 'r') || '1', 10) - 1;
    // Ensure result has enough rows
    while (result.length <= rowIdx) result.push([]);

    const cellEls = rowEl.getElementsByTagNameNS('*', 'c');
    for (const cell of cellEls) {
      const ref  = getAttr(cell, 'r');          // e.g. "B3"
      const type = getAttr(cell, 't');           // "s" = shared string, "str" = inline, "" = number
      const colLetters = ref.replace(/[0-9]/g, '');
      const colIdx = colRefToIndex(colLetters);

      while (result[rowIdx].length <= colIdx) result[rowIdx].push('');

      const vEl = cell.getElementsByTagNameNS('*', 'v')[0];
      const isEl = cell.getElementsByTagNameNS('*', 'is')[0];
      let val = '';

      if (type === 's') {
        // Shared string
        const si = parseInt(vEl ? vEl.textContent : '-1', 10);
        val = sharedStrings[si] != null ? sharedStrings[si] : '';
      } else if (type === 'inlineStr' || isEl) {
        // Inline string
        const tEl = (isEl || cell).getElementsByTagNameNS('*', 't')[0];
        val = tEl ? (tEl.textContent || '') : '';
      } else {
        // Number or date
        val = vEl ? (vEl.textContent || '') : '';
      }

      result[rowIdx][colIdx] = val;
    }
  }

  return result;
}

function colRefToIndex(col) {
  let idx = 0;
  for (let i = 0; i < col.length; i++) {
    idx = idx * 26 + (col.charCodeAt(i) - 64);
  }
  return idx - 1;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   CSV PARSER
   ═══════════════════════════════════════════════════════════════════════════════ */
/**
 * parseCSVText(text) — Handles BOM, CRLF, quoted fields.
 * Returns string[][]
 */
function parseCSVText(text) {
  // Remove BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote
          field += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        field = '';
        if (row.some(f => f !== '')) rows.push(row);
        row = [];
        i++;
        continue;
      } else {
        field += ch;
      }
    }
    i++;
  }

  // Last field / row
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);

  return rows;
}
