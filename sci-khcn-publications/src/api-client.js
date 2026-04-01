/**
 * api-client.js — dán vào <script> của cong-bo-khoa-hoc.html
 * Thay thế toàn bộ phần mock data bằng gọi API thực
 *
 * Cursor prompt:
 *   "Thay các hàm mock trong cong-bo-khoa-hoc.html bằng các hàm trong file này,
 *    đảm bảo BASE_URL trỏ đúng vào backend Express đang chạy"
 */

const BASE_URL = window.SCI_API_URL || '/api';  // prod: '/api' | dev: 'http://localhost:3001/api'

// ── Publications API ──────────────────────────────────────────────────────────

/** Lấy danh sách công bố với filter + pagination */
export async function listPublications(params = {}) {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
  ).toString();
  const res = await apiFetch(`/publications?${qs}`);
  return res; // { ok, data: [], pagination: { total, page, limit, totalPages } }
}

/** Thống kê tổng hợp cho dashboard */
export async function getStats() {
  return apiFetch('/publications/stats');
}

/** Chi tiết 1 công bố */
export async function getPublication(id) {
  return apiFetch(`/publications/${id}`);
}

/** Tạo mới công bố thủ công */
export async function createPublication(data) {
  return apiFetch('/publications', { method: 'POST', body: data });
}

/** Cập nhật công bố */
export async function updatePublication(id, data) {
  return apiFetch(`/publications/${id}`, { method: 'PUT', body: data });
}

/** Xóa công bố */
export async function deletePublication(id) {
  return apiFetch(`/publications/${id}`, { method: 'DELETE' });
}

// ── DOI Fetch API ─────────────────────────────────────────────────────────────

/**
 * Gọi backend → Crossref + PubMed + Unpaywall → trả về metadata đầy đủ
 * Dùng để điền tự động form thêm công bố
 *
 * @param {string} doi — "10.xxxx/xxxxx"
 * @returns enriched publication object để điền vào form
 */
export async function fetchDOIFromServer(doi) {
  const res = await apiFetch('/doi/fetch', { method: 'POST', body: { doi } });
  if (!res.ok) throw new Error(res.error || 'Không tìm thấy DOI');
  return res.data;
}

// Gắn vào nút "🔍 Tự động điền" trong HTML
window.fetchDOI = async function () {
  const doi = document.getElementById('addDoi')?.value?.trim();
  if (!doi) { showNotif('Vui lòng nhập DOI'); return; }

  const btn = document.querySelector('.doi-fetch-row .btn-primary');
  const origText = btn?.innerHTML;
  if (btn) { btn.innerHTML = '<span style="animation:spin 1s linear infinite;display:inline-block">⟳</span> Đang tra…'; btn.disabled = true; }

  try {
    showNotif('⏳ Đang tra cứu Crossref + PubMed…');
    const data = await fetchDOIFromServer(doi);

    // Điền vào form
    const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
    set('addTitle',   data.title);
    set('addAuthors', data.authors);
    set('addJournal', data.journal_name);
    set('addYear',    data.pub_year);
    set('addISSN',    data.issn);
    set('addIF',      data.impact_factor);
    set('addStatus',  data.status || 'published');
    if (data.pub_type) {
      const typeMap = { journal:'journal', conference:'conference', book_chapter:'book', patent:'patent', preprint:'preprint' };
      set('addType', typeMap[data.pub_type] || 'journal');
    }
    if (data.is_open_access) set('addDB', 'scopus-wos');

    // Hiển thị PMID nếu có
    if (data.pmid) showNotif(`✅ Đã điền từ Crossref & PubMed (PMID: ${data.pmid})`);
    else           showNotif('✅ Đã tự động điền từ Crossref!');

  } catch (err) {
    showNotif(`❌ ${err.message}`);
  } finally {
    if (btn) { btn.innerHTML = origText; btn.disabled = false; }
  }
};

// ── ORCID Harvest API (SSE) ───────────────────────────────────────────────────

/**
 * Bắt đầu phiên harvest từ ORCID bằng SSE
 * Nhận progress theo từng NCV theo thời gian thực
 *
 * @param {object} callbacks
 *   onResearcherStart(index, total, name, orcid)
 *   onResearcherDone(name, orcid, worksFound, newFound, newItems)
 *   onComplete(sessionId, totalNew)
 *   onError(message)
 */
