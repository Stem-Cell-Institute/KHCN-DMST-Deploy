// Client-side Script: Quản lý Đợt Kêu gọi Đề xuất Đề tài & Tự động Gửi Email Thông báo
let currentCallData = null;
let allProposals = [];

document.addEventListener('DOMContentLoaded', () => {
  loadCallInfo();
  loadProposals();
});

window.addEventListener('rbacLoaded', () => {
  renderCallRoleBanner();
  renderProposalsTable();
});

function renderCallRoleBanner() {
  const banner = document.getElementById('callRoleBanner');
  const textEl = document.getElementById('callRoleText');
  const khcnBox = document.getElementById('khcnCallControlBox');
  if (!banner || !textEl || !window.CURRENT_USER) return;

  const u = window.CURRENT_USER;
  const r = u.role_info || {};
  banner.style.borderLeftColor = r.color || 'var(--primary)';

  let roleNote = '';
  if (u.role === 'CHU_NHIEM') {
    roleNote = `Bạn đang xem với tư cách <strong>Chủ nhiệm: ${escapeHtml(u.leader_name)}</strong>. Bấm nút <em>"Nộp Đề xuất Đề tài"</em> để nộp đề xuất mới.`;
    const leaderInput = document.getElementById('propLeaderInput');
    if (leaderInput && u.leader_name) leaderInput.value = u.leader_name;
    const groupInput = document.getElementById('propResearchGroupInput');
    if (groupInput && !groupInput.value) {
      const matchLeader = (window.AVAILABLE_LEADERS || []).find(l => l.leader_name === u.leader_name);
      if (matchLeader && matchLeader.research_group) groupInput.value = matchLeader.research_group;
    }
  } else if (u.role === 'PHONG_KHCN') {
    roleNote = 'Quyền Phòng KHCN: Tiếp nhận hồ sơ thường xuyên, thẩm định thuyết minh/dự toán, lên lịch Hội đồng và quản lý đợt.';
  } else if (u.role === 'VIEN_TRUONG') {
    roleNote = 'Quyền Viện trưởng: Xem trước thuyết minh đề tài, phê duyệt giao nhiệm vụ & ban hành Quyết định giao nhiệm vụ.';
  } else if (u.role === 'SUPER_ADMIN') {
    roleNote = 'Quyền Admin toàn hệ thống: Toàn quyền cấu hình đợt và quản lý mọi hồ sơ.';
  } else {
    roleNote = r.description || '';
  }

  textEl.innerHTML = `
    <span style="width: 28px; height: 28px; border-radius: 6px; background: ${r.bg_light || '#eff6ff'}; color: ${r.color || '#0284c7'}; display: inline-flex; align-items: center; justify-content: center;">
      <i class="fa-solid ${r.icon || 'fa-user-shield'}"></i>
    </span>
    <div>
      <strong>Vai trò: ${escapeHtml(u.role === 'CHU_NHIEM' ? `CNĐT ${u.leader_name}` : (r.name || u.role))}</strong>
      <span style="color: #475569; margin-left: 6px;">— ${roleNote}</span>
    </div>
  `;

  if (khcnBox) {
    khcnBox.style.display = ['SUPER_ADMIN', 'PHONG_KHCN'].includes(u.role) ? 'block' : 'none';
  }
}

