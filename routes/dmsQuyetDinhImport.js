/**
 * Import Excel — quyết định, công văn, thông báo… (nhiều mẫu cột tiêu đề).
 * Số tham chiếu: Số QĐ, Số CV, cột «Số»; ngày: Ngày ban hành / Ngày tháng.
 * Hyperlink: Link scan / Word; hoặc trên ô số tham chiếu.
 * Cột theo dõi (ngày gửi, tiếp nhận…): gộp vào ghi chú.
 * Trùng khóa: lower(trim(số tham chiếu)) + ngày (YYYY-MM-DD).
 */

const XLSX = require('xlsx');

const DMS_NO_FILE = '__no_file__';

function stripAccents(s) {
  return String(s || '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normHeader(s) {
  return stripAccents(String(s || ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function cellToString(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const epoch = Date.UTC(1899, 11, 30);
    const ms = epoch + Math.round(v) * 86400000;
    const dt = new Date(ms);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).trim();
}

/** Chuỗi / Excel serial / Date object → YYYY-MM-DD hoặc null */
function parseAnyDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof v === 'number') {
    const s = cellToString(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  const str = cellToString(v);
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const m = str.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) {
    let d = parseInt(m[1], 10);
    let mo = parseInt(m[2], 10);
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    if (mo > 12 && d <= 12) {
      const t = d;
      d = mo;
      mo = t;
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

function classifyHeaderKey(norm) {
  if (!norm) return null;
  if (/^stt$/.test(norm) || norm === 'so thu tu') return 'stt';
  if (/\bso\b.*\bqd\b/.test(norm) || /\bso\b.*quyet\s*dinh/.test(norm) || norm.includes('so qd'))
    return 'so_qd';
  if (/\bso\s*cv\b/.test(norm) || /\bso\b.*\bcv\b/.test(norm)) return 'so_qd';
  if (norm === 'so') return 'so_qd';

  if (/ngay\s*tiep\s*nhan/.test(norm)) return 'ngay_tiep_nhan';
  if (/ngay\s*xu\s*ly/.test(norm)) return 'ngay_xu_ly';
  if (/ngay\s*gui/.test(norm)) return 'ngay_gui';
  if (/ngay\s*ban\s*hanh/.test(norm)) return 'ngay_bh';
  if (/ngay\s*thang/.test(norm)) return 'ngay_bh';

  if (/ngay\s*hieu\s*luc/.test(norm) || /^hieu\s*luc/.test(norm)) return 'ngay_hl';
  if (/trich\s*yeu/.test(norm) || /noi\s*dung/.test(norm) || /^tieu\s*de/.test(norm)) return 'trich_yeu';
  if (/dv\s*ban\s*hanh/.test(norm) || /don\s*vi\s*ban\s*hanh/.test(norm)) return 'dv';
  if (/don\s*vi\s*nhan/.test(norm)) return 'noi_nhan';
  if (/noi\s*nhan/.test(norm) || /nguoi\s*nhan/.test(norm) || /noi.*nguoi.*nhan/.test(norm))
    return 'noi_nhan';
  if (/soan\s*thao/.test(norm) || /nguoi.*soan.*thao/.test(norm) || /noi.*nguoi.*soan/.test(norm))
    return 'soan_thao';
  if (/nguoi\s*tiep\s*nhan/.test(norm) || /tiep\s*nhan\s*cong\s*van/.test(norm)) return 'tiep_nhan';
  if (/luu\s*vt/.test(norm)) return 'luu_vt';
  if (/ghi\s*chu/.test(norm)) return 'ghi_chu';
  if (/\bword\b/.test(norm) && (/link/.test(norm) || /file/.test(norm))) return 'link_word';
  if (/link/.test(norm) && /scan/.test(norm)) return 'link_scan';
  if (/ban\s*scan/.test(norm)) return 'link_scan';
  return null;
}

/** Ma trận ô: { text, href, raw } — href = đích hyperlink (file://, http, đường dẫn…) */
function readSheetMatrix(ws) {
  if (!ws || !ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const matrix = [];
  for (let R = range.s.r; R <= range.e.r; R++) {
    const row = [];
    for (let C = range.s.c; C <= range.e.c; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      const cell = ws[addr];
      let text = '';
      let href = null;
      let raw = null;
      if (cell) {
        if (cell.w != null && String(cell.w).trim() !== '') text = String(cell.w).trim();
        else if (cell.v != null && cell.v !== '') {
          raw = cell.v;
          text = cellToString(cell.v);
        } else {
          raw = cell.v;
        }
        const link = cell.l && (cell.l.Target != null ? cell.l.Target : cell.l.target);
        if (link != null && String(link).trim() !== '') href = String(link).trim();
      }
      row.push({ text, href, raw });
    }
    matrix.push(row);
  }
  return matrix;
}

function cellPlainString(cell) {
  if (!cell) return '';
  const t = (cell.text || '').trim();
  if (t) return t;
  return cellToString(cell.raw);
}

function cellLinkPreferHref(cell) {
  if (!cell) return '';
  if (cell.href) return cell.href;
  return cellPlainString(cell);
}

/** Bỏ qua placeholder không phải URL (ô Word/Scan ghi N/A). */
function linkCellValue(cell) {
  const v = String(cellLinkPreferHref(cell) || '').trim();
  if (!v) return '';
  const u = v.toLowerCase();
  if (u === 'n/a' || u === 'na' || u === 'none' || u === '-' || u === 'khong co' || u === 'không có') return '';
  if (v === '—') return '';
  return v;
}

function findHeaderMapping(matrix) {
  const maxScan = Math.min(matrix.length, 35);
  for (let r = 0; r < maxScan; r++) {
    const row = matrix[r] || [];
    const colMap = {};
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      const label = cell && typeof cell === 'object' && 'text' in cell ? cellPlainString(cell) : String(cell || '');
      const key = classifyHeaderKey(normHeader(label));
      if (key && colMap[key] === undefined) colMap[key] = c;
    }
    if (colMap.so_qd !== undefined && colMap.ngay_bh !== undefined) {
      return { headerRow: r, colMap };
    }
    if (colMap.trich_yeu !== undefined && colMap.ngay_bh !== undefined) {
      return { headerRow: r, colMap };
    }
  }
  return null;
}

function parseWorkbookBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: true });
  const out = { sheets: [], errors: [] };

  wb.SheetNames.forEach((sheetName) => {
    const ws = wb.Sheets[sheetName];
    if (!ws) return;
    const matrix = readSheetMatrix(ws);
    const found = findHeaderMapping(matrix);
    if (!found) {
      out.errors.push({
        sheet: sheetName,
        message:
          'Không tìm thấy dòng tiêu đề (cần cột số tham chiếu: Số / Số QĐ / Số CV và cột ngày: Ngày ban hành hoặc Ngày tháng).',
      });
      return;
    }
    const { headerRow, colMap } = found;
    const rows = [];
    for (let r = headerRow + 1; r < matrix.length; r++) {
      const line = matrix[r] || [];
      const cellAt = (k) => {
        const idx = colMap[k];
        if (idx === undefined) return null;
        return line[idx] || null;
      };
      const cSo = cellAt('so_qd');
      const soQd = cellPlainString(cSo);
      const linkFromRef =
        cSo && cSo.href && String(cSo.href).trim() ? String(cSo.href).trim() : '';
      const trich = cellPlainString(cellAt('trich_yeu'));
      const cBh = cellAt('ngay_bh');
      const cHl = cellAt('ngay_hl');
      const issueIso = parseAnyDate(cBh && cBh.raw !== undefined && cBh.raw !== null && cBh.raw !== '' ? cBh.raw : cBh ? cBh.text : '');
      const validIso = parseAnyDate(cHl && cHl.raw !== undefined && cHl.raw !== null && cHl.raw !== '' ? cHl.raw : cHl ? cHl.text : '');
      if (!soQd && !trich && !issueIso) continue;
      rows.push({
        sheet: sheetName,
        excelRow: r + 1,
        stt: cellPlainString(cellAt('stt')),
        so_qd: soQd,
        issue_date: issueIso,
        valid_until: validIso,
        trich_yeu: trich,
        dv: cellPlainString(cellAt('dv')),
        ghi_chu: cellPlainString(cellAt('ghi_chu')),
        noi_nhan: cellPlainString(cellAt('noi_nhan')),
        luu_vt: cellPlainString(cellAt('luu_vt')),
        soan_thao: cellPlainString(cellAt('soan_thao')),
        ngay_gui: cellPlainString(cellAt('ngay_gui')),
        tiep_nhan: cellPlainString(cellAt('tiep_nhan')),
        ngay_tiep_nhan: cellPlainString(cellAt('ngay_tiep_nhan')),
        ngay_xu_ly: cellPlainString(cellAt('ngay_xu_ly')),
        link_scan: linkCellValue(cellAt('link_scan')),
        link_word: linkCellValue(cellAt('link_word')),
        link_from_ref: linkFromRef,
      });
    }
    out.sheets.push({ name: sheetName, headerRow: headerRow + 1, rowCount: rows.length, rows });
  });

  return out;
}

function dedupKey(ref, issueIso) {
  const r = String(ref || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!r || !issueIso) return null;
  return `${r}||${issueIso}`;
}

function findExistingByKey(db, ref, issueIso) {
  if (!ref || !issueIso) return null;
  return db
    .prepare(
      `SELECT id, title FROM dms_documents
       WHERE lower(trim(COALESCE(ref_number,''))) = lower(trim(?))
         AND date(COALESCE(issue_date,'')) = date(?)`
    )
    .get(ref, issueIso);
}

function countDuplicateSummary(db) {
  const keys = db
    .prepare(
      `SELECT lower(trim(ref_number)) AS r, issue_date AS idate, COUNT(*) AS c
       FROM dms_documents
       WHERE COALESCE(trim(ref_number), '') != '' AND COALESCE(trim(issue_date), '') != ''
       GROUP BY lower(trim(ref_number)), issue_date
       HAVING c > 1`
    )
    .all();
  let docsInGroups = 0;
  for (const k of keys) {
    const n = db
      .prepare(
        `SELECT COUNT(*) AS n FROM dms_documents
         WHERE lower(trim(COALESCE(ref_number,''))) = ? AND issue_date = ?`
      )
      .get(k.r, k.idate).n;
    docsInGroups += n;
  }
  return { duplicateGroups: keys.length, documentsInDuplicateGroups: docsInGroups };
}

/**
 * @returns {{ imported, skippedDbDuplicate, skippedBatchDuplicate, errors, details }}
 */
function runQuyetDinhImport(db, parsed, opts) {
  const {
    userId,
    categoryId,
    documentTypeId,
    defaultStatus,
    dryRun,
  } = opts;
  const allowed = ['active', 'draft', 'expired', 'revoked'];
  const st = allowed.includes(String(defaultStatus || '').toLowerCase())
    ? String(defaultStatus).toLowerCase()
    : 'active';

  const ins = db.prepare(
    `INSERT INTO dms_documents (
      title, ref_number, category_id, document_type_id, status,
      issue_date, valid_until, file_path, original_name, file_size, mime_type, notes,
      issuing_unit, external_scan_link, external_word_link, import_sheet, uploaded_by_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?)`
  );

  let imported = 0;
  let skippedDbDuplicate = 0;
  let skippedBatchDuplicate = 0;
  const errors = [];
  const details = {
    importedRows: [],
    skippedDb: [],
    skippedBatch: [],
  };

  const seen = new Map();

  const allRows = [];
  parsed.sheets.forEach((s) => {
    s.rows.forEach((row) => allRows.push(row));
  });

  for (const row of allRows) {
    const ref = String(row.so_qd || '').trim();
    const issueIso = row.issue_date;
    if (!ref || !issueIso) {
      errors.push({
        sheet: row.sheet,
        excelRow: row.excelRow,
        message: 'Thiếu Số QĐ hoặc Ngày ban hành không đọc được.',
      });
      continue;
    }

    const key = dedupKey(ref, issueIso);
    if (seen.has(key)) {
      skippedBatchDuplicate += 1;
      details.skippedBatch.push({
        sheet: row.sheet,
        excelRow: row.excelRow,
        ref_number: ref,
        issue_date: issueIso,
        reason: 'Trùng trong cùng file (dòng đầu được giữ)',
        firstRow: seen.get(key),
      });
      continue;
    }

    const ex = findExistingByKey(db, ref, issueIso);
    if (ex) {
      skippedDbDuplicate += 1;
      details.skippedDb.push({
        sheet: row.sheet,
        excelRow: row.excelRow,
        ref_number: ref,
        issue_date: issueIso,
        existingId: ex.id,
        existingTitle: ex.title,
      });
      continue;
    }

    seen.set(key, { sheet: row.sheet, excelRow: row.excelRow });

    const title =
      String(row.trich_yeu || '').trim() ||
      `Văn bản ${ref} — ${issueIso}`;
    const noteParts = [];
    const gc = String(row.ghi_chu || '').trim();
    if (gc) noteParts.push(gc);
    const nn = String(row.noi_nhan || '').trim();
    if (nn) noteParts.push(`Nơi nhận / ĐV nhận: ${nn}`);
    const lv = String(row.luu_vt || '').trim();
    if (lv) noteParts.push(`Lưu VT: ${lv}`);
    const sthao = String(row.soan_thao || '').trim();
    if (sthao) noteParts.push(`Soạn thảo: ${sthao}`);
    const ng = String(row.ngay_gui || '').trim();
    if (ng) noteParts.push(`Ngày gửi: ${ng}`);
    const tn = String(row.tiep_nhan || '').trim();
    if (tn) noteParts.push(`Người tiếp nhận: ${tn}`);
    const ntn = String(row.ngay_tiep_nhan || '').trim();
    if (ntn) noteParts.push(`Ngày tiếp nhận: ${ntn}`);
    const nxl = String(row.ngay_xu_ly || '').trim();
    if (nxl) noteParts.push(`Ngày xử lý: ${nxl}`);
    const notes = noteParts.length ? noteParts.join('\n') : null;
    const scanLink =
      String(row.link_scan || '').trim() ||
      String(row.link_from_ref || '').trim() ||
      null;
    const wordLink = String(row.link_word || '').trim() || null;
    const origName =
      scanLink ||
      wordLink ||
      `${ref}-${issueIso}.pdf`;

    const dv = String(row.dv || '').trim() || null;

    if (!dryRun) {
      ins.run(
        title,
        ref,
        Number.isFinite(categoryId) ? categoryId : null,
        Number.isFinite(documentTypeId) ? documentTypeId : null,
        st,
        issueIso,
        row.valid_until || null,
        DMS_NO_FILE,
        origName,
        notes,
        dv,
        scanLink,
        wordLink,
        row.sheet,
        userId
      );
    }
    imported += 1;
    details.importedRows.push({
      sheet: row.sheet,
      excelRow: row.excelRow,
      ref_number: ref,
      issue_date: issueIso,
      title: title.slice(0, 80),
    });
  }

  return {
    imported,
    skippedDbDuplicate,
    skippedBatchDuplicate,
    errors,
    details,
  };
}

module.exports = {
  DMS_NO_FILE,
  parseWorkbookBuffer,
  dedupKey,
  findExistingByKey,
  countDuplicateSummary,
  runQuyetDinhImport,
};
