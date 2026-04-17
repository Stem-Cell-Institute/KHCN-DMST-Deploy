import type { MeUser, UserRole } from "./types";

export function getToken() {
  return localStorage.getItem("token") || "";
}

export function parseRoles(role: MeUser["role"]): UserRole[] {
  const raw = Array.isArray(role) ? role : String(role || "").split(/[,\s;|]+/);
  return raw
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean)
    .filter((x): x is UserRole =>
      [
        "proposer",
        "leader",
        "drafter",
        "reviewer",
        "admin",
        "master_admin",
        "module_manager",
        "user",
      ].includes(x)
    );
}