export function startORCIDHarvestStream(callbacks = {}) {
  const es = new EventSource(`${BASE_URL}/orcid/harvest/stream`);

  es.onmessage = (e) => {
    let event;
    try { event = JSON.parse(e.data); } catch { return; }

    switch (event.type) {
      case 'session_start':
        callbacks.onSessionStart?.();
        break;
      case 'researcher_start':
        callbacks.onResearcherStart?.(event.index, event.total, event.name, event.orcid);
        break;
      case 'researcher_done':
        callbacks.onResearcherDone?.(event);
        break;
      case 'session_complete':
        callbacks.onComplete?.(event.sessionId, event.totalNew, event.results);
        break;
      case 'error':
        callbacks.onError?.(event.message);
        break;
    }
  };

  es.addEventListener('done', () => {
    es.close();
    callbacks.onStreamClose?.();
  });

  es.onerror = (err) => {
    console.error('[SSE] Lỗi kết nối:', err);
    es.close();
    callbacks.onError?.('Mất kết nối với server');
  };

  return es; // caller có thể gọi es.close() để huỷ
}

// Gắn vào nút harvest trong HTML
window.startHarvest = async function () {
  if (window._harvestES) {
    window._harvestES.close();
    window._harvestES = null;
  }

  // Reset UI
  document.getElementById('harvestLog').innerHTML = '';
  document.getElementById('harvestResultsContainer').innerHTML = '';
  document.getElementById('harvestSummary').style.display = 'none';
  document.getElementById('harvestEmptyState').style.display = 'none';
  document.getElementById('newBadgeCount').style.display = 'none';
  document.getElementById('importAllBtn').style.display = 'none';

  let totalNew = 0;

  const btn = document.getElementById('startHarvestBtn');
  btn.innerHTML = '<span style="animation:spin 1s linear infinite;display:inline-block">⟳</span> Đang quét…';
  btn.classList.add('running');
  document.getElementById('harvestProgressFill').style.width = '0%';

  window._harvestES = startORCIDHarvestStream({
    onSessionStart: () => {
      addLog('=== Bắt đầu phiên thu thập ORCID ===', 'info');
      addLog('Endpoint: https://pub.orcid.org/v3.0/{orcid}/works', 'info');
      addLog('Nguồn phụ: Crossref API + PubMed E-utilities + Unpaywall', 'info');
    },

    onResearcherStart: (index, total, name, orcid) => {
      addLog(`→ Quét ${name} (${orcid})…`);
      const chip = document.getElementById(`chip-${index}`);
      if (chip) chip.classList.add('checking');
      const pct = Math.round(index / total * 100);
      document.getElementById('harvestProgressFill').style.width = pct + '%';
    },

    onResearcherDone: (event) => {
      const { index, total, name, orcid, worksFound, newFound, skipped, newItems, error } = event;
      const chip = document.getElementById(`chip-${index}`);

      if (error) {
        addLog(`  ✗ ${name}: LỖI — ${error}`, 'err');
        if (chip) { chip.classList.remove('checking'); chip.classList.add('error'); }
      } else if (newFound > 0) {
        addLog(`  ✓ ${name}: ${worksFound} works — phát hiện ${newFound} CÔNG BỐ MỚI!`);
        if (chip) {
          chip.classList.remove('checking');
          chip.classList.add('done-new');
          chip.innerHTML += `<span class="chip-badge">+${newFound}</span>`;
        }
        newItems.forEach(w => {
          addLog(`    📄 ${w.doi} — "${(w.title||'').substring(0,55)}…"`);
          renderNewPubCard(w, totalNew++);
        });
      } else {
        addLog(`  ✓ ${name}: ${worksFound} works — tất cả đã có trong CSDL`);
        if (chip) { chip.classList.remove('checking'); chip.classList.add('done-none'); }
      }

      // Cập nhật summary bar
      document.getElementById('sumChecked').textContent = index + 1;
      document.getElementById('sumWorks').textContent =
        (parseInt(document.getElementById('sumWorks').textContent || '0') + worksFound);
      document.getElementById('sumNew').textContent = totalNew;
      document.getElementById('sumSkipped').textContent =
        (parseInt(document.getElementById('sumSkipped').textContent || '0') + skipped);
      document.getElementById('harvestSummary').style.display = 'flex';

      const pct = Math.round((index + 1) / total * 100);
      document.getElementById('harvestProgressFill').style.width = pct + '%';
    },

    onComplete: (sessionId, total, results) => {
      addLog(`=== Hoàn thành — ${total} công bố mới phát hiện ===`, 'info');
      btn.innerHTML = '✓ Quét xong — Chạy lại';
      btn.classList.remove('running');

      document.getElementById('lastSyncInfo').textContent =
        `Quét lúc ${new Date().toLocaleString('vi-VN')} · session: ${sessionId?.substring(0,8)}…`;

      if (total > 0) {
        document.getElementById('newBadgeCount').textContent = total;
        document.getElementById('newBadgeCount').style.display = 'inline';
        document.getElementById('importAllBtn').style.display = 'inline-flex';
        document.getElementById('importAllCount').textContent = total;
      } else {
        document.getElementById('harvestResultsContainer').innerHTML = `
          <div class="harvest-empty">
            <div class="em-icon">✅</div>
            <div class="em-title">Tất cả đã cập nhật</div>
            <div class="em-sub">Không có công bố mới. CSDL đồng bộ hoàn toàn với tất cả ORCID record.</div>
          </div>`;
      }
    },

    onError: (msg) => {
      addLog(`LỖI: ${msg}`, 'err');
      btn.innerHTML = '↻ Thử lại';
      btn.classList.remove('running');
    },
  });
};

