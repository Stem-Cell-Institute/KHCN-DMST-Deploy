/**
 * Migration schema Cấp Viện, seed danh mục/options và helper báo cáo định kỳ / thống kê bước.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const path = require('path');
const fs = require('fs');
const db = require('../lib/db-bridge');

module.exports = function createCapVienSchemaAndHelpers({ legacyCapVienDbPath }) {
  function crdIsHalfHourMark(t) {
    if (!Number.isFinite(t)) return false;
    return Math.abs(Math.round(t * 2) - t * 2) < 1e-5;
  }

  function insertCapVienStep2History(submissionId, actionType, performedById, performedByRole, note) {
    const performedAt = new Date().toISOString();
    const u = performedById ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(performedById) : null;
    const performedByName = u ? (u.fullname || u.email || '') : '';
    db.prepare(
      'INSERT INTO cap_vien_step2_history (submissionId, actionType, performedAt, performedById, performedByName, performedByRole, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(submissionId, actionType, performedAt, performedById || null, performedByName, performedByRole || null, note || null);
    insertCapVienHistory(submissionId, '2', actionType, performedById, performedByRole, note);
  }

  function insertCapVienHistory(submissionId, stepId, actionType, performedById, performedByRole, note, performedAtOverride) {
    const performedAt = performedAtOverride || new Date().toISOString();
    const u = performedById ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(performedById) : null;
    const performedByName = u ? (u.fullname || u.email || '') : '';
    db.prepare(
      'INSERT INTO cap_vien_submission_history (submissionId, stepId, actionType, performedAt, performedById, performedByName, performedByRole, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(submissionId, stepId, actionType, performedAt, performedById || null, performedByName, performedByRole || null, note || null);
  }

  function capVienPeriodicPeriodIsTerminal(status) {
    const s = String(status || '').toLowerCase();
    return s === 'submitted' || s === 'waived' || s === 'bypassed';
  }

  function insertCapVienPeriodicAdminLog(submissionId, periodId, actionType, reqUser, payloadObj, note) {
    const performedAt = new Date().toISOString();
    const payloadJson = payloadObj != null ? JSON.stringify(payloadObj) : null;
    const role = reqUser && reqUser.role ? String(reqUser.role) : null;
    db.prepare(
      `INSERT INTO cap_vien_periodic_report_admin_log (submissionId, periodId, actionType, payloadJson, note, performedAt, performedById, performedByRole)
     VALUES (?,?,?,?,?,?,?,?)`
    ).run(submissionId, periodId || null, actionType, payloadJson, note || null, performedAt, reqUser.id, role);
  }

  function capVienPeriodicFlatFromStepHistory(stepHistory) {
    const flat = [];
    for (const sid of Object.keys(stepHistory || {})) {
      for (const h of stepHistory[sid] || []) {
        if (!h || !h.performedAt) continue;
        flat.push({ stepId: sid, actionType: h.actionType, performedAt: h.performedAt });
      }
    }
    flat.sort((a, b) => String(a.performedAt).localeCompare(String(b.performedAt)));
    return flat;
  }

  function capVienResolvePeriodicAnchor(submissionId, row, anchorType, anchorAtCustom, flat) {
    const pickLast = (stepId, actions) => {
      let last = null;
      for (const h of flat) {
        if (h.stepId !== stepId) continue;
        if (actions && !actions.includes(h.actionType)) continue;
        last = h.performedAt;
      }
      return last;
    };
    const t = String(anchorType || '').toLowerCase().trim();
    if (t === 'custom_date' && anchorAtCustom) return anchorAtCustom;
    if (t === 'contract_start') return row.createdAt || null;
    const t7 = pickLast('7', ['step7_complete']);
    if (t7) return t7;
    return row.createdAt || new Date().toISOString();
  }

  function capVienBuildPeriodicSchedule(anchorIso, cycleMonths, periodCount) {
    const anc = new Date(anchorIso);
    if (Number.isNaN(anc.getTime())) return [];
    const c = Math.max(1, Math.min(24, parseInt(cycleMonths, 10) || 6));
    const n = Math.max(1, Math.min(48, parseInt(periodCount, 10) || Math.min(12, Math.ceil(36 / c))));
    const rows = [];
    for (let i = 0; i < n; i++) {
      const start = new Date(anc.getTime());
      start.setUTCMonth(start.getUTCMonth() + i * c);
      const endExclusive = new Date(anc.getTime());
      endExclusive.setUTCMonth(endExclusive.getUTCMonth() + (i + 1) * c);
      const end = new Date(endExclusive.getTime() - 24 * 60 * 60 * 1000);
      const due = end.toISOString();
      rows.push({
        seq: i + 1,
        label: `Kỳ ${i + 1} (${c} tháng)`,
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
        dueAt: due
      });
    }
    return rows;
  }

  function getCapVienPeriodicReportBundle(submissionId, includeAdminLog, role) {
    const config = db.prepare('SELECT * FROM cap_vien_periodic_report_config WHERE submissionId = ?').get(submissionId);
    const periods = db.prepare(
      `SELECT * FROM cap_vien_periodic_report_period WHERE submissionId = ? AND deletedAt IS NULL ORDER BY seq ASC`
    ).all(submissionId);
    const primaryFiles = {};
    for (const p of periods) {
      if (p.primaryFileId) {
        const f = db.prepare(
          'SELECT id, fieldName, originalName, uploadedAt, uploadedById, uploadedByRole FROM cap_vien_submission_files WHERE id = ?'
        ).get(p.primaryFileId);
        if (f) primaryFiles[p.id] = f;
      }
    }
    let adminLog = [];
    if (includeAdminLog && String(role || '').toLowerCase() === 'admin') {
      adminLog = db.prepare(
        `SELECT id, periodId, actionType, payloadJson, note, performedAt, performedById, performedByRole FROM cap_vien_periodic_report_admin_log WHERE submissionId = ? ORDER BY id DESC LIMIT 200`
      ).all(submissionId);
    }
    return { config: config || null, periods, primaryFiles, adminLog };
  }

  /** Số ngày thực tế (mở bước → hoàn thành / đến hiện tại) — từ lịch sử + deadline + trạng thái */
  function computeCapVienStepActualStats(row, stepHistory, stepDeadlines) {
    const flat = [];
    for (const sid of Object.keys(stepHistory || {})) {
      for (const h of stepHistory[sid] || []) {
        if (!h || !h.performedAt) continue;
        flat.push({ stepId: sid, actionType: h.actionType, performedAt: h.performedAt });
      }
    }
    flat.sort((a, b) => String(a.performedAt).localeCompare(String(b.performedAt)));

    const dlOpened = (s) => (stepDeadlines[s] && stepDeadlines[s].openedAt) ? stepDeadlines[s].openedAt : null;
    const st = (row.status || '').toUpperCase();
    const nowIso = new Date().toISOString();

    const pickFirst = (stepId, actions) => {
      for (const h of flat) {
        if (h.stepId !== stepId) continue;
        if (actions && !actions.includes(h.actionType)) continue;
        return h.performedAt;
      }
      return null;
    };
    const pickLast = (stepId, actions) => {
      let last = null;
      for (const h of flat) {
        if (h.stepId !== stepId) continue;
        if (actions && !actions.includes(h.actionType)) continue;
        last = h.performedAt;
      }
      return last;
    };
    const pickAll = (stepId, action) => flat.filter(h => h.stepId === stepId && h.actionType === action).map(h => h.performedAt);

    const daySpan = (fromIso, toIso) => {
      if (!fromIso || !toIso) return null;
      const a = new Date(fromIso).getTime();
      const b = new Date(toIso).getTime();
      if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
      return Math.max(1, Math.ceil((b - a) / (24 * 60 * 60 * 1000)));
    };

    const pack = (openedAt, completedAt, completed) => {
      const end = completed && completedAt ? completedAt : (!completed && openedAt ? nowIso : null);
      const days = openedAt && end ? daySpan(openedAt, end) : null;
      return {
        days,
        completed: !!completed,
        openedAt: openedAt || null,
        completedAt: completed && completedAt ? completedAt : null
      };
    };

    const out = {};

    // Bước 1 — mở: tạo hồ sơ; đóng: nộp hồ sơ
    const s1o = dlOpened('1') || row.createdAt;
    let s1c = pickFirst('1', ['researcher_submit']);
    if (!s1c && st !== 'SUBMITTED' && st !== 'NEED_REVISION') {
      s1c = pickFirst('2', null) || row.createdAt;
    }
    const step1Done = !!s1c || (st !== 'SUBMITTED' && st !== 'NEED_REVISION');
    out['1'] = pack(s1o, s1c, step1Done);

    // Bước 2
    const s2o = dlOpened('2') || s1c || row.createdAt;
    const step2Done = ['VALIDATED', 'ASSIGNED', 'UNDER_REVIEW', 'REVIEWED', 'IN_MEETING', 'CONDITIONAL', 'APPROVED', 'CONTRACTED', 'IMPLEMENTATION', 'COMPLETED'].includes(st);
    let s2c = pickLast('2', ['secretary_approve']);
    if (!s2c && step2Done && row.reviewedAt && st !== 'NEED_REVISION') s2c = row.reviewedAt;
    if (st === 'NEED_REVISION' || st === 'SUBMITTED') {
      out['2'] = pack(s2o, null, false);
    } else {
      out['2'] = pack(s2o, s2c, step2Done);
    }

    // Bước 3
    const s3o = dlOpened('3') || s2c || s2o;
    let s3c = pickLast('3', ['chairman_assign']);
    if (!s3c && row.assignedAt) s3c = row.assignedAt;
    const step3Done = ['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED', 'IN_MEETING', 'CONDITIONAL', 'APPROVED', 'CONTRACTED', 'IMPLEMENTATION', 'COMPLETED'].includes(st);
    out['3'] = pack(s3o, s3c, step3Done);

    // Bước 4 — đóng: lần PB2 hoàn thành (reviewer_complete thứ 2 theo thời gian)
    const s4o = dlOpened('4') || s3c || s3o;
    const rcTimes = pickAll('4', 'reviewer_complete').sort();
    let s4c = rcTimes.length >= 2 ? rcTimes[1] : null;
    const bothPb = !!(row.step_4_reviewer1_done && row.step_4_reviewer2_done);
    if (!s4c && bothPb && rcTimes.length === 1) s4c = rcTimes[0];
    out['4'] = pack(s4o, s4c, bothPb);

    // Bước 4A
    const s4aO = dlOpened('4a') || pickFirst('4a', ['budget_upload']) || s3c || s3o;
    let s4aC = pickLast('4a', ['budget_approve']);
    const step4aDone = String(row.budget_4a_status || '').toLowerCase() === 'approved';
    if (!s4aC && step4aDone && row.budget_4a_approved_at) s4aC = row.budget_4a_approved_at;
    out['4a'] = pack(s4aO, s4aC, step4aDone);

    // Bước 5 — mở: sau khi đủ điều kiện (max PB2 xong & phê duyệt 4A) hoặc deadline / sự kiện đầu bước 5
    const secondRc = rcTimes.length >= 2 ? rcTimes[1] : null;
    const baTime = pickLast('4a', ['budget_approve']) || (step4aDone && row.budget_4a_approved_at ? row.budget_4a_approved_at : null);
    let s5o = dlOpened('5') || pickFirst('5', null);
    if (!s5o && secondRc && baTime) {
      s5o = new Date(Math.max(new Date(secondRc).getTime(), new Date(baTime).getTime())).toISOString();
    }
    if (!s5o && ['REVIEWED', 'IN_MEETING', 'CONDITIONAL', 'APPROVED', 'CONTRACTED', 'IMPLEMENTATION', 'COMPLETED'].includes(st)) {
      s5o = baTime || secondRc || s4aC || s4c || s3c;
    }
    const s5councilPass = pickLast('5', ['step5_council_pass_hd']);
    const step5WorkflowPast = ['CONDITIONAL', 'APPROVED', 'CONTRACTED', 'IMPLEMENTATION', 'COMPLETED'].includes(st);
    if (s5councilPass) {
      out['5'] = pack(s5o, s5councilPass, true);
    } else if (step5WorkflowPast) {
      out['5'] = { days: null, completed: true, openedAt: s5o || null, completedAt: null };
    } else if (['REVIEWED', 'IN_MEETING'].includes(st)) {
      out['5'] = s5o ? pack(s5o, null, false) : { days: null, completed: false, openedAt: null, completedAt: null };
    } else {
      out['5'] = { days: null, completed: false, openedAt: null, completedAt: null };
    }

    const s7cEthics = pickLast('7', ['step7_complete']);
    const s8o = dlOpened('8') || s7cEthics || null;
    const s8c = pickLast('8', ['step8_complete', 'step8_admin_bypass', 'step8_admin_waive']);
    const step8Done = !!(row.step8_completed === 1 || row.step8_completed === true);
    const step8Waived = !!(row.step8_waived === 1 || row.step8_waived === true);
    out['8'] = pack(s8o, s8c, step8Done || step8Waived);

    try {
      const periods = db.prepare(
        `SELECT seq, status, submittedAt, waivedAt, bypassedAt, periodStart, dueAt FROM cap_vien_periodic_report_period WHERE submissionId = ? AND deletedAt IS NULL ORDER BY seq ASC`
      ).all(row.id);
      if (periods.length > 0) {
        const s10o = dlOpened('10') || periods[0].periodStart || periods[0].dueAt || null;
        const allDone = periods.every((p) => capVienPeriodicPeriodIsTerminal(p.status));
        let s10c = null;
        if (allDone) {
          for (const p of periods) {
            const t =
              String(p.status).toLowerCase() === 'submitted'
                ? p.submittedAt
                : String(p.status).toLowerCase() === 'waived'
                  ? p.waivedAt
                  : String(p.status).toLowerCase() === 'bypassed'
                    ? p.bypassedAt
                    : null;
            if (t && (!s10c || String(t).localeCompare(String(s10c)) > 0)) s10c = t;
          }
        }
        out['10'] = pack(s10o, s10c, allDone);
      } else if (['IMPLEMENTATION', 'COMPLETED'].includes(st)) {
        out['10'] = pack(dlOpened('10'), null, false);
      }
    } catch (e) {
      /* bảng có thể chưa tạo trên DB cực cũ */
    }

    return out;
  }

  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN assignedReviewerIds TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN assignedAt TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN assignedById INTEGER').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_status TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_round INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('UPDATE cap_vien_submissions SET budget_4a_round = 1 WHERE COALESCE(budget_4a_round, 0) < 1').run(); } catch (e) { /* bỏ qua */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_revision_note TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_revision_requested_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_revision_requested_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_approved_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_approved_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step_4_reviewer1_done INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step_4_reviewer2_done INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN code TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN options_checked TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_location TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_attendance TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_documents TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_vote_result TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_decision TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_event_time TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_updated_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_updated_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_status TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_round INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('UPDATE cap_vien_submissions SET step5_council_revision_round = 0 WHERE step5_council_revision_round IS NULL').run(); } catch (e) { /* bỏ qua */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_note TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_requested_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_requested_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_so_qd TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_kinh_phi TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_thoi_gian TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_phi_quan_ly TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_meta_updated_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_meta_updated_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step7_so_hd TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step7_hieu_luc TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step7_meta_updated_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step7_meta_updated_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_ma_dao_duc TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_hieu_luc TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_so_quyet_dinh TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_meta_updated_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_meta_updated_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_completed INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_waived INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8a_completed INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8a_waived INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
  // Bước 9: danh mục hoá chất/vật tư đã "khoá" (số liệu chính thức để đối sánh dự toán, xem cap_vien_step9_supply_item).
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step9_supply_locked_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step9_supply_locked_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }

  db.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_periodic_report_config (
    submissionId INTEGER PRIMARY KEY,
    cycleMonths INTEGER NOT NULL DEFAULT 6,
    anchorType TEXT NOT NULL DEFAULT 'post_step7',
    anchorAt TEXT,
    dueRule TEXT DEFAULT 'end_of_period',
    dueOffsetDays INTEGER DEFAULT 0,
    timezone TEXT DEFAULT 'Asia/Ho_Chi_Minh',
    pauseReportClock INTEGER NOT NULL DEFAULT 0,
    pausedUntil TEXT,
    pauseReason TEXT,
    updatedAt TEXT NOT NULL,
    updatedById INTEGER,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  );
  CREATE TABLE IF NOT EXISTS cap_vien_periodic_report_period (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    label TEXT,
    periodStart TEXT,
    periodEnd TEXT,
    dueAt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    waivedAt TEXT,
    waivedById INTEGER,
    waiveNote TEXT,
    bypassedAt TEXT,
    bypassedById INTEGER,
    bypassNote TEXT,
    submittedAt TEXT,
    primaryFileId INTEGER,
    extraMeta TEXT,
    deletedAt TEXT,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id),
    UNIQUE(submissionId, seq)
  );
  CREATE TABLE IF NOT EXISTS cap_vien_periodic_report_period_file (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    periodId INTEGER NOT NULL,
    fileId INTEGER NOT NULL,
    role TEXT DEFAULT 'main',
    attachedAt TEXT NOT NULL,
    attachedById INTEGER,
    detachedAt TEXT,
    FOREIGN KEY (periodId) REFERENCES cap_vien_periodic_report_period(id),
    FOREIGN KEY (fileId) REFERENCES cap_vien_submission_files(id)
  );
  CREATE TABLE IF NOT EXISTS cap_vien_periodic_report_admin_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    periodId INTEGER,
    actionType TEXT NOT NULL,
    payloadJson TEXT,
    note TEXT,
    performedAt TEXT NOT NULL,
    performedById INTEGER NOT NULL,
    performedByRole TEXT,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  );
  -- Bước 9 (Thực hiện đề tài): mốc hoạt động do Chủ nhiệm/Admin tự khai báo (thay vì 3 mốc cố định trước đây).
  CREATE TABLE IF NOT EXISTS cap_vien_step9_milestone (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned', -- planned | in_progress | done
    eventDate TEXT,
    note TEXT,
    sortOrder INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    createdById INTEGER,
    updatedAt TEXT,
    updatedById INTEGER,
    deletedAt TEXT,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  );
  -- Danh mục hoá chất/vật tư dự toán (Bước 9). Trước khi cap_vien_submissions.step9_supply_locked_at
  -- được set, Chủ nhiệm/Admin còn sửa/xóa tự do; sau khi khoá, approvedQty là số liệu chính thức để
  -- đối sánh với các đợt cấp phát (cap_vien_step9_supply_issuance).
  CREATE TABLE IF NOT EXISTS cap_vien_step9_supply_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    name TEXT NOT NULL,
    unit TEXT,
    approvedQty REAL NOT NULL DEFAULT 0,
    approvedAmount REAL,
    note TEXT,
    createdAt TEXT NOT NULL,
    createdById INTEGER,
    updatedAt TEXT,
    updatedById INTEGER,
    deletedAt TEXT,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  );
  -- Đợt cấp phát cho từng item — 'requested' do Chủ nhiệm/Admin đề nghị, chỉ Admin/Phòng KHCN/Thư ký
  -- mới chuyển sang 'confirmed' (trừ vào approvedQty) hoặc 'rejected'.
  CREATE TABLE IF NOT EXISTS cap_vien_step9_supply_issuance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    itemId INTEGER NOT NULL,
    submissionId INTEGER NOT NULL,
    qty REAL NOT NULL,
    issuedDate TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'requested', -- requested | confirmed | rejected
    requestedById INTEGER,
    requestedAt TEXT NOT NULL,
    decidedById INTEGER,
    decidedAt TEXT,
    decisionNote TEXT,
    FOREIGN KEY (itemId) REFERENCES cap_vien_step9_supply_item(id),
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  );
  -- Bước 11: đề xuất điều chỉnh (nhân sự/kế hoạch/dự toán/gia hạn) — quy trình 2 cấp:
  -- Chủ nhiệm nộp -> Phòng KHCN xem xét (yêu cầu bổ sung/trình lên/từ chối thẳng) -> Viện trưởng duyệt/không duyệt.
  CREATE TABLE IF NOT EXISTS cap_vien_step11_adjustment_request (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    type TEXT NOT NULL, -- nhan_su | ke_hoach | du_toan | gia_han | khac
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted', -- submitted | khcn_need_revision | khcn_forwarded | approved | rejected
    requestedById INTEGER,
    requestedAt TEXT NOT NULL,
    khcnNote TEXT,
    khcnDecidedById INTEGER,
    khcnDecidedAt TEXT,
    directorNote TEXT,
    directorDecidedById INTEGER,
    directorDecidedAt TEXT,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  );
