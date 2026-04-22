# 07 - Merge/Release Checklist (1 trang)

Dung de chot 1 sprint refactor truoc khi merge vao `main` hoac deploy production.

## A. Workspace

- [ ] `git status` sach (khong co untracked ngoai y muon).
- [ ] Khong commit `*.db`, `.env`, `node_modules`, `dist/` thua.
- [ ] `.gitignore` dung khop.

## B. CI

- [ ] `document-workflow-guardrails.yml`: **deprecated-import-guard** PASS.
- [ ] `document-workflow-guardrails.yml`: **frontend-quality-gate** (lint + build) PASS.
- [ ] `document-workflow-guardrails.yml`: **pr-checklist-gate** PASS.
- [ ] Backend test (`npm test`) PASS.

## C. Regression

- [ ] Da chay `06-regression-checklist.md` cho cac use-case bi tac dong sprint nay.
- [ ] File regression luu trong `readme/refactor/sprint-logs/<sprint>/regression.md`.

## D. DDD boundary

- [ ] Khong them import vao path deprecated (`components/admin/AdminPrimitives`, `pages/admin/*`, `components/admin/AdminGuard`).
- [ ] Khong them method moi vao `DocumentModel` (phai them vao repository tuong ung).
- [ ] Khong goi `mailSend` truc tiep trong controller/use-case moi (phai qua event handler).

## E. Deprecation

- [ ] Deadline deprecation trong `09-deprecations.md` con hieu luc.
- [ ] Neu qua deadline: da xoa thuc su hoac da gia han + ghi ly do.

## F. Tai lieu

- [ ] ADR moi (neu co) da merge, status Accepted.
- [ ] `02-glossary.md` cap nhat neu co thuat ngu moi.
- [ ] `03-api-contract.md` cap nhat neu them/sua endpoint.
- [ ] `04-event-catalog.md` cap nhat neu them event.

## G. Release readiness

- [ ] Release note draft trong `readme/refactor/sprint-logs/<sprint>/release-notes.md`.
- [ ] Rollback plan xac nhan trong `08-rollback-runbook.md`.
- [ ] Nguoi on-call deploy co trong danh sach.

## H. Sign-off

- [ ] Tech lead: ______
- [ ] QA: ______
- [ ] DevOps: ______
- [ ] Product owner: ______

> Sau khi tick du, merge + tag `refactor/sprint-<N>-done` tren git.
