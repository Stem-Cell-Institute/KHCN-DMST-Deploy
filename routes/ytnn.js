'use strict';

const express = require('express');

/**
 * Pipeline buckets — disjoint status sets per table (aligned with cooperation workflow).
 */
const PIPE = {
  cho_phong: {
    cooperation_doan_ra: ['cho_phong_duyet'],
    cooperation_doan_vao: ['cho_phong_duyet', 'cho_tham_dinh'],
    cooperation_mou_de_xuat: ['cho_phong_duyet', 'dang_tham_dinh'],
    htqt_de_xuat: ['cho_phan_loai', 'cho_phong_duyet', 'dang_tham_dinh'],
  },
  cho_vt: {
    cooperation_doan_ra: ['cho_vt_duyet'],
    cooperation_doan_vao: ['cho_vt_duyet'],
    cooperation_mou_de_xuat: ['cho_vt_duyet'],
    htqt_de_xuat: ['cho_vt_duyet', 'cho_vt_phe_duyet'],
  },
  dang_xu_ly: {
    cooperation_doan_ra: ['yeu_cau_bo_sung', 'dang_chuan_bi', 'cho_ky_duyet'],
    cooperation_doan_vao: ['yeu_cau_bo_sung', 'dang_chuan_bi', 'cho_ky_duyet'],
    cooperation_mou_de_xuat: ['yeu_cau_bo_sung', 'dang_chuan_bi', 'cho_ky_duyet'],
    htqt_de_xuat: ['yeu_cau_bo_sung'],
  },
  da_duyet: {
    cooperation_doan_ra: ['da_duyet'],
    cooperation_doan_vao: ['da_duyet'],
    cooperation_mou_de_xuat: ['da_duyet'],
    htqt_de_xuat: ['da_duyet', 'da_phe_duyet', 'hoan_thanh'],
  },
  tu_choi: {
    cooperation_doan_ra: ['tu_choi', 'khong_phe_duyet'],
    cooperation_doan_vao: ['tu_choi', 'khong_phe_duyet'],
    cooperation_mou_de_xuat: ['tu_choi', 'khong_phe_duyet'],
    htqt_de_xuat: ['tu_choi', 'khong_phe_duyet'],
  },
  ket_thuc: {
    cooperation_doan_ra: ['ket_thuc_boi_nguoi_nop'],
    cooperation_doan_vao: ['ket_thuc_boi_nguoi_nop'],
    cooperation_mou_de_xuat: ['ket_thuc_boi_nguoi_nop'],
    htqt_de_xuat: ['ket_thuc_boi_nguoi_nop'],
  },
};

const DETAIL_LIMIT = 10;
const MODULE_HREF = '/module-hoatac-quocte.html';

function pragmaFk(db) {
  try {
    db.pragma('foreign_keys = ON');
  } catch (e) {
    /* ignore */
  }
}

function safeCount(db, sql, ...params) {
  pragmaFk(db);
  try {
    return (db.prepare(sql).get(...params) || {}).c || 0;
  } catch (e) {
    return 0;
  }
}

function tableToLoai(table) {
  if (table === 'cooperation_doan_ra') return 'doan_ra';
  if (table === 'cooperation_doan_vao') return 'doan_vao';
  if (table === 'cooperation_mou_de_xuat') return 'mou';
  if (table === 'htqt_de_xuat') return 'ytnn';
  return 'unknown';
}

function countBucket(db, bucket) {
  const spec = PIPE[bucket];
  if (!spec) return 0;
  let n = 0;
  for (const [table, statuses] of Object.entries(spec)) {
    if (!statuses || !statuses.length) continue;
    const ph = statuses.map(() => '?').join(',');
    const sql = `SELECT COUNT(*) AS c FROM ${table} WHERE lower(trim(COALESCE(status,''))) IN (${ph})`;
    n += safeCount(db, sql, ...statuses);
  }
  return n;
}

