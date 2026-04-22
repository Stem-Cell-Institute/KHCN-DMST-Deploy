# 01 - Baseline hien trang (As-Is Snapshot)

Tai lieu nay chot lai **hien trang module `document-workflow`** truoc khi bat dau refactor. Dung lam diem tham chieu de:
- so sanh khi chuyen tu as-is sang to-be
- danh gia rui ro refactor
- do luong tien do (bundle size, so file, so dong logic trong controller...)

> Ngay chup baseline: _____ (ghi vao khi bat dau Sprint 0).
> Commit baseline: `<git rev-parse HEAD>`.

## 1. Module inventory

### Backend (`modules/document-workflow/`)

| Folder | File chinh | Vai tro hien tai |
|---|---|---|
| `controllers/` | `documentWorkflowController.js` | "Fat controller": chua business logic, helper, goi truc tiep DB. |
|  | `documentWorkflowAdminController.js` | Admin: user/unit/setting/audit log, cung goi truc tiep `DocumentModel`. |
| `middleware/` | `documentPermissionMiddleware.js` | Authorization tap trung (role parse, `canAccessDocument`, guard factory). |
| `models/` | `DocumentModel.js` | Monolithic model: documents, attachments, feedback, history, module_settings, document_types, audit_logs. |
| `routes/` | `documentWorkflowRoutes.js` | Composition root: khoi tao model, middleware, controller, upload service; mount route. |
| `services/` | `documentUploadService.js` | Multer upload. |
|  | `documentWorkflowMailRules.js` | Helper compose mail (dang rai rac giua controller + service). |

### Frontend (`frontend/document-workflow-ui/src/`)

| Folder | File chinh | Vai tro hien tai |
|---|---|---|
| `pages/` | `DocumentListPage.tsx`, `DocumentDetailPage.tsx` | Page workflow. |
| `pages/admin/` | `AdminLayout.tsx`, `AdminDashboardPage.tsx`, `UserManagementPage.tsx`, `UnitsManagementPage.tsx`, `ModulePermissionsPage.tsx`, `ModuleSettingsPage.tsx`, `AuditLogsPage.tsx`, `EmailNotificationsPage.tsx` | Page admin. |
| `components/` | `StepForms.tsx`, `AttachmentUploader.tsx`, ... | UI specific workflow. |
| `components/admin/` | `AdminPrimitives.tsx`, `AdminGuard.tsx`, ... | Primitives + guard - mix generic + admin-specific. |
| `lib/` | `api.ts`, `auth.ts` | Client API monolithic. |

## 2. Diem dau bang (smell) can refactor

- **Controller lam business**: validate chuyen buoc, lay role, compose mail, query DB nam trong controller (~500-900 dong).
- **Model monolithic**: 1 file xu ly nhieu BC (Document, Unit, Setting, AuditLog, Type) -> kho mock, kho test, kho split.
- **Side effect inline**: mail + audit log duoc goi truc tiep sau khi update DB, khong phai event.
- **Admin UI coupled voi generic UI**: `AdminPrimitives.tsx` chua ca `DataTable` (generic) lan `AdminSidebarCard` (domain-specific).
- **API client 1 file**: `lib/api.ts` chua tat ca endpoint (workflow + admin).
- **Route cu con ton tai**: `routes/internalDocumentsWorkflow.js` song song voi routes moi.

## 3. Metric baseline (can do luong truoc refactor)

Chay va ghi lai vao bang duoi khi bat dau Sprint 0.

| Metric | Cach do | Baseline |
|---|---|---|
| Bundle size production | `npm run build` -> tong kich thuoc `dist/assets/*` | |
| Cold start backend | `time node server.js` den khi log "listening" | |
| Response p95 `GET /api/document-workflow/documents` | k6/autocannon 30s, 10 VU | |
| Response p95 `POST .../assign` | k6/autocannon | |
| Email delivery latency | log time giua event trigger va `mailSend` return | |
| So dong controller workflow | `wc -l controllers/documentWorkflowController.js` | |
| So dong DocumentModel | `wc -l models/DocumentModel.js` | |
| So file tsx trong `components/admin/` | `ls components/admin \| Measure-Object` | |
| ESLint warning count | `npm run lint` | |
| Test coverage (neu co) | jest/coverage | |

## 4. Dependency map (rut gon)

```
[Express server.js]
   |
   v
[documentWorkflowRoutes.js] --(injects)--> [DocumentModel] --(uses)--> [sqlite db]
   |                                         ^
   |                                         | (direct)
   v                                         |
[documentWorkflowController] ----------------+
   |
   +--> [documentPermissionMiddleware]
   +--> [documentUploadService (multer)]
   +--> [documentWorkflowMailRules] --> [mailSend]
```

Frontend:
```
[App.tsx]
   +--> pages/* --> components/* --> lib/api.ts
   +--> pages/admin/* --> components/admin/AdminPrimitives, AdminGuard --> lib/api.ts
```

## 5. Risk hotspot

- `DocumentModel.ensureSchema()` chay o boot, anh huong toan he thong neu chinh sai.
- Permission logic anh xa 3 bang (`users.role`, `user_roles`, `dms_user_roles`) - refactor de sot.
- Email rule gan chat voi workflow step - de gui thieu/trung.
- Admin SPA build trong `server.js` production - refactor build script co the vo silent.

## 6. Cach cap nhat baseline

- Cap nhat khi:
  - Tang/giam so file module.
  - Thay doi schema DB.
  - Thay doi CI pipeline.
- Luu commit hash baseline trong `CHANGELOG.md` cua module.
