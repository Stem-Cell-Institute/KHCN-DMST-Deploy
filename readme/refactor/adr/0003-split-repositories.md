# ADR-0003: Split DocumentModel theo Bounded Context

- **Status**: Accepted
- **Ngay**: 2026-04-22
- **Bounded Context**: Workflow, Admin, Catalog

## Boi canh

`DocumentModel.js` hien tap trung 7 bang (documents, attachments, feedback, history, module_settings, document_types, audit_logs). Vi pham nguyen tac 1 aggregate / 1 repository va khien:
- Test unit kho: phai setup toan bo schema.
- Refactor mot phan de break cac phan khac.
- Ranh gioi BC mo ho.

## Lua chon xem xet

1. **Giu monolithic** - khong refactor, chap nhan.
2. **Split repo theo bang** - moi bang 1 repo, chi tiet nhung co the over-split.
3. **Split repo theo bounded context + aggregate** - repository dung muc aggregate trong BC.
4. **Chuyen sang ORM (Prisma, Drizzle)** - viet lai nhieu, chi phi cao.

## Quyet dinh

Chon Option 3. Target repositories:

| BC | Repository | Bang chinh |
|---|---|---|
| Workflow | `DocumentRepository` | `documents` (aggregate root) |
|  | `AttachmentRepository` | `document_attachments` |
|  | `FeedbackRepository` | `document_feedback` |
|  | `HistoryRepository` | `document_history` |
| Admin | `UserAdminRepository` | `users`, `user_roles`, `dms_user_roles` (read-only qua interface) |
|  | `AuditLogRepository` | `audit_logs` |
| Catalog | `UnitRepository` | `units` |
|  | `DocumentTypeRepository` | `document_types` |
|  | `SettingsRepository` | `module_settings` |

Repo cross-BC (vi du `UserAdminRepository` dung o Workflow de lay ten actor) **phai qua interface doc-only** `UserDirectory`, khong cho phep Workflow update user.

## He qua

- **Tich cuc**: test de, boundary ro; de migrate tung phan (vi du chuyen `Settings` sang Turso truoc).
- **Tieu cuc**: tang so file; can quan ly transaction cross-repo (vi du `DocumentRepository.save` + `HistoryRepository.append` trong 1 use-case).
- **Tac dong team**: them quy uoc ve Unit of Work hoac transaction helper.

## Thuc thi

- Sprint 3 trong migration map.
- Truoc khi tach: tach `ensureSchema` sang module migration rieng (Sprint 3 pre-step).
- Moi repo co interface + 1 implementation sqlite, de swap Turso de dang.

## Danh gia lai

Sau Sprint 3, do so dong + do phu thuoc giua repo, neu phat sinh coupling cross-BC thi xem xet gom lai hoac them application service moi.
