// Script Quản lý Ma trận Phân quyền (RBAC)
let rbacData = null;
let currentUser = null;
let allRoles = [];
let allProfiles = [];
let highlightedRole = '';

document.addEventListener('DOMContentLoaded', () => {
  loadRBACData();
});

window.addEventListener('rbacLoaded', () => {
  loadRBACData();
});

async function loadRBACData() {
  try {
    // 1. Lấy thông tin user hiện tại
    const userRes = await fetch('/api/rbac/current-user');
    const userJson = await userRes.json();
    if (userJson.success) {
      currentUser = userJson.data;

      // Phương án 1: Chỉ SUPER_ADMIN và PHONG_KHCN mới được truy cập trang Phân quyền
      if (!['SUPER_ADMIN', 'PHONG_KHCN'].includes(currentUser.role)) {
        const container = document.querySelector('main.container');
        if (container) {
          container.innerHTML = `
            <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:3.5rem 2rem; text-align:center; max-width:620px; margin:2.5rem auto; box-shadow:var(--shadow-sm);">
              <div style="width:68px; height:68px; border-radius:50%; background:#fee2e2; color:#b91c1c; display:inline-flex; align-items:center; justify-content:center; font-size:2rem; margin-bottom:1.25rem;">
                <i class="fa-solid fa-lock"></i>
              </div>
              <h2 style="font-size:1.35rem; font-weight:700; color:#0f172a; margin-bottom:0.5rem;">Khu vực Giới hạn Quyền Quản trị</h2>
              <p style="color:#64748b; font-size:0.9rem; line-height:1.6; margin-bottom:1.75rem;">
                Theo quy định bảo mật hệ thống (Phương án 1), tính năng <strong>Quản trị & Cấu hình Phân quyền</strong> chỉ dành riêng cho <strong>Admin hệ thống</strong> và <strong>Phòng Khoa học & Công nghệ</strong>.<br>
                Bạn đang truy cập với vai trò: <strong style="color:#0f172a;">${currentUser.role_info?.name || currentUser.role}</strong>.
              </p>
              <div style="display:flex; justify-content:center; gap:12px;">
                <a href="/" class="btn btn-primary" style="text-decoration:none; padding:8px 18px;">
                  <i class="fa-solid fa-house"></i> Về Trang chủ Tổng quan
                </a>
                <a href="/quan-ly-dot.html" class="btn btn-outline" style="text-decoration:none; padding:8px 18px;">
                  <i class="fa-solid fa-file-signature"></i> Đăng ký Đề tài
                </a>
              </div>
            </div>
          `;
        }
        return;
      }

      updateCurrentUserUI();
    }

    // 2. Lấy danh sách 7 vai trò
    const rolesRes = await fetch('/api/rbac/roles');
    const rolesJson = await rolesRes.json();
    if (rolesJson.success) {
      allRoles = rolesJson.data;
      renderRoleCards();
    }

    // 3. Lấy Ma trận phân quyền
    const matrixRes = await fetch('/api/rbac/matrix');
    const matrixJson = await matrixRes.json();
    if (matrixJson.success) {
      rbacData = matrixJson.data;
      renderMatrixTable();
      renderDocResponsibilityTable();
    }

    // 4. Lấy danh sách hồ sơ demo
    const profRes = await fetch('/api/rbac/profiles');
    const profJson = await profRes.json();
    if (profJson.success) {
      allProfiles = profJson.data;
    }
  } catch (err) {
    console.error('Lỗi tải dữ liệu RBAC:', err);
    showToast('Lỗi khi tải ma trận phân quyền: ' + err.message, 'error');
  }
}

// Cập nhật thông tin vai trò đang xem trên Header & Banner
function updateCurrentUserUI() {
  if (!currentUser) return;

  const roleInfo = currentUser.role_info || {};
  
  // Navbar badge
  const navUserRole = document.getElementById('navUserRole');
  if (navUserRole) {
    navUserRole.innerText = roleInfo.short_name || currentUser.fullname;
  }
  const navIcon = document.getElementById('currentUserIcon');
  if (navIcon && roleInfo.icon) {
    navIcon.className = `fa-solid ${roleInfo.icon}`;
  }

  // Banner
  const bannerName = document.getElementById('bannerRoleName');
  const bannerDesc = document.getElementById('bannerRoleDesc');
  const bannerIcon = document.getElementById('bannerRoleIcon');
  
  if (bannerName) {
    bannerName.innerText = `${roleInfo.name} (${currentUser.fullname} • ${currentUser.unit})`;
  }
  if (bannerDesc) {
    bannerDesc.innerText = roleInfo.desc;
  }
  if (bannerIcon && roleInfo.icon) {
    bannerIcon.innerHTML = `<i class="fa-solid ${roleInfo.icon}"></i>`;
    bannerIcon.style.background = roleInfo.bg || '#dcfce7';
    bannerIcon.style.color = roleInfo.color || '#15803d';
  }
}

