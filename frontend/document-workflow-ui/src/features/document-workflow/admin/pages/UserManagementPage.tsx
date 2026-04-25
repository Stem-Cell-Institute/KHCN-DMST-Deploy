import axios from "axios";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteAdminUser,
  fetchAdminMe,
  fetchRoleMigrationReport,
  fetchModuleSettings,
  fetchAdminUsers,
  resetAdminUserPassword,
  saveModuleSettings,
  saveAdminUser,
  setAdminUserActive,
} from "@/features/document-workflow/use-cases/adminWorkflowApi";
import { fetchUnits } from "@/features/document-workflow/use-cases/documentWorkflowApi";
import { Button, Input, Select } from "@/components/ui";
import type { Unit } from "@/lib/types";
import {
  ConfirmDialog,
  DataTable,
  Pagination,
  useToast,
} from "@/shared/ui/primitives";
import { AdminSectionCard } from "@/features/document-workflow/admin/components/AdminCards";

const ROLE_OPTIONS = [
  "master_admin",
  "module_manager",
  "proposer",
  "leader",
  "reviewer",
  "drafter",
  "user",
];
const PAGE_SIZE = 10;
const ROLE_GUIDE: Record<string, string> = {
  master_admin:
    "Toan quyen he thong va toan bo thao tac trong module Workflow (xem/sua/xoa ho so, thao tac moi buoc).",
  module_manager:
    "Quan tri module Workflow: xem tat ca ho so, sua/xoa ho so va thao tac duoc tat ca cac buoc 1-9.",
  proposer: "Duoc tao ho so moi va thuc hien Buoc 1 (nop ho so).",
  leader: "Xu ly Buoc 2 (phan cong) va co the tham gia Buoc 5 (gop y).",
  reviewer: "Xu ly Buoc 4 (tham dinh) va Buoc 5 (gop y).",
  drafter: "Khi duoc phan cong se xu ly Buoc 3, Buoc 6, Buoc 7; co the tham gia Buoc 5.",
  user: "Tai khoan co ban, chi dang nhap/xem theo quyen duoc cap.",
};

type UserRow = {
  id: number;
  email: string;
  fullname?: string;
  department_id?: string;
  role?: string;
  is_banned?: number;
  is_active?: number;
};

type RoleMigrationReport = {
  totalUsersScanned?: number;
  usersTouched?: number;
  workflowRoleRowsInserted?: number;
  normalizedSystemRoleRows?: number;
  migratedAt?: string;
};

