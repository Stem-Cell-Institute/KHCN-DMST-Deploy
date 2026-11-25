/**
 * Zero-dependency Excel (.xlsx) & CSV parser for BM02 Dự toán kinh phí
 * Parses standard OOXML (.xlsx) via Node built-in zlib without requiring external npm packages.
 */
const zlib = require('zlib');

function decodeXmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function colLetterToIndex(letters) {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

function unzipBuffer(buf) {
  const entries = {};
  // Locate End of Central Directory (EOCD) signature 0x06054b50
  let eocdOffset = -1;
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Tệp không phải định dạng .xlsx hợp lệ (không tìm thấy cấu trúc ZIP)');
  }

  const cdCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  let p = cdOffset;
  for (let k = 0; k < cdCount; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const compMethod = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);

    if (compMethod === 0) {
      entries[name] = raw.toString('utf8');
    } else if (compMethod === 8) {
      entries[name] = zlib.inflateRawSync(raw).toString('utf8');
    }

    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function parseXlsxRows(buf) {
  const entries = unzipBuffer(buf);
  const sharedStringsXml = entries['xl/sharedStrings.xml'] || '';
  const sharedStrings = [];
  const siRegex = /<si>([\s\S]*?)<\/si>/g;
  let siMatch;
  while ((siMatch = siRegex.exec(sharedStringsXml)) !== null) {
    const tRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let text = '';
    let tMatch;
    while ((tMatch = tRegex.exec(siMatch[1])) !== null) {
      text += decodeXmlEntities(tMatch[1]);
    }
    sharedStrings.push(text);
  }

  // Pick first worksheet (sheet1.xml or first xl/worksheets/sheet*.xml)
  const sheetKey = entries['xl/worksheets/sheet1.xml']
    ? 'xl/worksheets/sheet1.xml'
    : Object.keys(entries).find(k => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k));

  if (!sheetKey) {
    throw new Error('Không tìm thấy trang tính (worksheet) trong tệp Excel');
  }

  const sheetXml = entries[sheetKey];
  const rows = [];
  const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rMatch;
  while ((rMatch = rowRegex.exec(sheetXml)) !== null) {
    const rowArr = [];
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cMatch;
    while ((cMatch = cellRegex.exec(rMatch[1])) !== null) {
      const attrs = cMatch[1];
      const body = cMatch[2];
      const refMatch = attrs.match(/r="([A-Z]+)\d+"/);
      const colIdx = refMatch ? colLetterToIndex(refMatch[1]) : rowArr.length;
      const typeMatch = attrs.match(/t="([^"]+)"/);
      const cellType = typeMatch ? typeMatch[1] : '';

      let val = '';
      if (cellType === 's') {
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        val = vMatch ? (sharedStrings[Number(vMatch[1])] || '') : '';
      } else if (cellType === 'inlineStr') {
        const tRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
        let tMatch;
        while ((tMatch = tRegex.exec(body)) !== null) {
          val += decodeXmlEntities(tMatch[1]);
        }
      } else if (cellType === 'str') {
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        val = vMatch ? decodeXmlEntities(vMatch[1]) : '';
      } else {
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        val = vMatch ? vMatch[1].trim() : '';
      }
      rowArr[colIdx] = val;
    }
    if (rowArr.some(v => v !== undefined && String(v).trim() !== '')) {
      rows.push(rowArr.map(v => (v === undefined ? '' : String(v).trim())));
    }
  }
  return rows;
}