// 1. Tải thông tin Đợt đang mở & Bộ biểu mẫu chuẩn
async function loadCallInfo() {
  try {
    const res = await fetch('/api/calls/current');
    const json = await res.json();
    if (!json.success) return;

    currentCallData = json.data;
    const call = json.data.call;

    document.getElementById('callCodeText').innerText = call.call_code;
    document.getElementById('callTitleText').innerText = call.title;
    const glEl = document.getElementById('callGuidelinesText');
    if (glEl) glEl.innerText = call.guidelines || '';

    const badge = document.getElementById('callStatusBadge');
    const toggleBtn = document.getElementById('btnToggleCallActive');
    const submitBtn = document.getElementById('btnSubmitProposalMain');

    if (call.is_active) {
      badge.style.background = '#22c55e';
      badge.innerHTML = '<i class="fa-solid fa-circle-check"></i> ĐANG MỞ TIẾP NHẬN THƯỜNG XUYÊN';
      if (toggleBtn) {
        toggleBtn.innerHTML = '<i class="fa-solid fa-power-off"></i> Đóng đợt (Khi Viện dừng tổ chức)';
        toggleBtn.className = 'btn btn-outline btn-sm';
      }
      if (submitBtn) submitBtn.style.display = 'inline-flex';
    } else {
      badge.style.background = '#ef4444';
      badge.innerHTML = '<i class="fa-solid fa-ban"></i> ĐỢT ĐÃ ĐÓNG (VIỆN DỪNG TỔ CHỨC)';
      if (toggleBtn) {
        toggleBtn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> Mở lại đợt tiếp nhận';
        toggleBtn.className = 'btn btn-primary btn-sm';
      }
      if (submitBtn) submitBtn.style.display = 'none';
    }

    renderOfficialForms(json.data.forms || []);

    // Cập nhật số lượng email trong badge Nhật ký Email
    try {
      const eRes = await fetch('/api/calls/email-logs');
      const eJson = await eRes.json();
      const countBadge = document.getElementById('emailLogsCountBadge');
      if (countBadge && eJson.success && Array.isArray(eJson.data)) {
        countBadge.innerText = eJson.data.length;
        countBadge.style.display = eJson.data.length > 0 ? 'inline-block' : 'none';
      }
    } catch (e) {}
  } catch (err) {
    console.error('Lỗi tải thông tin đợt:', err);
  }
}

// Render các thẻ tải biểu mẫu chuẩn
function renderOfficialForms(forms) {
  const container = document.getElementById('formsContainer');
  if (!container) return;

  container.innerHTML = forms.map(f => {
    const icon = f.file_type === 'xlsx' ? 'fa-file-excel' : 'fa-file-word';
    const iconColor = f.file_type === 'xlsx' ? '#16a34a' : '#0284c7';

    return `
      <div class="form-download-card">
        <div style="display: flex; align-items: center; gap: 10px; flex: 1;">
          <i class="fa-solid ${icon}" style="font-size: 1.6rem; color: ${iconColor};"></i>
          <div>
            <div style="font-weight: 700; font-size: 0.85rem; color: #1e293b;">${escapeHtml(f.name)}</div>
          </div>
        </div>
        <button class="btn btn-outline btn-sm" onclick="downloadSampleForm('${f.code}', '${escapeHtml(f.name)}')" title="Tải file mẫu về máy" style="padding: 4px 10px; font-size: 0.75rem; white-space: nowrap; margin-left: 8px;">
          <i class="fa-solid fa-download"></i> Tải mẫu
        </button>
      </div>
    `;
  }).join('');
}

function downloadSampleForm(formCode, formName) {
  showToast(`Đang tải xuống biểu mẫu chuẩn: ${formName}`, 'success');
  window.open(`/api/calls/download-template/${formCode}`, '_blank');
}

// 2. Tải danh sách hồ sơ đề xuất cuốn chiếu
async function loadProposals() {
  const tbody = document.getElementById('proposalsTableBody');
  tbody.innerHTML = `
    <tr>
      <td colspan="8" style="text-align: center; padding: 2rem; color: var(--text-muted);">
        <i class="fa-solid fa-spinner fa-spin"></i> Đang tải dữ liệu hồ sơ đề xuất...
      </td>
    </tr>
  `;

  try {
    const status = document.getElementById('proposalFilterStatus').value;
    let url = '/api/calls/proposals';
    if (status) url += `?status=${status}`;

    const res = await fetch(url);
    const json = await res.json();
    if (json.success) {
      allProposals = json.data;
      renderProposalsTable();
    } else {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--color-red); padding: 1.5rem;">Lỗi: ${json.error}</td></tr>`;
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--color-red); padding: 1.5rem;">Lỗi kết nối máy chủ (${err.message})</td></tr>`;
  }
}

