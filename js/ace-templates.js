/**
 * Mẫu hồ sơ SCI-ACE (Hội đồng đạo đức trên động vật) — Admin/Thư ký Hội đồng upload,
 * mọi người đăng nhập được download. Dùng chung cho nhom-1.html, nhom-2.html, nhom-3.html
 * (mỗi card .download-card[data-ace-type] khớp với 1 template_type ở backend).
 */
(function () {
  var API = '/api/ace-templates';

  function getToken() {
    try { return localStorage.getItem('token') || ''; } catch (_) { return ''; }
  }

  function downloadBlob(type, fallbackName) {
    var tok = getToken();
    return fetch(API + '/' + encodeURIComponent(type) + '/download', {
      headers: tok ? { Authorization: 'Bearer ' + tok } : {}
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (j) { throw new Error(j.message || ('HTTP ' + res.status)); });
      return res.blob().then(function (blob) {
        var disp = res.headers.get('Content-Disposition') || '';
        var name = fallbackName;
        var m = /filename\*=UTF-8''([^;\n]+)|filename="([^"]+)"/i.exec(disp);
        if (m) {
          try { name = decodeURIComponent((m[1] || m[2] || '').trim()); } catch (_) {}
        }
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
      });
    });
  }

  function uploadFile(type, file) {
    var tok = getToken();
    if (!tok) return Promise.reject(new Error('Chưa đăng nhập'));
    var fd = new FormData();
    fd.append('template_type', type);
    fd.append('file', file);
    return fetch('/api/admin/ace-templates', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok },
      body: fd
    }).then(function (res) {
      return res.json().then(function (j) {
        if (!res.ok) throw new Error(j.message || ('HTTP ' + res.status));
        return j;
      });
    });
  }

  function deleteFile(type) {
    var tok = getToken();
    if (!tok) return Promise.reject(new Error('Chưa đăng nhập'));
    return fetch('/api/admin/ace-templates/' + encodeURIComponent(type), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + tok }
    }).then(function (res) {
      return res.json().then(function (j) {
        if (!res.ok) throw new Error(j.message || ('HTTP ' + res.status));
        return j;
      });
    });
  }

  function applyCardState(card, tpl) {
    var btn = card.querySelector('.download-btn');
    var meta = card.querySelector('.tpl-meta');
    var btnDel = card.querySelector('.btn-delete-tpl');
    if (!btn) return;
    if (tpl && tpl.has_file) {
      btn.disabled = false;
      if (meta) meta.textContent = tpl.original_name || '';
      if (btnDel) btnDel.disabled = false;
    } else {
      btn.disabled = true;
      if (meta) meta.textContent = 'Chưa có file mẫu';
      if (btnDel) btnDel.disabled = true;
    }
  }

  function refreshList() {
    return fetch(API, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (data) {
      var map = {};
      (data.templates || []).forEach(function (t) { map[t.type] = t; });
      document.querySelectorAll('.download-card[data-ace-type]').forEach(function (card) {
        var type = card.getAttribute('data-ace-type');
        applyCardState(card, map[type]);
      });
    });
  }

  function init() {
    var tok = getToken();
    if (tok) {
      fetch('/api/ace-templates/can-manage', { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : { canManage: false }; })
        .then(function (d) { if (d && d.canManage) document.body.classList.add('can-manage-ace-templates'); })
        .catch(function () {});
    }

    document.querySelectorAll('.download-card[data-ace-type]').forEach(function (card) {
      var type = card.getAttribute('data-ace-type');
      var btn = card.querySelector('.download-btn');
      var btnUp = card.querySelector('.btn-upload');
      var btnDel = card.querySelector('.btn-delete-tpl');
      var inp = card.querySelector('.tpl-file');

      if (btn) {
        btn.addEventListener('click', function () {
          if (btn.disabled) return;
          downloadBlob(type, type + '.docx').catch(function (e) { alert(e.message || String(e)); });
        });
      }
      if (btnUp && inp) {
        btnUp.addEventListener('click', function () {
          if (!inp.files || !inp.files[0]) {
            alert('Chọn file trước khi gửi.');
            return;
          }
          btnUp.disabled = true;
          uploadFile(type, inp.files[0])
            .then(function () {
              inp.value = '';
              return refreshList();
            })
            .then(function () { alert('Đã cập nhật mẫu.'); })
            .catch(function (e) { alert(e.message || String(e)); })
            .finally(function () { btnUp.disabled = false; });
        });
      }
      if (btnDel) {
        btnDel.addEventListener('click', function () {
          if (!confirm('Xóa file mẫu đã đăng tải?')) return;
          btnDel.disabled = true;
          deleteFile(type)
            .then(function () { return refreshList(); })
            .then(function () { alert('Đã xóa.'); })
            .catch(function (e) { alert(e.message || String(e)); })
            .finally(function () { btnDel.disabled = false; });
        });
      }
    });

    refreshList().catch(function () {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
