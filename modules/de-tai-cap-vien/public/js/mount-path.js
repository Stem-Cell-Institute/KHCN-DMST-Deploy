/**
 * Hỗ trợ chạy module Quản lý Đề tài Cấp Viện dưới mount path (/de-tai-cap-vien) trong Eoffice
 * cũng như chạy độc lập ở root (/). Tự động chuẩn hóa fetch, window.open, và các thẻ động.
 */
(function () {
  var pathname = (window.location && window.location.pathname) || '';
  var base = pathname.indexOf('/de-tai-cap-vien') === 0 ? '/de-tai-cap-vien' : '';
  window.CAP_VIEN_BASE = base;

  function shouldPrefix(url) {
    if (typeof url !== 'string' || !base) return false;
    if (!url.startsWith('/') || url.startsWith('//')) return false;
    if (url === base || url.startsWith(base + '/')) return false;
    if (url === '/index.html') return false;
    return (
      url === '/' ||
      url.startsWith('/api/') ||
      url.startsWith('/uploads/') ||
      url.startsWith('/css/') ||
      url.startsWith('/js/') ||
      /^\/(chi-tiet|ban-lam-viec-khcn|quan-ly-dot|kiem-tra-ho-so|hoi-dong-ecv|phan-quyen)(\.html)?([?#]|$)/.test(url)
    );
  }

  window.cvUrl = function (url) {
    if (shouldPrefix(url)) {
      return url === '/' ? base + '/' : base + url;
    }
    return url;
  };

  if (!base) return;

  // 1. Tự động thêm tiền tố /de-tai-cap-vien cho fetch('/api/...') và fetch('/uploads/...')
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      if (typeof input === 'string' && shouldPrefix(input)) {
        return origFetch.call(this, window.cvUrl(input), init);
      }
      if (input && typeof Request !== 'undefined' && input instanceof Request) {
        try {
          var u = new URL(input.url);
          if (u.origin === window.location.origin && shouldPrefix(u.pathname)) {
            return origFetch.call(this, new Request(base + u.pathname + u.search + u.hash, input), init);
          }
        } catch (_) {}
      }
      return origFetch.call(this, input, init);
    };
  }

  // 2. Tự động thêm tiền tố cho window.open('/uploads/...') hoặc window.open('/api/...')
  var origOpen = window.open;
  if (typeof origOpen === 'function') {
    window.open = function (url, target, features) {
      if (typeof url === 'string' && shouldPrefix(url)) {
        url = window.cvUrl(url);
      }
      return origOpen.call(this, url, target, features);
    };
  }

  // 3. Tự động sửa các thẻ <a>, <iframe>, <img> được render động bằng innerHTML
  function rewriteAttrs(root) {
    if (!root || root.nodeType !== 1) return;
    var els = root.matches && root.matches('a[href],iframe[src],img[src],embed[src],object[data]')
      ? [root]
      : [];
    if (root.querySelectorAll) {
      els = els.concat(Array.from(root.querySelectorAll('a[href],iframe[src],img[src],embed[src],object[data]')));
    }
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.hasAttribute('data-eoffice-root')) continue;
      if (el.hasAttribute('href')) {
        var h = el.getAttribute('href');
        if (shouldPrefix(h)) el.setAttribute('href', window.cvUrl(h));
      }
      if (el.hasAttribute('src')) {
        var s = el.getAttribute('src');
        if (shouldPrefix(s)) el.setAttribute('src', window.cvUrl(s));
      }
      if (el.hasAttribute('data')) {
        var d = el.getAttribute('data');
        if (shouldPrefix(d)) el.setAttribute('data', window.cvUrl(d));
      }
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    rewriteAttrs(document.body);
    if (typeof MutationObserver !== 'undefined' && document.body) {
      var obs = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          if (m.type === 'attributes') {
            rewriteAttrs(m.target);
          } else if (m.addedNodes) {
            for (var j = 0; j < m.addedNodes.length; j++) {
              rewriteAttrs(m.addedNodes[j]);
            }
          }
        }
      });
      obs.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href', 'src', 'data'],
      });
    }
  });
})();
