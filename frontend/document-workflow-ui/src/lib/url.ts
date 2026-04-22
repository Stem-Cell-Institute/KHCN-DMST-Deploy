function normalizeBase(raw: string): string {
  const s = String(raw || "/").trim();
  if (!s || s === "/") return "/";
  return s.endsWith("/") ? s : `${s}/`;
}

function trimTrailingSlash(path: string): string {
  return String(path || "").replace(/\/+$/, "");
}

function resolveRuntimeBasePath(): string {
  const configuredBase = normalizeBase(String(import.meta.env.BASE_URL || "/"));
  const configuredBaseNoSlash = trimTrailingSlash(configuredBase);
  if (!configuredBaseNoSlash) return "";
  if (typeof window === "undefined") return configuredBaseNoSlash;

  const currentPath = String(window.location?.pathname || "");
  if (currentPath === configuredBaseNoSlash || currentPath.startsWith(`${configuredBaseNoSlash}/`)) {
    return configuredBaseNoSlash;
  }
  return "";
}

/**
 * Basename runtime cho React Router.
 * - Trả `"/admin"` khi URL hiện tại bắt đầu bằng `/admin`.
 * - Trả `undefined` khi ứng dụng đang chạy ở root (vd `/documents`).
 */
export function getRuntimeRouterBasename(): string | undefined {
  const base = resolveRuntimeBasePath();
  return base || undefined;
}

/**
 * Dựng URL tuyệt đối theo base runtime hiện tại.
 * - Nếu app đang ở `/admin/*` -> `/admin/<pathname>`.
 * - Nếu app đang ở root `/*`   -> `/<pathname>`.
 */
export function buildAppUrl(pathname: string): string {
  const base = resolveRuntimeBasePath();
  const rel = String(pathname || "").replace(/^\/+/, "");
  return `${base}/${rel}`.replace(/\/{2,}/g, "/");
}