`);

  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_cv_prp_sub ON cap_vien_periodic_report_period(submissionId);
  CREATE INDEX IF NOT EXISTS idx_cv_prp_due ON cap_vien_periodic_report_period(submissionId, dueAt);
  CREATE INDEX IF NOT EXISTS idx_cv_prpal_sub ON cap_vien_periodic_report_admin_log(submissionId);
  CREATE INDEX IF NOT EXISTS idx_cv_s9m_sub ON cap_vien_step9_milestone(submissionId);
  CREATE INDEX IF NOT EXISTS idx_cv_s9si_sub ON cap_vien_step9_supply_item(submissionId);
  CREATE INDEX IF NOT EXISTS idx_cv_s9su_item ON cap_vien_step9_supply_issuance(itemId);
  CREATE INDEX IF NOT EXISTS idx_cv_s9su_sub ON cap_vien_step9_supply_issuance(submissionId);
  CREATE INDEX IF NOT EXISTS idx_cv_s11ar_sub ON cap_vien_step11_adjustment_request(submissionId);
`);

  db.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_submission_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    affects_code INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0
  )
`);
  (function seedCapVienOptions() {
    const opts = db.prepare('SELECT id FROM cap_vien_submission_options LIMIT 1').get();
    if (opts) return;
    db.prepare('INSERT INTO cap_vien_submission_options (code, label, affects_code, sort_order) VALUES (?, ?, ?, ?)').run('coe', 'CoE', 1, 1);
    db.prepare('INSERT INTO cap_vien_submission_options (code, label, affects_code, sort_order) VALUES (?, ?, ?, ?)').run('kinh_phi_vien', 'Kinh phí từ Viện Tế bào gốc', 0, 2);
  })();

  // Bảng danh mục hạng mục đề tài cấp Viện (admin quản trị)
  db.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_linh_vuc (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS cap_vien_loai_de_tai (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS cap_vien_don_vi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS cap_vien_khoan_muc_chi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    parent_code TEXT,
    sort_order INTEGER DEFAULT 0
  )
`);
  (function seedCapVienCategories() {
    const hasLv = db.prepare('SELECT id FROM cap_vien_linh_vuc LIMIT 1').get();
    if (!hasLv) {
      const lv = [['stem-cell', 'Tế bào gốc', 1], ['biotechnology', 'Công nghệ sinh học', 2], ['medicine', 'Y sinh học', 3], ['other', 'Khác', 4]];
      lv.forEach(([c, l, o]) => db.prepare('INSERT INTO cap_vien_linh_vuc (code, label, sort_order) VALUES (?, ?, ?)').run(c, l, o));
    }
    const hasLdt = db.prepare('SELECT id FROM cap_vien_loai_de_tai LIMIT 1').get();
    if (!hasLdt) {
      const ldt = [['research', 'Đề tài nghiên cứu', 1], ['project', 'Dự án', 2], ['program', 'Chương trình', 3]];
      ldt.forEach(([c, l, o]) => db.prepare('INSERT INTO cap_vien_loai_de_tai (code, label, sort_order) VALUES (?, ?, ?)').run(c, l, o));
    }
    const hasKm = db.prepare('SELECT id FROM cap_vien_khoan_muc_chi LIMIT 1').get();
    if (!hasKm) {
      const km = [
        ['1', 'Chi thù lao cho cán bộ khoa học', null, 1],
        ['1.1', 'Chủ nhiệm đề tài', '1', 2],
        ['1.2', 'Thành viên chính', '1', 3],
        ['1.3', 'Kỹ thuật viên/Trợ lý', '1', 4],
        ['2', 'Chi mua vật tư, nguyên liệu', null, 5],
        ['2.1', 'Hóa chất', '2', 6],
        ['2.2', 'Sinh phẩm', '2', 7],
        ['2.3', 'Dụng cụ thí nghiệm tiêu hao', '2', 8],
        ['3', 'Chi mua sắm, sửa chữa tài sản cố định', null, 9],
        ['3.1', 'Thiết bị', '3', 10],
        ['3.2', 'Phần mềm', '3', 11],
        ['4', 'Chi hội nghị, hội thảo, công tác phí', null, 12],
        ['4.1', 'Hội nghị, hội thảo khoa học', '4', 13],
        ['4.2', 'Công tác phí trong nước', '4', 14],
        ['4.3', 'Công tác phí nước ngoài', '4', 15],
        ['5', 'Chi thuê ngoài', null, 16],
        ['5.1', 'Thuê chuyên gia', '5', 17],
        ['5.2', 'Thuê dịch vụ phân tích', '5', 18],
        ['6', 'Chi khác', null, 19],
        ['6.1', 'Chi phí quản lý chung (tối đa 5%)', '6', 20],
        ['6.2', 'Chi phí in ấn, văn phòng phẩm', '6', 21]
      ];
      km.forEach(([c, l, p, o]) => db.prepare('INSERT INTO cap_vien_khoan_muc_chi (code, label, parent_code, sort_order) VALUES (?, ?, ?, ?)').run(c, l, p, o));
    }
  })();

  (function migrateLegacyCapVienIntoMainDb() {
    if (!fs.existsSync(legacyCapVienDbPath)) return;
    const mainSubCount = db.prepare('SELECT COUNT(*) AS n FROM cap_vien_submissions').get().n;
    if (mainSubCount > 0) return;

    // Legacy database chỉ đọc từ file local, luôn dùng better-sqlite3
    let legacyDb;
    try {
      const LegacyDatabase = require('better-sqlite3');
      legacyDb = new LegacyDatabase(legacyCapVienDbPath, { readonly: true });
    } catch (e) {
      console.warn('[DB] Không mở được de-tai-cap-vien.db để gom vào sci-ace.db:', e.message);
      return;
    }
    let legacySubCount = 0;
    try {
      legacySubCount = legacyDb.prepare('SELECT COUNT(*) AS n FROM cap_vien_submissions').get().n;
    } catch (e) {
      legacyDb.close();
      return;
    }
    legacyDb.close();
    if (!legacySubCount) return;
    const capVienTables = [
      'cap_vien_submission_options',
      'cap_vien_linh_vuc',
      'cap_vien_loai_de_tai',
      'cap_vien_don_vi',
      'cap_vien_khoan_muc_chi',
      'cap_vien_submissions',
      'cap_vien_submission_files',
      'cap_vien_step2_history',
      'cap_vien_submission_history'
    ];
    db.pragma('foreign_keys = OFF');
    try {
      db.prepare('ATTACH DATABASE ? AS capvien_legacy').run(legacyCapVienDbPath);
      db.transaction(() => {
        db.exec(`
        DELETE FROM cap_vien_submission_files;
        DELETE FROM cap_vien_step2_history;
        DELETE FROM cap_vien_submission_history;
        DELETE FROM cap_vien_submissions;
        DELETE FROM cap_vien_submission_options;
        DELETE FROM cap_vien_linh_vuc;
        DELETE FROM cap_vien_loai_de_tai;
        DELETE FROM cap_vien_don_vi;
        DELETE FROM cap_vien_khoan_muc_chi;
      `);
        for (const t of capVienTables) {
          const exists = db.prepare("SELECT 1 FROM capvien_legacy.sqlite_master WHERE type = 'table' AND name = ?").get(t);
          if (!exists) continue;
          db.exec('INSERT INTO main.' + t + ' SELECT * FROM capvien_legacy.' + t);
        }
      })();
      db.prepare('DETACH DATABASE capvien_legacy').run();
      const bakPath = legacyCapVienDbPath + '.migrated.' + Date.now() + '.bak';
      fs.renameSync(legacyCapVienDbPath, bakPath);
      console.log('[DB] Đã gom dữ liệu Đề tài cấp Viện từ de-tai-cap-vien.db vào sci-ace.db. File cũ đổi tên:', path.basename(bakPath));
    } catch (e) {
      try { db.prepare('DETACH DATABASE capvien_legacy').run(); } catch (_) {}
      console.error('[DB] Gom de-tai-cap-vien.db thất bại:', e.message || e);
    }
    db.pragma('foreign_keys = ON');
  })();

  return {
    capVienBuildPeriodicSchedule,
    capVienPeriodicFlatFromStepHistory,
    capVienResolvePeriodicAnchor,
    computeCapVienStepActualStats,
    crdIsHalfHourMark,
    getCapVienPeriodicReportBundle,
    insertCapVienHistory,
    insertCapVienPeriodicAdminLog,
    insertCapVienStep2History,
  };
};
