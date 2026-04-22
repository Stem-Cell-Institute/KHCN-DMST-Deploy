# 02 - Ubiquitous Language (Glossary)

Danh sach thuat ngu chinh trong Document Workflow. Dung **thong nhat** trong code, API, tai lieu, PR.

## A. Quy trinh (Workflow)

| Thuat ngu VN | Tuong duong EN (code) | Y nghia |
|---|---|---|
| Ho so | Document | Don vi chinh cua module, ung voi 1 record trong `documents`. |
| Buoc quy trinh | WorkflowStep | 1 trong 9 buoc tu tao den luu tru. |
| Quy trinh | Workflow | Chuoi 9 buoc gan voi 1 ho so. |
| Phan cong | Assign | Chuyen ho so tu buoc 1 (tao) sang buoc 2 (co nguoi xu ly). |
| Soan thao | Draft / SaveDraft | Buoc 3: nguoi duoc giao up tai lieu nhap. |
| Review | Review | Buoc 4: nguoi co tham quyen nhan xet (phe duyet / tra lai). |
| Gop y | Feedback | Nhan xet cua reviewer, luu trong `document_feedback`. |
| Hoan thien | Finalize | Buoc 5: soan lai theo gop y. |
| Nop ho so | Submit | Buoc 6: nop ban hoan chinh len cap cao hon. |
| Phe duyet | Approve | Buoc 7 (noi bo review approve). |
| Ban hanh | Publish | Buoc 8: cong bo, gui email toan bo vai tro lien quan. |
| Luu tru | Archive | Buoc 9: dong ho so, khong con sua. |

### Cac buoc quy trinh (danh chinh)

1. **Tao ho so** (Create)
2. **Phan cong** (Assign)
3. **Soan thao** (Draft)
4. **Review** (Review)
5. **Hoan thien** (Finalize)
6. **Nop** (Submit)
7. **Phe duyet** (Approve)
8. **Ban hanh** (Publish)
9. **Luu tru** (Archive)

> Ghi chu: cac buoc 2-8 co the chuyen `tien` hoac `lui` tuy quyen va trang thai hien tai.

## B. Vai tro (Role)

| Thuat ngu | Ma trong code | Pham vi |
|---|---|---|
| Master admin | `admin` | Full quyen toan he thong. |
| Module admin | `document-workflow-admin` | Quan tri module (user, unit, setting, audit). |
| Reviewer | `document-reviewer` | Review o buoc 4. |
| Publisher | `document-publisher` | Ban hanh buoc 8. |
| Nguoi duoc giao | `assignee` (derived) | Nguoi duoc giao xu ly buoc 3/5. |
| Nguoi tao | `creator` (derived) | Nguoi tao ho so buoc 1. |

> Vai tro `derived` (assignee/creator) khong phai role cung trong bang, ma tinh tu quan he `documents.created_by`, `documents.assigned_to`.

## C. Du lieu

| Thuat ngu | Bang / Cot | Ghi chu |
|---|---|---|
| Ho so | `documents` | Pk `id`, FK `created_by`, `assigned_to`, `unit_id`, `document_type_id`. |
| Dinh kem | `document_attachments` | FK `document_id`, `step`. |
| Gop y | `document_feedback` | FK `document_id`, `reviewer_id`, `step`. |
| Lich su | `document_history` | Audit kieu timeline cho ho so. |
| Don vi | `units` | Don vi hanh chinh. |
| Loai ho so | `document_types` | Phan loai van ban. |
| Cau hinh | `module_settings` | Key/value theo module. |
| Nhat ky | `audit_logs` | Log hanh dong admin. |

## D. Kien truc (DDD)

| Thuat ngu | Y nghia |
|---|---|
| Bounded Context (BC) | Ranh gioi ngu nghia (Workflow / Admin / Catalog / Notification / Shared Kernel). |
| Aggregate | Cum entity co root (vi du `Document` la root cua Workflow BC). |
| Value Object (VO) | Khong co id rieng, bat bien (vi du `WorkflowStep`, `DocumentStatus`). |
| Domain Event | Su kien nghiep vu (vi du `DocumentPublished`) phat ra khi aggregate thay doi. |
| Use-case (Application Service) | Orchestration 1 hanh dong nguoi dung (vi du `PublishDocument`). |
| Repository | Cau noi aggregate <-> persistence. |
| Domain Event Bus | Pub/sub in-process cho event trong cung process. |
| Composition Root | Noi wiring toan bo dependency (`routes/documentWorkflowRoutes.js`). |

## E. Frontend

| Thuat ngu | Y nghia |
|---|---|
| Feature folder | `features/<context>/*` chua page/component/use-case cua 1 BC. |
| Shared UI | `shared/ui/*` - component khong biet domain. |
| Shared Lib | `shared/lib/*` - auth, types, utilities chung. |
| Use-case hook | React hook goi 1 API + state cho 1 hanh dong cu the. |
| Guard | Component chan route theo role (vi du `AdminGuard`). |

## F. Van hanh

| Thuat ngu | Y nghia |
|---|---|
| Guardrail | Rule CI chan regression (deprecated import, PR checklist, ...). |
| Shim / Compatibility layer | File re-export tam thoi giu path cu con chay, co deadline xoa. |
| Hard deprecate | Them warning + lint rule chan import moi + deadline xoa. |
| Migration sprint | 1 don vi cong viec refactor ~1 tuan, co DoD rieng. |

## G. Quy uoc dat ten

- Use-case: `<Verb><Noun>` (vi du `PublishDocument`, `AddFeedback`).
- Event: `<Noun><PastVerb>` (vi du `DocumentPublished`, `FeedbackAdded`).
- Repository: `<Aggregate>Repository` (vi du `DocumentRepository`).
- Service application: `<Context>Service` hoac `<UseCaseGroup>Service`.
- Frontend hook: `use<Verb><Noun>` (vi du `usePublishDocument`).
