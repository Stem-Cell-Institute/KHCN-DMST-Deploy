(function () {
  const STEP_NAMES = {
    1: "Đề xuất",
    2: "Phân công",
    3: "Soạn thảo",
    4: "Thẩm định",
    5: "Lấy ý kiến",
    6: "Hoàn thiện",
    7: "Trình ký",
    8: "Ban hành",
    9: "Lưu trữ",
  };

  const STEP_STAT_NAMES = {
    1: "Nộp hồ sơ",
    2: "Phân công",
    3: "Soạn thảo",
    4: "Thẩm định",
    5: "Lấy ý kiến",
    6: "Hoàn thiện",
    7: "Trình ký",
    8: "Ban hành",
    9: "Lưu trữ",
  };

  const ATTACHMENT_CATEGORY_OPTIONS = [
    { value: "", label: "— Không gắn nhãn —" },
    { value: "draft_v1", label: "Dự thảo lần 1 (soạn thảo)" },
    { value: "final_draft", label: "Bản hoàn thiện sau góp ý" },
    { value: "submission_package", label: "Hồ sơ trình ký / gói tài liệu trình ban hành" },
    { value: "published_copy", label: "Bản đã ban hành / công bố" },
    { value: "reference", label: "Tài liệu tham khảo, minh chứng" },
    { value: "other", label: "Khác" },
  ];

  const state = {
    token: localStorage.getItem("token") || "",
    units: [],
    assignableUsers: [],
    docs: [],
    selectedId: null,
    me: null,
  };

  const el = {
    stats: document.getElementById("wf-stats"),
    createForm: document.getElementById("wf-create-form"),
    filterForm: document.getElementById("wf-filter-form"),
    docList: document.getElementById("wf-doc-list"),
    detail: document.getElementById("wf-detail-panel"),
    refreshBtn: document.getElementById("wf-refresh-btn"),
    greeting: document.getElementById("wf-greeting"),
  };

  function apiBase() {
    if (window.location.protocol === "file:" || (window.location.port && window.location.port !== "3000")) {
      return "http://localhost:3000";
    }
    return "";
  }

  function normalizeRoleToken(v) {
    return String(v || "").trim().toLowerCase().replace(/\s+/g, "_");
  }

  function userRoles() {
    const raw = state.me && state.me.role != null ? state.me.role : "";
    if (Array.isArray(raw)) return raw.map(normalizeRoleToken).filter(Boolean);
    const s = String(raw || "").trim();
    if (!s) return [];
    return s.split(/[,\s;|]+/).map(normalizeRoleToken).filter(Boolean);
  }

  function roleLabel(role) {
    const r = normalizeRoleToken(role);
    const map = {
      proposer: "Người đề xuất",
      leader: "Lãnh đạo Viện",
      drafter: "Người soạn thảo",
      reviewer: "Người thẩm định",
      admin: "Văn thư/Admin",
    };
    return map[r] || r || "unknown";
  }

  function historyActionLabel(action) {
    const key = String(action || "").trim().toLowerCase();
    const map = {
      proposal_created: "Khởi tạo hồ sơ",
      draft_assigned: "Phân công soạn thảo",
      upload_draft: "Upload dự thảo",
      review_approved: "Thẩm định: Duyệt",
      review_rejected: "Thẩm định: Từ chối",
      feedback_added: "Thêm góp ý",
      draft_finalized: "Hoàn thiện dự thảo",
      document_submitted: "Trình ký",
      document_published: "Ban hành",
      document_archived: "Lưu trữ hồ sơ",
      document_deleted: "Xóa hồ sơ",
      document_aborted: "Dừng quy trình",
      document_general_updated: "Cập nhật hồ sơ",
      attachment_uploaded: "Upload tệp đính kèm",
    };
    return map[key] || action || "Không xác định";
  }

  function userLabel(u) {
    const name = String((u && (u.fullname || u.fullName)) || "").trim();
    const email = String((u && u.email) || "").trim();
    if (name && email) return `${name} (${email})`;
    return name || email || `User #${u && u.id ? u.id : "?"}`;
  }

  function resolveAssignableUserInput(value) {
    const s = String(value || "").trim();
    if (!s) return null;
    const direct = state.assignableUsers.find((u) => userLabel(u) === s);
    if (direct) return direct;
    const m = s.match(/\(([^()]+@[^()]+)\)\s*$/);
    const email = m ? String(m[1] || "").trim().toLowerCase() : "";
    if (email) {
      const byEmail = state.assignableUsers.find((u) => String(u.email || "").trim().toLowerCase() === email);
      if (byEmail) return byEmail;
    }
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) {
      const byId = state.assignableUsers.find((u) => Number(u.id) === n);
      if (byId) return byId;
    }
    return null;
  }

  function normalizeDocType(v) {
    const raw = String(v || "").trim().toLowerCase();
    if (!raw) return "";
    const simple = raw
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/\s+/g, "_");
    const map = {
      quy_che: "quy_che",
      quy_dinh: "quy_dinh",
      noi_quy: "noi_quy",
      huong_dan: "huong_dan",
      quyche: "quy_che",
      quydinh: "quy_dinh",
      noiquy: "noi_quy",
      huongdan: "huong_dan",
    };
    return map[simple] || "";
  }

  function renderGreeting() {
    if (!el.greeting) return;
    const displayName =
      (state.me && (state.me.fullName || state.me.fullname || state.me.email)) ||
      "bạn";
    el.greeting.textContent = `Xin chào, ${String(displayName)}!`;
  }

  function hasRole(...roles) {
    const owned = new Set(userRoles());
    if (owned.has("admin")) return true;
    return roles.some((r) => owned.has(normalizeRoleToken(r)));
  }

  function ensureToastRoot() {
    let root = document.getElementById("wf-toast-root");
    if (root) return root;
    root = document.createElement("div");
    root.id = "wf-toast-root";
    root.className = "wf-toast-root";
    document.body.appendChild(root);
    return root;
  }

  function showToast(message, type) {
    const root = ensureToastRoot();
    const item = document.createElement("div");
    item.className = `wf-toast wf-toast-${type || "info"}`;
    item.textContent = String(message || "");
    root.appendChild(item);
    setTimeout(() => {
      item.classList.add("wf-toast-hide");
      setTimeout(() => item.remove(), 220);
    }, 2600);
  }

  async function api(path, options) {
    const headers = Object.assign({}, options && options.headers ? options.headers : {});
    if (state.token) headers.Authorization = "Bearer " + state.token;
    const response = await fetch(apiBase() + path, Object.assign({}, options || {}, { headers }));
    let json = null;
    try { json = await response.json(); } catch (_) {}
    if (!response.ok) {
      throw new Error((json && json.message) || ("HTTP " + response.status));
    }
    return json;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fillFilterOptions() {
    const stepSelect = el.filterForm.elements.step;
    for (let i = 1; i <= 9; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `Bước ${i} - ${STEP_NAMES[i]}`;
      stepSelect.appendChild(opt);
    }
    const unitSelect = el.filterForm.elements.unitId;
    state.units.forEach((u) => {
      const opt = document.createElement("option");
      opt.value = String(u.id);
      opt.textContent = `${u.name}${u.code ? " (" + u.code + ")" : ""}`;
      unitSelect.appendChild(opt);
    });
  }

  function renderStats(stats) {
    const byStepMap = {};
    (stats.byStep || []).forEach((x) => { byStepMap[String(x.current_step)] = x.count; });
    const fallbackInProgress = Object.keys(byStepMap)
      .map((k) => Number(k))
      .filter((k) => Number.isFinite(k) && k >= 1 && k <= 8)
      .reduce((sum, k) => sum + Number(byStepMap[String(k)] || 0), 0);
    const fallbackCompleted = Number(byStepMap["9"] || 0);
    const fallbackTotal = Object.values(byStepMap).reduce((sum, c) => sum + Number(c || 0), 0);
    const inProgressCount = Number(stats.inProgressCount != null ? stats.inProgressCount : fallbackInProgress);
    const completedCount = Number(stats.completedCount != null ? stats.completedCount : fallbackCompleted);
    const totalCount = Number(stats.totalCount != null ? stats.totalCount : fallbackTotal);
    const createdTodayCount = Number(stats.createdTodayCount || 0);
    const overdueCount = Number(stats.overdueCount || 0);
    const html = [];
    html.push(`<div class="wf-stat"><span class="num">${totalCount}</span><span class="lbl">Tổng hồ sơ</span><span class="sub">Toàn bộ hồ sơ hiện có</span></div>`);
    html.push(`<div class="wf-stat"><span class="num">${inProgressCount}</span><span class="lbl">Đang trong quy trình</span><span class="sub">Hồ sơ bước 1-8</span></div>`);
    html.push(`<div class="wf-stat"><span class="num">${completedCount}</span><span class="lbl">Đã hoàn thành</span><span class="sub">Đã lưu trữ (bước 9)</span></div>`);
    html.push(`<div class="wf-stat"><span class="num">${overdueCount}</span><span class="lbl">Trễ hạn</span><span class="sub">Quá deadline xử lý</span></div>`);
    html.push(`<div class="wf-stat"><span class="num">${createdTodayCount}</span><span class="lbl">Tạo hôm nay</span><span class="sub">Hồ sơ mới trong ngày</span></div>`);
    el.stats.innerHTML = html.join("");
  }

  function renderList() {
    if (!state.docs.length) {
      el.docList.innerHTML = '<p class="wf-muted">Không có hồ sơ phù hợp.</p>';
      return;
    }
    const canDelete = hasRole("master_admin", "admin");
    el.docList.innerHTML = state.docs.map((d) => `
      <article class="wf-doc-item ${Number(d.id) === Number(state.selectedId) ? "active" : ""}" data-id="${d.id}">
        <div class="wf-doc-item-head">
          <p class="title">${escapeHtml(d.title || "(Không tiêu đề)")}</p>
          ${canDelete ? `<button class="wf-btn wf-btn-small wf-btn-danger wf-doc-delete" type="button" data-id="${d.id}" title="Xóa mềm hồ sơ">Xóa</button>` : ""}
        </div>
        <p class="meta">#${d.id} | Bước ${d.current_step} - ${STEP_NAMES[d.current_step] || ""}</p>
        <p class="meta">Trạng thái: ${escapeHtml(d.status || "")}</p>
      </article>
    `).join("");
    el.docList.querySelectorAll(".wf-doc-item").forEach((item) => {
      item.addEventListener("click", async () => {
        state.selectedId = Number(item.getAttribute("data-id"));
        renderList();
        await loadDetail();
      });
    });
    el.docList.querySelectorAll(".wf-doc-delete").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const id = Number(btn.getAttribute("data-id"));
        if (!id) return;
        const ok = window.confirm(`Bạn chắc chắn muốn xóa hồ sơ #${id}? Thao tác này là xóa mềm (có thể tra cứu lịch sử).`);
        if (!ok) return;
        try {
          await api(`/api/documents/${id}`, { method: "DELETE" });
          if (Number(state.selectedId) === id) state.selectedId = null;
          showToast(`Đã xóa hồ sơ #${id}.`, "success");
          await loadDocuments();
          await loadStats();
          await loadDetail();
        } catch (e) {
          showToast("Xóa hồ sơ thất bại: " + e.message, "error");
        }
      });
    });
  }

  function timeline(currentStep) {
    const out = [];
    for (let i = 1; i <= 9; i++) {
      let cls = "wf-step";
      if (i < currentStep) cls += " done";
      if (i === currentStep) cls += " current";
      out.push(`<div class="${cls}"><b>${i}</b><span>${STEP_NAMES[i]}</span></div>`);
    }
    return `<div class="wf-stepper">${out.join("")}</div>`;
  }

  function formatDateTime(value) {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString("vi-VN");
  }

  function detailTemplate(doc) {
    const attachments = doc.attachments || [];
    const history = doc.history || [];
    const docStatus = String(doc.status || "").toLowerCase();
    const isArchived = docStatus === "archived" || Number(doc.current_step || 0) >= 9;
    const isAborted = docStatus === "aborted";
    const archivedText = isArchived
      ? `<p class="wf-final-status">Trang thái cuối: Đã lưu trữ hoàn tất${doc.archived_at ? ` (${escapeHtml(formatDateTime(doc.archived_at))})` : ""}.</p>`
      : "";
    const abortedText = isAborted
      ? `<p class="wf-final-status" style="border-color:#e7b7b7;background:#fff4f4;color:#9b2f2f;">Trạng thái cuối: Đã dừng quy trình tại bước ${Number(doc.current_step || 1)}.</p>`
      : "";
    const categoryOptions = ATTACHMENT_CATEGORY_OPTIONS
      .map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`)
      .join("");
    const selectedDrafter = state.assignableUsers.find((u) => Number(u.id) === Number(doc.assigned_to_id));
    const selectedDrafterLabel = selectedDrafter ? userLabel(selectedDrafter) : "";
    const drafterOptions = state.assignableUsers
      .map((u) => `<option value="${escapeHtml(userLabel(u))}" data-user-id="${Number(u.id)}"></option>`)
      .join("");
    const unitOptions = state.units
      .map((u) => `<option value="${u.id}" ${Number(doc.assigned_unit_id) === Number(u.id) ? "selected" : ""}>${escapeHtml(u.name)}</option>`)
      .join("");
    const roles = userRoles();
    const roleBadge = roles.length
      ? roles.map((r) => `<span class="wf-role-chip">${escapeHtml(roleLabel(r))}</span>`).join("")
      : `<span class="wf-role-chip wf-role-chip-muted">Không xác định role</span>`;
    return `
      <h2>${escapeHtml(doc.title || "")}</h2>
      <p class="wf-muted">Hồ sơ #${doc.id} - Bước hiện tại: <b>${doc.current_step}</b> (${STEP_NAMES[doc.current_step] || ""})</p>
      <div class="wf-role-debug">
        <span class="wf-role-debug-label">Role hiện tại:</span>
        <div class="wf-role-debug-list">${roleBadge}</div>
      </div>
      ${timeline(Number(doc.current_step) || 1)}

      <section class="wf-block">
        <h3>Thông tin hồ sơ</h3>
        ${archivedText}
        ${abortedText}
        <div class="wf-row">
          <div><b>Loại văn bản:</b> ${escapeHtml(doc.doc_type || "")}</div>
          <div><b>Trạng thái:</b> ${escapeHtml(doc.status || "")}</div>
          <div><b>Đơn vị chủ trì:</b> ${escapeHtml(doc.assigned_unit_id || "")}</div>
          <div><b>Người soạn thảo:</b> ${escapeHtml(doc.assigned_to_id || "")}</div>
        </div>
      </section>

      <section class="wf-block">
        <h3>Điều khiển quy trình</h3>
        <form id="wf-form-abort" class="wf-inline-form">
          <h4>Dừng quy trình (Abort)</h4>
          <div class="wf-row wf-row-1">
            <label>Lý do dừng (không bắt buộc)
              <textarea name="reason" rows="2" placeholder="Ví dụ: Hồ sơ test sai, dừng quy trình để tránh thao tác tiếp."></textarea>
            </label>
          </div>
          <button class="wf-btn wf-btn-small wf-btn-danger" type="submit" ${isAborted || isArchived ? "disabled" : ""}>Huỷ quy trình</button>
        </form>
      </section>

      <section class="wf-block">
        <h3>Biểu mẫu thao tác theo bước</h3>
        <div class="wf-form-stack">
          <form id="wf-form-assign" class="wf-inline-form">
            <h4>Bước 2 - Phân công soạn thảo</h4>
            <div class="wf-row">
              <label>Đơn vị chủ trì
                <select name="unitId" required>
                  <option value="">Chọn đơn vị</option>
                  ${unitOptions}
                </select>
              </label>
              <label>Người soạn thảo
                <input name="assignedToName" list="wf-drafter-options" placeholder="Nhập tên hoặc email..." value="${escapeHtml(selectedDrafterLabel)}" required>
                <input name="assignedToId" type="hidden" value="${escapeHtml(doc.assigned_to_id || "")}">
                <datalist id="wf-drafter-options">${drafterOptions}</datalist>
              </label>
              <label>Deadline
                <input name="deadline" type="date" value="${escapeHtml(doc.assignment_deadline || "")}">
              </label>
            </div>
            <button class="wf-btn wf-btn-small" type="submit">Lưu phân công</button>
          </form>

          <form id="wf-form-draft" class="wf-inline-form">
            <h4>Bước 3 - Soạn thảo dự thảo lần 1</h4>
            <p class="wf-muted" style="margin:0 0 8px;font-size:13px;">Nội dung văn bản nằm trong file đính kèm; không cần nhập lại vào ô văn bản.</p>
            <div class="wf-row wf-row-1">
              <label class="wf-row-1">File dự thảo (PDF/DOCX...)
                <input name="files" type="file" multiple required>
              </label>
            </div>
            <div class="wf-actions">
              <button class="wf-btn wf-btn-small" type="submit">Upload file dự thảo</button>
            </div>
          </form>

          <form id="wf-form-review" class="wf-inline-form">
            <h4>Bước 4 - Thẩm định</h4>
            <div class="wf-row">
              <label>Kết quả
                <select name="action" required>
                  <option value="approve">Duyệt (chuyển bước 5)</option>
                  <option value="reject">Từ chối (quay về bước 3)</option>
                </select>
              </label>
              <label>Nhận xét
                <textarea name="comment" rows="2" placeholder="Nhập nhận xét thẩm định"></textarea>
              </label>
            </div>
            <button class="wf-btn wf-btn-small" type="submit">Gửi thẩm định</button>
          </form>

          <form id="wf-form-feedback" class="wf-inline-form">
            <h4>Bước 5 - Góp ý</h4>
            <div class="wf-row wf-row-1">
              <label>Nội dung góp ý
                <textarea name="content" rows="2" required></textarea>
              </label>
            </div>
            <button class="wf-btn wf-btn-small" type="submit">Thêm góp ý</button>
          </form>

          <form id="wf-form-finalize" class="wf-inline-form">
            <h4>Bước 6 - Hoàn thiện dự thảo</h4>
            <div class="wf-row wf-row-1">
              <label>Giải trình tiếp thu
                <textarea name="explainReceive" rows="2"></textarea>
              </label>
              <label>Tổng hợp góp ý
                <textarea name="feedbackSummary" rows="2"></textarea>
              </label>
            </div>
            <button class="wf-btn wf-btn-small" type="submit">Lưu bước 6</button>
          </form>

          <form id="wf-form-submit" class="wf-inline-form">
            <h4>Bước 7 - Trình ký ban hành</h4>
            <div class="wf-row wf-row-1">
              <label>Ghi chú trình ký
                <textarea name="submitNote" rows="2"></textarea>
              </label>
            </div>
            <button class="wf-btn wf-btn-small" type="submit">Trình ký</button>
          </form>

          <form id="wf-form-publish" class="wf-inline-form">
            <h4>Bước 8 - Ban hành</h4>
            <div class="wf-row">
              <label>Số hiệu văn bản
                <input name="documentNumber" value="${escapeHtml(doc.document_number || "")}">
              </label>
              <label>Ngày ban hành
                <input name="publishDate" type="date" value="${escapeHtml(doc.publish_date || "")}">
              </label>
              <label class="wf-check">
                <input name="signedConfirmed" type="checkbox" ${Number(doc.signed_confirmed) === 1 ? "checked" : ""}>
                Đã ký/đóng dấu
              </label>
            </div>
            <button class="wf-btn wf-btn-small" type="submit">Ban hành</button>
          </form>

          <form id="wf-form-archive" class="wf-inline-form">
            <h4>Bước 9 - Lưu trữ</h4>
            <div class="wf-row">
              <label>Ngày hết hiệu lực (tùy chọn)
                <input name="expireDate" type="date" value="${escapeHtml(doc.expire_date || "")}">
              </label>
              <label>Nhắc rà soát sau (ngày)
                <input name="remindAfterDays" type="number" min="1" value="${escapeHtml(doc.remind_after_days || 180)}">
              </label>
            </div>
            <p class="wf-muted" style="margin:6px 0 0;font-size:12px;">
              Có thể để trống ngày hết hiệu lực. Văn bản sẽ hết hiệu lực khi có văn bản thay thế hoặc quyết định riêng.
            </p>
            <button class="wf-btn wf-btn-small" type="submit">${isArchived ? "Lưu cập nhật hậu kiểm" : "Lưu trữ hồ sơ"}</button>
          </form>
        </div>
      </section>

      <section class="wf-block">
        <h3>Upload file đính kèm</h3>
        <form id="wf-upload-form">
          <div class="wf-row">
            <label>Bước<input name="step" type="number" min="1" max="9" value="${doc.current_step || 1}"></label>
            <label>Phân loại tệp
              <select name="category">${categoryOptions}</select>
            </label>
          </div>
          <div class="wf-row wf-row-1">
            <label>Files<input name="files" type="file" multiple></label>
          </div>
          <div class="wf-form-actions"><button class="wf-btn wf-btn-small" type="submit">Upload</button></div>
        </form>
      </section>

      <section class="wf-block">
        <h3>Tệp đính kèm</h3>
        <ul class="wf-attachments">
          ${attachments.length ? attachments.map((a) => `<li>B${a.step} - <a href="${apiBase()}/api/attachments/${a.id}" target="_blank">${escapeHtml(a.original_name || "")}</a></li>`).join("") : "<li>Chưa có tệp đính kèm.</li>"}
        </ul>
      </section>

      <section class="wf-block">
        <h3>Lịch sử hoạt động</h3>
        <ul class="wf-history">
          ${history.length ? history.map((h) => `<li>[B${h.step}] <b>${escapeHtml(historyActionLabel(h.action))}</b> - ${escapeHtml(h.note || "")}</li>`).join("") : "<li>Chưa có lịch sử.</li>"}
        </ul>
      </section>
    `;
  }

  async function loadDetail() {
    if (!state.selectedId) return;
    try {
      const res = await api(`/api/documents/${state.selectedId}`);
      const doc = res.data || {};
      el.detail.innerHTML = detailTemplate(doc);
      bindDetailActions(doc);
    } catch (e) {
      el.detail.innerHTML = `<p class="wf-muted">Không tải được chi tiết: ${escapeHtml(e.message)}</p>`;
    }
  }

  async function doJson(method, path, payload) {
    return api(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
  }

  function numberOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function computeCaps(doc) {
    const uid = state.me && state.me.id ? Number(state.me.id) : null;
    const step = Number(doc.current_step || 1);
    const isAdmin = hasRole("admin");
    const isLeader = hasRole("leader");
    const isReviewer = hasRole("reviewer");
    const isDrafter = hasRole("drafter");
    const isAssigned = uid != null && Number(doc.assigned_to_id) === uid;
    const canDraft = isAdmin || isLeader || (isDrafter && isAssigned);
    const status = String(doc.status || "").toLowerCase();
    const isClosed = status === "aborted" || status === "archived";
    const canAbort = hasRole("module_manager", "master_admin", "admin") && !isClosed;
    if (isClosed) {
      return {
        assign: false,
        draft: false,
        review: false,
        feedback: false,
        finalize: false,
        submit: false,
        publish: false,
        archive: false,
        upload: false,
        abort: false,
      };
    }
    return {
      assign: (isAdmin || isLeader) && step <= 2,
      draft: canDraft && step === 3,
      review: (isAdmin || isReviewer) && step === 4,
      feedback: (isAdmin || isLeader || isReviewer || isDrafter) && step === 5,
      finalize: canDraft && step === 6,
      submit: canDraft && step === 7,
      publish: isAdmin && step === 8,
      archive: isAdmin && step >= 8,
      upload: isAdmin || isLeader || isReviewer || isDrafter,
      abort: canAbort,
    };
  }

  function applyFormVisibility(doc) {
    const caps = computeCaps(doc);
    const map = [
      ["#wf-form-abort", "abort", "Chỉ Module Manager trở lên được dừng quy trình."],
      ["#wf-form-assign", "assign", "Bước 2 chỉ dành cho Leader/Admin khi hồ sơ ở bước 1-2."],
      ["#wf-form-draft", "draft", "Bước 3 chỉ cho người soạn thảo được phân công (hoặc Leader/Admin)."],
      ["#wf-form-review", "review", "Bước 4 chỉ dành cho Reviewer/Admin khi hồ sơ đang ở bước 4."],
      ["#wf-form-feedback", "feedback", "Bước 5 chỉ thao tác khi hồ sơ đang ở bước lấy ý kiến."],
      ["#wf-form-finalize", "finalize", "Bước 6 chỉ cho người soạn thảo được phân công."],
      ["#wf-form-submit", "submit", "Bước 7 chỉ cho người soạn thảo được phân công."],
      ["#wf-form-publish", "publish", "Bước 8 chỉ dành cho Admin."],
      ["#wf-form-archive", "archive", "Bước 9 chỉ dành cho Admin."],
    ];
    map.forEach(([selector, key, hint]) => {
      const form = el.detail.querySelector(selector);
      if (!form) return;
      const ok = !!caps[key];
      form.classList.toggle("is-enabled", ok);
      form.classList.toggle("is-disabled", !ok);
      form.removeAttribute("data-tooltip");
      form.removeAttribute("title");
      const controls = form.querySelectorAll("input, textarea, select, button");
      controls.forEach((ctrl) => {
        ctrl.disabled = !ok;
      });
      let note = form.querySelector(".wf-inline-note");
      if (!note) {
        note = document.createElement("p");
        note.className = "wf-inline-note";
        form.appendChild(note);
      }
      note.textContent = ok ? "" : hint;
      note.style.display = ok ? "none" : "";
    });
    const upload = el.detail.querySelector("#wf-upload-form");
    if (upload) {
      const controls = upload.querySelectorAll("input, textarea, select, button");
      controls.forEach((ctrl) => {
        ctrl.disabled = !caps.upload;
      });
      upload.classList.toggle("is-enabled", !!caps.upload);
      upload.classList.toggle("is-disabled", !caps.upload);
      upload.removeAttribute("data-tooltip");
      upload.removeAttribute("title");
      let note = upload.querySelector(".wf-inline-note");
      if (!note) {
        note = document.createElement("p");
        note.className = "wf-inline-note";
        upload.appendChild(note);
      }
      note.textContent = caps.upload ? "" : "Bạn không có quyền upload tệp cho hồ sơ này.";
      note.style.display = caps.upload ? "none" : "";
    }
  }

  function setFormLoading(form, isLoading, busyText) {
    if (!form) return;
    form.classList.toggle("is-loading", !!isLoading);
    const controls = form.querySelectorAll("input, textarea, select, button");
    controls.forEach((ctrl) => {
      if (ctrl.dataset.baseDisabled == null) {
        ctrl.dataset.baseDisabled = ctrl.disabled ? "1" : "0";
      }
      if (isLoading) {
        ctrl.disabled = true;
      } else if (ctrl.dataset.baseDisabled === "0") {
        ctrl.disabled = false;
      }
    });
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
      if (!submitBtn.dataset.baseText) submitBtn.dataset.baseText = submitBtn.textContent;
      submitBtn.textContent = isLoading ? (busyText || "Đang xử lý...") : submitBtn.dataset.baseText;
    }
  }

  function bindDetailActions(doc) {
    const bindForm = (selector, handler) => {
      const form = el.detail.querySelector(selector);
      if (!form) return;
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        try {
          const payload = new FormData(form);
          setFormLoading(form, true, "Đang gửi...");
          await handler(payload, form);
          showToast("Thao tác thành công.", "success");
          await loadDocuments();
          await loadStats();
          await loadDetail();
        } catch (e) {
          showToast("Lỗi: " + e.message, "error");
        } finally {
          setFormLoading(form, false);
        }
      });
    };

    bindForm("#wf-form-assign", async (fd, form) => {
      const unitRaw =
        form && form.elements && form.elements.unitId && form.elements.unitId.value != null
          ? String(form.elements.unitId.value).trim()
          : String(fd.get("unitId") || "").trim();
      const unitId = numberOrNull(unitRaw);
      const nameRaw =
        form && form.querySelector('input[name="assignedToName"]')
          ? String(form.querySelector('input[name="assignedToName"]').value || "").trim()
          : String(fd.get("assignedToName") || "").trim();
      let assignedToId = numberOrNull(fd.get("assignedToId"));
      if (!assignedToId) {
        const resolved = resolveAssignableUserInput(nameRaw);
        assignedToId = resolved ? numberOrNull(resolved.id) : null;
      }
      const deadlineRaw =
        form && form.querySelector('input[name="deadline"]')
          ? String(form.querySelector('input[name="deadline"]').value || "").trim()
          : String(fd.get("deadline") || "").trim();
      const deadline = deadlineRaw;
      if (!unitId) throw new Error("Vui lòng chọn đơn vị chủ trì hợp lệ.");
      if ((!assignedToId || assignedToId <= 0) && !nameRaw) throw new Error("Vui lòng nhập người soạn thảo.");
      if (!deadline) throw new Error("Vui lòng nhập deadline cho bước phân công.");
      await doJson("PUT", `/api/documents/${doc.id}/assign`, {
        unitId,
        assignedToId,
        assignedToName: nameRaw,
        deadline,
      });
    });

    bindForm("#wf-form-review", async (fd) => {
      const action = String(fd.get("action") || "").trim();
      const comment = String(fd.get("comment") || "").trim();
      if (!["approve", "reject"].includes(action)) throw new Error("Action thẩm định không hợp lệ.");
      if (action === "reject" && comment.length < 8) {
        throw new Error("Khi từ chối cần nhập nhận xét tối thiểu 8 ký tự.");
      }
      await doJson("POST", `/api/documents/${doc.id}/review`, {
        action,
        comment,
      });
    });

    bindForm("#wf-form-draft", async (fd) => {
      const hasFile = fd.getAll("files").some((f) => f && typeof f === "object" && f.size > 0);
      if (!hasFile) throw new Error("Bước 3 cần upload ít nhất 1 file dự thảo.");
      await api(`/api/documents/${doc.id}/draft`, { method: "POST", body: fd });
    });

    bindForm("#wf-form-feedback", async (fd) => {
      const content = String(fd.get("content") || "").trim();
      if (content.length < 5) throw new Error("Nội dung góp ý tối thiểu 5 ký tự.");
      await doJson("POST", `/api/documents/${doc.id}/feedback`, {
        content,
      });
    });

    bindForm("#wf-form-finalize", async (fd) => {
      const explainReceive = String(fd.get("explainReceive") || "").trim();
      const feedbackSummary = String(fd.get("feedbackSummary") || "").trim();
      if (!explainReceive && !feedbackSummary) {
        throw new Error("Cần nhập ít nhất giải trình tiếp thu hoặc tổng hợp góp ý.");
      }
      await doJson("POST", `/api/documents/${doc.id}/finalize`, {
        explainReceive,
        feedbackSummary,
      });
    });

    bindForm("#wf-form-submit", async (fd) => {
      const submitNote = String(fd.get("submitNote") || "").trim();
      if (!submitNote) throw new Error("Vui lòng nhập ghi chú trình ký.");
      await doJson("POST", `/api/documents/${doc.id}/submit`, {
        submitNote,
      });
    });

    bindForm("#wf-form-publish", async (fd) => {
      const documentNumber = String(fd.get("documentNumber") || "").trim();
      const publishDate = String(fd.get("publishDate") || "").trim();
      if (!documentNumber) throw new Error("Bước ban hành cần nhập số hiệu văn bản.");
      if (!publishDate) throw new Error("Bước ban hành cần nhập ngày ban hành.");
      const payload = new FormData();
      payload.append("signedConfirmed", fd.get("signedConfirmed") ? "true" : "false");
      payload.append("documentNumber", documentNumber);
      payload.append("publishDate", publishDate);
      await api(`/api/documents/${doc.id}/publish`, { method: "PUT", body: payload });
    });

    bindForm("#wf-form-archive", async (fd) => {
      const remindAfterDaysRaw = String(fd.get("remindAfterDays") || "").trim();
      const remindAfterDays = remindAfterDaysRaw ? numberOrNull(remindAfterDaysRaw) : null;
      if (remindAfterDaysRaw && (!remindAfterDays || remindAfterDays <= 0)) {
        throw new Error("Số ngày nhắc rà soát phải là số dương.");
      }
      await doJson("PUT", `/api/documents/${doc.id}/archive`, {
        expireDate: fd.get("expireDate") || null,
        remindAfterDays,
      });
    });

    bindForm("#wf-form-abort", async (fd) => {
      const reason = String(fd.get("reason") || "").trim();
      const ok = window.confirm(`Bạn chắc chắn muốn dừng quy trình hồ sơ #${doc.id}?`);
      if (!ok) return;
      await doJson("PUT", `/api/documents/${doc.id}/abort`, { reason });
    });

    const uploadForm = el.detail.querySelector("#wf-upload-form");
    if (uploadForm) {
      uploadForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        try {
          setFormLoading(uploadForm, true, "Đang upload...");
          const fd = new FormData(uploadForm);
          const step = numberOrNull(fd.get("step"));
          if (!step || step < 1 || step > 9) throw new Error("Bước upload phải nằm trong khoảng 1-9.");
          const files = uploadForm.querySelector('input[name="files"]');
          if (!files || !files.files || !files.files.length) throw new Error("Vui lòng chọn ít nhất 1 file.");
          await api(`/api/documents/${doc.id}/attachments`, { method: "POST", body: fd });
          showToast("Upload thành công.", "success");
          await loadDetail();
        } catch (e) {
          showToast("Upload lỗi: " + e.message, "error");
        } finally {
          setFormLoading(uploadForm, false);
        }
      });
    }

    const assignForm = el.detail.querySelector("#wf-form-assign");
    if (assignForm) {
      const nameInput = assignForm.querySelector('input[name="assignedToName"]');
      const idInput = assignForm.querySelector('input[name="assignedToId"]');
      const datalist = assignForm.querySelector("#wf-drafter-options");
      const syncAssignedToId = () => {
        if (!nameInput || !idInput || !datalist) return;
        const picked = Array.from(datalist.options).find((o) => o.value === nameInput.value);
        if (picked && picked.dataset.userId) {
          idInput.value = String(picked.dataset.userId);
          return;
        }
        const resolved = resolveAssignableUserInput(nameInput.value);
        idInput.value = resolved ? String(resolved.id) : "";
      };
      if (nameInput) {
        nameInput.addEventListener("input", syncAssignedToId);
        nameInput.addEventListener("change", syncAssignedToId);
      }
      syncAssignedToId();
    }

    applyFormVisibility(doc);
  }

  async function loadDocuments() {
    const form = el.filterForm;
    const params = new URLSearchParams();
    ["search", "step", "status", "unitId"].forEach((k) => {
      const val = String(form.elements[k].value || "").trim();
      if (val) params.set(k, val);
    });
    const res = await api(`/api/documents?${params.toString()}`);
    state.docs = res.data || [];
    const selectedExists = state.docs.some((d) => Number(d.id) === Number(state.selectedId));
    if (!selectedExists) {
      state.selectedId = state.docs.length ? Number(state.docs[0].id) : null;
    }
    renderList();
  }

  async function loadStats() {
    const res = await api("/api/dashboard/stats");
    renderStats(res.data || { byStep: [], totalCount: 0, inProgressCount: 0, completedCount: 0, createdTodayCount: 0, overdueCount: 0 });
  }

  async function init() {
    if (!state.token) {
      showToast("Bạn chưa đăng nhập. Vui lòng đăng nhập trước.", "error");
    }
    try {
      state.me = await api("/api/me");
    } catch (_) {}
    renderGreeting();
    try {
      const units = await api("/api/units");
      state.units = units.data || [];
      fillFilterOptions();
    } catch (_) {}
    try {
      const users = await api("/api/users/assignable");
      state.assignableUsers = Array.isArray(users && users.data) ? users.data : [];
    } catch (_) {
      state.assignableUsers = [];
    }

    el.createForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        const fd = new FormData(el.createForm);
        const titleInput = el.createForm.querySelector('input[name="title"]');
        const title =
          titleInput && titleInput.value != null
            ? String(titleInput.value).trim()
            : String(fd.get("title") || fd.get("documentTitle") || fd.get("name") || "").trim();
        if (!title) throw new Error("Thiếu tiêu đề.");
        const docType = normalizeDocType(fd.get("doc_type")) || "quy_che";
        setFormLoading(el.createForm, true, "Đang tạo...");
        await doJson("POST", "/api/documents", {
          title,
          doc_type: docType,
          reason: String(fd.get("reason") || "").trim(),
          proposalSummary: String(fd.get("proposalSummary") || "").trim(),
        });
        el.createForm.reset();
        await loadDocuments();
        await loadStats();
        await loadDetail();
        showToast("Đã tạo hồ sơ mới.", "success");
      } catch (e) {
        showToast("Tạo hồ sơ thất bại: " + e.message, "error");
      } finally {
        setFormLoading(el.createForm, false);
      }
    });

    el.filterForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      await loadDocuments();
      await loadDetail();
    });

    el.refreshBtn.addEventListener("click", async () => {
      await loadDocuments();
      await loadStats();
      await loadDetail();
    });

    await loadDocuments();
    await loadStats();
    await loadDetail();
  }

  init().catch((e) => {
    console.error(e);
    showToast("Không khởi tạo được giao diện: " + e.message, "error");
  });
})();
