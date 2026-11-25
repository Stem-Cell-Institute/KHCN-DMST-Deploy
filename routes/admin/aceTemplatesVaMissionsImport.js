'use strict';

/**
 * Quản trị mẫu ACE & Import/Thêm thủ công Nhiệm vụ KHCN (4 endpoint).
 *
 *   POST   /api/admin/ace-templates
 *   DELETE /api/admin/ace-templates/:type
 *   POST   /api/admin/missions/import
 *   POST   /api/admin/missions/manual
 *
 * Tách khỏi server.js (Đợt 6.3b của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/admin.test.js.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

module.exports = function createAdminAceTemplatesVaMissionsImportRouter({
  db,
  uploadDir,
  upload,
  authMiddleware,
  adminOnly,
  aceCanManageTemplates,
  ACE_TEMPLATE_TYPES,
  ACE_TEMPLATE_BY_TYPE,
  pathIsStrictlyInsideResolvedRoot,
  resolveMissionStatusInput,
}) {
  const router = express.Router();

  router.post(
    '/admin/ace-templates',
    authMiddleware,
    (req, res, next) => {
      if (!aceCanManageTemplates(req)) return res.status(403).json({ message: 'Chỉ Admin hoặc Thư ký Hội đồng mới được cập nhật mẫu.' });
      next();
    },
    upload.single('file'),
    (req, res) => {
      const type = (req.body.template_type || '').trim();
      if (!ACE_TEMPLATE_TYPES.includes(type)) {
        try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(400).json({ message: 'template_type không hợp lệ' });
      }
      if (!req.file || !req.file.path) return res.status(400).json({ message: 'Vui lòng chọn file để upload' });
      const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
      if (!['pdf', 'doc', 'docx'].includes(ext)) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(400).json({ message: 'Chỉ chấp nhận PDF, Word (.doc, .docx)' });
      }
      const destDir = path.join(uploadDir, 'ace-templates');
      fs.mkdirSync(destDir, { recursive: true });
      const finalName = type + '_' + Date.now() + '.' + ext;
      const destPath = path.join(destDir, finalName);
      fs.copyFileSync(req.file.path, destPath);
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      db.prepare("INSERT OR REPLACE INTO ace_templates (template_type, original_name, path, updated_at) VALUES (?, ?, ?, datetime('now'))").run(type, req.file.originalname || finalName, finalName);
      const row = db.prepare('SELECT template_type, original_name, updated_at FROM ace_templates WHERE template_type = ?').get(type);
      return res.status(201).json({ message: 'Đã cập nhật mẫu ' + (ACE_TEMPLATE_BY_TYPE[type] ? ACE_TEMPLATE_BY_TYPE[type].label : type), template: row });
    }
  );

  router.delete('/admin/ace-templates/:type', authMiddleware, (req, res) => {
    if (!aceCanManageTemplates(req)) return res.status(403).json({ message: 'Chỉ Admin hoặc Thư ký Hội đồng mới được xóa mẫu.' });
    const type = (req.params.type || '').trim();
    if (!ACE_TEMPLATE_TYPES.includes(type)) return res.status(400).json({ message: 'Loại mẫu không hợp lệ' });
    const row = db.prepare('SELECT path FROM ace_templates WHERE template_type = ?').get(type);
    if (!row) return res.status(404).json({ message: 'Không có file để xóa' });
    try {
      const templatesRoot = path.resolve(uploadDir, 'ace-templates');
      const fullPath = path.resolve(templatesRoot, String(row.path || '').trim());
      if (pathIsStrictlyInsideResolvedRoot(templatesRoot, fullPath) && fs.existsSync(fullPath)) {
        try { fs.unlinkSync(fullPath); } catch (_) {}
      }
      db.prepare('DELETE FROM ace_templates WHERE template_type = ?').run(type);
      return res.json({ ok: true, message: 'Đã xóa mẫu' });
    } catch (e) {
      console.error('[ace-templates delete]', e);
      return res.status(500).json({ message: 'Lỗi xóa' });
    }
  });

  // Import CSV hoặc Excel (.xlsx): cập nhật/thêm đề tài vào missions (Admin)
  router.post('/admin/missions/import', authMiddleware, adminOnly, upload.single('file'), (req, res) => {
    if (!req.file || !req.file.path) {
      return res.status(400).json({ message: 'Vui lòng chọn file CSV hoặc Excel (.xlsx) để import.' });
    }
    const isExcel = (req.file.originalname || '').toLowerCase().endsWith('.xlsx');
    let headerCells = [];
    let dataRows = [];

    if (isExcel) {
      try {
        const buf = fs.readFileSync(req.file.path);
        const workbook = XLSX.read(buf, { type: 'buffer', cellDates: false });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) return res.status(400).json({ message: 'File Excel không có sheet nào.' });
        const sheet = workbook.Sheets[sheetName];
        const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
        if (!rawRows.length) return res.status(400).json({ message: 'File Excel trống.' });
        headerCells = (rawRows[0] || []).map(c => String(c == null ? '' : c).trim().toLowerCase());
        const startDateCol = headerCells.indexOf('start_date') >= 0 ? headerCells.indexOf('start_date') : -1;
        const endDateCol = headerCells.indexOf('end_date') >= 0 ? headerCells.indexOf('end_date') : -1;
        for (let r = 1; r < rawRows.length; r++) {
          const row = rawRows[r] || [];
          const cells = [];
          for (let c = 0; c < headerCells.length; c++) {
            const val = row[c];
            if (c === startDateCol || c === endDateCol) {
              if (typeof val === 'number' && val >= 1) {
                const d = XLSX.SSF.parse_date_code(val);
                if (d && d.y) cells.push(d.y + '-' + String(d.m).padStart(2, '0') + '-' + String(d.d).padStart(2, '0'));
                else cells.push(String(val == null ? '' : val));
              } else cells.push(String(val == null ? '' : val));
            } else cells.push(String(val == null ? '' : val));
          }
          dataRows.push(cells);
        }
      } catch (e) {
        if (req.file.path && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(400).json({ message: 'Không đọc được file Excel. Bạn có thể lưu lại dưới dạng CSV (UTF-8) và thử import CSV.' });
      }
    } else {
      let raw = '';
      if (fs.existsSync(req.file.path)) {
        raw = (fs.readFileSync(req.file.path, 'utf8') || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      }
      if (!raw || raw.trim().length === 0) {
        return res.status(400).json({ message: 'File trống hoặc không đọc được.' });
      }
      let lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines[0] && lines[0].toLowerCase() === 'sep=,') lines = lines.slice(1);
      let delim = ',';
      if (lines[0] && /^sep=;/i.test(lines[0])) { lines = lines.slice(1); delim = ';'; }
      if (lines.length < 2) {
        return res.status(400).json({ message: 'File CSV cần có ít nhất dòng tiêu đề và một dòng dữ liệu.' });
      }
      const parseRow = (line) => {
        const out = [];
        let inQuoted = false, cur = '';
        for (let i = 0; i < line.length; i++) {
          const c = line[i];
          if (c === '"') {
            if (inQuoted && line[i + 1] === '"') { cur += '"'; i++; }
            else inQuoted = !inQuoted;
          } else if (c === delim && !inQuoted) { out.push(cur.trim()); cur = ''; }
          else cur += c;
        }
        out.push(cur.trim());
        return out;
      };
      headerCells = parseRow(lines[0]).map(h => h.trim().toLowerCase());
      for (let i = 1; i < lines.length; i++) dataRows.push(parseRow(lines[i]));
    }

    const codeIdx = headerCells.indexOf('code') >= 0 ? headerCells.indexOf('code') : 0;
    const titleIdx = headerCells.indexOf('title') >= 0 ? headerCells.indexOf('title') : 1;
    const principalIdx = headerCells.indexOf('principal') >= 0 ? headerCells.indexOf('principal') : 2;
    const levelIdx = headerCells.indexOf('level') >= 0 ? headerCells.indexOf('level') : 3;
    const statusIdx = headerCells.indexOf('status') >= 0 ? headerCells.indexOf('status') : 4;
    const startIdx = headerCells.indexOf('start_date') >= 0 ? headerCells.indexOf('start_date') : 5;
    const endIdx = headerCells.indexOf('end_date') >= 0 ? headerCells.indexOf('end_date') : 6;
    const progressIdx = headerCells.indexOf('progress') >= 0 ? headerCells.indexOf('progress') : 7;
    const budgetIdx = headerCells.indexOf('budget') >= 0 ? headerCells.indexOf('budget') : 8;

    const normalizeDate = (s) => {
      if (!s || typeof s !== 'string') return null;
      const v = s.trim();
      if (!v) return null;
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) return v.slice(0, 10);
      const parts = v.split(/[/\-.]/).map(p => p.trim());
      if (parts.length >= 3) {
        const a = parseInt(parts[0], 10);
        const b = parseInt(parts[1], 10);
        const c = parseInt(parts[2], 10);
        if (!isNaN(a) && !isNaN(b) && !isNaN(c) && parts[2].length >= 4) {
          let year = c;
          let month = a;
          let day = b;
          if (year < 100) year = 2000 + year;
          if (a > 12 && b <= 12) { month = b; day = a; }
          else if (b > 12 && a <= 12) { month = a; day = b; }
          month = Math.max(1, Math.min(12, month));
          day = Math.max(1, Math.min(31, day));
          return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
        }
      }
      return null;
    };

    let inserted = 0;
    let updated = 0;
    const levels = ['national', 'ministry', 'university', 'school', 'coe', 'first', 'institute'];
    const statuses = ['planning', 'approved', 'ongoing', 'review', 'completed', 'overdue'];
    for (let i = 0; i < dataRows.length; i++) {
      const cells = dataRows[i];
      if (cells.length < 2) continue;
      const code = (cells[codeIdx] != null ? cells[codeIdx] : cells[0] || '').trim();
      if (!code) continue;
      if (code.length > 80 || code.indexOf('Cấp') >= 0 || code.indexOf('Trạng thái') >= 0 || code.indexOf('GHI CHÚ') >= 0) continue;
      const title = (cells[titleIdx] != null ? cells[titleIdx] : cells[1] || '').trim() || code;
      const principal = (cells[principalIdx] != null ? cells[principalIdx] : '').trim();
      let level = (cells[levelIdx] != null ? cells[levelIdx] : 'institute').trim().toLowerCase();
      if (!levels.includes(level)) level = 'institute';
      let status = (cells[statusIdx] != null ? cells[statusIdx] : 'planning').trim().toLowerCase();
      if (!statuses.includes(status)) status = 'planning';
      const start_date = normalizeDate((cells[startIdx] != null ? cells[startIdx] : '').trim());
      const end_date = normalizeDate((cells[endIdx] != null ? cells[endIdx] : '').trim());
      let progress = parseInt(cells[progressIdx], 10);
      if (isNaN(progress)) progress = 0;
      progress = Math.max(0, Math.min(100, progress));
      let budget = null;
      const b = cells[budgetIdx];
      if (b != null && b.trim() !== '') { const n = parseFloat(String(b).replace(/,/g, '.')); if (!isNaN(n)) budget = n; }
      const existing = db.prepare('SELECT id, source_type FROM missions WHERE code = ?').get(code);
      if (existing) {
        db.prepare(
          'UPDATE missions SET title=?, principal=?, level=?, status=?, start_date=?, end_date=?, progress=?, budget=? WHERE code=?'
        ).run(title, principal, level, status, start_date, end_date, progress, budget, code);
        updated++;
      } else {
        db.prepare(
          'INSERT INTO missions (code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)'
        ).run(code, title, principal, level, status, start_date, end_date, progress, budget);
        inserted++;
      }
    }
    if (req.file.path && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.json({
      message: 'Import xong. Đã thêm ' + inserted + ' đề tài, cập nhật ' + updated + ' đề tài. Dashboard sẽ hiển thị số liệu mới.',
      inserted,
      updated
    });
  });

  // Admin: Thêm thủ công 1 đề tài vào bảng missions (upsert theo code)
  router.post('/admin/missions/manual', authMiddleware, adminOnly, (req, res) => {
    const body = req.body || {};
    const code = String(body.code || '').trim();
    const title = String(body.title || '').trim();
    const principal = String(body.principal || '').trim() || null;
    const level = String(body.level || '').trim().toLowerCase();
    const statusResolved = resolveMissionStatusInput(body.status != null && body.status !== '' ? body.status : 'planning');

    if (!code) return res.status(400).json({ message: 'Thiếu mã đề tài (code).' });
    if (!title) return res.status(400).json({ message: 'Thiếu tên đề tài (title).' });
    if (!['national', 'ministry', 'university', 'school', 'coe', 'first', 'institute'].includes(level)) {
      return res.status(400).json({ message: 'Cấp đề tài không hợp lệ. Hãy chọn: national | ministry | university | school | coe | first | institute.' });
    }
    if (!statusResolved) {
      return res.status(400).json({ message: 'Trạng thái không hợp lệ (quá dài hoặc ký tự không được phép).' });
    }

    const normalizeDate = (v) => {
      if (!v) return null;
      const s = String(v).trim();
      if (!s) return null;
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return s.slice(0, 10);
      const parts = s.split(/[/\-.]/).map(p => p.trim()).filter(Boolean);
      if (parts.length < 3) return null;
      const a = parseInt(parts[0], 10);
      const b = parseInt(parts[1], 10);
      const c = parseInt(parts[2], 10);
      if (!isNaN(a) && !isNaN(b) && !isNaN(c)) {
        const year = c;
        const month = Math.max(1, Math.min(12, a));
        const day = Math.max(1, Math.min(31, b));
        return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      }
      return null;
    };

    const start_date = normalizeDate(body.start_date || body.startDate || null);
    const end_date = normalizeDate(body.end_date || body.endDate || null);

    let progress = 0;
    if (body.progress != null && body.progress !== '') {
      progress = parseInt(body.progress, 10);
      if (!isNaN(progress)) progress = Math.max(0, Math.min(100, progress));
      else progress = 0;
    }

    let budget = null;
    if (body.budget != null && String(body.budget).trim() !== '') {
      const n = parseFloat(String(body.budget).replace(/,/g, '.'));
      if (!isNaN(n)) budget = n;
    }

    const existing = db.prepare('SELECT id FROM missions WHERE code = ?').get(code);
    try {
      if (existing) {
        db.prepare(
          'UPDATE missions SET title=?, principal=?, level=?, status=?, start_date=?, end_date=?, progress=?, budget=? WHERE code=?'
        ).run(title, principal, level, statusResolved, start_date, end_date, progress, budget, code);
        return res.json({ ok: true, message: 'Đã cập nhật đề tài.', id: existing.id, updated: true });
      }

      db.prepare(
        `INSERT INTO missions
          (code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'manual')`
      ).run(code, title, principal, level, statusResolved, start_date, end_date, progress, budget);
      const id = db.prepare('SELECT id FROM missions WHERE code=? ORDER BY id DESC LIMIT 1').get(code).id;
      return res.status(201).json({ ok: true, message: 'Đã thêm đề tài thủ công.', id, updated: false });
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi thêm thủ công: ' + (e.message || String(e)) });
    }
  });

  return router;
};
