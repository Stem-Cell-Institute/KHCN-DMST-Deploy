// Logic Màn hình Chi tiết Đề tài 360 độ (SCI)

let currentProjectId = null;
let currentProjectData = null;

const STAGE_NAMES = {
  1: 'Đăng ký đề xuất & Trình nộp thuyết minh',
  2: 'Họp Hội đồng xét duyệt đề cương',
  3: 'Quyết định giao nhiệm vụ, Hợp đồng & Dự toán',
  4: 'Triển khai & Cấp phát vật tư',
  5: 'Báo cáo tiến độ định kỳ (06 tháng/lần)',
  6: 'Gia hạn thời gian thực hiện',
  7: 'Nghiệm thu & Thanh lý hợp đồng'
};

document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  currentProjectId = urlParams.get('id');
  const initialTab = urlParams.get('tab');
  const initialMilestone = urlParams.get('milestone');

  if (!currentProjectId) {
    alert('Không tìm thấy mã đề tài. Đang quay lại trang chủ.');
    window.location.href = '/';
    return;
  }

  if (initialMilestone && Number(initialMilestone) >= 1 && Number(initialMilestone) <= 7) {
    activeMilestoneStep = Number(initialMilestone);
  }

  if (initialTab) {
    switchTabById(initialTab);
  }

  loadProject();
});

window.addEventListener('rbacLoaded', () => {
  renderDetailRoleBanner();
  if (currentProjectData) {
    renderExtensionSection(currentProjectData);
    renderProjectMilestoneTimeline(currentProjectData);
    renderStagesAndDocuments(currentProjectData.documents || [], currentProjectData.audit);
    renderBudgetAdjustmentsTable(currentBudgetAdjustments);
    renderBudgetVsActualDashboard(currentProjectData.budget_analytics);
    renderBudgetItems(currentProjectData.budget_items || []);
    renderSuppliesChecklist(currentProjectData.supplies || []);
  }
});

function renderDetailRoleBanner() {
  const banner = document.getElementById('detailRoleContextBanner');
  const textEl = document.getElementById('detailRoleContextText');
  if (!banner || !textEl || !window.CURRENT_USER) return;

  const u = window.CURRENT_USER;
  if (u.role === 'CHU_NHIEM' && currentProjectData) {
    const isOwner = window.isProjectOwnedByCurrentUser(currentProjectData.leader_name);
    if (!isOwner) {
      banner.style.display = 'block';
      textEl.innerHTML = `Chế độ xem tham khảo: Đề tài do <strong>${escapeHtml(currentProjectData.leader_name)}</strong> làm Chủ nhiệm.`;
      return;
    }
  }
  banner.style.display = 'none';
}

// 1. Tải toàn bộ dữ liệu 360 độ của Đề tài
async function loadProject() {
  try {
    const res = await fetch(`/api/projects/${currentProjectId}`);
    const json = await res.json();

    if (!json.success || !json.data) {
      alert(json.error || 'Lỗi khi tải thông tin đề tài');
      window.location.href = '/';
      return;
    }

    const p = json.data;
    currentProjectData = p;
    renderDetailRoleBanner();

    // A. Header Banner
    document.getElementById('headerCode').innerText = p.code;
    document.getElementById('headerTitle').innerText = p.title;
    document.getElementById('headerLeader').innerText = p.leader_name;
    document.getElementById('headerCategory').innerText = p.category || 'Cơ bản';
    document.getElementById('headerGroup').innerText = p.research_group || 'Chưa phân nhóm';
    if (p.budget_revised && p.budget_revised !== p.budget_total) {
      document.getElementById('headerBudget').innerHTML = `
        <span style="color: #7e22ce; font-weight: 800;">${Number(p.budget_revised).toLocaleString('vi-VN')} đ</span>
        <small style="color: #64748b; text-decoration: line-through; font-size: 0.75rem; margin-left: 4px;">(Gốc: ${p.budget_total_formatted})</small>
        <span class="badge badge-purple" style="font-size: 0.68rem; margin-left: 4px;">Đã điều chỉnh</span>
      `;
    } else {
      document.getElementById('headerBudget').innerText = p.budget_total_formatted;
    }

    // B. Cảnh báo hạn & Badge đếm ngược
    let badgeClass = 'badge-green';
    if (p.status_color === 'RED') {
      badgeClass = 'badge-red';
    } else if (p.status_color === 'YELLOW') {
      badgeClass = 'badge-yellow';
    } else if (p.status_color === 'BLUE') {
      badgeClass = 'badge-blue';
    } else if (p.status_color === 'GRAY') {
      badgeClass = 'badge-gray';
    }

    document.getElementById('headerAlertBadge').innerHTML = `
      <span class="badge ${badgeClass}" style="font-size: 0.9rem; padding: 5px 12px;">
        ${escapeHtml(p.badge_text)}
      </span>
    `;

    document.getElementById('headerDeadlineNote').innerHTML = `
      Hạn hoàn thành: <strong>${p.current_end_date_vn || 'Chưa xác định'}</strong>
      ${p.extension_count > 0 ? `(Gia hạn lần ${p.extension_count})` : ''}
    `;

    const warningEl = document.getElementById('headerWarningMsg');
    if (warningEl) {
      warningEl.style.display = 'none';
    }

    // C. Tab 1: Thông tin chung & Gia hạn
    document.getElementById('infoDecisionNumber').innerText = p.decision_number || 'Chưa ban hành';
    document.getElementById('infoDecisionDate').innerText = p.decision_date_vn || 'Chưa cập nhật';

    document.getElementById('infoLeader').innerText = p.leader_name;
    document.getElementById('infoMembers').innerText = p.members || 'Chưa cập nhật';
    document.getElementById('infoGroup').innerText = p.research_group || 'Chưa cập nhật';
    document.getElementById('infoEvaluation').innerText = p.final_evaluation || 'Đang thực hiện';

    const missingCount = p.audit ? p.audit.missing_count : 0;
    document.getElementById('infoMissingDocs').innerHTML = missingCount === 0
      ? '<span class="badge badge-green">Đủ 100% hồ sơ pháp lý</span>'
      : `<span style="color: #b91c1c; font-weight: 600;">Thiếu ${missingCount}/${p.audit.total_required} văn bản (Đạt ${p.audit.percentage}%)</span>`;

    // Render khu vực Gia hạn theo đúng trạng thái phê duyệt thực tế và vai trò
    renderExtensionSection(p);

    // C2. Tiến trình thực hiện nhiệm vụ KH&CN
    if (p.budget_adjustments) {
      currentBudgetAdjustments = p.budget_adjustments;
    }
    renderProjectMilestoneTimeline(p);

    // D. Tab 2: Hồ sơ 7 Giai đoạn
    renderStagesAndDocuments(p.documents || [], p.audit);

    // E. Tab 3: Báo cáo định kỳ 6 tháng
    renderPeriodicReports(p.reports || []);

    // F. Tab 4: Dự toán & Cấp phát vật tư
    renderBudgetVsActualDashboard(p.budget_analytics);
    renderBudgetItems(p.budget_items || []);
    renderSuppliesChecklist(p.supplies || []);
    loadBudgetAdjustments();
    const recModal = document.getElementById('budgetReconcileModal');
    if (recModal && recModal.classList.contains('active')) {
      renderBudgetReconcileModalContent();
    }

  } catch (err) {
    console.error('Lỗi khi tải dữ liệu đề tài:', err);
    showToast('Không thể kết nối máy chủ', 'error');
  }
}

// 2. Chuyển Tab
function switchTab(tabId) {
  switchTabById(tabId, event ? event.currentTarget : null);
}

function switchTabById(tabId, btnEl) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active');
    if (!btnEl && btn.getAttribute('onclick') && btn.getAttribute('onclick').includes(tabId)) {
      btn.classList.add('active');
    }
  });
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

  if (btnEl) btnEl.classList.add('active');
  const target = document.getElementById(tabId);
  if (target) target.classList.add('active');
}

// 3. Render Khu vực & Lịch sử Gia hạn theo đúng trạng thái thực tế của quy trình (3 bước) và phân quyền Vai trò
function renderExtensionSection(p) {
  if (!p) return;
  const extensions = p.extensions || [];
  const approvedExts = extensions.filter(e => e.status === 'APPROVED');
  const activePendingExt = extensions.find(e => e.status === 'PENDING' || e.status === 'REVISION_NEEDED');
  const approvedCount = approvedExts.length;

  // Cập nhật thông tin Thời gian thực hiện & Hạn hoàn thành hiện tại ở Bảng trái (CHỈ cộng hạn khi đã APPROVED)
  const durationEl = document.getElementById('infoDuration');
  const endDateEl = document.getElementById('infoCurrentEndDate');
  if (durationEl && endDateEl) {
    if (approvedCount > 0) {
      durationEl.innerHTML = `
        <span>${p.duration_months || 12} tháng</span>
        <span style="font-size: 0.8rem; color: #7e22ce; font-weight: 600;"> (+${approvedCount * 6} tháng đã phê duyệt gia hạn)</span>
      `;
      endDateEl.innerHTML = `
        <span style="color: #7e22ce; font-weight: 700;">${p.current_end_date_vn || '--'}</span>
        <span style="font-size: 0.78rem; color: #64748b; font-weight: 400; text-decoration: line-through; margin-left: 8px;">(Hạn gốc: ${p.base_end_date_vn || '--'})</span>
      `;
    } else {
      durationEl.innerHTML = `
        <span>${p.duration_months || 12} tháng</span>
        ${activePendingExt ? `<span style="font-size: 0.75rem; color: #b45309; font-weight: 600; margin-left: 6px;">(Đang trình đề xuất gia hạn Lần ${activePendingExt.extension_num})</span>` : ''}
      `;
      endDateEl.innerHTML = `
        <span>${p.current_end_date_vn || '--'}</span>
        ${activePendingExt ? `<span style="font-size: 0.74rem; color: #b45309; font-weight: 600; margin-left: 6px;">(Chưa cộng hạn — Chờ Quyết định phê duyệt)</span>` : ''}
      `;
    }
  }

  // Cập nhật thanh tiến độ số lần gia hạn đã duyệt
  const countBadge = document.getElementById('extCountBadge');
  if (countBadge) countBadge.innerText = `${approvedCount} / 2 lần đã duyệt`;

  const pendingBadge = document.getElementById('extPendingBadge');
  if (pendingBadge) {
    if (activePendingExt) {
      pendingBadge.style.display = 'inline-flex';
      pendingBadge.className = activePendingExt.status === 'REVISION_NEEDED' ? 'badge badge-red' : 'badge badge-yellow';
      pendingBadge.innerText = activePendingExt.status === 'REVISION_NEEDED'
        ? `Lần ${activePendingExt.extension_num}: Yêu cầu bổ sung`
        : `Lần ${activePendingExt.extension_num}: Đang chờ duyệt`;
    } else {
      pendingBadge.style.display = 'none';
    }
  }

  const progBar = document.getElementById('extProgressBar');
  if (progBar) progBar.style.width = `${Math.min(100, (approvedCount / 2) * 100)}%`;

  // Phân quyền nút "Lập đề xuất xin gia hạn" theo Vai trò và trạng thái hiện tại
  const role = typeof window.getCurrentRole === 'function' ? window.getCurrentRole() : 'PHONG_KHCN';
  const isKhcnOrAdmin = ['PHONG_KHCN', 'SUPER_ADMIN'].includes(role);
  const isProjectOwner = role === 'CHU_NHIEM' && (!p.leader_name || typeof window.isProjectOwnedByCurrentUser !== 'function' || window.isProjectOwnedByCurrentUser(p.leader_name));
  const canProposeExt = isProjectOwner || isKhcnOrAdmin;

  const btnExtend = document.getElementById('btnOpenExtendModal');
  const lockNotice = document.getElementById('extLockNotice');
  const roleHint = document.getElementById('extRoleHintNotice');

  if (approvedCount >= 2) {
    if (btnExtend) btnExtend.style.display = 'none';
    if (roleHint) roleHint.style.display = 'none';
    if (lockNotice) lockNotice.style.display = 'block';
  } else if (activePendingExt) {
    if (btnExtend) btnExtend.style.display = 'none';
    if (lockNotice) lockNotice.style.display = 'none';
    if (roleHint) {
      roleHint.style.display = 'block';
      if (isKhcnOrAdmin || role === 'VIEN_TRUONG') {
        roleHint.innerHTML = `Đề xuất gia hạn <strong>Lần ${activePendingExt.extension_num}</strong> đang chờ xử lý. Chuyên viên P. KH&amp;CN sử dụng nút <strong>"Cập nhật kết quả trình Viện trưởng"</strong> ở thẻ bên dưới để khai báo Phê duyệt (kèm QĐ mộc đỏ), Từ chối hoặc Yêu cầu bổ sung.`;
      } else if (isProjectOwner) {
        roleHint.innerHTML = activePendingExt.request_file_id
          ? `Đã nộp Đơn xin gia hạn <strong>Lần ${activePendingExt.extension_num}</strong> có chữ ký. Hồ sơ đang chờ Phòng KH&amp;CN trình Viện trưởng phê duyệt.`
          : `Bạn đã khởi tạo đề xuất gia hạn <strong>Lần ${activePendingExt.extension_num}</strong>. Hãy thực hiện <strong>Bước 1 (Tải mẫu Đơn .docx)</strong>, in ra ký tên và bấm <strong>Bước 2 (Tải lên Đơn đã ký PDF)</strong> ở thẻ bên dưới.`;
      } else {
        roleHint.innerHTML = `Đề tài đang có hồ sơ đề nghị gia hạn Lần ${activePendingExt.extension_num} chờ xét duyệt.`;
      }
    }
  } else {
    if (lockNotice) lockNotice.style.display = 'none';
    if (canProposeExt) {
      if (btnExtend) {
        btnExtend.style.display = 'inline-flex';
        btnExtend.innerText = `Lập đề xuất xin gia hạn Lần ${approvedCount + 1} (+06 tháng)`;
      }
      if (roleHint) roleHint.style.display = 'none';
    } else {
      if (btnExtend) btnExtend.style.display = 'none';
      if (roleHint) {
        roleHint.style.display = 'block';
        roleHint.innerHTML = `Chế độ xem (${escapeHtml(getCurrentRoleLabelVn())}): Chỉ Chủ nhiệm đề tài hoặc Phòng KH&amp;CN mới khởi tạo đề xuất xin gia hạn.`;
      }
    }
  }

  renderExtensionHistory(extensions);
}

function renderExtensionHistory(extensions) {
  const container = document.getElementById('extHistoryList');
  if (!container) return;
  if (!extensions || extensions.length === 0) {
    container.innerHTML = '<div style="color: #64748b;">Chưa phát sinh đề xuất gia hạn.</div>';
    return;
  }

  const role = typeof window.getCurrentRole === 'function' ? window.getCurrentRole() : 'PHONG_KHCN';
  const isKhcnOrAdmin = ['PHONG_KHCN', 'SUPER_ADMIN'].includes(role);
  const isDirector = role === 'VIEN_TRUONG';
  const isProjectOwner = role === 'CHU_NHIEM' && (!currentProjectData || typeof window.isProjectOwnedByCurrentUser !== 'function' || window.isProjectOwnedByCurrentUser(currentProjectData.leader_name));
  const allDocs = (currentProjectData && currentProjectData.documents) ? currentProjectData.documents : [];

  container.innerHTML = extensions.map(e => {
    const extNum = e.extension_num || 1;
    const reqDocKey = `DON_GIA_HAN_${extNum}`;
    const decDocKey = `QD_GIA_HAN_${extNum}`;

    const reqDocObj = e.request_file_id
      ? allDocs.find(d => Number(d.id) === Number(e.request_file_id))
      : allDocs.find(d => d.doc_type === reqDocKey);
    const decDocObj = e.decision_file_id
      ? allDocs.find(d => Number(d.id) === Number(e.decision_file_id))
      : allDocs.find(d => d.doc_type === decDocKey);

    const hasSignedRequest = Boolean(reqDocObj);
    const hasRedSealDecision = Boolean(decDocObj);

    let statusBadgeHtml = '';
    let cardBorderColor = '#cbd5e1';
    let cardBg = '#f8fafc';
    let rightHeaderHtml = '';
    let datesGridHtml = '';
    let workflowTrackerHtml = '';
    let feedbackBoxHtml = '';
    let actionButtonsHtml = '';

    // Nút tải mẫu Đơn điền sẵn (.docx)
    const downloadDocxBtn = `
      <a href="/api/projects/${currentProjectId}/export-autofill/${reqDocKey}?extId=${e.id}" target="_blank" class="btn btn-outline btn-sm" style="padding: 3px 8px; font-size: 0.73rem; color: #0284c7; border-color: #7dd3fc; background: #f0f9ff; text-decoration: none;" title="Tải biểu mẫu Đơn đề nghị gia hạn (.docx) đã điền sẵn thông tin đề tài và lý do">
        1. Tải mẫu Đơn (.docx)
      </a>
    `;

    if (e.status === 'APPROVED') {
      cardBorderColor = '#86efac';
      cardBg = '#f0fdf4';
      statusBadgeHtml = `<span class="badge badge-green" style="font-size: 0.72rem;">Đã phê duyệt gia hạn (+${e.months_added || 6} tháng)</span>`;
      rightHeaderHtml = `<span style="font-weight: 700; color: #15803d; font-size: 0.78rem;">Số QĐ: ${escapeHtml(e.decision_number || 'Đã cấp')}</span>`;

      datesGridHtml = `
        <div>Hạn trước gia hạn: <span style="text-decoration: line-through; color: #64748b;">${escapeHtml(e.previous_end_date_vn || e.previous_end_date)}</span></div>
        <div>Hạn mới chính thức: <strong style="color: #15803d;">${escapeHtml(e.new_end_date_vn || e.new_end_date)}</strong></div>
        <div>Ngày trình đơn: <span>${escapeHtml(e.request_date_vn || e.request_date || '-')}</span></div>
        <div>Ngày ký Quyết định: <strong>${escapeHtml(e.decision_date_vn || e.decision_date || '-')}</strong></div>
      `;

      if (e.director_opinion) {
        feedbackBoxHtml = `
          <div style="margin-top: 6px; padding: 6px 9px; background: #dcfce7; border: 1px solid #bbf7d0; border-radius: 4px; font-size: 0.76rem; color: #166534;">
            <strong>Kết luận phê duyệt:</strong> ${escapeHtml(e.director_opinion)}
          </div>
        `;
      }

      const btns = [];
      if (reqDocObj) {
        btns.push(`<button type="button" class="btn btn-outline btn-sm" style="padding: 3px 8px; font-size: 0.72rem;" onclick="jumpToMilestoneDetailTarget('preview', ${reqDocObj.id}, '${escapeHtml(reqDocObj.title)}')">Xem Đơn xin gia hạn</button>`);
      }
      if (decDocObj) {
        btns.push(`<button type="button" class="btn btn-outline btn-sm" style="padding: 3px 8px; font-size: 0.72rem; color: #15803d; border-color: #86efac; background: #ffffff; font-weight: 600;" onclick="jumpToMilestoneDetailTarget('preview', ${decDocObj.id}, '${escapeHtml(decDocObj.title)}')">Xem Quyết định (Mộc đỏ)</button>`);
      }
      if (isKhcnOrAdmin) {
        btns.push(`<button type="button" class="btn btn-outline btn-sm" style="padding: 3px 8px; font-size: 0.72rem; color: #0f172a; border-color: #94a3b8; background: #ffffff; font-weight: 600;" onclick="openKhcnProcessExtensionModal(${e.id})" title="Chỉnh sửa Số QĐ, Ngày ký, thay tệp Quyết định hoặc mở khóa trạng thái nếu khai báo nhầm">Sửa / Điều chỉnh (P. KH&amp;CN)</button>`);
      }
      actionButtonsHtml = btns.join(' ');

    } else if (e.status === 'REJECTED') {
      cardBorderColor = '#fca5a5';
      cardBg = '#fef2f2';
      statusBadgeHtml = `<span class="badge badge-red" style="font-size: 0.72rem;">Không được phê duyệt (Từ chối gia hạn)</span>`;
      rightHeaderHtml = `<span style="font-weight: 700; color: #b91c1c; font-size: 0.76rem;">Hạn đề tài giữ nguyên</span>`;

      datesGridHtml = `
        <div>Hạn hoàn thành giữ nguyên: <strong style="color: #b91c1c;">${escapeHtml(e.previous_end_date_vn || e.previous_end_date)}</strong></div>
        <div>Hạn đề xuất (Không duyệt): <span style="text-decoration: line-through; color: #94a3b8;">${escapeHtml(e.new_end_date_vn || e.new_end_date)}</span></div>
        <div>Ngày trình đơn: <span>${escapeHtml(e.request_date_vn || e.request_date || '-')}</span></div>
        <div>Ngày có kết luận: <strong>${escapeHtml(e.decision_date_vn || e.decision_date || '-')}</strong></div>
      `;

      feedbackBoxHtml = `
        <div style="margin-top: 6px; padding: 7px 10px; background: #ffe4e6; border: 1px solid #fda4af; border-radius: 4px; font-size: 0.77rem; color: #9f1239; line-height: 1.4;">
          <strong>Lý do Viện trưởng không phê duyệt &amp; Chỉ đạo xử lý:</strong> ${escapeHtml(e.director_opinion || 'Không đồng ý gia hạn thời gian thực hiện đề tài.')}
        </div>
      `;

      const btns = [];
      if (reqDocObj) {
        btns.push(`<button type="button" class="btn btn-outline btn-sm" style="padding: 3px 8px; font-size: 0.72rem;" onclick="jumpToMilestoneDetailTarget('preview', ${reqDocObj.id}, '${escapeHtml(reqDocObj.title)}')">Xem Đơn đã trình</button>`);
      }
      if (isKhcnOrAdmin) {
        btns.push(`<button type="button" class="btn btn-outline btn-sm" style="padding: 3px 8px; font-size: 0.72rem; color: #0f172a; border-color: #94a3b8; background: #ffffff; font-weight: 600;" onclick="openKhcnProcessExtensionModal(${e.id})">Sửa / Cập nhật lại kết quả (P. KH&amp;CN)</button>`);
      }
      actionButtonsHtml = btns.join(' ');

    } else {
      // PENDING hoặc REVISION_NEEDED (Đang trình đề xuất — Chưa có Quyết định của Viện trưởng)
      const isRevision = e.status === 'REVISION_NEEDED';
      cardBorderColor = isRevision ? '#fdba74' : '#fde047';
      cardBg = isRevision ? '#fff7ed' : '#fefce8';

      if (isRevision) {
        statusBadgeHtml = `<span class="badge badge-red" style="font-size: 0.72rem;">Yêu cầu bổ sung / chỉnh sửa hồ sơ</span>`;
      } else if (!hasSignedRequest) {
        statusBadgeHtml = `<span class="badge badge-yellow" style="font-size: 0.72rem;">Bước 1/3: Chờ nộp bản scan Đơn có chữ ký</span>`;
      } else {
        statusBadgeHtml = `<span class="badge badge-blue" style="font-size: 0.72rem;">Bước 2/3: Đã nộp Đơn đã ký — Chờ trình Viện trưởng</span>`;
      }

      rightHeaderHtml = `<span style="font-size: 0.74rem; color: #b45309; font-weight: 700;">Chưa ban hành Quyết định</span>`;

      datesGridHtml = `
        <div>Hạn hiện tại (Đang áp dụng): <strong style="color: #0f172a;">${escapeHtml(e.previous_end_date_vn || e.previous_end_date)}</strong></div>
        <div>Hạn đề xuất (Nếu được duyệt): <strong style="color: #7e22ce;">${escapeHtml(e.new_end_date_vn || e.new_end_date)}</strong> <span style="font-size:0.7rem; color:#64748b;">(Dự kiến)</span></div>
        <div>Ngày lập đề xuất: <span>${escapeHtml(e.request_date_vn || e.request_date || '-')}</span></div>
        <div>Ngày ký Quyết định: <span style="color: #94a3b8; font-style: italic;">Chờ Viện trưởng duyệt</span></div>
      `;

      // Thanh 3 bước thực tế ngay trong thẻ đề xuất
      workflowTrackerHtml = `
        <div style="margin: 8px 0; padding: 7px 10px; background: #ffffff; border: 1px dashed #cbd5e1; border-radius: 5px; font-size: 0.74rem; line-height: 1.5;">
          <div style="color: #15803d; font-weight: 600;">
            ✓ Bước 1 (Đã tạo đề xuất): Đã khai báo lý do xin gia hạn Lần ${extNum}.
          </div>
          <div style="color: ${hasSignedRequest ? '#15803d' : '#b45309'}; font-weight: 600;">
            ${hasSignedRequest
              ? `✓ Bước 2 (Đã nộp Đơn có chữ ký): ${escapeHtml(reqDocObj.file_name)} (${formatFileSize(reqDocObj.file_size)})`
              : `• Bước 2 (Chờ thực hiện): Chủ nhiệm cần tải mẫu Đơn (.docx), ký tên và tải bản scan Đơn đã ký (PDF) lên hệ thống.`}
          </div>
          <div style="color: #475569; font-weight: 600;">
            • Bước 3 (Chờ P. KH&amp;CN &amp; Viện trưởng): P. KH&amp;CN trình Viện trưởng xem xét ký Quyết định (đóng dấu mộc đỏ) hoặc trả lời từ chối.
          </div>
        </div>
      `;

      if (isRevision && e.khcn_notes) {
        feedbackBoxHtml = `
          <div style="margin-top: 6px; padding: 7px 10px; background: #ffedd5; border: 1px solid #fdba74; border-radius: 4px; font-size: 0.77rem; color: #9a3412; line-height: 1.4;">
            <strong>Ý kiến Phòng KH&amp;CN yêu cầu bổ sung:</strong> ${escapeHtml(e.khcn_notes)}
          </div>
        `;
      }

      const btns = [];
      if (isProjectOwner || isKhcnOrAdmin) {
        btns.push(downloadDocxBtn);
        if (!hasSignedRequest) {
          btns.push(`
            <button type="button" class="btn btn-primary btn-sm" style="padding: 3px 9px; font-size: 0.73rem;" onclick="openUploadModalForCriteria('${reqDocKey}', 6, 'Đơn đề nghị gia hạn Lần ${extNum} (06 tháng)')">
              2. Tải lên Đơn đã ký (PDF)
            </button>
          `);
        } else {
          btns.push(`
            <button type="button" class="btn btn-outline btn-sm" style="padding: 3px 8px; font-size: 0.72rem;" onclick="jumpToMilestoneDetailTarget('preview', ${reqDocObj.id}, '${escapeHtml(reqDocObj.title)}')">
              Xem Đơn đã nộp
            </button>
            <button type="button" class="btn btn-outline btn-sm" style="padding: 3px 8px; font-size: 0.72rem;" onclick="openEditDocModal(${reqDocObj.id}, '${reqDocKey}', 6, 'UPLOADED')">
              Thay tệp Đơn
            </button>
          `);
        }
        btns.push(`
          <button type="button" class="btn btn-outline btn-sm" style="padding: 3px 8px; font-size: 0.72rem;" onclick="openExtendModal(${e.id})">
            Sửa lý do
          </button>
          <button type="button" class="btn btn-outline btn-sm" style="padding: 3px 8px; font-size: 0.72rem; color: #dc2626; border-color: #fca5a5;" onclick="handleCancelExtensionRequest(${e.id}, ${extNum})">
            Hủy đề xuất
          </button>
        `);
      } else if (reqDocObj) {
        btns.push(`
          <button type="button" class="btn btn-outline btn-sm" style="padding: 3px 8px; font-size: 0.72rem;" onclick="jumpToMilestoneDetailTarget('preview', ${reqDocObj.id}, '${escapeHtml(reqDocObj.title)}')">
            Xem Đơn đã nộp
          </button>
        `);
      }

      if (isKhcnOrAdmin || isDirector) {
        btns.push(`
          <button type="button" class="btn btn-primary btn-sm" style="padding: 3px 10px; font-size: 0.73rem; background: #0f172a; border-color: #0f172a;" onclick="openKhcnProcessExtensionModal(${e.id})">
            3. Cập nhật kết quả trình Viện trưởng
          </button>
        `);
      }

      actionButtonsHtml = btns.join(' ');
    }

    return `
      <div style="background: ${cardBg}; border: 1px solid ${cardBorderColor}; border-radius: 6px; padding: 10px 12px; margin-bottom: 10px;">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 6px;">
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <span style="font-weight: 800; color: #0f172a; font-size: 0.84rem;">Đề xuất gia hạn Lần ${extNum}</span>
            ${statusBadgeHtml}
          </div>
          ${rightHeaderHtml}
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 0.78rem; margin-bottom: 6px; background: #ffffff; padding: 8px 10px; border-radius: 4px; border: 1px solid #e2e8f0;">
          ${datesGridHtml}
        </div>
        <div style="font-size: 0.79rem; color: #334155; line-height: 1.4;">
          <strong>Lý do Chủ nhiệm đề nghị:</strong> ${escapeHtml(e.reason || 'Bổ sung thời gian thực hiện')}
        </div>
        ${workflowTrackerHtml}
        ${feedbackBoxHtml}
        <div style="margin-top: 8px; display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap;">
          ${actionButtonsHtml}
        </div>
      </div>
    `;
  }).join('');
}

// Cấu hình các văn bản liên thông xuất hiện ở 2 hoặc 3 Giai đoạn (dùng chung trạng thái & tệp số hóa gốc)
const STAGE_SHARED_DOC_KEYS = {
  1: ['THUYET_MINH'],
  2: ['BB_XET_DUYET', 'THUYET_MINH', 'QD_GIAO_NHIEM_VU'],
  3: ['QD_GIAO_NHIEM_VU', 'HOP_DONG_NCKH', 'DU_TOAN_DA_DUYET', 'DON_DIEU_CHINH_DU_TOAN', 'QD_DIEU_CHINH_DU_TOAN'],
  4: ['CHUNG_TU_VAT_TU', 'DU_TOAN_DA_DUYET', 'DON_DIEU_CHINH_DU_TOAN', 'QD_DIEU_CHINH_DU_TOAN'],
  5: ['BAO_CAO_6_THANG'],
  6: ['DON_GIA_HAN_1', 'QD_GIA_HAN_1', 'DON_GIA_HAN_2', 'QD_GIA_HAN_2', 'BAO_CAO_6_THANG'],
  7: ['BAO_CAO_TONG_KET', 'SAN_PHAM_KHCN', 'BB_NGHIEM_THU', 'GIAI_TRINH_SAU_HOP', 'QD_CONG_NHAN', 'BB_THANH_LY', 'BAO_CAO_6_THANG']
};

// Nhãn ghi chú liên thông giữa các giai đoạn để người dùng biết văn bản được đồng bộ tự động
const SHARED_STAGE_LABELS = {
  THUYET_MINH: 'Liên thông Giai đoạn 1 & 2',
  QD_GIAO_NHIEM_VU: 'Liên thông Giai đoạn 2 & 3',
  DU_TOAN_DA_DUYET: 'Liên thông Giai đoạn 3 & 4',
  DON_DIEU_CHINH_DU_TOAN: 'Liên thông Giai đoạn 3 & 4',
  QD_DIEU_CHINH_DU_TOAN: 'Liên thông Giai đoạn 3 & 4',
  BAO_CAO_6_THANG: 'Liên thông Giai đoạn 5, 6 & 7'
};

