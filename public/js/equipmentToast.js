/**
 * Toast phản hồi nhanh (STIMS — module thiết bị)
 * Gọi: window.stimsToast('Đã lưu', true) hoặc stimsToast('Lỗi', false)
 */
(function () {
  function ensureHost() {
    var h = document.getElementById('stims-toast-host');
    if (h) return h;
    h = document.createElement('div');
    h.id = 'stims-toast-host';
    h.setAttribute('aria-live', 'polite');
    h.style.cssText =
      'position:fixed;bottom:24px;right:24px;z-index:99999;display:flex;flex-direction:column;gap:8px;max-width:min(420px,92vw);pointer-events:none;';
    document.body.appendChild(h);
    return h;
  }

  window.stimsToast = function (message, ok) {
    var host = ensureHost();
    var el = document.createElement('div');
    el.style.cssText =
      'pointer-events:auto;padding:12px 16px;border-radius:12px;font-size:14px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.35);animation:stimsToastIn .22s ease;';
    el.style.background = ok ? 'linear-gradient(135deg,#059669,#10b981)' : 'linear-gradient(135deg,#b91c1c,#ef4444)';
    el.style.color = '#fff';
    el.textContent = message || '';
    if (!document.getElementById('stims-toast-keyframes')) {
      var s = document.createElement('style');
      s.id = 'stims-toast-keyframes';
      s.textContent =
        '@keyframes stimsToastIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}';
      document.head.appendChild(s);
    }
    host.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity .25s ease';
      setTimeout(function () {
        try {
          host.removeChild(el);
        } catch (e) {}
      }, 280);
    }, 3200);
  };
})();