function parseRoleList(value: unknown): string[] {
  return String(value || "")
    .split(/[,\s;|]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function roleCsv(list: string[]) {
  return Array.from(
    new Set((list || []).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))
  ).join(",");
}

function apiErr(e: unknown, fallback: string) {
  if (
    axios.isAxiosError(e) &&
    e.response?.data &&
    typeof (e.response.data as { message?: string }).message === "string"
  ) {
    return (e.response.data as { message: string }).message;
  }
  if (e instanceof Error) return e.message;
  return fallback;
}

function readInternalDomainFlags(settings: { settings?: Record<string, string> }) {
  const s = settings.settings || {};
  return {
    enabled: String(s.internal_domain_access_enabled || "0") === "1",
    suffix: String(s.internal_domain_email_suffix || "@sci.edu.vn"),
  };
}

export function UserManagementPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [page, setPage] = useState(1);
  const [roleFilter, setRoleFilter] = useState<"all" | "assigned" | "unassigned">("all");
  const [scrollToEditor, setScrollToEditor] = useState(false);
  const [internalDomainEnabled, setInternalDomainEnabled] = useState(false);
  const [internalDomainSuffix, setInternalDomainSuffix] = useState("@sci.edu.vn");
  const [roleMigrationReport, setRoleMigrationReport] = useState<RoleMigrationReport | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [confirm, setConfirm] = useState<{
    kind: "delete" | "master";
    user: UserRow;
    nextRoles?: string;
  } | null>(null);
  const [meId, setMeId] = useState<number>(0);
  const toast = useToast();

  async function reload() {
    try {
      const u = await fetchAdminUsers();
      setUsers(Array.isArray(u) ? (u as UserRow[]) : []);
    } catch {
      setUsers([]);
    }
    try {
      const unit = await fetchUnits();
      setUnits(Array.isArray(unit) ? unit : []);
    } catch {
      setUnits([]);
    }
    try {
      const mod = await fetchModuleSettings();
      const flags = readInternalDomainFlags(mod);
      setInternalDomainEnabled(flags.enabled);
      setInternalDomainSuffix(flags.suffix);
    } catch {}
    try {
      const report = await fetchRoleMigrationReport();
      setRoleMigrationReport((report as RoleMigrationReport | null) || null);
    } catch {
      setRoleMigrationReport(null);
    }
  }

  useEffect(() => {
    void Promise.all([reload(), fetchAdminMe().then((m) => setMeId(Number(m.user?.id || 0)))]).catch(
      () => {}
    );
  }, []);

  const safeUsers = Array.isArray(users) ? users : [];
  const filteredUsers = useMemo(() => {
    if (roleFilter === "all") return safeUsers;
    return safeUsers.filter((u) => {
      const hasAnyRole = parseRoleList(u.role).length > 0;
      return roleFilter === "assigned" ? hasAnyRole : !hasAnyRole;
    });
  }, [safeUsers, roleFilter]);
  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE));
  const pageRows = useMemo(
    () => filteredUsers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filteredUsers, page]
  );
  const emailSuggestions = useMemo(
    () =>
      Array.from(
        new Set(safeUsers.map((u) => String(u.email || "").trim().toLowerCase()).filter(Boolean))
      ).sort(),
    [safeUsers]
  );
  useEffect(() => {
    setPage(1);
  }, [roleFilter]);
  useEffect(() => {
    if (!editing || !scrollToEditor) return;
    const id = window.requestAnimationFrame(() => {
      editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      setScrollToEditor(false);
    });
    return () => window.cancelAnimationFrame(id);
  }, [editing, scrollToEditor]);

  return (
    <div className="space-y-4">
      <AdminSectionCard className="p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-slate-800">Quản lý người dùng</h2>
            <label className="block w-full text-sm md:w-80">
              Lọc phân vai Workflow documentation
              <Select
                value={roleFilter}
                onChange={(e) =>
                  setRoleFilter(e.target.value as "all" | "assigned" | "unassigned")
                }
                className="mt-1"
              >
                <option value="all">Tất cả người dùng</option>
                <option value="assigned">Đã được phân vai (ít nhất 1 vai trò)</option>
                <option value="unassigned">Chưa được phân vai</option>
              </Select>
            </label>
            <p className="text-sm text-slate-500">
              Hiển thị {filteredUsers.length}/{safeUsers.length} người dùng
            </p>
          </div>
          <Button
            onClick={() => {
              setEditing({ id: 0, email: "", role: "user", is_banned: 0 });
              setScrollToEditor(true);
            }}
          >
            Thêm người dùng
          </Button>
        </div>
      </AdminSectionCard>

      {roleMigrationReport ? (
        <AdminSectionCard className="p-4">
          <h3 className="text-base font-semibold text-slate-800">Báo cáo migration role CSV</h3>
          <div className="mt-2 grid gap-2 text-sm text-slate-700 md:grid-cols-2">
            <div>Tổng user quét: {Number(roleMigrationReport.totalUsersScanned || 0)}</div>
            <div>User bị ảnh hưởng: {Number(roleMigrationReport.usersTouched || 0)}</div>
            <div>Role workflow đã tách: {Number(roleMigrationReport.workflowRoleRowsInserted || 0)}</div>
            <div>Role hệ thống đã chuẩn hóa: {Number(roleMigrationReport.normalizedSystemRoleRows || 0)}</div>
            <div className="md:col-span-2">
              Thời điểm chạy: {String(roleMigrationReport.migratedAt || "N/A")}
            </div>
          </div>
        </AdminSectionCard>
      ) : null}

      <AdminSectionCard>
        <DataTable
          headers={["ID", "Email", "Họ tên", "Đơn vị", "Vai trò", "Trạng thái", "Thao tác"]}
        >
          {pageRows.map((u) => (
            <tr key={String(u.id)} className="border-t border-slate-100">
              <td className="px-3 py-2">{String(u.id)}</td>
              <td className="px-3 py-2">{String(u.email || "")}</td>
              <td className="px-3 py-2">{String(u.fullname || "")}</td>
              <td className="px-3 py-2">{String(u.department_id || "")}</td>
              <td className="px-3 py-2">{String(u.role || "")}</td>
              <td className="px-3 py-2">
                {Number(u.is_banned || 0) === 1 ? "inactive" : "active"}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setEditing(u)}>
                    Sửa
                  </Button>
                  <Button
                    variant={Number(u.is_banned || 0) === 1 ? "default" : "danger"}
                    onClick={async () => {
                      await setAdminUserActive(Number(u.id), Number(u.is_banned || 0) === 1);
                      toast.push("success", "Đã cập nhật trạng thái user.");
                      await reload();
                    }}
                  >
                    {Number(u.is_banned || 0) === 1 ? "Mở khóa" : "Khóa"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={async () => {
                      const out = await resetAdminUserPassword(Number(u.id));
                      toast.push(
                        "success",
                        `Reset token (${String(u.email)}): ${out.data?.resetToken || "N/A"}`
                      );
                    }}
                  >
                    Reset mật khẩu
                  </Button>
                  <Button variant="danger" onClick={() => setConfirm({ kind: "delete", user: u })}>
                    Xóa
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </DataTable>
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </AdminSectionCard>

      {editing ? (
        <AdminSectionCard className="p-4" ref={editorRef}>
          <form
            className="grid gap-3 md:grid-cols-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = e.currentTarget;
              const roleText = Array.from(
                f.querySelectorAll<HTMLInputElement>('input[name="roles"]:checked')
              )
                .map((x) => x.value)
                .join(",");
              const typedEmail = String((f.elements.namedItem("email") as HTMLInputElement).value || "")
                .trim()
                .toLowerCase();
              const existedInList = safeUsers.find(
                (u) => String(u.email || "").trim().toLowerCase() === typedEmail
              );
              const editingNumericId = Number(editing.id);
              const payload: Record<string, unknown> = {
                id: editingNumericId > 0 ? editingNumericId : existedInList ? existedInList.id : null,
                email: typedEmail,
                fullname: (f.elements.namedItem("fullname") as HTMLInputElement).value,
                department_id:
                  (f.elements.namedItem("department_id") as HTMLSelectElement).value || null,
                role: roleText,
                is_banned: (f.elements.namedItem("is_banned") as HTMLInputElement).checked,
                is_active: !(f.elements.namedItem("is_banned") as HTMLInputElement).checked,
              };
              try {
                await saveAdminUser(payload);
                setEditing(null);
                toast.push("success", "Lưu người dùng thành công.");
                await reload();
              } catch (err) {
                toast.push("error", apiErr(err, "Không lưu được người dùng."));
              }
            }}
          >
            <label className="text-sm">
              Email
              <Input name="email" defaultValue={String(editing.email || "")} list="emails" required />
              <datalist id="emails">
                {emailSuggestions.map((email) => (
                  <option key={email} value={email} />
                ))}
              </datalist>
            </label>
            <label className="text-sm">
              Họ tên
              <Input name="fullname" defaultValue={String(editing.fullname || "")} />
            </label>
            <label className="text-sm">
              Đơn vị
              <Select name="department_id" defaultValue={String(editing.department_id || "")}>
                <option value="">-- Không chọn --</option>
                {units.map((u) => (
                  <option key={u.id} value={u.code || u.name}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </label>
            <fieldset className="md:col-span-2 rounded border border-slate-200 p-3">
              <legend className="px-1 text-sm font-medium text-slate-700">Vai trò</legend>
              <div className="mt-1 grid gap-2 md:grid-cols-3">
                {ROLE_OPTIONS.map((r) => (
                  <div key={r} className="rounded border border-slate-200 bg-slate-50 p-2">
                    <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
                      <input
                        type="checkbox"
                        name="roles"
                        value={r}
                        defaultChecked={parseRoleList(editing.role).includes(r)}
                      />
                      {r}
                    </label>
                    <p className="mt-1 text-xs text-slate-600">{ROLE_GUIDE[r]}</p>
                  </div>
                ))}
              </div>
            </fieldset>
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input
                name="is_banned"
                type="checkbox"
                defaultChecked={Number(editing.is_banned || 0) === 1}
              />
              Khóa tài khoản
            </label>
            <div className="md:col-span-2 flex gap-2">
              <Button type="submit">Lưu</Button>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                Hủy
              </Button>
            </div>
          </form>
        </AdminSectionCard>
      ) : null}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === "delete" ? "Xác nhận xóa người dùng" : "Xác nhận đổi quyền"}
        description={
          confirm?.kind === "delete"
            ? `Bạn sắp xóa user ${confirm?.user.email}.`
            : `Bạn đang thay đổi quyền cho ${confirm?.user.email}.`
        }
        confirmLabel={confirm?.kind === "delete" ? "Xóa người dùng" : "Xác nhận thay đổi"}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (!confirm) return;
          if (confirm.kind === "delete") {
            if (Number(confirm.user.id) === Number(meId)) {
              toast.push("error", "Không thể tự xóa tài khoản hiện tại.");
              setConfirm(null);
              return;
            }
            await deleteAdminUser(Number(confirm.user.id));
            toast.push("success", "Đã xóa user.");
            setConfirm(null);
            await reload();
          } else if (editing && confirm.nextRoles) {
            await saveAdminUser({
              id: editing.id,
              email: editing.email,
              fullname: editing.fullname || "",
              department_id: editing.department_id || null,
              role: roleCsv(parseRoleList(confirm.nextRoles)),
            });
            toast.push("success", "Đã cập nhật vai trò.");
            setConfirm(null);
            setEditing(null);
            await reload();
          }
        }}
      />
    </div>
  );
}
