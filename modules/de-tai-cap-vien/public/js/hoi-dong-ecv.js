(function () {
  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg, isError = false) {
    const c = document.getElementById('toastContainer');
    if (!c) return alert(msg);
    const el = document.createElement('div');
    el.className = `toast ${isError ? 'toast-error' : 'toast-success'}`;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  window.switchNationalTab = function (tabId, btn) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const target = document.getElementById(tabId);
    if (target) target.classList.add('active');
  };

  window.loadCouncilTargets = async function () {
    const type = document.getElementById('councilTargetType').value;
    const sel = document.getElementById('councilTargetSelect');
    sel.innerHTML = '<option value="">Đang tải...</option>';

    try {
      if (type === 'PROJECT') {
        const r = await fetch('/api/projects?limit=200');
        const j = await r.json();
        const list = j.data || [];
        sel.innerHTML = list.map(p => `<option value="${p.id}">[${esc(p.code)}] ${esc(p.title)} (${esc(p.leader_name)})</option>`).join('');
      } else {
        const r = await fetch('/api/calls');
        const j = await r.json();
        const calls = j.data || [];
        let proposals = [];
        for (const c of calls.slice(0, 5)) {
          const rp = await fetch(`/api/calls/${c.id}/proposals`);
          const jp = await rp.json();
          if (jp.data) proposals = proposals.concat(jp.data);
        }
        sel.innerHTML = proposals.length
          ? proposals.map(pr => `<option value="${pr.id}">[${esc(pr.proposal_code)}] ${esc(pr.title)} (${esc(pr.leader_name)})</option>`).join('')
          : '<option value="">Chưa có hồ sơ đề xuất nào</option>';
      }
      await loadCouncilScores();
    } catch (err) {
      sel.innerHTML = `<option value="">Lỗi tải danh sách</option>`;
    }
  };

  window.loadCouncilScores = async function () {
    const type = document.getElementById('councilTargetType').value;
    const id = document.getElementById('councilTargetSelect').value;
    const banner = document.getElementById('councilSummaryBanner');
    const tbody = document.getElementById('councilScoresBody');

    if (!id) {
      banner.innerHTML = 'Vui lòng chọn một đề tài hoặc hồ sơ đề xuất.';
      tbody.innerHTML = '';
      return;
    }

    const r = await fetch(`/api/councils/${type}/${id}`);
    const j = await r.json();
    const scores = j.data || [];
    const sum = j.summary || {};

    banner.innerHTML = `
      <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:12px; align-items:center;">
        <div>
          <strong>Tổng số phiếu đã chấm:</strong> ${sum.count || 0} &nbsp;|&nbsp;
          <strong>Điểm trung bình Hội đồng:</strong> <span style="font-size:1.1rem; color:#0369a1; font-weight:700;">${sum.average_score || 0}/100</span>
          ${sum.rating ? `<span class="badge" style="background:#0284c7; color:#fff; margin-left:6px;">${esc(sum.rating)}</span>` : ''}
        </div>
        <div style="font-size:0.85rem;">
          Đạt: <strong style="color:#15803d;">${sum.votes_dat || 0}</strong> &nbsp;•&nbsp;
          Đạt (chỉnh sửa): <strong style="color:#b45309;">${sum.votes_dat_chinh_sua || 0}</strong> &nbsp;•&nbsp;
          Không đạt: <strong style="color:#dc2626;">${sum.votes_khong_dat || 0}</strong>
        </div>
      </div>
    `;

    tbody.innerHTML = scores.length === 0
      ? '<tr><td colspan="9" style="text-align:center; color:#64748b;">Chưa có thành viên Hội đồng nào chấm điểm trực tuyến.</td></tr>'
      : scores.map(s => `
        <tr>
          <td style="font-weight:600;">${esc(s.member_name)}</td>
          <td>${esc(s.member_role)}</td>
          <td>${s.score_scientific}</td>
          <td>${s.score_methodology}</td>
          <td>${s.score_impact}</td>
          <td>${s.score_budget}</td>
          <td style="font-weight:700; color:#0369a1;">${s.total_score}</td>
          <td>${esc(s.vote)}</td>
          <td style="font-size:0.82rem;">${esc(s.comments || '--')}</td>
        </tr>
      `).join('');
  };

  async function loadResearchersList() {
    const sel = document.getElementById('researcherSelect');
    const r = await fetch('/api/researchers');
    const j = await r.json();
    const list = j.data || [];
    sel.innerHTML = list.map(u => `<option value="${esc(u.full_name)}">${esc(u.academic_title ? u.academic_title + ' ' : '')}${esc(u.full_name)} (${u.project_count || 0} đề tài)</option>`).join('');
    if (list.length > 0) await loadResearcherECV();
  }

  window.loadResearcherECV = async function () {
    const name = document.getElementById('researcherSelect').value;
    const area = document.getElementById('ecvContentArea');
    if (!name) return;

    const r = await fetch(`/api/researchers/ecv?name=${encodeURIComponent(name)}`);
    const j = await r.json();
    if (!j.success) {
      area.innerHTML = `<div style="color:#dc2626;">${esc(j.error)}</div>`;
      return;
    }

    const { profile: pf, projects, products, stats } = j.data;

    area.innerHTML = `
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin-bottom:1.25rem;">
        <div style="background:#f0f9ff; border:1px solid #bae6fd; border-radius:8px; padding:10px;">
          <div style="font-size:0.76rem; color:#0369a1;">Tổng đề tài chủ trì</div>
          <div style="font-size:1.3rem; font-weight:700;">${stats.total_projects}</div>
        </div>
        <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:10px;">
          <div style="font-size:0.76rem; color:#15803d;">Đã hoàn thành</div>
          <div style="font-size:1.3rem; font-weight:700;">${stats.completed_projects}</div>
        </div>
        <div style="background:#faf5ff; border:1px solid #e9d5ff; border-radius:8px; padding:10px;">
          <div style="font-size:0.76rem; color:#7e22ce;">Bài báo / Sáng chế / ĐT</div>
          <div style="font-size:1.3rem; font-weight:700;">${stats.papers_count} / ${stats.patents_count} / ${stats.trainings_count}</div>
        </div>
        <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:10px;">
          <div style="font-size:0.76rem; color:#b45309;">Tổng kinh phí chủ trì</div>
          <div style="font-size:1.1rem; font-weight:700;">${Number(stats.total_budget || 0).toLocaleString('vi-VN')} đ</div>
        </div>
      </div>

      <form id="ecvEditForm" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px; background:#f8fafc; padding:14px; border-radius:8px; border:1px solid #e2e8f0; margin-bottom:1.25rem;">
        <input type="hidden" name="full_name" value="${esc(pf.full_name)}">
        <div>
          <label class="form-label">Học hàm / Học vị</label>
          <input name="academic_title" class="form-control" value="${esc(pf.academic_title || '')}" placeholder="VD: PGS.TS., TS., ThS.">
        </div>
        <div>
          <label class="form-label">Nhóm nghiên cứu / Đơn vị</label>
          <input name="research_group" class="form-control" value="${esc(pf.research_group || '')}">
        </div>
        <div>
          <label class="form-label">Chức vụ</label>
          <input name="position_title" class="form-control" value="${esc(pf.position_title || '')}">
        </div>
        <div>
          <label class="form-label">Email công vụ</label>
          <input name="email" class="form-control" value="${esc(pf.email || '')}">
        </div>
        <div>
          <label class="form-label">ORCID ID</label>
          <input name="orcid" class="form-control" value="${esc(pf.orcid || '')}" placeholder="0000-000X-XXXX-XXXX">
        </div>
        <div>
          <label class="form-label">Google Scholar / Scopus</label>
          <input name="google_scholar_url" class="form-control" value="${esc(pf.google_scholar_url || '')}" placeholder="https://scholar.google.com/...">
        </div>
        <div style="grid-column: 1 / -1;">
          <label class="form-label">Lĩnh vực chuyên môn &amp; Quá trình đào tạo / công tác</label>
          <textarea name="specialization" class="form-control" rows="2" placeholder="Hướng nghiên cứu chính, quá trình đào tạo...">${esc(pf.specialization || '')}</textarea>
        </div>
        <div style="grid-column: 1 / -1;">
          <button type="submit" class="btn btn-primary btn-sm">Lưu cập nhật e-CV</button>
        </div>
      </form>

      <h4 style="margin:0 0 8px; font-size:0.98rem;">Đề tài NCKH đã &amp; đang chủ trì (${projects.length})</h4>
      <div class="table-responsive" style="margin-bottom:1.25rem;">
        <table class="data-table">
          <thead>
            <tr><th>Mã số</th><th>Tên đề tài</th><th>Nhóm</th><th>Kinh phí</th><th>Trạng thái</th></tr>
          </thead>
          <tbody>
            ${projects.map(p => `
              <tr>
                <td><a href="/chi-tiet.html?id=${p.id}" style="font-weight:600; color:#0369a1;">${esc(p.code)}</a></td>
                <td>${esc(p.title)}</td>
                <td>${esc(p.research_group || '--')}</td>
                <td>${Number(p.budget_total || 0).toLocaleString('vi-VN')} đ</td>
                <td>${esc(p.status)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <h4 style="margin:0 0 8px; font-size:0.98rem;">Sản phẩm KHCN tích lũy từ các đề tài (${products.length})</h4>
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr><th>Đề tài</th><th>Loại</th><th>Tên sản phẩm</th><th>Tạp chí / Bậc</th><th>Xếp hạng</th><th>Năm</th></tr>
          </thead>
          <tbody>
            ${products.length === 0 ? '<tr><td colspan="6" style="text-align:center; color:#64748b;">Chưa có sản phẩm KHCN nào được ghi nhận.</td></tr>' : products.map(pr => `
              <tr>
                <td>${esc(pr.project_code)}</td>
                <td>${esc(pr.product_type)}</td>
                <td style="font-weight:600;">${esc(pr.title)}</td>
                <td>${esc(pr.venue_or_degree || '--')}</td>
                <td>${esc(pr.quartile_or_rank || '--')}</td>
                <td>${esc(pr.publish_year || '--')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    const form = document.getElementById('ecvEditForm');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = Object.fromEntries(new FormData(form).entries());
        const res = await fetch('/api/researchers/ecv', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data.success) return toast(data.error || 'Lỗi lưu e-CV', true);
        toast(data.message);
      });
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    const scoreForm = document.getElementById('councilScoreForm');
    if (scoreForm) {
      scoreForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const type = document.getElementById('councilTargetType').value;
        const id = document.getElementById('councilTargetSelect').value;
        if (!id) return toast('Chưa chọn đề tài/đề xuất', true);
        const payload = Object.fromEntries(new FormData(scoreForm).entries());
        const r = await fetch(`/api/councils/${type}/${id}/score`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await r.json();
        if (!r.ok || !data.success) return toast(data.error || 'Lỗi gửi phiếu chấm', true);
        toast(data.message);
        await loadCouncilScores();
      });
    }

    loadCouncilTargets();
    loadResearchersList();
  });
})();
