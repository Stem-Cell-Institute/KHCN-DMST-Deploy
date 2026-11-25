// Shared Global RBAC Header & Role Switcher
// Quản lý phân quyền: Admin hệ thống, Viện trưởng, Phòng KHCN, Chủ nhiệm đề tài & các phòng ban phối hợp

window.CURRENT_USER = null;
window.RBAC_PROFILES = [];
window.AVAILABLE_LEADERS = [];

document.addEventListener('DOMContentLoaded', () => {
  initGlobalRbac();
});

async function initGlobalRbac() {
  try {
    const [userRes, profRes] = await Promise.all([
      fetch('/api/rbac/current-user'),
      fetch('/api/rbac/profiles')
    ]);
    const userJson = await userRes.json();
    const profJson = await profRes.json();

    if (userJson.success) {
      window.CURRENT_USER = userJson.data;
    }
    if (profJson.success) {
      window.RBAC_PROFILES = profJson.data || [];
      window.AVAILABLE_LEADERS = profJson.leaders || (userJson.data && userJson.data.available_leaders) || [];
    }

    renderNavbarRoleWidget();
    ensureGlobalRoleModal();
    updateNavbarCallStatus();
    updateKhcnActionBadge();

    window.dispatchEvent(new CustomEvent('rbacLoaded', { detail: window.CURRENT_USER }));
  } catch (err) {
    console.error('Lỗi khởi tạo RBAC:', err);
  }
}

async function updateKhcnActionBadge() {
  try {
    const res = await fetch('/api/projects/action-center');
    const json = await res.json();
    if (!json.success || !json.data) return;
    const s = json.data.summary || {};
    const total = (s.pending_proposals_cnt || 0) + (s.missing_legal_docs_cnt || 0) + (s.urgent_deadlines_cnt || 0) + (s.pending_adjustments_cnt || 0);

    const badges = document.querySelectorAll('.khcn-work-badge');
    badges.forEach(b => {
      b.innerText = total;
      b.style.display = total > 0 ? 'inline-block' : 'none';
    });
  } catch (_) {}
}

async function updateNavbarCallStatus() {
  try {
    const res = await fetch('/api/calls/current');
    const json = await res.json();
    if (!json.success || !json.data || !json.data.call) return;
    const call = json.data.call;
    const navLinks = document.querySelectorAll('.nav-menu a[href*="quan-ly-dot"]');
    navLinks.forEach(link => {
      const existingDot = link.querySelector('.pulse-dot');
      if (call.is_active) {
        if (!existingDot) {
          link.insertAdjacentHTML('beforeend', '<span class="pulse-dot" title="Đợt đăng ký đang mở thường xuyên"></span><span class="open-call-badge">Đang mở</span>');
        }
      } else {
        const pDot = link.querySelector('.pulse-dot');
        const oBadge = link.querySelector('.open-call-badge');
        if (pDot) pDot.remove();
        if (oBadge) oBadge.remove();
      }
    });
  } catch (err) {}
}

window.getCurrentRole = function () {
  return (window.CURRENT_USER && window.CURRENT_USER.role) || 'PHONG_KHCN';
};

window.getCurrentLeader = function () {
  if (window.getCurrentRole() === 'CHU_NHIEM') {
    return (window.CURRENT_USER && window.CURRENT_USER.leader_name) || 'Nguyễn Trường Sinh';
  }
  return null;
};

window.isProjectOwnedByCurrentUser = function (projectLeaderName, projectLeaderEmail) {
  const role = window.getCurrentRole();
  if (role !== 'CHU_NHIEM') return true;
  const u = window.CURRENT_USER || {};
  const pEmail = String(projectLeaderEmail || '').trim().toLowerCase();
  const uEmail = String(u.email || '').trim().toLowerCase();
  if (pEmail && !u.is_role_preview) {
    return !!uEmail && pEmail === uEmail;
  }
  const norm = (s) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/\b(gs|pgs|ts|ths|cn|ks|bs|dr|mr|ms|mrs|prof)\b\.?/gi, ' ')
    .replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const activeLeader = norm(window.getCurrentLeader() || u.fullname);
  const projLeader = norm(projectLeaderName);
  if (!activeLeader || !projLeader) return false;
  return projLeader === activeLeader;
};