// Render bảng danh sách hồ sơ đề xuất
function renderProposalsTable() {
  const tbody = document.getElementById('proposalsTableBody');
  if (!tbody) return;

  if (allProposals.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; padding: 2.5rem; color: var(--text-muted);">
          <i class="fa-solid fa-folder-open" style="font-size: 2rem; color: #cbd5e1; display: block; margin-bottom: 6px;"></i>
          Chưa có hồ sơ đề xuất nào. Bấm <strong>"Nộp Đề xuất Đề tài"</strong> ở góc trên để nộp đề xuất mới.
        </td>
      </tr>
    `;
    return;
  }

  const role = typeof window.getCurrentRole === 'function' ? window.getCurrentRole() : 'PHONG_KHCN';
  const canKhcn = ['SUPER_ADMIN', 'PHONG_KHCN'].includes(role);
  const canDirector = ['SUPER_ADMIN', 'VIEN_TRUONG'].includes(role);

  tbody.innerHTML = allProposals.map((p, idx) => {
    let statusPill = '';
    let actionBtn = '';

    if (p.status === 'SUBMITTED') {
      statusPill = '<span class="status-step-pill step-submitted"><i class="fa-solid fa-clock"></i> Mới nộp (P.KHCN sơ duyệt)</span>';
      if (canKhcn) {
        actionBtn = `
          <button class="btn btn-outline btn-sm" onclick="openScheduleCouncilModal(${p.id}, '${escapeHtml(p.title)}', '${escapeHtml(p.leader_name)}')" style="font-size: 0.72rem; padding: 3px 8px; color: #7e22ce; border-color: #d8b4fe;">
            <i class="fa-solid fa-calendar-check"></i> Lên lịch Hội đồng
          </button>
        `;
      }
    } else if (p.status === 'COUNCIL_REVIEW') {
      statusPill = `<span class="status-step-pill step-council"><i class="fa-solid fa-users"></i> Hội đồng xét (${p.council_date || 'Đang họp'})</span>`;
      if (canDirector) {
        actionBtn = `
          <button class="btn btn-primary btn-sm" onclick="openDirectorApproveProposalModal(${p.id}, '${escapeHtml(p.title)}', '${escapeHtml(p.leader_name)}', ${p.budget_proposed})" style="font-size: 0.72rem; padding: 3px 8px; background: #15803d; border-color: #15803d;">
            <i class="fa-solid fa-signature"></i> Duyệt trúng tuyển
          </button>
        `;
      }
    } else if (p.status === 'APPROVED') {
      statusPill = '<span class="status-step-pill step-approved"><i class="fa-solid fa-circle-check"></i> Đã phê duyệt giao nhiệm vụ</span>';
      if (p.converted_project_id) {
        actionBtn = `
          <a href="/chi-tiet.html?id=${p.converted_project_id}" class="btn btn-outline btn-sm" style="font-size: 0.72rem; padding: 3px 8px; color: #15803d; border-color: #bbf7d0;">
            <i class="fa-solid fa-arrow-up-right-from-square"></i> Mở Đề tài 360°
          </a>
        `;
      }
    } else {
      statusPill = '<span class="status-step-pill step-revision"><i class="fa-solid fa-triangle-exclamation"></i> Cần chỉnh sửa</span>';
    }

    const fileChips = (p.files || []).map(f => {
      const isTm = f.file_type === 'THUYET_MINH';
      return `<a href="/uploads/${escapeHtml(f.stored_path)}" target="_blank" style="display: inline-block; font-size: 0.7rem; background: #f1f5f9; color: #0284c7; padding: 2px 6px; border-radius: 4px; text-decoration: none; margin: 1px;"><i class="fa-solid ${isTm ? 'fa-file-word' : 'fa-file-excel'}"></i> ${isTm ? 'Thuyết minh' : 'Dự toán'}</a>`;
    }).join(' ');

    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted); font-size: 0.8rem;">${idx + 1}</td>
        <td>
          <span style="font-weight: 700; color: var(--primary); font-size: 0.85rem;">${escapeHtml(p.proposal_code)}</span>
          <div style="font-size: 0.7rem; color: #64748b;">${p.submitted_at_vn}</div>
        </td>
        <td>
          <div style="font-weight: 600; color: #1e293b; font-size: 0.85rem; max-width: 320px;">${escapeHtml(p.title)}</div>
        </td>
        <td>
          <div style="font-weight: 600; font-size: 0.82rem;">${escapeHtml(p.leader_name)}</div>
          <div style="font-size: 0.72rem; color: #0284c7;">${escapeHtml(p.research_group || '')}</div>
        </td>
        <td style="font-weight: 700; color: #b45309; font-size: 0.82rem;">${p.budget_proposed_formatted}</td>
        <td>${fileChips || '<span style="color:#94a3b8; font-size:0.75rem;">Không có</span>'}</td>
        <td>${statusPill}</td>
        <td style="text-align: center;">${actionBtn || '<span style="font-size: 0.72rem; color: #94a3b8;">Đang theo dõi</span>'}</td>
      </tr>
    `;
  }).join('');
}

