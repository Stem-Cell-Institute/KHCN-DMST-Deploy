(function () {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get('id');
  if (!projectId) return;

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function notify(msg, isError = false) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg, isError ? 'error' : 'success');
    } else {
      alert(msg);
    }
  }

  const PRODUCT_TYPE_LABELS = {
    PAPER: 'Bài báo khoa học',
    PATENT: 'Sáng chế / GPHI',
    TRAINING: 'Đào tạo (ThS/TS/CN)',
    OTHER: 'Sản phẩm khác'
  };

  const PRODUCT_STATUS_LABELS = {
    REGISTERED: 'Đăng ký',
    SUBMITTED: 'Đã nộp',
    ACCEPTED: 'Chấp nhận đăng',
    PUBLISHED: 'Đã xuất bản / Bảo vệ'
  };

  const ACCEPTANCE_STEPS = [
    { key: 'REQUESTED', label: '1. Nộp Đơn nghiệm thu' },
    { key: 'KHCN_CHECKED', label: '2. P. KHCN kiểm tra ĐK' },
    { key: 'COUNCIL_SCHEDULED', label: '3. Lập Hội đồng' },
    { key: 'COUNCIL_EVALUATED', label: '4. Họp & Chấm điểm' },
    { key: 'REVISION_SUBMITTED', label: '5. Giải trình sau họp' },
    { key: 'RECOGNIZED', label: '6. QĐ Công nhận' },
    { key: 'LIQUIDATED', label: '7. Thanh lý HĐ' }
  ];

  async function loadProducts() {
    const box = document.getElementById('productsWarehouseContainer');
    if (!box) return;
    try {
      const res = await fetch(`/api/products/project/${projectId}`);
      const json = await res.json();
      const items = json.data || [];

      box.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:1rem; border-bottom:1px solid #e2e8f0; padding-bottom:10px;">
          <div>
            <h3 style="margin:0; font-size:1.02rem; font-weight:700; color:#0f172a;">Kho Sản phẩm KHCN có cấu trúc (${items.length})</h3>
            <div style="font-size:0.8rem; color:#64748b;">Quản lý bài báo (Q1-Q4/ISI/Scopus), sáng chế/GPHI và sản phẩm đào tạo gắn với đề tài</div>
          </div>
        </div>

        <form id="addProductForm" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px; background:#f8fafc; padding:12px; border-radius:8px; border:1px solid #e2e8f0; margin-bottom:1rem;">
          <select name="product_type" class="form-control" required>
            <option value="PAPER">Bài báo khoa học</option>
            <option value="PATENT">Sáng chế / GPHI</option>
            <option value="TRAINING">Đào tạo (ThS/TS/CN)</option>
            <option value="OTHER">Sản phẩm khác</option>
          </select>
          <input name="title" class="form-control" placeholder="Tên bài báo / sáng chế / học viên *" required style="grid-column: span 2;">
          <input name="authors_or_trainee" class="form-control" placeholder="Tác giả / Học viên">
          <input name="venue_or_degree" class="form-control" placeholder="Tạp chí / Cơ quan / Bậc ĐT">
          <input name="quartile_or_rank" class="form-control" placeholder="Xếp hạng (Q1, Scopus, ThS...)">
          <input name="doi_or_code" class="form-control" placeholder="DOI / Số bằng / Số QĐ">
          <input name="publish_year" type="number" class="form-control" value="${new Date().getFullYear()}" placeholder="Năm">
          <select name="status" class="form-control">
            <option value="REGISTERED">Đăng ký</option>
            <option value="SUBMITTED">Đã nộp</option>
            <option value="ACCEPTED">Chấp nhận đăng</option>
            <option value="PUBLISHED">Đã xuất bản / Cấp bằng</option>
          </select>
          <button type="submit" class="btn btn-primary btn-sm">+ Thêm sản phẩm</button>
        </form>

        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Loại</th>
                <th>Tên sản phẩm</th>
                <th>Tác giả / Học viên</th>
                <th>Nơi công bố / Bậc</th>
                <th>Xếp hạng</th>
                <th>DOI / Mã số</th>
                <th>Năm</th>
                <th>Trạng thái</th>
                <th>Xác thực</th>
                <th style="text-align:center;">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              ${items.length === 0 ? '<tr><td colspan="10" style="text-align:center; color:#64748b;">Chưa có sản phẩm KHCN nào được khai báo.</td></tr>' : items.map(it => `
                <tr>
                  <td><span class="badge" style="background:#e0f2fe; color:#0369a1;">${esc(PRODUCT_TYPE_LABELS[it.product_type] || it.product_type)}</span></td>
                  <td style="font-weight:600;">${esc(it.title)}</td>
                  <td>${esc(it.authors_or_trainee || '--')}</td>
                  <td>${esc(it.venue_or_degree || '--')}</td>
                  <td>${esc(it.quartile_or_rank || '--')}</td>
                  <td style="font-size:0.78rem;">${esc(it.doi_or_code || '--')}</td>
                  <td>${esc(it.publish_year || '--')}</td>
                  <td>${esc(PRODUCT_STATUS_LABELS[it.status] || it.status)}</td>
                  <td>${it.verified_at ? `<span style="color:#15803d; font-weight:600; font-size:0.78rem;">Đã xác thực (${esc(it.verified_by)})</span>` : '<span style="color:#b45309; font-size:0.78rem;">Chờ P.KHCN</span>'}</td>
                  <td style="text-align:center; white-space:nowrap;">
                    ${!it.verified_at ? `<button class="btn btn-outline btn-sm" onclick="window._verifyProduct(${it.id})" style="padding:2px 8px; font-size:0.74rem; color:#15803d; border-color:#86efac;">Xác thực</button>` : ''}
                    <button class="btn btn-outline btn-sm" onclick="window._deleteProduct(${it.id})" style="padding:2px 8px; font-size:0.74rem; color:#dc2626; border-color:#fca5a5;">Xóa</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;

      const form = document.getElementById('addProductForm');
      if (form) {
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(form);
          const payload = Object.fromEntries(fd.entries());
          payload.project_id = Number(projectId);
          const r = await fetch('/api/products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await r.json();
          if (!r.ok || !data.success) return notify(data.error || 'Lỗi thêm sản phẩm', true);
          notify(data.message);
          await Promise.all([loadProducts(), loadAcceptance(), loadActivityLogs()]);
        });
      }
    } catch (err) {
      box.innerHTML = `<div style="color:#dc2626;">Lỗi tải kho sản phẩm: ${esc(err.message)}</div>`;
    }
  }

  window._verifyProduct = async function (id) {
    const r = await fetch(`/api/products/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verify: true })
    });
    const data = await r.json();
    if (!r.ok || !data.success) return notify(data.error || 'Không thể xác thực', true);
    notify(data.message);
    await Promise.all([loadProducts(), loadAcceptance(), loadActivityLogs()]);
  };

  window._deleteProduct = async function (id) {
    if (!confirm('Xóa sản phẩm KHCN này khỏi kho?')) return;
    const r = await fetch(`/api/products/${id}`, { method: 'DELETE' });
    const data = await r.json();
    if (!r.ok || !data.success) return notify(data.error || 'Không thể xóa', true);
    notify(data.message);
    await Promise.all([loadProducts(), loadAcceptance(), loadActivityLogs()]);
  };

  async function loadAcceptance() {
    const box = document.getElementById('acceptanceWorkflowContainer');
    if (!box) return;
    try {
      const res = await fetch(`/api/acceptances/project/${projectId}`);
      const json = await res.json();
      const a = json.data || { stage_status: 'DRAFT' };
      const pre = json.preconditions || {};
      const curIdx = ACCEPTANCE_STEPS.findIndex(s => s.key === a.stage_status);
      const isCancelled = a.stage_status === 'CANCELLED_LIQUIDATION';

      const stepperHtml = ACCEPTANCE_STEPS.map((st, idx) => {
        const done = !isCancelled && curIdx >= idx;
        const bg = done ? '#0284c7' : '#e2e8f0';
        const color = done ? '#fff' : '#475569';
        return `<div style="flex:1; min-width:110px; background:${bg}; color:${color}; padding:8px 10px; border-radius:6px; font-size:0.76rem; font-weight:600; text-align:center;">${esc(st.label)}</div>`;
      }).join('');

      box.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:1rem; border-bottom:1px solid #e2e8f0; padding-bottom:10px;">
          <div>
            <h3 style="margin:0; font-size:1.02rem; font-weight:700; color:#0f172a;">Luồng Nghiệm thu – Thanh lý Khép kín</h3>
            <div style="font-size:0.8rem; color:#64748b;">
              Trạng thái hiện tại: <strong style="color:#0369a1;">${esc(a.stage_status)}</strong>
              • Sản phẩm KHCN: <strong>${pre.verified_products_count || 0}/${pre.products_count || 0}</strong> đã xác thực
              • Báo cáo 6T đã duyệt: <strong>${pre.approved_reports_count || 0}/${pre.total_reports_count || 0}</strong>
            </div>
          </div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <a href="/api/projects/${projectId}/export-autofill/DON_NGHIEM_THU" target="_blank" class="btn btn-outline btn-sm">Xuất Đơn Nghiệm thu</a>
            <a href="/api/projects/${projectId}/export-autofill/BB_NGHIEM_THU" target="_blank" class="btn btn-outline btn-sm">Xuất BB Hội đồng</a>
            <a href="/api/projects/${projectId}/export-autofill/GIAI_TRINH" target="_blank" class="btn btn-outline btn-sm">Xuất Bản giải trình</a>
            <a href="/api/projects/${projectId}/export-autofill/BB_THANH_LY" target="_blank" class="btn btn-outline btn-sm">Xuất BB Thanh lý</a>
          </div>
        </div>

        <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:1.2rem;">${stepperHtml}</div>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px;">
          <div style="border:1px solid #e2e8f0; border-radius:8px; padding:12px;">
            <div style="font-weight:700; font-size:0.86rem; margin-bottom:8px;">Bước 1 &amp; 2: Nộp đơn &amp; Kiểm tra điều kiện</div>
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
              <button class="btn btn-primary btn-sm" onclick="window._accAction('request', {})">1. Nộp Đơn nghiệm thu</button>
              <button class="btn btn-outline btn-sm" onclick="window._accKhcnCheck()">2. P.KHCN Xác nhận đủ ĐK</button>
            </div>
            ${a.khcn_checked_at ? `<div style="margin-top:8px; font-size:0.78rem; color:#15803d;">P.KHCN đã kiểm tra: ${esc(a.khcn_checked_by)} (${esc(a.khcn_notes || 'Đủ điều kiện')})</div>` : ''}
          </div>

          <form id="accCouncilForm" style="border:1px solid #e2e8f0; border-radius:8px; padding:12px; display:grid; gap:6px;">
            <div style="font-weight:700; font-size:0.86rem;">Bước 3 &amp; 4: Hội đồng Nghiệm thu</div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
              <input type="date" name="council_date" class="form-control" value="${esc(a.council_date || '')}" title="Ngày họp Hội đồng">
              <input name="council_chair" class="form-control" placeholder="Chủ tịch Hội đồng" value="${esc(a.council_chair || 'PGS. TS. Phạm Văn Phúc')}">
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
              <input type="number" step="0.1" name="council_score" class="form-control" placeholder="Điểm TB (0-100)" value="${a.council_score ?? ''}">
              <select name="council_rating" class="form-control">
                <option value="">-- Xếp loại --</option>
                ${['Xuất sắc', 'Tốt', 'Khá', 'Đạt', 'Không đạt'].map(r => `<option value="${r}" ${a.council_rating === r ? 'selected' : ''}>${r}</option>`).join('')}
              </select>
            </div>
            <input name="council_conclusion" class="form-control" placeholder="Kết luận của Hội đồng" value="${esc(a.council_conclusion || '')}">
            <button type="submit" class="btn btn-primary btn-sm">Lưu Lịch / Kết quả Hội đồng</button>
          </form>

          <form id="accFinalizeForm" style="border:1px solid #e2e8f0; border-radius:8px; padding:12px; display:grid; gap:6px;">
            <div style="font-weight:700; font-size:0.86rem;">Bước 5, 6 &amp; 7: Giải trình, QĐ Công nhận &amp; Thanh lý</div>
            <div style="display:flex; gap:6px;">
              <input id="accRevInput" class="form-control" placeholder="Tóm tắt giải trình tiếp thu sau họp" value="${esc(a.revision_summary || '')}">
              <button type="button" class="btn btn-outline btn-sm" onclick="window._accSubmitRevision()">5. Nộp Giải trình</button>
            </div>
            <div style="display:flex; gap:6px;">
              <input id="accRecNum" class="form-control" placeholder="Số QĐ công nhận (VD: 120/QĐ-TBG)" value="${esc(a.recognition_decision_number || '')}">
              <button type="button" class="btn btn-outline btn-sm" onclick="window._accRecognize()">6. Ký QĐ Công nhận</button>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
              <input type="number" name="liquidation_settled_amount" class="form-control" placeholder="Số tiền quyết toán (VNĐ)" value="${a.liquidation_settled_amount || ''}">
              <input type="number" name="liquidation_refund_amount" class="form-control" placeholder="Số tiền hoàn trả (VNĐ)" value="${a.liquidation_refund_amount || ''}">
            </div>
            <div style="display:flex; gap:6px;">
              <button type="submit" class="btn btn-primary btn-sm" style="background:#15803d; border-color:#15803d; flex:1;">7. Thanh lý Hoàn tất (COMPLETED)</button>
              <button type="button" class="btn btn-outline btn-sm" onclick="window._accCancelLiquidate()" style="color:#dc2626; border-color:#fca5a5;">Thanh lý Chấm dứt</button>
            </div>
          </form>
        </div>
      `;

      const councilForm = document.getElementById('accCouncilForm');
      if (councilForm) {
        councilForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const payload = Object.fromEntries(new FormData(councilForm).entries());
          await window._accAction('council', payload);
        });
      }

      const finForm = document.getElementById('accFinalizeForm');
      if (finForm) {
        finForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const payload = Object.fromEntries(new FormData(finForm).entries());
          payload.outcome = 'COMPLETED';
          await window._accAction('liquidate', payload);
        });
      }
    } catch (err) {
      box.innerHTML = `<div style="color:#dc2626;">Lỗi tải luồng nghiệm thu: ${esc(err.message)}</div>`;
    }
  }

  window._accAction = async function (endpoint, payload) {
    const r = await fetch(`/api/acceptances/project/${projectId}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
    const data = await r.json();
    if (!r.ok || !data.success) return notify(data.error || 'Thao tác thất bại', true);
    notify(data.message);
    await Promise.all([loadAcceptance(), loadActivityLogs()]);
  };

  window._accKhcnCheck = async function () {
    const note = prompt('Nhập nhận xét kiểm tra điều kiện của P. KHCN:', 'Đủ điều kiện nghiệm thu');
    if (note === null) return;
    await window._accAction('khcn-check', { khcn_notes: note });
  };

  window._accSubmitRevision = async function () {
    const val = document.getElementById('accRevInput')?.value || '';
    await window._accAction('revision', { revision_summary: val });
  };

  window._accRecognize = async function () {
    const num = document.getElementById('accRecNum')?.value?.trim();
    if (!num) return notify('Vui lòng nhập Số QĐ công nhận kết quả', true);
    await window._accAction('recognize', { recognition_decision_number: num });
  };

  window._accCancelLiquidate = async function () {
    if (!confirm('Xác nhận thanh lý CHẤM DỨT / HỦY đề tài này?')) return;
    await window._accAction('liquidate', { outcome: 'CANCELLED', liquidation_notes: 'Thanh lý chấm dứt hợp đồng' });
  };

  async function loadActivityLogs() {
    const box = document.getElementById('activityLogsContainer');
    if (!box) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/activity-logs?limit=60`);
      const json = await res.json();
      const logs = json.data || [];

      box.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; border-bottom:1px solid #e2e8f0; padding-bottom:10px;">
          <div>
            <h3 style="margin:0; font-size:1.02rem; font-weight:700; color:#0f172a;">Nhật ký Hoạt động Nghiệp vụ (${logs.length})</h3>
            <div style="font-size:0.8rem; color:#64748b;">Lưu vết toàn bộ thao tác hồ sơ phục vụ báo cáo Viện trưởng &amp; Thanh tra - Kiểm toán</div>
          </div>
          <button class="btn btn-outline btn-sm" onclick="window._reloadLogs()">Làm mới</button>
        </div>
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width:155px;">Thời gian</th>
                <th style="width:170px;">Người thực hiện</th>
                <th style="width:120px;">Vai trò</th>
                <th style="width:170px;">Hành động</th>
                <th>Nội dung chi tiết</th>
              </tr>
            </thead>
            <tbody>
              ${logs.length === 0 ? '<tr><td colspan="5" style="text-align:center; color:#64748b;">Chưa có nhật ký hoạt động nào cho đề tài này.</td></tr>' : logs.map(l => `
                <tr>
                  <td style="font-size:0.78rem; color:#475569;">${esc(l.created_at)}</td>
                  <td style="font-weight:600;">${esc(l.actor_name)}</td>
                  <td><span class="badge" style="background:#f1f5f9; color:#334155;">${esc(l.actor_role)}</span></td>
                  <td style="font-size:0.78rem; font-family:monospace; color:#0369a1;">${esc(l.action)}</td>
                  <td>${esc(l.summary)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } catch (err) {
      box.innerHTML = `<div style="color:#dc2626;">Lỗi tải nhật ký: ${esc(err.message)}</div>`;
    }
  }

  window._reloadLogs = loadActivityLogs;

  document.addEventListener('DOMContentLoaded', () => {
    loadProducts();
    loadAcceptance();
    loadActivityLogs();
  });
})();
