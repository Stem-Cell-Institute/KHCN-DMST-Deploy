// Dashboard Logic - Quản lý Đề tài Cấp Viện (SCI)

let currentFilters = {
  q: '',
  group: '',
  color: '',
  year: '',
  leader: ''
};

let debounceTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadData();
  checkCallStatusForDashboard();
});

async function checkCallStatusForDashboard() {
  try {
    const res = await fetch('/api/calls/current');
    const json = await res.json();
    const banner = document.getElementById('callDashboardBanner');
    const titleEl = document.getElementById('dashCallTitle');
    if (!banner) return;
    if (json.success && json.data && json.data.call && json.data.call.is_active) {
      if (titleEl && json.data.call.title) {
        titleEl.innerText = json.data.call.title;
      }
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  } catch (err) {}
}

window.addEventListener('rbacLoaded', (e) => {
  const user = e.detail;
  if (user && user.role === 'CHU_NHIEM' && user.leader_name) {
    currentFilters.leader = user.leader_name;
  } else {
    currentFilters.leader = '';
  }
  const btnNew = document.getElementById('btnNewProjectMain');
  if (btnNew) {
    btnNew.style.display = (user && ['SUPER_ADMIN', 'PHONG_KHCN'].includes(user.role)) ? 'inline-flex' : 'none';
  }
  renderDashboardRoleBanner();
  loadKHCNWorkstation();
  loadStats();
  loadData();
});

function renderDashboardRoleBanner() {
  const banner = document.getElementById('dashboardRoleBanner');
  const textEl = document.getElementById('dashboardRoleText');
  const actionsEl = document.getElementById('dashboardRoleActions');
  if (!banner || !textEl || !window.CURRENT_USER) return;

  const u = window.CURRENT_USER;
  const r = u.role_info || {};
  banner.style.borderLeftColor = r.color || 'var(--primary)';

  let scopeDesc = '';
  if (u.role === 'CHU_NHIEM') {
    scopeDesc = `Đang xem và quản lý các đề tài của <strong>CNĐT: ${escapeHtml(u.leader_name)}</strong>. Bấm vào đề tài để Upload bổ sung hồ sơ hoặc Xin điều chỉnh dự toán.`;
  } else if (u.role === 'PHONG_KHCN') {
    scopeDesc = 'Đầu mối Quản lý KHCN toàn Viện (30 đề tài): Khởi tạo đề tài, Upload QĐ/Biên bản HĐ, Xác thực hồ sơ kiểm toán & Thẩm tra dự toán.';
  } else if (u.role === 'VIEN_TRUONG') {
    scopeDesc = 'Thẩm quyền Viện trưởng: Giám sát tiến độ toàn Viện, Phê duyệt điều chỉnh dự toán & Ký quyết định gia hạn / nghiệm thu.';
  } else if (u.role === 'SUPER_ADMIN') {
    scopeDesc = 'Quản trị viên toàn hệ thống: Toàn quyền cấu hình phân quyền, quản lý dữ liệu và hồ sơ 30 đề tài.';
  } else {
    scopeDesc = r.description || '';
  }

  textEl.innerHTML = `
    <span style="width: 30px; height: 30px; border-radius: 6px; background: ${r.bg_light || '#eff6ff'}; color: ${r.color || '#0284c7'}; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;">
      <i class="fa-solid ${r.icon || 'fa-user-shield'}"></i>
    </span>
    <div>
      <span style="font-weight: 700; color: #0f172a;">Vai trò: ${escapeHtml(r.name || u.role)}</span>
      <span style="color: #475569; margin-left: 6px;">— ${scopeDesc}</span>
    </div>
  `;

  // Cách 1: Chủ nhiệm đề tài chỉ xem duy nhất đề tài của chính mình (khóa cứng ở backend, bỏ nút Xem toàn Viện)
  const switchBtn = u.can_switch_role
    ? `<button class="btn btn-outline btn-sm" onclick="openGlobalRoleSwitcherModal()" style="font-size: 0.75rem;">
      <i class="fa-solid fa-repeat"></i> Đổi vai trò (Xem thử)
    </button>`
    : '';
  actionsEl.innerHTML = switchBtn;
}

function toggleDashboardLeaderScope(onlyMine) {
  if (onlyMine && window.getCurrentLeader()) {
    currentFilters.leader = window.getCurrentLeader();
  } else {
    currentFilters.leader = '';
  }
  renderDashboardRoleBanner();
  loadStats();
  loadData();
}

// Bàn làm việc Nghiệp vụ Phòng KH&CN
let khcnActionData = null;
let missingLegalFilter = false;

async function loadKHCNWorkstation() {
  const card = document.getElementById('khcnWorkstationCard');
  const container = document.getElementById('khcnWorkstationBoxes');
  const badge = document.getElementById('khcnTotalPendingBadge');
  if (!card || !container) return;

  const u = window.CURRENT_USER;
  if (!u || !['PHONG_KHCN', 'VIEN_TRUONG', 'SUPER_ADMIN'].includes(u.role)) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';

  try {
    const res = await fetch('/api/projects/action-center');
    const json = await res.json();
    if (!json.success) return;

    khcnActionData = json.data;
    const s = json.data.summary || {};
    const totalPending = (s.pending_proposals_cnt || 0) + (s.missing_legal_docs_cnt || 0) + (s.urgent_deadlines_cnt || 0) + (s.pending_adjustments_cnt || 0);

    if (badge) {
      if (totalPending > 0) {
        badge.innerText = `${totalPending} việc cần xử lý`;
        badge.style.background = '#fee2e2';
        badge.style.color = '#b91c1c';
        badge.style.display = 'inline-block';
      } else {
        badge.innerText = '';
        badge.style.display = 'none';
      }
    }

    container.innerHTML = `
      <!-- Thẻ 1: Hồ sơ Đề xuất mới nộp -->
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; justify-content: space-between;">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
            <span style="font-size: 0.76rem; font-weight: 700; color: #475569; text-transform: uppercase;">
              <i class="fa-solid fa-inbox" style="color: #0284c7;"></i> Hồ sơ Chờ Sơ duyệt
            </span>
            ${s.pending_proposals_cnt > 0 ? `<span style="font-size: 1.25rem; font-weight: 800; color: #ea580c;">${s.pending_proposals_cnt}</span>` : ''}
          </div>
          <p style="font-size: 0.73rem; color: #64748b; margin: 0 0 10px 0;">
            Hồ sơ đề xuất mới nộp từ Nhà khoa học cần thẩm định thể thức & lên lịch Hội đồng.
          </p>
        </div>
        <a href="/quan-ly-dot.html" class="btn btn-outline btn-xs" style="font-size: 0.72rem; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 4px;">
          <i class="fa-solid fa-list-check"></i> Vào Trang Tiếp nhận Hồ sơ
        </a>
      </div>

      <!-- Thẻ 2: Đề tài Thiếu QĐ & Hợp đồng Pháp lý -->
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; justify-content: space-between;">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
            <span style="font-size: 0.76rem; font-weight: 700; color: #475569; text-transform: uppercase;">
              <i class="fa-solid fa-file-signature" style="color: #eab308;"></i> Thiếu Hồ sơ Pháp lý
            </span>
            ${s.missing_legal_docs_cnt > 0 ? `<span style="font-size: 1.25rem; font-weight: 800; color: #d97706;">${s.missing_legal_docs_cnt}</span>` : ''}
          </div>
          <p style="font-size: 0.73rem; color: #64748b; margin: 0 0 10px 0;">
            Đề tài chưa upload File Scan Quyết định giao nhiệm vụ, Hợp đồng NCKH có chữ ký hoặc Biên bản HĐ.
          </p>
        </div>
        <button class="btn btn-outline btn-xs" onclick="filterMissingLegalDocs()" style="font-size: 0.72rem; display: inline-flex; align-items: center; justify-content: center; gap: 4px;">
          <i class="fa-solid fa-filter"></i> Lọc ${s.missing_legal_docs_cnt || 0} đề tài cần bổ sung
        </button>
      </div>

      <!-- Thẻ 3: Đề tài Sắp hết hạn / Quá hạn cần đôn đốc -->
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; justify-content: space-between;">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
            <span style="font-size: 0.76rem; font-weight: 700; color: #475569; text-transform: uppercase;">
              <i class="fa-solid fa-triangle-exclamation" style="color: #dc2626;"></i> Cảnh báo Hạn (30-15-7-0)
            </span>
            ${s.urgent_deadlines_cnt > 0 ? `<span style="font-size: 1.25rem; font-weight: 800; color: #dc2626;">${s.urgent_deadlines_cnt}</span>` : ''}
          </div>
          <p style="font-size: 0.73rem; color: #64748b; margin: 0 0 10px 0;">
            Đề tài cận hạn cần nộp nghiệm thu, nộp đơn gia hạn hoặc kích hoạt quy trình thanh lý hợp đồng.
          </p>
        </div>
        <button class="btn btn-outline btn-xs" onclick="filterByColor('RED')" style="font-size: 0.72rem; display: inline-flex; align-items: center; justify-content: center; gap: 4px; color: #dc2626; border-color: #fca5a5;">
          <i class="fa-solid fa-bell"></i> Xem các đề tài Quá hạn
        </button>
      </div>

      <!-- Thẻ 4: Tờ trình Điều chỉnh & Gia hạn -->
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; justify-content: space-between;">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
            <span style="font-size: 0.76rem; font-weight: 700; color: #475569; text-transform: uppercase;">
              <i class="fa-solid fa-sliders" style="color: #9333ea;"></i> Tờ trình Chờ Duyệt
            </span>
            ${s.pending_adjustments_cnt > 0 ? `<span style="font-size: 1.25rem; font-weight: 800; color: #9333ea;">${s.pending_adjustments_cnt}</span>` : ''}
          </div>
          <p style="font-size: 0.73rem; color: #64748b; margin: 0 0 10px 0;">
            Tờ trình điều chỉnh dự toán kinh phí hoặc đơn xin gia hạn thời gian thực hiện đề tài.
          </p>
        </div>
        <button class="btn btn-outline btn-xs" onclick="filterByColor('EXTENDED')" style="font-size: 0.72rem; display: inline-flex; align-items: center; justify-content: center; gap: 4px;">
          <i class="fa-solid fa-clock-rotate-left"></i> Xem đề tài đã gia hạn
        </button>
      </div>
    `;
  } catch (err) {
    console.error('Lỗi khi tải bàn làm việc P. KHCN:', err);
  }
}

// Lọc các đề tài thiếu hồ sơ pháp lý
function filterMissingLegalDocs() {
  missingLegalFilter = true;
  document.getElementById('colorSelect').value = '';
  currentFilters.color = '';
  updateCardActiveState('');
  loadData();
  const tableEl = document.querySelector('.table-card');
  if (tableEl) {
    tableEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// Bắn quét hạn thủ công từ Dashboard
async function triggerDashboardDeadlineScan() {
  const btn = document.getElementById('btnDashScanDeadlines');
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang quét hạn toàn Viện...';

  try {
    const res = await fetch('/api/projects/run-deadline-check', { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      showToast(json.message || 'Quét hạn toàn Viện thành công!', 'success');
      loadKHCNWorkstation();
      loadStats();
      loadData();
    } else {
      showToast(json.message || 'Lỗi khi quét hạn', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối máy chủ: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

// 1. Tải số liệu thống kê KPI
async function loadStats() {
  try {
    const params = new URLSearchParams();
    if (currentFilters.leader) params.append('leader', currentFilters.leader);
    const res = await fetch(`/api/projects/stats?${params.toString()}`);
    const json = await res.json();
    if (json.success) {
      const s = json.stats;
      document.getElementById('statTotal').innerText = s.total_projects || 0;
      document.getElementById('statGreen').innerText = s.green_count || 0;
      document.getElementById('statYellow').innerText = s.yellow_count || 0;
      document.getElementById('statRed').innerText = s.red_count || 0;
      document.getElementById('statExtended').innerText = s.extended_count || 0;
      document.getElementById('statCompleted').innerText = s.completed_count || 0;
    }
  } catch (err) {
    console.error('Lỗi khi tải thống kê:', err);
  }
}

// 2. Tải danh sách đề tài và hiển thị bảng
async function loadData() {
  const tbody = document.getElementById('projectsTableBody');
  tbody.innerHTML = `
    <tr>
      <td colspan="11" style="text-align: center; padding: 2rem; color: var(--text-muted);">
        <i class="fa-solid fa-spinner fa-spin"></i> Đang tải dữ liệu đề tài cấp Viện...
      </td>
    </tr>
  `;

  try {
    const params = new URLSearchParams();
    if (currentFilters.q) params.append('q', currentFilters.q);
    if (currentFilters.group) params.append('group', currentFilters.group);
    if (currentFilters.color) params.append('color', currentFilters.color);
    if (currentFilters.year) params.append('year', currentFilters.year);
    if (currentFilters.leader) params.append('leader', currentFilters.leader);

    const res = await fetch(`/api/projects?${params.toString()}`);
    const json = await res.json();

    if (!json.success || !json.data || json.data.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="11" style="text-align: center; padding: 3rem; color: var(--text-muted);">
            <i class="fa-solid fa-folder-open" style="font-size: 2rem; margin-bottom: 8px; display: block;"></i>
            Không tìm thấy đề tài nào phù hợp với bộ lọc.
          </td>
        </tr>
      `;
      return;
    }

    let dataList = json.data;
    if (missingLegalFilter && khcnActionData && khcnActionData.missing_legal_docs) {
      const missingIds = new Set(khcnActionData.missing_legal_docs.map(x => x.id));
      dataList = dataList.filter(p => missingIds.has(p.id));
    }

    if (!dataList || dataList.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="11" style="text-align: center; padding: 3rem; color: var(--text-muted);">
            <i class="fa-solid fa-folder-open" style="font-size: 2rem; margin-bottom: 8px; display: block;"></i>
            Không tìm thấy đề tài nào phù hợp với bộ lọc.
          </td>
        </tr>
      `;
      return;
    }

    const count = dataList.length;

    // Hiển thị Banner thông báo bộ lọc đang áp dụng
    const banner = document.getElementById('filterNoticeBanner');
    const bannerText = document.getElementById('filterNoticeText');
    const hasFilter = missingLegalFilter || currentFilters.color || currentFilters.group || currentFilters.year || currentFilters.q || currentFilters.leader;

    if (hasFilter) {
      let filterDesc = '';
      if (missingLegalFilter) filterDesc = '📑 Đề tài thiếu Hồ sơ Pháp lý / Hợp đồng scan';
      else if (currentFilters.color === 'RED') filterDesc = '🔴 Báo đỏ quá hạn';
      else if (currentFilters.color === 'YELLOW') filterDesc = '🟡 Cảnh báo sắp hết hạn';
      else if (currentFilters.color === 'GREEN') filterDesc = '🟢 Đúng tiến độ';
      else if (currentFilters.color === 'EXTENDED') filterDesc = '🟣 Đề tài đã gia hạn (Lần 1 hoặc Lần 2)';
      else if (currentFilters.color === 'BLUE') filterDesc = '🔵 Đã nghiệm thu';
      else if (currentFilters.color === 'GRAY') filterDesc = '⚪ Hủy đề tài';

      if (currentFilters.leader) filterDesc += (filterDesc ? ' • ' : '') + `Chủ nhiệm: ${currentFilters.leader}`;
      if (currentFilters.group) filterDesc += (filterDesc ? ' • ' : '') + `Nhóm: ${currentFilters.group}`;
      if (currentFilters.year) filterDesc += (filterDesc ? ' • ' : '') + `Năm: ${currentFilters.year}`;
      if (currentFilters.q) filterDesc += (filterDesc ? ' • ' : '') + `Từ khóa: "${currentFilters.q}"`;

      bannerText.innerText = `Đang lọc: ${filterDesc} (${count} đề tài)`;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }

    tbody.innerHTML = dataList.map((p, index) => {
      // Xác định badge màu cảnh báo
      let badgeClass = 'badge-green';
      let icon = 'fa-circle-check';
      if (p.status_color === 'RED') {
        badgeClass = 'badge-red';
        icon = 'fa-triangle-exclamation';
      } else if (p.status_color === 'YELLOW') {
        badgeClass = 'badge-yellow';
        icon = 'fa-clock';
      } else if (p.status_color === 'BLUE') {
        badgeClass = 'badge-blue';
        icon = 'fa-award';
      } else if (p.status_color === 'GRAY') {
        badgeClass = 'badge-gray';
        icon = 'fa-ban';
      }

      // Xử lý cột Ngày hết hạn (thể hiện rõ hạn hiện tại vs hạn gốc nếu có gia hạn)
      // Cột kết hợp Thời gian thực hiện (Bắt đầu QĐ -> Ngày hết hạn & Thông tin gia hạn nếu có)
      let timeHtml = `
        <div style="font-weight: 600; color: #1e293b; font-size: 0.8rem; white-space: nowrap;">
          ${p.decision_date_vn || '<span style="color:#94a3b8;">-</span>'}
          <span style="color: #94a3b8; font-weight: normal; margin: 0 2px;">→</span>
          <span style="color: ${p.extension_count > 0 ? '#7e22ce' : '#1e293b'}; font-weight: 700;">${p.current_end_date_vn || '-'}</span>
        </div>
      `;

      if (p.extension_count > 0 && p.latest_extension) {
        const ext = p.latest_extension;
        timeHtml += `
          <div style="margin-top: 3px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
            <span class="badge" style="background: #f3e8ff; color: #9333ea; border: 1px solid #e9d5ff; font-weight: 700; font-size: 0.68rem; padding: 1px 5px;" title="Gia hạn lần ${p.extension_count}: ${escapeHtml(ext.decision_number || '')} (${ext.decision_date_vn || ''})">
              <i class="fa-solid fa-clock-rotate-left"></i> Lần ${p.extension_count} (+${ext.months_added || 6}T)
            </span>
            <span style="font-size: 0.68rem; color: #94a3b8; text-decoration: line-through;" title="Hạn gốc ban đầu: ${p.base_end_date_vn}">
              ${p.base_end_date_vn}
            </span>
          </div>
        `;
      } else if (p.extension_count > 0) {
        timeHtml += `
          <div style="margin-top: 2px;">
            <span class="badge" style="background: #f3e8ff; color: #9333ea; font-size: 0.68rem; padding: 1px 5px;">
              <i class="fa-solid fa-clock-rotate-left"></i> Lần ${p.extension_count}
            </span>
          </div>
        `;
      }

      const aud = p.audit_summary || { completed_count: 0, total_required: 13, missing_count: 13, percentage: 0 };
      const audColor = aud.percentage === 100 ? 'var(--color-green)' : (aud.percentage < 40 ? 'var(--color-red)' : 'var(--primary)');
      const auditCellHtml = `
        <a href="/chi-tiet.html?id=${p.id}&tab=tab-docs" style="text-decoration: none; display: block;" title="Bấm để xem hoặc Upload bổ sung văn bản còn thiếu (${aud.missing_count} mục thiếu)">
          <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.78rem;">
            <strong style="color: ${audColor};">${aud.percentage}%</strong>
            <span style="color: var(--text-muted); font-size: 0.72rem;">${aud.completed_count}/${aud.total_required} mục</span>
          </div>
          <div class="audit-progress-container" style="margin-top: 3px; height: 5px;">
            <div class="audit-progress-bar" style="width: ${aud.percentage}%; background: ${audColor};"></div>
          </div>
          <div style="font-size: 0.68rem; color: ${aud.missing_count > 0 ? '#b91c1c' : '#15803d'}; margin-top: 2px; font-weight: 600;">
            ${aud.missing_count > 0 ? `<i class="fa-solid fa-cloud-arrow-up"></i> Thiếu ${aud.missing_count} giấy tờ` : '<i class="fa-solid fa-check"></i> Đủ hồ sơ'}
          </div>
        </a>
      `;

      return `
        <tr>
          <td style="color: var(--text-muted); font-size: 0.8rem; vertical-align: top; text-align: center; padding-top: 12px;">${index + 1}</td>
          <td style="vertical-align: top; padding-top: 12px;">
            <a href="/chi-tiet.html?id=${p.id}" style="font-weight: 700; color: var(--primary); text-decoration: none;">
              ${escapeHtml(p.code)}
            </a>
          </td>
          <td style="vertical-align: top; padding-top: 12px;">
            <div style="font-weight: 600; color: #1e293b; line-height: 1.45; font-size: 0.88rem;" title="${escapeHtml(p.title)}">
              ${escapeHtml(p.title)}
            </div>
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 4px;">
              Loại: <span style="font-weight: 500; color: #475569;">${escapeHtml(p.category || 'Cơ bản')}</span>
            </div>
          </td>
          <td style="vertical-align: top; padding-top: 12px;">
            <div style="font-weight: 600;">${escapeHtml(p.leader_name)}</div>
            <div style="font-size: 0.75rem; color: #0284c7;">${escapeHtml(p.research_group || '-')}</div>
          </td>
          <td style="vertical-align: top; padding-top: 12px;">
            ${timeHtml}
          </td>
          <td style="font-size: 0.85rem; font-weight: 500; white-space: nowrap; vertical-align: top; padding-top: 12px;">
            ${p.budget_total_formatted}
          </td>
          <td style="vertical-align: top; padding-top: 12px;">
            ${auditCellHtml}
          </td>
          <td style="vertical-align: top; padding-top: 12px;">
            <div class="badge ${badgeClass}" title="${escapeHtml(p.warning_msg || '')}">
              <i class="fa-solid ${icon}"></i>
              ${escapeHtml(p.badge_text)}
            </div>
          </td>
          <td style="text-align: center; vertical-align: top; padding-top: 12px;">
            <a href="/chi-tiet.html?id=${p.id}" class="btn btn-primary btn-sm" title="Xem hồ sơ 360 độ">
              Chi tiết <i class="fa-solid fa-arrow-right"></i>
            </a>
          </td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error('Lỗi khi tải bảng đề tài:', err);
    tbody.innerHTML = `
      <tr>
        <td colspan="11" style="text-align: center; padding: 2rem; color: var(--color-red);">
          <i class="fa-solid fa-circle-exclamation"></i> Không thể kết nối máy chủ để tải dữ liệu.
        </td>
      </tr>
    `;
  }
}

// 3. Xử lý Lọc dữ liệu
function applyFilters() {
  missingLegalFilter = false;
  currentFilters.group = document.getElementById('groupSelect').value;
  currentFilters.color = document.getElementById('colorSelect').value;
  currentFilters.year = document.getElementById('yearSelect').value;
  updateCardActiveState(currentFilters.color);
  loadData();
}

function filterByColor(color) {
  missingLegalFilter = false;
  document.getElementById('colorSelect').value = color;
  currentFilters.color = color;
  updateCardActiveState(color);
  loadData();

  // Tự động cuộn xuống bảng danh sách để người dùng thấy ngay kết quả
  const tableEl = document.querySelector('.table-card');
  if (tableEl) {
    tableEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// Cập nhật viền sáng active cho Card KPI đang chọn
function updateCardActiveState(color) {
  const cardMap = {
    '': 'cardTotal',
    'GREEN': 'cardGreen',
    'YELLOW': 'cardYellow',
    'RED': 'cardRed',
    'EXTENDED': 'cardExtended',
    'BLUE': 'cardBlue'
  };

  document.querySelectorAll('.kpi-card').forEach(c => c.classList.remove('active'));
  const activeId = cardMap[color] || (color === '' ? 'cardTotal' : null);
  if (activeId) {
    const el = document.getElementById(activeId);
    if (el) el.classList.add('active');
  }
}

function debounceFilter() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentFilters.q = document.getElementById('searchInput').value.trim();
    loadData();
  }, 350);
}

function resetFilters() {
  missingLegalFilter = false;
  currentFilters = { q: '', group: '', color: '', year: '', leader: '' };
  document.getElementById('searchInput').value = '';
  document.getElementById('groupSelect').value = '';
  document.getElementById('colorSelect').value = '';
  document.getElementById('yearSelect').value = '';
  updateCardActiveState('');
  renderDashboardRoleBanner();
  loadStats();
  loadData();
}

// 4. Modal Thêm đề tài mới
function openNewProjectModal() {
  document.getElementById('newProjectForm').reset();
  // Mặc định ngày hôm nay
  const today = new Date().toISOString().split('T')[0];
  document.querySelector('#newProjectForm input[name="decision_date"]').value = today;
  document.getElementById('newProjectModal').classList.add('active');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

async function handleCreateProject(e) {
  e.preventDefault();
  const form = e.target;
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (json.success) {
      showToast('Đã thêm mới đề tài thành công!', 'success');
      closeModal('newProjectModal');
      loadStats();
      loadData();
    } else {
      showToast(json.error || 'Có lỗi xảy ra', 'error');
    }
  } catch (err) {
    showToast('Lỗi mạng: ' + err.message, 'error');
  }
}

// Toast thông báo
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<i class="fa-solid fa-${type === 'success' ? 'circle-check' : 'circle-exclamation'}"></i> ${message}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
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
