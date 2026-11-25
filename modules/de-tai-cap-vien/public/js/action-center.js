// Logic cho Bàn làm việc Nghiệp vụ Phòng KH&CN (Action Center)
let actionCenterData = null;
let currentTab = 'proposals'; // 'proposals', 'missing', 'deadlines', 'adjustments'
let currentSearchTerm = '';

document.addEventListener('DOMContentLoaded', () => {
  loadActionCenterData();
});

window.addEventListener('rbacLoaded', (e) => {
  const user = e.detail;
  const alertEl = document.getElementById('roleAlertNonKhcn');
  const roleNameEl = document.getElementById('lblCurrentRoleName');
  if (user && !['SUPER_ADMIN', 'PHONG_KHCN', 'VIEN_TRUONG'].includes(user.role)) {
    if (alertEl) alertEl.style.display = 'block';
    if (roleNameEl) roleNameEl.innerText = user.role_info?.name || user.role;
  } else {
    if (alertEl) alertEl.style.display = 'none';
  }
});

async function loadActionCenterData() {
  try {
    const res = await fetch('/api/projects/action-center');
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Lỗi tải dữ liệu');

    actionCenterData = json.data;
    const s = json.data.summary || {};

    // Cập nhật số liệu trên 4 thẻ: Chỉ hiện khi có số lượng (> 0), không hiện số 0
    function updateCounterEl(id, count) {
      const el = document.getElementById(id);
      if (!el) return;
      if (count && count > 0) {
        el.innerText = count;
        el.style.display = 'inline-block';
      } else {
        el.innerText = '';
        el.style.display = 'none';
      }
    }

    updateCounterEl('cntProposals', s.pending_proposals_cnt);
    updateCounterEl('cntMissing', s.missing_legal_docs_cnt);
    updateCounterEl('cntDeadlines', s.urgent_deadlines_cnt);
    updateCounterEl('cntAdjustments', s.pending_adjustments_cnt);

    const total = (s.pending_proposals_cnt || 0) + (s.missing_legal_docs_cnt || 0) + (s.urgent_deadlines_cnt || 0) + (s.pending_adjustments_cnt || 0);
    const pill = document.getElementById('headerTotalPendingPill');
    if (pill) {
      if (total > 0) {
        pill.innerText = `${total} việc cần xử lý`;
        pill.className = 'badge-urgent';
        pill.style.display = 'inline-block';
      } else {
        pill.innerText = '';
        pill.style.display = 'none';
      }
    }

    // Cập nhật badge trên navbar
    const navBadges = document.querySelectorAll('.khcn-work-badge');
    navBadges.forEach(b => {
      b.innerText = total;
      b.style.display = total > 0 ? 'inline-block' : 'none';
    });

    renderCurrentTab();
  } catch (err) {
    console.error('Lỗi loadActionCenterData:', err);
    document.getElementById('actionCenterTbody').innerHTML = `
      <tr><td colspan="7" style="text-align:center; padding:2rem; color:red;">Lỗi tải dữ liệu: ${err.message}</td></tr>
    `;
  }
}

function switchActionTab(tab) {
  currentTab = tab;
  ['proposals', 'missing', 'deadlines', 'adjustments'].forEach(t => {
    const card = document.getElementById(`cardTab${t.charAt(0).toUpperCase() + t.slice(1)}`);
    if (card) {
      if (t === tab) card.classList.add('active');
      else card.classList.remove('active');
    }
  });

  renderCurrentTab();
}

function filterCurrentTable() {
  currentSearchTerm = document.getElementById('actionCenterSearch').value.toLowerCase().trim();
  renderCurrentTab();
}

