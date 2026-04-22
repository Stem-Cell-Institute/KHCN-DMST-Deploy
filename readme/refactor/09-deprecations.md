# 09 - Deprecation Register

Danh sach path / API / component **hard deprecated**. Moi muc co:
- Path cu
- Replacement
- Status (soft / hard)
- Deadline xoa
- Ly do

> Deadline **fixed**: `2026-06-30` cho nhom frontend UI.

## 1. Frontend

### 1.1 `components/admin/AdminPrimitives`
- **Status**: hard deprecated
- **Deadline**: 2026-06-30
- **Replacement**:
  - Generic UI -> `@/shared/ui/primitives`
  - Admin card -> `@/features/document-workflow/admin/components/AdminCards`
- **Ly do**: tron lan UI generic voi admin-specific, pha boundary DDD.
- **Guardrail**: `no-restricted-imports` + grep CI.

### 1.2 `components/admin/AdminGuard`
- **Status**: hard deprecated
- **Deadline**: 2026-06-30
- **Replacement**: `@/features/document-workflow/admin/components/AdminGuard`
- **Guardrail**: `no-restricted-imports`.

### 1.3 `pages/admin/*`
- **Status**: hard deprecated
- **Deadline**: 2026-06-30
- **Replacement**: `@/features/document-workflow/admin/pages/*`
- **Guardrail**: `no-restricted-imports`.

### 1.4 `lib/api.ts` (khi da tach)
- **Status**: soft deprecated -> facade re-export
- **Deadline**: 2026-09-30
- **Replacement**:
  - Workflow API -> `@/features/document-workflow/use-cases/documentWorkflowApi`
  - Admin API -> `@/features/document-workflow/use-cases/adminWorkflowApi`
- **Guardrail**: review thu cong ban dau, lint sau.

## 2. Backend

### 2.1 `routes/internalDocumentsWorkflow.js`
- **Status**: soft deprecated
- **Deadline**: 2026-07-31
- **Replacement**: `modules/document-workflow/routes/documentWorkflowRoutes.js`
- **Hanh dong**: xac nhan khong co client nao con goi -> xoa.

### 2.2 `DocumentModel` (sau sprint 3)
- **Status**: soft deprecated
- **Deadline**: 2026-08-31
- **Replacement**: `infrastructure/repositories/*`
- **Guardrail**: lint rule chan import `DocumentModel` ngoai `infrastructure/` (viet rule custom ESLint hoac grep CI).

### 2.3 Mail call truc tiep (`mailSend` trong controller)
- **Status**: hard deprecated sau sprint 4
- **Deadline**: sprint 5
- **Replacement**: phat `DomainEvent`, `WorkflowNotificationHandler` lang nghe.
- **Guardrail**: grep CI `mailSend\\(` trong `controllers/` tra ve 0.

## 3. API endpoints

_(khong co breaking change API o target v2 hien tai; cap nhat neu them trong sprint sau)_

## 4. Quy trinh xoa

1. Check `git grep <path>` == 0 trong `frontend/document-workflow-ui/src` va `modules/document-workflow`.
2. Check CI guardrail vang trong it nhat 2 PR lien tuc.
3. Xoa file + cap nhat README + bo entry trong `eslint.config.js`.
4. Tag commit `deprecation/<path>-removed`.

## 5. Quy trinh gia han

- Can review cua tech lead.
- Ghi ro ly do gia han va deadline moi.
- Update bang nay + notify team.
