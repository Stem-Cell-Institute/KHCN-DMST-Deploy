# 03 - API Contract (HTTP <-> Use-case)

Bang nay dinh nghia **hop dong giua HTTP endpoint va application use-case** cua module Document Workflow theo Target v2. Moi dong mo ta:
- method + path
- use-case tuong ung (trong `application/document/use-cases/`)
- role yeu cau
- domain event phat ra (neu co)
- notification handler lang nghe

Muc dich: lam **single source of truth** khi refactor controller - chi parse DTO va goi dung use-case.

## 1. Workflow BC

### 1.1 Query (read-only)

| Method + Path | Use-case | Role | Event | Mo ta |
|---|---|---|---|---|
| `GET /api/document-workflow/documents` | `ListDocumentsQuery` | auth + role tuy filter | - | Danh sach, filter theo step/unit/role. |
| `GET /api/document-workflow/documents/:id` | `GetDocumentDetailQuery` | `canAccessDocument` | - | Chi tiet 1 ho so + history + attachments. |
| `GET /api/document-workflow/documents/:id/history` | `GetDocumentHistoryQuery` | `canAccessDocument` | - | Lich su chuyen buoc. |
| `GET /api/document-workflow/documents/:id/attachments` | `ListAttachmentsQuery` | `canAccessDocument` | - | Theo `step`. |
| `GET /api/document-workflow/documents/:id/feedback` | `ListFeedbackQuery` | `canAccessDocument` | - | |

### 1.2 Command (write)

| Method + Path | Use-case | Role | Event | Notification |
|---|---|---|---|---|
| `POST /api/document-workflow/documents` | `CreateDocumentUseCase` | `creator` | `DocumentCreated` | - |
| `POST /api/document-workflow/documents/:id/assign` | `AssignDocumentUseCase` | admin / module-admin | `DocumentAssigned` | mail to assignee |
| `POST /api/document-workflow/documents/:id/drafts` | `SaveDraftUseCase` | assignee | `DraftSaved` | - |
| `POST /api/document-workflow/documents/:id/review` | `ReviewDocumentUseCase` | reviewer | `DocumentReviewed` | mail to assignee |
| `POST /api/document-workflow/documents/:id/feedback` | `AddFeedbackUseCase` | reviewer | `FeedbackAdded` | mail to assignee |
| `POST /api/document-workflow/documents/:id/finalize` | `FinalizeDraftUseCase` | assignee | `DraftFinalized` | mail to reviewer |
| `POST /api/document-workflow/documents/:id/submit` | `SubmitDocumentUseCase` | assignee | `DocumentSubmitted` | mail to approver |
| `POST /api/document-workflow/documents/:id/approve` | `ApproveDocumentUseCase` | approver | `DocumentApproved` | mail to publisher |
| `POST /api/document-workflow/documents/:id/publish` | `PublishDocumentUseCase` | publisher | `DocumentPublished` | mail broadcast |
| `POST /api/document-workflow/documents/:id/archive` | `ArchiveDocumentUseCase` | admin / module-admin | `DocumentArchived` | - |
| `DELETE /api/document-workflow/documents/:id/attachments/:attId` | `RemoveAttachmentUseCase` | owner step hien tai | `AttachmentRemoved` | - |

## 2. Admin BC

| Method + Path | Use-case | Role | Event |
|---|---|---|---|
| `GET /api/document-workflow/admin/users` | `ListUsersQuery` | module-admin | - |
| `POST /api/document-workflow/admin/users/:id/roles` | `AssignRoleUseCase` | module-admin | `UserRoleChanged` |
| `DELETE /api/document-workflow/admin/users/:id/roles/:role` | `RevokeRoleUseCase` | module-admin | `UserRoleChanged` |
| `GET /api/document-workflow/admin/units` | `ListUnitsQuery` | module-admin | - |
| `POST /api/document-workflow/admin/units` | `CreateUnitUseCase` | module-admin | `UnitCreated` |
| `PUT /api/document-workflow/admin/units/:id` | `UpdateUnitUseCase` | module-admin | `UnitUpdated` |
| `DELETE /api/document-workflow/admin/units/:id` | `DeleteUnitUseCase` | module-admin | `UnitDeleted` |
| `GET /api/document-workflow/admin/settings` | `GetModuleSettingsQuery` | module-admin | - |
| `PUT /api/document-workflow/admin/settings` | `UpdateModuleSettingsUseCase` | module-admin | `ModuleSettingsUpdated` |
| `GET /api/document-workflow/admin/audit-logs` | `ListAuditLogsQuery` | module-admin | - |
| `GET /api/document-workflow/admin/notifications` | `GetEmailRulesQuery` | module-admin | - |
| `PUT /api/document-workflow/admin/notifications` | `UpdateEmailRulesUseCase` | module-admin | `EmailRulesUpdated` |

## 3. DTO conventions

### 3.1 Request

- Body: JSON camelCase.
- File upload: `multipart/form-data`, field `files[]`, metadata trong field JSON string `metadata`.
- Query filter: `?step=3&unitId=5&assignedTo=12`.
- Paging: `?page=1&pageSize=20`.

### 3.2 Response

Success:
```json
{
  "data": { ... },
  "meta": { "page": 1, "pageSize": 20, "total": 123 }
}
```

Error envelope:
```json
{
  "error": {
    "code": "WORKFLOW_INVALID_STEP",
    "message": "Khong the chuyen tu buoc 3 sang buoc 5.",
    "details": { "currentStep": 3, "targetStep": 5 }
  }
}
```

### 3.3 Error code convention

- Prefix theo BC: `WORKFLOW_*`, `ADMIN_*`, `CATALOG_*`, `NOTIFICATION_*`.
- Suffix mo ta ngan: `INVALID_STEP`, `PERMISSION_DENIED`, `NOT_FOUND`, `DUPLICATE`, `UPLOAD_FAILED`.

## 4. Versioning

- Base path: `/api/document-workflow`.
- Khi breaking change: `/api/v2/document-workflow/...`, giu v1 song song it nhat 1 sprint.

## 5. Idempotency

- Command chuyen buoc (`assign`, `review`, `publish`, `archive`) nen nhan header `Idempotency-Key` (UUID client gen).
- Server check + cache response 24h (implement o application service).

## 6. Contract test

- Moi dong bang tren ung voi 1 contract test: (a) success case, (b) permission denied, (c) invalid state (sai buoc).
- Contract test phai chay tren CI, chan deploy neu fail.
