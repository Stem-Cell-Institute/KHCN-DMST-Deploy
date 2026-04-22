# 04 - Event Catalog (Domain Events)

Danh sach event duoc phat tu domain layer, payload va handler dang ky.

## 1. Quy uoc chung

- Event la **imutable fact**, dat ten qua khu: `<Noun><PastVerb>`.
- Payload chi chua id + field bien doi, khong tra ve aggregate full.
- Version hoa payload qua field `v` (khoi dau `1`).
- Meta chung moi event: `occurredAt`, `actorId`, `correlationId`.

Schema JSON goc:

```json
{
  "type": "DocumentPublished",
  "v": 1,
  "occurredAt": "2026-04-22T10:30:00Z",
  "actorId": 42,
  "correlationId": "req-abc-123",
  "payload": { ... }
}
```

## 2. Workflow BC events

### 2.1 `DocumentCreated`
- **Trigger**: `CreateDocumentUseCase`.
- **Payload**: `{ documentId, title, unitId, createdBy }`.
- **Handlers**: `AuditLogHandler`.

### 2.2 `DocumentAssigned`
- **Trigger**: `AssignDocumentUseCase`.
- **Payload**: `{ documentId, assigneeId, previousAssigneeId?, dueDate? }`.
- **Handlers**: `WorkflowNotificationHandler` (mail to assignee), `AuditLogHandler`.

### 2.3 `DraftSaved`
- **Trigger**: `SaveDraftUseCase`.
- **Payload**: `{ documentId, step, attachmentIds: [] }`.
- **Handlers**: `AuditLogHandler`.

### 2.4 `DocumentReviewed`
- **Trigger**: `ReviewDocumentUseCase`.
- **Payload**: `{ documentId, reviewerId, decision: "approve"|"request-changes", step }`.
- **Handlers**: `WorkflowNotificationHandler` (mail to assignee), `AuditLogHandler`.

### 2.5 `FeedbackAdded`
- **Trigger**: `AddFeedbackUseCase`.
- **Payload**: `{ documentId, feedbackId, reviewerId, step }`.
- **Handlers**: `WorkflowNotificationHandler`, `AuditLogHandler`.

### 2.6 `DraftFinalized`
- **Trigger**: `FinalizeDraftUseCase`.
- **Payload**: `{ documentId, attachmentIds: [] }`.
- **Handlers**: `WorkflowNotificationHandler` (mail to reviewer), `AuditLogHandler`.

### 2.7 `DocumentSubmitted`
- **Trigger**: `SubmitDocumentUseCase`.
- **Payload**: `{ documentId, submittedBy, submittedTo }`.
- **Handlers**: `WorkflowNotificationHandler` (mail to approver), `AuditLogHandler`.

### 2.8 `DocumentApproved`
- **Trigger**: `ApproveDocumentUseCase`.
- **Payload**: `{ documentId, approverId }`.
- **Handlers**: `WorkflowNotificationHandler` (mail to publisher), `AuditLogHandler`.

### 2.9 `DocumentPublished`
- **Trigger**: `PublishDocumentUseCase`.
- **Payload**: `{ documentId, publisherId, publishedAt }`.
- **Handlers**: `WorkflowNotificationHandler` (broadcast mail theo rule), `AuditLogHandler`, `SearchIndexHandler?`.

### 2.10 `DocumentArchived`
- **Trigger**: `ArchiveDocumentUseCase`.
- **Payload**: `{ documentId, archivedBy, reason? }`.
- **Handlers**: `AuditLogHandler`.

### 2.11 `AttachmentRemoved`
- **Trigger**: `RemoveAttachmentUseCase`.
- **Payload**: `{ documentId, attachmentId, step }`.
- **Handlers**: `AuditLogHandler`.

## 3. Admin BC events

### 3.1 `UserRoleChanged`
- **Payload**: `{ userId, role, action: "grant"|"revoke", moduleId }`.
- **Handlers**: `AuditLogHandler`.

### 3.2 `UnitCreated` / `UnitUpdated` / `UnitDeleted`
- **Payload**: `{ unitId, name?, changes? }`.
- **Handlers**: `AuditLogHandler`.

### 3.3 `ModuleSettingsUpdated`
- **Payload**: `{ moduleId, keys: [] }`.
- **Handlers**: `AuditLogHandler`, `SettingsCacheInvalidator?`.

### 3.4 `EmailRulesUpdated`
- **Payload**: `{ ruleIds: [] }`.
- **Handlers**: `AuditLogHandler`, `NotificationRuleReloader`.

## 4. Handler contract

```js
// application/events/DomainEventBus.js (ky thuat)
bus.subscribe("DocumentPublished", async (event) => {
  await workflowNotificationHandler.handle(event);
});
```

- Handler **phai idempotent** (nhan event trung khong gay side effect trung).
- Handler **khong nem loi ra ngoai bus** -> dung try/catch, log.
- Handler co the chay async (fire-and-forget) nhung phai dam bao phat hien loi (log + metric).

## 5. Evolution rules

- Them field: tang `v` neu handler cu khong tuong thich; neu backward compatible thi giu `v`.
- Xoa field: khong duoc xoa trong cung version -> phai bump major.
- Rename event: deprecate 1 sprint, phat ca 2 ten (old + new) trong thoi gian giao thoa.

## 6. Observability

- Moi event log 1 dong: `[event] type=... actor=... doc=...`.
- Metric: counter theo `type`, histogram thoi gian xu ly handler.
- Correlate voi request log qua `correlationId`.
