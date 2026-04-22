# 05 - Test Strategy theo layer

Dinh nghia **kim tu thap test** cho module Document Workflow Target v2. Muc tieu: test nhanh, tap trung, khong trung lap.

## 1. Kim tu thap

```
             /\
            /e2\        <- it, cham, chay CI nightly
           /----\
          /contr \      <- API contract tests (~20)
         /--------\
        /integration\   <- repo + db + file storage (~40)
       /------------\
      / application  \  <- use-case (~60)
     /----------------\
    /      domain      \ <- entity, VO, rules (~100+)
   /--------------------\
```

## 2. Theo layer

### 2.1 Domain layer - **Unit test thuan**

- Test `Document.assignTo(userId)`, `Document.moveToStep(step)`, `AccessPolicy.canReview(user, doc)`.
- Khong co DB, khong co mock phuc tap.
- Kiem tra invariants:
  - Khong chuyen buoc sai thu tu.
  - Khong publish neu chua approve.
  - Khong archive neu chua publish.
- Run: `jest --selectProjects domain` hoac `--testPathPattern=domain`.
- Target coverage: **90%+** o layer nay.

### 2.2 Application layer - **Use-case test**

- Moi use-case 1 test suite: `AssignDocumentUseCase.spec.js`.
- Mock repository (in-memory stub) va event bus.
- Kiem tra:
  - Goi dung repo.save voi aggregate sau khi apply business rules.
  - Publish dung event.
  - Xu ly loi (permission, state) tra ra error domain.
- Khong cham DB that.

### 2.3 Infrastructure layer - **Integration test**

- Repository thuc voi sqlite in-memory (`:memory:`).
- File uploader voi tmp dir.
- Mailer voi transport stub.
- Contract repo: kiem tra moi method cua interface.
- Target: it nhat 1 happy + 1 edge case moi method.

### 2.4 Interface (HTTP) layer - **Contract test**

- Dung `supertest` chay qua Express app that, voi app layer da wire.
- Moi dong trong `03-api-contract.md` co 3 case:
  - 200 happy.
  - 403 permission denied.
  - 409/422 invalid state.

### 2.5 E2E - **Smoke test workflow day du**

- Chay 1 scenario: tao -> phan cong -> draft -> review -> finalize -> submit -> approve -> publish -> archive.
- Dung Playwright hoac curl script.
- Chay nightly va truoc release.
- Target: **100% pass** truoc merge.

## 3. Frontend

### 3.1 Unit component

- Test component trong `features/document-workflow/components/*` voi React Testing Library.
- Focus: state transitions, rendering theo prop.

### 3.2 Use-case hook

- Test `use<UseCase>` voi mock API client.
- Kiem tra loading / error / success state.

### 3.3 Integration page

- Mount page voi MSW (mock service worker) stub API.
- Kiem tra luong thao tac chinh (click publish -> goi API -> hien toast).

### 3.4 E2E frontend

- Playwright, chay cung voi backend e2e smoke.

## 4. Khi nao viet test

- **Truoc khi di chuyen code** (Sprint 1-5): viet test domain + application bao ve behavior cu, refactor khong lam thay doi test.
- **Khi them event moi** (Sprint 4): viet contract test publish event.
- **Khi them use-case moi**: bat buoc viet unit test application layer.
- **Khi sua bug**: viet test reproduce bug truoc khi fix (TDD bug).

## 5. Cau hinh CI

- Chay `unit + application + integration` moi PR.
- Chay `contract + e2e smoke` moi PR vao `main` / `REFACTOR`.
- Chay full suite nightly.

## 6. Tools duoc chon

- Backend: Jest + supertest + better-sqlite3 in-memory.
- Frontend: Vitest + React Testing Library + MSW + Playwright.
- Coverage: `c8` hoac Jest built-in.

## 7. Metric can giam sat

- Tong thoi gian test suite (< 3 phut unit + application).
- Coverage domain >= 90%.
- Flaky rate e2e < 2%.
- Thoi gian e2e smoke < 5 phut.

## 8. Quy uoc dat ten file test

- `<Subject>.spec.ts` cho unit.
- `<Subject>.integration.spec.ts` cho integration.
- `<Use-case>.contract.spec.ts` cho HTTP contract.
- `<scenario>.e2e.spec.ts` cho e2e.
