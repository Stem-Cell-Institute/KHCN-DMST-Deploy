/**
 * Trang admin /admin/ticker — tab, bảng, gọi API, reloadTickerPreview()
 */
(function () {
  var cfg = window.__TICKER_ADMIN__ || {};
  /** Bản sao danh sách items (để mở form Sửa không cần gọi API lại) */
  var tickerItemsCache = [];
  function apiBase() {
    if (typeof cfg.apiBase === 'string') return cfg.apiBase;
    if (window.location.protocol === 'file:') return 'http://localhost:3000';
    return '';
  }
  function token() {
    try {
      return localStorage.getItem('token') || '';
    } catch (e) {
      return '';
    }
  }
  function authHeaders() {
    return {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token(),
    };
  }

  var SPEED_LABELS = {
    10: 'Rất nhanh',
    20: 'Nhanh',
    30: 'Trung bình',
    40: 'Chậm',
    50: 'Rất chậm',
    60: 'Cực chậm',
    70: 'Rất cực chậm',
    80: 'Chậm nhất',
  };

  function $(id) {
    return document.getElementById(id);
  }

  function showTab(name) {
    ['list', 'add', 'cats', 'settings'].forEach(function (t) {
      var panel = $('tab-panel-' + t);
      var btn = $('tab-btn-' + t);
      if (panel) panel.style.display = t === name ? 'block' : 'none';
      if (btn) btn.setAttribute('aria-selected', t === name ? 'true' : 'false');
    });
  }

  window.reloadTickerPreview = function () {
    var prev = $('adminTickerPreview');
    var inner = $('sciTickerInnerPreview');
    var track = $('sciTickerTrackPreview');
    var banner = $('adminTickerHiddenBanner');
    if (!inner || !track || !window.SciTicker) return;
    fetch(apiBase() + '/api/ticker/public', { credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (json) {
        if (!json || !json.success || !json.data) return;
        var settings = json.data.settings;
        var items = json.data.items || [];
        window.SciTicker.buildSequence(inner, settings, items);
        window.SciTicker.applyAnimation(inner, settings.speed);
        window.SciTicker.setupHoverPause(track, inner, settings);
        if (prev) prev.style.display = '';
        if (banner) {
          banner.style.display = Number(settings.is_visible) === 1 ? 'none' : 'block';
        }
      })
      .catch(function () {});
  };

  function reloadItemsTable() {
    var tbody = $('items-table-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5">Đang tải…</td></tr>';
    fetch(apiBase() + '/api/ticker/items', { headers: { Authorization: 'Bearer ' + token() } })
      .then(function (r) {
        return r.json();
      })
      .then(function (json) {
        if (!json || !json.success) {
          tickerItemsCache = [];
          tbody.innerHTML = '<tr><td colspan="5">Không tải được dữ liệu</td></tr>';
          return;
        }
        var rows = json.data || [];
        tickerItemsCache = rows;
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="5">Chưa có tin nào.</td></tr>';
          return;
        }
        tbody.innerHTML = rows
          .map(function (it) {
            var badge =
              '<span class="sci-t-tag" style="background:' +
              escapeAttr(it.category.bg_color) +
              ';color:' +
              escapeAttr(it.category.fg_color) +
              '">' +
              escapeHtml(it.category.label) +
              '</span>';
            var content = escapeHtml(truncate(it.content, 80));
            var linkCell =
              it.link && String(it.link).trim()
                ? '<span class="badge-link">Có link</span>'
                : '—';
            var st =
              Number(it.is_active) === 1
                ? '<span class="st-on">Hiện</span>'
                : '<span class="st-off">Ẩn</span>';
            var nextToggle = Number(it.is_active) === 1 ? 0 : 1;
            var toggleLabel = Number(it.is_active) === 1 ? 'Ẩn' : 'Hiện';
            return (
              '<tr data-id="' +
              it.id +
              '">' +
              '<td>' +
              badge +
              '</td>' +
              '<td>' +
              content +
              '</td>' +
              '<td>' +
              linkCell +
              '</td>' +
              '<td>' +
              st +
              '</td>' +
              '<td class="td-actions"><button type="button" class="btn-sm btn-edit" data-id="' +
              it.id +
              '">Sửa</button><button type="button" class="btn-sm btn-toggle" data-id="' +
              it.id +
              '" data-active="' +
              nextToggle +
              '">' +
              toggleLabel +
              '</button><button type="button" class="btn-sm btn-del" data-id="' +
              it.id +
              '">Xóa</button></td>' +
              '</tr>'
            );
          })
          .join('');
        tbody.querySelectorAll('.btn-edit').forEach(function (btn) {
          btn.addEventListener('click', function () {
            openEditItem(btn.getAttribute('data-id'));
          });
        });
        tbody.querySelectorAll('.btn-toggle').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            var active = btn.getAttribute('data-active') === '1';
            fetch(apiBase() + '/api/ticker/items/' + id, {
              method: 'PATCH',
              headers: authHeaders(),
              body: JSON.stringify({ is_active: active }),
            })
              .then(function (r) {
                return r.json();
              })
              .then(function (j) {
                if (j && j.success) {
                  reloadItemsTable();
                  window.reloadTickerPreview();
                } else {
                  alert((j && j.message) || 'Lỗi');
                }
              });
          });
        });
        tbody.querySelectorAll('.btn-del').forEach(function (btn) {
          btn.addEventListener('click', function () {
            if (!confirm('Xóa vĩnh viễn tin này?')) return;
            var id = btn.getAttribute('data-id');
            fetch(apiBase() + '/api/ticker/items/' + id, {
              method: 'DELETE',
              headers: { Authorization: 'Bearer ' + token() },
            })
              .then(function (r) {
                return r.json();
              })
              .then(function (j) {
                if (j && j.success) {
                  reloadItemsTable();
                  window.reloadTickerPreview();
                } else {
                  alert((j && j.message) || 'Lỗi');
                }
              });
          });
        });
      });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
  }
  function truncate(s, n) {
    s = String(s || '');
    return s.length <= n ? s : s.slice(0, n) + '…';
  }

  function loadCategoriesSelect(sel, onDone) {
    if (!sel) return;
    fetch(apiBase() + '/api/ticker/categories', { headers: { Authorization: 'Bearer ' + token() } })
      .then(function (r) {
        return r.json();
      })
      .then(function (json) {
        if (!json || !json.success) return;
        var list = json.data || [];
        sel.innerHTML = list
          .map(function (c) {
            return (
              '<option value="' +
              c.id +
              '">' +
              escapeHtml(c.label) +
              '</option>'
            );
          })
          .join('');
        if (typeof onDone === 'function') onDone();
      });
  }

  function openEditItem(id) {
    var nid = parseInt(id, 10);
    var it = tickerItemsCache.find(function (x) {
      return Number(x.id) === nid;
    });
    if (!it) return;
    var hid = $('edit-item-id');
    var content = $('edit-item-content');
    var link = $('edit-item-link');
    var active = $('edit-item-active');
    var modal = $('modal-edit-item');
    if (hid) hid.value = String(it.id);
    if (content) content.value = it.content || '';
    if (link) link.value = it.link || '';
    if (active) active.checked = Number(it.is_active) === 1;
    loadCategoriesSelect($('edit-item-category'), function () {
      var sel = $('edit-item-category');
      if (sel && it.category_id != null) sel.value = String(it.category_id);
    });
    if (modal) modal.classList.add('is-open');
    if (content) content.focus();
  }

  function closeEditModal() {
    var modal = $('modal-edit-item');
    if (modal) modal.classList.remove('is-open');
  }

  /** Nút nhanh cạnh Preview: đồng bộ với checkbox Cài đặt « Hiển thị ticker với người dùng » */
  function updateGlobalTickerButton() {
    var btn = $('btn-ticker-toggle-global');
    var vis = $('setting-visible');
    if (!btn) return;
    var shown = vis ? vis.checked : true;
    if (shown) {
      btn.textContent = 'Ẩn toàn bộ thanh Ticker';
      btn.className = 'btn-ticker-global btn-ticker-global--hide';
      btn.title =
        'Ẩn thanh thông báo trên mọi trang người dùng (trang chủ, các trang đã nhúng ticker). Bản xem Preview bên dưới vẫn hiển thị để chỉnh sửa.';
    } else {
      btn.textContent = 'Hiện lại thanh Ticker cho người dùng';
      btn.className = 'btn-ticker-global btn-ticker-global--show';
      btn.title = 'Hiển thị lại thanh chạy trên giao diện người dùng';
    }
  }

  function bindSettings() {
    var range = $('setting-speed');
    var speedLabel = $('setting-speed-label');
    var fontRange = $('setting-font-size');
    var fontLabel = $('setting-font-size-label');
    var vis = $('setting-visible');
    var links = $('setting-links');
    var hover = $('setting-hover');
    if (range && speedLabel) {
      function syncLabel() {
        var v = parseInt(range.value, 10);
        speedLabel.textContent = (SPEED_LABELS[v] || v) + ' (' + v + 's/vòng)';
      }
      range.addEventListener('input', syncLabel);
      range.addEventListener('change', function () {
        var v = parseInt(range.value, 10);
        fetch(apiBase() + '/api/ticker/settings', {
          method: 'PUT',
          headers: authHeaders(),
          body: JSON.stringify({ speed: v }),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (j) {
            if (j && j.success) {
              var inner = $('sciTickerInnerPreview');
              if (inner && window.SciTicker) window.SciTicker.applyAnimation(inner, v);
              window.reloadTickerPreview();
            }
          });
      });
      syncLabel();
    }
    if (fontRange && fontLabel) {
      function syncFontLabel() {
        var v = parseInt(fontRange.value, 10);
        fontLabel.textContent = v + ' px — chữ nội dung và nhãn loại (tỷ lệ nhãn ~78%)';
      }
      fontRange.addEventListener('input', syncFontLabel);
      fontRange.addEventListener('change', function () {
        var v = parseInt(fontRange.value, 10);
        putSettings({ content_font_size: v });
      });
      syncFontLabel();
    }
    function putSettings(body) {
      fetch(apiBase() + '/api/ticker/settings', {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(body),
      })
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          if (j && j.success && j.data && window.__TICKER_PAGE_SETTINGS__) {
            var d = j.data;
            if (d.is_visible !== undefined && d.is_visible !== null) {
              window.__TICKER_PAGE_SETTINGS__.is_visible = d.is_visible;
            }
            if (d.speed !== undefined && d.speed !== null) {
              window.__TICKER_PAGE_SETTINGS__.speed = d.speed;
            }
            if (d.links_enabled !== undefined && d.links_enabled !== null) {
              window.__TICKER_PAGE_SETTINGS__.links_enabled = d.links_enabled;
            }
            if (d.hover_pause !== undefined && d.hover_pause !== null) {
              window.__TICKER_PAGE_SETTINGS__.hover_pause = d.hover_pause;
            }
            if (d.content_font_size !== undefined && d.content_font_size !== null) {
              window.__TICKER_PAGE_SETTINGS__.content_font_size = d.content_font_size;
            }
          }
          window.reloadTickerPreview();
          updateGlobalTickerButton();
        });
    }
    if (vis) {
      vis.addEventListener('change', function () {
        putSettings({ is_visible: vis.checked ? 1 : 0 });
      });
    }
    if (links) {
      links.addEventListener('change', function () {
        putSettings({ links_enabled: links.checked ? 1 : 0 });
      });
    }
    if (hover) {
      hover.addEventListener('change', function () {
        putSettings({ hover_pause: hover.checked ? 1 : 0 });
      });
    }
  }

  function initFromServer() {
    var s = window.__TICKER_PAGE_SETTINGS__;
    if (!s) return;
    var range = $('setting-speed');
    var vis = $('setting-visible');
    var links = $('setting-links');
    var hover = $('setting-hover');
    if (range) range.value = String(s.speed || 30);
    if (vis) vis.checked = Number(s.is_visible) === 1;
    if (links) links.checked = Number(s.links_enabled) === 1;
    if (hover) hover.checked = Number(s.hover_pause) === 1;
    var speedLabel = $('setting-speed-label');
    if (speedLabel && range) {
      var v = parseInt(range.value, 10);
      speedLabel.textContent = (SPEED_LABELS[v] || v) + ' (' + v + 's/vòng)';
    }
    var fontRange = $('setting-font-size');
    var fontLabel = $('setting-font-size-label');
    if (fontRange) {
      var fs = Math.min(20, Math.max(11, Number(s.content_font_size) || 13));
      fontRange.value = String(fs);
    }
    if (fontLabel && fontRange) {
      var fv = parseInt(fontRange.value, 10);
      fontLabel.textContent = fv + ' px — chữ nội dung và nhãn loại (tỷ lệ nhãn ~78%)';
    }
  }

  function init() {
    showTab('list');

    $('tab-btn-list') &&
      $('tab-btn-list').addEventListener('click', function () {
        showTab('list');
      });
    $('tab-btn-add') &&
      $('tab-btn-add').addEventListener('click', function () {
        showTab('add');
      });
    $('tab-btn-cats') &&
      $('tab-btn-cats').addEventListener('click', function () {
        showTab('cats');
      });
    $('tab-btn-settings') &&
      $('tab-btn-settings').addEventListener('click', function () {
        showTab('settings');
      });

    var addCatSel = $('add-item-category');
    loadCategoriesSelect(addCatSel);

    $('btn-edit-cancel') &&
      $('btn-edit-cancel').addEventListener('click', function () {
        closeEditModal();
      });
    $('modal-edit-item') &&
      $('modal-edit-item').addEventListener('click', function (e) {
        if (e.target === $('modal-edit-item')) closeEditModal();
      });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeEditModal();
    });

    $('form-edit-item') &&
      $('form-edit-item').addEventListener('submit', function (e) {
        e.preventDefault();
        var hid = $('edit-item-id');
        var iid = hid && hid.value ? parseInt(hid.value, 10) : 0;
        if (!iid) return;
        var cat = $('edit-item-category');
        var content = $('edit-item-content');
        var link = $('edit-item-link');
        var active = $('edit-item-active');
        var body = {
          category_id: parseInt(cat && cat.value, 10),
          content: (content && content.value) || '',
          link: (link && link.value) || '',
          is_active: active && active.checked ? 1 : 0,
        };
        fetch(apiBase() + '/api/ticker/items/' + iid, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify(body),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (j) {
            if (j && j.success) {
              closeEditModal();
              reloadItemsTable();
              window.reloadTickerPreview();
            } else {
              alert((j && j.message) || 'Không lưu được');
            }
          })
          .catch(function () {
            alert('Lỗi kết nối');
          });
      });

    $('form-add-item') &&
      $('form-add-item').addEventListener('submit', function (e) {
        e.preventDefault();
        var cat = $('add-item-category');
        var content = $('add-item-content');
        var link = $('add-item-link');
        var active = $('add-item-active');
        var body = {
          category_id: parseInt(cat && cat.value, 10),
          content: (content && content.value) || '',
          link: (link && link.value) || '',
          is_active: active && active.checked ? 1 : 0,
        };
        fetch(apiBase() + '/api/ticker/items', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(body),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (j) {
            if (j && j.success) {
              if (content) content.value = '';
              if (link) link.value = '';
              showTab('list');
              reloadItemsTable();
              window.reloadTickerPreview();
            } else {
              alert((j && j.message) || 'Không thêm được');
            }
          });
      });

    $('form-new-category') &&
      $('form-new-category').addEventListener('submit', function (e) {
        e.preventDefault();
        var label = $('new-cat-label');
        var bg = $('new-cat-bg');
        var fg = $('new-cat-fg');
        fetch(apiBase() + '/api/ticker/categories', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            label: (label && label.value) || '',
            bg_color: (bg && bg.value) || '#ede9fe',
            fg_color: (fg && fg.value) || '#5b21b6',
          }),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (j) {
            if (j && j.success) {
              loadCategoriesList();
              loadCategoriesSelect(addCatSel);
              if (label) label.value = '';
            } else {
              alert((j && j.message) || 'Lỗi');
            }
          });
      });

    var bgIn = $('new-cat-bg');
    var fgIn = $('new-cat-fg');
    var prev = $('new-cat-preview');
    function syncPrev() {
      if (!prev) return;
      prev.style.background = (bgIn && bgIn.value) || '#ede9fe';
      prev.style.color = (fgIn && fgIn.value) || '#5b21b6';
    }
    if (bgIn) bgIn.addEventListener('input', syncPrev);
    if (fgIn) fgIn.addEventListener('input', syncPrev);
    syncPrev();

    $('btn-preview-play') &&
      $('btn-preview-play').addEventListener('click', function () {
        var inner = $('sciTickerInnerPreview');
        if (!inner) return;
        inner.classList.remove('paused');
        this.style.display = 'none';
        var p = $('btn-preview-pause');
        if (p) p.style.display = '';
      });
    $('btn-preview-pause') &&
      $('btn-preview-pause').addEventListener('click', function () {
        var inner = $('sciTickerInnerPreview');
        if (!inner) return;
        inner.classList.add('paused');
        this.style.display = 'none';
        var p = $('btn-preview-play');
        if (p) p.style.display = '';
      });

    $('btn-ticker-toggle-global') &&
      $('btn-ticker-toggle-global').addEventListener('click', function () {
        var vis = $('setting-visible');
        var currentlyShown = vis && vis.checked;
        var nextVisible = currentlyShown ? 0 : 1;
        fetch(apiBase() + '/api/ticker/settings', {
          method: 'PUT',
          headers: authHeaders(),
          body: JSON.stringify({ is_visible: nextVisible }),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (j) {
            if (!j || !j.success) {
              alert((j && j.message) || 'Không cập nhật được cài đặt');
              return;
            }
            if (vis && j.data) vis.checked = Number(j.data.is_visible) === 1;
            if (j.data && window.__TICKER_PAGE_SETTINGS__) {
              window.__TICKER_PAGE_SETTINGS__.is_visible = j.data.is_visible;
              if (j.data.content_font_size != null) {
                window.__TICKER_PAGE_SETTINGS__.content_font_size = j.data.content_font_size;
              }
            }
            var fr = $('setting-font-size');
            var fl = $('setting-font-size-label');
            if (fr && j.data && j.data.content_font_size != null) {
              fr.value = String(j.data.content_font_size);
              if (fl) fl.textContent = j.data.content_font_size + ' px — chữ nội dung và nhãn loại (tỷ lệ nhãn ~78%)';
            }
            updateGlobalTickerButton();
            window.reloadTickerPreview();
          })
          .catch(function () {
            alert('Lỗi kết nối');
          });
      });

    initFromServer();
    bindSettings();
    updateGlobalTickerButton();
    reloadItemsTable();
    loadCategoriesList();
    window.reloadTickerPreview();
  }

  function loadCategoriesList() {
    var wrap = $('categories-list');
    if (!wrap) return;
    fetch(apiBase() + '/api/ticker/categories', { headers: { Authorization: 'Bearer ' + token() } })
      .then(function (r) {
        return r.json();
      })
      .then(function (json) {
        if (!json || !json.success) return;
        var list = json.data || [];
        wrap.innerHTML = list
          .map(function (c) {
            return (
              '<div class="cat-row">' +
              '<span class="sci-t-tag" style="background:' +
              escapeAttr(c.bg_color) +
              ';color:' +
              escapeAttr(c.fg_color) +
              '">' +
              escapeHtml(c.label) +
              '</span>' +
              '<button type="button" class="btn-sm btn-del-cat" data-id="' +
              c.id +
              '">Xóa</button>' +
              '</div>'
            );
          })
          .join('');
        wrap.querySelectorAll('.btn-del-cat').forEach(function (btn) {
          btn.addEventListener('click', function () {
            if (
              !confirm(
                'Xóa loại này sẽ xóa toàn bộ tin liên quan. Tiếp tục?'
              )
            )
              return;
            var id = btn.getAttribute('data-id');
            fetch(apiBase() + '/api/ticker/categories/' + id, {
              method: 'DELETE',
              headers: { Authorization: 'Bearer ' + token() },
            })
              .then(function (r) {
                return r.json();
              })
              .then(function (j) {
                if (j && j.success) {
                  loadCategoriesList();
                  loadCategoriesSelect($('add-item-category'));
                  reloadItemsTable();
                  window.reloadTickerPreview();
                } else {
                  alert((j && j.message) || 'Không xóa được');
                }
              });
          });
        });
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
