/**
 * Phục vụ giao diện quản trị React (/admin), trạng thái build (/admin-ui-status, /api/admin-ui-status)
 * và file tĩnh của thư mục gốc (express.static).
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const express = require('express');

module.exports = function mountAdminUiAndStatic({ app, rootDir }) {
  // Admin UI bridge:
  // - If built bundle exists, serve React app at /admin
  // - Otherwise fallback to legacy HTML workflow page from backend
  const adminUiDistCandidates = [
    process.env.ADMIN_UI_DIST || '',
    path.join(rootDir, 'frontend', 'document-workflow-ui', 'dist'),
    path.join(rootDir, 'document-workflow-ui', 'dist'),
    path.join(rootDir, 'dist', 'document-workflow-ui'),
  ].filter(Boolean);
  const adminUiAutoBuildDisabled =
    String(process.env.ADMIN_UI_AUTO_BUILD || '').toLowerCase() === '0' ||
    String(process.env.ADMIN_UI_AUTO_BUILD || '').toLowerCase() === 'false';
  function tryAutoBuildAdminUi(triggerReason) {
    const frontendDir = path.join(rootDir, 'frontend', 'document-workflow-ui');
    const frontendPkg = path.join(frontendDir, 'package.json');
    if (adminUiAutoBuildDisabled) return { attempted: false, ok: false, reason: 'disabled-by-env' };
    if (!fs.existsSync(frontendPkg)) return { attempted: false, ok: false, reason: 'missing-frontend-package' };

    // Giới hạn tổng thời gian spawnSync để không chặn app.listen vô hạn nếu npm treo
    // (mạng chậm, lockfile hỏng, postinstall hook stuck). Quá giờ -> SIGTERM child, server
    // vẫn khởi động được với bundle cũ (nếu có) thay vì zombie không listen.
    const DEFAULT_AUTO_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
    const parsedTimeout = Number.parseInt(String(process.env.ADMIN_UI_AUTO_BUILD_TIMEOUT_MS || ''), 10);
    const perStepTimeoutMs =
      Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_AUTO_BUILD_TIMEOUT_MS;
    const fmtTimeout = `${Math.round(perStepTimeoutMs / 1000)}s`;

    console.log(
      `[ADMIN UI] ${triggerReason || 'dist missing'} -> attempting auto build (npm install + npm run build; timeout=${fmtTimeout}/step)`
    );

    function describeSpawnFailure(label, result) {
      if (result && result.signal) return `${label}: process bị kill bởi ${result.signal} (có thể do timeout=${fmtTimeout})`;
      if (result && result.error) return `${label}: ${result.error.code || ''} ${result.error.message || result.error}`.trim();
      return `${label}: exit code = ${result ? result.status : 'unknown'}`;
    }

    const installResult = spawnSync('npm', ['install'], {
      cwd: frontendDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      timeout: perStepTimeoutMs,
      killSignal: 'SIGTERM',
    });
    if (installResult.status !== 0) {
      console.error('[ADMIN UI] Auto-build failed at npm install -', describeSpawnFailure('npm install', installResult));
      return { attempted: true, ok: false, reason: installResult.signal ? 'install-timeout' : 'install-failed' };
    }
    const buildResult = spawnSync('npm', ['run', 'build'], {
      cwd: frontendDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      timeout: perStepTimeoutMs,
      killSignal: 'SIGTERM',
    });
    if (buildResult.status !== 0) {
      console.error('[ADMIN UI] Auto-build failed at npm run build -', describeSpawnFailure('npm run build', buildResult));
      return { attempted: true, ok: false, reason: buildResult.signal ? 'build-timeout' : 'build-failed' };
    }
    console.log('[ADMIN UI] Auto-build succeeded');
    return { attempted: true, ok: true, reason: 'build-succeeded' };
  }

  /**
   * So sánh mtime của thư mục source React với dist/index.html để nhận biết khi
   * người vận hành đã `git pull` code mới nhưng chưa rebuild bundle. Nếu phát hiện
   * source mới hơn dist thì tự động rebuild khi khởi động (trừ khi tắt bằng env).
   */
  function adminUiSourceNewerThanDist() {
    try {
      const srcDir = path.join(rootDir, 'frontend', 'document-workflow-ui', 'src');
      const indexHtmlInRepo = path.join(rootDir, 'frontend', 'document-workflow-ui', 'index.html');
      const packageJson = path.join(rootDir, 'frontend', 'document-workflow-ui', 'package.json');
      const existingDist = adminUiDistCandidates.find((dir) => fs.existsSync(path.join(dir, 'index.html')));
      if (!existingDist) return { newer: true, reason: 'dist-missing' };
      if (!fs.existsSync(srcDir)) return { newer: false, reason: 'src-missing' };
      const distMtime = fs.statSync(path.join(existingDist, 'index.html')).mtimeMs;
      let latestSourceMtime = 0;
      let latestSourceFile = '';
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            walk(full);
          } else {
            const m = fs.statSync(full).mtimeMs;
            if (m > latestSourceMtime) {
              latestSourceMtime = m;
              latestSourceFile = full;
            }
          }
        }
      };
      walk(srcDir);
      for (const aux of [indexHtmlInRepo, packageJson]) {
        if (fs.existsSync(aux)) {
          const m = fs.statSync(aux).mtimeMs;
          if (m > latestSourceMtime) {
            latestSourceMtime = m;
            latestSourceFile = aux;
          }
        }
      }
      if (latestSourceMtime > distMtime + 1000) {
        return {
          newer: true,
          reason: `source newer than dist (source=${latestSourceFile} mtime=${new Date(latestSourceMtime).toISOString()}, dist=${new Date(distMtime).toISOString()})`,
        };
      }
      return { newer: false, reason: 'dist up-to-date' };
    } catch (e) {
      return { newer: false, reason: 'stat-failed: ' + (e && e.message) };
    }
  }

  let adminUiAutoBuildState = { attempted: false, ok: false, reason: 'not-needed' };
  const adminUiDistPresent = adminUiDistCandidates.some((dir) => fs.existsSync(path.join(dir, 'index.html')));
  if (!adminUiDistPresent) {
    adminUiAutoBuildState = tryAutoBuildAdminUi('dist missing');
  } else {
    const staleCheck = adminUiSourceNewerThanDist();
    if (staleCheck.newer) {
      console.log('[ADMIN UI] Stale build detected: ' + staleCheck.reason);
      adminUiAutoBuildState = tryAutoBuildAdminUi('stale dist: ' + staleCheck.reason);
    }
  }
  const adminUiDistDir = adminUiDistCandidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) || null;
  const adminUiIndexFile = adminUiDistDir ? path.join(adminUiDistDir, 'index.html') : '';
  const legacyWorkflowHtml = path.join(rootDir, 'quy-trinh-van-ban-noi-bo.html');
  let adminUiServeMode = 'uninitialized';
  let adminUiModeReason = '';

  if (adminUiDistDir && fs.existsSync(adminUiIndexFile)) {
    adminUiServeMode = 'react-build';
    adminUiModeReason = `Found build file: ${adminUiIndexFile}`;
    // Vite build currently emits absolute /assets/* URLs by default.
    // Serve both /assets and /admin/assets to avoid 404 in admin SPA.
    app.use(
      '/assets',
      express.static(path.join(adminUiDistDir, 'assets'), {
        etag: false,
        lastModified: false,
        maxAge: 0,
      })
    );
    app.use(
      '/admin/assets',
      express.static(path.join(adminUiDistDir, 'assets'), {
        etag: false,
        lastModified: false,
        maxAge: 0,
      })
    );
    app.get(['/admin', '/admin/*'], (req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      return res.sendFile(adminUiIndexFile);
    });
  } else {
    adminUiServeMode = fs.existsSync(legacyWorkflowHtml) ? 'legacy-fallback' : 'unavailable';
    const checkedDistPaths = adminUiDistCandidates.length
      ? adminUiDistCandidates.join(', ')
      : '(none)';
    adminUiModeReason = fs.existsSync(legacyWorkflowHtml)
      ? `Missing React build (checked: ${checkedDistPaths}); using legacy page (${legacyWorkflowHtml})`
      : `Missing React build (checked: ${checkedDistPaths}) and legacy page (${legacyWorkflowHtml})`;
    app.get(['/admin', '/admin/*'], (req, res) => {
      if (fs.existsSync(legacyWorkflowHtml)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        return res.sendFile(legacyWorkflowHtml);
      }
      return res.status(503).send('Admin UI is not available. Missing frontend build and legacy fallback page.');
    });
  }
  console.log(`[ADMIN UI] Mode=${adminUiServeMode}. ${adminUiModeReason}`);
  function sendAdminUiStatus(res) {
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: adminUiServeMode !== 'unavailable',
      mode: adminUiServeMode,
      reason: adminUiModeReason,
      reactBuildIndexExists: !!(adminUiDistDir && fs.existsSync(adminUiIndexFile)),
      autoBuild: adminUiAutoBuildState,
      legacyFallbackExists: fs.existsSync(legacyWorkflowHtml),
      adminPath: '/admin',
    });
  }
  // Public status endpoint (không đi qua namespace /api để tránh bị auth middleware chặn).
  app.get('/admin-ui-status', (req, res) => {
    return sendAdminUiStatus(res);
  });
  // Giữ endpoint cũ để tương thích nếu môi trường không chặn /api.
  app.get('/api/admin-ui-status', (req, res) => {
    return sendAdminUiStatus(res);
  });

  app.use(
    express.static(rootDir, {
      /** Tắt ETag/Last-Modified — nếu không, trình duyệt vẫn nhận 304 dù có Cache-Control (file HTML cũ). */
      etag: false,
      lastModified: false,
      /** Tránh cache HTML; các file khác vẫn tải lại đầy đủ khi không còn 304. */
      setHeaders(res, filePath) {
        const lower = String(filePath || '').toLowerCase().replace(/\\/g, '/');
        // Các file JS của module DMS đang sửa đổi thường xuyên — nếu cache như file tĩnh thông
        // thường, trình duyệt có thể chạy bản cũ dù HTML đã tải bản mới (tab/nút mới hiện ra
        // nhưng bấm không phản ứng vì JS xử lý vẫn là bản trước đó).
        const isNoCacheJs = /\/js\/dms-(records-app|admin-page)\.js$/.test(lower);
        if (lower.endsWith('.html') || isNoCacheJs) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
          res.setHeader('Pragma', 'no-cache');
        }
      },
    })
  );
};