function fetchDetailRows(db, bucket) {
  const spec = PIPE[bucket];
  if (!spec) return [];
  const merged = [];
  for (const [table, statuses] of Object.entries(spec)) {
    if (!statuses || !statuses.length) continue;
    const ph = statuses.map(() => '?').join(',');
    let sql;
    if (table === 'cooperation_doan_ra') {
      sql =
        `SELECT id,
          COALESCE(NULLIF(TRIM(muc_dich),''), TRIM(quoc_gia), 'Đoàn ra') AS ten_de_xuat,
          submitted_by_name AS nguoi_tao, created_at AS ngay_tao, status AS trang_thai
         FROM cooperation_doan_ra
         WHERE lower(trim(COALESCE(status,''))) IN (${ph})
         ORDER BY datetime(created_at) DESC LIMIT ?`;
    } else if (table === 'cooperation_doan_vao') {
      sql =
        `SELECT id,
          COALESCE(NULLIF(TRIM(muc_dich),''), TRIM(don_vi_de_xuat), 'Đoàn vào') AS ten_de_xuat,
          submitted_by_name AS nguoi_tao, created_at AS ngay_tao, status AS trang_thai
         FROM cooperation_doan_vao
         WHERE lower(trim(COALESCE(status,''))) IN (${ph})
         ORDER BY datetime(created_at) DESC LIMIT ?`;
    } else if (table === 'cooperation_mou_de_xuat') {
      sql =
        `SELECT id,
          COALESCE(NULLIF(TRIM(ten_doi_tac),''), 'MOU') AS ten_de_xuat,
          submitted_by_name AS nguoi_tao, created_at AS ngay_tao, status AS trang_thai
         FROM cooperation_mou_de_xuat
         WHERE lower(trim(COALESCE(status,''))) IN (${ph})
         ORDER BY datetime(created_at) DESC LIMIT ?`;
    } else if (table === 'htqt_de_xuat') {
      sql =
        `SELECT id,
          COALESCE(NULLIF(TRIM(ten),''), 'YTNN') AS ten_de_xuat,
          submitted_by_name AS nguoi_tao, created_at AS ngay_tao, status AS trang_thai
         FROM htqt_de_xuat
         WHERE lower(trim(COALESCE(status,''))) IN (${ph})
         ORDER BY datetime(created_at) DESC LIMIT ?`;
    } else {
      continue;
    }
    try {
      pragmaFk(db);
      const rows = db.prepare(sql).all(...statuses, DETAIL_LIMIT);
      for (const r of rows || []) {
        merged.push({
          id: r.id,
          ten_de_xuat: r.ten_de_xuat,
          nguoi_tao: r.nguoi_tao || '—',
          ngay_tao: r.ngay_tao || '—',
          loai: tableToLoai(table),
          trang_thai: r.trang_thai || '',
          link: MODULE_HREF,
        });
      }
    } catch (e) {
      /* table or column missing */
    }
  }
  merged.sort((a, b) => String(b.ngay_tao).localeCompare(String(a.ngay_tao)));
  return merged.slice(0, DETAIL_LIMIT);
}

function last12MonthMeta() {
  const keys = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push({
      ym: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      thang: d.getMonth() + 1,
      nam: d.getFullYear(),
    });
  }
  return keys;
}

function monthCountsByYm(db, table) {
  const map = {};
  try {
    pragmaFk(db);
    const rows = db
      .prepare(
        `SELECT strftime('%Y-%m', created_at) AS ym, COUNT(*) AS c FROM ${table}
         WHERE created_at IS NOT NULL AND trim(CAST(created_at AS TEXT)) != ''
         GROUP BY ym HAVING ym IS NOT NULL AND length(ym) >= 7`
      )
      .all();
    for (const r of rows || []) map[r.ym] = r.c || 0;
  } catch (e) {
    /* ignore */
  }
  return map;
}

function buildMonthly(db) {
  const meta = last12MonthMeta();
  const mRa = monthCountsByYm(db, 'cooperation_doan_ra');
  const mVa = monthCountsByYm(db, 'cooperation_doan_vao');
  const mMou = monthCountsByYm(db, 'cooperation_mou_de_xuat');
  return meta.map(({ ym, thang, nam }) => {
    const a = mRa[ym] || 0;
    const b = mVa[ym] || 0;
    const c = mMou[ym] || 0;
    return { thang, nam, ym, tong: a + b + c, doan_ra: a, doan_vao: b, mou: c };
  });
}

