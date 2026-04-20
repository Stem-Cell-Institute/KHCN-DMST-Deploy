import { parseRoles } from "./auth";
import type { DocumentRecord, MeUser, WorkflowStep } from "./types";

export interface StepPermission {
  canAct: boolean;
  reason?: string;
}

export function canCreateDocument(me: MeUser | null) {
  if (!me) return false;
  const roles = parseRoles(me.role);
  return roles.includes("proposer") || roles.includes("admin") || roles.includes("master_admin") || roles.includes("module_manager");
}

export function stepPermission(me: MeUser | null, doc: DocumentRecord, step: WorkflowStep): StepPermission {
  if (!me) return { canAct: false, reason: "Bạn chưa đăng nhập." };
  const roles = parseRoles(me.role);
  const isSuperManager = roles.includes("admin") || roles.includes("master_admin") || roles.includes("module_manager");
  if (isSuperManager) return { canAct: true };

  const isAssignedDrafter =
    roles.includes("drafter") && Number(doc.assigned_to_id || 0) === Number(me.id || -1);
  const isLeader = roles.includes("leader");
  const isReviewer = roles.includes("reviewer");

  if (doc.current_step !== step) {
    return { canAct: false, reason: `Hồ sơ đang ở bước ${doc.current_step}.` };
  }

  switch (step) {
    case 1:
      return {
        canAct: roles.includes("proposer"),
        reason: "Chỉ Người đề xuất thao tác bước 1.",
      };
    case 2:
      return { canAct: isLeader, reason: "Chỉ Lãnh đạo Viện thao tác bước 2." };
    case 3:
      return {
        canAct: isAssignedDrafter,
        reason: "Chỉ Người soạn thảo được giao thao tác bước 3.",
      };
    case 4:
      return { canAct: isReviewer, reason: "Chỉ Reviewer thao tác bước 4." };
    case 5:
      return {
        canAct: isAssignedDrafter || isReviewer || isLeader,
        reason: "Chỉ Drafter/Reviewer/Leader thao tác bước 5.",
      };
    case 6:
      return {
        canAct: isAssignedDrafter,
        reason: "Chỉ Người soạn thảo được giao thao tác bước 6.",
      };
    case 7:
      return {
        canAct: isAssignedDrafter,
        reason: "Chỉ Người soạn thảo được giao thao tác bước 7.",
      };
    case 8:
      return { canAct: false, reason: "Chỉ Văn thư/Admin thao tác bước 8." };
    case 9:
      return { canAct: false, reason: "Chỉ Văn thư/Admin thao tác bước 9." };
    default:
      return { canAct: false, reason: "Không có quyền." };
  }
}