// Render 7 thẻ vai trò ở trên cùng
function renderRoleCards() {
  const container = document.getElementById('rolesCardsContainer');
  if (!container || !allRoles) return;

  container.innerHTML = allRoles.map(r => {
    const isCurrent = currentUser && currentUser.role === r.key;
    const isHigh = highlightedRole === r.key;

    return `
      <div class="role-card ${isCurrent ? 'active' : ''} ${isHigh ? 'highlight' : ''}" onclick="selectRoleHighlight('${r.key}')" title="Bấm để lọc / làm nổi bật cột quyền của ${r.name}">
        <div class="role-card-header">
          <div class="role-card-icon" style="background: ${r.bg}; color: ${r.color};">
            <i class="fa-solid ${r.icon}"></i>
          </div>
          <div>
            <div class="role-card-title">${escapeHtml(r.short_name)}</div>
            ${isCurrent ? '<span style="font-size: 0.65rem; background: #15803d; color: white; padding: 1px 5px; border-radius: 4px; font-weight: 700;">ĐANG CHỌN</span>' : ''}
          </div>
        </div>
        <div class="role-card-desc" title="${escapeHtml(r.desc)}">
          ${escapeHtml(r.desc)}
        </div>
      </div>
    `;
  }).join('');
}

// Render Bảng Ma trận Phân quyền
function renderMatrixTable(searchTerm = '', filterRole = '') {
  const tbody = document.getElementById('matrixTableBody');
  if (!tbody || !rbacData) return;

  const roleOrder = ['VIEN_TRUONG', 'SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TCHC', 'CHU_NHIEM', 'THU_KHO', 'PHONG_TC_CU'];
  
  let html = '';
  let globalIndex = 0;

  rbacData.groups.forEach(group => {
    // Lọc theo search term
    const matchedPerms = group.permissions.filter(p => {
      const matchText = (p.name + ' ' + p.desc + ' ' + p.key).toLowerCase().includes(searchTerm.toLowerCase());
      if (!matchText) return false;
      if (filterRole) {
        const roleAcc = p.role_access.find(ra => ra.role_key === filterRole);
        return roleAcc && roleAcc.has_access;
      }
      return true;
    });

    if (matchedPerms.length === 0) return;

    // Header nhóm chức năng
    html += `
      <tr class="matrix-group-row">
        <td colspan="9">
          <i class="fa-solid fa-folder-closed" style="color: var(--primary); margin-right: 6px;"></i>
          ${escapeHtml(group.group_name)} (${matchedPerms.length} quyền)
        </td>
      </tr>
    `;

    matchedPerms.forEach(perm => {
      globalIndex++;
      const accessMap = new Map();
      perm.role_access.forEach(ra => accessMap.set(ra.role_key, ra.has_access));

      const cellsHtml = roleOrder.map(rKey => {
        const has = accessMap.get(rKey);
        const isHighlight = highlightedRole === rKey;
        
        let iconHtml = '';
        if (has) {
          // Các icon chuyên biệt theo nghiệp vụ
          if (rKey === 'VIEN_TRUONG' && (perm.key.includes('SIGN') || perm.key.includes('APPROVE'))) {
            iconHtml = '<span class="access-badge" style="background: #f3e8ff; color: #7e22ce;" title="Thẩm quyền Ký / Phê duyệt"><i class="fa-solid fa-signature"></i></span>';
          } else if (rKey === 'CHU_NHIEM' && (perm.key.includes('OWN') || perm.key.includes('SUBMIT') || perm.key.includes('REQUISITION'))) {
            iconHtml = '<span class="access-badge" style="background: #dcfce7; color: #15803d;" title="Thực hiện trên đề tài của mình"><i class="fa-solid fa-circle-check"></i></span>';
          } else if (rKey === 'THU_KHO' && perm.key.includes('WAREHOUSE')) {
            iconHtml = '<span class="access-badge" style="background: #ffedd5; color: #c2410c;" title="Nghiệp vụ xuất kho"><i class="fa-solid fa-boxes-packing"></i></span>';
          } else if (rKey === 'PHONG_TCHC' && perm.key.includes('STAMP')) {
            iconHtml = '<span class="access-badge" style="background: #fef3c7; color: #b45309;" title="Đóng dấu & phát hành"><i class="fa-solid fa-stamp"></i></span>';
          } else if (rKey === 'PHONG_TC_CU' && (perm.key.includes('MISA') || perm.key.includes('DISBURSE') || perm.key.includes('SETTLEMENT'))) {
            iconHtml = '<span class="access-badge" style="background: #e0e7ff; color: #4338ca;" title="Nghiệp vụ Tài chính - MISA"><i class="fa-solid fa-calculator"></i></span>';
          } else {
            iconHtml = '<span class="access-badge access-yes" title="Có quyền thực hiện"><i class="fa-solid fa-check"></i></span>';
          }
        } else {
          iconHtml = '<span class="access-no" title="Không có quyền"><i class="fa-solid fa-minus"></i></span>';
        }

        return `
          <td class="access-cell ${isHighlight ? 'highlight' : ''}" data-role="${rKey}">
            ${iconHtml}
          </td>
        `;
      }).join('');

      html += `
        <tr>
          <td style="text-align: center; font-size: 0.75rem; color: var(--text-muted);">${globalIndex}</td>
          <td>
            <div class="perm-name">${escapeHtml(perm.name)}</div>
            <div class="perm-desc">${escapeHtml(perm.desc)}</div>
          </td>
          ${cellsHtml}
        </tr>
      `;
    });
  });

  if (globalIndex === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align: center; padding: 3rem; color: var(--text-muted);">
          <i class="fa-solid fa-filter-circle-xmark" style="font-size: 2rem; color: #cbd5e1; display: block; margin-bottom: 8px;"></i>
          Không tìm thấy chức năng hoặc quyền hạn nào phù hợp với từ khóa lọc.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = html;
}

// Lọc Ma trận
function filterMatrix() {
  const q = document.getElementById('searchInput').value.trim();
  const role = document.getElementById('roleFilterSelect').value;
  highlightedRole = role;
  renderRoleCards();
  renderMatrixTable(q, role);
}

function selectRoleHighlight(roleKey) {
  if (highlightedRole === roleKey) {
    highlightedRole = '';
  } else {
    highlightedRole = roleKey;
  }
  document.getElementById('roleFilterSelect').value = highlightedRole;
  filterMatrix();
}

function resetMatrixFilter() {
  document.getElementById('searchInput').value = '';
  document.getElementById('roleFilterSelect').value = '';
  highlightedRole = '';
  renderRoleCards();
  renderMatrixTable('', '');
}

// Render Bảng Phân định Trách nhiệm 18 Đầu mục Văn bản Pháp lý
function renderDocResponsibilityTable() {
  const tbody = document.getElementById('docResponsibilityTableBody');
  if (!tbody || !rbacData || !rbacData.document_criteria) return;

  const roleLabels = {
    SUPER_ADMIN: 'Admin HT',
    VIEN_TRUONG: 'Viện trưởng',
    PHONG_KHCN: 'Phòng KHCN',
    CHU_NHIEM: 'Chủ nhiệm ĐT',
    PHONG_TCHC: 'Phòng TC-HC',
    PHONG_TC_CU: 'Phòng TC-CU',
    THU_KHO: 'Thủ kho'
  };

  tbody.innerHTML = rbacData.document_criteria.map((c, idx) => {
    const ownerColor = c.owner_role === 'CHU_NHIEM' ? '#0d9488' : (c.owner_role === 'PHONG_TC_CU' ? '#ea580c' : '#0284c7');
    const ownerBg = c.owner_role === 'CHU_NHIEM' ? '#f0fdfa' : (c.owner_role === 'PHONG_TC_CU' ? '#fff7ed' : '#f0f9ff');

    const uploadRolesBadges = (c.allowed_upload_roles || []).map(rk => {
      return `<span class="badge badge-gray" style="font-size: 0.7rem; margin: 1px;">${escapeHtml(roleLabels[rk] || rk)}</span>`;
    }).join(' ');

    const signVerifyText = c.owner_role === 'CHU_NHIEM'
      ? '<span style="color:#0284c7; font-size:0.78rem; font-weight:600;"><i class="fa-solid fa-stamp"></i> P. KHCN kiểm tra & Xác thực bản cứng</span>'
      : '<span style="color:#7e22ce; font-size:0.78rem; font-weight:600;"><i class="fa-solid fa-signature"></i> Viện trưởng ký duyệt / P. KHCN & TC-HC lưu gốc</span>';

    return `
      <tr>
        <td style="text-align: center; font-weight: 600; color: var(--text-muted);">${idx + 1}</td>
        <td><span class="badge badge-blue" style="font-size: 0.72rem;">Giai đoạn ${c.stage}</span></td>
        <td>
          <div style="font-weight: 700; color: #1e293b; font-size: 0.85rem;">
            <i class="fa-solid ${c.icon}" style="color: var(--primary); margin-right: 5px;"></i>${escapeHtml(c.name)}
          </div>
          <div style="font-size: 0.74rem; color: #64748b; margin-top: 2px;">${escapeHtml(c.desc)}</div>
        </td>
        <td>
          <span style="display: inline-block; background: ${ownerBg}; color: ${ownerColor}; border: 1px solid ${ownerColor}44; padding: 3px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 700;">
            ${escapeHtml(c.owner_label)}
          </span>
        </td>
        <td>${uploadRolesBadges}</td>
        <td>${signVerifyText}</td>
      </tr>
    `;
  }).join('');
}

// Modal đổi vai trò
function openRoleModal() {
  if (!currentUser || !currentUser.can_switch_role) return;
  if (typeof window.openGlobalRoleSwitcherModal === 'function') {
    window.openGlobalRoleSwitcherModal();
    return;
  }
  const container = document.getElementById('profilesListContainer');
  if (!container || !allProfiles) return;

  container.innerHTML = allProfiles.map(p => {
    const isCurrent = currentUser && currentUser.role === p.role;
    const rInfo = p.role_info || {};

    return `
      <div class="profile-item ${isCurrent ? 'current' : ''}" onclick="switchRole('${p.role}')">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="width: 40px; height: 40px; border-radius: 8px; background: ${rInfo.bg || '#f1f5f9'}; color: ${rInfo.color || '#334155'}; display: flex; align-items: center; justify-content: center; font-size: 1.1rem;">
            <i class="fa-solid ${rInfo.icon || 'fa-user'}"></i>
          </div>
          <div>
            <div style="font-weight: 700; font-size: 0.9rem; color: #1e293b;">
              ${escapeHtml(rInfo.name)}
            </div>
            <div style="font-size: 0.75rem; color: #64748b;">
              ${escapeHtml(p.fullname)} • <span style="color: #0284c7;">${escapeHtml(p.unit)}</span>
            </div>
          </div>
        </div>
        <div>
          ${isCurrent 
            ? '<span class="badge badge-green"><i class="fa-solid fa-circle-check"></i> Đang chọn</span>' 
            : '<button class="btn btn-outline btn-sm">Chọn vai trò này</button>'}
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('roleSwitcherModal').classList.add('active');
}

function closeRoleModal() {
  document.getElementById('roleSwitcherModal').classList.remove('active');
}

// Chuyển đổi vai trò
async function switchRole(roleKey) {
  try {
    const res = await fetch('/api/rbac/switch-role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: roleKey })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message, 'success');
      closeRoleModal();
      // Tải lại dữ liệu trang
      setTimeout(() => {
        window.location.reload();
      }, 500);
    } else {
      showToast(json.error || 'Không thể chuyển vai trò', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối máy chủ: ' + err.message, 'error');
  }
}

// Xuất file CSV Ma trận
function exportMatrixCSV() {
  if (!rbacData) return;

  const roleOrder = ['VIEN_TRUONG', 'SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TCHC', 'CHU_NHIEM', 'THU_KHO', 'PHONG_TC_CU'];
  const roleNames = ['Viện trưởng', 'Admin hệ thống', 'Phòng KHCN', 'Phòng TC-HC', 'Chủ nhiệm đề tài', 'Thủ kho', 'Phòng TC-Cung ứng'];

  let csv = '\uFEFF'; // BOM
  csv += 'STT,Nhóm chức năng,Tên quyền hạn,Mô tả chi tiết,' + roleNames.join(',') + '\n';

  let stt = 0;
  rbacData.groups.forEach(g => {
    g.permissions.forEach(p => {
      stt++;
      const row = [
        stt,
        `"${g.group_name.replace(/"/g, '""')}"`,
        `"${p.name.replace(/"/g, '""')}"`,
        `"${p.desc.replace(/"/g, '""')}"`
      ];

      const accessMap = new Map();
      p.role_access.forEach(ra => accessMap.set(ra.role_key, ra.has_access));

      roleOrder.forEach(r => {
        row.push(accessMap.get(r) ? '"Có quyền (X)"' : '""');
      });

      csv += row.join(',') + '\n';
    });
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Ma_tran_phan_quyen_de_tai_cap_vien_SCI_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('Đã xuất thành công file CSV Ma trận phân quyền!', 'success');
}

function showToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
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
