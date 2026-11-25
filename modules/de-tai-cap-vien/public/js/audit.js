// Script Quản lý Giám sát Hồ sơ Pháp lý & Kiểm toán (Toàn Viện & Từng Đề tài)
let allAuditProjects = [];
let criteriaBreakdownCache = [];
let currentFilters = {
  status: '',
  group: '',
  missing_key: '',
  leader: '',
  q: ''
};

let debounceTimer = null;
let currentProjectAudit = null;
let breakdownExpanded = true;

const STAGE_NAMES = {
  1: 'GĐ 1: Đề xuất & Tuyển chọn',
  2: 'GĐ 2: Quyết định Giao nhiệm vụ',
  3: 'GĐ 3: Hợp đồng & Tạm ứng',
  4: 'GĐ 4: Mua sắm Vật tư & Hóa chất',
  5: 'GĐ 5: Báo cáo Định kỳ 6 tháng',
  6: 'GĐ 6: Gia hạn Thực hiện (Lần 1 & 2)',
  7: 'GĐ 7: Nghiệm thu & Thanh lý HĐ'
};

// Khởi chạy khi tải trang
document.addEventListener('DOMContentLoaded', () => {
  loadAuditData();
});

// Lắng nghe khi RBAC hoàn tất tải hoặc khi người dùng chuyển đổi vai trò
window.addEventListener('rbacLoaded', (e) => {
  const user = e.detail;
  populateLeaderDropdown();
  if (user && user.role === 'CHU_NHIEM' && user.leader_name) {
    currentFilters.leader = user.leader_name;
    const leaderSel = document.getElementById('leaderFilterSelect');
    if (leaderSel) leaderSel.value = user.leader_name;
  } else {
    currentFilters.leader = '';
    const leaderSel = document.getElementById('leaderFilterSelect');
    if (leaderSel) leaderSel.value = '';
  }
  renderRoleContextBanner();
  loadAuditData();
  if (currentProjectAudit && document.getElementById('auditDetailModal').classList.contains('active')) {
    openAuditModal(currentProjectAudit.id);
  }
});

function populateLeaderDropdown() {
  const sel = document.getElementById('leaderFilterSelect');
  if (!sel || !window.AVAILABLE_LEADERS || window.AVAILABLE_LEADERS.length === 0) return;
  const currentVal = currentFilters.leader || sel.value;
  sel.innerHTML = `<option value="">-- Tất cả Chủ nhiệm đề tài (${window.AVAILABLE_LEADERS.length} CNĐT) --</option>` +
    window.AVAILABLE_LEADERS.map(l =>
      `<option value="${escapeHtml(l.leader_name)}" ${l.leader_name === currentVal ? 'selected' : ''}>${escapeHtml(l.leader_name)} (${l.project_count} đề tài)</option>`
    ).join('');
}

function renderRoleContextBanner() {
  const banner = document.getElementById('roleContextBanner');
  const textEl = document.getElementById('roleContextText');
  const actionsEl = document.getElementById('roleContextActions');
  if (!banner || !window.CURRENT_USER) return;

  const u = window.CURRENT_USER;
  const r = u.role_info || {};
  banner.style.borderLeftColor = r.color || 'var(--primary)';

  let permDesc = '';
  if (u.role === 'SUPER_ADMIN') {
    permDesc = 'Toàn quyền Upload bổ sung mọi loại văn bản, xác thực bản cứng và quản trị toàn bộ 30 đề tài.';
  } else if (u.role === 'PHONG_KHCN') {
    permDesc = 'Quản lý hồ sơ toàn Viện: Upload Quyết định / Biên bản HĐ / Hợp đồng (hoặc nộp thay CNĐT) & Xác thực đối chiếu bản gốc.';
  } else if (u.role === 'VIEN_TRUONG') {
    permDesc = 'Giám sát tổng thể 30 đề tài toàn Viện, đọc xem trước toàn bộ hồ sơ PDF & Phê duyệt điều chỉnh dự toán / gia hạn.';
  } else if (u.role === 'CHU_NHIEM') {
    permDesc = `Đang làm việc với tư cách <strong>Chủ nhiệm đề tài: ${escapeHtml(u.leader_name)}</strong>. Được phép Upload trực tiếp các văn bản do CNĐT lập (Thuyết minh, Dự toán, Báo cáo 6 tháng, Đơn gia hạn, Báo cáo tổng kết, Sản phẩm KHCN, Giải trình).`;
  } else {
    permDesc = r.description || '';
  }

  textEl.innerHTML = `
    <span style="width: 30px; height: 30px; border-radius: 6px; background: ${r.bg_light || '#eff6ff'}; color: ${r.color || '#0284c7'}; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;">
      <i class="fa-solid ${r.icon || 'fa-user-shield'}"></i>
    </span>
    <div>
      <span style="font-weight: 700; color: #0f172a;">Vai trò hiện tại: ${escapeHtml(r.name || u.role)}</span>
      <span style="color: #475569; margin-left: 6px;">— ${permDesc}</span>
    </div>
  `;

  const switchBtn = u.can_switch_role
    ? `<button class="btn btn-outline btn-sm" onclick="openGlobalRoleSwitcherModal()" style="font-size: 0.75rem;">
      <i class="fa-solid fa-repeat"></i> Đổi vai trò (Xem thử)
    </button>`
    : '';
  actionsEl.innerHTML = switchBtn;
}

