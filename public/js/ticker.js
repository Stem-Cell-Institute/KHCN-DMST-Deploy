/**
 * Ticker Thông Báo — client (user đã đăng nhập: có token trong localStorage)
 * Gọi /api/ticker/public, build .sci-t-item, nhân đôi nội dung để loop.
 */
(function () {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function apiBase() {
    if (window.location.protocol === 'file:') return 'http://localhost:3000';
    return '';
  }

  /** Ánh xạ key danh mục trong DB → class theme (t-pub / t-news / t-event) */
  function themeClassForCategoryKey(key) {
    const k = String(key || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (k === 'pub' || k.indexOf('cong_bo') !== -1) return 't-pub';
    if (k === 'news' || k.indexOf('tin') !== -1) return 't-news';
    if (k === 'event' || k.indexOf('su_kien') !== -1 || k.indexOf('sukien') !== -1) return 't-event';
    return '';
  }

  function buildItemEl(item, settings) {
    const wrap = document.createElement('span');
    wrap.className = 'sci-t-item';
    const tag = document.createElement('span');
    const themeCls = themeClassForCategoryKey(item.category && item.category.key);
    tag.className = 'sci-t-tag' + (themeCls ? ' ' + themeCls : '');
    tag.textContent = item.category.label;
    if (themeCls) {
      tag.style.backgroundColor = '';
      tag.style.color = '';
    } else {
      tag.style.backgroundColor = item.category.bg_color;
      tag.style.color = item.category.fg_color;
    }
    const sep = document.createElement('span');
    sep.className = 'sci-t-sep';
    sep.setAttribute('aria-hidden', 'true');
    const text = escapeHtml(item.content);
    const useLink =
      item.link &&
      String(item.link).trim() &&
      Number(settings.links_enabled) === 1;
    let contentNode;
    if (useLink) {
      const a = document.createElement('a');
      a.href = item.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.innerHTML = text;
      contentNode = a;
    } else {
      const span = document.createElement('span');
      span.innerHTML = text;
      contentNode = span;
    }
    wrap.appendChild(tag);
    wrap.appendChild(sep);
    wrap.appendChild(contentNode);
    return wrap;
  }

  function applyContentFontSize(inner, settings) {
    const fz = Math.max(11, Math.min(20, parseInt(settings.content_font_size, 10) || 13));
    inner.style.fontSize = fz + 'px';
  }

  function buildSequence(inner, settings, items) {
    inner.innerHTML = '';
    applyContentFontSize(inner, settings);
    if (!items || !items.length) {
      const empty = document.createElement('span');
      empty.className = 'sci-t-item';
      empty.textContent = 'Chưa có thông báo.';
      inner.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (let pass = 0; pass < 2; pass++) {
      items.forEach(function (it) {
        frag.appendChild(buildItemEl(it, settings));
      });
    }
    inner.appendChild(frag);
  }

  function applyAnimation(inner, speedSeconds) {
    const sec = Math.max(10, Math.min(80, parseInt(speedSeconds, 10) || 30));
    inner.style.animationDuration = sec + 's';
  }

  function setupHoverPause(track, inner, settings) {
    track.onmouseenter = null;
    track.onmouseleave = null;
    if (Number(settings.hover_pause) !== 1) return;
    track.onmouseenter = function () {
      inner.classList.add('paused');
    };
    track.onmouseleave = function () {
      inner.classList.remove('paused');
    };
  }

  /**
   * @param {HTMLElement} containerEl
   * @param {{ innerEl?: HTMLElement, trackEl?: HTMLElement }} [opts]
   */
  function initContainer(containerEl, opts) {
    opts = opts || {};
    const inner = opts.innerEl || containerEl.querySelector('#sciTickerInner');
    const track = opts.trackEl || containerEl.querySelector('#sciTickerTrack');
    if (!inner || !track) return;

    fetch(apiBase() + '/api/ticker/public', { credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (json) {
        if (!json || !json.success || !json.data) return;
        const settings = json.data.settings;
        const items = json.data.items || [];
        if (Number(settings.is_visible) !== 1) {
          containerEl.style.display = 'none';
          return;
        }
        buildSequence(inner, settings, items);
        applyAnimation(inner, settings.speed);
        inner.classList.remove('paused');
        setupHoverPause(track, inner, settings);
        containerEl.style.display = '';
      })
      .catch(function () {
        containerEl.style.display = 'none';
      });
  }

  function shouldRun() {
    try {
      return !!localStorage.getItem('token');
    } catch (e) {
      return false;
    }
  }

  function run() {
    if (!shouldRun()) return;
    var el = document.getElementById('sci-ticker-container');
    if (!el) return;
    initContainer(el);
  }

  window.SciTicker = {
    initContainer: initContainer,
    buildSequence: buildSequence,
    applyAnimation: applyAnimation,
    applyContentFontSize: applyContentFontSize,
    setupHoverPause: setupHoverPause,
    apiBase: apiBase,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
