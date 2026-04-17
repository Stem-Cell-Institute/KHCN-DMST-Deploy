import { useEffect, useMemo, useState } from "react";
import {
  deleteAdminUser,
  fetchAdminMe,
  fetchAdminUsers,
  fetchUnits,
  resetAdminUserPassword,
  saveAdminUser,
  setAdminUserActive,
} from "@/lib/api";
import { Button, Input, Select } from "@/components/ui";
import type { Unit } from "@/lib/types";
import { AdminSectionCard, ConfirmDialog, DataTable, FormDialog, Pagination, useToast } from "@/components/admin/AdminPrimitives";

const ROLE_OPTIONS = ["master_admin", "module_manager", "proposer", "leader", "reviewer", "drafter", "user"];
const PAGE_SIZE = 10;

type UserRow = {
  id: number;
  email: string;
  fullname?: string;
  department_id?: string;
  role?: string;
  is_banned?: number;
  is_active?: number;
};

function parseRoleList(value: unknown): string[] {
  return String(value || "")
    .split(/[,\s;|]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function roleCsv(list: string[]) {
  return Array.from(new Set((list || []).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))).join(",");
}

export function UserManagementPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [page, setPage] = useState(1);
  const [confirm, setConfirm] = useState<{ kind: "delete" | "master"; user: UserRow; nextRoles?: string } | null>(null);
  const [meId, setMeId] = useState<number>(0);
  const toast = useToast();

  async function reload() {
    const [u, unit] = await Promise.all([fetchAdminUsers(), fetchUnits()]);
    setUsers(Array.isArray(u) ? (u as UserRow[]) : []);
    setUnits(Array.isArray(unit) ? unit : []);
  }

  useEffect(() => {
    void Promise.all([reload(), fetchAdminMe().then((m) => setMeId(Number(m.user?.id || 0)))]).catch(() => {});
  }, []);

  const safeUsers = Array.isArray(users) ? users : [];
  const totalPages = Math.max(1, Math.ceil(safeUsers.length / PAGE_SIZE));
  const pageRows = useMemo(() => safeUsers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [safeUsers, page]);
  const emailSuggestions = useMemo(
    () =>
      Array.from(new Set(safeUsers.map((u) => String(u.email || "").trim().toLowerCase()).filter(Boolean))).sort(),
    [safeUsers]
  );

  return (
    <div className="space-y-4">
      <AdminSectionCard className="p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800">Quản lý người dùng</h2>
          <Button onClick={() => setEditing({ id: 0, email: "", role: "user", is_banned: 0 })}>Thêm người dùng</Button>
        </div>
      </AdminSectionCard>

      <AdminSectionCard>
        <DataTable headers={["ID", "Email", "Họ tên", "Đơn vị", "Vai trò", "Trạng thái", "Thao tác"]}>
          {pageRows.map((u) => (
              <tr key={String(u.id)} className="border-t border-slate-100">
                <td className="px-3 py-2">{String(u.id)}</td>
                <td className="px-3 py-2">{String(u.email || "")}</td>
                <td className="px-3 py-2">{String(u.fullname || "")}</td>
                <td className="px-3 py-2">{String(u.department_id || "")}</td>
                <td className="px-3 py-2">{String(u.role || "")}</td>
                <td className="px-3 py-2">{Number(u.is_banned || 0) === 1 ? "inactive" : "active"}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => setEditing(u)}>Sửa</Button>
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
                        toast.push("success", `Reset token (${String(u.email)}): ${out.data?.resetToken || "N/A"}`);
                      }}
                    >
                      Reset mật khẩu
                    </Button>
                    <Button variant="danger" onClick={() => setConfirm({ kind: "delete", user: u })}>Xóa</Button>
                  </div>
                </td>
              </tr>
            ))}
        </DataTable>
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </AdminSectionCard>

      <FormDialog
        open={!!editing}
        title={editing?.id ? "Sửa người dùng" : "Thêm người dùng"}
        description="Dùng dialog để tạo hoặc cập nhật thông tin tài khoản."
        onClose={() => setEditing(null)}
      >
        {editing ? (
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
              const existedUser = safeUsers.find((u) => String(u.email || "").trim().toLowerCase() === typedEmail);
              const prevMaster = String(editing.role || "").split(",").map((x) => x.trim()).includes("master_admin");
              const nextMaster = roleText.split(",").map((x) => x.trim()).includes("master_admin");
              if (editing.id && prevMaster !== nextMaster) {
                setConfirm({ kind: "master", user: editing, nextRoles: roleText });
                return;
              }
              const payload: Record<string, unknown> = {
                id: editing.id || (existedUser ? existedUser.id : null),
                email: typedEmail,
                fullname: (f.elements.namedItem("fullname") as HTMLInputElement).value,
                department_id: (f.elements.namedItem("department_id") as HTMLSelectElement).value || null,
                role: roleText,
                is_banned: (f.elements.namedItem("is_banned") as HTMLInputElement).checked,
                is_active: !(f.elements.namedItem("is_banned") as HTMLInputElement).checked,
              };
              const password = (f.elements.namedItem("password") as HTMLInputElement).value;
              if (password) payload.password = password;
              await saveAdminUser(payload);
              setEditing(null);
              toast.push("success", "Lưu người dùng thành công.");
              await reload();
            }}
          >
            <label className="text-sm">Email
              <Input name="email" defaultValue={String(editing.email || "")} list="registered-email-suggestions" required />
              <datalist id="registered-email-suggestions">
                {emailSuggestions.map((email) => <option key={email} value={email} />)}
              </datalist>
            </label>
            <label className="text-sm">Họ tên<Input name="fullname" defaultValue={String(editing.fullname || "")} /></label>
            <label className="text-sm">Đơn vị
              <Select name="department_id" defaultValue={String(editing.department_id || "")}>
                <option value="">-- Không chọn --</option>
                {units.map((u) => <option key={u.id} value={u.code || u.name}>{u.name}</option>)}
              </Select>
            </label>
            <label className="text-sm">Mật khẩu (chỉ nhập khi tạo mới / đổi)
              <Input name="password" type="password" />
            </label>
            <fieldset className="md:col-span-2 rounded border border-slate-200 p-3">
              <legend className="px-1 text-sm font-medium text-slate-700">Vai trò người dùng</legend>
              <div className="mt-1 grid gap-2 md:grid-cols-3">
                {ROLE_OPTIONS.map((r) => (
                  <label key={r} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="roles" value={r} defaultChecked={parseRoleList(editing.role).includes(r)} />
                    {r}
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Có thể gõ email để chọn account đã đăng ký; khi trùng email hệ thống sẽ cập nhật role cho account đó.
              </p>
            </fieldset>
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input name="is_banned" type="checkbox" defaultChecked={Number(editing.is_banned || 0) === 1} />
              Khóa tài khoản
            </label>
            <div className="md:col-span-2 flex gap-2">
              <Button type="submit">Lưu</Button>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>Hủy</Button>
            </div>
          </form>
        ) : null}
      </FormDialog>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === "delete" ? "Xác nhận xóa người dùng" : "Xác nhận đổi quyền Master Admin"}
        description={
          confirm?.kind === "delete"
            ? `Bạn sắp xóa user ${confirm?.user.email}. Hành động này có thể không hoàn tác.`
            : `Bạn đang thay đổi quyền master_admin cho ${confirm?.user.email}.`
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
            return;
          }
          if (editing && confirm.nextRoles) {
            await saveAdminUser({
              id: editing.id,
              email: editing.email,
              fullname: editing.fullname || "",
              department_id: editing.department_id || null,
              role: roleCsv(parseRoleList(confirm.nextRoles)),
              is_banned: Number(editing.is_banned || 0) === 1,
              is_active: Number(editing.is_banned || 0) !== 1,
            });
            toast.push("success", "Đã cập nhật vai trò Master Admin.");
            setConfirm(null);
            setEditing(null);
            await reload();
          }
        }}
      />
    </div>
  );
}
