'use strict';

/**
 * Sự kiện (Events workflow) — 13 endpoint /api/events/*.
 *
 * Tách khỏi server.js (Đợt 5.1 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/cooperationHtqtEvents.test.js.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const EVENT_STATUS_ORDER = ['draft', 'cho_xin_phep', 'da_nop_xin_phep', 'da_duoc_phep', 'dang_to_chuc', 'cho_bao_cao', 'da_bao_cao', 'hoan_thanh'];
const EVENT_TRANSITIONS = {
  draft: ['cho_xin_phep'],
  cho_xin_phep: ['da_nop_xin_phep'],
  da_nop_xin_phep: ['da_duoc_phep'],
  da_duoc_phep: ['dang_to_chuc'],
  dang_to_chuc: ['cho_bao_cao'],
  cho_bao_cao: ['da_bao_cao'],
  da_bao_cao: ['hoan_thanh'],
};

function eventNormStatus(s) {
  const v = String(s || '').trim().toLowerCase();
  return EVENT_STATUS_ORDER.includes(v) ? v : 'draft';
}

module.exports = function createEventsRouter({
  db,
  rootDir,
  uploadDir,
  UPLOAD_FILE_BYTES_SUBMISSION,
  MULTIPART_MAX_FIELD_BYTES,
  authMiddleware,
  coopPhongOrAdmin,
  adminOnly,
  fixFilenameEncoding,
  resolveEventUploadFileForUnlink,
  toVietnameseCurrencyWords,
  buildEventPermissionDocBuffer,
  buildEventReportDocBuffer,
  setContentDisposition,
}) {
  const router = express.Router();

  function eventGetById(id) { return db.prepare('SELECT * FROM events WHERE id = ? AND deleted_at IS NULL').get(id); }
  function eventGetSessions(id) { return db.prepare('SELECT id, event_id, ngay, gio_bat_dau, gio_ket_thuc, noi_dung, thu_tu FROM event_sessions WHERE event_id = ? ORDER BY COALESCE(thu_tu, 999), id').all(id); }
  function eventGetFiles(id) { return db.prepare('SELECT id, event_id, loai_file, ten_file, duong_dan, mo_ta, nguoi_upload, ngay_upload FROM event_files WHERE event_id = ? ORDER BY ngay_upload DESC, id DESC').all(id); }
  function eventGenSoVanBan() {
    const y = String(new Date().getFullYear());
    const row = db.prepare('SELECT COUNT(*) AS c FROM events WHERE strftime("%Y", COALESCE(ngay_tao, datetime("now"))) = ?').get(y);
    return String(((row && row.c) || 0) + 1) + '/SCI-KHCN&QHĐN';
  }
  function eventStatusTransitionError(ev, toStatus) {
    const from = eventNormStatus(ev.trang_thai);
    const to = eventNormStatus(toStatus);
    if (!(EVENT_TRANSITIONS[from] || []).includes(to)) return 'Không đúng thứ tự chuyển trạng thái.';
    if (to === 'da_duoc_phep') {
      const has = db.prepare("SELECT 1 FROM event_files WHERE event_id = ? AND loai_file = 'quyet_dinh_cho_phep' LIMIT 1").get(ev.id);
      if (!has) return 'Cần upload Quyết định cho phép trước khi chuyển trạng thái này.';
    }
    if (to === 'da_bao_cao') {
      const has = db.prepare("SELECT 1 FROM event_files WHERE event_id = ? AND loai_file IN ('bao_cao_su_kien','quyet_dinh_bao_cao') LIMIT 1").get(ev.id);
      if (!has) return 'Cần upload Báo cáo có dấu đỏ trước khi chuyển trạng thái này.';
    }
    return '';
  }

  const uploadEventFiles = multer({
    storage: multer.diskStorage({
      destination: function (req, _file, cb) {
        const id = parseInt(req.params.id, 10);
        const dir = path.join(uploadDir, 'events', String(id));
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: function (_req, file, cb) {
        const ext = path.extname(file.originalname || '') || '.bin';
        const safe = path.basename(file.originalname || 'file', ext).replace(/[^\w\-]+/g, '_').slice(0, 80);
        cb(null, Date.now() + '_' + safe + ext.toLowerCase());
      },
    }),
    limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES, files: 10 },
    fileFilter: function (_req, file, cb) {
      const n = (file.originalname || '').toLowerCase();
      if (!/\.(pdf|doc|docx|jpg|jpeg|png)$/i.test(n)) return cb(new Error('Chỉ nhận PDF, DOC, DOCX, JPG, PNG'));
      cb(null, true);
    },
  });

  router.get('/events', authMiddleware, (req, res) => {
    try {
      const q = req.query || {};
      const conds = ['deleted_at IS NULL'];
      const params = [];
      if (q.loai) { conds.push('loai = ?'); params.push(String(q.loai)); }
      if (q.trang_thai) { conds.push('trang_thai = ?'); params.push(eventNormStatus(q.trang_thai)); }
      if (q.nam) { conds.push('strftime("%Y", COALESCE(ngay_bat_dau, ngay_tao)) = ?'); params.push(String(q.nam)); }
      const list = db.prepare(`SELECT id, so_van_ban, tieu_de, loai, ngay_bat_dau, ngay_ket_thuc, trang_thai, ngay_tao FROM events WHERE ${conds.join(' AND ')} ORDER BY COALESCE(ngay_bat_dau, ngay_tao) DESC, id DESC`).all(...params);
      return res.json({ ok: true, list });
    } catch (e) { return res.status(500).json({ message: 'Lỗi tải danh sách sự kiện: ' + e.message }); }
  });

  router.post('/events', authMiddleware, coopPhongOrAdmin, (req, res) => {
    const b = req.body || {};
    if (!String(b.tieu_de || '').trim() || !String(b.ngay_bat_dau || '').trim()) return res.status(400).json({ message: 'Thiếu Tên sự kiện hoặc Ngày bắt đầu.' });
    try {
      const so = String(b.so_van_ban || '').trim() || eventGenSoVanBan();
      const ins = db.prepare(`INSERT INTO events (so_van_ban,tieu_de,loai,don_vi_to_chuc,hinh_thuc,link_su_kien,dia_diem,quy_mo,lich_trinh,muc_tieu,thanh_phan_tham_du,kinh_phi_du_kien,nguon_kinh_phi,ngay_bat_dau,ngay_ket_thuc,han_dang_ky,nguoi_tao,trang_thai,nguoi_phu_trach,phu_trach_lien_he,ghi_chu) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(so, b.tieu_de || '', b.loai || 'Hội thảo', b.don_vi_to_chuc || '', b.hinh_thuc || '', b.link_su_kien || '', b.dia_diem || '', b.quy_mo ? Number(b.quy_mo) : null, JSON.stringify(b.lich_trinh || []), b.muc_tieu || '', b.thanh_phan_tham_du || '', b.kinh_phi_du_kien ? Number(b.kinh_phi_du_kien) : 0, b.nguon_kinh_phi || '', b.ngay_bat_dau || '', b.ngay_ket_thuc || '', b.han_dang_ky || '', req.user.fullname || req.user.email || '', eventNormStatus(b.trang_thai || 'draft'), b.nguoi_phu_trach || '', b.phu_trach_lien_he || '', b.ghi_chu || '');
      const id = Number(ins.lastInsertRowid);
      db.prepare('INSERT INTO event_status_history (event_id, from_status, to_status, note, changed_by_id, changed_by_name) VALUES (?, ?, ?, ?, ?, ?)').run(id, null, eventNormStatus(b.trang_thai || 'draft'), 'Tạo sự kiện', req.user.id || null, req.user.fullname || req.user.email || '');
      return res.status(201).json({ ok: true, id, so_van_ban: so });
    } catch (e) { return res.status(500).json({ message: 'Lỗi tạo sự kiện: ' + e.message }); }
  });

  router.get('/events/:id', authMiddleware, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
    const event = eventGetById(id);
    if (!event) return res.status(404).json({ message: 'Không tìm thấy sự kiện' });
    const sessions = eventGetSessions(id);
    const files = eventGetFiles(id);
    const history = db.prepare('SELECT * FROM event_status_history WHERE event_id = ? ORDER BY id DESC').all(id);
    return res.json({ ok: true, event, sessions, files, history });
  });

  router.put('/events/:id', authMiddleware, coopPhongOrAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const sets = [], vals = [];
    ['so_van_ban', 'tieu_de', 'loai', 'don_vi_to_chuc', 'hinh_thuc', 'link_su_kien', 'dia_diem', 'quy_mo', 'lich_trinh', 'muc_tieu', 'thanh_phan_tham_du', 'kinh_phi_du_kien', 'nguon_kinh_phi', 'ngay_bat_dau', 'ngay_ket_thuc', 'han_dang_ky', 'so_nguoi_tham_du_thuc_te', 'ket_qua_su_kien', 'de_xuat_kien_nghi', 'bai_hoc_kinh_nghiem', 'uu_diem', 'han_che', 'nguoi_phu_trach', 'phu_trach_lien_he', 'ghi_chu'].forEach((k) => {
      if (b[k] !== undefined) { sets.push(`${k}=?`); vals.push(k === 'lich_trinh' ? JSON.stringify(b[k] || []) : b[k]); }
    });
    if (!sets.length) return res.status(400).json({ message: 'Không có gì cập nhật.' });
    vals.push(id);
    const r = db.prepare(`UPDATE events SET ${sets.join(',')} WHERE id = ? AND deleted_at IS NULL`).run(...vals);
    if (!r.changes) return res.status(404).json({ message: 'Không tìm thấy sự kiện' });
    return res.json({ ok: true, message: 'Đã cập nhật.' });
  });

  router.delete('/events/:id', authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
    db.prepare("UPDATE events SET deleted_at = datetime('now','localtime') WHERE id = ?").run(id);
    return res.json({ ok: true, message: 'Đã xóa sự kiện.' });
  });

  router.patch('/events/:id/status', authMiddleware, coopPhongOrAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const to = eventNormStatus((req.body || {}).to_status);
    const note = String((req.body || {}).note || '').slice(0, 2000);
    const ev = eventGetById(id);
    if (!ev) return res.status(404).json({ message: 'Không tìm thấy sự kiện' });
    const err = eventStatusTransitionError(ev, to);
    if (err) return res.status(400).json({ message: err });
    const from = eventNormStatus(ev.trang_thai);
    db.prepare('UPDATE events SET trang_thai = ? WHERE id = ?').run(to, id);
    db.prepare('INSERT INTO event_status_history (event_id, from_status, to_status, note, changed_by_id, changed_by_name) VALUES (?, ?, ?, ?, ?, ?)').run(id, from, to, note || null, req.user.id || null, req.user.fullname || req.user.email || '');
    return res.json({ ok: true, from_status: from, to_status: to });
  });

  router.get('/events/:id/sessions', authMiddleware, (req, res) => {
    const id = parseInt(req.params.id, 10);
    return res.json({ ok: true, list: eventGetSessions(id) });
  });

  router.put('/events/:id/sessions', authMiddleware, coopPhongOrAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const list = Array.isArray((req.body || {}).sessions) ? req.body.sessions : [];
    if (!eventGetById(id)) return res.status(404).json({ message: 'Không tìm thấy sự kiện' });
    db.transaction(() => {
      db.prepare('DELETE FROM event_sessions WHERE event_id = ?').run(id);
      const ins = db.prepare('INSERT INTO event_sessions (event_id, ngay, gio_bat_dau, gio_ket_thuc, noi_dung, thu_tu) VALUES (?, ?, ?, ?, ?, ?)');
      list.forEach((s, i) => ins.run(id, s.ngay || '', s.gio_bat_dau || '', s.gio_ket_thuc || '', s.noi_dung || '', i + 1));
      db.prepare('UPDATE events SET lich_trinh = ? WHERE id = ?').run(JSON.stringify(list), id);
    })();
    return res.json({ ok: true, count: list.length });
  });

  router.post('/events/:id/files', authMiddleware, coopPhongOrAdmin, (req, res) => {
    uploadEventFiles.array('files', 10)(req, res, (err) => {
      if (err) return res.status(400).json({ message: 'Upload thất bại' });
      const id = parseInt(req.params.id, 10);
      if (!eventGetById(id)) return res.status(404).json({ message: 'Không tìm thấy sự kiện' });
      const loai = String((req.body || {}).loai_file || 'khac');
      const moTa = (req.body || {}).mo_ta ? String(req.body.mo_ta).slice(0, 2000) : null;
      const out = [];
      for (const f of req.files || []) {
        const rel = path.join('uploads', 'events', String(id), f.filename).replace(/\\/g, '/');
        const tenFile = fixFilenameEncoding(f.originalname) || f.filename;
        const ins = db.prepare('INSERT INTO event_files (event_id, loai_file, ten_file, duong_dan, mo_ta, nguoi_upload) VALUES (?, ?, ?, ?, ?, ?)').run(id, loai, tenFile, rel, moTa, req.user.fullname || req.user.email || '');
        out.push({ id: Number(ins.lastInsertRowid), ten_file: tenFile, duong_dan: rel, loai_file: loai });
      }
      return res.json({ ok: true, files: out });
    });
  });

  router.get('/events/:id/files', authMiddleware, (req, res) => {
    const id = parseInt(req.params.id, 10);
    return res.json({ ok: true, list: eventGetFiles(id) });
  });

  router.delete('/events/:id/files/:fileId', authMiddleware, coopPhongOrAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const fid = parseInt(req.params.fileId, 10);
    const row = db.prepare('SELECT * FROM event_files WHERE id = ? AND event_id = ?').get(fid, id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy file' });
    try {
      const abs = resolveEventUploadFileForUnlink(row.duong_dan, id);
      if (abs) fs.unlinkSync(abs);
    } catch (_) {}
    db.prepare('DELETE FROM event_files WHERE id = ?').run(fid);
    return res.json({ ok: true });
  });

  router.post('/events/:id/export/to-trinh', authMiddleware, coopPhongOrAdmin, async (req, res) => {
    try {
      const tpl = path.join(rootDir, 'templates', 'events', 'to_trinh_xin_phep.docx');
      if (!fs.existsSync(tpl)) {
        return res.status(400).json({ message: 'Thiếu template Word: templates/events/to_trinh_xin_phep.docx. Vui lòng đặt đúng file mẫu để xuất đúng định dạng.' });
      }
      const id = parseInt(req.params.id, 10);
      const ev = eventGetById(id);
      if (!ev) return res.status(404).json({ message: 'Không tìm thấy sự kiện' });
      const sessions = eventGetSessions(id);
      const data = {
        so_van_ban: ev.so_van_ban || '',
        tieu_de: ev.tieu_de || '',
        loai: ev.loai || '',
        hinh_thuc: ev.hinh_thuc || '',
        dia_diem: ev.dia_diem || '',
        link_su_kien: ev.link_su_kien || '',
        quy_mo: ev.quy_mo || '',
        muc_tieu: ev.muc_tieu || '',
        thanh_phan_tham_du: ev.thanh_phan_tham_du || '',
        kinh_phi_du_kien: ev.kinh_phi_du_kien || 0,
        kinh_phi_bang_chu: toVietnameseCurrencyWords(ev.kinh_phi_du_kien || 0),
        nguon_kinh_phi: ev.nguon_kinh_phi || '',
        ngay_bat_dau: ev.ngay_bat_dau || '',
        ngay_ket_thuc: ev.ngay_ket_thuc || '',
        lich_trinh: sessions.map((s, i) => ({ stt: i + 1, ngay: s.ngay || '', gio_bat_dau: s.gio_bat_dau || '', gio_ket_thuc: s.gio_ket_thuc || '', noi_dung: s.noi_dung || '' })),
      };
      const buf = await buildEventPermissionDocBuffer(data);
      const fn = 'to_trinh_xin_phep_' + id + '_' + Date.now() + '.docx';
      const dir = path.join(uploadDir, 'events', String(id)); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, fn), buf);
      const rel = path.join('uploads', 'events', String(id), fn).replace(/\\/g, '/');
      db.prepare('INSERT INTO event_files (event_id, loai_file, ten_file, duong_dan, mo_ta, nguoi_upload) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'to_trinh_xin_phep', fn, rel, 'Word tờ trình sinh tự động', req.user.fullname || req.user.email || '');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      setContentDisposition(res, fn);
      return res.send(buf);
    } catch (e) { return res.status(500).json({ message: 'Lỗi xuất Word: ' + e.message }); }
  });

  router.post('/events/:id/export/bao-cao', authMiddleware, coopPhongOrAdmin, async (req, res) => {
    try {
      const tpl = path.join(rootDir, 'templates', 'events', 'bao_cao_su_kien.docx');
      if (!fs.existsSync(tpl)) {
        return res.status(400).json({ message: 'Thiếu template Word: templates/events/bao_cao_su_kien.docx. Vui lòng đặt đúng file mẫu để xuất đúng định dạng.' });
      }
      const id = parseInt(req.params.id, 10);
      const ev = eventGetById(id);
      if (!ev) return res.status(404).json({ message: 'Không tìm thấy sự kiện' });
      const sessions = eventGetSessions(id);
      const data = { tieu_de: ev.tieu_de || '', ngay_bat_dau: ev.ngay_bat_dau || '', ngay_ket_thuc: ev.ngay_ket_thuc || '', so_nguoi_tham_du_thuc_te: ev.so_nguoi_tham_du_thuc_te || '', ket_qua_su_kien: ev.ket_qua_su_kien || '', de_xuat_kien_nghi: ev.de_xuat_kien_nghi || '', bai_hoc_kinh_nghiem: ev.bai_hoc_kinh_nghiem || '', uu_diem: ev.uu_diem || '', han_che: ev.han_che || '', lich_trinh: sessions };
      const buf = await buildEventReportDocBuffer(data);
      const fn = 'bao_cao_su_kien_' + id + '_' + Date.now() + '.docx';
      const dir = path.join(uploadDir, 'events', String(id)); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, fn), buf);
      const rel = path.join('uploads', 'events', String(id), fn).replace(/\\/g, '/');
      db.prepare('INSERT INTO event_files (event_id, loai_file, ten_file, duong_dan, mo_ta, nguoi_upload) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'bao_cao_su_kien', fn, rel, 'Word báo cáo sinh tự động', req.user.fullname || req.user.email || '');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      setContentDisposition(res, fn);
      return res.send(buf);
    } catch (e) { return res.status(500).json({ message: 'Lỗi xuất Word: ' + e.message }); }
  });

  return router;
};