function toggleLeaderScope(onlyMine) {
  const leaderSel = document.getElementById('leaderFilterSelect');
  if (onlyMine && window.getCurrentLeader()) {
    currentFilters.leader = window.getCurrentLeader();
    if (leaderSel) leaderSel.value = currentFilters.leader;
  } else {
    currentFilters.leader = '';
    if (leaderSel) leaderSel.value = '';
  }
  renderRoleContextBanner();
  loadAuditData();
}

// 1. Tải dữ liệu Kiểm toán từ máy chủ
async function loadAuditData() {
  const tbody = document.getElementById('auditTableBody');
  tbody.innerHTML = `
    <tr>
      <td colspan="7" style="text-align: center; padding: 2.5rem; color: var(--text-muted);">
        <i class="fa-solid fa-spinner fa-spin"></i> Đang tải dữ liệu hồ sơ pháp lý kiểm toán...
      </td>
    </tr>
  `;

  try {
    // A. Lấy thống kê KPI & Breakdown 18 đầu mục toàn Viện
    const resSummary = await fetch('/api/audit/summary');
    const jsonSummary = await resSummary.json();
    if (jsonSummary.success) {
      const s = jsonSummary.data;
      document.getElementById('statAuditTotal').innerText = s.total_projects;
      document.getElementById('statMissingLiquidation').innerText = s.missing_liquidation;
      document.getElementById('statExtendedNeedsDocs').innerText = s.extended_needs_docs;
      document.getElementById('statAuditReady').innerText = s.full_audit_ready;

      const avgBadge = document.getElementById('avgCompletionBadge');
      if (avgBadge) {
        avgBadge.innerText = `Tỷ lệ hoàn thiện TB toàn Viện: ${s.avg_completion_rate || 0}%`;
      }

      if (s.criteria_breakdown) {
        criteriaBreakdownCache = s.criteria_breakdown;
        renderCriteriaBreakdownGrid(s.criteria_breakdown);
        populateMissingDocDropdown(s.criteria_breakdown);
      }
    }

    // B. Lấy danh sách ma trận hồ sơ
    let url = '/api/audit/projects';
    const params = new URLSearchParams();
    if (currentFilters.status) params.append('status', currentFilters.status);
    if (currentFilters.group) params.append('group', currentFilters.group);
    if (currentFilters.missing_key) params.append('missing_key', currentFilters.missing_key);
    if (currentFilters.leader) params.append('leader', currentFilters.leader);
    if (currentFilters.q) params.append('q', currentFilters.q);

    if (params.toString()) {
      url += '?' + params.toString();
    }

    const resList = await fetch(url);
    const jsonList = await resList.json();

    if (jsonList.success) {
      allAuditProjects = jsonList.data;
      renderAuditTable(allAuditProjects);
      updateFilterBanner(allAuditProjects.length);
    } else {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--color-red); padding: 2rem;">Lỗi: ${jsonList.error}</td></tr>`;
    }
  } catch (err) {
    console.error('Lỗi khi tải dữ liệu kiểm toán:', err);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--color-red); padding: 2rem;">Không thể kết nối máy chủ (${err.message})</td></tr>`;
  }
}

// Render lưới 18 đầu mục văn bản toàn Viện
function renderCriteriaBreakdownGrid(breakdown) {
  const grid = document.getElementById('criteriaBreakdownGrid');
  if (!grid) return;

  grid.innerHTML = breakdown.map(c => {
    const isSelected = currentFilters.missing_key === c.key;
    const pct = c.applicable_count > 0 ? Math.round((c.submitted_count / c.applicable_count) * 100) : 100;
    const ownerColor = c.owner_role === 'CHU_NHIEM' ? '#0d9488' : (c.owner_role === 'PHONG_TC_CU' ? '#ea580c' : '#0284c7');

    return `
      <div onclick="filterByMissingDocKey('${c.key}')"
        style="cursor: pointer; border: ${isSelected ? '2px solid var(--primary)' : '1px solid #e2e8f0'}; background: ${isSelected ? '#eff6ff' : '#f8fafc'}; border-radius: 8px; padding: 8px 10px; transition: all 0.15s;"
        title="Bấm để lọc ${c.missing_count} đề tài đang thiếu: ${escapeHtml(c.name)}">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 6px;">
          <div style="font-size: 0.78rem; font-weight: 700; color: #1e293b; line-height: 1.3;">
            <i class="fa-solid ${c.icon}" style="color: var(--primary); margin-right: 4px;"></i>${escapeHtml(c.name)}
          </div>
          <span style="font-size: 0.68rem; font-weight: 700; padding: 1px 6px; border-radius: 10px; background: ${c.missing_count > 0 ? '#fee2e2' : '#dcfce7'}; color: ${c.missing_count > 0 ? '#b91c1c' : '#15803d'}; white-space: nowrap;">
            ${c.missing_count > 0 ? `Thiếu ${c.missing_count}` : 'Đủ 100%'}
          </span>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px; font-size: 0.7rem; color: #64748b;">
          <span style="color: ${ownerColor}; font-weight: 600;">${escapeHtml(c.owner_label || '')}</span>
          <span>Đã có: <strong>${c.submitted_count}/${c.applicable_count}</strong> (${pct}%)</span>
        </div>
      </div>
    `;
  }).join('');
}