function parseCsvRows(text) {
  const cleaned = text.replace(/^\uFEFF/, '');
  const lines = cleaned.split(/\r?\n/).filter(l => l.trim().length > 0);
  return lines.map(line => {
    const cols = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if ((ch === ',' || ch === ';' || ch === '\t') && !inQuotes) {
        cols.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    cols.push(cur.trim());
    return cols;
  });
}

function parseNumberVN(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  const s = String(val).trim();
  if (!s) return 0;
  // Handle Excel numeric strings like "1500000" or "1,500,000" or "1.500.000"
  if (/^\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) {
    return Number(s) || 0;
  }
  // Remove currency symbols & spaces
  let clean = s.replace(/[^\d.,-]/g, '');
  // If both dot and comma exist, determine decimal separator
  if (clean.includes('.') && clean.includes(',')) {
    if (clean.lastIndexOf(',') > clean.lastIndexOf('.')) {
      clean = clean.replace(/\./g, '').replace(',', '.');
    } else {
      clean = clean.replace(/,/g, '');
    }
  } else if (clean.includes(',')) {
    // Multiple commas or 3 digits after comma -> thousands separator
    const parts = clean.split(',');
    if (parts.length > 2 || (parts[1] && parts[1].length === 3)) {
      clean = clean.replace(/,/g, '');
    } else {
      clean = clean.replace(',', '.');
    }
  } else if (clean.includes('.')) {
    const parts = clean.split('.');
    if (parts.length > 2 || (parts[1] && parts[1].length === 3)) {
      clean = clean.replace(/\./g, '');
    }
  }
  const n = Number(clean);
  return isNaN(n) ? 0 : n;
}

function normalizeHeader(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract structured budget items from rows of BM02 Excel or generic CSV/XLSX
 */
function extractBudgetItemsFromRows(rows) {
  if (!rows || rows.length === 0) return [];

  // 1. Find header row by matching common Vietnamese/English budget column headers
  let headerRowIdx = -1;
  let colMap = {
    stt: -1,
    name: -1,
    spec: -1,
    unit: -1,
    qty: -1,
    unitPrice: -1,
    totalPrice: -1,
    notes: -1
  };

  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const row = rows[i];
    const norm = row.map(normalizeHeader);
    const tempMap = { stt: -1, name: -1, spec: -1, unit: -1, qty: -1, unitPrice: -1, totalPrice: -1, notes: -1 };
    norm.forEach((cell, cIdx) => {
      if (!cell) return;
      if (tempMap.stt === -1 && (cell === 'stt' || cell === 'tt')) tempMap.stt = cIdx;
      else if (tempMap.name === -1 && (cell.includes('ten') || cell.includes('hang hoa') || cell.includes('noi dung') || cell.includes('hoa chat') || cell.includes('vat tu') || cell.includes('hang muc'))) tempMap.name = cIdx;
      else if (tempMap.spec === -1 && (cell.includes('quy cach') || cell.includes('hang sx') || cell.includes('thong so') || cell.includes('mo ta'))) tempMap.spec = cIdx;
      else if (tempMap.unit === -1 && (cell === 'dvt' || cell.includes('don vi') || cell === 'unit')) tempMap.unit = cIdx;
      else if (tempMap.qty === -1 && (cell.includes('so luong') || cell === 'sl' || cell.includes('qty'))) tempMap.qty = cIdx;
      else if (tempMap.unitPrice === -1 && (cell.includes('don gia') || cell.includes('gia du kien') || cell.includes('unit price'))) tempMap.unitPrice = cIdx;
      else if (tempMap.totalPrice === -1 && (cell.includes('thanh tien') || cell.includes('tong tien') || cell.includes('kinh phi') || cell.includes('total'))) tempMap.totalPrice = cIdx;
      else if (tempMap.notes === -1 && (cell.includes('ghi chu') || cell.includes('note'))) tempMap.notes = cIdx;
    });

    if (tempMap.name !== -1 && (tempMap.qty !== -1 || tempMap.unitPrice !== -1 || tempMap.totalPrice !== -1)) {
      headerRowIdx = i;
      colMap = tempMap;
      break;
    }
  }

  // Fallback default columns if header not clearly detected: [STT, Tên, Quy cách, ĐVT, SL, Đơn giá, Thành tiền, Ghi chú]
  if (headerRowIdx === -1) {
    headerRowIdx = 0;
    colMap = { stt: 0, name: 1, spec: 2, unit: 3, qty: 4, unitPrice: 5, totalPrice: 6, notes: 7 };
  }

  const items = [];
  let currentCategory = 'Hóa chất & Vật tư';

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const rawStt = colMap.stt >= 0 ? (row[colMap.stt] || '') : '';
    const rawName = colMap.name >= 0 ? (row[colMap.name] || '') : '';
    const normName = normalizeHeader(rawName);
    const normStt = normalizeHeader(rawStt);

    if (!rawName) continue;

    // Skip sub-header numbering row like (1) (2) (3) or total/signature rows
    if (/^\(\d+\)$/.test(rawName) || normName.startsWith('tong cong') || normName.startsWith('tong kinh phi') || normName.startsWith('cong:') || normName === 'cong' || normName.includes('bang chu') || normName.includes('chu nhiem') || normName.includes('vien truong') || normName.includes('nguoi lap')) {
      continue;
    }

    const qty = colMap.qty >= 0 ? parseNumberVN(row[colMap.qty]) : 0;
    const unitPrice = colMap.unitPrice >= 0 ? parseNumberVN(row[colMap.unitPrice]) : 0;
    const totalRaw = colMap.totalPrice >= 0 ? parseNumberVN(row[colMap.totalPrice]) : 0;

    // Detect Roman numeral section header (I, II, III, IV...) -> update category
    if (/^(i|ii|iii|iv|v|vi|vii|viii|ix|x|\d+\.)$/i.test(normStt.replace(/\./g, '')) && qty === 0 && unitPrice === 0) {
      currentCategory = rawName;
      continue;
    }

    // Must have at least a quantity or price/total to be considered a budget item
    if (qty <= 0 && unitPrice <= 0 && totalRaw <= 0) {
      continue;
    }

    const finalQty = qty > 0 ? qty : 1;
    let finalUnitPrice = unitPrice;
    let finalTotal = totalRaw;

    if (finalUnitPrice === 0 && finalTotal > 0 && finalQty > 0) {
      finalUnitPrice = Math.round(finalTotal / finalQty);
    }
    if (finalTotal === 0 && finalUnitPrice > 0 && finalQty > 0) {
      finalTotal = Math.round(finalUnitPrice * finalQty);
    }

    items.push({
      category: currentCategory,
      item_name: rawName,
      specification: colMap.spec >= 0 ? (row[colMap.spec] || '') : '',
      unit: colMap.unit >= 0 ? (row[colMap.unit] || '') : '',
      approved_quantity: finalQty,
      unit_price: finalUnitPrice,
      total_price: finalTotal,
      notes: colMap.notes >= 0 ? (row[colMap.notes] || '') : ''
    });
  }

  return items;
}

function parseBudgetFile(buffer, originalName = '') {
  const lower = String(originalName).toLowerCase();
  let rows = [];
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    rows = parseCsvRows(buffer.toString('utf8'));
  } else {
    rows = parseXlsxRows(buffer);
  }
  return extractBudgetItemsFromRows(rows);
}

module.exports = {
  parseXlsxRows,
  parseCsvRows,
  parseBudgetFile,
  parseNumberVN
};