// 3. Modal Nộp Hồ sơ Đề xuất (Chủ nhiệm nộp)
function openSubmitProposalModal() {
  document.getElementById('submitProposalForm').reset();
  const u = window.CURRENT_USER;
  if (u && u.role === 'CHU_NHIEM' && u.leader_name) {
    document.getElementById('propLeaderInput').value = u.leader_name;
  }
  document.getElementById('submitProposalModal').classList.add('active');
}

function closeSubmitProposalModal() {
  document.getElementById('submitProposalModal').classList.remove('active');
}

async function handleSubmitProposal(e) {
  e.preventDefault();
  const form = e.target;
  const formData = new FormData(form);

  const btn = document.getElementById('btnSubmitProposalSend');
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang nộp & Bắn email...';

  try {
    const res = await fetch('/api/calls/proposals', {
      method: 'POST',
      body: formData
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message, 'success');
      closeSubmitProposalModal();
      loadProposals();
      loadCallInfo();
    } else {
      showToast(json.error || 'Lỗi khi nộp hồ sơ', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối máy chủ: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

// 4. Modal Lên Lịch Hội Đồng (Phòng KHCN)
function openScheduleCouncilModal(propId, title, leader) {
  document.getElementById('scProposalId').value = propId;
  document.getElementById('scProposalTitle').innerText = title;
  document.getElementById('scProposalLeader').innerText = leader;
  const in3Days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  document.getElementById('scCouncilDate').value = in3Days;
  document.getElementById('scheduleCouncilModal').classList.add('active');
}

function closeScheduleCouncilModal() {
  document.getElementById('scheduleCouncilModal').classList.remove('active');
}

async function handleScheduleCouncilSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const propId = form.proposal_id.value;
  const councilDate = form.council_date.value;
  const khcnNotes = form.khcn_notes.value;

  try {
    const res = await fetch(`/api/calls/proposals/${propId}/schedule-council`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ council_date: councilDate, khcn_notes: khcnNotes })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message, 'success');
      closeScheduleCouncilModal();
      loadProposals();
    } else {
      showToast(json.error || 'Lỗi khi lên lịch Hội đồng', 'error');
    }
  } catch (err) {
    showToast('Lỗi mạng: ' + err.message, 'error');
  }
}

// 5. Modal Viện trưởng Phê duyệt Đề tài
function openDirectorApproveProposalModal(propId, title, leader, budget) {
  document.getElementById('dapProposalId').value = propId;
  document.getElementById('dapTitle').innerText = title;
  document.getElementById('dapLeader').innerText = leader;
  document.getElementById('dapBudget').value = budget || 50000000;
  document.getElementById('dapDecNumber').value = `QĐ-SCI.25/${propId}`;
  document.getElementById('dapDecDate').value = new Date().toISOString().slice(0, 10);
  document.getElementById('directorApproveProposalModal').classList.add('active');
}

function closeDirectorApproveProposalModal() {
  document.getElementById('directorApproveProposalModal').classList.remove('active');
}

async function handleDirectorApproveProposalSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const propId = form.proposal_id.value;
  const payload = {
    decision_number: form.decision_number.value,
    decision_date: form.decision_date.value,
    budget_approved: form.budget_approved.value,
    council_score: form.council_score.value,
    director_decision: form.director_decision.value
  };

  try {
    const res = await fetch(`/api/calls/proposals/${propId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message, 'success');
      closeDirectorApproveProposalModal();
      loadProposals();
    } else {
      showToast(json.error || 'Lỗi phê duyệt', 'error');
    }
  } catch (err) {
    showToast('Lỗi mạng: ' + err.message, 'error');
  }
}

// 6a. Phát Email thông báo Mở đợt đến toàn Viện chủ động
async function sendBroadcastAnnouncementEmail() {
  if (!currentCallData || !currentCallData.call) return;
  const call = currentCallData.call;
  if (!call.is_active) {
    alert('Đợt đăng ký hiện đang đóng. Vui lòng mở lại đợt trước khi phát email thông báo.');
    return;
  }
  if (!confirm(`Bạn có chắc chắn muốn phát Email Thông báo Mở đợt [${call.title}] đến tất cả các Nhà khoa học, Chủ nhiệm đề tài và Trưởng nhóm nghiên cứu toàn Viện không?`)) {
    return;
  }

  showToast('Đang phát email thông báo toàn Viện...', 'info');
  try {
    const res = await fetch(`/api/calls/${call.id}/broadcast-announcement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message, 'success');
      loadCallInfo();
    } else {
      showToast(json.error || 'Lỗi khi gửi email thông báo', 'error');
    }
  } catch (err) {
    showToast('Lỗi mạng khi phát email: ' + err.message, 'error');
  }
}