function toggleCriteriaBreakdown() {
  const grid = document.getElementById('criteriaBreakdownGrid');
  const btn = document.getElementById('btnToggleBreakdown');
  if (!grid) return;
  breakdownExpanded = !breakdownExpanded;
  grid.style.display = breakdownExpanded ? 'grid' : 'none';
  if (btn) {
    btn.innerHTML = breakdownExpanded
      ? '<i class="fa-solid fa-chevron-up"></i> Thu gọn'
      : '<i class="fa-solid fa-chevron-down"></i> Mở rộng 18 đầu mục';
  }
}

function populateMissingDocDropdown(breakdown) {
  const sel = document.getElementById('missingDocSelect');
  if (!sel) return;
  const currentVal = currentFilters.missing_key;
  sel.innerHTML = `<option value="">-- Lọc theo văn bản còn thiếu (18 loại) --</option>` +
    breakdown.map(c =>
      `<option value="${c.key}" ${c.key === currentVal ? 'selected' : ''}>Thiếu: ${escapeHtml(c.name)} (${c.missing_count} đề tài)</option>`
    ).join('');
}

function filterByMissingDocKey(docKey) {
  if (currentFilters.missing_key === docKey) {
    currentFilters.missing_key = '';
  } else {
    currentFilters.missing_key = docKey;
  }
  const sel = document.getElementById('missingDocSelect');
  if (sel) sel.value = currentFilters.missing_key;
  loadAuditData();
}

