/**
 * Helper kiểm tra trạng thái và quyền truy cập chi tiết/hồ sơ ngoài cho Nhiệm vụ KHCN.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

module.exports = function createMissionAccessHelpers({ roleIsAny }) {
  function sanitizeMissionStatusFreeText(s) {
    const t = String(s || '')
      .trim()
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f<>]/g, '')
      .slice(0, 200);
    return t || null;
  }

  /** Mã trạng thái chuẩn (dropdown). Giá trị khác có thể lưu nếu là văn bản tự do (sau khi sanitize). */
  const MISSION_STATUS_ENUM = [
    'planning',
    'approved',
    'ongoing',
    'review',
    'completed',
    'overdue',
    'cho_phe_duyet_ngoai',
    'da_phe_duyet',
    'dang_thuc_hien',
    'nghiem_thu_trung_gian',
    'nghiem_thu_tong_ket',
    'hoan_thanh',
    'khong_duoc_phe_duyet',
    'cho_vien_xet_chon',
    'cho_ct_hd_xet_duyet',
    'buoc4a',
    'buoc4b',
    'cho_bo_tham_dinh',
    'cho_ngoai_xet_chon',
    'cho_phe_duyet_chinh_thuc',
    'cho_ky_hop_dong',
    'xin_dieu_chinh',
    'cho_nghiem_thu_co_so',
    'cho_nghiem_thu_bo_nn',
    'hoan_thien_sau_nghiem_thu',
    'thanh_ly_hop_dong',
    'dung_khong_dat_dot',
  ];

  function resolveMissionStatusInput(raw) {
    const stRaw = String(raw != null ? raw : '').trim();
    if (!stRaw) return null;
    if (MISSION_STATUS_ENUM.includes(stRaw)) return stRaw;
    const stLow = stRaw.toLowerCase();
    if (MISSION_STATUS_ENUM.includes(stLow)) return stLow;
    return sanitizeMissionStatusFreeText(stRaw);
  }

  /** Chuẩn hóa tên để so khớp chủ nhiệm (bỏ học hàm viết tắt thường gặp ở đầu chuỗi). */
  function normMissionPrincipalName(s) {
    let t = String(s || '').trim();
    let prev;
    do {
      prev = t;
      t = t
        .replace(/^(PGS\.\s*TS\.|PGS\.\s*TS|PGS\s+TS\.|PGS\s+TS|GS\.\s*TS\.|GS\.\s*TS|GS\s+TS\.|GS\s+TS|TSCKH\.|TS\.|TS\s|ThS\.|ThS\s|BSCKII\.|BSCKI\.|BS\.|CN\.|DR\.|Dr\.)\s+/i, '')
        .trim();
    } while (t !== prev);
    return t.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /** So khớp trường principal của missions với user đăng nhập (fullname / email). */
  function missionPrincipalMatchesUser(principalText, user) {
    if (!user) return false;
    const pRaw = (principalText || '').trim();
    if (!pRaw) return false;
    const email = (user.email || '').trim().toLowerCase();
    if (email && pRaw.toLowerCase() === email) return true;
    const fullname = (user.fullname || '').trim();
    const pn = normMissionPrincipalName(pRaw);
    const fn = normMissionPrincipalName(fullname);
    if (fn.length >= 2 && pn === fn) return true;
    if (fn.length >= 3 && pn.length >= 3 && (pn.includes(fn) || fn.includes(pn))) return true;
    return false;
  }

  /** Admin xem được mọi đề tài; user thường chỉ đề tài mình là chủ nhiệm (theo trường principal). */
  function canUserAccessMissionHoSoNgoai(req, missionRow) {
    if (!missionRow) return false;
    if (!req.user) return false;
    if ((req.user.role || '').toLowerCase() === 'admin') return true;
    return missionPrincipalMatchesUser(missionRow.principal, req.user);
  }

  /** Quyền xem chi tiết đề tài: nhóm xử lý nghiệp vụ + admin; user thường chỉ xem đề tài mình phụ trách. */
  function canUserAccessMissionDetail(req, missionRow) {
    if (!missionRow || !req || !req.user) return false;
    if (roleIsAny(req, ['admin', 'phong_khcn', 'thu_ky', 'chu_tich', 'thanh_vien', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'])) {
      return true;
    }
    return missionPrincipalMatchesUser(missionRow.principal, req.user);
  }

  return {
    canUserAccessMissionDetail,
    canUserAccessMissionHoSoNgoai,
    resolveMissionStatusInput,
  };
};
