'use strict';

/**
 * Nhiệm vụ KHCN — nhóm lõi: thống kê, danh sách tìm kiếm, đăng ký đề tài mới.
 *
 *   GET  /api/missions/stats
 *   GET  /api/missions
 *   POST /api/missions
 *
 * Tách khỏi server.js (Đợt 1.1 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi
 * từng endpoint: đường dẫn, tham số, mã trạng thái, thông báo lỗi. Không sửa một dòng
 * logic nào — chỉ cắt–dán và đổi `app.` thành `router.`.
 *
 * LƯU Ý THỨ TỰ: router này phải mount TRƯỚC handler '/api/missions/:id' còn trong
 * server.js. Handler đó trả 400 «ID không hợp lệ» và KHÔNG gọi next(), nên mọi route
 * có segment chữ sau /api/missions/ (ở đây là 'stats') mà đăng ký sau nó sẽ chết im
 * lặng — không phải 404 mà là 400, rất khó truy.
 *
 * `transporter` truyền theo giá trị là an toàn: server.js gán nó ở dòng ~3412, trước
 * điểm mount này. Nếu sau này mount sớm hơn, phải đổi sang truyền hàm getter.
 */

const express = require('express');

module.exports = function createMissionsCoreRouter({
  db,
  authMiddleware,
  transporter,
  PORT,
  syncMissionsFromCapVien,
  getSmtpFrom,
  getNotificationEmails,
}) {
const router = express.Router();

router.get('/missions/stats', authMiddleware, (req, res) => {
  syncMissionsFromCapVien();
  const all = db.prepare('SELECT id, level, status, end_date, budget, start_date FROM missions').all();
  const now = new Date().toISOString().slice(0, 10);
  const thisMonthStart = now.slice(0, 7) + '-01';
  const byLevel = { national: 0, ministry: 0, university: 0, school: 0, institute: 0 };
  const byStatus = { planning: 0, approved: 0, ongoing: 0, review: 0, completed: 0, overdue: 0, cho_phe_duyet_ngoai: 0, da_phe_duyet: 0, dang_thuc_hien: 0, nghiem_thu_trung_gian: 0, nghiem_thu_tong_ket: 0, hoan_thanh: 0, khong_duoc_phe_duyet: 0, cho_vien_xet_chon: 0, cho_bo_tham_dinh: 0, cho_ngoai_xet_chon: 0, cho_ky_hop_dong: 0, xin_dieu_chinh: 0, cho_nghiem_thu_co_so: 0, cho_nghiem_thu_bo_nn: 0, hoan_thien_sau_nghiem_thu: 0, thanh_ly_hop_dong: 0 };
  let totalBudget = 0;
  let overdue = 0;
  let completed = 0;
  let totalEnded = 0;
  let acceptanceThisMonth = 0;
  for (const m of all) {
    const lev = (m.level || 'institute').toLowerCase();
    if (byLevel[lev] !== undefined) byLevel[lev]++;
    const st = (m.status || 'planning').toLowerCase();
    if (byStatus[st] !== undefined) byStatus[st]++;
    if (m.budget != null) totalBudget += Number(m.budget);
    const isCompleted = ['completed', 'hoan_thanh'].includes(st);
    if (m.end_date && m.end_date < now && !isCompleted) overdue++;
    if (isCompleted) { completed++; totalEnded++; }
    else if (m.end_date) totalEnded++;
    if (['review', 'nghiem_thu_trung_gian', 'nghiem_thu_tong_ket', 'cho_nghiem_thu_co_so', 'cho_nghiem_thu_bo_nn', 'hoan_thien_sau_nghiem_thu'].includes(st)) acceptanceThisMonth++;
  }
  const completionRate = totalEnded > 0 ? Math.round((completed / totalEnded) * 100) : 0;
  return res.json({
    total: all.length,
    byLevel,
    byStatus,
    totalBudget: Math.round(totalBudget),
    overdue,
    completionRate,
    acceptanceThisMonth,
    totalOngoing: (byStatus.ongoing || 0) + (byStatus.dang_thuc_hien || 0)
  });
});

/** Tìm kiếm nhiệm vụ: gộp dấu + nhiều từ (AND), giống tinh thần module Quản lý công bố */
function missionSearchFold(s) {
  try {
    return String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  } catch (e) {
    return String(s == null ? '' : s).toLowerCase();
  }
}

const MISSION_LEVEL_SEARCH_LABELS = {
  national: 'Cấp Nhà nước cap quoc gia',
  ministry: 'Cấp Bộ bo',
  university: 'Cấp ĐHQG dai hoc quoc gia',
  school: 'Cấp Trường ĐH KHTN truong dai hoc khoa hoc tu nhien',
  institute: 'Cấp Viện vien co so',
};

const MISSION_STATUS_SEARCH_LABELS = {
  planning: 'Lập kế hoạch lap ke hoach',
  approved: 'Đã phê duyệt da phe duyet',
  ongoing: 'Đang thực hiện dang thuc hien',
  review: 'Nghiệm thu nghiem thu',
  completed: 'Hoàn thành hoan thanh',
  overdue: 'Quá hạn qua han',
  cho_phe_duyet_ngoai: 'Chờ phê duyệt ngoài cho phe duyet ngoai',
  da_phe_duyet: 'Đã phê duyệt da phe duyet',
  dang_thuc_hien: 'Đang thực hiện dang thuc hien',
  nghiem_thu_trung_gian: 'Nghiệm thu cơ sở Viện nghiem thu co so',
  nghiem_thu_tong_ket: 'Nghiệm thu cấp Bộ NN nghiem thu bo',
  hoan_thanh: 'Hoàn thành hoan thanh',
  khong_duoc_phe_duyet: 'Không được phê duyệt khong duoc phe duyet',
  cho_vien_xet_chon: 'Chờ HĐ Viện xét chọn cho hoi dong vien',
  cho_ct_hd_xet_duyet: 'Chờ CT HĐ KHCN xét duyệt chu tich hoi dong',
  buoc4a: 'Bước 4A Nhánh A buoc 4a',
  buoc4b: 'Bước 4B Nhánh B buoc 4b',
  cho_bo_tham_dinh: 'Chờ Bộ thẩm định cho bo tham dinh',
  cho_ngoai_xet_chon: 'Chờ cơ quan ngoài xét chọn cho ngoai',
  cho_phe_duyet_chinh_thuc: 'Chờ phê duyệt chính thức cho phe duyet chinh thuc',
  cho_ky_hop_dong: 'Chờ ký hợp đồng cho ky hop dong',
  dung_khong_dat_dot: 'Dừng không đạt đợt dung khong dat dot',
  xin_dieu_chinh: 'Xin điều chỉnh nội dung xin dieu chinh',
  cho_nghiem_thu_co_so: 'Chờ nghiệm thu cơ sở cho nghiem thu co so',
  cho_nghiem_thu_bo_nn: 'Chờ nghiệm thu cấp Bộ NN cho nghiem thu bo',
  hoan_thien_sau_nghiem_thu: 'Hoàn thiện sau nghiệm thu hoan thien sau nghiem thu',
  thanh_ly_hop_dong: 'Thanh lý hợp đồng thanh ly hop dong',
};

function missionFormatDateVn(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function missionHaystackNumberVi(n) {
  if (n == null || n === '') return '';
  try {
    return new Intl.NumberFormat('vi-VN').format(Number(n));
  } catch (e) {
    return String(n);
  }
}

function buildMissionSearchHaystack(r) {
  const chunks = [];
  const push = (v) => {
    if (v == null || v === '') return;
    chunks.push(String(v));
  };
  push(r.id);
  push(r.code);
  push(r.title);
  push(r.principal);
  push(r.principal_hoc_vi);
  push(r.principal_don_vi);
  push(r.principal_orcid);
  push(r.level);
  push(r.status);
  push(r.start_date);
  push(r.end_date);
  push(missionFormatDateVn(r.start_date));
  push(missionFormatDateVn(r.end_date));
  if (r.progress != null && r.progress !== '') {
    push(String(r.progress));
    push(`${r.progress}%`);
  }
  push(r.budget);
  push(missionHaystackNumberVi(r.budget));
  push(r.managing_agency);
  push(r.contract_number);
  push(r.funding_source);
  push(r.cooperating_units);
  push(r.mission_type);
  push(r.field);
  push(r.objectives);
  push(r.disbursement_year);
  push(r.approved_budget);
  push(missionHaystackNumberVi(r.approved_budget));
  push(r.disbursed_budget);
  push(missionHaystackNumberVi(r.disbursed_budget));
  push(r.source_type);
  push(r.source_id);
  const lv = MISSION_LEVEL_SEARCH_LABELS[r.level];
  if (lv) push(lv);
  const st = MISSION_STATUS_SEARCH_LABELS[r.status];
  if (st) push(st);
  if (r.source_type === 'cap_vien') {
    push('de tai cap vien dong bo cap vien hồ sơ cấp viện');
  }
  try {
    push(JSON.stringify(r));
  } catch (e) {}
  return missionSearchFold(chunks.join(' '));
}

function missionSearchQueryMatchesRow(r, queryRaw) {
  const qFold = missionSearchFold(queryRaw).trim();
  if (!qFold) return true;
  const tokens = qFold.split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = buildMissionSearchHaystack(r);
  return tokens.every((t) => hay.includes(t));
}

router.get('/missions', authMiddleware, (req, res) => {
  syncMissionsFromCapVien();
  const qRaw = (req.query.q || req.query.search || '').trim();
  const level = (req.query.level || '').trim().toLowerCase();
  const status = (req.query.status || '').trim().toLowerCase();
  const year = (req.query.year || '').trim();
  const whereParts = [];
  const params = [];
  if (level) {
    whereParts.push('level = ?');
    params.push(level);
  }
  if (status) {
    const statusList = status.split(',').map((s) => s.trim()).filter(Boolean);
    if (statusList.length === 1) {
      whereParts.push('status = ?');
      params.push(statusList[0]);
    } else if (statusList.length > 1) {
      whereParts.push('status IN (' + statusList.map(() => '?').join(',') + ')');
      params.push(...statusList);
    }
  }
  if (year) {
    whereParts.push('(start_date LIKE ? OR end_date LIKE ?)');
    params.push(year + '%', year + '%');
  }
  const whereSql = whereParts.length ? ' AND ' + whereParts.join(' AND ') : '';
  const orderSql = ' ORDER BY start_date DESC, id DESC';
  const selectBases = [
    'SELECT id, code, title, principal, principal_hoc_vi, principal_don_vi, principal_orcid, level, status, start_date, end_date, progress, budget, managing_agency, contract_number, funding_source, cooperating_units, mission_type, field, objectives, disbursement_year, approved_budget, disbursed_budget, source_id, source_type FROM missions WHERE 1=1',
    'SELECT id, code, title, principal, principal_hoc_vi, principal_don_vi, principal_orcid, level, status, start_date, end_date, progress, budget, source_id, source_type FROM missions WHERE 1=1',
    'SELECT id, code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type FROM missions WHERE 1=1',
  ];
  let rows;
  let lastErr;
  for (let i = 0; i < selectBases.length; i++) {
    const sql = selectBases[i] + whereSql + orderSql;
    try {
      rows = params.length ? db.prepare(sql).all(...params) : db.prepare(sql).all();
      if (i === selectBases.length - 1) {
        rows.forEach((r) => {
          r.principal_hoc_vi = r.principal_don_vi = r.principal_orcid = null;
        });
      }
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!rows) {
    console.error('[GET /api/missions]', lastErr && lastErr.message ? lastErr.message : lastErr);
    return res.status(500).json({ missions: [], message: 'Không đọc được danh sách nhiệm vụ.' });
  }
  if (qRaw) {
    rows = rows.filter((r) => missionSearchQueryMatchesRow(r, qRaw));
  }
  return res.json({ missions: rows });
});

// Tạo nhiệm vụ mới (Luồng B - Cấp Bộ/ĐHQG/Nhà nước). Cấp Viện dùng nop-de-tai-cap-vien.html
router.post('/missions', authMiddleware, (req, res) => {
  const user = req.user;
  const body = req.body || {};
  const level = (body.level || '').trim().toLowerCase();
  if (!['national', 'ministry', 'university', 'school'].includes(level)) {
    return res.status(400).json({ message: 'API này chỉ dùng cho Cấp Bộ, Cấp ĐHQG, Cấp Trường ĐH KHTN, Cấp Nhà nước. Cấp Viện vui lòng nộp tại trang Đề tài cấp Viện.' });
  }
  const title = (body.title || '').trim();
  if (!title) return res.status(400).json({ message: 'Tên đề tài không được để trống.' });
  const code = (body.code || '').trim() || ('DT-' + level.toUpperCase().slice(0, 2) + '-' + new Date().getFullYear() + '-' + String(Date.now()).slice(-4));
  const principal = (user.fullname || user.email || '').trim() || null;
  const status = (body.status || 'cho_phe_duyet_ngoai').trim();
  const validStatus = ['cho_phe_duyet_ngoai', 'da_phe_duyet', 'dang_thuc_hien', 'nghiem_thu_trung_gian', 'nghiem_thu_tong_ket', 'hoan_thanh', 'khong_duoc_phe_duyet', 'planning', 'approved', 'ongoing', 'review', 'completed', 'overdue', 'cho_vien_xet_chon', 'cho_bo_tham_dinh', 'cho_ngoai_xet_chon', 'cho_ky_hop_dong', 'xin_dieu_chinh', 'cho_nghiem_thu_co_so', 'cho_nghiem_thu_bo_nn', 'hoan_thien_sau_nghiem_thu', 'thanh_ly_hop_dong'];
  const finalStatus = validStatus.includes(status) ? status : 'cho_vien_xet_chon';
  const startDate = (body.start_date || '').trim() || null;
  const endDate = (body.end_date || '').trim() || null;
  const progress = body.progress != null && !isNaN(parseInt(body.progress, 10)) ? Math.min(100, Math.max(0, parseInt(body.progress, 10))) : 0;
  const budget = body.budget != null && !isNaN(parseFloat(body.budget)) ? parseFloat(body.budget) : null;
  const managingAgency = (body.managing_agency || '').trim() || null;
  const contractNumber = (body.contract_number || '').trim() || null;
  const fundingSource = (body.funding_source || '').trim() || null;
  const approvedBudget = body.approved_budget != null && !isNaN(parseFloat(body.approved_budget)) ? parseFloat(body.approved_budget) : null;
  const disbursedBudget = body.disbursed_budget != null && !isNaN(parseFloat(body.disbursed_budget)) ? parseFloat(body.disbursed_budget) : null;
  const disbursementYear = (body.disbursement_year || '').trim() || null;
  const cooperatingUnits = (body.cooperating_units || '').trim() || null;
  const missionType = (body.mission_type || '').trim() || null;
  const field = (body.field || '').trim() || null;
  const objectives = (body.objectives || '').trim() || null;
  try {
    db.prepare(`
      INSERT INTO missions (code, title, principal, level, status, start_date, end_date, progress, budget, source_type,
        managing_agency, contract_number, funding_source, approved_budget, disbursed_budget, disbursement_year,
        cooperating_units, mission_type, field, objectives)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(code, title, principal, level, finalStatus, startDate, endDate, progress, budget,
      managingAgency, contractNumber, fundingSource, approvedBudget, disbursedBudget, disbursementYear,
      cooperatingUnits, missionType, field, objectives);
    const row = db.prepare('SELECT id, code, title, principal, level, status, managing_agency, objectives, start_date, end_date, budget, created_at FROM missions WHERE code = ? ORDER BY id DESC LIMIT 1').get(code);
    sendMissionProposalToCouncil(row, user.email || '');
    return res.status(201).json({ message: 'Đã đăng ký đề tài.', mission: row });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(400).json({ message: 'Mã đề tài đã tồn tại.' });
    throw e;
  }
});

const LEVEL_LABELS_EMAIL = { national: 'Cấp Nhà nước', ministry: 'Cấp Bộ', university: 'Cấp ĐHQG', school: 'Cấp Trường ĐH KHTN', institute: 'Cấp Viện' };

function sendMissionProposalToCouncil(mission, submitterEmail) {
  const toList = getNotificationEmails();
  if (!transporter || toList.length === 0) {
    if (!transporter) console.log('[Email] Bỏ qua: chưa cấu hình SMTP');
    else console.log('[Email] Bỏ qua: chưa có người nhận (Quản trị → Danh sách người nhận email)');
    return Promise.resolve();
  }
  const missionId = mission.id;
  const title = mission.title || '';
  const principal = mission.principal || submitterEmail;
  const levelLabel = LEVEL_LABELS_EMAIL[mission.level] || mission.level || '';
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + missionId;
  const subject = '[Đề tài ngoài Viện] Đề xuất mới: ' + title;

  const detailLines = [];
  detailLines.push('- Chủ nhiệm: ' + principal);
  detailLines.push('- Cấp đề tài: ' + levelLabel);
  detailLines.push('- Tên đề tài: ' + title);
  if (mission.managing_agency) detailLines.push('- Cơ quan quản lý: ' + mission.managing_agency);
  if (mission.start_date || mission.end_date) detailLines.push('- Thời gian: ' + (mission.start_date || '—') + ' đến ' + (mission.end_date || '—'));
  if (mission.budget != null) detailLines.push('- Kinh phí dự kiến: ' + new Intl.NumberFormat('vi-VN').format(mission.budget) + ' VNĐ');
  if (mission.objectives) detailLines.push('- Mục tiêu nghiên cứu: ' + (mission.objectives.length > 200 ? mission.objectives.slice(0, 200) + '...' : mission.objectives));
  const detailBlock = detailLines.join('\n');

  const text =
    'Kính gửi các thầy cô thành viên Hội đồng KHCN Viện Tế bào gốc,\n\n' +
    'Chủ nhiệm ' + principal + ' vừa gửi đề xuất đề tài ' + levelLabel + ': ' + title + '.\n\n' +
    'Chi tiết đề tài:\n' + detailBlock + '\n\n' +
    'Vui lòng đăng nhập hệ thống để xem chi tiết và hồ sơ đính kèm, đồng thời thực hiện bước tiếp theo (xét chọn/phê duyệt đề xuất).\n\n' +
    'Xem tiến trình đề tài: ' + timelineUrl;

  const detailHtml = '<ul style="margin:10px 0;padding-left:20px;line-height:1.6">' +
    '<li><strong>Chủ nhiệm:</strong> ' + (principal || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</li>' +
    '<li><strong>Cấp đề tài:</strong> ' + (levelLabel || '').replace(/</g, '&lt;') + '</li>' +
    '<li><strong>Tên đề tài:</strong> ' + (title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</li>' +
    (mission.managing_agency ? '<li><strong>Cơ quan quản lý:</strong> ' + String(mission.managing_agency).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</li>' : '') +
    ((mission.start_date || mission.end_date) ? '<li><strong>Thời gian:</strong> ' + (mission.start_date || '—') + ' đến ' + (mission.end_date || '—') + '</li>' : '') +
    (mission.budget != null ? '<li><strong>Kinh phí dự kiến:</strong> ' + new Intl.NumberFormat('vi-VN').format(mission.budget) + ' VNĐ</li>' : '') +
    (mission.objectives ? '<li><strong>Mục tiêu nghiên cứu:</strong> ' + String(mission.objectives).slice(0, 300).replace(/</g, '&lt;').replace(/>/g, '&gt;') + (mission.objectives.length > 300 ? '...' : '') + '</li>' : '') +
    '</ul>';

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>Kính gửi các thầy cô thành viên Hội đồng KHCN Viện Tế bào gốc,</p>' +
    '<p>Chủ nhiệm <strong>' + (principal || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> vừa gửi đề xuất đề tài <strong>' + (levelLabel || '').replace(/</g, '&lt;') + '</strong>: <strong>' + (title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong>.</p>' +
    '<p>Chi tiết đề tài:</p>' + detailHtml +
    '<p>Vui lòng đăng nhập hệ thống để xem chi tiết và hồ sơ đính kèm, đồng thời thực hiện bước tiếp theo (xét chọn/phê duyệt đề xuất).</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0;font-weight:600">Xem tiến trình đề tài</a></p>' +
    '</div>';

  console.log('[Email] Gửi thông báo đề xuất đề tài tới: ' + toList.join(', '));
  return transporter.sendMail({
    from: getSmtpFrom(),
    to: toList.join(', '),
    subject,
    text,
    html
  }).catch(err => console.error('[Email] Lỗi gửi:', err.message));
}

return router;
};
