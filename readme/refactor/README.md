# Document Workflow Refactor - Bo tai lieu

Bo tai lieu nay phuc vu refactor module `document-workflow` theo Domain-Driven Design (DDD). Muc tieu: chuyen tu kien truc hybrid hien tai sang DDD clean hoan toan, giam rui ro, giu san xuat chay lien tuc.

## Cau truc

### 1. Tam nhin & kien truc
- [Target Architecture v2 (C4 + Migration Map)](../document-workflow-target-architecture-v2.md)
- [Baseline hien trang (as-is snapshot)](./01-baseline-as-is.md)
- [Ubiquitous Language / Glossary](./02-glossary.md)

### 2. Hop dong ky thuat
- [API Contract - HTTP <-> Use-case](./03-api-contract.md)
- [Event Catalog - Domain Events](./04-event-catalog.md)

### 3. Quyet dinh kien truc (ADR)
- [ADR Index](./adr/README.md)
- [ADR-0001: Chon DDD layering cho module](./adr/0001-ddd-layering.md)
- [ADR-0002: In-process Domain Event Bus](./adr/0002-in-process-event-bus.md)
- [ADR-0003: Split DocumentModel theo Bounded Context](./adr/0003-split-repositories.md)
- [ADR Template](./adr/_template.md)

### 4. Chat luong & kiem thu
- [Test Strategy theo layer](./05-test-strategy.md)
- [Regression Checklist theo use-case](./06-regression-checklist.md)

### 5. Van hanh & phat hanh
- [Merge/Release Checklist 1 trang](./07-merge-checklist.md)
- [Rollback Runbook](./08-rollback-runbook.md)
- [Deprecation Register](./09-deprecations.md)

### 6. Quan tri code
- [CI Guardrail + PR Template Spec](./10-ci-guardrails.md)
- [Contributor Guide (onboarding DDD v2)](./11-contributor-guide.md)

### 7. Tracking
- [Sprint Tracker Template](./12-sprint-tracker.md)

## Luong doc khuyen nghi

1. Developer moi: `README.md` -> `02-glossary.md` -> `11-contributor-guide.md` -> target architecture v2.
2. Reviewer kien truc: target architecture v2 -> ADR -> API contract -> event catalog.
3. Nguoi chot release: merge checklist -> regression checklist -> rollback runbook -> deprecation register.
4. Maintainer CI: CI guardrail spec -> PR template spec.

## Nguyen tac chu dao

- **UI boundary truoc, backend layering sau, side effect cuoi cung**.
- Moi buoc refactor phai co test bao ve truoc khi di chuyen code.
- Compatibility shim luon co deadline xoa ro rang.
- Moi thay doi huong den 1 use-case cu the, khong gom cuc.