window.canUserUploadCriteria = function (allowedUploadRoles, projectLeaderName) {
  const role = window.getCurrentRole();
  if (role === 'SUPER_ADMIN' || role === 'PHONG_KHCN') return true;
  if (Array.isArray(allowedUploadRoles) && !allowedUploadRoles.includes(role)) {
    return false;
  }
  if (role === 'CHU_NHIEM') {
    return window.isProjectOwnedByCurrentUser(projectLeaderName);
  }
  return Array.isArray(allowedUploadRoles) ? allowedUploadRoles.includes(role) : false;
};

window.canUserVerifyHardcopy = function () {
  const role = window.getCurrentRole();
  return ['SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TCHC', 'PHONG_TC_CU'].includes(role);
};

function renderNavbarRoleWidget() {
  if (!window.CURRENT_USER) return;
  const u = window.CURRENT_USER;
  const r = u.role_info || {};
  const navUser = document.querySelector('.nav-user');
  if (!navUser) return;

  const canSwitch = !!u.can_switch_role;
  // Tìm hoặc tạo nút hiển thị vai trò (chỉ Admin Eoffice mới có nút "Đổi vai trò")
  let badgeEl = document.getElementById('activeRoleBadgeHeader');
  const displayTitle = u.role === 'CHU_NHIEM'
    ? `CNĐT: ${u.leader_name || u.fullname}`
    : (r.short_name || u.role);

  const switchPill = canSwitch
    ? `<span style="font-size:10px; background:rgba(0,0,0,0.08); padding:1px 6px; border-radius:8px; margin-left:2px;">Đổi vai trò <i class="fa-solid fa-caret-down"></i></span>`
    : '';
  const badgeHtml = `
    <i class="fa-solid ${r.icon || 'fa-user-shield'}"></i>
    <span>${displayTitle}</span>
    ${switchPill}
  `;

  const applyBadge = (el) => {
    el.id = 'activeRoleBadgeHeader';
    el.style.background = r.bg_light || '#eff6ff';
    el.style.color = r.color || '#0284c7';
    el.style.border = `1px solid ${(r.color || '#0284c7')}55`;
    if (canSwitch) {
      el.style.cursor = 'pointer';
      el.title = 'Admin: Click để xem thử dưới vai trò khác';
      el.onclick = function (ev) { if (ev) ev.preventDefault(); openGlobalRoleSwitcherModal(); };
    } else {
      el.style.cursor = 'default';
      el.title = `${u.fullname || ''} — ${r.name || u.role}`;
      el.removeAttribute('href');
      el.onclick = function (ev) { if (ev) ev.preventDefault(); };
    }
    el.innerHTML = badgeHtml;
  };

  if (badgeEl) {
    applyBadge(badgeEl);
  } else {
    const firstBadge = navUser.querySelector('.user-badge');
    if (firstBadge) applyBadge(firstBadge);
  }

  // Phương án 1: Chỉ Admin hệ thống, Viện trưởng và Phòng KHCN mới thấy Menu Bàn làm việc KHCN & Phân quyền
  const isKhcnOrAdmin = ['SUPER_ADMIN', 'PHONG_KHCN', 'VIEN_TRUONG'].includes(u.role);
  document.querySelectorAll('.nav-khcn-only').forEach(link => {
    link.style.display = isKhcnOrAdmin ? 'inline-flex' : 'none';
  });

  const canAccessRbac = ['SUPER_ADMIN', 'PHONG_KHCN'].includes(u.role);
  document.querySelectorAll('.nav-menu a[href*="phan-quyen"]').forEach(link => {
    link.style.display = canAccessRbac ? 'inline-flex' : 'none';
  });

  if (!canSwitch) {
    document.querySelectorAll('[onclick*="openGlobalRoleSwitcherModal"], [onclick*="openSwitchRoleModal"], [onclick*="openRoleModal"]').forEach(el => {
      el.style.display = 'none';
    });
  }
}