// 6. Đóng / Mở lại đợt (Khi Viện tạm dừng tổ chức đề tài cấp cơ sở)
async function toggleCallActiveState() {
  if (!currentCallData || !currentCallData.call) return;
  const call = currentCallData.call;
  const newActive = !call.is_active;

  const confirmMsg = newActive
    ? 'Bạn có chắc chắn muốn MỞ LẠI đợt tiếp nhận hồ sơ đề tài thường xuyên không?'
    : 'Bạn có chắc chắn muốn ĐÓNG ĐỢT này lại không? (Áp dụng khi Viện có quyết định tạm dừng tổ chức đề tài cấp Viện)';

  if (!confirm(confirmMsg)) return;

  let reason = '';
  if (!newActive) {
    reason = prompt('Nhập lý do đóng đợt (Lưu vào biên bản hệ thống):', 'Viện tạm dừng tổ chức đợt đề tài NCKH cấp cơ sở năm nay');
    if (reason === null) return;
  }

  try {
    const res = await fetch(`/api/calls/${call.id}/toggle-active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: newActive, close_reason: reason })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message, 'success');
      loadCallInfo();
    } else {
      showToast(json.error || 'Lỗi khi cập nhật trạng thái đợt', 'error');
    }
  } catch (err) {
    showToast('Lỗi mạng: ' + err.message, 'error');
  }
}

// 7. Modal Nhật ký Email Tự động
async function openEmailLogsModal() {
  const container = document.getElementById('emailLogsContainer');
  container.innerHTML = '<div style="text-align:center; padding:1.5rem; color:#94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải nhật ký email...</div>';
  document.getElementById('emailLogsModal').classList.add('active');

  try {
    const res = await fetch('/api/calls/email-logs');
    const json = await res.json();
    if (!json.success || json.data.length === 0) {
      container.innerHTML = '<div style="text-align:center; padding:2rem; color:#94a3b8;">Chưa có email thông báo nào được gửi.</div>';
      return;
    }

    container.innerHTML = json.data.map(log => `
      <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; padding:12px; margin-bottom:10px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <strong style="color:#0f172a; font-size:0.85rem;"><i class="fa-solid fa-envelope" style="color:var(--primary);"></i> ${escapeHtml(log.subject)}</strong>
          <span style="font-size:0.72rem; color:#64748b;">${new Date(log.sent_at).toLocaleString('vi-VN')}</span>
        </div>
        <div style="font-size:0.75rem; color:#475569; margin-bottom:6px;">
          Đến: <strong>${escapeHtml(log.recipient_name)}</strong> &lt;${escapeHtml(log.recipient_email)}&gt; • Vai trò: <span class="badge badge-gray" style="font-size:0.68rem;">${escapeHtml(log.recipient_role)}</span>
        </div>
        <div style="background:#f8fafc; border:1px solid #cbd5e1; border-radius:6px; padding:8px; font-size:0.75rem; color:#334155; max-height:120px; overflow-y:auto;">
          ${log.body_html}
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<div style="color:red; padding:1rem;">Lỗi tải nhật ký: ${err.message}</div>`;
  }
}

function closeEmailLogsModal() {
  document.getElementById('emailLogsModal').classList.remove('active');
}

// Kích hoạt quét hạn thủ công & Bắn email tức thời
async function triggerManualDeadlineScan() {
  const btn = document.getElementById('btnManualDeadlineScanModal');
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang quét hạn toàn Viện & Gửi email...';

  try {
    const res = await fetch('/api/projects/run-deadline-check', { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      showToast(json.message || 'Quét hạn thành công!', 'success');
      await openEmailLogsModal();
      loadCallInfo();
    } else {
      showToast(json.message || 'Có lỗi xảy ra khi quét hạn', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối máy chủ: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

function showToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<i class="fa-solid fa-${type === 'success' ? 'circle-check' : 'triangle-exclamation'}"></i> ${escapeHtml(msg)}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
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