// ── Queue API ─────────────────────────────────────────────────────────────────

// Import 1 item từ queue vào publications
window.importOnePub = async function (queueId) {
  const card = document.getElementById(`npc-${queueId}`);
  if (card) { card.style.opacity = '.5'; card.style.pointerEvents = 'none'; }
  try {
    await apiFetch(`/orcid/queue/${queueId}/approve`, { method: 'POST', body: {} });
    if (card) card.querySelector('.npc-actions').innerHTML =
      '<span style="color:var(--green);font-family:var(--mono);font-size:13px">✅ Đã import</span>';
    showNotif('✅ Đã import thành công vào CSDL!');
  } catch (err) {
    if (card) { card.style.opacity = '1'; card.style.pointerEvents = ''; }
    showNotif(`❌ Lỗi: ${err.message}`);
  }
};

// Import tất cả
window.importAllNew = async function () {
  try {
    const res = await apiFetch('/orcid/queue/approve-all', { method: 'POST', body: {} });
    showNotif(`✅ Đã import ${res.imported} công bố vào CSDL!`);
    document.getElementById('importAllBtn').style.display = 'none';
  } catch (err) {
    showNotif(`❌ ${err.message}`);
  }
};

// ── ORCID Researcher Management ───────────────────────────────────────────────

/** Load danh sách NCV từ DB */
async function loadResearchers() {
  const res = await apiFetch('/orcid/researchers');
  return res.data || [];
}

/** Lưu NCV mới */
window.addOrcidEntry = async function () {
  const name = document.getElementById('newOrcidName')?.value?.trim();
  const id   = document.getElementById('newOrcidId')?.value?.trim();
  if (!name || !id) { showNotif('Vui lòng nhập đầy đủ'); return; }
  if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(id)) {
    showNotif('ORCID iD không đúng định dạng'); return;
  }
  try {
    await apiFetch('/orcid/researchers', {
      method: 'POST',
      body: { full_name: name, orcid_id: id, is_active: 1 }
    });
    document.getElementById('newOrcidName').value = '';
    document.getElementById('newOrcidId').value = '';
    // Refresh list
    const researchers = await loadResearchers();
    window.orcidRegistry = researchers.map(r => ({
      name: r.full_name, orcid: r.orcid_id, dept: r.department || '—', active: !!r.is_active
    }));
    renderOrcidManageList();
    showNotif(`✅ Đã thêm ${name}`);
  } catch (err) { showNotif(`❌ ${err.message}`); }
};

// Load researchers khi mở harvest modal
const _origOpenHarvestModal = window.openHarvestModal;
window.openHarvestModal = async function () {
  try {
    const researchers = await loadResearchers();
    window.orcidRegistry = researchers.map(r => ({
      name: r.full_name, orcid: r.orcid_id, dept: r.department || '—', active: !!r.is_active
    }));
  } catch {
    // fallback: dùng mock data nếu server chưa sẵn sàng
  }
  _origOpenHarvestModal?.();
  renderResearcherChips?.('idle');
  document.getElementById('harvestModal').classList.add('open');
};

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function apiFetch(path, { method = 'GET', body } = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}