// 2. Render Bảng Ma trận Kiểm tra Hồ sơ
function renderAuditTable(projects) {
  const tbody = document.getElementById('auditTableBody');

  if (!projects || projects.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 3rem; color: var(--text-muted);">
          <i class="fa-solid fa-folder-open" style="font-size: 2.5rem; margin-bottom: 12px; color: #cbd5e1; display: block;"></i>
          Không tìm thấy đề tài nào phù hợp với điều kiện lọc hiện tại.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = projects.map((p, idx) => {
    const a = p.audit;
    
    // Màu thanh tiến độ hồ sơ
    let progressColor = 'var(--primary)';
    if (a.percentage === 100) progressColor = 'var(--color-green)';
    else if (a.percentage < 40) progressColor = 'var(--color-red)';
    else if (a.percentage < 70) progressColor = 'var(--color-yellow)';

    // Nhãn tình trạng đề tài
    let statusBadge = '';
    if (a.is_completed) {
      statusBadge = '<span class="badge badge-blue"><i class="fa-solid fa-award"></i> Đã nghiệm thu</span>';
    } else if (a.is_extended) {
      statusBadge = `<span class="badge badge-purple" title="Hạn đến: ${p.current_end_date_vn}"><i class="fa-solid fa-clock-rotate-left"></i> Đã gia hạn (Lần ${p.extension_count})</span>`;
    } else if (p.status_color === 'RED') {
      statusBadge = '<span class="badge badge-red"><i class="fa-solid fa-triangle-exclamation"></i> Báo đỏ quá hạn</span>';
    } else if (p.status_color === 'YELLOW') {
      statusBadge = '<span class="badge badge-yellow"><i class="fa-solid fa-clock"></i> Sắp hết hạn</span>';
    } else {
      statusBadge = '<span class="badge badge-green"><i class="fa-solid fa-circle-check"></i> Đang đúng hạn</span>';
    }

    // Danh sách các văn bản còn thiếu dạng pills
    let missingPillsHtml = '';
    if (a.percentage === 100) {
      missingPillsHtml = `
        <span class="audit-pill audit-pill-green">
          <i class="fa-solid fa-circle-check"></i> Đủ 100% hồ sơ pháp lý & kiểm toán
        </span>
      `;
    } else {
      const pills = [];

      if (a.missing_extension_2) {
        pills.push('<span class="audit-pill audit-pill-purple" style="font-weight: 700; border: 1px solid #c084fc; background: #faf5ff;"><i class="fa-solid fa-clock-rotate-left"></i> Thiếu Giấy & QĐ gia hạn Lần 2</span>');
      }

      if (a.is_completed) {
        if (a.missing_for_liquidation.some(m => m.includes('thanh lý') || m.includes('quyết toán'))) {
          pills.push('<span class="audit-pill audit-pill-yellow"><i class="fa-solid fa-handshake-slash"></i> Thiếu Biên bản thanh lý HĐ & Quyết toán</span>');
        }
        if (a.missing_for_liquidation.some(m => m.includes('tiếp thu') || m.includes('giải trình'))) {
          pills.push('<span class="audit-pill audit-pill-yellow"><i class="fa-solid fa-pen-to-square"></i> Thiếu Bản giải trình sau họp NT</span>');
        }
      }

      if (a.is_extended || p.status_color === 'RED' || p.status_color === 'YELLOW') {
        if (a.missing_for_acceptance.some(m => m.includes('tổng kết'))) {
          pills.push('<span class="audit-pill audit-pill-purple"><i class="fa-solid fa-file-circle-exclamation"></i> Thiếu Báo cáo tổng kết đề tài</span>');
        }
        if (a.missing_for_acceptance.some(m => m.includes('sản phẩm') || m.includes('Sản phẩm'))) {
          pills.push('<span class="audit-pill audit-pill-purple"><i class="fa-solid fa-newspaper"></i> Thiếu Minh chứng bài báo / Sản phẩm</span>');
        }
        if (a.missing_for_acceptance.some(m => m.includes('nghiệm thu') || m.includes('Nghiệm thu'))) {
          pills.push('<span class="audit-pill audit-pill-purple"><i class="fa-solid fa-users-gear"></i> Thiếu Biên bản HĐ nghiệm thu</span>');
        }
      }

      if (a.missing_list.some(m => m.includes('Thuyết minh'))) {
        pills.push('<span class="audit-pill audit-pill-red"><i class="fa-solid fa-triangle-exclamation"></i> Thiếu Thuyết minh đề tài</span>');
      }
      if (a.missing_list.some(m => m.includes('Dự toán'))) {
        pills.push('<span class="audit-pill audit-pill-red"><i class="fa-solid fa-calculator"></i> Thiếu Dự toán đã duyệt</span>');
      }
      if (a.missing_list.some(m => m.includes('Hợp đồng'))) {
        pills.push('<span class="audit-pill audit-pill-red"><i class="fa-solid fa-file-contract"></i> Thiếu Hợp đồng NCKH</span>');
      }
      if (a.missing_list.some(m => m.includes('Báo cáo tiến độ'))) {
        pills.push('<span class="audit-pill audit-pill-yellow"><i class="fa-solid fa-clock-rotate-left"></i> Nợ Báo cáo 6 tháng</span>');
      }

      if (pills.length === 0) {
        missingPillsHtml = a.missing_list.slice(0, 3).map(m => 
          `<span class="audit-pill audit-pill-red"><i class="fa-solid fa-circle-exclamation"></i> Thiếu: ${escapeHtml(m)}</span>`
        ).join('') + (a.missing_list.length > 3 ? ` <span style="font-size: 0.72rem; color: #94a3b8;">+${a.missing_list.length - 3} mục khác</span>` : '');
      } else {
        missingPillsHtml = pills.slice(0, 3).join('') + (a.missing_count > pills.length ? ` <span style="font-size: 0.72rem; color: #94a3b8; font-weight: 500;">(và ${a.missing_count - pills.length} văn bản khác)</span>` : '');
      }
    }

    // Phân tách số lượng mục thiếu theo trách nhiệm (CNĐT vs P.KHCN)
    const missingByOwner = a.missing_by_owner || {};
    const cndtMissingCount = Array.isArray(missingByOwner.CHU_NHIEM)
      ? missingByOwner.CHU_NHIEM.length
      : (Number(missingByOwner.CHU_NHIEM) || 0);
    const pkhcnMissingCount = (Array.isArray(missingByOwner.PHONG_KHCN) ? missingByOwner.PHONG_KHCN.length : (Number(missingByOwner.PHONG_KHCN) || 0))
      + (Array.isArray(missingByOwner.PHONG_TC_CU) ? missingByOwner.PHONG_TC_CU.length : (Number(missingByOwner.PHONG_TC_CU) || 0));

    const ownerHintHtml = a.missing_count > 0 ? `
      <div style="font-size: 0.72rem; color: #64748b; margin-top: 5px; display: flex; align-items: center; gap: 6px; white-space: nowrap;">
        <span title="Số văn bản do Chủ nhiệm đề tài cần nộp bổ sung" style="color: #0d9488; font-weight: 600;">
          <i class="fa-solid fa-user-pen" style="font-size: 0.68rem;"></i> CNĐT: ${cndtMissingCount}
        </span>
        <span style="color: #cbd5e1;">•</span>
        <span title="Số văn bản do Phòng KHCN / Viện ban hành hoặc lưu trữ" style="color: #0284c7; font-weight: 600;">
          <i class="fa-solid fa-building-columns" style="font-size: 0.68rem;"></i> P.KHCN: ${pkhcnMissingCount}
        </span>
      </div>
    ` : '';

    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted); font-size: 0.8rem; padding-top: 14px;">${idx + 1}</td>
        <td style="padding-top: 14px;">
          <a href="/chi-tiet.html?id=${p.id}" style="font-weight: 700; color: var(--primary); text-decoration: none;">
            ${escapeHtml(p.code)}
          </a>
        </td>
        <td style="padding-top: 14px; vertical-align: top;">
          <div style="font-weight: 600; color: #1e293b; line-height: 1.45; font-size: 0.88rem;" title="${escapeHtml(p.title)}">
            ${escapeHtml(p.title)}
          </div>
          <div style="font-size: 0.74rem; color: var(--text-muted); margin-top: 3px;">
            Chủ nhiệm: <strong style="color: #334155;">${escapeHtml(p.leader_name)}</strong> • <span style="color: #0284c7;">${escapeHtml(p.research_group || 'Chưa phân nhóm')}</span>
          </div>
        </td>
        <td style="padding-top: 14px;">${statusBadge}</td>
        <td style="padding-top: 14px;">
          <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem;">
            <strong style="color: ${progressColor};">${a.percentage}%</strong>
            <span style="color: var(--text-muted); font-size: 0.75rem;">${a.completed_count}/${a.total_required} giấy tờ</span>
          </div>
          <div class="audit-progress-container" style="margin-top: 4px;">
            <div class="audit-progress-bar" style="width: ${a.percentage}%; background: ${progressColor};"></div>
          </div>
          ${ownerHintHtml}
        </td>
        <td style="padding-top: 14px;">
          <div style="display: flex; flex-wrap: wrap; gap: 4px; align-items: center;">
            ${missingPillsHtml}
          </div>
        </td>
        <td style="text-align: center; padding: 14px 6px; white-space: nowrap;">
          <div style="display: flex; gap: 5px; justify-content: center; align-items: center;">
            <button class="btn btn-primary btn-sm" onclick="openAuditModal(${p.id})" title="Kiểm tra & Upload bổ sung trực tiếp các văn bản còn thiếu" style="padding: 4px 8px; font-size: 0.75rem;">
              <i class="fa-solid fa-cloud-arrow-up"></i> Kiểm tra / Nộp
            </button>
            <a href="/chi-tiet.html?id=${p.id}&tab=tab-docs" class="btn btn-outline btn-sm" title="Mở trang Hồ sơ 360 độ của đề tài" style="padding: 4px 8px;">
              <i class="fa-solid fa-folder-open"></i>
            </a>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// 3. Cập nhật Banner Lọc
function updateFilterBanner(count) {
  const banner = document.getElementById('filterBanner');
  const bannerText = document.getElementById('filterBannerText');

  const parts = [];
  if (currentFilters.status === 'MISSING_LIQUIDATION') parts.push('⚠️ Thiếu hồ sơ Thanh lý / Quyết toán');
  else if (currentFilters.status === 'EXTENDED') parts.push('🟣 Đã gia hạn - Cần hoàn thiện hồ sơ nghiệm thu');
  else if (currentFilters.status === 'COMPLETED') parts.push('🔵 Đã nghiệm thu');
  else if (currentFilters.status === 'INCOMPLETE') parts.push('🔴 Hồ sơ còn thiếu');
  else if (currentFilters.status === 'READY') parts.push('✅ Đủ 100% hồ sơ kiểm toán');

  if (currentFilters.missing_key) {
    const found = criteriaBreakdownCache.find(c => c.key === currentFilters.missing_key);
    parts.push(`📄 Đang thiếu văn bản: "${found ? found.name : currentFilters.missing_key}"`);
  }
  if (currentFilters.leader) parts.push(`👨‍🔬 Chủ nhiệm: ${currentFilters.leader}`);
  if (currentFilters.group) parts.push(`🔬 Nhóm: ${currentFilters.group}`);
  if (currentFilters.q) parts.push(`🔍 Từ khóa: "${currentFilters.q}"`);

  if (parts.length > 0) {
    bannerText.innerText = `Đang lọc: ${parts.join(' • ')} (Hiển thị ${count} đề tài)`;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

// 4. Lọc theo trạng thái kiểm toán từ Card KPI
function filterAuditStatus(statusKey) {
  currentFilters.status = statusKey;
  document.getElementById('statusSelect').value = statusKey;

  document.querySelectorAll('.kpi-card').forEach(c => c.classList.remove('active'));
  if (statusKey === '') document.getElementById('cardAuditTotal').classList.add('active');
  else if (statusKey === 'MISSING_LIQUIDATION') document.getElementById('cardMissingLiquidation').classList.add('active');
  else if (statusKey === 'EXTENDED') document.getElementById('cardExtendedNeedsDocs').classList.add('active');
  else if (statusKey === 'READY') document.getElementById('cardAuditReady').classList.add('active');

  loadAuditData();
}

// 5. Áp dụng bộ lọc từ dropdown
function applyAuditFilters() {
  currentFilters.status = document.getElementById('statusSelect').value;
  currentFilters.group = document.getElementById('groupSelect').value;
  const missingSel = document.getElementById('missingDocSelect');
  if (missingSel) currentFilters.missing_key = missingSel.value;
  const leaderSel = document.getElementById('leaderFilterSelect');
  if (leaderSel) currentFilters.leader = leaderSel.value;
  renderRoleContextBanner();
  loadAuditData();
}

// 6. Tìm kiếm debounce
function debounceFilter() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentFilters.q = document.getElementById('searchInput').value.trim();
    loadAuditData();
  }, 300);
}

// 7. Xóa toàn bộ bộ lọc
function resetFilters() {
  currentFilters = { status: '', group: '', missing_key: '', leader: '', q: '' };
  document.getElementById('searchInput').value = '';
  document.getElementById('statusSelect').value = '';
  document.getElementById('groupSelect').value = '';
  const missingSel = document.getElementById('missingDocSelect');
  if (missingSel) missingSel.value = '';
  const leaderSel = document.getElementById('leaderFilterSelect');
  if (leaderSel) leaderSel.value = '';
  document.querySelectorAll('.kpi-card').forEach(c => c.classList.remove('active'));
  renderRoleContextBanner();
  loadAuditData();
}

// ==============================================================
// MODAL KIỂM TRA CHI TIẾT 18 HẠNG MỤC HỒ SƠ & UPLOAD TRỰC TIẾP
// ==============================================================
async function openAuditModal(projectId) {
  try {
    const res = await fetch(`/api/audit/projects/${projectId}`);
    const json = await res.json();
    if (!json.success) {
      showToast('Không thể tải chi tiết kiểm toán', 'error');
      return;
    }

    const p = json.data;
    currentProjectAudit = p;

    document.getElementById('modalAuditTitle').innerText = `Kiểm tra & Bổ sung Hồ sơ Pháp lý: ${p.code}`;
    document.getElementById('modalAuditSubtitle').innerText = `${p.title} • Chủ nhiệm: ${p.leader_name} (${p.research_group || 'Chưa phân nhóm'})`;
    
    // Top Stats
    document.getElementById('modalAuditPercent').innerText = `${p.audit.percentage}% (${p.audit.completed_count}/${p.audit.total_required} giấy tờ)`;
    document.getElementById('modalAuditProgressBar').style.width = `${p.audit.percentage}%`;
    document.getElementById('modalAuditProgressBar').style.background = p.audit.percentage === 100 ? 'var(--color-green)' : (p.audit.percentage < 50 ? 'var(--color-red)' : 'var(--primary)');

    // Trạng thái nghiệm thu & thanh lý
    const accEl = document.getElementById('modalAuditAcceptanceStatus');
    if (p.audit.ready_for_acceptance) {
      accEl.innerHTML = '<span style="color: var(--color-green);"><i class="fa-solid fa-circle-check"></i> Đủ hồ sơ để nghiệm thu</span>';
    } else {
      accEl.innerHTML = `<span style="color: var(--color-red);"><i class="fa-solid fa-circle-exclamation"></i> Thiếu ${p.audit.missing_for_acceptance.length} giấy tờ</span>`;
    }

    const liqEl = document.getElementById('modalAuditLiquidationStatus');
    if (p.audit.ready_for_liquidation) {
      liqEl.innerHTML = '<span style="color: var(--color-green);"><i class="fa-solid fa-circle-check"></i> Đủ hồ sơ để thanh lý</span>';
    } else {
      liqEl.innerHTML = `<span style="color: #b45309;"><i class="fa-solid fa-handshake-slash"></i> Thiếu ${p.audit.missing_for_liquidation.length} giấy tờ</span>`;
    }

    // Nhóm các tiêu chí theo 5 nhóm
    const groups = [
      { name: 'I. HỒ SƠ PHÁP LÝ & ĐỀ CƯƠNG', items: p.audit.items.filter(i => i.group === 'PHÁP LÝ & ĐỀ CƯƠNG') },
      { name: 'II. QUYẾT ĐỊNH & HỢP ĐỒNG TRIỂN KHAI', items: p.audit.items.filter(i => i.group === 'QUYẾT ĐỊNH & HỢP ĐỒNG') },
      { name: 'III. TÀI CHÍNH - DỰ TOÁN & VẬT TƯ', items: p.audit.items.filter(i => i.group === 'TÀI CHÍNH & VẬT TƯ') },
      { name: 'IV. GIÁM SÁT TIẾN ĐỘ & GIA HẠN (LẦN 1 & LẦN 2)', items: p.audit.items.filter(i => i.group.includes('GIÁM SÁT TIẾN ĐỘ')) },
      { name: 'V. HỒ SƠ NGHIỆM THU & THANH LÝ HỢP ĐỒNG', items: p.audit.items.filter(i => i.group === 'NGHIỆM THU & THANH LÝ') }
    ];

    const canVerify = typeof window.canUserVerifyHardcopy === 'function' ? window.canUserVerifyHardcopy() : true;

    const container = document.getElementById('modalAuditItemsContainer');
    container.innerHTML = groups.map(g => {
      if (g.items.length === 0) return '';

      return `
        <div class="audit-group-title">
          <i class="fa-solid fa-folder-closed" style="color: var(--primary);"></i> ${g.name}
        </div>
        ${g.items.map(item => {
          let badgeHtml = '';
          let actionBtn = '';

          const canUpload = typeof window.canUserUploadCriteria === 'function'
            ? window.canUserUploadCriteria(item.allowed_upload_roles, p.leader_name)
            : true;

          const ownerBadgeColor = item.owner_role === 'CHU_NHIEM' ? '#0d9488' : (item.owner_role === 'PHONG_TC_CU' ? '#ea580c' : '#0284c7');
          const ownerBadgeBg = item.owner_role === 'CHU_NHIEM' ? '#f0fdfa' : (item.owner_role === 'PHONG_TC_CU' ? '#fff7ed' : '#f0f9ff');
          const ownerBadge = `<span style="font-size: 0.68rem; color: ${ownerBadgeColor}; background: ${ownerBadgeBg}; border: 1px solid ${ownerBadgeColor}33; padding: 1px 6px; border-radius: 4px; font-weight: 600;">${escapeHtml(item.owner_label || '')}</span>`;

          if (item.status === 'UPLOADED') {
            badgeHtml = `<span class="audit-status-badge" style="background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd;"><i class="fa-solid fa-file-circle-check"></i> Đã nộp file</span>`;
            const btns = [];
            if (item.file && item.file.id) {
              btns.push(`
                <button class="btn btn-outline btn-sm" onclick="previewDocInModal(${item.file.id}, '${escapeHtml(item.file.title)}')">
                  <i class="fa-solid fa-eye"></i> Xem trước
                </button>
              `);
            } else if (item.file && item.file.is_virtual) {
              btns.push(`<span style="font-size: 0.72rem; color: #0284c7; font-style: italic;"><i class="fa-solid fa-check"></i> Đã ghi nhận hệ thống</span>`);
            }
            if (canUpload) {
              btns.push(`
                <button class="btn btn-outline btn-sm" onclick="openQuickUploadModal(${p.id}, '${escapeHtml(p.code)}', '${item.key}', ${item.stage}, '${escapeHtml(item.name)}')" title="Tải lên bản cập nhật mới cho văn bản này">
                  <i class="fa-solid fa-cloud-arrow-up"></i> Nộp lại
                </button>
              `);
            }
            actionBtn = btns.join(' ');
          } else if (item.status === 'VERIFIED') {
            badgeHtml = `<span class="audit-status-badge" style="background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0;"><i class="fa-solid fa-check-double"></i> Đã xác thực bản cứng</span>`;
            if (canUpload) {
              actionBtn = `
                <button class="btn btn-outline btn-sm" onclick="openQuickUploadModal(${p.id}, '${escapeHtml(p.code)}', '${item.key}', ${item.stage}, '${escapeHtml(item.name)}')" title="Đính kèm thêm file scan số hóa">
                  <i class="fa-solid fa-file-arrow-up"></i> Đính kèm PDF
                </button>
              `;
            }
          } else if (item.status === 'NOT_REQUIRED') {
            badgeHtml = `<span class="audit-status-badge" style="background: #f1f5f9; color: #94a3b8; border: 1px solid #e2e8f0;"><i class="fa-solid fa-minus"></i> Không áp dụng</span>`;
            if (canUpload && (item.key === 'DON_DIEU_CHINH_DU_TOAN' || item.key === 'QD_DIEU_CHINH_DU_TOAN' || item.key.includes('GIA_HAN'))) {
              actionBtn = `
                <button class="btn btn-outline btn-sm" style="font-size: 0.72rem; opacity: 0.85;" onclick="openQuickUploadModal(${p.id}, '${escapeHtml(p.code)}', '${item.key}', ${item.stage}, '${escapeHtml(item.name)}')" title="Nộp bổ sung nếu phát sinh">
                  <i class="fa-solid fa-plus"></i> Nộp nếu phát sinh
                </button>
              `;
            }
          } else {
            badgeHtml = `<span class="audit-status-badge" style="background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca;"><i class="fa-solid fa-triangle-exclamation"></i> Còn thiếu</span>`;
            const btns = [];
            if (canUpload) {
              btns.push(`
                <button class="btn btn-primary btn-sm" style="background: var(--primary); padding: 4px 10px; font-size: 0.75rem;" onclick="openQuickUploadModal(${p.id}, '${escapeHtml(p.code)}', '${item.key}', ${item.stage}, '${escapeHtml(item.name)}')">
                  <i class="fa-solid fa-cloud-arrow-up"></i> Upload bổ sung
                </button>
              `);
            } else {
              btns.push(`<span style="font-size: 0.72rem; color: #64748b; font-style: italic;"><i class="fa-solid fa-lock"></i> Do ${escapeHtml(item.owner_label || 'bộ phận chuyên trách')} nộp</span>`);
            }
            if (canVerify) {
              btns.push(`
                <button class="btn btn-outline btn-sm" onclick="quickVerifyDoc(${p.id}, '${item.key}')" title="Xác thực đã có hồ sơ giấy bản cứng tại Viện">
                  <i class="fa-solid fa-stamp"></i> Xác thực giấy
                </button>
              `);
            }
            actionBtn = btns.join(' ');
          }

          let purposeLabel = '';
          if (item.needed_for === 'ACCEPTANCE') purposeLabel = '<span style="font-size: 0.68rem; color: #7e22ce; background: #f3e8ff; padding: 1px 6px; border-radius: 4px; font-weight: 600;">Cần để Nghiệm thu</span>';
          else if (item.needed_for === 'LIQUIDATION') purposeLabel = '<span style="font-size: 0.68rem; color: #b45309; background: #fef3c7; padding: 1px 6px; border-radius: 4px; font-weight: 600;">Cần để Thanh lý & Quyết toán</span>';

          const uploadedFileInfo = (item.file && item.file.id)
            ? `<div style="font-size: 0.73rem; color: #0369a1; margin-left: 26px; margin-top: 3px;">
                 <i class="fa-solid fa-paperclip"></i> File đã nộp: <strong>${escapeHtml(item.file.title || item.file.file_name)}</strong>
                 ${item.file.uploaded_by ? ` • Người nộp: <em>${escapeHtml(item.file.uploaded_by)}</em>` : ''}
               </div>`
            : '';

          return `
            <div class="audit-item-row">
              <div style="flex: 1; padding-right: 15px;">
                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                  <i class="fa-solid ${item.icon}" style="color: var(--primary); font-size: 0.95rem; width: 18px;"></i>
                  <span style="font-weight: 600; color: #1e293b; font-size: 0.875rem;">${escapeHtml(item.name)}</span>
                  ${ownerBadge}
                  ${purposeLabel}
                </div>
                <div style="font-size: 0.75rem; color: var(--text-muted); margin-left: 26px; margin-top: 2px;">
                  ${escapeHtml(item.desc)}
                </div>
                ${uploadedFileInfo}
                ${item.notes ? `<div style="font-size: 0.73rem; color: #15803d; margin-left: 26px; margin-top: 2px; font-style: italic;"><i class="fa-solid fa-circle-check"></i> ${escapeHtml(item.notes)}</div>` : ''}
              </div>

              <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end;">
                ${badgeHtml}
                ${actionBtn}
              </div>
            </div>
          `;
        }).join('')}
      `;
    }).join('');

    document.getElementById('auditDetailModal').classList.add('active');
  } catch (err) {
    showToast('Lỗi mạng: ' + err.message, 'error');
  }
}

function closeAuditModal() {
  document.getElementById('auditDetailModal').classList.remove('active');
}

// ==============================================================
// QUICK UPLOAD TRỰC TIẾP TRÊN TRANG KIỂM TOÁN
// ==============================================================
function openQuickUploadModal(projectId, projectCode, docKey, stage, criteriaName) {
  document.getElementById('quProjectId').value = projectId;
  document.getElementById('quDocType').value = docKey;
  document.getElementById('quStage').value = stage || 1;
  document.getElementById('quCriteriaName').innerText = criteriaName;
  document.getElementById('quStageLabel').innerText = STAGE_NAMES[stage] || `Giai đoạn ${stage}`;

  const u = window.CURRENT_USER;
  const uploaderText = u
    ? (u.role === 'CHU_NHIEM' ? `CNĐT ${u.leader_name}` : `${u.role_info?.short_name || u.role} (${u.fullname})`)
    : 'Phòng KHCN & ĐN';
  document.getElementById('quUploaderLabel').innerText = uploaderText;

  document.getElementById('quickUploadSubtitle').innerText = `Đề tài ${projectCode} • ${criteriaName}`;
  document.getElementById('quTitle').value = `${criteriaName} - Đề tài ${projectCode}`;
  document.getElementById('quFile').value = '';
  document.getElementById('quNotes').value = '';

  document.getElementById('quickUploadModal').classList.add('active');
}

function closeQuickUploadModal() {
  document.getElementById('quickUploadModal').classList.remove('active');
}

async function submitQuickUpload(e) {
  e.preventDefault();
  const projectId = document.getElementById('quProjectId').value;
  const fileInput = document.getElementById('quFile');
  if (!fileInput.files || fileInput.files.length === 0) {
    showToast('Vui lòng chọn file văn bản để tải lên', 'error');
    return;
  }

  const submitBtn = document.getElementById('quSubmitBtn');
  const origHtml = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tải lên...';

  try {
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    formData.append('stage', document.getElementById('quStage').value);
    formData.append('doc_type', document.getElementById('quDocType').value);
    formData.append('title', document.getElementById('quTitle').value);
    formData.append('notes', document.getElementById('quNotes').value);

    const res = await fetch(`/api/documents/upload/${projectId}`, {
      method: 'POST',
      body: formData
    });
    const json = await res.json();

    if (json.success) {
      showToast(json.message || 'Đã tải lên hồ sơ và cập nhật tiến độ thành công!', 'success');
      closeQuickUploadModal();
      await loadAuditData();
      if (document.getElementById('auditDetailModal').classList.contains('active')) {
        await openAuditModal(projectId);
      }
    } else {
      showToast(json.error || 'Lỗi khi tải lên hồ sơ', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối khi tải file: ' + err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = origHtml;
  }
}

// 8. Xác thực nhanh hồ sơ giấy
async function quickVerifyDoc(projectId, docKey) {
  const notes = prompt('Nhập ghi chú thẩm định kiểm toán (ví dụ: Bản cứng lưu tại VP Viện, số lưu trữ...):', 'Hồ sơ bản gốc lưu tại VP Viện Tế bào gốc');
  if (notes === null) return;

  try {
    const res = await fetch('/api/audit/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId,
        doc_key: docKey,
        status: 'VERIFIED',
        notes: notes
      })
    });
    const json = await res.json();
    if (json.success) {
      showToast('Đã xác thực hồ sơ giấy thành công!', 'success');
      openAuditModal(projectId);
      loadAuditData();
    } else {
      showToast(json.error || 'Lỗi khi xác thực', 'error');
    }
  } catch (err) {
    showToast('Lỗi mạng: ' + err.message, 'error');
  }
}

// 9. Xem trước file PDF trong Modal
function previewDocInModal(docId, title) {
  const iframe = document.getElementById('previewModalIframe');
  const titleEl = document.getElementById('previewModalTitle');
  const openTabBtn = document.getElementById('previewOpenTabBtn');

  const previewUrl = `/api/documents/${docId}/preview`;
  titleEl.innerText = title || 'Xem trước văn bản';
  iframe.src = previewUrl;
  openTabBtn.href = previewUrl;

  document.getElementById('previewModal').classList.add('active');
}

function closePreviewModal() {
  document.getElementById('previewModal').classList.remove('active');
  document.getElementById('previewModalIframe').src = '';
}

// 10. Xuất Bảng Kiểm toán ra file CSV / Excel
function exportAuditCSV() {
  if (!allAuditProjects || allAuditProjects.length === 0) {
    showToast('Không có dữ liệu để xuất', 'error');
    return;
  }

  let csvContent = '\uFEFF';
  csvContent += 'STT,Mã đề tài,Tên đề tài,Chủ nhiệm,Nhóm nghiên cứu,Tình trạng đề tài,Tiến độ hồ sơ (%),Số văn bản thiếu,Danh sách văn bản còn thiếu phục vụ nghiệm thu / thanh lý\n';

  allAuditProjects.forEach((p, idx) => {
    const a = p.audit;
    const cleanTitle = `"${(p.title || '').replace(/"/g, '""')}"`;
    const cleanLeader = `"${(p.leader_name || '').replace(/"/g, '""')}"`;
    const cleanGroup = `"${(p.research_group || '').replace(/"/g, '""')}"`;
    const missingDocsStr = `"${(a.missing_list || []).join('; ').replace(/"/g, '""')}"`;

    csvContent += `${idx + 1},${p.code},${cleanTitle},${cleanLeader},${cleanGroup},${p.status},${a.percentage}%,${a.missing_count},${missingDocsStr}\n`;
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Danh_muc_ho_so_thieu_kiem_toan_de_tai_SCI_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('Đã xuất thành công file danh mục hồ sơ kiểm toán!', 'success');
}

// Helper: Hiển thị Toast
function showToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<i class="fa-solid fa-${type === 'success' ? 'circle-check' : 'triangle-exclamation'}"></i> ${escapeHtml(msg)}`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
