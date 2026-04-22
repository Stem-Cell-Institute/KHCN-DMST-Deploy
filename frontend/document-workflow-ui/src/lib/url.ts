/**
 * Dựng URL tuyệt đối theo base của ứng dụng (khớp vite.config `base` và
 * `basename` của React Router). Dùng cho các liên kết cần full page reload
 * để chuyển vùng giữa các module (ví dụ: từ `/documents` sang `/admin/...`
 * khi deploy qua nginx, tránh lệ thuộc vào trạng thái basename của SPA).
 *
 * - Khi vite base = "/admin/": buildAppUrl("module-settings") => "/admin/module-settings".
 * - Khi vite base = "/": buildAppUrl("module-settings") => "/module-settings".
 */
export function buildAppUrl(pathname: string): string {
  const raw = String(import.meta.env.BASE_URL || "/");
  const base = raw.endsWith("/") ? raw : raw + "/";
  const rel = String(pathname || "").replace(/^\/+/, "");
  return base + rel;
}