// Chính sách phân quyền tải lên & Yêu cầu pháp lý (dấu mộc đỏ / chữ ký phê duyệt) cho từng loại văn bản
const CRITERIA_UPLOAD_POLICY = {
  THUYET_MINH: {
    owner_label: 'Chủ nhiệm đề tài nộp',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN'],
    require_red_seal: true,
    legal_tag: 'Bản đã phê duyệt & đóng dấu mộc đỏ (GĐ1 cho phép bản ký đề xuất)',
    legal_detail: 'Tại Giai đoạn 1 (Trình nộp đề xuất): Bản có chữ ký của Chủ nhiệm đề tài. Tại Giai đoạn 2 (Sau họp Hội đồng): Bắt buộc tải lên bản scan PDF Thuyết minh đã chỉnh sửa hoàn thiện, có chữ ký phê duyệt của Lãnh đạo Viện và đóng dấu mộc đỏ.'
  },
  BB_XET_DUYET: {
    owner_label: 'Phòng KH&CN lập & lưu',
    allowed_upload_roles: ['PHONG_KHCN', 'SUPER_ADMIN'],
    require_red_seal: true,
    legal_tag: 'Bản scan có chữ ký Chủ tịch HĐ, Thư ký & dấu xác nhận',
    legal_detail: 'Bắt buộc tải lên bản scan PDF Biên bản họp Hội đồng xét duyệt đề cương có đầy đủ chữ ký của Chủ tịch Hội đồng, Thư ký khoa học và đóng dấu xác nhận.'
  },
  QD_GIAO_NHIEM_VU: {
    owner_label: 'Viện trưởng ký / P. KH&CN & Văn thư lưu',
    allowed_upload_roles: ['PHONG_KHCN', 'PHONG_TCHC', 'SUPER_ADMIN'],
    require_red_seal: true,
    legal_tag: 'Bắt buộc: Bản scan có chữ ký Viện trưởng & dấu mộc đỏ',
    legal_detail: 'Bắt buộc tải lên bản scan màu (PDF) Quyết định giao nhiệm vụ KH&CN đã cấp số văn thư, có chữ ký của Viện trưởng và đóng dấu mộc đỏ của Viện.'
  },
  HOP_DONG_NCKH: {
    owner_label: 'Viện & Chủ nhiệm ký / P. KH&CN & Văn thư lưu',
    allowed_upload_roles: ['PHONG_KHCN', 'PHONG_TCHC', 'SUPER_ADMIN'],
    require_red_seal: true,
    legal_tag: 'Bắt buộc: Bản scan có chữ ký hai bên & dấu mộc đỏ',
    legal_detail: 'Bắt buộc tải lên bản scan màu (PDF) Hợp đồng NCKH cấp cơ sở có đầy đủ chữ ký của Viện trưởng, Chủ nhiệm đề tài và đóng dấu mộc đỏ của Viện.'
  },
  DU_TOAN_DA_DUYET: {
    owner_label: 'Chủ nhiệm lập / P. KH&CN & TC-Cung ứng duyệt',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'PHONG_TC_CU', 'SUPER_ADMIN'],
    require_red_seal: true,
    legal_tag: 'Bắt buộc: Bản đã thẩm định, phê duyệt & đóng dấu mộc đỏ',
    legal_detail: 'Bắt buộc tải lên bản scan (PDF) Phụ lục dự toán chi tiết đã có chữ ký của Chủ nhiệm đề tài, xác nhận thẩm định của P. KH&CN / P. TC-Cung ứng và phê duyệt đóng dấu mộc đỏ.'
  },
  DON_DIEU_CHINH_DU_TOAN: {
    owner_label: 'Chủ nhiệm đề tài lập & nộp',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN'],
    require_red_seal: false,
    legal_tag: 'Bản có chữ ký đề xuất của Chủ nhiệm đề tài',
    legal_detail: 'Yêu cầu tải lên bản scan (PDF) Tờ trình đề xuất điều chỉnh dự toán kinh phí / danh mục vật tư có chữ ký xác nhận của Chủ nhiệm đề tài.'
  },
  QD_DIEU_CHINH_DU_TOAN: {
    owner_label: 'Viện trưởng ký / P. KH&CN & Văn thư lưu',
    allowed_upload_roles: ['PHONG_KHCN', 'PHONG_TCHC', 'SUPER_ADMIN'],
    require_red_seal: true,
    legal_tag: 'Bắt buộc: Bản scan có chữ ký Viện trưởng & dấu mộc đỏ',
    legal_detail: 'Bắt buộc tải lên bản scan màu (PDF) Quyết định hoặc Văn bản chấp thuận điều chỉnh dự toán có chữ ký phê duyệt của Viện trưởng và đóng dấu mộc đỏ.'
  },
  CHUNG_TU_VAT_TU: {
    owner_label: 'Thủ kho & P. TC-Cung ứng lập & lưu',
    allowed_upload_roles: ['THU_KHO', 'PHONG_TC_CU', 'PHONG_KHCN', 'SUPER_ADMIN'],
    require_red_seal: false,
    legal_tag: 'Bản có chữ ký xác nhận giao nhận (Thủ kho, P. TC-CU & Chủ nhiệm)',
    legal_detail: 'Yêu cầu tải lên bản scan Phiếu xuất kho / Biên bản giao nhận vật tư hóa chất hoặc chứng từ đơn hàng MISA đã có đầy đủ chữ ký xác nhận của Thủ kho, P. TC-Cung ứng và Chủ nhiệm đề tài.'
  },
  BAO_CAO_6_THANG: {
    owner_label: 'Chủ nhiệm đề tài nộp',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN'],
    require_red_seal: false,
    legal_tag: 'Bản đã ký của Chủ nhiệm & xác nhận đánh giá của P. KH&CN',
    legal_detail: 'Yêu cầu tải lên bản scan (PDF) Báo cáo tiến độ định kỳ 06 tháng có chữ ký của Chủ nhiệm đề tài và xác nhận đánh giá tiến độ của Phòng KH&CN.'
  },
  DON_GIA_HAN_1: {
    owner_label: 'Chủ nhiệm đề tài nộp',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN'],
    require_red_seal: false,
    legal_tag: 'Bản có chữ ký Chủ nhiệm đề tài & xác nhận tiếp nhận',
    legal_detail: 'Yêu cầu tải lên bản scan (PDF) Đơn đề nghị gia hạn thời gian thực hiện (Lần 1) có chữ ký cam kết của Chủ nhiệm đề tài.'
  },
  QD_GIA_HAN_1: {
    owner_label: 'Viện trưởng ký / P. KH&CN & Văn thư lưu',
    allowed_upload_roles: ['PHONG_KHCN', 'PHONG_TCHC', 'SUPER_ADMIN'],
    require_red_seal: true,
    legal_tag: 'Bắt buộc: Bản scan có chữ ký Viện trưởng & dấu mộc đỏ',
    legal_detail: 'Bắt buộc tải lên bản scan màu (PDF) Quyết định cho phép gia hạn thực hiện đề tài (Lần 1) có chữ ký của Viện trưởng và đóng dấu mộc đỏ.'
  },
  DON_GIA_HAN_2: {
    owner_label: 'Chủ nhiệm đề tài nộp',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN'],
    require_red_seal: false,
    legal_tag: 'Bản có chữ ký cam kết của Chủ nhiệm đề tài',
    legal_detail: 'Yêu cầu tải lên bản scan (PDF) Đơn đề nghị gia hạn Lần 2 (Lần cuối) kèm bản giải trình và chữ ký cam kết hoàn thành của Chủ nhiệm đề tài.'
  },
  QD_GIA_HAN_2: {
    owner_label: 'Viện trưởng ký / P. KH&CN & Văn thư lưu',
    allowed_upload_roles: ['PHONG_KHCN', 'PHONG_TCHC', 'SUPER_ADMIN'],
    require_red_seal: true,
    legal_tag: 'Bắt buộc: Bản scan có chữ ký Viện trưởng & dấu mộc đỏ',
    legal_detail: 'Bắt buộc tải lên bản scan màu (PDF) Quyết định cho phép gia hạn thực hiện đề tài Lần 2 (Lần cuối) có chữ ký của Viện trưởng và đóng dấu mộc đỏ.'
  },
  BAO_CAO_TONG_KET: {
    owner_label: 'Chủ nhiệm đề tài nộp',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN'],
    require_red_seal: true,
    legal_tag: 'Bắt buộc: Bản hoàn thiện đã phê duyệt & đóng dấu mộc đỏ',
    legal_detail: 'Bắt buộc tải lên bản scan (PDF) Báo cáo tổng kết chính thức đã hoàn thiện sau nghiệm thu, có chữ ký của Chủ nhiệm đề tài và trang xác nhận đóng dấu mộc đỏ của Viện.'
  },
  SAN_PHAM_KHCN: {
    owner_label: 'Chủ nhiệm đề tài nộp',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN'],
    require_red_seal: false,
    legal_tag: 'Bản công bố chính thức / Quy trình có quyết định & dấu xác nhận',
    legal_detail: 'Yêu cầu tải lên bản PDF bài báo khoa học đã xuất bản chính thức (hoặc văn bản chấp nhận đăng) / Quy trình kỹ thuật có xác nhận nghiệm thu và đóng dấu của đơn vị.'
  },
  BB_NGHIEM_THU: {
    owner_label: 'Phòng KH&CN lập & lưu',
    allowed_upload_roles: ['PHONG_KHCN', 'SUPER_ADMIN'],
    require_red_seal: true,
    legal_tag: 'Bắt buộc: Bản scan có chữ ký Hội đồng nghiệm thu & dấu xác nhận',
    legal_detail: 'Bắt buộc tải lên bản scan (PDF) Biên bản họp Hội đồng đánh giá nghiệm thu cấp cơ sở có đầy đủ chữ ký của Chủ tịch Hội đồng, Thư ký và đóng dấu xác nhận.'
  },
  GIAI_TRINH_SAU_HOP: {
    owner_label: 'Chủ nhiệm đề tài nộp',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN'],
    require_red_seal: false,
    legal_tag: 'Bắt buộc: Bản có chữ ký Chủ nhiệm & xác nhận của Chủ tịch HĐ',
    legal_detail: 'Bắt buộc tải lên bản scan (PDF) Bản giải trình chỉnh sửa sau nghiệm thu có chữ ký của Chủ nhiệm đề tài và chữ ký xác nhận đồng ý của Chủ tịch Hội đồng nghiệm thu.'
  },
  QD_CONG_NHAN: {
    owner_label: 'Viện trưởng ký / P. KH&CN & Văn thư lưu',
    allowed_upload_roles: ['PHONG_KHCN', 'PHONG_TCHC', 'SUPER_ADMIN'],
    require_red_seal: true,
    legal_tag: 'Bắt buộc: Bản scan có chữ ký Viện trưởng & dấu mộc đỏ',
    legal_detail: 'Bắt buộc tải lên bản scan màu (PDF) Quyết định công nhận kết quả nghiệm thu đề tài có chữ ký của Viện trưởng và đóng dấu mộc đỏ của Viện.'
  },
  BB_THANH_LY: {
    owner_label: 'P. TC-Cung ứng & P. KH&CN lập & lưu',
    allowed_upload_roles: ['PHONG_TC_CU', 'PHONG_KHCN', 'PHONG_TCHC', 'SUPER_ADMIN'],
    require_red_seal: true,
    legal_tag: 'Bắt buộc: Bản scan có chữ ký hai bên, Kế toán & dấu mộc đỏ',
    legal_detail: 'Bắt buộc tải lên bản scan màu (PDF) Biên bản thanh lý Hợp đồng NCKH và Báo cáo quyết toán kinh phí có đầy đủ chữ ký của Viện trưởng, P. TC-Cung ứng, P. KH&CN, Chủ nhiệm và đóng dấu mộc đỏ.'
  }
};

const ROLE_VN_LABELS = {
  SUPER_ADMIN: 'Quản trị hệ thống',
  VIEN_TRUONG: 'Viện trưởng',
  PHONG_KHCN: 'Phòng KH&CN',
  CHU_NHIEM: 'Chủ nhiệm đề tài',
  PHONG_TCHC: 'Phòng Tổ chức - Hành chính (Văn thư)',
  PHONG_TC_CU: 'Phòng Tài chính - Cung ứng',
  THU_KHO: 'Thủ kho Vật tư - Hóa chất'
};

function getCurrentRoleLabelVn() {
  const role = typeof window.getCurrentRole === 'function' ? window.getCurrentRole() : 'PHONG_KHCN';
  if (role === 'CHU_NHIEM' && typeof window.getCurrentLeader === 'function') {
    return `Chủ nhiệm đề tài (${window.getCurrentLeader()})`;
  }
  return ROLE_VN_LABELS[role] || role;
}

function canCurrentUserUploadCriteriaItem(item) {
  if (!item) return false;
  const policy = CRITERIA_UPLOAD_POLICY[item.key];
  const allowedRoles = policy ? policy.allowed_upload_roles : (item.allowed_upload_roles || ['PHONG_KHCN', 'SUPER_ADMIN']);
  if (typeof window.canUserUploadCriteria === 'function') {
    return window.canUserUploadCriteria(allowedRoles, currentProjectData?.leader_name);
  }
  return true;
}

// Hàm dựng danh sách tiêu chí văn bản cho từng Giai đoạn (bao gồm cả văn bản chính, văn bản liên thông và phân quyền tải lên)
function getStageCriteriaList(stage, auditItems = [], documents = []) {
  const st = Number(stage);
  const keys = STAGE_SHARED_DOC_KEYS[st] || [];
  const itemMap = new Map();

  (auditItems || []).forEach(it => {
    const pol = CRITERIA_UPLOAD_POLICY[it.key];
    itemMap.set(it.key, {
      ...it,
      owner_label: pol ? pol.owner_label : it.owner_label,
      allowed_upload_roles: pol ? pol.allowed_upload_roles : it.allowed_upload_roles
    });
  });

  // Bổ sung mục Tờ trình đề xuất điều chỉnh dự toán (DON_DIEU_CHINH_DU_TOAN) nếu chưa tách riêng trong auditItems
  if (!itemMap.has('DON_DIEU_CHINH_DU_TOAN')) {
    const matchedDonFile = (documents || []).find(d => d.doc_type === 'DON_DIEU_CHINH_DU_TOAN');
    const qdCrit = itemMap.get('QD_DIEU_CHINH_DU_TOAN');
    const isReq = qdCrit ? Boolean(qdCrit.required) : false;
    itemMap.set('DON_DIEU_CHINH_DU_TOAN', {
      key: 'DON_DIEU_CHINH_DU_TOAN',
      name: 'Tờ trình đề xuất điều chỉnh dự toán kinh phí (nếu có)',
      short_name: 'Tờ trình điều chỉnh DT',
      stage: 3,
      required: isReq,
      status: matchedDonFile ? 'UPLOADED' : (isReq ? 'MISSING' : 'NOT_REQUIRED'),
      status_label: matchedDonFile ? 'Đã nộp bản số hóa' : (isReq ? 'Chưa nộp' : 'Không bắt buộc'),
      owner_role: 'CHU_NHIEM',
      owner_label: CRITERIA_UPLOAD_POLICY.DON_DIEU_CHINH_DU_TOAN.owner_label,
      allowed_upload_roles: CRITERIA_UPLOAD_POLICY.DON_DIEU_CHINH_DU_TOAN.allowed_upload_roles,
      file: matchedDonFile ? {
        id: matchedDonFile.id,
        title: matchedDonFile.title,
        file_name: matchedDonFile.file_name,
        file_size: matchedDonFile.file_size,
        uploaded_by: matchedDonFile.uploaded_by,
        uploaded_at_vn: matchedDonFile.uploaded_at_vn
      } : null
    });
  }

  const result = [];
  keys.forEach(k => {
    const found = itemMap.get(k);
    if (found) {
      result.push({
        ...found,
        display_stage: st,
        is_primary_stage: Number(found.stage) === st,
        shared_stage_note: SHARED_STAGE_LABELS[k] || null
      });
    }
  });

  // Thêm các tiêu chí khác có stage gốc bằng st nhưng chưa nằm trong keys
  (auditItems || []).forEach(it => {
    if (Number(it.stage) === st && !result.some(r => r.key === it.key)) {
      const pol = CRITERIA_UPLOAD_POLICY[it.key];
      result.push({
        ...it,
        owner_label: pol ? pol.owner_label : it.owner_label,
        allowed_upload_roles: pol ? pol.allowed_upload_roles : it.allowed_upload_roles,
        display_stage: st,
        is_primary_stage: true,
        shared_stage_note: SHARED_STAGE_LABELS[it.key] || null
      });
    }
  });

  return result;
}