function renderCurrentTab() {
  if (!actionCenterData) return;

  const thead = document.getElementById('actionCenterThead');
  const tbody = document.getElementById('actionCenterTbody');
  const title = document.getElementById('currentTabTitle');
  const sub = document.getElementById('currentTabSub');

  if (currentTab === 'proposals') {
    title.innerHTML = '<i class="fa-solid fa-inbox" style="color: #0284c7;"></i> <span>Hồ sơ Đề xuất Mới Tiếp nhận Chờ Phòng KHCN Sơ duyệt</span>';
    sub.innerText = 'Thẩm tra tính hợp lệ về Thuyết minh và Bảng dự toán kinh phí để chuyển Hội đồng xét duyệt đề cương.';
    
    thead.innerHTML = `
      <tr>
        <th style="width: 50px; text-align: center;">STT</th>
        <th style="width: 140px;">MÃ HỒ SƠ</th>
        <th>TÊN ĐỀ TÀI ĐỀ XUẤT</th>
        <th style="width: 180px;">CHỦ NHIỆM & NHÓM</th>
        <th style="width: 130px;">DỰ TOÁN XIN</th>
        <th style="width: 150px;">NGÀY NỘP</th>
        <th style="width: 150px; text-align: center;">THAO TÁC</th>
      </tr>
    `;

    let list = actionCenterData.pending_proposals || [];
    if (currentSearchTerm) {
      list = list.filter(p => (p.title + p.proposal_code + p.leader_name).toLowerCase().includes(currentSearchTerm));
    }

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:3rem; color:#64748b;"><i class="fa-solid fa-circle-check" style="color:#16a34a; font-size:1.5rem; display:block; margin-bottom:6px;"></i>Tuyệt vời! Hiện không có hồ sơ đề xuất nào đang chờ sơ duyệt.</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map((p, idx) => `
      <tr>
        <td style="text-align:center; color:#64748b;">${idx + 1}</td>
        <td><strong style="color:#0284c7;">${escapeHtml(p.proposal_code)}</strong></td>
        <td>
          <div style="font-weight:600; color:#1e293b;">${escapeHtml(p.title)}</div>
        </td>
        <td>
          <div style="font-weight:600;">${escapeHtml(p.leader_name)}</div>
          <div class="table-subtext">${escapeHtml(p.research_group || 'Chưa phân nhóm')}</div>
        </td>
        <td style="font-weight:700; color:#b45309;">${Number(p.budget_proposed || 0).toLocaleString('vi-VN')} đ</td>
        <td><div class="table-subtext">${p.submitted_at ? new Date(p.submitted_at).toLocaleString('vi-VN') : '--'}</div></td>
        <td style="text-align:center;">
          <a href="/quan-ly-dot.html?proposal_id=${p.id}&action=verify" class="btn btn-primary btn-xs" style="text-decoration:none; display:inline-flex; align-items:center; gap:4px;">
            <i class="fa-solid fa-clipboard-check"></i> Sơ duyệt hồ sơ
          </a>
        </td>
      </tr>
    `).join('');
  } 
  else if (currentTab === 'missing') {
    title.innerHTML = '<i class="fa-solid fa-file-signature" style="color: #d97706;"></i> <span>Danh sách Đề tài Thiếu File Scan Quyết định hoặc Hợp đồng NCKH</span>';
    sub.innerText = 'Để đảm bảo hồ sơ pháp lý phục vụ Thanh tra - Kiểm toán, P. KHCN cần tải lên bản scan có mộc đỏ Quyết định giao nhiệm vụ & Hợp đồng NCKH.';

    thead.innerHTML = `
      <tr>
        <th style="width: 50px; text-align: center;">STT</th>
        <th style="width: 140px;">MÃ ĐỀ TÀI</th>
        <th>TÊN ĐỀ TÀI NGHIÊN CỨU</th>
        <th style="width: 180px;">CHỦ NHIỆM & NHÓM</th>
        <th style="width: 150px;">SỐ QUYẾT ĐỊNH</th>
        <th style="width: 110px; text-align: center;">TÀI LIỆU CÓ</th>
        <th style="width: 160px; text-align: center;">THAO TÁC BỔ SUNG</th>
      </tr>
    `;

    let list = actionCenterData.missing_legal_docs || [];
    if (currentSearchTerm) {
      list = list.filter(p => (p.title + p.code + p.leader_name).toLowerCase().includes(currentSearchTerm));
    }

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:3rem; color:#64748b;"><i class="fa-solid fa-circle-check" style="color:#16a34a; font-size:1.5rem; display:block; margin-bottom:6px;"></i>Tất cả đề tài đang thực hiện đều đã có đủ hồ sơ pháp lý cơ bản!</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map((p, idx) => `
      <tr>
        <td style="text-align:center; color:#64748b;">${idx + 1}</td>
        <td><strong style="color:#0284c7;">${escapeHtml(p.code)}</strong></td>
        <td><div style="font-weight:600; color:#1e293b;">${escapeHtml(p.title)}</div></td>
        <td>
          <div style="font-weight:600;">${escapeHtml(p.leader_name)}</div>
          <div class="table-subtext">${escapeHtml(p.research_group || '')}</div>
        </td>
        <td>
          <span class="badge ${p.decision_number && p.decision_number !== 'Chưa nhập' ? 'badge-info' : 'badge-urgent'}" style="font-size:0.7rem;">
            ${escapeHtml(p.decision_number || 'Chưa nhập số QĐ')}
          </span>
        </td>
        <td style="text-align:center;">
          <span class="badge ${p.docs_count >= 3 ? 'badge-success' : 'badge-warn'}" style="font-size:0.72rem;">
            ${p.docs_count} file
          </span>
        </td>
        <td style="text-align:center; white-space:nowrap;">
          <a href="/api/projects/${p.id}/export-autofill/HOP_DONG_NCKH" target="_blank" class="btn btn-outline btn-xs" style="text-decoration:none; display:inline-flex; align-items:center; gap:4px; color:#0284c7; border-color:#38bdf8; background:#f0f9ff; margin-right:4px;" title="Tải Hợp đồng đã tự động điền sẵn 100% dữ liệu để in trình ký">
            <i class="fa-solid fa-file-signature"></i> Tải HĐ điền sẵn
          </a>
          <a href="/chi-tiet.html?id=${p.id}&tab=tab-docs" class="btn btn-primary btn-xs" style="text-decoration:none; display:inline-flex; align-items:center; gap:4px;">
            <i class="fa-solid fa-upload"></i> Upload scan
          </a>
        </td>
      </tr>
    `).join('');
  }
  else if (currentTab === 'deadlines') {
    title.innerHTML = '<i class="fa-solid fa-bell" style="color: #dc2626;"></i> <span>Danh sách Đề tài Quá hạn & Cận hạn cần Đôn đốc (30 - 15 - 7 - 0 ngày)</span>';
    sub.innerText = 'Các đề tài cần thông báo nộp hồ sơ nghiệm thu, làm đơn gia hạn thời gian hoặc kích hoạt thủ tục thanh lý hợp đồng.';

    thead.innerHTML = `
      <tr>
        <th style="width: 50px; text-align: center;">STT</th>
        <th style="width: 140px;">MÃ ĐỀ TÀI</th>
        <th>TÊN ĐỀ TÀI NGHIÊN CỨU</th>
        <th style="width: 180px;">CHỦ NHIỆM</th>
        <th style="width: 130px;">HẠN KẾT THÚC</th>
        <th style="width: 150px; text-align: center;">TRẠNG THÁI HẠN</th>
        <th style="width: 150px; text-align: center;">THAO TÁC</th>
      </tr>
    `;

    let list = actionCenterData.urgent_deadlines || [];
    if (currentSearchTerm) {
      list = list.filter(p => (p.title + p.code + p.leader_name).toLowerCase().includes(currentSearchTerm));
    }

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:3rem; color:#64748b;"><i class="fa-solid fa-circle-check" style="color:#16a34a; font-size:1.5rem; display:block; margin-bottom:6px;"></i>Hiện không có đề tài nào quá hạn hoặc cận hạn nguy hiểm!</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map((p, idx) => {
      const isOverdue = p.days_remaining < 0;
      return `
        <tr>
          <td style="text-align:center; color:#64748b;">${idx + 1}</td>
          <td><strong style="color:#0284c7;">${escapeHtml(p.code)}</strong></td>
          <td><div style="font-weight:600; color:#1e293b;">${escapeHtml(p.title)}</div></td>
          <td><div style="font-weight:600;">${escapeHtml(p.leader_name)}</div></td>
          <td><div style="font-weight:700; color:${isOverdue ? '#dc2626' : '#d97706'};">${p.current_end_date_vn || '--'}</div></td>
          <td style="text-align:center;">
            <span class="${isOverdue ? 'badge-urgent' : 'badge-warn'}">
              ${isOverdue ? `Quá hạn ${Math.abs(p.days_remaining)} ngày` : `Còn ${p.days_remaining} ngày`}
            </span>
          </td>
          <td style="text-align:center; white-space:nowrap;">
            ${isOverdue ? `
              <a href="/api/projects/${p.id}/export-autofill/BB_THANH_LY" target="_blank" class="btn btn-outline btn-xs" style="text-decoration:none; display:inline-flex; align-items:center; gap:4px; color:#dc2626; border-color:#fca5a5; background:#fff1f2; margin-right:4px;" title="Tải Biên bản thanh lý HĐ điền sẵn">
                <i class="fa-solid fa-file-contract"></i> Tải BB Thanh lý
              </a>
            ` : `
              <a href="/api/projects/${p.id}/export-autofill/DON_NGHIEM_THU" target="_blank" class="btn btn-outline btn-xs" style="text-decoration:none; display:inline-flex; align-items:center; gap:4px; color:#16a34a; border-color:#86efac; background:#f0fdf4; margin-right:4px;" title="Tải Đơn nghiệm thu điền sẵn">
                <i class="fa-solid fa-file-circle-check"></i> Đơn NT
              </a>
              <a href="/api/projects/${p.id}/export-autofill/DON_GIA_HAN_1" target="_blank" class="btn btn-outline btn-xs" style="text-decoration:none; display:inline-flex; align-items:center; gap:4px; color:#9333ea; border-color:#d8b4fe; background:#faf5ff; margin-right:4px;" title="Tải Đơn gia hạn điền sẵn">
                <i class="fa-solid fa-clock-rotate-left"></i> Đơn Gia hạn
              </a>
            `}
            <a href="/chi-tiet.html?id=${p.id}&tab=tab-docs" class="btn btn-outline btn-xs" style="text-decoration:none; display:inline-flex; align-items:center; gap:4px;">
              <i class="fa-solid fa-folder-open"></i> Hồ sơ
            </a>
          </td>
        </tr>
      `;
    }).join('');
  }
  else if (currentTab === 'adjustments') {
    title.innerHTML = '<i class="fa-solid fa-sliders" style="color: #9333ea;"></i> <span>Tờ trình Điều chỉnh Dự toán & Báo cáo Tiến độ 6 tháng Chờ Thẩm định</span>';
    sub.innerText = 'P. KHCN thẩm tra tính hợp lý chuyên môn của các yêu cầu thay đổi danh mục kinh phí trước khi trình Viện trưởng ký.';

    thead.innerHTML = `
      <tr>
        <th style="width: 50px; text-align: center;">STT</th>
        <th style="width: 140px;">MÃ ĐỀ TÀI</th>
        <th>NỘI DUNG YÊU CẦU ĐIỀU CHỈNH</th>
        <th style="width: 180px;">CHỦ NHIỆM</th>
        <th style="width: 140px;">NGÀY NỘP</th>
        <th style="width: 130px; text-align: center;">TRẠNG THÁI</th>
        <th style="width: 150px; text-align: center;">THAO TÁC</th>
      </tr>
    `;

    let list = actionCenterData.pending_adjustments || [];
    if (currentSearchTerm) {
      list = list.filter(p => (p.project_title + p.project_code + p.leader_name + p.reason).toLowerCase().includes(currentSearchTerm));
    }

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:3rem; color:#64748b;"><i class="fa-solid fa-circle-check" style="color:#16a34a; font-size:1.5rem; display:block; margin-bottom:6px;"></i>Không có tờ trình điều chỉnh dự toán hoặc báo cáo tiến độ nào đang chờ duyệt.</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map((a, idx) => `
      <tr>
        <td style="text-align:center; color:#64748b;">${idx + 1}</td>
        <td><strong style="color:#0284c7;">${escapeHtml(a.project_code)}</strong></td>
        <td>
          <div style="font-weight:600; color:#1e293b;">Điều chỉnh dự toán Lần ${a.adjustment_num}: ${escapeHtml(a.reason || '')}</div>
          <div class="table-subtext">Chênh lệch: ${Number(a.difference_amount || 0).toLocaleString('vi-VN')} đ</div>
        </td>
        <td><div style="font-weight:600;">${escapeHtml(a.leader_name)}</div></td>
        <td><div class="table-subtext">${a.request_date || '--'}</div></td>
        <td style="text-align:center;"><span class="badge-warn">Chờ P. KHCN thẩm tra</span></td>
        <td style="text-align:center;">
          <a href="/chi-tiet.html?id=${a.project_id}&tab=tab-adjustments" class="btn btn-primary btn-xs" style="text-decoration:none; display:inline-flex; align-items:center; gap:4px;">
            <i class="fa-solid fa-check-to-slot"></i> Thẩm tra tờ trình
          </a>
        </td>
      </tr>
    `).join('');
  }
}

// Bắn quét hạn thủ công
async function triggerActionCenterScan() {
  const btn = document.getElementById('btnActionCenterScan');
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang quét hạn...';
  }

  try {
    const res = await fetch('/api/projects/run-deadline-check', { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      showToast(json.message || 'Quét hạn toàn Viện thành công!', 'success');
      await loadActionCenterData();
    } else {
      showToast(json.message || 'Lỗi khi quét hạn', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối máy chủ: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
}

// Modal Xem Nhật ký Email
async function openEmailLogsModal() {
  const modal = document.getElementById('emailLogsModal');
  const container = document.getElementById('emailLogsContainer');
  if (!modal || !container) return;

  modal.classList.add('active');
  container.innerHTML = '<div style="text-align:center; padding:2rem;"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải nhật ký email...</div>';

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
  const modal = document.getElementById('emailLogsModal');
  if (modal) modal.classList.remove('active');
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