function ensureGlobalRoleModal() {
  if (document.getElementById('globalRoleSwitcherModal')) return;

  const modalDiv = document.createElement('div');
  modalDiv.id = 'globalRoleSwitcherModal';
  modalDiv.className = 'modal-overlay';
  modalDiv.innerHTML = `
    <div class="modal-box" style="max-width: 780px;">
      <div class="modal-header" style="background:#f8fafc;">
        <div>
          <h3 class="modal-title"><i class="fa-solid fa-user-gear" style="color:var(--primary)"></i> Chuyển đổi Vai trò & Phân quyền Quản lý Đề tài</h3>
          <div style="font-size:12px; color:var(--text-secondary); margin-top:2px;">
            Mô phỏng phân quyền thực tế tại Viện Tế bào gốc (Admin, Viện trưởng, Phòng KHCN, Chủ nhiệm đề tài...)
          </div>
        </div>
        <button class="modal-close" onclick="closeGlobalRoleSwitcherModal()">&times;</button>
      </div>
      <div class="modal-body" id="globalRoleSwitcherBody" style="max-height:78vh; overflow-y:auto;">
      </div>
    </div>
  `;
  document.body.appendChild(modalDiv);
}

window.openGlobalRoleSwitcherModal = function () {
  if (!window.CURRENT_USER || !window.CURRENT_USER.can_switch_role) return;
  ensureGlobalRoleModal();
  const bodyEl = document.getElementById('globalRoleSwitcherBody');
  const activeRole = window.getCurrentRole();
  const activeLeader = window.getCurrentLeader() || 'Nguyễn Trường Sinh';

  const coreRoles = ['SUPER_ADMIN', 'VIEN_TRUONG', 'PHONG_KHCN', 'CHU_NHIEM'];
  const supportRoles = ['PHONG_TCHC', 'PHONG_TC_CU', 'THU_KHO'];

  const roleSummaryMap = {
    SUPER_ADMIN: {
      tag: 'Toàn quyền hệ thống',
      duties: 'Quản trị kỹ thuật toàn hệ thống, cấu hình ma trận phân quyền, upload/xóa/xác thực mọi hồ sơ, can thiệp xử lý sự cố dữ liệu.'
    },
    VIEN_TRUONG: {
      tag: 'Thẩm quyền Phê duyệt cấp Viện',
      duties: 'Giám sát vĩ mô 30 đề tài toàn Viện, xem trước mọi hồ sơ PDF, Phê duyệt Điều chỉnh dự toán (Bước 3) & ký Quyết định giao nhiệm vụ / gia hạn / công nhận nghiệm thu.'
    },
    PHONG_KHCN: {
      tag: 'Đầu mối Quản lý KHCN & Kiểm toán',
      duties: 'Theo dõi hồ sơ toàn Viện, Upload Biên bản Hội đồng / Quyết định / Hợp đồng hoặc nộp bổ sung thay CNĐT, Xác thực đối chiếu bản cứng (Hardcopy), Thẩm định điều chỉnh dự toán (Bước 2).'
    },
    CHU_NHIEM: {
      tag: 'Thực hiện đề tài & Nộp hồ sơ chuyên môn',
      duties: 'Quản lý các đề tài do mình làm Chủ nhiệm; Trực tiếp Upload bổ sung Thuyết minh, Dự toán, Báo cáo 6 tháng, Đơn xin gia hạn, Báo cáo tổng kết, Sản phẩm KHCN, Giải trình sau nghiệm thu & Lập tờ trình điều chỉnh dự toán (Bước 1).'
    },
    PHONG_TCHC: {
      tag: 'Văn thư & Lưu trữ pháp lý',
      duties: 'Cấp số văn bản, đóng dấu ban hành các Quyết định hành chính và xác thực lưu trữ bản gốc.'
    },
    PHONG_TC_CU: {
      tag: 'Tài chính - Kế toán - Cung ứng',
      duties: 'Thẩm định dự toán, đối chiếu chứng từ hóa đơn mua sắm vật tư, xác nhận quyết toán và ký Biên bản thanh lý hợp đồng.'
    },
    THU_KHO: {
      tag: 'Quản lý Kho Vật tư - Hóa chất',
      duties: 'Theo dõi tồn kho hóa chất, sinh phẩm và xác nhận xuất kho thực tế cho từng đề tài.'
    }
  };

  const renderRoleCard = (p) => {
    const r = p.role_info || {};
    const isCurrent = p.role === activeRole;
    const summary = roleSummaryMap[p.role] || { tag: r.short_name, duties: r.description };

    if (p.role === 'CHU_NHIEM') {
      const leaderOptions = (window.AVAILABLE_LEADERS || []).map(l => {
        const selected = l.leader_name === activeLeader ? 'selected' : '';
        return `<option value="${l.leader_name}" ${selected}>${l.leader_name} (${l.project_count} đề tài - ${l.research_group || 'SCI'})</option>`;
      }).join('');

      return `
        <div style="border:2px solid ${isCurrent ? r.color : '#e2e8f0'}; background:${isCurrent ? r.bg_light : '#ffffff'}; border-radius:10px; padding:14px; transition:all 0.15s;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
            <div style="display:flex; align-items:center; gap:10px;">
              <div style="width:38px; height:38px; border-radius:8px; background:${r.bg_light}; color:${r.color}; display:flex; align-items:center; justify-content:center; font-size:17px; flex-shrink:0;">
                <i class="fa-solid ${r.icon}"></i>
              </div>
              <div>
                <div style="font-weight:700; font-size:14px; color:#0f172a;">${r.name}</div>
                <span style="display:inline-block; font-size:11px; font-weight:600; color:${r.color};">${summary.tag}</span>
              </div>
            </div>
            ${isCurrent ? `<span class="badge badge-green"><i class="fa-solid fa-check"></i> Đang chọn</span>` : ''}
          </div>
          <div style="font-size:12px; color:#475569; margin:8px 0 10px 0; line-height:1.45;">
            ${summary.duties}
          </div>
          <div style="background:#f8fafc; padding:10px; border-radius:8px; border:1px solid #cbd5e1;">
            <label style="display:block; font-size:11px; font-weight:700; color:#334155; margin-bottom:4px;">
              <i class="fa-solid fa-user-graduate"></i> Chọn Chủ nhiệm đề tài thực tế tại Viện để thao tác:
            </label>
            <div style="display:flex; gap:8px;">
              <select id="globalSelectLeaderName" class="form-control" style="font-size:12px; padding:5px 8px; flex:1;" onclick="event.stopPropagation()">
                ${leaderOptions}
              </select>
              <button class="btn btn-primary btn-sm" style="background:${r.color}; border-color:${r.color}; white-space:nowrap;"
                onclick="switchSystemRoleGlobal('CHU_NHIEM', document.getElementById('globalSelectLeaderName').value)">
                <i class="fa-solid fa-right-to-bracket"></i> Vào vai CNĐT này
              </button>
            </div>
          </div>
        </div>
      `;
    }

    return `
      <div onclick="switchSystemRoleGlobal('${p.role}')" style="cursor:pointer; border:2px solid ${isCurrent ? r.color : '#e2e8f0'}; background:${isCurrent ? r.bg_light : '#ffffff'}; border-radius:10px; padding:14px; transition:all 0.15s;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
          <div style="display:flex; align-items:center; gap:10px;">
            <div style="width:38px; height:38px; border-radius:8px; background:${r.bg_light}; color:${r.color}; display:flex; align-items:center; justify-content:center; font-size:17px; flex-shrink:0;">
              <i class="fa-solid ${r.icon}"></i>
            </div>
            <div>
              <div style="font-weight:700; font-size:14px; color:#0f172a;">${r.name}</div>
              <span style="display:inline-block; font-size:11px; font-weight:600; color:${r.color};">${summary.tag}</span>
            </div>
          </div>
          ${isCurrent
            ? `<span class="badge badge-green"><i class="fa-solid fa-check"></i> Đang chọn</span>`
            : `<button class="btn btn-outline btn-sm" style="font-size:11px; padding:3px 8px;">Chọn vai trò</button>`}
        </div>
        <div style="font-size:12px; color:#475569; margin-top:8px; line-height:1.45;">
          ${summary.duties}
        </div>
        <div style="font-size:11px; color:#64748b; margin-top:6px;">
          <i class="fa-solid fa-id-badge"></i> Tài khoản đại diện: <strong>${p.fullname}</strong> (${p.title})
        </div>
      </div>
    `;
  };

  const coreProfiles = coreRoles.map(k => (window.RBAC_PROFILES || []).find(p => p.role === k)).filter(Boolean);
  const supportProfiles = supportRoles.map(k => (window.RBAC_PROFILES || []).find(p => p.role === k)).filter(Boolean);

  bodyEl.innerHTML = `
    <div style="margin-bottom:14px;">
      <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:#0f172a; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
        <i class="fa-solid fa-star" style="color:#d97706;"></i> 4 Vai trò Trọng tâm trong Quản lý & Cập nhật Hồ sơ Đề tài
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        ${coreProfiles.map(renderRoleCard).join('')}
      </div>
    </div>

    <div>
      <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:#64748b; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
        <i class="fa-solid fa-building-user"></i> Các bộ phận Phối hợp (Văn thư, Tài chính - Cung ứng, Thủ kho)
      </div>
      <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:10px;">
        ${supportProfiles.map(renderRoleCard).join('')}
      </div>
    </div>

    <div style="margin-top:14px; padding-top:12px; border-top:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center;">
      ${['SUPER_ADMIN', 'PHONG_KHCN'].includes(activeRole)
        ? `<a href="/phan-quyen.html" style="font-size:12px; font-weight:600; color:var(--primary); text-decoration:none;">
             <i class="fa-solid fa-table-cells-large"></i> Xem chi tiết Ma trận Phân quyền & Quy trình phối hợp &rarr;
           </a>`
        : `<span style="font-size:12px; color:#64748b;"><i class="fa-solid fa-shield-halved"></i> Quản trị phân quyền do Admin & Phòng KHCN phụ trách</span>`}
      <button class="btn btn-outline btn-sm" onclick="closeGlobalRoleSwitcherModal()">Đóng</button>
    </div>
  `;

  document.getElementById('globalRoleSwitcherModal').classList.add('active');
};

window.closeGlobalRoleSwitcherModal = function () {
  const modal = document.getElementById('globalRoleSwitcherModal');
  if (modal) modal.classList.remove('active');
};

window.switchSystemRoleGlobal = async function (roleKey, leaderName) {
  try {
    const res = await fetch('/api/rbac/switch-role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: roleKey, leader_name: leaderName })
    });
    const json = await res.json();
    if (!json.success) {
      alert('Lỗi chuyển vai trò: ' + json.error);
      return;
    }
    closeGlobalRoleSwitcherModal();
    // Reload lại dữ liệu RBAC và phát sự kiện cập nhật giao diện
    await initGlobalRbac();
    if (typeof showToast === 'function') {
      showToast(json.message);
    }
  } catch (err) {
    alert('Lỗi kết nối khi chuyển vai trò: ' + err.message);
  }
};