function buildCanhBao(db) {
  return {
    thoaThuanHieuLuc: safeCount("SELECT COUNT(*) AS c FROM cooperation_thoa_thuan WHERE trang_thai='hieu_luc'"),
    suKienSapDienRa: safeCount("SELECT COUNT(*) AS c FROM cooperation_su_kien WHERE status='sap_dien_ra'"),
    hnhtSap30: safeCount(
      `SELECT COUNT(*) AS c FROM conference_registrations WHERE status = 'director_approved'
       AND julianday(conf_start_date) >= julianday('now')
       AND julianday(conf_start_date) <= julianday('now', '+30 days')`
    ),
    hnhtQuaHan15: safeCount(
      `SELECT COUNT(*) AS c FROM conference_registrations WHERE status = 'director_approved'
       AND julianday('now') - julianday(conf_end_date) > 15`
    ),
    deTaiYTNN: safeCount(
      `SELECT COUNT(*) AS c FROM htqt_de_xuat WHERE lower(trim(status)) IN (
        'cho_phan_loai','cho_phong_duyet','dang_tham_dinh','cho_vt_duyet','cho_vt_phe_duyet','yeu_cau_bo_sung'
      )`
    ),
  };
}

function buildStatsPayload(db) {
  const total =
    safeCount('SELECT COUNT(*) AS c FROM cooperation_doan_ra') +
    safeCount('SELECT COUNT(*) AS c FROM cooperation_doan_vao') +
    safeCount('SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat');

  const doanRa = safeCount('SELECT COUNT(*) AS c FROM cooperation_doan_ra');
  const doanVao = safeCount('SELECT COUNT(*) AS c FROM cooperation_doan_vao');
  const mou = safeCount('SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat');

  return {
    total,
    doanRa,
    doanVao,
    mou,
    choPhong: countBucket(db, 'cho_phong'),
    choVT: countBucket(db, 'cho_vt'),
    dangXuLy: countBucket(db, 'dang_xu_ly'),
    daDuyet: countBucket(db, 'da_duyet'),
    tuChoi: countBucket(db, 'tu_choi'),
    ketThuc: countBucket(db, 'ket_thuc'),
  };
}

/**
 * @param {{ db: import('better-sqlite3').Database, coopDashboardViewer: import('express').RequestHandler }} opts
 */
function createYtnnRouter(opts) {
  const db = opts.db;
  const coopDashboardViewer = opts.coopDashboardViewer;
  if (!db || typeof coopDashboardViewer !== 'function') {
    throw new Error('createYtnnRouter: db and coopDashboardViewer are required');
  }

  const router = express.Router();

  router.get('/dashboard', coopDashboardViewer, (req, res) => {
    try {
      pragmaFk(db);
      const stats = buildStatsPayload(db);
      const monthly = buildMonthly(db);
      const canhBao = buildCanhBao(db);
      const lastUpdated = new Date().toLocaleString('vi-VN');
      res.render('ytnn/dashboard', {
        stats,
        monthly,
        lastUpdated,
        canhBao,
      });
    } catch (e) {
      console.error('[ytnn/dashboard]', e);
      res.status(500).send('Không tải được dashboard.');
    }
  });

  router.get('/api/dashboard/stats', coopDashboardViewer, (req, res) => {
    try {
      pragmaFk(db);
      const stats = buildStatsPayload(db);
      res.json({
        ...stats,
        lastUpdated: new Date().toISOString(),
      });
    } catch (e) {
      console.error('[ytnn/api/dashboard/stats]', e);
      res.status(500).json({ message: 'Không tải được thống kê.' });
    }
  });

  router.get('/api/dashboard/detail', coopDashboardViewer, (req, res) => {
    const status = String(req.query.status || '').trim();
    const allowed = Object.keys(PIPE);
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: 'status không hợp lệ', allowed });
    }
    try {
      pragmaFk(db);
      const rows = fetchDetailRows(db, status);
      res.json(rows);
    } catch (e) {
      console.error('[ytnn/api/dashboard/detail]', e);
      res.status(500).json({ message: 'Không tải được chi tiết.' });
    }
  });

  return router;
}

module.exports = createYtnnRouter;