// 4. Render Hồ sơ 7 Giai đoạn (Phân cấp rõ ràng giữa Khối Giai đoạn Cha và Danh sách Văn bản Con + Phân quyền theo Vai trò × Giai đoạn × Loại văn bản)
function renderStagesAndDocuments(documents, audit) {
  const container = document.getElementById('stagesContainer');
  let html = '';
  const auditItems = (audit && audit.items) ? audit.items : [];
  const matchedFileIds = new Set();

  // Thu thập trước tất cả file đã khớp với tiêu chí để không bị lặp ở mục "Văn bản bổ sung"
  const allowedStagesList = [];
  for (let s = 1; s <= 7; s++) {
    const listS = getStageCriteriaList(s, auditItems, documents);
    listS.forEach(it => {
      if (it.file && it.file.id) matchedFileIds.add(it.file.id);
    });
    if (listS.some(it => canCurrentUserUploadCriteriaItem(it))) {
      allowedStagesList.push(s);
    }
  }

  // Cập nhật thanh trạng thái thẩm quyền nộp văn bản ở đầu khung 7 giai đoạn
  const topBtn = document.getElementById('btnTopUploadDoc');
  const scopeBadge = document.getElementById('docsRoleScopeBadge');
  const roleLabel = getCurrentRoleLabelVn();
  if (allowedStagesList.length > 0) {
    if (topBtn) topBtn.style.display = 'inline-flex';
    if (scopeBadge) {
      const stageStr = allowedStagesList.length === 7
        ? 'Toàn bộ 7 giai đoạn'
        : `Giai đoạn ${allowedStagesList.join(', ')}`;
      scopeBadge.innerHTML = `Vai trò đang thao tác: <strong>${escapeHtml(roleLabel)}</strong> • Phạm vi mở chức năng tải lên: <strong style="color:#0284c7;">${stageStr}</strong>`;
    }
  } else {
    if (topBtn) topBtn.style.display = 'none';
    if (scopeBadge) {
      scopeBadge.innerHTML = `Vai trò đang thao tác: <strong>${escapeHtml(roleLabel)}</strong> • <span style="color:#64748b;">Chế độ xem và tra cứu văn bản (Không thuộc thẩm quyền tải tệp lên)</span>`;
    }
  }

  for (let stage = 1; stage <= 7; stage++) {
    const stageCriteria = getStageCriteriaList(stage, auditItems, documents);
    const stageDocs = documents.filter(d => Number(d.stage) === stage);
    const uploadableInStage = stageCriteria.filter(i => canCurrentUserUploadCriteriaItem(i));

    const reqItems = stageCriteria.filter(i => i.required);
    const doneItems = reqItems.filter(i => i.status === 'UPLOADED' || i.status === 'VERIFIED');

    const criteriaHtml = stageCriteria.map((item, idx) => {
      const canUpload = canCurrentUserUploadCriteriaItem(item);

      let statusBadge = '';
      let actions = '';
      let rowExtraCls = '';

      const autoFillKeys = ['QD_GIAO_NHIEM_VU', 'HOP_DONG_NCKH', 'QD_DIEU_CHINH_DU_TOAN', 'DON_DIEU_CHINH_DU_TOAN', 'BAO_CAO_6_THANG', 'DON_GIA_HAN_1', 'DON_GIA_HAN_2', 'BAO_CAO_TONG_KET', 'BB_NGHIEM_THU', 'GIAI_TRINH_SAU_HOP', 'BB_THANH_LY', 'DON_NGHIEM_THU'];
      const autoFillBtn = (canUpload && autoFillKeys.includes(item.key)) ? `
        <a href="/api/projects/${currentProjectId}/export-autofill/${item.key}" target="_blank" class="btn btn-outline btn-sm" style="padding: 3px 8px; font-size: 0.72rem; color: #0284c7; border-color: #7dd3fc; background: #f0f9ff; text-decoration: none;" title="Tải biểu mẫu Word đã điền sẵn thông tin đề tài">
          Tải mẫu
        </a>
      ` : '';

      const role = typeof window.getCurrentRole === 'function' ? window.getCurrentRole() : 'PHONG_KHCN';
      const isKhcnOrAdmin = ['PHONG_KHCN', 'SUPER_ADMIN'].includes(role);
      const isLockedVerified = item.status === 'VERIFIED';

      if (item.status === 'UPLOADED' || (item.status === 'VERIFIED' && item.file && item.file.id)) {
        statusBadge = item.status === 'VERIFIED'
          ? `<span class="badge badge-green" style="font-size: 0.68rem; padding: 2px 7px;">Đã duyệt bản chính</span>`
          : `<span class="badge badge-blue" style="font-size: 0.68rem; padding: 2px 7px;">Đã nộp bản số hóa</span>`;
        const btns = [];
        if (autoFillBtn && (!isLockedVerified || isKhcnOrAdmin)) {
          btns.push(autoFillBtn);
        }
        if (item.file && item.file.id) {
          btns.push(`
            <button type="button" class="btn btn-outline btn-sm" onclick="previewDocument(${item.file.id}, '${escapeHtml(item.file.title)}')" style="padding: 3px 8px; font-size: 0.74rem;">
              Xem văn bản
            </button>
            <a href="/api/documents/${item.file.id}/download" class="btn btn-outline btn-sm" style="padding: 3px 8px; font-size: 0.74rem; text-decoration: none;">
              Tải về
            </a>
          `);
          if (isKhcnOrAdmin) {
            btns.push(`
              <button type="button" class="btn btn-outline btn-sm" onclick="openEditDocModal(${item.file.id}, '${item.key}', ${stage}, '${item.status}')" style="padding: 3px 8px; font-size: 0.72rem; color: #0f172a; border-color: #94a3b8; background: #f8fafc; font-weight: 600;" title="Đổi phân loại nếu tải nhầm mục, thay tệp mới, khóa duyệt bản chính hoặc gỡ bỏ văn bản">
                Sửa / Xử lý
              </button>
            `);
          } else if (canUpload && !isLockedVerified) {
            btns.push(`
              <button type="button" class="btn btn-outline btn-sm" onclick="openEditDocModal(${item.file.id}, '${item.key}', ${stage}, '${item.status}')" style="padding: 3px 8px; font-size: 0.72rem; color: #0369a1; border-color: #7dd3fc; background: #f0f9ff; font-weight: 600;" title="Thay tệp mới nếu tải nhầm, sửa tên hiển thị hoặc gỡ văn bản">
                Sửa / Thay tệp
              </button>
            `);
          } else if (canUpload && isLockedVerified) {
            btns.push(`<span style="font-size: 0.7rem; color: #15803d; font-weight: 600; padding: 2px 6px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 4px;" title="Phòng KH&CN đã đối chiếu dấu mộc đỏ và khóa lưu trữ bản chính. Liên hệ P. KH&CN nếu cần mở khóa cập nhật.">Đã khóa bản chính</span>`);
          }
        } else if (canUpload) {
          btns.push(`
            <button type="button" class="btn btn-outline btn-sm" onclick="openUploadModalForCriteria('${item.key}', ${stage}, '${escapeHtml(item.name)}')" style="padding: 3px 8px; font-size: 0.72rem;">
              Nộp lại
            </button>
          `);
        }
        actions = btns.join(' ');
      } else if (item.status === 'VERIFIED') {
        statusBadge = `<span class="badge badge-green" style="font-size: 0.68rem; padding: 2px 7px;">Đã duyệt bản chính</span>`;
        if (canUpload) {
          actions = autoFillBtn + `
            <button type="button" class="btn btn-outline btn-sm" onclick="openUploadModalForCriteria('${item.key}', ${stage}, '${escapeHtml(item.name)}')" style="padding: 3px 8px; font-size: 0.72rem;">
              Đính kèm tệp
            </button>
          `;
        }
      } else if (item.status === 'NOT_REQUIRED') {
        statusBadge = `<span class="badge badge-gray" style="font-size: 0.68rem; padding: 2px 7px;">Không bắt buộc</span>`;
        if (canUpload) {
          actions = autoFillBtn + `
            <button type="button" class="btn btn-outline btn-sm" onclick="openUploadModalForCriteria('${item.key}', ${stage}, '${escapeHtml(item.name)}')" style="padding: 3px 8px; font-size: 0.72rem;">
              Nộp bổ sung
            </button>
          `;
        } else {
          actions = `<span style="font-size: 0.73rem; color: #94a3b8;">Do ${escapeHtml(item.owner_label)}</span>`;
        }
      } else {
        rowExtraCls = 'is-missing';
        statusBadge = `<span class="badge badge-red" style="font-size: 0.68rem; padding: 2px 7px;">Chưa nộp</span>`;
        if (canUpload) {
          actions = autoFillBtn + `
            <button type="button" class="btn btn-primary btn-sm" onclick="openUploadModalForCriteria('${item.key}', ${stage}, '${escapeHtml(item.name)}')" style="padding: 3px 10px; font-size: 0.74rem;">
              Nộp văn bản
            </button>
          `;
        } else {
          actions = `<span style="font-size: 0.74rem; color: #64748b;">Chờ ${escapeHtml(item.owner_label)}</span>`;
        }
      }

      const metaParts = [];
      if (item.owner_label) {
        metaParts.push(`Đơn vị nộp: <strong>${escapeHtml(item.owner_label)}</strong>`);
      }
      if (item.shared_stage_note) {
        metaParts.push(`<span style="color: #475569; font-weight: 600;">${escapeHtml(item.shared_stage_note)}</span>`);
      }
      if (item.file && item.file.id) {
        const uploaderText = item.file.uploaded_by ? ` • Người tải: ${escapeHtml(item.file.uploaded_by)}` : '';
        metaParts.push(`Tệp: <span style="color: #0369a1; font-weight: 600;">${escapeHtml(item.file.title || item.file.file_name)}</span> (${formatFileSize(item.file.file_size)}${uploaderText})`);
      }

      const pol = CRITERIA_UPLOAD_POLICY[item.key];
      let legalLineHtml = '';
      if (pol && pol.legal_tag) {
        const isRedSeal = pol.require_red_seal && !(item.key === 'THUYET_MINH' && stage === 1);
        const legalText = (item.key === 'THUYET_MINH' && stage === 1)
          ? 'Bản trình nộp có chữ ký Chủ nhiệm đề tài (hoặc bản đã phê duyệt)'
          : (item.key === 'THUYET_MINH' && stage === 2)
            ? 'Bắt buộc: Bản hoàn thiện sau Hội đồng đã phê duyệt & đóng dấu mộc đỏ'
            : pol.legal_tag;
        const legalStyle = isRedSeal
          ? 'color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca;'
          : 'color: #1e40af; background: #eff6ff; border: 1px solid #bfdbfe;';
        legalLineHtml = `
          <div style="margin-top: 4px;">
            <span style="display: inline-block; font-size: 0.71rem; font-weight: 600; padding: 1px 7px; border-radius: 4px; ${legalStyle}">
              Yêu cầu pháp lý: ${escapeHtml(legalText)}
            </span>
          </div>
        `;
      }

      const rowDomId = item.is_primary_stage
        ? `criteria-row-${item.key}`
        : `criteria-row-${item.key}-stage-${stage}`;

      return `
        <div id="${rowDomId}" class="stage-doc-row ${rowExtraCls}">
          <div style="flex: 1; min-width: 240px; display: flex; align-items: flex-start; gap: 6px;">
            <span class="stage-doc-index" style="flex-shrink: 0; padding-top: 1px;">${stage}.${idx + 1}.</span>
            <div style="flex: 1;">
              <div style="line-height: 1.4;">
                <span style="font-weight: 700; font-size: 0.86rem; color: #0f172a; margin-right: 6px;">${escapeHtml(item.name)}</span>
                ${statusBadge}
              </div>
              <div style="font-size: 0.75rem; color: #64748b; margin-top: 3px;">
                ${metaParts.join(' &nbsp;•&nbsp; ')}
              </div>
              ${legalLineHtml}
            </div>
          </div>
          <div style="display: flex; gap: 5px; align-items: center; flex-shrink: 0;">
            ${actions}
          </div>
        </div>
      `;
    }).join('');

    // Các file bổ sung khác trong cùng giai đoạn
    const extraDocs = stageDocs.filter(d => !matchedFileIds.has(d.id));
    const roleForExtra = typeof window.getCurrentRole === 'function' ? window.getCurrentRole() : 'PHONG_KHCN';
    const isKhcnOrAdminExtra = ['PHONG_KHCN', 'SUPER_ADMIN'].includes(roleForExtra);
    const isOwnerExtra = roleForExtra === 'CHU_NHIEM' && (!currentProjectData || typeof window.isProjectOwnedByCurrentUser !== 'function' || window.isProjectOwnedByCurrentUser(currentProjectData.leader_name));

    const extraDocsHtml = extraDocs.map((d, eIdx) => {
      const subIndex = stageCriteria.length + eIdx + 1;
      const canEditExtra = isKhcnOrAdminExtra || isOwnerExtra;
      return `
        <div class="stage-doc-row">
          <div style="flex: 1; min-width: 240px; display: flex; align-items: flex-start; gap: 6px;">
            <span class="stage-doc-index" style="flex-shrink: 0; padding-top: 1px;">${stage}.${subIndex}.</span>
            <div style="flex: 1;">
              <div style="line-height: 1.4;">
                <span style="font-weight: 700; font-size: 0.85rem; color: #0f172a; margin-right: 6px;">${escapeHtml(d.title)}</span>
                <span class="badge badge-blue" style="font-size: 0.68rem; padding: 2px 7px;">Văn bản bổ sung</span>
              </div>
              <div style="font-size: 0.75rem; color: #64748b; margin-top: 3px;">
                Tệp: <span style="color: #0369a1; font-weight: 600;">${escapeHtml(d.file_name)}</span> (${formatFileSize(d.file_size)} • Người tải: ${escapeHtml(d.uploaded_by || 'Phòng KH&CN')})
              </div>
            </div>
          </div>
          <div style="display: flex; gap: 5px; flex-shrink: 0;">
            <button type="button" class="btn btn-outline btn-sm" onclick="previewDocument(${d.id}, '${escapeHtml(d.title)}')" style="padding: 3px 8px; font-size: 0.74rem;">
              Xem văn bản
            </button>
            <a href="/api/documents/${d.id}/download" class="btn btn-outline btn-sm" style="padding: 3px 8px; font-size: 0.74rem; text-decoration: none;">
              Tải về
            </a>
            ${canEditExtra ? `
              <button type="button" class="btn btn-outline btn-sm" onclick="openEditDocModal(${d.id}, '${escapeHtml(d.doc_type || 'KHAC')}', ${stage}, 'UPLOADED')" style="padding: 3px 8px; font-size: 0.72rem; color: #0f172a; border-color: #94a3b8; background: #f8fafc; font-weight: 600;" title="Phân loại lại vào đúng danh mục hồ sơ, thay tệp hoặc gỡ bỏ">
                Sửa / Xử lý
              </button>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');

    const isAllDone = reqItems.length > 0 && doneItems.length === reqItems.length;
    const stageBadge = reqItems.length > 0
      ? `<span class="stage-group-status-pill ${isAllDone ? 'is-complete' : 'is-incomplete'}">${doneItems.length}/${reqItems.length} mục</span>`
      : '';

    const stageAddBtnHtml = uploadableInStage.length > 0
      ? `<button type="button" class="stage-group-add-btn" onclick="openUploadModalForStage(${stage})" title="Mở hộp thoại nộp các văn bản thuộc thẩm quyền tại Giai đoạn ${stage}">
           + Thêm văn bản (${uploadableInStage.length})
         </button>`
      : `<span style="font-size: 0.7rem; color: #cbd5e1; padding: 2px 6px;">Chỉ xem</span>`;

    html += `
      <div id="stage-box-${stage}" class="stage-group-card">
        <div class="stage-group-header">
          <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
            <span class="stage-group-step-pill">Giai đoạn ${stage}</span>
            <span class="stage-group-title">${STAGE_NAMES[stage]}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
            ${stageBadge}
            ${stageAddBtnHtml}
          </div>
        </div>

        <div class="stage-group-body">
          ${criteriaHtml}
          ${extraDocsHtml}
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
}

// 5. Xem nội dung văn bản trực tiếp
function previewDocument(docId, title) {
  const iframe = document.getElementById('previewIframe');
  const placeholder = document.getElementById('previewPlaceholder');
  const titleEl = document.getElementById('previewTitle');
  const openNewTabBtn = document.getElementById('previewOpenNewTab');
  const downloadBtn = document.getElementById('previewDownloadBtn');

  const previewUrl = `/api/documents/${docId}/preview`;
  const downloadUrl = `/api/documents/${docId}/download`;

  titleEl.innerText = title || 'Nội dung văn bản';
  iframe.src = previewUrl;

  placeholder.style.display = 'none';
  iframe.style.display = 'block';

  openNewTabBtn.href = previewUrl;
  openNewTabBtn.style.display = 'inline-flex';

  downloadBtn.href = downloadUrl;
  downloadBtn.style.display = 'inline-flex';

  showToast(`Đang mở văn bản: ${title}`, 'success');
}

// 6. Render Báo cáo Định kỳ 6 tháng
function renderPeriodicReports(reports) {
  const tbody = document.getElementById('reportsTableBody');
  if (!reports || reports.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; padding: 1.5rem; color: var(--text-muted);">
          Chưa có kỳ báo cáo định kỳ nào.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = reports.map(r => {
    let statusBadge = '<span class="badge badge-yellow">Chưa nộp</span>';
    if (r.status === 'APPROVED') {
      statusBadge = '<span class="badge badge-green">Đã thông qua</span>';
    } else if (r.status === 'SUBMITTED') {
      statusBadge = '<span class="badge badge-blue">Đã nộp — Chờ duyệt</span>';
    } else if (r.status === 'REVISION_NEEDED') {
      statusBadge = '<span class="badge badge-red">Yêu cầu bổ sung</span>';
    }

    return `
      <tr id="report-row-${r.id}">
        <td style="font-weight: 700; text-align: center;">Kỳ ${r.period_num}</td>
        <td>
          <div style="font-weight: 600;">Báo cáo định kỳ ${r.period_num * 6} tháng</div>
          <div style="font-size: 0.76rem; color: var(--text-muted);">Tiến độ: ${r.progress_percent || 0}%</div>
        </td>
        <td style="font-weight: 600; color: #dc2626;">${r.due_date_vn || r.due_date}</td>
        <td>${r.submitted_date_vn || '<span style="color:#64748b;">Chưa nộp</span>'}</td>
        <td>${statusBadge}</td>
        <td>
          ${r.report_file_id ? `
            <div style="margin-bottom: 4px;">
              <a href="/api/documents/${r.report_file_id}/download" class="badge badge-blue" style="text-decoration: none;">
                Tải tệp báo cáo đã nộp
              </a>
            </div>
          ` : ''}
          ${r.progress_summary ? `<div style="font-size: 0.8rem; max-width: 250px;">${escapeHtml(r.progress_summary)}</div>` : '<span style="color:#64748b; font-size: 0.78rem;">--</span>'}
        </td>
        <td>
          ${r.khcn_evaluation ? `<div style="font-size: 0.8rem; color: #0284c7;">${escapeHtml(r.khcn_evaluation)}</div>` : '<span style="color:#64748b;">Chưa có ý kiến</span>'}
        </td>
        <td style="text-align: center;">
          <div style="display: flex; flex-direction: column; gap: 4px; align-items: center;">
            <a href="/api/projects/${currentProjectId}/export-autofill/BAO_CAO_6_THANG?reportId=${r.id}" target="_blank" class="btn btn-outline btn-sm" style="padding: 3px 8px; font-size: 0.74rem; color: #0284c7; border-color: #7dd3fc; background: #f0f9ff; text-decoration: none; width: 100%; justify-content: center;">
              Tải biểu mẫu
            </a>
            <button class="btn btn-primary btn-sm" style="width: 100%; justify-content: center; font-size: 0.74rem; padding: 3px 8px;" onclick="openSubmitReportModal(${r.id}, ${r.period_num})">
              Nộp báo cáo
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// =========================================================================
// 7A. BẢNG ĐIỀU KHIỂN ĐỐI CHIẾU TIẾN ĐỘ THỰC TẾ VS DỰ TOÁN (BUDGET VS ACTUAL)
// =========================================================================
function getSuppliesRolePermissions() {
  const role = typeof window.getCurrentRole === 'function' ? window.getCurrentRole() : 'PHONG_KHCN';
  const isOwner = role === 'CHU_NHIEM' && (!currentProjectData || typeof window.isProjectOwnedByCurrentUser !== 'function' || window.isProjectOwnedByCurrentUser(currentProjectData.leader_name));
  return {
    role,
    isOwner,
    canEditBudget: ['SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TC_CU', 'VIEN_TRUONG'].includes(role) || isOwner,
    canDeleteBudget: ['SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TC_CU'].includes(role),
    canRequestSupply: isOwner || ['PHONG_KHCN', 'SUPER_ADMIN'].includes(role),
    canKhcnApprove: ['PHONG_KHCN', 'VIEN_TRUONG', 'SUPER_ADMIN'].includes(role),
    canWarehouseUpdate: ['THU_KHO', 'PHONG_TC_CU', 'PHONG_KHCN', 'SUPER_ADMIN'].includes(role),
    canFinancePrice: ['PHONG_TC_CU', 'THU_KHO', 'PHONG_KHCN', 'SUPER_ADMIN'].includes(role),
    canPiConfirm: isOwner || ['SUPER_ADMIN', 'PHONG_KHCN'].includes(role)
  };
}

function renderBudgetVsActualDashboard(analytics) {
  const perms = getSuppliesRolePermissions();

  // Cập nhật nhãn phạm vi vai trò
  const scopeBadge = document.getElementById('suppliesRoleScopeBadge');
  if (scopeBadge) {
    let scopeText = 'Chế độ xem tổng hợp';
    if (perms.role === 'SUPER_ADMIN') scopeText = 'Toàn quyền quản trị Dự toán & Cấp phát';
    else if (perms.role === 'PHONG_KHCN') scopeText = 'Đối chiếu dự toán, duyệt đề xuất & quản lý định mức';
    else if (perms.role === 'THU_KHO') scopeText = 'Kiểm kho, xuất kho & cập nhật SL giao nhận thực tế';
    else if (perms.role === 'PHONG_TC_CU') scopeText = 'Quản lý dự toán, mua sắm MISA & đơn giá thực chi';
    else if (perms.role === 'VIEN_TRUONG') scopeText = 'Giám sát giải ngân & phê duyệt điều chỉnh/vượt định mức';
    else if (perms.role === 'CHU_NHIEM') scopeText = perms.isOwner ? 'Lập đề xuất vật tư, điều chỉnh DT & xác nhận nhận hàng' : 'Chế độ xem tham khảo';
    scopeBadge.innerHTML = `Vai trò: <strong>${escapeHtml(getCurrentRoleLabelVn())}</strong> • <span style="color:#0284c7;">${scopeText}</span>`;
  }

  // Ẩn/hiện nút hành động theo RBAC & Trạng thái Khóa dự toán gốc (Baseline Lock)
  const legal = (analytics && analytics.legal_status) ? analytics.legal_status : { is_locked: false, has_red_seal_doc: false, red_seal_doc: null };
  const isLocked = Boolean(legal.is_locked);
  const canLockBudget = ['SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TC_CU', 'VIEN_TRUONG'].includes(perms.role);
  const canUnlockBudget = ['SUPER_ADMIN', 'PHONG_KHCN'].includes(perms.role);

  const btnImport = document.getElementById('btnImportBudgetExcel');
  const btnAddB = document.getElementById('btnAddBudgetItem');
  const btnReqS = document.getElementById('btnOpenRequestSupply');
  const lockNoticeBar = document.getElementById('budgetLockedNoticeBar');
  if (btnImport) btnImport.style.display = (perms.canEditBudget && !isLocked) ? 'inline-flex' : 'none';
  if (btnAddB) btnAddB.style.display = (perms.canEditBudget && !isLocked) ? 'inline-flex' : 'none';
  if (btnReqS) btnReqS.style.display = perms.canRequestSupply ? 'inline-flex' : 'none';
  if (lockNoticeBar) lockNoticeBar.style.display = isLocked ? 'block' : 'none';

  // Render Thanh Pháp lý Dự toán có dấu mộc đỏ & Chốt khóa bản gốc
  const legalBar = document.getElementById('budgetLegalBaselineBar');
  if (legalBar) {
    const doc = legal.red_seal_doc;
    if (isLocked) {
      legalBar.style.background = '#f0fdf4';
      legalBar.style.borderColor = '#86efac';
    } else if (legal.has_red_seal_doc) {
      legalBar.style.background = '#eff6ff';
      legalBar.style.borderColor = '#93c5fd';
    } else {
      legalBar.style.background = '#fffbeb';
      legalBar.style.borderColor = '#fcd34d';
    }

    const statusBadgeHtml = isLocked
      ? `<span class="badge badge-green" style="font-size:0.75rem;"><i class="fa-solid fa-lock"></i> Đã Chốt &amp; Khóa theo bản mộc đỏ</span>`
      : `<span class="badge badge-yellow" style="font-size:0.75rem;"><i class="fa-solid fa-lock-open"></i> Bản nháp — Chưa chốt khóa dự toán gốc</span>`;

    const docInfoHtml = doc
      ? `<span style="font-size:0.78rem; color:#166534;">Văn bản phê duyệt: <strong>${escapeHtml(doc.file_name)}</strong>${legal.locked_by ? ` • Chốt bởi: <strong>${escapeHtml(legal.locked_by)}</strong> (${escapeHtml(legal.locked_at || '')})` : ''}</span>`
      : `<span style="font-size:0.78rem; color:#92400e;">Chưa có bản scan PDF Dự toán phê duyệt có dấu mộc đỏ (<code>DU_TOAN_DA_DUYET</code>).</span>`;

    const btns = [];
    btns.push(`<button type="button" class="btn btn-outline btn-sm" style="padding:3px 9px; font-size:0.74rem; color:#0284c7; border-color:#7dd3fc; background:#f0f9ff; font-weight:600;" onclick="openBudgetReconcileModal()"><i class="fa-solid fa-columns"></i> Đối chiếu 2 cột (PDF ↔ Soft-copy)</button>`);
    if (doc) {
      btns.push(`<button type="button" class="btn btn-outline btn-sm" style="padding:3px 9px; font-size:0.74rem; color:#15803d; border-color:#86efac; background:#fff; font-weight:600;" onclick="jumpToMilestoneDetailTarget('preview', ${doc.id}, '${escapeHtml(doc.title || 'Dự toán phê duyệt (Mộc đỏ)')}')"><i class="fa-solid fa-file-pdf"></i> Xem bản mộc đỏ</button>`);
    } else if (perms.canEditBudget) {
      btns.push(`<button type="button" class="btn btn-primary btn-sm" style="padding:3px 9px; font-size:0.74rem;" onclick="openUploadModalForCriteria('DU_TOAN_DA_DUYET', 3, 'Bản Dự toán kinh phí đã phê duyệt (Có dấu mộc đỏ)')"><i class="fa-solid fa-upload"></i> Tải lên Dự toán mộc đỏ (PDF)</button>`);
    }
    if (!isLocked && canLockBudget) {
      btns.push(`<button type="button" class="btn btn-success btn-sm" style="padding:3px 10px; font-size:0.74rem;" onclick="handleLockBudgetBaseline(${doc ? doc.id : 'null'})" ${!doc ? 'title="Cần tải lên bản scan Dự toán mộc đỏ trước khi chốt khóa"' : ''}><i class="fa-solid fa-shield-halved"></i> Chốt &amp; Khóa dự toán gốc</button>`);
    } else if (isLocked && canUnlockBudget) {
      btns.push(`<button type="button" class="btn btn-outline btn-sm" style="padding:3px 9px; font-size:0.73rem; color:#b45309; border-color:#fcd34d; background:#fff;" onclick="handleUnlockBudgetBaseline()"><i class="fa-solid fa-unlock"></i> Mở khóa hiệu đính</button>`);
    }

    legalBar.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:4px;">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <strong style="font-size:0.82rem; color:#0f172a;">Căn cứ pháp lý Dự toán (Mộc đỏ Viện trưởng):</strong>
          ${statusBadgeHtml}
        </div>
        <div>${docInfoHtml}</div>
      </div>
      <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
        ${btns.join('')}
      </div>
    `;
  }

  if (!analytics || !analytics.summary) return;
  const s = analytics.summary;

  const effEl = document.getElementById('kpiEffectiveBudget');
  const subEl = document.getElementById('kpiBudgetSubnote');
  if (effEl) effEl.innerText = Number(s.effective_budget || 0).toLocaleString('vi-VN') + ' đ';
  if (subEl) {
    subEl.innerText = s.revised_budget && s.revised_budget !== s.base_budget
      ? `Đã điều chỉnh (Gốc: ${Number(s.base_budget).toLocaleString('vi-VN')} đ) • ${s.total_budget_items} hạng mục`
      : `${s.total_budget_items} hạng mục chi tiết (Tổng chi tiết: ${Number(s.budget_items_total || 0).toLocaleString('vi-VN')} đ)`;
  }

  const comEl = document.getElementById('kpiCommittedAmount');
  const comSub = document.getElementById('kpiCommittedSubnote');
  if (comEl) comEl.innerText = Number(s.committed_amount || 0).toLocaleString('vi-VN') + ' đ';
  if (comSub) comSub.innerText = `${s.committed_pct || 0}% dự toán • ${s.total_supplies || 0} dòng đề xuất`;

  const disbEl = document.getElementById('kpiActualDisbursed');
  const disbSub = document.getElementById('kpiDisbursedSubnote');
  if (disbEl) disbEl.innerText = Number(s.actual_disbursed || 0).toLocaleString('vi-VN') + ' đ';
  if (disbSub) disbSub.innerText = `${s.disbursement_pct || 0}% dự toán • ${s.fully_fulfilled || 0}/${s.total_supplies || 0} dòng nhận đủ`;

  const remEl = document.getElementById('kpiRemainingBudget');
  const riskSub = document.getElementById('kpiRiskCountSubnote');
  if (remEl) {
    remEl.innerText = Number(s.remaining_budget || 0).toLocaleString('vi-VN') + ' đ';
    remEl.style.color = s.remaining_budget < 0 ? '#dc2626' : '#b45309';
  }
  if (riskSub) {
    const riskTotal = (s.over_budget_count || 0) + (s.outside_budget_count || 0);
    riskSub.innerHTML = riskTotal > 0
      ? `<span style="color:#dc2626; font-weight:700;">${s.over_budget_count || 0} vượt định mức • ${s.outside_budget_count || 0} ngoài DT</span>`
      : `<span style="color:#15803d;">Không có dòng vượt/ngoài dự toán</span>`;
  }

  // Thanh tiến độ so sánh
  const tPct = Math.min(100, Math.max(0, Number(s.time_elapsed_pct) || 0));
  const dPct = Math.max(0, Number(s.disbursement_pct) || 0);
  const sPct = Math.min(100, Math.max(0, Number(s.supply_progress_pct) || 0));

  const barTimeText = document.getElementById('barTimeElapsedText');
  const barTimeFill = document.getElementById('barTimeElapsedFill');
  if (barTimeText) barTimeText.innerText = `${tPct}%`;
  if (barTimeFill) barTimeFill.style.width = `${tPct}%`;

  const barDisbText = document.getElementById('barDisbursementText');
  const barDisbFill = document.getElementById('barDisbursementFill');
  if (barDisbText) {
    barDisbText.innerText = `${dPct}%`;
    barDisbText.style.color = dPct > 100 ? '#dc2626' : '#15803d';
  }
  if (barDisbFill) {
    barDisbFill.style.width = `${Math.min(100, dPct)}%`;
    barDisbFill.style.background = dPct > 100 ? '#dc2626' : (dPct >= 85 ? '#d97706' : '#16a34a');
  }

  const barSupText = document.getElementById('barSupplyProgressText');
  const barSupFill = document.getElementById('barSupplyProgressFill');
  if (barSupText) barSupText.innerText = `${sPct}%`;
  if (barSupFill) barSupFill.style.width = `${sPct}%`;

  // Cảnh báo tự động
  const alertBox = document.getElementById('budgetAlertsContainer');
  if (alertBox) {
    const alerts = analytics.alerts || [];
    if (alerts.length === 0) {
      alertBox.innerHTML = `
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-left: 4px solid #16a34a; border-radius: 6px; padding: 7px 12px; font-size: 0.78rem; color: #166534;">
          <i class="fa-solid fa-circle-check" style="margin-right: 6px;"></i>
          Tình trạng dự toán và cấp phát vật tư đang nằm trong ngưỡng kiểm soát an toàn.
        </div>
      `;
    } else {
      alertBox.innerHTML = alerts.map(a => {
        const isRed = a.level === 'RED';
        const isYellow = a.level === 'YELLOW';
        const bg = isRed ? '#fef2f2' : (isYellow ? '#fffbeb' : '#eff6ff');
        const border = isRed ? '#fca5a5' : (isYellow ? '#fde68a' : '#bfdbfe');
        const left = isRed ? '#dc2626' : (isYellow ? '#d97706' : '#0284c7');
        const color = isRed ? '#991b1b' : (isYellow ? '#92400e' : '#1e40af');
        const icon = isRed ? 'fa-triangle-exclamation' : (isYellow ? 'fa-circle-exclamation' : 'fa-circle-info');
        return `
          <div style="background: ${bg}; border: 1px solid ${border}; border-left: 4px solid ${left}; border-radius: 6px; padding: 7px 12px; font-size: 0.78rem; color: ${color};">
            <i class="fa-solid ${icon}" style="margin-right: 6px;"></i>${escapeHtml(a.message)}
          </div>
        `;
      }).join('');
    }
  }
}

// 7. Render Dự toán đã duyệt (Kèm Trừ lùi Hạn mức / Quota)
function renderBudgetItems(budgetItems) {
  const tbody = document.getElementById('budgetTableBody');
  const tfoot = document.getElementById('budgetTableFoot');
  const dropdown = document.getElementById('budgetSelectDropdown');
  const perms = getSuppliesRolePermissions();

  if (dropdown) {
    dropdown.innerHTML = '<option value="">-- Hạng mục ngoài dự toán / Nhập thủ công --</option>';
  }

  if (!budgetItems || budgetItems.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="12" style="text-align: center; padding: 1.5rem; color: var(--text-muted);">
          Chưa có danh mục dự toán chi tiết. Hãy bấm <strong>Import Excel (BM02)</strong> hoặc <strong>+ Thêm hạng mục dự toán</strong> để thiết lập hạn mức (Quota).
        </td>
      </tr>
    `;
    if (tfoot) tfoot.innerHTML = '';
    return;
  }

  let sumBudgetTotal = 0;
  let sumActualSpent = 0;

  tbody.innerHTML = budgetItems.map((item, idx) => {
    const approvedQty = Number(item.approved_quantity) || 0;
    const reqQty = Number(item.total_requested_qty) || 0;
    const recQty = Number(item.total_received_qty) || 0;
    const remQuota = item.remaining_quota_qty !== undefined ? Number(item.remaining_quota_qty) : Number((approvedQty - reqQty).toFixed(2));
    const fulfillPct = item.fulfillment_pct !== undefined ? Number(item.fulfillment_pct) : (approvedQty > 0 ? Math.round((recQty / approvedQty) * 100) : 0);
    const totalPrice = Number(item.total_price) || 0;
    const actualSpent = Number(item.actual_spent) || 0;

    sumBudgetTotal += totalPrice;
    sumActualSpent += actualSpent;

    if (dropdown) {
      dropdown.innerHTML += `<option value="${item.id}" data-name="${escapeHtml(item.item_name)}" data-spec="${escapeHtml(item.specification || '')}" data-unit="${escapeHtml(item.unit || '')}" data-approved="${approvedQty}" data-requested="${reqQty}" data-remaining="${remQuota}" data-price="${Number(item.unit_price || 0)}">${escapeHtml(item.item_name)} — Duyệt: ${approvedQty} ${escapeHtml(item.unit || '')} | Còn lại: ${remQuota}</option>`;
    }

    let quotaBadge = `<span class="badge badge-green" style="font-size:0.72rem;">${remQuota}</span>`;
    if (remQuota < 0 || item.quota_status === 'OVER_QUOTA') {
      quotaBadge = `<span class="badge badge-red" style="font-size:0.72rem;" title="Vượt hạn mức dự toán!">Vượt ${Math.abs(remQuota)}</span>`;
    } else if (remQuota === 0 && approvedQty > 0) {
      quotaBadge = `<span class="badge badge-gray" style="font-size:0.72rem;">Hết (0)</span>`;
    } else if (item.quota_status === 'NEAR_LIMIT') {
      quotaBadge = `<span class="badge badge-yellow" style="font-size:0.72rem;">Còn ${remQuota}</span>`;
    }

    const barColor = item.quota_status === 'OVER_QUOTA' ? '#dc2626' : (fulfillPct >= 100 ? '#16a34a' : '#0284c7');
    const origHint = (item.original_quantity !== null && item.original_quantity !== undefined && Number(item.original_quantity) !== approvedQty)
      ? `<div style="font-size:0.68rem; color:#7e22ce;">(Gốc: ${item.original_quantity})</div>` : '';

    const isBudgetLocked = Boolean(currentProjectData && currentProjectData.budget_analytics && currentProjectData.budget_analytics.legal_status && currentProjectData.budget_analytics.legal_status.is_locked);
    const actionHtml = isBudgetLocked
      ? `<span style="color:#15803d; font-size:0.7rem; font-weight:600;" title="Dự toán đã chốt khóa theo bản mộc đỏ. Mọi thay đổi thực hiện qua Điều chỉnh dự toán."><i class="fa-solid fa-lock"></i> Đã khóa</span>`
      : (perms.canEditBudget ? `
      <div style="display:flex; gap:4px; justify-content:center;">
        <button type="button" class="btn btn-outline btn-sm" style="padding:2px 6px; font-size:0.72rem;" onclick="openAddBudgetModal(${item.id})" title="Sửa hạng mục">
          <i class="fa-solid fa-pen"></i>
        </button>
        ${perms.canDeleteBudget ? `
          <button type="button" class="btn btn-outline btn-sm" style="padding:2px 6px; font-size:0.72rem; color:#dc2626; border-color:#fca5a5;" onclick="deleteBudgetItem(${item.id}, '${escapeHtml(item.item_name)}')" title="Xóa hạng mục">
            <i class="fa-solid fa-trash"></i>
          </button>
        ` : ''}
      </div>
    ` : '<span style="color:#94a3b8; font-size:0.72rem;">--</span>');

    return `
      <tr style="${item.quota_status === 'OVER_QUOTA' ? 'background:#fef2f2;' : ''}">
        <td style="text-align: center; color: var(--text-muted);">${idx + 1}</td>
        <td>
          <div style="font-weight: 600; color: #0f172a;">${escapeHtml(item.item_name)}</div>
          ${item.category ? `<div style="font-size: 0.7rem; color: #64748b;">${escapeHtml(item.category)}</div>` : ''}
          ${item.notes ? `<div style="font-size: 0.7rem; color: #0369a1;">${escapeHtml(item.notes)}</div>` : ''}
        </td>
        <td style="font-size: 0.8rem;">${escapeHtml(item.specification || '-')}</td>
        <td style="font-size: 0.8rem;">${escapeHtml(item.unit || '-')}</td>
        <td style="font-weight: 700; color: var(--primary); text-align: center;">${approvedQty}${origHint}</td>
        <td style="text-align: center; font-weight: 600; color: #0284c7;">${reqQty}</td>
        <td style="text-align: center;">
          <div style="font-weight: 700; color: #15803d;">${recQty}</div>
          <div style="height: 4px; background: #e2e8f0; border-radius: 4px; margin-top: 3px; overflow: hidden;">
            <div style="height: 100%; width: ${Math.min(100, fulfillPct)}%; background: ${barColor};"></div>
          </div>
          <div style="font-size: 0.67rem; color: #64748b;">${fulfillPct}%</div>
        </td>
        <td style="text-align: center;">${quotaBadge}</td>
        <td style="text-align: right; font-size: 0.8rem;">${Number(item.unit_price || 0).toLocaleString('vi-VN')} đ</td>
        <td style="text-align: right; font-weight: 600; font-size: 0.82rem;">${totalPrice.toLocaleString('vi-VN')} đ</td>
        <td style="text-align: right; font-weight: 700; font-size: 0.82rem; color: ${actualSpent > totalPrice && totalPrice > 0 ? '#dc2626' : '#15803d'};">${actualSpent.toLocaleString('vi-VN')} đ</td>
        <td style="text-align: center;">${actionHtml}</td>
      </tr>
    `;
  }).join('');

  if (tfoot) {
    tfoot.innerHTML = `
      <tr style="background: #f8fafc; font-weight: 700; border-top: 2px solid #cbd5e1;">
        <td colspan="9" style="text-align: right; color: #0f172a; padding: 10px;">TỔNG CỘNG DANH MỤC DỰ TOÁN CHI TIẾT:</td>
        <td style="text-align: right; color: #0f172a;">${sumBudgetTotal.toLocaleString('vi-VN')} đ</td>
        <td style="text-align: right; color: #15803d;">${sumActualSpent.toLocaleString('vi-VN')} đ</td>
        <td></td>
      </tr>
    `;
  }
}

function applySuppliesQuickFilter() {
  if (!currentProjectData) return;
  renderSuppliesChecklist(currentProjectData.supplies || []);
}

// 8. Render Bảng Theo dõi Cấp phát Hóa chất / Vật tư (Chuẩn RBAC + Giá thực chi + Duyệt KH&CN)
function renderSuppliesChecklist(supplies) {
  const tbody = document.getElementById('suppliesTableBody');
  const perms = getSuppliesRolePermissions();
  const filterVal = (document.getElementById('suppliesQuickFilter') || {}).value || 'ALL';

  let filtered = supplies || [];
  if (filterVal === 'OVER_OR_OUTSIDE') {
    filtered = filtered.filter(s => s.budget_check_status === 'Vượt định mức' || s.budget_check_status === 'Ngoài dự toán' || Number(s.over_budget_qty) > 0);
  } else if (filterVal === 'PENDING_KHCN') {
    filtered = filtered.filter(s => ['PENDING', 'FLAGGED'].includes(s.khcn_approval_status || 'PENDING'));
  } else if (filterVal === 'UNFULFILLED') {
    filtered = filtered.filter(s => s.fulfillment_status !== 'Đã nhận đủ');
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="13" style="text-align: center; padding: 1.5rem; color: var(--text-muted);">
          ${(supplies && supplies.length > 0) ? 'Không có dòng cấp phát nào khớp bộ lọc.' : 'Chưa phát sinh đề xuất cấp phát vật tư.'}
        </td>
      </tr>
    `;
    return;
  }

  const budgetItems = (currentProjectData && currentProjectData.budget_items) ? currentProjectData.budget_items : [];

  tbody.innerHTML = filtered.map((s, idx) => {
    const isFull = s.fulfillment_status === 'Đã nhận đủ';
    const checkStatus = s.budget_check_status || 'Ngoài dự toán';
    const isOver = checkStatus === 'Vượt định mức' || Number(s.over_budget_qty) > 0;
    const isOutside = checkStatus === 'Ngoài dự toán';
    const khcnStatus = s.khcn_approval_status || 'PENDING';

    let budgetBadge = `<span class="badge badge-green" style="font-size:0.71rem;">Trong dự toán</span>`;
    if (isOver) {
      budgetBadge = `<span class="badge badge-red" style="font-size:0.71rem;">Vượt định mức${Number(s.over_budget_qty) > 0 ? ` (+${s.over_budget_qty})` : ''}</span>`;
    } else if (isOutside) {
      budgetBadge = `<span class="badge badge-yellow" style="font-size:0.71rem;">Ngoài dự toán</span>`;
    }

    const rowBg = isOver ? 'background:#fef2f2;' : (khcnStatus === 'REJECTED' ? 'background:#f8fafc; opacity:0.65;' : '');
    const disWarehouse = perms.canWarehouseUpdate ? '' : 'disabled';
    const disKhcn = perms.canKhcnApprove ? '' : 'disabled';
    const disPrice = perms.canFinancePrice ? '' : 'disabled';

    const refPrice = Number(s.unit_price) || 0;
    const actPrice = Number(s.actual_unit_price) || 0;
    const actTotal = Number(s.actual_total_cost) || 0;

    // Relink dropdown cho P. KHCN / TC-CU đối với các dòng cũ chưa liên kết dự toán
    const relinkHtml = (perms.canWarehouseUpdate && !s.budget_item_id && budgetItems.length > 0) ? `
      <select id="linkBudget-${s.id}" style="margin-top:4px; width:100%; font-size:0.7rem; padding:2px 4px; border:1px dashed #94a3b8; border-radius:4px;" title="Gán vào hạng mục dự toán">
        <option value="">-- Gán mục DT --</option>
        ${budgetItems.map(b => `<option value="${b.id}">${escapeHtml(b.item_name)} (${b.approved_quantity})</option>`).join('')}
      </select>
    ` : '';

    // Nút xác nhận nhận hàng của Chủ nhiệm
    const piConfirmHtml = s.pi_confirmed_received
      ? `<div style="margin-top:4px; font-size:0.7rem; color:#15803d; font-weight:700;"><i class="fa-solid fa-check-double"></i> CNĐT đã xác nhận</div>`
      : (perms.canPiConfirm && Number(s.received_quantity) > 0
        ? `<button type="button" class="btn btn-outline btn-sm" style="margin-top:4px; padding:2px 6px; font-size:0.69rem; color:#15803d; border-color:#86efac; background:#f0fdf4;" onclick="confirmPiSupplyReceived(${s.id}, true)">Xác nhận đã nhận</button>`
        : '');

    const canSaveRow = perms.canWarehouseUpdate || perms.canKhcnApprove;
    const canDeleteRow = (perms.canRequestSupply && Number(s.received_quantity || 0) === 0) || perms.role === 'SUPER_ADMIN';

    return `
      <tr id="supply-row-${s.id}" style="${rowBg}">
        <td style="color: var(--text-muted); font-size: 0.78rem; text-align: center;">${idx + 1}</td>
        <td>
          <div style="font-weight: 600; color: #0f172a; font-size: 0.82rem;">${escapeHtml(s.item_name)}</div>
          <div style="font-size: 0.72rem; color: var(--text-muted);">
            ${escapeHtml(s.specification || '')}${s.unit ? ` • ĐVT: ${escapeHtml(s.unit)}` : ''} • ${s.request_date || '-'}
          </div>
          ${relinkHtml}
        </td>
        <td style="font-weight: 700; text-align: center; color: #0284c7;">${s.requested_quantity}</td>

        <!-- Đối chiếu dự toán -->
        <td>
          ${budgetBadge}
          ${s.quota_quantity !== null && s.quota_quantity !== undefined ? `<div style="font-size:0.69rem; color:#475569; margin-top:2px;">Định mức: <strong>${s.quota_quantity}</strong></div>` : ''}
        </td>

        <!-- Duyệt P. KH&CN -->
        <td>
          <select class="filter-select" id="khcnApp-${s.id}" ${disKhcn} style="font-size: 0.75rem; padding: 3px 5px; width: 100%;">
            <option value="PENDING" ${khcnStatus === 'PENDING' ? 'selected' : ''}>Chờ duyệt</option>
            <option value="APPROVED" ${khcnStatus === 'APPROVED' ? 'selected' : ''}>Đã duyệt</option>
            <option value="FLAGGED" ${khcnStatus === 'FLAGGED' ? 'selected' : ''}>Cần giải trình</option>
            <option value="REJECTED" ${khcnStatus === 'REJECTED' ? 'selected' : ''}>Từ chối</option>
          </select>
          ${s.khcn_approved_by ? `<div style="font-size:0.66rem; color:#64748b; margin-top:2px;">${escapeHtml(s.khcn_approved_by)}</div>` : ''}
        </td>

        <!-- Tình trạng kho -->
        <td>
          <select class="filter-select" id="stock-${s.id}" ${disWarehouse} style="font-size: 0.76rem; padding: 3px 5px; width: 100%;">
            <option value="Chưa kiểm kho" ${s.stock_status === 'Chưa kiểm kho' ? 'selected' : ''}>Chưa kiểm kho</option>
            <option value="Trong kho" ${s.stock_status === 'Trong kho' ? 'selected' : ''}>Trong kho</option>
            <option value="Cần mua" ${s.stock_status === 'Cần mua' ? 'selected' : ''}>Cần mua</option>
            <option value="Mua ngoài" ${s.stock_status === 'Mua ngoài' ? 'selected' : ''}>Mua ngoài</option>
            <option value="Thầy Phúc duyệt" ${s.stock_status === 'Thầy Phúc duyệt' ? 'selected' : ''}>Thầy Phúc duyệt</option>
          </select>
        </td>

        <!-- SL Đã cấp -->
        <td>
          <input type="number" class="form-control" id="recQty-${s.id}" ${disWarehouse} value="${s.received_quantity || 0}" min="0" step="any" style="width: 72px; font-size: 0.78rem; padding: 4px;" oninput="updateRemaining(${s.id}, ${s.requested_quantity}, ${refPrice})">
        </td>

        <!-- SL Còn thiếu -->
        <td style="text-align: center; font-weight: 700; color: #dc2626;" id="remQty-${s.id}">
          ${s.remaining_quantity !== null && s.remaining_quantity !== undefined ? s.remaining_quantity : Math.max(0, s.requested_quantity - (s.received_quantity || 0))}
        </td>

        <!-- Đơn giá thực tế & Thực chi -->
        <td>
          <input type="number" class="form-control" id="actPrice-${s.id}" ${disPrice} value="${actPrice || refPrice || 0}" min="0" placeholder="Đơn giá thực..." style="width: 115px; font-size: 0.76rem; padding: 3px 6px;" oninput="updateRemaining(${s.id}, ${s.requested_quantity}, ${refPrice})">
          <div style="font-size: 0.71rem; color: #15803d; font-weight: 700; margin-top: 3px;" id="actTotal-${s.id}">
            Thực chi: ${actTotal.toLocaleString('vi-VN')} đ
          </div>
          ${refPrice > 0 ? `<div style="font-size: 0.66rem; color: #64748b;">Giá DT: ${refPrice.toLocaleString('vi-VN')} đ</div>` : ''}
        </td>

        <!-- Trạng thái nhận -->
        <td>
          <select class="filter-select" id="ful-${s.id}" ${disWarehouse} style="font-size: 0.76rem; padding: 3px 5px; width: 100%;">
            <option value="Đã nhận đủ" ${isFull ? 'selected' : ''}>Đã nhận đủ</option>
            <option value="Chưa nhận đủ" ${s.fulfillment_status === 'Chưa nhận đủ' ? 'selected' : ''}>Chưa nhận đủ</option>
            <option value="Chưa cấp" ${s.fulfillment_status === 'Chưa cấp' ? 'selected' : ''}>Chưa cấp</option>
          </select>
          ${piConfirmHtml}
        </td>

        <!-- Mã chứng từ MISA -->
        <td>
          <input type="text" class="form-control" id="misa-${s.id}" ${disWarehouse} value="${escapeHtml(s.misa_order_id || '')}" placeholder="Mã MISA..." style="font-size: 0.76rem; padding: 3px 6px;">
        </td>

        <!-- Ghi chú -->
        <td>
          <input type="text" class="form-control" id="notes-${s.id}" ${canSaveRow ? '' : 'disabled'} value="${escapeHtml(s.notes || '')}" placeholder="Ghi chú..." style="font-size: 0.76rem; padding: 3px 6px;">
        </td>

        <!-- Nút Lưu / Xóa -->
        <td style="text-align: center;">
          <div style="display:flex; gap:4px; justify-content:center;">
            ${canSaveRow ? `
              <button class="btn btn-success btn-sm" onclick="saveSupplyRow(${s.id})" style="padding: 4px 9px; font-size: 0.74rem;">
                Lưu
              </button>
            ` : '<span style="font-size:0.7rem; color:#94a3b8;">Chỉ xem</span>'}
            ${canDeleteRow ? `
              <button class="btn btn-outline btn-sm" onclick="deleteSupplyRow(${s.id}, '${escapeHtml(s.item_name)}')" style="padding: 4px 6px; font-size: 0.72rem; color: #dc2626; border-color: #fca5a5;" title="Xóa đề xuất">
                <i class="fa-solid fa-trash"></i>
              </button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Tự động tính số lượng còn thiếu & Thành tiền thực chi khi nhập SL Đã cấp / Đơn giá thực tế
function updateRemaining(id, requestedQty, refPrice = 0) {
  const recInput = document.getElementById(`recQty-${id}`);
  const remEl = document.getElementById(`remQty-${id}`);
  const fulSelect = document.getElementById(`ful-${id}`);
  const priceInput = document.getElementById(`actPrice-${id}`);
  const totalEl = document.getElementById(`actTotal-${id}`);

  const rec = Number(recInput ? recInput.value : 0) || 0;
  const rem = Math.max(0, Number((requestedQty - rec).toFixed(2)));
  if (remEl) remEl.innerText = rem;

  if (fulSelect) {
    if (rec >= requestedQty) fulSelect.value = 'Đã nhận đủ';
    else if (rec > 0) fulSelect.value = 'Chưa nhận đủ';
    else fulSelect.value = 'Chưa cấp';
  }

  const unitPrice = priceInput ? (Number(priceInput.value) || 0) : (Number(refPrice) || 0);
  const totalCost = Math.round(rec * unitPrice);
  if (totalEl) totalEl.innerText = `Thực chi: ${totalCost.toLocaleString('vi-VN')} đ`;
}

// Lưu 1 dòng checklist cấp phát (tự động cập nhật lại bảng KPI & Quota)
async function saveSupplyRow(id) {
  const stock = document.getElementById(`stock-${id}`)?.value;
  const recQty = Number(document.getElementById(`recQty-${id}`)?.value) || 0;
  const remQty = Number(document.getElementById(`remQty-${id}`)?.innerText) || 0;
  const ful = document.getElementById(`ful-${id}`)?.value;
  const misa = document.getElementById(`misa-${id}`)?.value;
  const notes = document.getElementById(`notes-${id}`)?.value;
  const khcnApp = document.getElementById(`khcnApp-${id}`)?.value;
  const actPrice = Number(document.getElementById(`actPrice-${id}`)?.value) || 0;
  const linkSelect = document.getElementById(`linkBudget-${id}`);

  const payload = {
    stock_status: stock,
    received_quantity: recQty,
    remaining_quantity: remQty,
    fulfillment_status: ful,
    misa_order_id: misa,
    notes: notes,
    khcn_approval_status: khcnApp,
    actual_unit_price: actPrice,
    actual_total_cost: Math.round(recQty * actPrice)
  };
  if (linkSelect && linkSelect.value) {
    payload.budget_item_id = Number(linkSelect.value);
  }

  try {
    const res = await fetch(`/api/supplies/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (json.success) {
      showToast('Đã lưu cập nhật cấp phát & đối chiếu dự toán!', 'success');
      loadProject();
    } else {
      showToast(json.error || 'Lỗi khi lưu', 'error');
    }
  } catch (err) {
    showToast('Lỗi mạng: ' + err.message, 'error');
  }
}

async function confirmPiSupplyReceived(id, confirmed) {
  try {
    const res = await fetch(`/api/supplies/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_mode: 'PI_CONFIRM', pi_confirmed_received: confirmed })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message || 'Đã xác nhận nhận hàng!', 'success');
      loadProject();
    } else {
      showToast(json.error || 'Lỗi xác nhận', 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

async function deleteSupplyRow(id, name) {
  if (!confirm(`Bạn có chắc chắn muốn xóa dòng đề xuất "${name}"?`)) return;
  try {
    const res = await fetch(`/api/supplies/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      showToast('Đã xóa dòng đề xuất vật tư', 'success');
      loadProject();
    } else {
      showToast(json.error || 'Không thể xóa', 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

// ==========================================
// CÁC THAO TÁC MODAL & SUBMIT
// ==========================================

// =========================================================================
// QUY TRÌNH GIA HẠN THỜI GIAN THỰC HIỆN (3 BƯỚC PHÁP LÝ THEO VAI TRÒ)
// =========================================================================
function addSixMonthsPreviewVN(dateStr) {
  if (!dateStr) return '--';
  const parts = String(dateStr).trim().split(/[\/\-]/);
  let d = null;
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    } else {
      d = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
    }
  }
  if (!d || isNaN(d.getTime())) return '--';
  d.setMonth(d.getMonth() + 6);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function openExtendModal(editExtId = null) {
  const form = document.getElementById('extendForm');
  if (form) form.reset();

  const extensions = (currentProjectData && currentProjectData.extensions) ? currentProjectData.extensions : [];
  const approvedCount = extensions.filter(e => e.status === 'APPROVED').length;
  const editingExt = editExtId
    ? extensions.find(e => Number(e.id) === Number(editExtId))
    : extensions.find(e => e.status === 'PENDING' || e.status === 'REVISION_NEEDED');

  const extNum = editingExt ? (editingExt.extension_num || 1) : (approvedCount + 1);
  const curEndVN = editingExt
    ? (editingExt.previous_end_date_vn || editingExt.previous_end_date)
    : (currentProjectData.current_end_date_vn || currentProjectData.base_end_date_vn || '--');
  const propEndVN = editingExt
    ? (editingExt.new_end_date_vn || editingExt.new_end_date)
    : addSixMonthsPreviewVN(curEndVN);

  document.getElementById('modalEditExtId').value = editingExt ? editingExt.id : '';
  document.getElementById('modalExtNumHidden').value = extNum;
  document.getElementById('modalExtNumberText').value = `Gia hạn Lần ${extNum} (+06 tháng)`;

  const propEl = document.getElementById('modalExtProposedDateText');
  if (propEl) {
    propEl.value = `Hạn hiện tại: ${curEndVN} ➔ Hạn đề xuất mới: ${propEndVN} (Chờ phê duyệt)`;
  }

  const todayISO = new Date().toISOString().slice(0, 10);
  const reqDateEl = document.getElementById('modalExtRequestDate');
  if (reqDateEl) {
    reqDateEl.value = (editingExt && editingExt.request_date && editingExt.request_date.includes('-'))
      ? editingExt.request_date.slice(0, 10)
      : todayISO;
  }

  const reasonEl = document.getElementById('modalExtReasonInput');
  if (reasonEl) {
    reasonEl.value = editingExt ? (editingExt.reason || '') : '';
  }

  const titleEl = document.getElementById('extendModalTitle');
  const submitBtn = document.getElementById('btnSubmitExtendForm');
  if (titleEl) {
    titleEl.innerText = editingExt
      ? `Cập nhật Đề xuất Gia hạn Lần ${extNum} (06 tháng)`
      : `Lập Đề xuất Gia hạn Thời gian Thực hiện (06 tháng)`;
  }
  if (submitBtn) {
    submitBtn.innerText = editingExt ? 'Lưu cập nhật đề xuất' : 'Lưu đề xuất gia hạn';
  }

  document.getElementById('extendModal').classList.add('active');
}

async function handleExtendProject(e) {
  e.preventDefault();
  const editExtId = document.getElementById('modalEditExtId').value;
  const extNum = Number(document.getElementById('modalExtNumHidden').value) || 1;
  const reason = document.getElementById('modalExtReasonInput').value;
  const requestDate = document.getElementById('modalExtRequestDate').value;
  const fileInput = document.getElementById('modalExtSignedRequestFile');

  try {
    // 1. Nếu người dùng có đính kèm sẵn bản scan Đơn đề nghị gia hạn đã ký, tải lên Giai đoạn 6 trước
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      const fileObj = fileInput.files[0];
      const reqDocKey = `DON_GIA_HAN_${extNum}`;
      const upForm = new FormData();
      upForm.append('file', fileObj);
      upForm.append('stage', '6');
      upForm.append('doc_type', reqDocKey);
      upForm.append('title', `Đơn đề nghị gia hạn Lần ${extNum} (06 tháng) - Đề tài ${currentProjectData ? currentProjectData.code : ''}`);
      upForm.append('notes', reason);
      upForm.append('uploaded_by', getCurrentRoleLabelVn());

      const upRes = await fetch(`/api/documents/upload/${currentProjectId}`, {
        method: 'POST',
        body: upForm
      });
      const upJson = await upRes.json();
      if (!upJson.success) {
        showToast(upJson.error || 'Lỗi khi tải tệp Đơn đề nghị gia hạn lên hệ thống', 'error');
        return;
      }
    }

    // 2. Tạo mới hoặc cập nhật bản ghi đề xuất gia hạn (trạng thái PENDING, chưa đổi hạn đề tài)
    let res;
    if (editExtId) {
      res = await fetch(`/api/extensions/item/${editExtId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action_type: 'UPDATE_REQUEST',
          reason,
          request_date: requestDate
        })
      });
    } else {
      res = await fetch(`/api/extensions/${currentProjectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason,
          request_date: requestDate
        })
      });
    }

    const json = await res.json();
    if (json.success) {
      showToast(json.message, 'success');
      closeModal('extendModal');
      loadProject();
    } else {
      showToast(json.error || 'Không thể lưu đề xuất gia hạn', 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

async function handleCancelExtensionRequest(extId, extNum) {
  const confirmed = window.confirm(
    `Bạn có chắc chắn muốn HỦY Đề xuất xin gia hạn Lần ${extNum} đang trình?\n\nHệ thống sẽ xóa đề xuất này và giữ nguyên thời hạn hoàn thành hiện tại của đề tài.`
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/extensions/item/${extId}`, {
      method: 'DELETE'
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message || 'Đã hủy đề xuất gia hạn.', 'success');
      loadProject();
    } else {
      showToast(json.error || 'Không thể hủy đề xuất', 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

// Mở hộp thoại Xử lý & Cập nhật Kết quả Phê duyệt Gia hạn (Dành cho Phòng KH&CN / Viện trưởng)
function openKhcnProcessExtensionModal(extId) {
  const extensions = (currentProjectData && currentProjectData.extensions) ? currentProjectData.extensions : [];
  const ext = extensions.find(e => Number(e.id) === Number(extId));
  if (!ext) {
    showToast('Không tìm thấy hồ sơ đề xuất gia hạn.', 'error');
    return;
  }

  const form = document.getElementById('khcnProcessExtensionForm');
  if (form) form.reset();

  const extNum = ext.extension_num || 1;
  document.getElementById('khcnExtIdInput').value = ext.id;
  document.getElementById('khcnExtNumInput').value = extNum;

  const allDocs = (currentProjectData && currentProjectData.documents) ? currentProjectData.documents : [];
  const reqDocKey = `DON_GIA_HAN_${extNum}`;
  const decDocKey = `QD_GIA_HAN_${extNum}`;
  const reqDocObj = ext.request_file_id
    ? allDocs.find(d => Number(d.id) === Number(ext.request_file_id))
    : allDocs.find(d => d.doc_type === reqDocKey);
  const decDocObj = ext.decision_file_id
    ? allDocs.find(d => Number(d.id) === Number(ext.decision_file_id))
    : allDocs.find(d => d.doc_type === decDocKey);

  const summaryBox = document.getElementById('khcnExtSummaryBox');
  if (summaryBox) {
    summaryBox.innerHTML = `
      <div><strong>Đợt đề nghị:</strong> Gia hạn Lần ${extNum} (+06 tháng) • <strong>Hạn hiện tại:</strong> ${escapeHtml(ext.previous_end_date_vn || ext.previous_end_date)} ➔ <strong>Hạn đề xuất mới:</strong> <span style="color:#7e22ce; font-weight:700;">${escapeHtml(ext.new_end_date_vn || ext.new_end_date)}</span></div>
      <div style="margin-top:3px;"><strong>Lý do của Chủ nhiệm:</strong> ${escapeHtml(ext.reason || '')}</div>
      <div style="margin-top:3px;"><strong>Tình trạng Đơn xin gia hạn có chữ ký:</strong> ${
        reqDocObj
          ? `<span style="color:#15803d; font-weight:700;">Đã nộp (${escapeHtml(reqDocObj.file_name)})</span>`
          : `<span style="color:#b91c1c; font-weight:700;">Chưa nộp bản scan Đơn có chữ ký</span>`
      }</div>
    `;
  }

  const todayISO = new Date().toISOString().slice(0, 10);
  document.getElementById('khcnExtDecisionNumber').value = ext.decision_number || '';
  document.getElementById('khcnExtDecisionDate').value = (ext.decision_date && ext.decision_date.includes('-'))
    ? ext.decision_date.slice(0, 10)
    : todayISO;
  document.getElementById('khcnExtApproveNote').value = ext.director_opinion || '';

  document.getElementById('khcnExtRejectDate').value = (ext.decision_date && ext.decision_date.includes('-'))
    ? ext.decision_date.slice(0, 10)
    : todayISO;
  document.getElementById('khcnExtRejectDocNum').value = ext.decision_number || '';
  document.getElementById('khcnExtRejectReason').value = ext.status === 'REJECTED' ? (ext.director_opinion || '') : '';

  document.getElementById('khcnExtRevisionNote').value = ext.khcn_notes || '';

  const existingDecNote = document.getElementById('khcnExtExistingDecisionFileNote');
  if (existingDecNote) {
    if (decDocObj) {
      existingDecNote.innerHTML = `Đang có tệp Quyết định trên hệ thống: <strong>${escapeHtml(decDocObj.file_name)}</strong> (${formatFileSize(decDocObj.file_size)}). Chọn tệp mới nếu muốn thay thế.`;
    } else {
      existingDecNote.innerHTML = `<span style="color:#b91c1c;">Chưa có tệp Quyết định gia hạn Lần ${extNum} trên hệ thống. Bắt buộc chọn tệp PDF Quyết định có dấu mộc đỏ để hoàn tất phê duyệt.</span>`;
    }
  }

  const actionSelect = document.getElementById('khcnExtActionTypeSelect');
  if (actionSelect) {
    if (ext.status === 'REJECTED') {
      actionSelect.value = 'REJECTED';
    } else if (ext.status === 'REVISION_NEEDED') {
      actionSelect.value = 'REVISION_NEEDED';
    } else {
      actionSelect.value = 'APPROVED';
    }
    onKhcnExtActionTypeChange(actionSelect.value);
  }

  document.getElementById('khcnProcessExtensionModal').classList.add('active');
}

function onKhcnExtActionTypeChange(actionType) {
  const approvedBox = document.getElementById('khcnExtApprovedFields');
  const rejectedBox = document.getElementById('khcnExtRejectedFields');
  const revisionBox = document.getElementById('khcnExtRevisionFields');
  const submitBtn = document.getElementById('btnSubmitKhcnExtProcess');

  if (approvedBox) approvedBox.style.display = actionType === 'APPROVED' ? 'block' : 'none';
  if (rejectedBox) rejectedBox.style.display = actionType === 'REJECTED' ? 'block' : 'none';
  if (revisionBox) revisionBox.style.display = actionType === 'REVISION_NEEDED' ? 'block' : 'none';

  if (submitBtn) {
    if (actionType === 'APPROVED') {
      submitBtn.innerText = 'Xác nhận Phê duyệt & Cộng 06 tháng';
      submitBtn.className = 'btn btn-primary';
    } else if (actionType === 'REJECTED') {
      submitBtn.innerText = 'Xác nhận Từ chối gia hạn (Giữ hạn cũ)';
      submitBtn.className = 'btn btn-warning';
    } else if (actionType === 'REVISION_NEEDED') {
      submitBtn.innerText = 'Gửi yêu cầu Chủ nhiệm bổ sung';
      submitBtn.className = 'btn btn-primary';
    } else {
      submitBtn.innerText = 'Đưa về trạng thái Đang chờ duyệt';
      submitBtn.className = 'btn btn-outline';
    }
  }
}

async function handleKhcnProcessExtensionSubmit(e) {
  e.preventDefault();
  const extId = document.getElementById('khcnExtIdInput').value;
  const extNum = Number(document.getElementById('khcnExtNumInput').value) || 1;
  const actionType = document.getElementById('khcnExtActionTypeSelect').value;

  try {
    if (actionType === 'APPROVED') {
      const decNumber = document.getElementById('khcnExtDecisionNumber').value.trim();
      const decDate = document.getElementById('khcnExtDecisionDate').value;
      const decNote = document.getElementById('khcnExtApproveNote').value.trim();
      const decFileInput = document.getElementById('khcnExtDecisionFileInput');

      if (!decNumber) {
        showToast('Bắt buộc nhập Số Quyết định cho phép gia hạn do Viện trưởng ký.', 'error');
        return;
      }
      if (!decDate) {
        showToast('Bắt buộc chọn Ngày ký Quyết định gia hạn.', 'error');
        return;
      }

      // Nếu P. KH&CN chọn tệp scan Quyết định gia hạn có dấu mộc đỏ ngay trong modal này -> tải lên Giai đoạn 6
      if (decFileInput && decFileInput.files && decFileInput.files.length > 0) {
        const fileObj = decFileInput.files[0];
        const decDocKey = `QD_GIA_HAN_${extNum}`;
        const upForm = new FormData();
        upForm.append('file', fileObj);
        upForm.append('stage', '6');
        upForm.append('doc_type', decDocKey);
        upForm.append('title', `Quyết định cho phép gia hạn Lần ${extNum} số ${decNumber} - Đề tài ${currentProjectData ? currentProjectData.code : ''}`);
        upForm.append('notes', decNote || `Quyết định gia hạn Lần ${extNum} số ${decNumber} ký ngày ${decDate}`);
        upForm.append('uploaded_by', getCurrentRoleLabelVn());

        const upRes = await fetch(`/api/documents/upload/${currentProjectId}`, {
          method: 'POST',
          body: upForm
        });
        const upJson = await upRes.json();
        if (!upJson.success) {
          showToast(upJson.error || 'Lỗi khi tải tệp Quyết định gia hạn lên hệ thống', 'error');
          return;
        }
      }

      const res = await fetch(`/api/extensions/item/${extId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action_type: 'APPROVED',
          decision_number: decNumber,
          decision_date: decDate,
          director_opinion: decNote || `Đã phê duyệt gia hạn Lần ${extNum} (+06 tháng) theo Quyết định số ${decNumber}.`,
          reviewed_by: getCurrentRoleLabelVn()
        })
      });
      const json = await res.json();
      if (json.success) {
        showToast(json.message, 'success');
        closeModal('khcnProcessExtensionModal');
        loadProject();
      } else {
        showToast(json.error || 'Không thể phê duyệt gia hạn', 'error');
      }
      return;
    }

    if (actionType === 'REJECTED') {
      const rejDate = document.getElementById('khcnExtRejectDate').value;
      const rejDocNum = document.getElementById('khcnExtRejectDocNum').value.trim();
      const rejReason = document.getElementById('khcnExtRejectReason').value.trim();

      if (!rejReason) {
        showToast('Vui lòng nhập Lý do Viện trưởng không phê duyệt và chỉ đạo xử lý tiếp theo.', 'error');
        return;
      }

      const res = await fetch(`/api/extensions/item/${extId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action_type: 'REJECTED',
          decision_number: rejDocNum || null,
          decision_date: rejDate || null,
          director_opinion: rejReason,
          reviewed_by: getCurrentRoleLabelVn()
        })
      });
      const json = await res.json();
      if (json.success) {
        showToast(json.message, 'success');
        closeModal('khcnProcessExtensionModal');
        loadProject();
      } else {
        showToast(json.error || 'Lỗi khi ghi nhận từ chối gia hạn', 'error');
      }
      return;
    }

    if (actionType === 'REVISION_NEEDED') {
      const revNote = document.getElementById('khcnExtRevisionNote').value.trim();
      if (!revNote) {
        showToast('Vui lòng nhập nội dung yêu cầu Chủ nhiệm bổ sung / chỉnh sửa.', 'error');
        return;
      }
      const res = await fetch(`/api/extensions/item/${extId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action_type: 'REVISION_NEEDED',
          khcn_notes: revNote,
          reviewed_by: getCurrentRoleLabelVn()
        })
      });
      const json = await res.json();
      if (json.success) {
        showToast(json.message, 'success');
        closeModal('khcnProcessExtensionModal');
        loadProject();
      } else {
        showToast(json.error || 'Lỗi khi gửi yêu cầu bổ sung', 'error');
      }
      return;
    }

    if (actionType === 'REVERT_TO_PENDING') {
      const res = await fetch(`/api/extensions/item/${extId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action_type: 'REVERT_TO_PENDING',
          reviewed_by: getCurrentRoleLabelVn()
        })
      });
      const json = await res.json();
      if (json.success) {
        showToast(json.message, 'success');
        closeModal('khcnProcessExtensionModal');
        loadProject();
      } else {
        showToast(json.error || 'Lỗi khi khôi phục trạng thái chờ duyệt', 'error');
      }
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

async function handleDeleteExtensionFromModal() {
  const extId = document.getElementById('khcnExtIdInput').value;
  const extNum = document.getElementById('khcnExtNumInput').value || 1;
  if (!extId) return;

  const confirmed = window.confirm(
    `Bạn có chắc chắn muốn XÓA đợt đề xuất gia hạn Lần ${extNum} này?\n\nHệ thống sẽ xóa bản ghi này và tự động tính toán lại hạn hoàn thành của đề tài.`
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/extensions/item/${extId}`, {
      method: 'DELETE'
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message, 'success');
      closeModal('khcnProcessExtensionModal');
      loadProject();
    } else {
      showToast(json.error || 'Không thể xóa bản ghi gia hạn', 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

// Danh mục văn bản con tương ứng với từng Giai đoạn (Điều kiện phụ thuộc Cha -> Con, bao gồm cả văn bản liên thông 2-3 giai đoạn)
const STAGE_DOC_CATALOG = {
  1: [
    { key: 'THUYET_MINH', name: 'Thuyết minh đề tài (đã duyệt)' }
  ],
  2: [
    { key: 'BB_XET_DUYET', name: 'Biên bản Hội đồng xét duyệt đề cương' },
    { key: 'THUYET_MINH', name: 'Thuyết minh đề tài (đã duyệt)' },
    { key: 'QD_GIAO_NHIEM_VU', name: 'Quyết định giao nhiệm vụ KHCN' }
  ],
  3: [
    { key: 'QD_GIAO_NHIEM_VU', name: 'Quyết định giao nhiệm vụ KHCN' },
    { key: 'HOP_DONG_NCKH', name: 'Hợp đồng NCKH cấp cơ sở' },
    { key: 'DU_TOAN_DA_DUYET', name: 'Bản Dự toán kinh phí đã phê duyệt' },
    { key: 'DON_DIEU_CHINH_DU_TOAN', name: 'Tờ trình đề xuất điều chỉnh dự toán kinh phí (nếu có)' },
    { key: 'QD_DIEU_CHINH_DU_TOAN', name: 'Quyết định phê duyệt điều chỉnh dự toán (nếu có)' }
  ],
  4: [
    { key: 'CHUNG_TU_VAT_TU', name: 'Biên bản cấp phát vật tư / Đơn hàng MISA' },
    { key: 'DU_TOAN_DA_DUYET', name: 'Bản Dự toán kinh phí đã phê duyệt' },
    { key: 'DON_DIEU_CHINH_DU_TOAN', name: 'Tờ trình đề xuất điều chỉnh dự toán kinh phí (nếu có)' },
    { key: 'QD_DIEU_CHINH_DU_TOAN', name: 'Quyết định phê duyệt điều chỉnh dự toán (nếu có)' }
  ],
  5: [
    { key: 'BAO_CAO_6_THANG', name: 'Báo cáo tiến độ định kỳ 06 tháng/lần' }
  ],
  6: [
    { key: 'DON_GIA_HAN_1', name: 'Đơn đề nghị gia hạn Lần 1 (06 tháng)' },
    { key: 'QD_GIA_HAN_1', name: 'Quyết định cho phép gia hạn Lần 1' },
    { key: 'DON_GIA_HAN_2', name: 'Đơn đề nghị gia hạn Lần 2 (06 tháng - Lần cuối)' },
    { key: 'QD_GIA_HAN_2', name: 'Quyết định cho phép gia hạn Lần 2 (Lần cuối)' },
    { key: 'BAO_CAO_6_THANG', name: 'Báo cáo tiến độ định kỳ 06 tháng/lần' }
  ],
  7: [
    { key: 'BAO_CAO_TONG_KET', name: 'Báo cáo tổng kết đề tài & Tóm tắt' },
    { key: 'SAN_PHAM_KHCN', name: 'Minh chứng sản phẩm KHCN (Bài báo / Quy trình / Sáng chế)' },
    { key: 'BB_NGHIEM_THU', name: 'Biên bản Hội đồng đánh giá nghiệm thu' },
    { key: 'GIAI_TRINH_SAU_HOP', name: 'Bản giải trình tiếp thu sau nghiệm thu' },
    { key: 'QD_CONG_NHAN', name: 'Quyết định công nhận kết quả nghiệm thu' },
    { key: 'BB_THANH_LY', name: 'Biên bản thanh lý Hợp đồng & Báo cáo quyết toán' },
    { key: 'BAO_CAO_6_THANG', name: 'Báo cáo tiến độ định kỳ 06 tháng/lần' }
  ]
};

// Đồng bộ danh sách Giai đoạn được phép tải lên trong Modal theo Vai trò hiện tại
function syncUploadModalStageOptions() {
  const stageSelect = document.getElementById('uploadStageSelect');
  const roleNotice = document.getElementById('uploadModalRoleNotice');
  const allAuditItems = (currentProjectData && currentProjectData.audit && currentProjectData.audit.items)
    ? currentProjectData.audit.items
    : [];
  const allDocs = (currentProjectData && currentProjectData.documents)
    ? currentProjectData.documents
    : [];

  const allowedStages = [];
  const stageCounts = {};

  for (let s = 1; s <= 7; s++) {
    const rawItems = allAuditItems.length > 0
      ? getStageCriteriaList(s, allAuditItems, allDocs)
      : (STAGE_DOC_CATALOG[s] || []);
    const allowedInS = rawItems.filter(it => canCurrentUserUploadCriteriaItem(it));
    stageCounts[s] = allowedInS.length;
    if (allowedInS.length > 0) {
      allowedStages.push(s);
    }
  }

  if (stageSelect) {
    stageSelect.innerHTML = [1, 2, 3, 4, 5, 6, 7].map(s => {
      const cnt = stageCounts[s] || 0;
      const isAllowed = cnt > 0;
      const suffix = isAllowed ? ` (Được nộp ${cnt} loại văn bản)` : ' (Không thuộc thẩm quyền nộp)';
      return `<option value="${s}" ${isAllowed ? '' : 'disabled'}>Giai đoạn ${s}: ${escapeHtml(STAGE_NAMES[s])}${suffix}</option>`;
    }).join('');
  }

  if (roleNotice) {
    const roleLabel = getCurrentRoleLabelVn();
    const stageText = allowedStages.length === 7
      ? 'Toàn bộ 7 giai đoạn'
      : (allowedStages.length > 0 ? `Giai đoạn ${allowedStages.join(', ')}` : 'Không có giai đoạn nào');
    roleNotice.innerHTML = `Vai trò thao tác: <strong>${escapeHtml(roleLabel)}</strong> • Thẩm quyền tải văn bản tại: <strong style="color:#0284c7;">${stageText}</strong>`;
  }

  return allowedStages;
}

// Modal Nộp tài liệu (Lọc điều kiện kép: Theo Vai trò hiện tại -> Chọn Giai đoạn -> Chỉ hiện các loại văn bản thuộc thẩm quyền nộp tại Giai đoạn đó)
function onUploadStageChange(stageVal, preferredDocKey = null) {
  const allowedStages = syncUploadModalStageOptions();
  let stage = Number(stageVal) || (allowedStages[0] || 1);
  if (allowedStages.length > 0 && !allowedStages.includes(stage)) {
    stage = allowedStages[0];
  }

  const stageSelect = document.getElementById('uploadStageSelect');
  const docSelect = document.getElementById('uploadDocTypeSelect');
  const docLabel = document.getElementById('uploadDocTypeLabel');

  if (stageSelect) {
    stageSelect.value = String(stage);
  }
  if (docLabel) {
    docLabel.innerText = `2. Chọn Văn bản thuộc thẩm quyền nộp tại Giai đoạn ${stage} *`;
  }
  if (!docSelect) return;

  const allAuditItems = (currentProjectData && currentProjectData.audit && currentProjectData.audit.items)
    ? currentProjectData.audit.items
    : [];
  const allDocs = (currentProjectData && currentProjectData.documents)
    ? currentProjectData.documents
    : [];

  const computedStageItems = allAuditItems.length > 0
    ? getStageCriteriaList(stage, allAuditItems, allDocs)
    : (STAGE_DOC_CATALOG[stage] || []);

  // Đánh số thứ tự gốc trong giai đoạn (ví dụ 3.3, 3.4) và lọc chỉ giữ những văn bản mà vai trò hiện tại được phép tải lên
  const indexedAllowedItems = computedStageItems
    .map((it, idx) => ({
      ...it,
      stage_sub_index: `${stage}.${idx + 1}`
    }))
    .filter(it => canCurrentUserUploadCriteriaItem(it));

  let optionsHtml = indexedAllowedItems.map(item => {
    const statusNote = item.status === 'UPLOADED'
      ? ' (Đã nộp)'
      : (item.status === 'VERIFIED' ? ' (Đã lưu bản chính)' : (item.status === 'MISSING' ? ' (Chưa nộp)' : ''));
    return `<option value="${item.key}" data-stage="${stage}" data-clean-name="${escapeHtml(item.name)}">${item.stage_sub_index}. ${escapeHtml(item.name)}${statusNote}</option>`;
  }).join('');

  if (indexedAllowedItems.length > 0) {
    optionsHtml += `<option value="KHAC" data-stage="${stage}" data-clean-name="Văn bản bổ sung Giai đoạn ${stage}">${stage}.${computedStageItems.length + 1}. Văn bản / Minh chứng bổ sung khác (Giai đoạn ${stage})</option>`;
  } else {
    optionsHtml = `<option value="" disabled selected>Không có loại văn bản nào thuộc thẩm quyền nộp tại Giai đoạn ${stage}</option>`;
  }

  docSelect.innerHTML = optionsHtml;

  if (preferredDocKey && Array.from(docSelect.options).some(o => o.value === preferredDocKey)) {
    docSelect.value = preferredDocKey;
  } else {
    const firstMissing = indexedAllowedItems.find(i => i.status === 'MISSING');
    docSelect.value = firstMissing ? firstMissing.key : (indexedAllowedItems[0] ? indexedAllowedItems[0].key : 'KHAC');
  }

  onUploadDocTypeChange(docSelect);
}

function openUploadModal() {
  const allowedStages = syncUploadModalStageOptions();
  if (allowedStages.length === 0) {
    showToast('Vai trò hiện tại chỉ có quyền xem hồ sơ, không thực hiện tải văn bản lên.', 'error');
    return;
  }
  document.getElementById('uploadDocForm').reset();
  const repEl = document.getElementById('uploadReplaceDocId');
  if (repEl) repEl.value = '';
  onUploadStageChange(allowedStages[0]);
  document.getElementById('uploadModal').classList.add('active');
}

function openUploadModalForStage(stage) {
  const allowedStages = syncUploadModalStageOptions();
  if (!allowedStages.includes(Number(stage))) {
    showToast(`Vai trò hiện tại không có thẩm quyền tải văn bản tại Giai đoạn ${stage}.`, 'error');
    return;
  }
  document.getElementById('uploadDocForm').reset();
  const repEl = document.getElementById('uploadReplaceDocId');
  if (repEl) repEl.value = '';
  onUploadStageChange(stage);
  document.getElementById('uploadModal').classList.add('active');
}

function openUploadModalForCriteria(docKey, stage, criteriaName, replaceDocId = '') {
  if (!canCurrentUserUploadCriteriaItem({ key: docKey })) {
    showToast('Vai trò hiện tại không có thẩm quyền tải lên loại văn bản này.', 'error');
    return;
  }
  document.getElementById('uploadDocForm').reset();
  const repEl = document.getElementById('uploadReplaceDocId');
  if (repEl) repEl.value = replaceDocId ? String(replaceDocId) : '';
  onUploadStageChange(stage || 1, docKey);
  const titleInput = document.getElementById('uploadTitleInput');
  if (titleInput && criteriaName) {
    titleInput.value = `${criteriaName} - Đề tài ${currentProjectData ? currentProjectData.code : ''}`;
  }
  document.getElementById('uploadModal').classList.add('active');
}

function onUploadDocTypeChange(selectEl) {
  const opt = selectEl.options[selectEl.selectedIndex];
  if (!opt) return;
  const docKey = opt.value;
  const stageNum = Number(opt.getAttribute('data-stage')) || Number(document.getElementById('uploadStageSelect')?.value) || 1;
  const cleanName = opt.getAttribute('data-clean-name') || opt.text.replace(/^\d+\.\d+\.\s*/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const titleInput = document.getElementById('uploadTitleInput');
  if (titleInput) {
    titleInput.value = `${cleanName} - Đề tài ${currentProjectData ? currentProjectData.code : ''}`;
  }

  // Cập nhật thông báo yêu cầu pháp lý (dấu mộc đỏ / chữ ký phê duyệt) cho loại văn bản đang chọn
  const legalBox = document.getElementById('uploadLegalRequirementBox');
  const confirmLabel = document.getElementById('uploadLegalConfirmLabel');
  const pol = CRITERIA_UPLOAD_POLICY[docKey];

  if (legalBox) {
    if (pol) {
      const isRedSeal = pol.require_red_seal && !(docKey === 'THUYET_MINH' && stageNum === 1);
      const detailText = (docKey === 'THUYET_MINH' && stageNum === 1)
        ? 'Bản trình nộp đề xuất có chữ ký xác nhận của Chủ nhiệm đề tài (hoặc bản scan PDF đã phê duyệt và đóng dấu mộc đỏ nếu đã qua Hội đồng).'
        : (docKey === 'THUYET_MINH' && stageNum === 2)
          ? 'Bắt buộc tải lên bản scan (PDF) Thuyết minh đề tài đã chỉnh sửa hoàn thiện sau họp Hội đồng, có chữ ký phê duyệt và đóng dấu mộc đỏ của Viện.'
          : pol.legal_detail;

      if (isRedSeal) {
        legalBox.style.background = '#fef2f2';
        legalBox.style.border = '1px solid #fecaca';
        legalBox.style.color = '#991b1b';
        legalBox.innerHTML = `<strong>Yêu cầu pháp lý (Bắt buộc có dấu mộc đỏ / phê duyệt):</strong> ${escapeHtml(detailText)}`;
      } else {
        legalBox.style.background = '#eff6ff';
        legalBox.style.border = '1px solid #bfdbfe';
        legalBox.style.color = '#1e3a8a';
        legalBox.innerHTML = `<strong>Yêu cầu pháp lý (Bản ký xác nhận):</strong> ${escapeHtml(detailText)}`;
      }

      if (confirmLabel) {
        confirmLabel.innerText = isRedSeal
          ? 'Tôi xác nhận tệp tải lên là bản scan đã có đầy đủ chữ ký phê duyệt và đóng dấu mộc đỏ đúng quy định pháp lý.'
          : 'Tôi xác nhận tệp tải lên đã có đầy đủ chữ ký xác nhận của cá nhân / đơn vị có thẩm quyền theo quy định.';
      }
    } else {
      legalBox.style.background = '#f8fafc';
      legalBox.style.border = '1px solid #cbd5e1';
      legalBox.style.color = '#334155';
      legalBox.innerHTML = '<strong>Yêu cầu pháp lý:</strong> Văn bản bổ sung cần có chữ ký xác nhận hoặc đóng dấu của đơn vị ban hành để đảm bảo giá trị lưu trữ kiểm toán.';
      if (confirmLabel) {
        confirmLabel.innerText = 'Tôi xác nhận tệp tải lên là văn bản hợp lệ phục vụ lưu trữ hồ sơ đề tài.';
      }
    }
  }
}

async function handleUploadDoc(e) {
  e.preventDefault();
  const form = e.target;
  const formData = new FormData(form);
  formData.set('uploaded_by', getCurrentRoleLabelVn());

  try {
    const res = await fetch(`/api/documents/upload/${currentProjectId}`, {
      method: 'POST',
      body: formData
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message || 'Đã tải văn bản lên và cập nhật tiến độ thành công!', 'success');
      closeModal('uploadModal');
      loadProject();
    } else {
      showToast(json.error || 'Lỗi khi tải văn bản lên', 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

// =========================================================================
// CHỈNH SỬA / ĐỔI PHÂN LOẠI / THAY TỆP / KHÓA DUYỆT / GỠ BỎ VĂN BẢN TẢI NHẦM
// =========================================================================
let currentEditingDocMeta = null;

function openEditDocModal(docId, currentDocKey, currentStage, currentAuditStatus) {
  const allDocs = (currentProjectData && currentProjectData.documents) ? currentProjectData.documents : [];
  const docObj = allDocs.find(d => Number(d.id) === Number(docId));
  if (!docObj) {
    showToast('Không tìm thấy thông tin văn bản cần chỉnh sửa.', 'error');
    return;
  }

  const role = typeof window.getCurrentRole === 'function' ? window.getCurrentRole() : 'PHONG_KHCN';
  const isKhcnOrAdmin = ['PHONG_KHCN', 'SUPER_ADMIN'].includes(role);

  if (!isKhcnOrAdmin && currentAuditStatus === 'VERIFIED') {
    showToast('Văn bản này đã được Phòng KH&CN duyệt bản chính và khóa lưu trữ.', 'error');
    return;
  }

  currentEditingDocMeta = {
    id: docObj.id,
    old_stage: Number(currentStage || docObj.stage || 1),
    old_doc_type: currentDocKey || docObj.doc_type || 'KHAC',
    old_status: currentAuditStatus || 'UPLOADED',
    title: docObj.title || docObj.file_name
  };

  const form = document.getElementById('editDocForm');
  if (form) form.reset();

  document.getElementById('editDocIdInput').value = docObj.id;

  const infoBox = document.getElementById('editDocCurrentFileInfo');
  if (infoBox) {
    const upBy = docObj.uploaded_by || 'Phòng KH&CN';
    const upTime = docObj.uploaded_at_vn || docObj.uploaded_at || '';
    infoBox.innerHTML = `
      <div><strong>Tệp hiện đang lưu trữ:</strong> <span style="color:#0369a1; font-weight:700;">${escapeHtml(docObj.file_name)}</span> (${formatFileSize(docObj.file_size)})</div>
      <div style="margin-top:2px; color:#64748b;">Người tải lên: <strong>${escapeHtml(upBy)}</strong> ${upTime ? `• Thời điểm: ${escapeHtml(upTime)}` : ''}</div>
    `;
  }

  // Đồng bộ danh sách Giai đoạn được phép chuyển tới theo vai trò
  const stageSelect = document.getElementById('editDocStageSelect');
  const allAuditItems = (currentProjectData && currentProjectData.audit && currentProjectData.audit.items)
    ? currentProjectData.audit.items
    : [];

  if (stageSelect) {
    stageSelect.innerHTML = [1, 2, 3, 4, 5, 6, 7].map(s => {
      const rawItems = allAuditItems.length > 0
        ? getStageCriteriaList(s, allAuditItems, allDocs)
        : (STAGE_DOC_CATALOG[s] || []);
      const allowedInS = rawItems.filter(it => canCurrentUserUploadCriteriaItem(it));
      const isAllowed = isKhcnOrAdmin || allowedInS.length > 0 || Number(s) === currentEditingDocMeta.old_stage;
      return `<option value="${s}" ${isAllowed ? '' : 'disabled'}>Giai đoạn ${s}: ${escapeHtml(STAGE_NAMES[s])}</option>`;
    }).join('');
  }

  onEditDocStageChange(currentEditingDocMeta.old_stage, currentEditingDocMeta.old_doc_type);

  // Giữ nguyên tên hiển thị và ghi chú hiện tại của văn bản khi mở hộp thoại
  const titleInput = document.getElementById('editDocTitleInput');
  if (titleInput) titleInput.value = docObj.title || '';
  const notesInput = document.getElementById('editDocNotesInput');
  if (notesInput) notesInput.value = docObj.notes || '';

  // Khối xác thực & khóa bản chính dành riêng cho Phòng KH&CN / Admin
  const verifyBox = document.getElementById('editDocVerifyStatusGroup');
  const verifySelect = document.getElementById('editDocVerifyStatusSelect');
  if (verifyBox && verifySelect) {
    if (isKhcnOrAdmin && currentEditingDocMeta.old_doc_type !== 'KHAC') {
      verifyBox.style.display = 'block';
      verifySelect.value = (currentAuditStatus === 'VERIFIED') ? 'VERIFIED' : 'UPLOADED';
    } else {
      verifyBox.style.display = 'none';
      verifySelect.value = 'UPLOADED';
    }
  }

  document.getElementById('editDocModal').classList.add('active');
}

function onEditDocStageChange(stageVal, preferredDocKey = null) {
  const stage = Number(stageVal) || 1;
  const stageSelect = document.getElementById('editDocStageSelect');
  const docSelect = document.getElementById('editDocTypeSelect');
  if (stageSelect) stageSelect.value = String(stage);
  if (!docSelect) return;

  const role = typeof window.getCurrentRole === 'function' ? window.getCurrentRole() : 'PHONG_KHCN';
  const isKhcnOrAdmin = ['PHONG_KHCN', 'SUPER_ADMIN'].includes(role);

  const allAuditItems = (currentProjectData && currentProjectData.audit && currentProjectData.audit.items)
    ? currentProjectData.audit.items
    : [];
  const allDocs = (currentProjectData && currentProjectData.documents)
    ? currentProjectData.documents
    : [];

  const computedStageItems = allAuditItems.length > 0
    ? getStageCriteriaList(stage, allAuditItems, allDocs)
    : (STAGE_DOC_CATALOG[stage] || []);

  const indexedAllowedItems = computedStageItems
    .map((it, idx) => ({
      ...it,
      stage_sub_index: `${stage}.${idx + 1}`
    }))
    .filter(it => isKhcnOrAdmin || canCurrentUserUploadCriteriaItem(it) || it.key === preferredDocKey);

  let optionsHtml = indexedAllowedItems.map(item => {
    const isCurrent = currentEditingDocMeta && item.key === currentEditingDocMeta.old_doc_type;
    const statusNote = isCurrent
      ? ' (Mục hiện tại của tệp này)'
      : (item.status === 'UPLOADED' ? ' (Đã có tệp)' : (item.status === 'VERIFIED' ? ' (Đã duyệt bản chính)' : (item.status === 'MISSING' ? ' (Chưa nộp)' : '')));
    return `<option value="${item.key}" data-stage="${stage}" data-clean-name="${escapeHtml(item.name)}">${item.stage_sub_index}. ${escapeHtml(item.name)}${statusNote}</option>`;
  }).join('');

  optionsHtml += `<option value="KHAC" data-stage="${stage}" data-clean-name="Văn bản bổ sung Giai đoạn ${stage}">${stage}.${computedStageItems.length + 1}. Văn bản / Minh chứng bổ sung khác (Giai đoạn ${stage})</option>`;

  docSelect.innerHTML = optionsHtml;

  if (preferredDocKey && Array.from(docSelect.options).some(o => o.value === preferredDocKey)) {
    docSelect.value = preferredDocKey;
  } else if (indexedAllowedItems[0]) {
    docSelect.value = indexedAllowedItems[0].key;
  } else {
    docSelect.value = 'KHAC';
  }

  onEditDocTypeChange(docSelect, false);
}

function onEditDocTypeChange(selectEl, shouldUpdateTitle = true) {
  const opt = selectEl.options[selectEl.selectedIndex];
  if (!opt) return;
  const docKey = opt.value;
  const stageNum = Number(opt.getAttribute('data-stage')) || Number(document.getElementById('editDocStageSelect')?.value) || 1;
  const cleanName = opt.getAttribute('data-clean-name') || opt.text.replace(/^\d+\.\d+\.\s*/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();

  if (shouldUpdateTitle) {
    const titleInput = document.getElementById('editDocTitleInput');
    if (titleInput) {
      titleInput.value = `${cleanName} - Đề tài ${currentProjectData ? currentProjectData.code : ''}`;
    }
  }

  // Hiện/ẩn khung xác thực bản chính của P. KH&CN nếu chuyển giữa tiêu chí chuẩn và KHAC
  const role = typeof window.getCurrentRole === 'function' ? window.getCurrentRole() : 'PHONG_KHCN';
  const isKhcnOrAdmin = ['PHONG_KHCN', 'SUPER_ADMIN'].includes(role);
  const verifyBox = document.getElementById('editDocVerifyStatusGroup');
  if (verifyBox) {
    verifyBox.style.display = (isKhcnOrAdmin && docKey !== 'KHAC') ? 'block' : 'none';
  }

  const legalBox = document.getElementById('editDocLegalBox');
  const pol = CRITERIA_UPLOAD_POLICY[docKey];
  if (legalBox) {
    if (pol) {
      const isRedSeal = pol.require_red_seal && !(docKey === 'THUYET_MINH' && stageNum === 1);
      const detailText = (docKey === 'THUYET_MINH' && stageNum === 1)
        ? 'Bản trình nộp đề xuất có chữ ký xác nhận của Chủ nhiệm đề tài (hoặc bản scan PDF đã phê duyệt và đóng dấu mộc đỏ).'
        : (docKey === 'THUYET_MINH' && stageNum === 2)
          ? 'Bắt buộc bản scan (PDF) Thuyết minh đề tài đã hoàn thiện sau họp Hội đồng, có chữ ký phê duyệt và đóng dấu mộc đỏ của Viện.'
          : pol.legal_detail;
      legalBox.style.background = isRedSeal ? '#fef2f2' : '#eff6ff';
      legalBox.style.border = isRedSeal ? '1px solid #fecaca' : '1px solid #bfdbfe';
      legalBox.style.color = isRedSeal ? '#991b1b' : '#1e3a8a';
      legalBox.innerHTML = `<strong>Yêu cầu pháp lý của danh mục này:</strong> ${escapeHtml(detailText)}`;
    } else {
      legalBox.style.background = '#f8fafc';
      legalBox.style.border = '1px solid #cbd5e1';
      legalBox.style.color = '#334155';
      legalBox.innerHTML = '<strong>Yêu cầu pháp lý:</strong> Văn bản bổ sung lưu trữ kèm theo giai đoạn thực hiện.';
    }
  }
}

async function handleEditDocSubmit(e) {
  e.preventDefault();
  const docId = document.getElementById('editDocIdInput').value;
  if (!docId) return;

  const form = e.target;
  const formData = new FormData(form);
  formData.set('uploaded_by', getCurrentRoleLabelVn());

  const newDocType = formData.get('doc_type') || 'KHAC';
  const role = typeof window.getCurrentRole === 'function' ? window.getCurrentRole() : 'PHONG_KHCN';
  const isKhcnOrAdmin = ['PHONG_KHCN', 'SUPER_ADMIN'].includes(role);
  const verifySelect = document.getElementById('editDocVerifyStatusSelect');
  const desiredVerifyStatus = (isKhcnOrAdmin && verifySelect && newDocType !== 'KHAC')
    ? verifySelect.value
    : null;

  try {
    const res = await fetch(`/api/documents/${docId}`, {
      method: 'PUT',
      body: formData
    });
    const json = await res.json();
    if (!json.success) {
      showToast(json.error || 'Lỗi khi cập nhật văn bản', 'error');
      return;
    }

    // Nếu Phòng KH&CN chọn khóa duyệt bản chính (VERIFIED) hoặc mở khóa (UPLOADED)
    if (desiredVerifyStatus && newDocType !== 'KHAC') {
      await fetch('/api/audit/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: currentProjectId,
          criteria_key: newDocType,
          status: desiredVerifyStatus,
          verified_by: getCurrentRoleLabelVn(),
          notes: formData.get('notes') || ''
        })
      });
    }

    showToast(json.message || 'Đã lưu thay đổi thông tin và phân loại văn bản!', 'success');
    closeModal('editDocModal');
    loadProject();
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

async function handleDeleteEditedDocument() {
  const docId = document.getElementById('editDocIdInput').value;
  if (!docId) return;

  const docTitle = (currentEditingDocMeta && currentEditingDocMeta.title) ? currentEditingDocMeta.title : `#${docId}`;
  const confirmed = window.confirm(
    `Bạn có chắc chắn muốn GỠ BỎ văn bản "${docTitle}" đã tải nhầm?\n\nHệ thống sẽ xóa tệp này và trả trạng thái danh mục tương ứng về "Chưa nộp" để tải lại tệp đúng.`
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/documents/${docId}`, {
      method: 'DELETE'
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message || 'Đã gỡ bỏ văn bản tải nhầm và cập nhật lại danh mục hồ sơ!', 'success');
      closeModal('editDocModal');
      loadProject();
    } else {
      showToast(json.error || 'Không thể gỡ bỏ văn bản', 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

// Modal Báo cáo 6 tháng
function openSubmitReportModal(reportId, periodNum) {
  document.getElementById('submitReportForm').reset();
  document.getElementById('modalReportId').value = reportId;
  document.getElementById('modalReportPeriodLabel').value = `Kỳ ${periodNum}: Báo cáo định kỳ ${periodNum * 6} tháng`;
  const tplBtn = document.getElementById('modalReportDownloadTemplateBtn');
  if (tplBtn) {
    tplBtn.href = `/api/projects/${currentProjectId}/export-autofill/BAO_CAO_6_THANG?reportId=${reportId}`;
  }
  document.getElementById('reportModal').classList.add('active');
}

async function handleSubmitReport(e) {
  e.preventDefault();
  const reportId = document.getElementById('modalReportId').value;
  const periodLabel = document.getElementById('modalReportPeriodLabel').value;
  const fileInput = document.getElementById('modalReportFileInput');
  const formData = new FormData(e.target);
  const payload = Object.fromEntries(formData.entries());

  try {
    // Nếu nhà khoa học có đính kèm file Báo cáo hoàn chỉnh (Word/PDF), upload vào kho số hóa GĐ 5 trước
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      const fileObj = fileInput.files[0];
      const upForm = new FormData();
      upForm.append('file', fileObj);
      upForm.append('stage', '5');
      upForm.append('doc_type', 'BAO_CAO_6_THANG');
      upForm.append('title', `${periodLabel} - Đề tài ${currentProjectData ? currentProjectData.code : ''}`);
      upForm.append('notes', payload.progress_summary || `Báo cáo tiến độ 6 tháng hoàn chỉnh (${fileObj.name})`);

      const upRes = await fetch(`/api/documents/upload/${currentProjectId}`, {
        method: 'POST',
        body: upForm
      });
      const upJson = await upRes.json();
      if (!upJson.success) {
        showToast(upJson.error || 'Lỗi khi tải file báo cáo lên hệ thống', 'error');
        return;
      }
      payload.report_file_id = upJson.documentId;
      if (!payload.progress_summary) {
        payload.progress_summary = `Đã nộp file báo cáo hoàn chỉnh: ${fileObj.name}`;
      }
    } else if (!payload.progress_summary) {
      payload.progress_summary = `Đã nộp ${periodLabel}`;
    }

    const res = await fetch(`/api/reports/${reportId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (json.success) {
      showToast('Đã nộp báo cáo định kỳ 6 tháng & đồng bộ hồ sơ số thành công!', 'success');
      closeModal('reportModal');
      loadProject();
    } else {
      showToast(json.error || 'Lỗi nộp báo cáo', 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

// Modal Thêm / Sửa mục dự toán
function openAddBudgetModal(editItemId = null) {
  const form = document.getElementById('addBudgetForm');
  if (form) form.reset();
  const idInput = document.getElementById('budgetEditItemId');
  const titleEl = document.getElementById('addBudgetModalTitle');
  const btnEl = document.getElementById('btnSaveBudgetItem');

  if (editItemId && currentProjectData && Array.isArray(currentProjectData.budget_items)) {
    const item = currentProjectData.budget_items.find(b => Number(b.id) === Number(editItemId));
    if (item) {
      if (idInput) idInput.value = item.id;
      if (titleEl) titleEl.innerText = 'Cập nhật Hạng mục Dự toán Kinh phí';
      if (btnEl) btnEl.innerText = 'Cập nhật hạng mục';
      document.getElementById('budgetCategoryInput').value = item.category || 'Hóa chất & Vật tư thí nghiệm';
      document.getElementById('budgetItemNameInput').value = item.item_name || '';
      document.getElementById('budgetSpecInput').value = item.specification || '';
      document.getElementById('budgetUnitInput').value = item.unit || '';
      document.getElementById('budgetQtyInput').value = item.approved_quantity || 1;
      document.getElementById('budgetPriceInput').value = item.unit_price || 0;
      document.getElementById('budgetNotesInput').value = item.notes || '';
    }
  } else {
    if (idInput) idInput.value = '';
    if (titleEl) titleEl.innerText = 'Thêm Hạng mục Dự toán Kinh phí';
    if (btnEl) btnEl.innerText = 'Lưu hạng mục';
  }
  document.getElementById('addBudgetModal').classList.add('active');
}

async function handleAddBudget(e) {
  e.preventDefault();
  const formData = new FormData(e.target);
  const payload = Object.fromEntries(formData.entries());
  const editId = payload.edit_item_id;

  try {
    const url = editId
      ? `/api/supplies/budget/item/${editId}`
      : `/api/supplies/budget/${currentProjectId}`;
    const res = await fetch(url, {
      method: editId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message || 'Đã lưu hạng mục dự toán!', 'success');
      closeModal('addBudgetModal');
      loadProject();
    } else {
      showToast(json.error || 'Lỗi lưu dự toán', 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

async function handleLockBudgetBaseline(docId) {
  if (!docId) {
    showToast('Cần tải lên Bản scan Dự toán phê duyệt có dấu mộc đỏ (PDF) trước khi Chốt & Khóa.', 'error');
    return;
  }
  if (!confirm('Xác nhận CHỐT & KHÓA bảng dự toán chi tiết theo bản phê duyệt có dấu mộc đỏ của Viện trưởng?\n\nSau khi khóa, không ai có thể tự sửa tay số lượng/đơn giá — mọi thay đổi bắt buộc phải đi qua quy trình Điều chỉnh dự toán.')) {
    return;
  }
  try {
    const res = await fetch(`/api/supplies/budget/${currentProjectId}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc_id: docId })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message, 'success');
      loadProject();
    } else {
      showToast(json.error || 'Không thể chốt khóa dự toán', 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

async function handleUnlockBudgetBaseline() {
  const reason = prompt('Nhập lý do mở khóa bảng dự toán gốc để hiệu đính (sẽ ghi nhận vào Nhật ký kiểm toán):');
  if (reason === null) return;
  try {
    const res = await fetch(`/api/supplies/budget/${currentProjectId}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason.trim() })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message, 'success');
      loadProject();
    } else {
      showToast(json.error || 'Không thể mở khóa', 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

// =========================================================================
// MÀN HÌNH ĐỐI CHIẾU 2 CỘT (PDF MỘC ĐỎ ↔ BẢNG SOFT-COPY & DÁN NHANH EXCEL)
// =========================================================================
function openBudgetReconcileModal() {
  renderBudgetReconcileModalContent();
  document.getElementById('budgetReconcileModal').classList.add('active');
}

function renderBudgetReconcileModalContent() {
  if (!currentProjectData) return;
  const analytics = currentProjectData.budget_analytics || {};
  const legal = analytics.legal_status || {};
  const items = currentProjectData.budget_items || [];
  const perms = getSuppliesRolePermissions();
  const isLocked = Boolean(legal.is_locked);
  const canLockBudget = ['SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TC_CU', 'VIEN_TRUONG'].includes(perms.role);

  // 1. Cột trái: PDF mộc đỏ
  const doc = legal.red_seal_doc;
  const iframe = document.getElementById('reconcilePdfIframe');
  const emptyBox = document.getElementById('reconcilePdfEmpty');
  const newTabBtn = document.getElementById('reconcilePdfNewTabBtn');
  const upBtn = document.getElementById('reconcileUploadPdfBtn');
  const pdfTitle = document.getElementById('reconcilePdfHeaderTitle');

  if (doc) {
    const url = `/api/documents/${doc.id}/preview`;
    if (pdfTitle) pdfTitle.innerText = `Bản mộc đỏ: ${doc.file_name}`;
    if (iframe) {
      if (iframe.getAttribute('data-doc-id') !== String(doc.id)) {
        iframe.src = url;
        iframe.setAttribute('data-doc-id', String(doc.id));
      }
      iframe.style.display = 'block';
    }
    if (emptyBox) emptyBox.style.display = 'none';
    if (newTabBtn) { newTabBtn.href = url; newTabBtn.style.display = 'inline-flex'; }
  } else {
    if (pdfTitle) pdfTitle.innerText = 'Chưa có Bản scan Dự toán mộc đỏ';
    if (iframe) { iframe.src = ''; iframe.removeAttribute('data-doc-id'); iframe.style.display = 'none'; }
    if (emptyBox) emptyBox.style.display = 'flex';
    if (newTabBtn) newTabBtn.style.display = 'none';
  }
  if (upBtn) upBtn.style.display = (!isLocked && perms.canEditBudget) ? 'inline-flex' : 'none';

  // 2. Thanh đối chiếu tổng kinh phí
  const approvedBudget = Math.round(Number(currentProjectData.budget_revised || currentProjectData.budget_total || 0));
  const sumItems = Math.round(items.reduce((s, it) => s + (Number(it.total_price) || 0), 0));
  const diff = sumItems - approvedBudget;
  const isMatched = items.length > 0 && (approvedBudget === 0 || Math.abs(diff) <= 1000);

  const matchBar = document.getElementById('reconcileTotalMatchBar');
  if (matchBar) {
    let badgeHtml = '';
    if (items.length === 0) {
      badgeHtml = `<span class="badge badge-yellow" style="font-size:0.74rem;">Chưa có hạng mục soft-copy</span>`;
    } else if (isMatched) {
      badgeHtml = `<span class="badge badge-green" style="font-size:0.74rem;"><i class="fa-solid fa-circle-check"></i> Khớp 100% với tổng QĐ phê duyệt</span>`;
    } else {
      const diffStr = (diff > 0 ? '+' : '') + diff.toLocaleString('vi-VN') + ' đ';
      badgeHtml = `<span class="badge badge-red" style="font-size:0.74rem;"><i class="fa-solid fa-triangle-exclamation"></i> Lệch ${diffStr}</span>`;
    }

    matchBar.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <div style="display:flex; gap:16px; flex-wrap:wrap; font-size:0.8rem;">
          <span>Tổng QĐ phê duyệt: <strong style="color:#0f172a;">${approvedBudget.toLocaleString('vi-VN')} đ</strong></span>
          <span>Tổng Soft-copy: <strong style="color:${isMatched ? '#15803d' : '#dc2626'};">${sumItems.toLocaleString('vi-VN')} đ</strong></span>
        </div>
        <div>${badgeHtml}</div>
      </div>
    `;
  }

  // 3. Ẩn/hiện thanh công cụ nhập
  const toolsBar = document.getElementById('reconcileToolsBar');
  const countLabel = document.getElementById('reconcileItemsCountLabel');
  if (countLabel) countLabel.innerText = `${items.length} hạng mục`;
  if (toolsBar) toolsBar.style.display = (!isLocked && perms.canEditBudget) ? 'flex' : 'none';
  if (isLocked) toggleReconcilePasteBox(false);

  // 4. Bảng Soft-copy
  const tbody = document.getElementById('reconcileSoftCopyBody');
  if (tbody) {
    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:1.5rem; color:#64748b;">Chưa có dữ liệu soft-copy. Hãy bấm <strong>Dán nhanh từ Excel</strong>, <strong>Import file BM02</strong> hoặc <strong>+ Thêm 1 dòng</strong>.</td></tr>`;
    } else {
      tbody.innerHTML = items.map((it, i) => `
        <tr>
          <td style="text-align:center; color:#64748b;">${i + 1}</td>
          <td>
            <div style="font-weight:600; color:#0f172a;">${escapeHtml(it.item_name)}</div>
            ${it.specification ? `<div style="font-size:0.7rem; color:#64748b;">${escapeHtml(it.specification)}</div>` : ''}
          </td>
          <td>${escapeHtml(it.unit || '-')}</td>
          <td style="text-align:center; font-weight:700;">${it.approved_quantity}</td>
          <td style="text-align:right;">${Number(it.unit_price || 0).toLocaleString('vi-VN')}</td>
          <td style="text-align:right; font-weight:700; color:#0f172a;">${Number(it.total_price || 0).toLocaleString('vi-VN')}</td>
          <td style="text-align:center;">
            ${!isLocked && perms.canEditBudget ? `
              <button type="button" class="btn btn-outline btn-sm" style="padding:1px 5px; font-size:0.68rem;" onclick="openAddBudgetModal(${it.id})" title="Sửa"><i class="fa-solid fa-pen"></i></button>
              ${perms.canDeleteBudget ? `<button type="button" class="btn btn-outline btn-sm" style="padding:1px 5px; font-size:0.68rem; color:#dc2626;" onclick="deleteBudgetItem(${it.id}, '${escapeHtml(it.item_name)}')" title="Xóa"><i class="fa-solid fa-trash"></i></button>` : ''}
            ` : '<i class="fa-solid fa-lock" style="color:#15803d; font-size:0.72rem;"></i>'}
          </td>
        </tr>
      `).join('');
    }
  }

  // 5. Footer & nút Chốt khóa
  const footerNote = document.getElementById('reconcileFooterNote');
  const lockBtn = document.getElementById('btnReconcileConfirmLock');
  if (isLocked) {
    if (footerNote) footerNote.innerHTML = `<span style="color:#15803d; font-weight:700;"><i class="fa-solid fa-lock"></i> Đã Chốt &amp; Khóa dự toán gốc bởi ${escapeHtml(legal.locked_by || '')} (${escapeHtml(legal.locked_at || '')}).</span>`;
    if (lockBtn) lockBtn.style.display = 'none';
  } else {
    if (lockBtn) {
      lockBtn.style.display = canLockBudget ? 'inline-flex' : 'none';
      lockBtn.disabled = !(doc && isMatched);
      lockBtn.title = !doc
        ? 'Cần tải lên Bản scan PDF mộc đỏ trước'
        : (!isMatched ? 'Tổng bảng soft-copy cần khớp 100% với Tổng QĐ phê duyệt trước khi Chốt khóa' : 'Sẵn sàng Chốt & Khóa dự toán gốc');
    }
    if (footerNote) {
      if (!doc) {
        footerNote.innerHTML = `<span style="color:#b45309;">Bước 1: Cần tải lên bản scan PDF mộc đỏ ở cột trái.</span>`;
      } else if (!isMatched) {
        footerNote.innerHTML = `<span style="color:#dc2626;">Bước 2: Chỉnh sửa bảng soft-copy bên phải cho khớp tổng ${approvedBudget.toLocaleString('vi-VN')} đ để mở nút Chốt khóa.</span>`;
      } else {
        footerNote.innerHTML = `<span style="color:#15803d; font-weight:600;">Đã đủ bản mộc đỏ và khớp 100% tổng kinh phí — sẵn sàng bấm Chốt &amp; Khóa!</span>`;
      }
    }
  }
}

function toggleReconcilePasteBox(forceState) {
  const box = document.getElementById('reconcilePasteBox');
  if (!box) return;
  const next = forceState !== undefined ? forceState : (box.style.display === 'none');
  box.style.display = next ? 'block' : 'none';
  if (next) {
    const ta = document.getElementById('reconcilePasteTextarea');
    if (ta) ta.focus();
  }
}

function parseVnNumberClient(str) {
  if (!str) return 0;
  let s = String(str).trim().replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  if (s.includes('.') && s.includes(',')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (s.includes(',')) {
    const parts = s.split(',');
    s = (parts.length > 2 || (parts[1] && parts[1].length === 3)) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (s.includes('.')) {
    const parts = s.split('.');
    if (parts.length > 2 || (parts[1] && parts[1].length === 3)) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

async function handleApplyReconcilePaste() {
  const ta = document.getElementById('reconcilePasteTextarea');
  const raw = ta ? ta.value.trim() : '';
  if (!raw) {
    showToast('Vui lòng dán dữ liệu bảng từ Excel/Sheet vào ô trống.', 'error');
    return;
  }

  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    let cols = line.includes('\t') ? line.split('\t').map(c => c.trim()) : line.split(';').map(c => c.trim());
    if (cols.length < 2) continue;

    // Bỏ qua dòng tiêu đề hoặc dòng tổng cộng
    const firstNorm = cols[0].toLowerCase();
    if (firstNorm === 'stt' || firstNorm.includes('tổng cộng') || firstNorm.includes('tong cong')) continue;

    // Nếu cột đầu là số STT (1, 2, 3...) và có >= 4 cột -> bỏ cột STT
    if (/^\d+\.?$/.test(cols[0]) && cols.length >= 4) {
      cols = cols.slice(1);
    }

    const name = cols[0] || '';
    if (!name || name.toLowerCase().includes('tổng cộng')) continue;

    let spec = '', unit = '', qty = 1, unitPrice = 0, totalPrice = 0;
    if (cols.length >= 6) {
      spec = cols[1]; unit = cols[2]; qty = parseVnNumberClient(cols[3]) || 1; unitPrice = parseVnNumberClient(cols[4]); totalPrice = parseVnNumberClient(cols[5]);
    } else if (cols.length === 5) {
      spec = cols[1]; unit = cols[2]; qty = parseVnNumberClient(cols[3]) || 1; unitPrice = parseVnNumberClient(cols[4]); totalPrice = Math.round(qty * unitPrice);
    } else if (cols.length === 4) {
      unit = cols[1]; qty = parseVnNumberClient(cols[2]) || 1; unitPrice = parseVnNumberClient(cols[3]); totalPrice = Math.round(qty * unitPrice);
    } else if (cols.length === 3) {
      qty = parseVnNumberClient(cols[1]) || 1; unitPrice = parseVnNumberClient(cols[2]); totalPrice = Math.round(qty * unitPrice);
    } else if (cols.length === 2) {
      qty = 1; totalPrice = parseVnNumberClient(cols[1]); unitPrice = totalPrice;
    }

    if (unitPrice === 0 && totalPrice > 0 && qty > 0) unitPrice = Math.round(totalPrice / qty);
    if (totalPrice === 0 && unitPrice > 0 && qty > 0) totalPrice = Math.round(unitPrice * qty);

    items.push({
      category: 'Hóa chất & Vật tư thí nghiệm',
      item_name: name,
      specification: spec,
      unit: unit,
      approved_quantity: qty,
      unit_price: unitPrice,
      total_price: totalPrice,
      notes: ''
    });
  }

  if (items.length === 0) {
    showToast('Không tách được dòng hợp lệ nào. Hãy copy trực tiếp các dòng bảng từ Excel/Google Sheet.', 'error');
    return;
  }

  try {
    const res = await fetch(`/api/supplies/budget/${currentProjectId}/import-excel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'append', items_json: JSON.stringify(items) })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message || `Đã thêm ${items.length} hạng mục từ bảng dán!`, 'success');
      if (ta) ta.value = '';
      toggleReconcilePasteBox(false);
      await loadProject();
    } else {
      showToast(json.error || 'Lỗi lưu dữ liệu dán', 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

async function confirmLockFromReconcileModal() {
  const doc = currentProjectData?.budget_analytics?.legal_status?.red_seal_doc;
  await handleLockBudgetBaseline(doc ? doc.id : null);
}

async function deleteBudgetItem(itemId, name) {
  if (!confirm(`Bạn có chắc chắn muốn xóa hạng mục dự toán "${name}"?`)) return;
  try {
    const res = await fetch(`/api/supplies/budget/item/${itemId}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      showToast('Đã xóa hạng mục dự toán', 'success');
      loadProject();
    } else {
      showToast(json.error || 'Không thể xóa hạng mục', 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

// Modal Import Excel (BM02) / CSV Dự toán
let pendingImportBudgetItems = [];

function openImportBudgetExcelModal() {
  pendingImportBudgetItems = [];
  const fileIn = document.getElementById('importBudgetFileInput');
  if (fileIn) fileIn.value = '';
  const prevBox = document.getElementById('importBudgetPreviewBox');
  if (prevBox) prevBox.style.display = 'none';
  const btn = document.getElementById('btnConfirmImportBudget');
  if (btn) btn.disabled = true;
  document.getElementById('importBudgetExcelModal').classList.add('active');
}

async function previewBudgetExcelImport() {
  const fileIn = document.getElementById('importBudgetFileInput');
  if (!fileIn || !fileIn.files || fileIn.files.length === 0) {
    showToast('Vui lòng chọn tệp Excel (.xlsx) hoặc CSV trước.', 'error');
    return;
  }
  const fd = new FormData();
  fd.append('file', fileIn.files[0]);
  fd.append('mode', 'preview');

  try {
    const res = await fetch(`/api/supplies/budget/${currentProjectId}/import-excel`, {
      method: 'POST',
      body: fd
    });
    const json = await res.json();
    if (!json.success) {
      showToast(json.error || 'Không thể đọc tệp Excel', 'error');
      return;
    }
    pendingImportBudgetItems = json.items || [];
    const prevBox = document.getElementById('importBudgetPreviewBox');
    const summaryEl = document.getElementById('importBudgetPreviewSummary');
    const tbody = document.getElementById('importBudgetPreviewBody');
    const btn = document.getElementById('btnConfirmImportBudget');

    if (summaryEl) {
      summaryEl.innerHTML = `Đã đọc được <span style="color:#15803d;">${json.count} hạng mục</span> • Tổng giá trị: <span style="color:#0284c7;">${Number(json.total_value || 0).toLocaleString('vi-VN')} đ</span>`;
    }
    if (tbody) {
      tbody.innerHTML = pendingImportBudgetItems.map((it, i) => `
        <tr>
          <td style="text-align:center;">${i + 1}</td>
          <td><strong>${escapeHtml(it.item_name)}</strong><div style="font-size:0.68rem; color:#64748b;">${escapeHtml(it.category || '')}</div></td>
          <td>${escapeHtml(it.specification || '-')}</td>
          <td>${escapeHtml(it.unit || '-')}</td>
          <td style="text-align:center; font-weight:700;">${it.approved_quantity}</td>
          <td style="text-align:right;">${Number(it.unit_price || 0).toLocaleString('vi-VN')} đ</td>
          <td style="text-align:right; font-weight:700;">${Number(it.total_price || 0).toLocaleString('vi-VN')} đ</td>
        </tr>
      `).join('');
    }
    if (prevBox) prevBox.style.display = 'block';
    if (btn) btn.disabled = pendingImportBudgetItems.length === 0;
  } catch (err) {
    showToast('Lỗi đọc tệp: ' + err.message, 'error');
  }
}

async function confirmBudgetExcelImport() {
  if (!pendingImportBudgetItems.length) return;
  const mode = (document.getElementById('importBudgetModeSelect') || {}).value || 'append';
  if (mode === 'replace' && !confirm('Chế độ Thay thế sẽ xóa toàn bộ hạng mục dự toán hiện tại của đề tài này và thay bằng danh sách mới. Tiếp tục?')) {
    return;
  }
  try {
    const res = await fetch(`/api/supplies/budget/${currentProjectId}/import-excel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, items_json: JSON.stringify(pendingImportBudgetItems) })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message || 'Import dự toán thành công!', 'success');
      closeModal('importBudgetExcelModal');
      loadProject();
    } else {
      showToast(json.error || 'Lỗi import', 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

// Modal Chủ nhiệm Xin cấp hóa chất (Kèm kiểm tra Quota trực tiếp)
function openRequestSupplyModal() {
  document.getElementById('requestSupplyForm').reset();
  const qBox = document.getElementById('supplyQuotaInfoBox');
  const wBox = document.getElementById('supplyOverQuotaWarning');
  if (qBox) qBox.style.display = 'none';
  if (wBox) wBox.style.display = 'none';
  document.getElementById('requestSupplyModal').classList.add('active');
  checkRequestSupplyQuotaLive();
}

function handleSelectBudgetItem(select) {
  const opt = select.options[select.selectedIndex];
  const qBox = document.getElementById('supplyQuotaInfoBox');
  if (opt && select.value) {
    document.getElementById('reqItemName').value = opt.getAttribute('data-name') || opt.text.split('—')[0].trim();
    document.getElementById('reqSpec').value = opt.getAttribute('data-spec') || '';
    document.getElementById('reqUnit').value = opt.getAttribute('data-unit') || '';
    const priceIn = document.getElementById('reqUnitPrice');
    if (priceIn) priceIn.value = opt.getAttribute('data-price') || 0;

    const approved = Number(opt.getAttribute('data-approved')) || 0;
    const requested = Number(opt.getAttribute('data-requested')) || 0;
    const remaining = Number(opt.getAttribute('data-remaining')) || 0;
    const unit = opt.getAttribute('data-unit') || '';
    if (qBox) {
      qBox.style.display = 'block';
      qBox.innerHTML = `<strong>Hạn mức dự toán (Quota):</strong> Đã duyệt <strong>${approved} ${escapeHtml(unit)}</strong> • Đã đề xuất trước đó: <strong>${requested}</strong> • Hạn mức còn lại: <strong style="color:${remaining <= 0 ? '#dc2626' : '#15803d'};">${remaining} ${escapeHtml(unit)}</strong>`;
    }
  } else if (qBox) {
    qBox.style.display = 'none';
  }
  checkRequestSupplyQuotaLive();
}

function checkRequestSupplyQuotaLive() {
  const select = document.getElementById('budgetSelectDropdown');
  const qtyIn = document.getElementById('reqQtyInput');
  const wBox = document.getElementById('supplyOverQuotaWarning');
  if (!wBox) return;

  const qty = Number(qtyIn ? qtyIn.value : 0) || 0;
  if (!select || !select.value) {
    if (qty > 0) {
      wBox.style.display = 'block';
      wBox.innerHTML = `<strong><i class="fa-solid fa-triangle-exclamation"></i> Cảnh báo Ngoài dự toán:</strong> Hạng mục này chưa thuộc danh mục dự toán đã duyệt. Yêu cầu vẫn được gửi nhưng sẽ gắn cờ <strong>Ngoài dự toán</strong> để P. KH&amp;CN / Viện trưởng xem xét.`;
    } else {
      wBox.style.display = 'none';
    }
    return;
  }

  const opt = select.options[select.selectedIndex];
  const remaining = Number(opt.getAttribute('data-remaining')) || 0;
  const unit = opt.getAttribute('data-unit') || '';

  if (qty > remaining) {
    const over = Number((qty - remaining).toFixed(2));
    wBox.style.display = 'block';
    wBox.innerHTML = `<strong><i class="fa-solid fa-triangle-exclamation"></i> Cảnh báo Vượt định mức (+${over} ${escapeHtml(unit)}):</strong> Số lượng xin cấp (${qty}) vượt hạn mức còn lại (${remaining}). Hệ thống vẫn cho phép gửi nhưng sẽ gắn cờ đỏ <strong>Vượt định mức</strong> để P. KH&amp;CN / Viện trưởng thẩm định.`;
  } else {
    wBox.style.display = 'none';
  }
}

async function handleRequestSupply(e) {
  e.preventDefault();
  const formData = new FormData(e.target);
  const payload = Object.fromEntries(formData.entries());

  try {
    const res = await fetch(`/api/supplies/project/${currentProjectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.warning || json.message || 'Đã gửi yêu cầu cấp phát hóa chất!', json.warning ? 'error' : 'success');
      closeModal('requestSupplyModal');
      loadProject();
    } else {
      showToast(json.error || 'Lỗi gửi yêu cầu', 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<i class="fa-solid fa-${type === 'success' ? 'circle-check' : 'circle-exclamation'}"></i> ${message}`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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

// Tải thông tin Kiểm toán cho Đề tài hiện tại
async function loadAuditForProject(projectId) {
  const box = document.getElementById('auditProjectSummaryBox');
  if (!box) return;

  try {
    const res = await fetch(`/api/audit/projects/${projectId}`);
    const json = await res.json();
    if (!json.success || !json.data) {
      box.innerHTML = '<div style="color:#94a3b8; font-size:0.8rem;">Chưa có dữ liệu kiểm toán.</div>';
      return;
    }

    const p = json.data;
    const a = p.audit;
    let color = 'var(--primary)';
    if (a.percentage === 100) color = 'var(--color-green)';
    else if (a.percentage < 50) color = 'var(--color-red)';
    else if (a.percentage < 75) color = 'var(--color-yellow)';

    const missingItems = (a.items || []).filter(i => i.required && i.status === 'MISSING');
    const submittedItems = (a.items || []).filter(i => i.status === 'UPLOADED' || i.status === 'VERIFIED');

    let missingHtml = '';
    if (missingItems.length === 0) {
      missingHtml = '<div style="font-size:0.8rem; color:var(--color-green); font-weight:600;"><i class="fa-solid fa-circle-check"></i> Đủ 100% hồ sơ phục vụ kiểm toán!</div>';
    } else {
      missingHtml = `
        <div style="font-size:0.78rem; color:#b91c1c; font-weight:700; margin-bottom:6px;">
          <i class="fa-solid fa-triangle-exclamation"></i> Còn thiếu ${missingItems.length} văn bản cần bổ sung:
        </div>
        <div style="display:flex; flex-direction:column; gap:5px; max-height: 220px; overflow-y: auto; padding-right: 4px;">
          ${missingItems.map(item => {
            const canUpload = typeof window.canUserUploadCriteria === 'function'
              ? window.canUserUploadCriteria(item.allowed_upload_roles, p.leader_name)
              : true;
            return `
              <div style="font-size:0.74rem; color:#334155; display:flex; align-items:center; justify-content:space-between; gap:6px; background:#ffffff; padding:5px 8px; border-radius:6px; border:1px solid #fecaca;">
                <div style="flex:1;">
                  <i class="fa-solid fa-circle-xmark" style="color:var(--color-red); font-size:0.72rem;"></i>
                  <strong>${escapeHtml(item.name)}</strong>
                  <span style="font-size:0.66rem; color:#64748b;">(${escapeHtml(item.owner_label || '')})</span>
                </div>
                ${canUpload
                  ? `<button class="btn btn-primary btn-sm" style="padding:2px 7px; font-size:0.68rem;" onclick="openUploadModalForCriteria('${item.key}', ${item.stage}, '${escapeHtml(item.name)}')"><i class="fa-solid fa-upload"></i> Upload</button>`
                  : `<span style="font-size:0.66rem; color:#94a3b8; white-space:nowrap;"><i class="fa-solid fa-lock"></i> ${escapeHtml(item.owner_label)}</span>`}
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    const submittedSummaryHtml = submittedItems.length > 0 ? `
      <div style="margin-top:8px; padding-top:8px; border-top:1px dashed #cbd5e1;">
        <div style="font-size:0.75rem; color:#15803d; font-weight:700; margin-bottom:4px;">
          <i class="fa-solid fa-circle-check"></i> Đã nộp / Đã xác thực (${submittedItems.length} mục):
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:4px;">
          ${submittedItems.map(item => `
            <span style="font-size:0.68rem; background:#dcfce7; color:#166534; padding:2px 6px; border-radius:4px; font-weight:600;">
              <i class="fa-solid fa-check"></i> ${escapeHtml(item.name)}
            </span>
          `).join('')}
        </div>
      </div>
    ` : '';

    box.innerHTML = `
      <div style="background:#f8fafc; border:1px solid var(--border-color); border-radius:8px; padding:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span style="font-size:0.8rem; font-weight:600; color:#334155;">Mức độ hoàn thiện hồ sơ:</span>
          <strong style="color:${color}; font-size:0.9rem;">${a.percentage}% (${a.completed_count}/${a.total_required} mục)</strong>
        </div>
        <div class="audit-progress-container" style="margin-bottom:10px;">
          <div class="audit-progress-bar" style="width:${a.percentage}%; background:${color};"></div>
        </div>
        ${missingHtml}
        ${submittedSummaryHtml}
        <div style="margin-top:10px; display:flex; justify-content:space-between; align-items:center;">
          <button class="btn btn-outline btn-sm" style="font-size:0.72rem;" onclick="switchTabById('tab-docs')">
            <i class="fa-solid fa-folder-tree"></i> Sang Tab Hồ sơ 7 Giai đoạn
          </button>
          <a href="/kiem-tra-ho-so.html" class="btn btn-outline btn-sm" style="font-size:0.72rem;">
            Bảng Kiểm toán Toàn Viện <i class="fa-solid fa-arrow-right"></i>
          </a>
        </div>
      </div>
    `;
  } catch (err) {
    box.innerHTML = `<div style="color:#94a3b8; font-size:0.8rem;">Lỗi tải kiểm toán: ${err.message}</div>`;
  }
}

// ==============================================================
// XỬ LÝ QUY TRÌNH ĐIỀU CHỈNH DỰ TOÁN KINH PHÍ (4 BƯỚC)
// ==============================================================

let currentBudgetAdjustments = [];

// 1. Tải danh sách lịch sử các lần điều chỉnh dự toán
async function loadBudgetAdjustments() {
  const tbody = document.getElementById('budgetAdjustmentsTableBody');
  if (!tbody || !currentProjectId) return;

  try {
    const res = await fetch(`/api/projects/${currentProjectId}/budget-adjustments`);
    const json = await res.json();
    if (json.success) {
      currentBudgetAdjustments = json.data.adjustments || [];
      renderBudgetAdjustmentsTable(currentBudgetAdjustments);
      if (currentProjectData) {
        currentProjectData.budget_adjustments = currentBudgetAdjustments;
        renderProjectMilestoneTimeline(currentProjectData);
      }
    } else {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--color-red); padding:1rem;">Lỗi: ${json.error}</td></tr>`;
    }
  } catch (err) {
    console.error('Lỗi tải lịch sử điều chỉnh dự toán:', err);
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#94a3b8; padding:1rem;">Chưa có dữ liệu điều chỉnh (${err.message})</td></tr>`;
  }
}

// 2. Render bảng danh sách lịch sử điều chỉnh dự toán
function renderBudgetAdjustmentsTable(adjustments) {
  const tbody = document.getElementById('budgetAdjustmentsTableBody');
  if (!tbody) return;

  if (!adjustments || adjustments.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; padding: 1.5rem; color: var(--text-muted);">
          Chưa phát sinh điều chỉnh dự toán.
        </td>
      </tr>
    `;
    return;
  }

  const activeRole = typeof window.getCurrentRole === 'function' ? window.getCurrentRole() : 'PHONG_KHCN';
  const canKhcnReview = ['PHONG_KHCN', 'SUPER_ADMIN', 'PHONG_TC_CU'].includes(activeRole);
  const canDirectorApprove = ['VIEN_TRUONG', 'SUPER_ADMIN'].includes(activeRole);

  tbody.innerHTML = adjustments.map(adj => {
    // Trạng thái badge
    let statusBadge = '';
    let actionBtn = '';

    if (adj.status === 'PENDING') {
      statusBadge = '<span class="badge badge-yellow">Chờ P. KH&amp;CN thẩm tra</span>';
      actionBtn = canKhcnReview ? `
        <button class="btn btn-outline btn-sm" onclick="openKhcnReviewModal(${adj.id})">
          Thẩm tra
        </button>
      ` : `<span style="font-size: 0.72rem; color: #64748b;">Chờ P. KH&amp;CN</span>`;
    } else if (adj.status === 'KHCN_REVIEWED') {
      statusBadge = '<span class="badge badge-purple">Chờ Viện trưởng phê duyệt</span>';
      actionBtn = canDirectorApprove ? `
        <button class="btn btn-primary btn-sm" onclick="openDirectorApproveModal(${adj.id})" style="background:#7e22ce; border-color:#7e22ce;">
          Phê duyệt
        </button>
      ` : `<span style="font-size: 0.72rem; color: #7e22ce;">Chờ Viện trưởng</span>`;
    } else if (adj.status === 'APPROVED') {
      statusBadge = '<span class="badge badge-green">Đã phê duyệt</span>';
      actionBtn = `<span style="font-size: 0.74rem; color: #15803d; font-weight: 600;">Hoàn tất</span>`;
    } else {
      statusBadge = '<span class="badge badge-red">Không đạt / Yêu cầu sửa</span>';
      actionBtn = `<span style="font-size: 0.72rem; color: #b91c1c;">Cần chỉnh sửa</span>`;
    }

    const diffNum = Number(adj.difference_amount || 0);
    const diffFormatted = (diffNum > 0 ? '+' : '') + diffNum.toLocaleString('vi-VN') + ' đ';
    const diffColor = diffNum > 0 ? '#15803d' : (diffNum < 0 ? '#b91c1c' : '#0284c7');
    const isInternalRealloc = diffNum === 0;

    return `
      <tr id="adj-row-${adj.id}">
        <td style="text-align: center; font-weight: 700; color: #475569;">Lần ${adj.adjustment_num}</td>
        <td style="font-size: 0.8rem; color: #64748b;">${escapeHtml(adj.request_date)}</td>
        <td>
          <div style="font-size: 0.82rem;">
            <span style="text-decoration: line-through; color: #94a3b8;">${Number(adj.old_budget).toLocaleString('vi-VN')} đ</span><br>
            ➔ <strong style="color: #7e22ce;">${Number(adj.new_budget).toLocaleString('vi-VN')} đ</strong>
          </div>
          <div style="font-size: 0.72rem; color: ${diffColor}; font-weight: 600; margin-top: 2px;">
            ${isInternalRealloc ? '<span class="badge badge-blue" style="font-size:0.68rem;">Điều chuyển nội bộ (0 đ)</span>' : `Chênh lệch: ${diffFormatted}`}
          </div>
        </td>
        <td>
          <div style="font-weight: 600; font-size: 0.82rem; color: #0f172a;">${escapeHtml(adj.reason)}</div>
          ${adj.proposal_details ? `<div style="font-size: 0.72rem; color: #64748b; margin-top: 2px;">Chi tiết: ${escapeHtml(adj.proposal_details)}</div>` : ''}
          <div style="margin-top: 5px; display: flex; gap: 5px; flex-wrap: wrap;">
            <a href="/api/projects/${currentProjectId}/export-autofill/TO_TRINH_DIEU_CHINH_DU_TOAN?adjId=${adj.id}" target="_blank" class="btn btn-outline btn-sm" style="padding: 2px 8px; font-size: 0.71rem; color: #0284c7; border-color: #7dd3fc; background: #f0f9ff; text-decoration: none;">
              Tải mẫu Tờ trình (.docx)
            </a>
            ${adj.request_file_id ? `
              <button type="button" class="btn btn-outline btn-sm" style="padding: 2px 8px; font-size: 0.71rem;" onclick="jumpToMilestoneDetailTarget('preview', ${adj.request_file_id}, 'Tờ trình điều chỉnh dự toán Lần ${adj.adjustment_num}')">
                Xem Tờ trình đã ký
              </button>
            ` : ''}
          </div>
        </td>
        <td>
          ${adj.khcn_opinion 
            ? `<div style="font-size: 0.75rem; color: #0f172a; line-height: 1.3;">
                ${escapeHtml(adj.khcn_opinion)}
               </div>
               <div style="font-size: 0.68rem; color: #64748b; margin-top: 2px;">
                 ${escapeHtml(adj.khcn_reviewed_by || 'Phòng KH&CN')} (${escapeHtml(adj.khcn_reviewed_at || '')})
               </div>`
            : '<span style="color: #64748b; font-size: 0.75rem;">Chờ thẩm tra</span>'}
        </td>
        <td>
          ${adj.decision_number 
            ? `<div style="font-size: 0.8rem; font-weight: 700; color: #15803d;">
                ${escapeHtml(adj.decision_number)}
               </div>
               <div style="font-size: 0.72rem; color: #475569;">
                 Ngày ký: ${escapeHtml(adj.decision_date)} • ${escapeHtml(adj.approved_by || 'Viện trưởng')}
               </div>
               ${adj.decision_file_id ? `
                 <button type="button" class="btn btn-outline btn-sm" style="margin-top:4px; padding:2px 8px; font-size:0.71rem; color:#15803d; border-color:#86efac; background:#f0fdf4; font-weight:600;" onclick="jumpToMilestoneDetailTarget('preview', ${adj.decision_file_id}, 'QĐ Điều chỉnh dự toán số ${escapeHtml(adj.decision_number)}')">
                   <i class="fa-solid fa-file-pdf"></i> Xem QĐ (Mộc đỏ)
                 </button>
               ` : ''}`
            : '<span style="color: #64748b; font-size: 0.75rem;">Chưa ban hành</span>'}
        </td>
        <td style="text-align: center;">${statusBadge}</td>
        <td style="text-align: center;">${actionBtn}</td>
      </tr>
    `;
  }).join('');
}

// 3. Mở Modal Đề xuất điều chỉnh dự toán (Chủ nhiệm)
function openBudgetAdjustmentModal() {
  if (!currentProjectData) return;
  const currentBudget = currentProjectData.budget_revised || currentProjectData.budget_total || 0;
  document.getElementById('budgetAdjustmentForm').reset();
  document.getElementById('adjCurrentBudget').value = Number(currentBudget).toLocaleString('vi-VN') + ' đ';
  document.getElementById('adjNewBudget').value = currentBudget;
  const listEl = document.getElementById('adjItemChangesList');
  if (listEl) {
    listEl.innerHTML = '<div class="adj-empty-hint" style="font-size: 0.75rem; color: #64748b;">Chưa chọn hạng mục điều chỉnh cụ thể (bấm "+ Thêm dòng điều chỉnh" để tăng/giảm SL, điều chuyển nội bộ hoặc bổ sung hạng mục mới).</div>';
  }
  const calcBar = document.getElementById('adjAutoCalcBar');
  if (calcBar) calcBar.style.display = 'none';
  document.getElementById('budgetAdjustmentModal').classList.add('active');
}

function addAdjItemChangeRow() {
  const listEl = document.getElementById('adjItemChangesList');
  if (!listEl) return;
  const hint = listEl.querySelector('.adj-empty-hint');
  if (hint) hint.remove();

  const budgetItems = (currentProjectData && currentProjectData.budget_items) ? currentProjectData.budget_items : [];
  const rowDiv = document.createElement('div');
  rowDiv.className = 'adj-item-change-row';
  rowDiv.style.cssText = 'display:grid; grid-template-columns: 1.8fr 0.8fr 1fr auto; gap:6px; align-items:center; background:#fff; border:1px solid #cbd5e1; border-radius:5px; padding:6px;';
  rowDiv.innerHTML = `
    <select class="form-control adj-ch-item" style="font-size:0.76rem; padding:4px;" onchange="onAdjItemSelectChange(this)">
      <option value="__NEW__">+ Bổ sung hạng mục mới...</option>
      ${budgetItems.map(b => `<option value="${b.id}" data-qty="${b.approved_quantity}" data-rec="${b.total_received_qty || 0}" data-price="${b.unit_price || 0}">${escapeHtml(b.item_name)} (Duyệt: ${b.approved_quantity} | Đã cấp: ${b.total_received_qty || 0})</option>`).join('')}
    </select>
    <input type="number" class="form-control adj-ch-qty" placeholder="SL mới" step="any" min="0" style="font-size:0.76rem; padding:4px;" oninput="recalcBudgetAdjustmentTotals()">
    <input type="number" class="form-control adj-ch-price" placeholder="Đơn giá mới" min="0" style="font-size:0.76rem; padding:4px;" oninput="recalcBudgetAdjustmentTotals()">
    <button type="button" class="btn btn-outline btn-sm" style="padding:3px 7px; color:#dc2626;" onclick="this.parentElement.remove(); recalcBudgetAdjustmentTotals();">&times;</button>
    <input type="text" class="form-control adj-ch-newname" placeholder="Tên hạng mục bổ sung mới (nếu chọn Bổ sung mới)..." style="grid-column: 1 / -1; font-size:0.75rem; padding:4px; margin-top:2px;">
    <div class="adj-ch-warn" style="display:none; grid-column: 1 / -1; font-size:0.72rem; color:#dc2626; font-weight:600;"></div>
  `;
  listEl.appendChild(rowDiv);
  recalcBudgetAdjustmentTotals();
}

function onAdjItemSelectChange(select) {
  const row = select.closest('.adj-item-change-row');
  const nameIn = row.querySelector('.adj-ch-newname');
  const qtyIn = row.querySelector('.adj-ch-qty');
  const priceIn = row.querySelector('.adj-ch-price');
  if (select.value === '__NEW__') {
    if (nameIn) nameIn.style.display = 'block';
    if (qtyIn) qtyIn.min = 0;
  } else {
    const opt = select.options[select.selectedIndex];
    if (nameIn) nameIn.style.display = 'none';
    if (qtyIn) {
      qtyIn.value = opt.getAttribute('data-qty') || '';
      qtyIn.min = opt.getAttribute('data-rec') || 0;
    }
    if (priceIn) priceIn.value = opt.getAttribute('data-price') || 0;
  }
  recalcBudgetAdjustmentTotals();
}

function recalcBudgetAdjustmentTotals() {
  const rows = document.querySelectorAll('#adjItemChangesList .adj-item-change-row');
  const calcBar = document.getElementById('adjAutoCalcBar');
  const newBudgetInput = document.getElementById('adjNewBudget');
  if (!currentProjectData || rows.length === 0) {
    if (calcBar) calcBar.style.display = 'none';
    return;
  }

  const baseBudget = Number(currentProjectData.budget_revised || currentProjectData.budget_total || 0);
  let totalDelta = 0;
  let hasReductionError = false;

  rows.forEach(row => {
    const sel = row.querySelector('.adj-ch-item');
    const qty = Number(row.querySelector('.adj-ch-qty').value) || 0;
    const price = Number(row.querySelector('.adj-ch-price').value) || 0;
    const warnEl = row.querySelector('.adj-ch-warn');

    if (sel.value === '__NEW__') {
      totalDelta += Math.round(qty * price);
      if (warnEl) warnEl.style.display = 'none';
    } else {
      const opt = sel.options[sel.selectedIndex];
      const oldQty = Number(opt.getAttribute('data-qty')) || 0;
      const oldPrice = Number(opt.getAttribute('data-price')) || 0;
      const recQty = Number(opt.getAttribute('data-rec')) || 0;
      totalDelta += Math.round((qty * price) - (oldQty * oldPrice));

      if (qty < recQty) {
        hasReductionError = true;
        if (warnEl) {
          warnEl.style.display = 'block';
          warnEl.innerText = `Không hợp lệ: SL mới (${qty}) thấp hơn SL đã cấp phát thực tế (${recQty})!`;
        }
      } else if (warnEl) {
        warnEl.style.display = 'none';
      }
    }
  });

  const computedNew = Math.max(0, baseBudget + totalDelta);
  if (newBudgetInput) newBudgetInput.value = computedNew;

  if (calcBar) {
    calcBar.style.display = 'block';
    const deltaStr = (totalDelta > 0 ? '+' : '') + totalDelta.toLocaleString('vi-VN') + ' đ';
    const typeLabel = totalDelta === 0
      ? '<span class="badge badge-blue" style="font-size:0.7rem;">Điều chuyển nội bộ (Không đổi tổng kinh phí)</span>'
      : (totalDelta > 0
        ? '<span class="badge badge-yellow" style="font-size:0.7rem;">Điều chỉnh tăng tổng kinh phí</span>'
        : '<span class="badge badge-green" style="font-size:0.7rem;">Điều chỉnh giảm tổng kinh phí</span>');
    calcBar.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
        <span>Chênh lệch từ các hạng mục: <strong style="color:${totalDelta > 0 ? '#b45309' : '#15803d'};">${deltaStr}</strong> ➔ Dự toán mới: <strong>${computedNew.toLocaleString('vi-VN')} đ</strong></span>
        ${typeLabel}
      </div>
      ${hasReductionError ? '<div style="color:#dc2626; font-weight:700; margin-top:4px;">Có hạng mục giảm thấp hơn SL đã cấp phát thực tế — vui lòng sửa trước khi trình!</div>' : ''}
    `;
  }
}

// 4. Xử lý nộp Tờ trình xin điều chỉnh dự toán (Bước 1)
async function handleSubmitBudgetAdjustment(e) {
  e.preventDefault();
  const form = e.target;
  const newBudget = form.new_budget.value;
  const reason = form.reason.value;
  const proposalDetails = form.proposal_details.value;
  const fileInput = document.getElementById('adjSignedRequestFileInput');

  // Thu thập & kiểm tra an toàn danh sách thay đổi hạng mục chi tiết
  const itemChanges = [];
  let reductionBlocked = false;
  document.querySelectorAll('#adjItemChangesList .adj-item-change-row').forEach(row => {
    const selEl = row.querySelector('.adj-ch-item');
    const sel = selEl.value;
    const qty = Number(row.querySelector('.adj-ch-qty').value);
    const price = Number(row.querySelector('.adj-ch-price').value) || 0;
    const newName = (row.querySelector('.adj-ch-newname')?.value || '').trim();
    if (sel === '__NEW__' && newName) {
      itemChanges.push({ action: 'ADD', item_name: newName, new_quantity: qty || 1, new_unit_price: price });
    } else if (sel && sel !== '__NEW__') {
      const recQty = Number(selEl.options[selEl.selectedIndex].getAttribute('data-rec')) || 0;
      if (qty < recQty) reductionBlocked = true;
      itemChanges.push({ action: 'UPDATE', budget_item_id: Number(sel), new_quantity: qty, new_unit_price: price });
    }
  });

  if (reductionBlocked) {
    showToast('Không thể trình: Có hạng mục giảm số lượng thấp hơn số lượng đã cấp phát thực tế.', 'error');
    return;
  }

  try {
    // 1. Nếu có chọn tệp Tờ trình có chữ ký -> tải lên Kho hồ sơ Giai đoạn 3 trước
    let requestFileId = null;
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      const upForm = new FormData();
      upForm.append('file', fileInput.files[0]);
      upForm.append('stage', '3');
      upForm.append('doc_type', 'DON_DIEU_CHINH_DU_TOAN');
      upForm.append('title', `Tờ trình đề xuất điều chỉnh dự toán - Đề tài ${currentProjectData ? currentProjectData.code : ''}`);
      upForm.append('notes', reason);
      upForm.append('uploaded_by', getCurrentRoleLabelVn());

      const upRes = await fetch(`/api/documents/upload/${currentProjectId}`, { method: 'POST', body: upForm });
      const upJson = await upRes.json();
      if (!upJson.success) {
        showToast(upJson.error || 'Lỗi tải tệp Tờ trình điều chỉnh dự toán', 'error');
        return;
      }
      requestFileId = upJson.id || (upJson.data && upJson.data.id) || null;
    }

    const res = await fetch(`/api/projects/${currentProjectId}/budget-adjustments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        new_budget: newBudget,
        reason: reason,
        proposal_details: proposalDetails,
        item_changes: itemChanges,
        request_file_id: requestFileId
      })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message, 'success');
      closeModal('budgetAdjustmentModal');
      loadBudgetAdjustments();
      loadProject();
    } else {
      showToast(json.error || 'Lỗi nộp tờ trình', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối máy chủ: ' + err.message, 'error');
  }
}

// 5. Mở Modal P. KHCN thẩm tra (Bước 2)
function openKhcnReviewModal(adjId) {
  document.getElementById('khcnAdjId').value = adjId;
  document.getElementById('khcnOpinionInput').value = 'Đồng ý đề xuất điều chuyển kinh phí sang nhóm hóa chất/sinh phẩm phù hợp mục tiêu đề tài, đúng định mức chi tiêu nội bộ của Viện.';
  document.getElementById('khcnReviewModal').classList.add('active');
}

// 6. Xử lý P. KHCN thẩm tra (Bước 2)
async function handleKhcnReviewSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const adjId = form.adjId.value;
  const opinion = form.opinion.value;
  const status = form.status.value;

  try {
    const res = await fetch(`/api/projects/${currentProjectId}/budget-adjustments/${adjId}/khcn-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opinion, status })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message, 'success');
      closeModal('khcnReviewModal');
      loadBudgetAdjustments();
    } else {
      showToast(json.error || 'Lỗi thẩm tra', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối máy chủ: ' + err.message, 'error');
  }
}

// 7. Mở Modal Viện trưởng phê duyệt (Bước 3 & 4 - Bắt buộc có bản scan QĐ mộc đỏ)
function openDirectorApproveModal(adjId) {
  document.getElementById('directorApproveForm').reset();
  document.getElementById('directorAdjId').value = adjId;
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('decDateInput').value = today;
  document.getElementById('decNumberInput').value = `QĐ-SCI.${currentProjectId}/ĐC-DT`;

  const existingNote = document.getElementById('directorAdjExistingFileNote');
  if (existingNote) {
    const allDocs = (currentProjectData && currentProjectData.documents) ? currentProjectData.documents : [];
    const existingQd = allDocs.find(d => d.doc_type === 'QD_DIEU_CHINH_DU_TOAN');
    if (existingQd) {
      existingNote.innerHTML = `Hiện đã có tệp QĐ trên hệ thống: <strong>${escapeHtml(existingQd.file_name)}</strong>. Chọn tệp mới nếu đây là đợt điều chỉnh tiếp theo.`;
    } else {
      existingNote.innerHTML = `<span style="color:#b91c1c;">Bắt buộc tải lên tệp PDF Quyết định điều chỉnh dự toán có chữ ký Viện trưởng &amp; dấu mộc đỏ.</span>`;
    }
  }
  document.getElementById('directorApproveModal').classList.add('active');
}

// 8. Xử lý Viện trưởng phê duyệt & Cập nhật hệ thống (Bước 3 & 4)
async function handleDirectorApproveSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const adjId = form.adjId.value;
  const decisionNumber = form.decision_number.value.trim();
  const decisionDate = form.decision_date.value;
  const directorDecision = form.director_decision.value;
  const fileInput = document.getElementById('directorAdjDecisionFileInput');

  try {
    let decisionFileId = null;
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      const upForm = new FormData();
      upForm.append('file', fileInput.files[0]);
      upForm.append('stage', '3');
      upForm.append('doc_type', 'QD_DIEU_CHINH_DU_TOAN');
      upForm.append('title', `Quyết định phê duyệt điều chỉnh dự toán số ${decisionNumber} - Đề tài ${currentProjectData ? currentProjectData.code : ''}`);
      upForm.append('notes', directorDecision || `Viện trưởng ký duyệt ngày ${decisionDate}`);
      upForm.append('uploaded_by', getCurrentRoleLabelVn());

      const upRes = await fetch(`/api/documents/upload/${currentProjectId}`, { method: 'POST', body: upForm });
      const upJson = await upRes.json();
      if (!upJson.success) {
        showToast(upJson.error || 'Lỗi khi tải lên bản scan Quyết định mộc đỏ', 'error');
        return;
      }
      decisionFileId = upJson.id || (upJson.data && upJson.data.id) || null;
    }

    const res = await fetch(`/api/projects/${currentProjectId}/budget-adjustments/${adjId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision_number: decisionNumber,
        decision_date: decisionDate,
        director_decision: directorDecision,
        decision_file_id: decisionFileId
      })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message, 'success');
      closeModal('directorApproveModal');
      loadBudgetAdjustments();
      loadProject(); // Cập nhật lại số liệu kinh phí, Quota & tài liệu kiểm toán
    } else {
      showToast(json.error || 'Lỗi phê duyệt', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối máy chủ: ' + err.message, 'error');
  }
}

// ==============================================================
// DÒNG THỜI GIAN LỊCH SỬ & MILESTONE SỰ KIỆN ĐỀ TÀI (360° OVERVIEW)
// ==============================================================

let activeMilestoneStep = 3; // Mặc định mở mốc trọng tâm hoặc tự động chọn mốc hiện tại
let isMilestoneDetailCollapsed = false;

function parseClientDateScore(dateStr) {
  if (!dateStr) return 0;
  const s = String(dateStr).trim();
  if (!s) return 0;
  const parts = s.split(/[\/\-]/);
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).getTime() || 0;
    }
    return new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0])).getTime() || 0;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function renderProjectMilestoneTimeline(p) {
  const trackEl = document.getElementById('milestoneStepperTrack');
  const panelsEl = document.getElementById('milestoneDetailPanelsWrapper');
  const streamEl = document.getElementById('fullChronologicalStreamList');
  const badgeEl = document.getElementById('milestoneTotalEventsBadge');
  if (!trackEl || !panelsEl || !streamEl || !p) return;

  const auditItems = (p.audit && p.audit.items) ? p.audit.items : [];
  const docs = p.documents || [];
  const reports = p.reports || [];
  const extensions = p.extensions || [];
  const adjustments = p.budget_adjustments || currentBudgetAdjustments || [];
  const supplies = p.supplies || [];
  const proposal = p.proposal || null;

  const findCrit = (key) => auditItems.find(i => i.key === key) || null;
  const isCritDone = (key) => {
    const c = findCrit(key);
    return c && (c.status === 'UPLOADED' || c.status === 'VERIFIED');
  };

  // Thu thập toàn bộ dòng sự kiện lịch sử theo trình tự thời gian
  const allEvents = [];

  // --- GIAI ĐOẠN 1: ĐĂNG KÝ & THUYẾT MINH ---
  const thuyetMinhCrit = findCrit('THUYET_MINH');
  const m1Date = p.submission_date_vn || (proposal && proposal.submitted_at_vn) || (thuyetMinhCrit?.file?.uploaded_at_vn) || p.decision_date_vn || '--';
  const m1Done = isCritDone('THUYET_MINH') || !!proposal || !!p.decision_number;
  const m1Events = [];

  m1Events.push({
    date: m1Date,
    actor: `Chủ nhiệm: ${p.leader_name}`,
    actor_role: 'CHU_NHIEM',
    dot_class: 'dot-green',
    title: `Trình nộp hồ sơ đề xuất và thuyết minh đề tài${proposal ? ` (Mã số: ${proposal.proposal_code})` : ''}`,
    desc: `Đơn vị chuyên môn: ${p.research_group || 'Viện Tế bào gốc'} • Kinh phí đề xuất: ${proposal ? Number(proposal.budget_proposed || p.budget_total).toLocaleString('vi-VN') + ' đ' : p.budget_total_formatted} • Thời gian: ${p.duration_months || 12} tháng.`,
    action_label: 'Hồ sơ Giai đoạn 1',
    action_fn: `jumpToMilestoneDetailTarget('stage', 1, 'THUYET_MINH')`
  });

  if (thuyetMinhCrit && thuyetMinhCrit.file && thuyetMinhCrit.file.id) {
    m1Events.push({
      date: thuyetMinhCrit.file.uploaded_at_vn || m1Date,
      actor: thuyetMinhCrit.file.uploaded_by || `Chủ nhiệm: ${p.leader_name}`,
      actor_role: 'CHU_NHIEM',
      dot_class: 'dot-green',
      title: `Lưu trữ văn bản: ${thuyetMinhCrit.file.title}`,
      desc: `Tệp văn bản: ${thuyetMinhCrit.file.file_name} (${formatFileSize(thuyetMinhCrit.file.file_size)}).`,
      action_label: 'Xem văn bản',
      action_fn: `jumpToMilestoneDetailTarget('preview', ${thuyetMinhCrit.file.id}, '${escapeHtml(thuyetMinhCrit.file.title)}')`
    });
  } else if (thuyetMinhCrit && thuyetMinhCrit.status === 'VERIFIED') {
    m1Events.push({
      date: thuyetMinhCrit.verified_at ? thuyetMinhCrit.verified_at.slice(0, 10) : m1Date,
      actor: thuyetMinhCrit.verified_by || 'Phòng KH&CN',
      actor_role: 'PHONG_KHCN',
      dot_class: 'dot-green',
      title: 'Xác thực lưu trữ bản chính Thuyết minh đề tài',
      desc: thuyetMinhCrit.notes || 'Đã đối chiếu và lưu trữ hồ sơ bản cứng.',
      action_label: 'Chi tiết hồ sơ',
      action_fn: `jumpToMilestoneDetailTarget('stage', 1, 'THUYET_MINH')`
    });
  }

  // --- GIAI ĐOẠN 2: XÉT DUYỆT ĐỀ CƯƠNG ---
  const bbXetDuyetCrit = findCrit('BB_XET_DUYET');
  const m2Date = p.council_date_vn || (proposal && proposal.council_date_vn) || (bbXetDuyetCrit?.file?.uploaded_at_vn) || p.decision_date_vn || '--';
  const m2Done = isCritDone('BB_XET_DUYET') || !!p.decision_number || (proposal && proposal.status === 'APPROVED');
  const m2Events = [];

  m2Events.push({
    date: m2Date,
    actor: 'Hội đồng KH&CN & Phòng KH&CN',
    actor_role: 'PHONG_KHCN',
    dot_class: m2Done ? 'dot-green' : 'dot-yellow',
    title: `Họp Hội đồng xét duyệt đề cương — Kết luận: ${p.council_result || (proposal && proposal.council_result) || 'Đạt'}${proposal && proposal.council_score ? ` (${proposal.council_score}/100 điểm)` : ''}`,
    desc: (proposal && proposal.council_notes) ? proposal.council_notes : 'Thông qua nội dung khoa học và định mức kinh phí thực hiện.',
    action_label: 'Hồ sơ Giai đoạn 2',
    action_fn: `jumpToMilestoneDetailTarget('stage', 2, 'BB_XET_DUYET')`
  });

  if (bbXetDuyetCrit && bbXetDuyetCrit.file && bbXetDuyetCrit.file.id) {
    m2Events.push({
      date: bbXetDuyetCrit.file.uploaded_at_vn || m2Date,
      actor: bbXetDuyetCrit.file.uploaded_by || 'Phòng KH&CN',
      actor_role: 'PHONG_KHCN',
      dot_class: 'dot-green',
      title: `Lưu trữ văn bản: ${bbXetDuyetCrit.file.title}`,
      desc: `Tệp văn bản: ${bbXetDuyetCrit.file.file_name}`,
      action_label: 'Xem văn bản',
      action_fn: `jumpToMilestoneDetailTarget('preview', ${bbXetDuyetCrit.file.id}, '${escapeHtml(bbXetDuyetCrit.file.title)}')`
    });
  }

  // --- GIAI ĐOẠN 3: GIAO NHIỆM VỤ & HỢP ĐỒNG ---
  const qdGiaoCrit = findCrit('QD_GIAO_NHIEM_VU');
  const hdCrit = findCrit('HOP_DONG_NCKH');
  const dtCrit = findCrit('DU_TOAN_DA_DUYET');
  const m3Date = p.decision_date_vn || 'Chưa ban hành';
  const m3Done = !!p.decision_number || isCritDone('QD_GIAO_NHIEM_VU');
  const m3Events = [];

  m3Events.push({
    date: m3Date,
    actor: 'Viện trưởng Viện Tế bào gốc',
    actor_role: 'VIEN_TRUONG',
    dot_class: m3Done ? 'dot-green' : 'dot-yellow',
    title: `Ban hành Quyết định giao nhiệm vụ KH&CN số: ${p.decision_number || 'Chưa cấp số'}`,
    desc: `Ngày ký: ${m3Date} • Kinh phí phê duyệt: ${p.budget_total_formatted} • Thời hạn: ${p.duration_months || 12} tháng (Đến ngày: ${p.base_end_date_vn || '--'}).`,
    action_label: 'Thông tin Quyết định',
    action_fn: `jumpToMilestoneDetailTarget('overview-decision')`
  });

  m3Events.push({
    date: hdCrit?.file?.uploaded_at_vn || m3Date,
    actor: 'Viện trưởng & Chủ nhiệm đề tài',
    actor_role: 'PHONG_KHCN',
    dot_class: (isCritDone('HOP_DONG_NCKH') && isCritDone('DU_TOAN_DA_DUYET')) ? 'dot-green' : 'dot-yellow',
    title: 'Ký kết Hợp đồng NCKH cấp cơ sở và Phê duyệt Dự toán chi tiết',
    desc: `Trạng thái Hợp đồng: ${hdCrit ? hdCrit.status_label : 'Chưa cập nhật'} • Danh mục dự toán: ${(p.budget_items || []).length} hạng mục.`,
    action_label: 'Hồ sơ Giai đoạn 3',
    action_fn: `jumpToMilestoneDetailTarget('stage', 3, 'HOP_DONG_NCKH')`
  });

  // --- GIAI ĐOẠN 4: KINH PHÍ & VẬT TƯ ---
  const m4Events = [];
  adjustments.forEach(adj => {
    m4Events.push({
      date: adj.decision_date_vn || adj.request_date_vn || '--',
      actor: adj.status === 'APPROVED' ? `Viện trưởng (${adj.decision_number || 'Đã ký QĐ'})` : (adj.status === 'KHCN_REVIEWED' ? 'Phòng KH&CN thẩm tra' : `Chủ nhiệm: ${p.leader_name}`),
      actor_role: adj.status === 'APPROVED' ? 'VIEN_TRUONG' : 'CHU_NHIEM',
      dot_class: adj.status === 'APPROVED' ? 'dot-purple' : 'dot-yellow',
      title: `Điều chỉnh dự toán kinh phí lần ${adj.adjustment_num}: ${Number(adj.old_budget).toLocaleString('vi-VN')} đ ➔ ${Number(adj.new_budget).toLocaleString('vi-VN')} đ`,
      desc: `Nội dung: ${adj.reason}${adj.decision_number ? ` • Quyết định số: ${adj.decision_number} (${adj.decision_date_vn})` : ''}.`,
      action_label: `Điều chỉnh lần ${adj.adjustment_num}`,
      action_fn: `jumpToMilestoneDetailTarget('adjustment', ${adj.id})`
    });
  });

  if (supplies.length > 0) {
    const fullCnt = supplies.filter(s => s.fulfillment_status === 'Đã nhận đủ').length;
    const latestSupplyDate = supplies[0].received_date || supplies[0].request_date || p.decision_date_vn || '--';
    const misaCodes = supplies.map(s => s.misa_order_id).filter(Boolean);
    m4Events.push({
      date: latestSupplyDate,
      actor: 'Phòng TC-Cung ứng & Chủ nhiệm',
      actor_role: 'PHONG_TC_CU',
      dot_class: fullCnt === supplies.length ? 'dot-green' : 'dot-yellow',
      title: `Cấp phát hóa chất, vật tư: Hoàn thành ${fullCnt}/${supplies.length} hạng mục`,
      desc: misaCodes.length > 0 ? `Chứng từ / Đơn hàng: ${misaCodes.join(', ')}.` : `Tổng số hạng mục đề xuất cấp phát: ${supplies.length} mục.`,
      action_label: 'Bảng cấp phát vật tư',
      action_fn: `jumpToMilestoneDetailTarget('supplies')`
    });
  } else {
    m4Events.push({
      date: p.decision_date_vn || '--',
      actor: 'Phòng KH&CN & Phòng TC-Cung ứng',
      actor_role: 'PHONG_TC_CU',
      dot_class: isCritDone('CHUNG_TU_VAT_TU') ? 'dot-green' : 'dot-yellow',
      title: `Danh mục dự toán (${(p.budget_items || []).length} hạng mục) & Chứng từ vật tư`,
      desc: isCritDone('CHUNG_TU_VAT_TU') ? 'Đã lưu trữ chứng từ cấp phát vật tư.' : 'Chưa phát sinh phiếu đề xuất cấp phát mới.',
      action_label: 'Dự toán & Vật tư',
      action_fn: `jumpToMilestoneDetailTarget('supplies')`
    });
  }

  const m4Date = adjustments.length > 0
    ? (adjustments[adjustments.length - 1].decision_date_vn || adjustments[adjustments.length - 1].request_date_vn)
    : (supplies.length > 0 ? (supplies[0].request_date || 'Đang thực hiện') : 'Đang thực hiện');
  const m4Done = isCritDone('CHUNG_TU_VAT_TU') || (supplies.length > 0 && supplies.every(s => s.fulfillment_status === 'Đã nhận đủ'));

  const todayScore = new Date().setHours(0, 0, 0, 0);

  // --- GIAI ĐOẠN 5: BÁO CÁO ĐỊNH KỲ ---
  const m5Events = [];
  const submittedReps = reports.filter(r => r.status === 'SUBMITTED' || r.status === 'APPROVED');
  let hasOverdueUnsubmittedRep = false;
  let hasLateHistoryRep = false;
  let firstOverdueRepDate = null;

  if (reports.length > 0) {
    reports.forEach(r => {
      const isRepDone = r.status === 'SUBMITTED' || r.status === 'APPROVED';
      const dueScore = parseClientDateScore(r.due_date_vn || r.due_date);
      const subScore = parseClientDateScore(r.submitted_date_vn || r.submitted_date);
      const isRepOverdue = !isRepDone && dueScore > 0 && dueScore < todayScore;
      const isRepLate = isRepDone && dueScore > 0 && subScore > dueScore;

      if (isRepOverdue) {
        hasOverdueUnsubmittedRep = true;
        if (!firstOverdueRepDate) firstOverdueRepDate = r.due_date_vn;
      }
      if (isRepLate) {
        hasLateHistoryRep = true;
      }

      const repStatusText = r.status === 'APPROVED'
        ? (isRepLate ? 'Đã thông qua (Nộp trễ hạn)' : 'Đã thông qua')
        : (r.status === 'SUBMITTED' ? (isRepLate ? 'Đã nộp (Trễ hạn)' : 'Đã nộp') : (isRepOverdue ? 'Quá hạn nộp' : 'Chưa nộp'));

      m5Events.push({
        date: r.submitted_date_vn || `Hạn: ${r.due_date_vn}`,
        actor: isRepDone ? `Chủ nhiệm: ${p.leader_name}` : 'Chủ nhiệm đề tài',
        actor_role: 'CHU_NHIEM',
        dot_class: (isRepOverdue || isRepLate) ? 'dot-red' : (r.status === 'APPROVED' ? 'dot-green' : (r.status === 'SUBMITTED' ? 'dot-purple' : 'dot-yellow')),
        title: `Báo cáo tiến độ định kỳ kỳ ${r.period_num} (${r.period_num * 6} tháng) — ${repStatusText}`,
        desc: `Hạn nộp: ${r.due_date_vn} • Ngày nộp: ${r.submitted_date_vn || 'Chưa nộp'} • Tiến độ: ${r.progress_percent || 0}%.${r.khcn_evaluation ? ` Nhận xét P.KH&CN: ${r.khcn_evaluation}` : ''}`,
        action_label: `Báo cáo kỳ ${r.period_num}`,
        action_fn: `jumpToMilestoneDetailTarget('report', ${r.id})`
      });
    });
  } else {
    m5Events.push({
      date: isCritDone('BAO_CAO_6_THANG') ? (findCrit('BAO_CAO_6_THANG')?.file?.uploaded_at_vn || 'Đã lưu') : 'Định kỳ 06 tháng',
      actor: `Chủ nhiệm: ${p.leader_name}`,
      actor_role: 'CHU_NHIEM',
      dot_class: isCritDone('BAO_CAO_6_THANG') ? 'dot-green' : 'dot-yellow',
      title: 'Báo cáo tiến độ định kỳ 06 tháng',
      desc: isCritDone('BAO_CAO_6_THANG') ? 'Đã lưu trữ văn bản báo cáo định kỳ.' : 'Chưa đến kỳ hạn hoặc chưa nộp báo cáo.',
      action_label: 'Bảng báo cáo định kỳ',
      action_fn: `jumpToMilestoneDetailTarget('reports-tab')`
    });
  }
  const m5Date = hasOverdueUnsubmittedRep
    ? `Hạn: ${firstOverdueRepDate || reports[0]?.due_date_vn}`
    : (submittedReps.length > 0
      ? (submittedReps[submittedReps.length - 1].submitted_date_vn || submittedReps[submittedReps.length - 1].due_date_vn)
      : (reports.length > 0 ? `Hạn: ${reports[0].due_date_vn}` : 'Định kỳ 06 tháng'));
  const m5Done = reports.length > 0
    ? (submittedReps.length === reports.length && !hasOverdueUnsubmittedRep)
    : isCritDone('BAO_CAO_6_THANG');
  const m5Overdue = hasOverdueUnsubmittedRep || hasLateHistoryRep || (Boolean(p.is_overdue) && !m5Done);

  // --- GIAI ĐOẠN 6: GIA HẠN THỰC HIỆN ---
  const m6Events = [];
  const approvedExts = extensions.filter(e => e.status === 'APPROVED');
  const pendingExts = extensions.filter(e => e.status === 'PENDING' || e.status === 'REVISION_NEEDED');
  const rejectedExts = extensions.filter(e => e.status === 'REJECTED');
  const extCount = approvedExts.length;
  let hasLateExtHistory = false;

  if (extensions.length > 0) {
    extensions.forEach(e => {
      const prevScore = parseClientDateScore(e.previous_end_date_vn || e.previous_end_date);
      const reqScore = parseClientDateScore(e.request_date_vn || e.request_date);
      if (prevScore > 0 && reqScore > prevScore) {
        hasLateExtHistory = true;
      }

      if (e.status === 'APPROVED') {
        m6Events.push({
          date: e.decision_date_vn || e.request_date_vn || 'Đã phê duyệt',
          actor: `Viện trưởng (${e.decision_number || 'Quyết định gia hạn'})`,
          actor_role: 'VIEN_TRUONG',
          dot_class: (prevScore > 0 && reqScore > prevScore) ? 'dot-red' : 'dot-green',
          title: `Đã phê duyệt gia hạn Lần ${e.extension_num} (+${e.months_added || 6} tháng) — Quyết định số: ${e.decision_number || 'Đã cấp'}`,
          desc: `Ngày trình: ${e.request_date_vn || '--'} • Ngày ký QĐ: ${e.decision_date_vn || '--'} • Thời hạn mới: ${e.previous_end_date_vn || e.previous_end_date} ➔ ${e.new_end_date_vn || e.new_end_date}.`,
          action_label: `Chi tiết gia hạn Lần ${e.extension_num}`,
          action_fn: `jumpToMilestoneDetailTarget('extension')`
        });
      } else if (e.status === 'REJECTED') {
        m6Events.push({
          date: e.decision_date_vn || e.request_date_vn || 'Đã có kết luận',
          actor: 'Viện trưởng & Phòng KH&CN',
          actor_role: 'VIEN_TRUONG',
          dot_class: 'dot-red',
          title: `Không phê duyệt đề xuất gia hạn Lần ${e.extension_num} (Giữ nguyên hạn cũ: ${e.previous_end_date_vn || e.previous_end_date})`,
          desc: `Lý do / Chỉ đạo của Viện trưởng: ${e.director_opinion || 'Không đồng ý gia hạn thời gian thực hiện đề tài.'}`,
          action_label: 'Xem kết luận',
          action_fn: `jumpToMilestoneDetailTarget('extension')`
        });
      } else {
        const statusDesc = e.status === 'REVISION_NEEDED'
          ? `Yêu cầu bổ sung hồ sơ: ${e.khcn_notes || 'Chờ Chủ nhiệm hoàn thiện đơn'}`
          : (e.request_file_id ? 'Đã nộp bản scan Đơn có chữ ký — Chờ P. KH&CN trình Viện trưởng phê duyệt' : 'Chủ nhiệm mới khởi tạo đề xuất — Chờ nộp bản scan Đơn có chữ ký');
        m6Events.push({
          date: e.request_date_vn || 'Đang trình duyệt',
          actor: `Chủ nhiệm: ${p.leader_name}`,
          actor_role: 'CHU_NHIEM',
          dot_class: 'dot-yellow',
          title: `Đang trình đề xuất xin gia hạn Lần ${e.extension_num} (+${e.months_added || 6} tháng — Chưa cộng hạn đề tài)`,
          desc: `Trạng thái: ${statusDesc} • Lý do: ${e.reason || ''} • Hạn đề xuất (nếu được duyệt): ${e.new_end_date_vn || e.new_end_date}.`,
          action_label: 'Xử lý hồ sơ gia hạn',
          action_fn: `jumpToMilestoneDetailTarget('extension')`
        });
      }
    });
  } else {
    m6Events.push({
      date: `Hạn gốc: ${p.base_end_date_vn || '--'}`,
      actor: 'Phòng KH&CN',
      actor_role: 'PHONG_KHCN',
      dot_class: 'dot-green',
      title: 'Thực hiện theo tiến độ gốc (Không phát sinh gia hạn)',
      desc: `Số lần đã duyệt gia hạn: 0/2 lần • Hạn hoàn thành theo Quyết định: ${p.base_end_date_vn || '--'}.`,
      action_label: 'Thông tin gia hạn',
      action_fn: `jumpToMilestoneDetailTarget('extension')`
    });
  }

  const m6Date = extensions.length > 0
    ? (extensions[extensions.length - 1].decision_date_vn || extensions[extensions.length - 1].request_date_vn || 'Đang trình duyệt')
    : 'Không phát sinh';
  const m6Done = extCount > 0 && pendingExts.length === 0 && isCritDone('DON_GIA_HAN_1') && isCritDone('QD_GIA_HAN_1');
  const m6Overdue = (extCount > 0 && !(isCritDone('DON_GIA_HAN_1') && isCritDone('QD_GIA_HAN_1'))) || hasLateExtHistory;
  const m6SubLabel = pendingExts.length > 0
    ? `Đang trình Lần ${pendingExts[0].extension_num} (Chờ duyệt)`
    : (rejectedExts.length > 0 && extCount === 0
        ? `Từ chối GH (${extCount}/2 lần)`
        : (m6Overdue ? 'Trễ hạn trình GH' : (extCount > 0 ? `Đã duyệt ${extCount}/2 lần (+${extCount * 6}T)` : '0/2 lần')));
  const m6StateClass = m6Overdue
    ? 'ms-overdue'
    : (pendingExts.length > 0 ? 'ms-warning' : (extCount > 0 ? (m6Done ? 'ms-done' : 'ms-warning') : 'ms-pending'));

  // --- GIAI ĐOẠN 7: NGHIỆM THU & THANH LÝ ---
  const stage7Criteria = auditItems.filter(i => i.stage === 7);
  const stage7Done = stage7Criteria.filter(i => i.status === 'UPLOADED' || i.status === 'VERIFIED');
  const isProjectCompleted = p.status === 'COMPLETED' || (p.final_evaluation || '').toLowerCase().includes('nghiệm thu');
  const endScore = parseClientDateScore(p.current_end_date_vn || p.current_end_date);
  const qdCongNhanScore = parseClientDateScore(findCrit('QD_CONG_NHAN')?.file?.uploaded_at_vn);
  const m7Overdue = Boolean(p.is_overdue)
    || (!isProjectCompleted && endScore > 0 && endScore < todayScore)
    || (isProjectCompleted && endScore > 0 && qdCongNhanScore > endScore)
    || (isProjectCompleted && stage7Done.length < stage7Criteria.length);

  const m7Date = isProjectCompleted
    ? (findCrit('QD_CONG_NHAN')?.file?.uploaded_at_vn || p.current_end_date_vn || 'Đã nghiệm thu')
    : `Hạn: ${p.current_end_date_vn || '--'}`;
  const m7Events = [];

  m7Events.push({
    date: m7Date,
    actor: isProjectCompleted ? 'Hội đồng Nghiệm thu & Viện trưởng' : 'Chủ nhiệm & Phòng KH&CN',
    actor_role: isProjectCompleted ? 'VIEN_TRUONG' : 'CHU_NHIEM',
    dot_class: m7Overdue ? 'dot-red' : (isProjectCompleted ? 'dot-green' : 'dot-yellow'),
    title: isProjectCompleted
      ? `Nghiệm thu và Thanh lý Hợp đồng NCKH (${p.final_evaluation || 'Hoàn thành'})`
      : `Nghiệm thu và Thanh lý Hợp đồng NCKH (${m7Overdue ? `Trễ hạn${p.overdue_days ? ' ' + p.overdue_days + ' ngày' : ''}` : `Hạn kết thúc: ${p.current_end_date_vn || '--'}`})`,
    desc: `Hồ sơ pháp lý Giai đoạn 7: Đã hoàn thiện ${stage7Done.length}/${stage7Criteria.length} danh mục bắt buộc.`,
    action_label: 'Hồ sơ Giai đoạn 7',
    action_fn: `jumpToMilestoneDetailTarget('stage', 7, 'BAO_CAO_TONG_KET')`
  });

  stage7Done.forEach(item => {
    m7Events.push({
      date: item.file?.uploaded_at_vn || (item.verified_at ? item.verified_at.slice(0, 10) : m7Date),
      actor: item.file?.uploaded_by || item.verified_by || item.owner_label,
      actor_role: item.owner_role,
      dot_class: 'dot-green',
      title: `Hoàn tất văn bản: ${item.name}`,
      desc: item.file?.title || item.notes || item.status_label,
      action_label: item.file?.id ? 'Xem văn bản' : 'Chi tiết',
      action_fn: item.file?.id
        ? `jumpToMilestoneDetailTarget('preview', ${item.file.id}, '${escapeHtml(item.file.title)}')`
        : `jumpToMilestoneDetailTarget('stage', 7, '${item.key}')`
    });
  });

  const m1Overdue = !m1Done && m2Done;
  const m2Overdue = !isCritDone('BB_XET_DUYET') && m3Done;
  const m3AllDocsDone = isCritDone('QD_GIAO_NHIEM_VU') && isCritDone('HOP_DONG_NCKH') && isCritDone('DU_TOAN_DA_DUYET');
  const m3Overdue = !m3AllDocsDone && (Boolean(p.is_overdue) || isProjectCompleted);

  // Cấu trúc 7 Giai đoạn trên trục ngang (Tách biệt: Thời gian phía trên đường ngang, Sự kiện phía dưới đường ngang, Tô đỏ các mốc trễ hạn)
  const milestones = [
    {
      step: 1,
      title: 'Trình nộp thuyết minh',
      full_title: 'Giai đoạn 1: Đăng ký đề xuất và Trình nộp thuyết minh đề tài',
      date_label: m1Date,
      sub_label: proposal ? proposal.proposal_code : (isCritDone('THUYET_MINH') ? 'Đã lưu thuyết minh' : 'Thiếu thuyết minh'),
      state_class: m1Overdue ? 'ms-overdue' : (m1Done ? 'ms-done' : 'ms-warning'),
      criteria_list: getStageCriteriaList(1, auditItems, docs),
      events: m1Events,
      primary_jump_label: 'Mở Hồ sơ Giai đoạn 1',
      primary_jump_fn: `jumpToMilestoneDetailTarget('stage', 1, 'THUYET_MINH')`
    },
    {
      step: 2,
      title: 'Xét duyệt đề cương',
      full_title: 'Giai đoạn 2: Họp Hội đồng xét duyệt đề cương nghiên cứu',
      date_label: m2Date,
      sub_label: m2Overdue ? 'Thiếu Biên bản HĐ' : `Kết luận: ${p.council_result || 'Đạt'}`,
      state_class: m2Overdue ? 'ms-overdue' : (isCritDone('BB_XET_DUYET') ? 'ms-done' : (m2Done ? 'ms-active' : 'ms-warning')),
      criteria_list: getStageCriteriaList(2, auditItems, docs),
      events: m2Events,
      primary_jump_label: 'Mở Hồ sơ Giai đoạn 2',
      primary_jump_fn: `jumpToMilestoneDetailTarget('stage', 2, 'BB_XET_DUYET')`
    },
    {
      step: 3,
      title: 'Giao nhiệm vụ & HĐ',
      full_title: 'Giai đoạn 3: Quyết định giao nhiệm vụ, Hợp đồng và Dự toán',
      date_label: m3Date,
      sub_label: m3Overdue ? 'Thiếu hồ sơ giao việc' : (p.decision_number || 'Chưa cấp số QĐ'),
      state_class: m3Overdue ? 'ms-overdue' : ((isCritDone('QD_GIAO_NHIEM_VU') && isCritDone('HOP_DONG_NCKH')) ? 'ms-done' : (m3Done ? 'ms-active' : 'ms-warning')),
      criteria_list: getStageCriteriaList(3, auditItems, docs),
      events: m3Events,
      primary_jump_label: 'Mở Hồ sơ Giai đoạn 3',
      primary_jump_fn: `jumpToMilestoneDetailTarget('stage', 3, 'QD_GIAO_NHIEM_VU')`
    },
    {
      step: 4,
      title: 'Kinh phí & Vật tư',
      full_title: 'Giai đoạn 4: Cấp phát vật tư và Điều chỉnh dự toán kinh phí',
      date_label: m4Date,
      sub_label: `${supplies.length} mục vật tư • ${adjustments.length} lần ĐC`,
      state_class: m4Done ? 'ms-done' : 'ms-active',
      criteria_list: getStageCriteriaList(4, auditItems, docs),
      events: m4Events,
      primary_jump_label: 'Chuyển đến mục Dự toán & Vật tư',
      primary_jump_fn: `jumpToMilestoneDetailTarget('supplies')`
    },
    {
      step: 5,
      title: 'Báo cáo định kỳ',
      full_title: 'Giai đoạn 5: Báo cáo tiến độ định kỳ 06 tháng',
      date_label: m5Date,
      sub_label: m5Overdue
        ? (hasOverdueUnsubmittedRep ? `Trễ hạn (${submittedReps.length}/${reports.length} kỳ)` : `Nộp trễ (${submittedReps.length}/${reports.length} kỳ)`)
        : (reports.length > 0 ? `Đã nộp ${submittedReps.length}/${reports.length} kỳ` : (isCritDone('BAO_CAO_6_THANG') ? 'Đã nộp báo cáo' : 'Chưa nộp')),
      state_class: m5Overdue ? 'ms-overdue' : (m5Done ? 'ms-done' : 'ms-warning'),
      criteria_list: getStageCriteriaList(5, auditItems, docs),
      events: m5Events,
      primary_jump_label: 'Chuyển đến mục Báo cáo định kỳ',
      primary_jump_fn: `jumpToMilestoneDetailTarget('reports-tab')`
    },
    {
      step: 6,
      title: 'Gia hạn thực hiện',
      full_title: 'Giai đoạn 6: Gia hạn thời gian thực hiện đề tài',
      date_label: m6Date,
      sub_label: m6SubLabel,
      state_class: m6StateClass,
      criteria_list: getStageCriteriaList(6, auditItems, docs),
      events: m6Events,
      primary_jump_label: 'Chuyển đến mục Quản lý gia hạn',
      primary_jump_fn: `jumpToMilestoneDetailTarget('extension')`
    },
    {
      step: 7,
      title: 'Nghiệm thu & Thanh lý',
      full_title: 'Giai đoạn 7: Đánh giá nghiệm thu, Công nhận kết quả và Thanh lý Hợp đồng',
      date_label: m7Date,
      sub_label: m7Overdue
        ? `${p.overdue_days ? `Trễ hạn ${p.overdue_days} ngày` : 'Trễ hạn'} • ${stage7Done.length}/${stage7Criteria.length} mục`
        : (isProjectCompleted ? `Đã nghiệm thu (${stage7Done.length}/${stage7Criteria.length} mục)` : `Hồ sơ: ${stage7Done.length}/${stage7Criteria.length} mục`),
      state_class: m7Overdue ? 'ms-overdue' : ((isProjectCompleted && stage7Done.length === stage7Criteria.length) ? 'ms-done' : (isProjectCompleted ? 'ms-warning' : 'ms-active')),
      criteria_list: getStageCriteriaList(7, auditItems, docs),
      events: m7Events,
      primary_jump_label: 'Mở Hồ sơ Giai đoạn 7',
      primary_jump_fn: `jumpToMilestoneDetailTarget('stage', 7, 'BAO_CAO_TONG_KET')`
    }
  ];

  // Gom toàn bộ sự kiện từ 7 giai đoạn
  milestones.forEach(m => {
    m.events.forEach(ev => {
      allEvents.push({
        ...ev,
        milestone_step: m.step,
        milestone_short: `GĐ ${m.step}: ${m.title}`,
        sort_score: parseClientDateScore(ev.date) || (m.step * 1000)
      });
    });
  });

  if (badgeEl) {
    const completedMilestones = milestones.filter(m => m.state_class === 'ms-done').length;
    const overdueMilestones = milestones.filter(m => m.state_class === 'ms-overdue').length;
    badgeEl.innerHTML = overdueMilestones > 0
      ? `Hoàn thành ${completedMilestones}/7 giai đoạn • <span style="color:#dc2626; font-weight:700;">${overdueMilestones} mốc trễ hạn</span> • ${allEvents.length} sự kiện`
      : `Hoàn thành ${completedMilestones}/7 giai đoạn • ${allEvents.length} sự kiện`;
  }

  // Render trục ngang 3 tầng: [Tầng trên: Thời gian] -> [Tầng giữa: Đường trục ngang & Điểm mốc] -> [Tầng dưới: Sự kiện & Kết quả]
  trackEl.innerHTML = milestones.map(m => {
    const isExpanded = (!isMilestoneDetailCollapsed && activeMilestoneStep === m.step);
    const nodeContent = m.state_class === 'ms-done' ? '✓' : (m.state_class === 'ms-overdue' ? '!' : m.step);
    return `
      <button
        type="button"
        class="milestone-node-btn ${m.state_class}"
        id="ms-btn-${m.step}"
        aria-expanded="${isExpanded ? 'true' : 'false'}"
        aria-controls="ms-panel-${m.step}"
        onclick="selectMilestoneStep(${m.step})"
      >
        <div class="ms-top-time-zone">
          <span class="ms-step-date">${escapeHtml(m.date_label)}</span>
        </div>
        <div class="ms-axis-zone">
          <span class="ms-node-circle">${nodeContent}</span>
        </div>
        <div class="ms-bottom-event-zone">
          <div class="ms-step-title">${m.step}. ${escapeHtml(m.title)}</div>
          <div class="ms-step-sub" title="${escapeHtml(m.sub_label)}">${escapeHtml(m.sub_label)}</div>
        </div>
      </button>
    `;
  }).join('');

  // Render 7 Khung Chi tiết tương ứng
  panelsEl.innerHTML = milestones.map(m => {
    const isHidden = isMilestoneDetailCollapsed || activeMilestoneStep !== m.step;
    const roleInMs = typeof window.getCurrentRole === 'function' ? window.getCurrentRole() : 'PHONG_KHCN';
    const isKhcnOrAdminMs = ['PHONG_KHCN', 'SUPER_ADMIN'].includes(roleInMs);
    const criteriaHtml = m.criteria_list.length > 0 ? m.criteria_list.map(c => {
      const isDone = c.status === 'UPLOADED' || c.status === 'VERIFIED';
      const badgeCls = c.status === 'VERIFIED' ? 'badge-green' : (c.status === 'UPLOADED' ? 'badge-blue' : (c.status === 'NOT_REQUIRED' ? 'badge-gray' : 'badge-red'));
      const canUpload = canCurrentUserUploadCriteriaItem(c);
      const canEditUploaded = isKhcnOrAdminMs || (canUpload && c.status !== 'VERIFIED');

      return `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 10px; background:#ffffff; border:1px solid ${isDone ? '#bae6fd' : '#e2e8f0'}; border-radius:6px; font-size:0.78rem;">
          <div style="flex:1;">
            <div style="font-weight:600; color:#0f172a; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <span>${escapeHtml(c.name)}</span>
              <span class="badge ${badgeCls}" style="font-size:0.65rem; padding:1px 6px;">${escapeHtml(c.status_label)}</span>
            </div>
            ${c.file && c.file.title ? `<div style="font-size:0.7rem; color:#0369a1; margin-top:2px;">${escapeHtml(c.file.title)} ${c.file.uploaded_at_vn ? `(${escapeHtml(c.file.uploaded_at_vn)})` : ''}</div>` : `<div style="font-size:0.7rem; color:#64748b; margin-top:2px;">Trách nhiệm: ${escapeHtml(c.owner_label || '')}</div>`}
          </div>
          <div style="display:flex; gap:4px; flex-shrink:0;">
            ${c.file && c.file.id ? `
              <button type="button" class="btn btn-outline btn-sm" style="padding:2px 8px; font-size:0.72rem;" onclick="jumpToMilestoneDetailTarget('preview', ${c.file.id}, '${escapeHtml(c.file.title)}')">
                Xem văn bản
              </button>
              <a href="/api/documents/${c.file.id}/download" class="btn btn-outline btn-sm" style="padding:2px 8px; font-size:0.72rem; text-decoration:none;">
                Tải về
              </a>
              ${canEditUploaded ? `
                <button type="button" class="btn btn-outline btn-sm" style="padding:2px 7px; font-size:0.7rem; color:#0f172a; border-color:#94a3b8; background:#f8fafc; font-weight:600;" onclick="openEditDocModal(${c.file.id}, '${c.key}', ${m.step}, '${c.status}')" title="Chỉnh sửa phân loại, thay tệp hoặc gỡ bỏ văn bản tải nhầm">
                  Sửa / Xử lý
                </button>
              ` : ''}
            ` : (canUpload && c.status !== 'NOT_REQUIRED' ? `
              <button type="button" class="btn btn-primary btn-sm" style="padding:2px 8px; font-size:0.72rem;" onclick="openUploadModalForCriteria('${c.key}', ${c.stage}, '${escapeHtml(c.name)}')">
                Nộp bổ sung
              </button>
            ` : '')}
          </div>
        </div>
      `;
    }).join('') : '<div style="font-size:0.78rem; color:#64748b;">Không có danh mục văn bản bắt buộc.</div>';

    const eventsHtml = m.events.map(ev => `
      <div class="event-stream-item">
        <span class="event-stream-dot ${ev.dot_class || ''}"></span>
        <div>
          <span class="badge badge-blue" style="font-size:0.68rem; padding:1px 6px; margin-right:4px;">
            ${escapeHtml(ev.date)}
          </span>
          <span style="font-size:0.72rem; font-weight:700; color:#475569;">
            • ${escapeHtml(ev.actor)}
          </span>
        </div>
        <div style="font-weight:700; font-size:0.83rem; color:#0f172a; margin-top:3px;">
          ${escapeHtml(ev.title)}
        </div>
        <div style="font-size:0.75rem; color:#475569; margin-top:2px;">
          ${escapeHtml(ev.desc)}
        </div>
      </div>
    `).join('');

    return `
      <div id="ms-panel-${m.step}" class="ms-detail-panel" data-step="${m.step}" ${isHidden ? 'hidden="until-found"' : ''}>
        <div class="milestone-panel-inner">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; border-bottom:1px solid #cbd5e1; padding-bottom:6px;">
            <h4 style="font-size:0.88rem; font-weight:700; color:#0f172a; text-transform:uppercase;">${escapeHtml(m.full_title)}</h4>
            <button type="button" class="btn btn-primary btn-sm" style="font-size:0.74rem; padding:3px 10px;" onclick="${m.primary_jump_fn}">
              ${escapeHtml(m.primary_jump_label)}
            </button>
          </div>

          <div class="ms-detail-grid">
            <div>
              <div style="font-size:0.74rem; font-weight:700; color:#475569; margin-bottom:6px; text-transform:uppercase;">
                Nhật ký sự kiện &amp; Quyết định hành chính:
              </div>
              <div class="event-stream-list">
                ${eventsHtml}
              </div>
            </div>

            <div>
              <div style="font-size:0.74rem; font-weight:700; color:#475569; margin-bottom:6px; text-transform:uppercase;">
                Danh mục văn bản pháp lý lưu trữ:
              </div>
              <div style="display:flex; flex-direction:column; gap:5px;">
                ${criteriaHtml}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Render Chế độ 2: Nhật ký dọc toàn bộ quá trình
  streamEl.innerHTML = allEvents.map((ev, idx) => `
    <div class="event-stream-item">
      <span class="event-stream-dot ${ev.dot_class || ''}"></span>
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <span class="badge badge-gray" style="font-size:0.66rem;">#${idx + 1} • ${escapeHtml(ev.milestone_short)}</span>
          <span class="badge badge-blue" style="font-size:0.7rem;">
            ${escapeHtml(ev.date)}
          </span>
          <span style="font-size:0.74rem; font-weight:700; color:#334155;">
            • ${escapeHtml(ev.actor)}
          </span>
        </div>
        ${ev.action_fn ? `
          <button type="button" class="btn btn-outline btn-sm" style="padding:2px 9px; font-size:0.72rem; color:var(--primary); border-color:#7dd3fc; background:#f0f9ff;" onclick="${ev.action_fn}">
            ${escapeHtml(ev.action_label || 'Mở chi tiết')}
          </button>
        ` : ''}
      </div>
      <div style="font-weight:700; font-size:0.84rem; color:#0f172a; margin-top:3px;">
        ${escapeHtml(ev.title)}
      </div>
      <div style="font-size:0.76rem; color:#475569; margin-top:2px;">
        ${escapeHtml(ev.desc)}
      </div>
    </div>
  `).join('');

  setupMilestoneBeforeMatchListener();
}

function selectMilestoneStep(stepNum) {
  if (!isMilestoneDetailCollapsed && activeMilestoneStep === stepNum) {
    // Nếu bấm lại vào chính mốc đang mở -> thu gọn hoặc giữ nguyên
    toggleMilestoneDetailCollapse();
    return;
  }
  isMilestoneDetailCollapsed = false;
  activeMilestoneStep = Number(stepNum);

  const iconEl = document.getElementById('iconToggleMilestonePanel');
  if (iconEl) iconEl.className = 'fa-solid fa-chevron-up';

  document.querySelectorAll('#milestoneStepperTrack .milestone-node-btn').forEach(btn => {
    const isTarget = btn.id === `ms-btn-${activeMilestoneStep}`;
    btn.setAttribute('aria-expanded', isTarget ? 'true' : 'false');
  });

  document.querySelectorAll('#milestoneDetailPanelsWrapper .ms-detail-panel').forEach(panel => {
    const pStep = Number(panel.getAttribute('data-step'));
    if (pStep === activeMilestoneStep) {
      panel.removeAttribute('hidden');
    } else {
      panel.setAttribute('hidden', 'until-found');
    }
  });
}

function toggleMilestoneDetailCollapse() {
  isMilestoneDetailCollapsed = !isMilestoneDetailCollapsed;
  const iconEl = document.getElementById('iconToggleMilestonePanel');
  if (iconEl) {
    iconEl.className = isMilestoneDetailCollapsed ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up';
  }

  document.querySelectorAll('#milestoneStepperTrack .milestone-node-btn').forEach(btn => {
    const isTarget = !isMilestoneDetailCollapsed && btn.id === `ms-btn-${activeMilestoneStep}`;
    btn.setAttribute('aria-expanded', isTarget ? 'true' : 'false');
  });

  document.querySelectorAll('#milestoneDetailPanelsWrapper .ms-detail-panel').forEach(panel => {
    const pStep = Number(panel.getAttribute('data-step'));
    if (!isMilestoneDetailCollapsed && pStep === activeMilestoneStep) {
      panel.removeAttribute('hidden');
    } else {
      panel.setAttribute('hidden', 'until-found');
    }
  });
}

function switchTimelineMode(mode) {
  const stepperContainer = document.getElementById('timelineModeStepperContainer');
  const streamContainer = document.getElementById('timelineModeStreamContainer');
  const btnStepper = document.getElementById('btnTimelineModeStepper');
  const btnStream = document.getElementById('btnTimelineModeStream');
  const btnTogglePanel = document.getElementById('btnToggleMilestonePanel');

  if (!stepperContainer || !streamContainer) return;

  if (mode === 'stream') {
    stepperContainer.setAttribute('hidden', 'until-found');
    streamContainer.removeAttribute('hidden');
    btnStream.className = 'btn btn-primary btn-sm';
    btnStepper.className = 'btn btn-outline btn-sm';
    if (btnTogglePanel) btnTogglePanel.style.display = 'none';
  } else {
    streamContainer.setAttribute('hidden', 'until-found');
    stepperContainer.removeAttribute('hidden');
    btnStepper.className = 'btn btn-primary btn-sm';
    btnStream.className = 'btn btn-outline btn-sm';
    if (btnTogglePanel) btnTogglePanel.style.display = 'inline-flex';
  }
}

// Đồng bộ trạng thái khi người dùng dùng Ctrl+F (Find-in-page) khớp nội dung trong panel ẩn (chuẩn Modern Web Guidance)
let isBeforeMatchBound = false;
function setupMilestoneBeforeMatchListener() {
  if (isBeforeMatchBound) return;
  const section = document.getElementById('projectMilestoneOverviewSection');
  if (!section) return;

  section.addEventListener('beforematch', (e) => {
    const matchedPanel = e.target.closest('.ms-detail-panel');
    if (matchedPanel) {
      const step = Number(matchedPanel.getAttribute('data-step'));
      if (step) {
        switchTimelineMode('stepper');
        isMilestoneDetailCollapsed = false;
        selectMilestoneStep(step);
      }
    } else if (e.target.closest('#timelineModeStreamContainer')) {
      switchTimelineMode('stream');
    }
  });
  isBeforeMatchBound = true;
}

// Điều hướng thông minh từ Milestone tới đúng Tab & Vùng dữ liệu chi tiết kèm hiệu ứng Highlight
function jumpToMilestoneDetailTarget(targetType, param1, param2) {
  const flashElement = (el) => {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('milestone-jump-highlight');
    void el.offsetWidth; // trigger reflow
    el.classList.add('milestone-jump-highlight');
    setTimeout(() => el.classList.remove('milestone-jump-highlight'), 2200);
  };

  if (targetType === 'preview') {
    // Chuyển sang Tab 2 (Hồ sơ 7 giai đoạn & Xem trước) và bật bản xem trước PDF ngay lập tức
    switchTabById('tab-docs');
    previewDocument(param1, param2);
    const previewBox = document.querySelector('.preview-container');
    flashElement(previewBox);
  } else if (targetType === 'stage') {
    // Chuyển sang Tab 2 và cuộn tới đúng Giai đoạn hoặc dòng tiêu chí (ưu tiên dòng trong giai đoạn đang chọn nếu là văn bản liên thông)
    switchTabById('tab-docs');
    const critRow = param2
      ? (document.getElementById(`criteria-row-${param2}-stage-${param1}`) || document.getElementById(`criteria-row-${param2}`))
      : null;
    const stageBox = document.getElementById(`stage-box-${param1}`);
    flashElement(critRow || stageBox);
  } else if (targetType === 'overview-decision') {
    switchTabById('tab-overview');
    flashElement(document.getElementById('overviewDecisionCardSection'));
  } else if (targetType === 'extension') {
    switchTabById('tab-overview');
    flashElement(document.getElementById('overviewExtensionCardSection'));
  } else if (targetType === 'report') {
    switchTabById('tab-reports');
    const repRow = document.getElementById(`report-row-${param1}`);
    flashElement(repRow || document.getElementById('reportsCardSection'));
  } else if (targetType === 'reports-tab') {
    switchTabById('tab-reports');
    flashElement(document.getElementById('reportsCardSection'));
  } else if (targetType === 'adjustment') {
    switchTabById('tab-supplies');
    const adjRow = document.getElementById(`adj-row-${param1}`);
    flashElement(adjRow || document.getElementById('budgetAdjustmentCardSection'));
  } else if (targetType === 'supplies') {
    switchTabById('tab-supplies');
    flashElement(document.getElementById('suppliesChecklistCardSection'));
  }
}

