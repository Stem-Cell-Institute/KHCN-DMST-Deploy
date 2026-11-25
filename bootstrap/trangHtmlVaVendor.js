/**
 * Trang đăng nhập, các middleware chặn trang .html cần đăng nhập/quyền,
 * và file thư viện vendor (xlsx, Sortable, Chart.js, pdf.js).
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const vaiTroHanChe = require('../services/vaiTroHanChe');

module.exports = function mountHtmlPagesAndVendor({
  JWT_SECRET,
  app,
  clearAuthCookie,
  getTokenFromReq,
  userIdIsBanned,
  rootDir,
}) {
  // (enrich, journal-metrics, …). Nếu đặt trước, mọi /api/enrich/* sẽ 404.

  // Serve dang-nhap.html với script inject: sau login redirect về trang pending
  app.get('/dang-nhap.html', (req, res) => {
    const filePath = path.join(rootDir, 'dang-nhap.html');
    if (!fs.existsSync(filePath)) return res.status(404).send('Không tìm thấy trang đăng nhập');
    let html = fs.readFileSync(filePath, 'utf8');
    const injectScript = `
<script>
// HTQT Login Hook: sau khi đăng nhập thành công, redirect về trang pending
(function() {
  var _fetch = window.fetch;
  window.fetch = function(url, opts) {
    return _fetch.apply(this, arguments).then(function(response) {
      if (typeof url === 'string' && url.indexOf('/api/login') !== -1 && response.ok) {
        response.clone().json().then(function(data) {
          if (data && data.token) {
            var pending = sessionStorage.getItem('htqt_redirect_after_login');
            if (pending) {
              sessionStorage.removeItem('htqt_redirect_after_login');
              setTimeout(function() { window.location.href = pending; }, 200);
            }
          }
        }).catch(function() {});
      }
      return response;
    });
  };
})();
</script>`;
    // Inject trước </body>
    if (html.includes('</body>')) {
      html = html.replace('</body>', injectScript + '\n</body>');
    } else {
      html = html + injectScript;
    }
    res.type('html').send(html);
  });

  // Chỉ cho phép khách (chưa đăng nhập) xem trang chủ và các trang đăng nhập/đăng ký/quên mật khẩu; các trang .html khác cần cookie JWT hợp lệ.
  const PUBLIC_HTML_AUTH = new Set([
    'dang-nhap.html',
    'dang-ky.html',
    'xac-minh-email.html',
    'crd-dang-ky.html',
    'quen-mat-khau.html',
    'dat-lai-mat-khau.html',
  ]);
  function isPublicHtmlPath(reqPath) {
    const p = (reqPath || '').replace(/\\/g, '/');
    if (p === '/' || p === '' || p === '/index.html') return true;
    if (/\/public\/equipment\/public\.html$/i.test(p)) return true;
    const base = path.basename(p);
    return PUBLIC_HTML_AUTH.has(base);
  }

  /** Đường dẫn không đuôi .html — Đăng ký HN/HT */
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const p = (req.path || '').replace(/\\/g, '/');
    const hnhtMap = {
      '/hop-tac/hoi-nghi-hoi-thao/dang-ky': 'hop-tac/hoi-nghi-hoi-thao/dang-ky.html',
      '/hop-tac/hoi-nghi-hoi-thao/cua-toi': 'hop-tac/hoi-nghi-hoi-thao/cua-toi.html',
      '/hop-tac/hoi-nghi-hoi-thao/chi-tiet': 'hop-tac/hoi-nghi-hoi-thao/chi-tiet.html',
      '/quan-ly/hoi-nghi-hoi-thao': 'quan-ly/hoi-nghi-hoi-thao.html',
    };
    const rel = hnhtMap[p];
    if (!rel) return next();
    const token = getTokenFromReq(req);
    if (!token) {
      return res.redirect(302, '/dang-nhap.html?returnUrl=' + encodeURIComponent(p));
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (userIdIsBanned(payload.id)) {
        clearAuthCookie(res);
        return res.redirect(302, '/dang-nhap.html?banned=1');
      }
    } catch (e) {
      return res.redirect(302, '/dang-nhap.html?returnUrl=' + encodeURIComponent(p));
    }
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs)) return next();
    return res.sendFile(abs);
  });

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const reqPath = req.path || '';
    if (!reqPath.endsWith('.html')) return next();

    const token0 = getTokenFromReq(req);
    if (token0) {
      try {
        const payload0 = jwt.verify(token0, JWT_SECRET);
        // vai trò chỉ dùng một số module (crd_user, sinh_vien): chỉ mở các trang của module đó (services/vaiTroHanChe.js)
        if (!userIdIsBanned(payload0.id) && !vaiTroHanChe.trangHtmlDuocPhep(payload0.role, reqPath)) {
          return res.redirect(302, vaiTroHanChe.trangMacDinh(payload0.role));
        }
      } catch (e) {
        /* token lỗi — xử lý bước dưới */
      }
    }

    if (isPublicHtmlPath(reqPath)) return next();
    const token = getTokenFromReq(req);
    if (!token) {
      const base = path.basename(reqPath);
      return res.redirect(302, '/dang-nhap.html?returnUrl=' + encodeURIComponent(base));
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (userIdIsBanned(payload.id)) {
        clearAuthCookie(res);
        return res.redirect(302, '/dang-nhap.html?banned=1');
      }
      return next();
    } catch (e) {
      const base = path.basename(reqPath);
      return res.redirect(302, '/dang-nhap.html?returnUrl=' + encodeURIComponent(base));
    }
  });

  /** Không cho tải source / cấu hình qua static (trước đây chỉ .html có auth). */
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let p = (req.path || '').replace(/\\/g, '/');
    try {
      p = decodeURIComponent(p);
    } catch (_) {
      return res.status(400).end();
    }
    if (p.includes('..')) return res.status(403).end();
    p = p.split('?')[0].toLowerCase();
    const blocked = [
      /^\/server\.js$/,
      /^\/server-backup.*\.js$/,
      /^\/package(-lock)?\.json$/,
      /^\/\.env/,
      /^\/lib\//,
      /^\/routes\//,
      /^\/services\//,
      /^\/views\//,
      /^\/templates\//,
      /^\/node_modules\//,
      /^\/middleware\//,
      /^\/migrations\//,
      /^\/scripts\//,
      /^\/database\//,
      /^\/db\//,
      /^\/sci-khcn-publications\//,
      /^\/data\//,
      /^\/uploads\//,
      /^\/uploads\/equipment\//,
      /^\/\.git/,
      /^\/crd-lab-booking\/main\.jsx$/,
      /^\/(fix-crd-created-at|test-insert-created-at)\.js$/,
    ];
    if (blocked.some((r) => r.test(p))) return res.status(403).end();
    return next();
  });

  // Local fallback for equipment Excel importer when CDN is blocked.
  app.get('/public/vendor/xlsx.full.min.js', (req, res) => {
    try {
      return res.sendFile(path.join(rootDir, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'));
    } catch (e) {
      return res.status(404).send('xlsx bundle not found');
    }
  });

  // Local fallback for SortableJS used by homepage drag-and-drop.
  app.get('/public/vendor/Sortable.min.js', (req, res) => {
    try {
      return res.sendFile(path.join(rootDir, 'node_modules', 'sortablejs', 'Sortable.min.js'));
    } catch (e) {
      return res.status(404).send('sortable bundle not found');
    }
  });

  /** Chart.js phục vụ nội bộ: CSP chỉ cho script-src 'self', nạp từ CDN sẽ bị chặn.
   *  Gói npm chỉ có dist/chart.umd.js (đã minify) — không có chart.umd.min.js như URL
   *  jsDelivr dùng trước đây (jsDelivr tự minify khi file .min.js không tồn tại). */
  app.get('/public/vendor/chart.umd.js', (req, res) => {
    try {
      return res.sendFile(path.join(rootDir, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
    } catch (e) {
      return res.status(404).send('chart.js bundle not found');
    }
  });

  /** pdf.js phục vụ nội bộ (CSP chỉ cho script-src 'self'): chỉ hai tệp dùng để xem trước PDF khi đặt khung chữ ký số (public/js/kysoViTri.js). */
  app.get('/public/vendor/pdfjs/:tep', (req, res) => (['pdf.min.mjs', 'pdf.worker.min.mjs'].includes(req.params.tep) ? res.type('application/javascript').sendFile(path.join(rootDir, 'node_modules', 'pdfjs-dist', 'build', req.params.tep)) : res.status(404).end()));
};
