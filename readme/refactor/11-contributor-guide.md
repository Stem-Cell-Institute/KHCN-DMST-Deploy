# 11 - Contributor Guide (Onboarding DDD v2)

Huong dan cho developer moi hoac developer cu chuyen sang working tren target architecture.

## 1. Tu duy DDD trong 5 phut

- **Bounded Context (BC)**: 1 "the gioi" ngu nghia (Workflow, Admin, Catalog, Notification). Tu vung va rule bounded trong chinh BC do.
- **Aggregate**: cum doi tuong thay doi cung nhau, co `root` (vi du `Document`).
- **Use-case**: 1 hanh dong nguoi dung (AssignDocument). 1 use-case = 1 application service method.
- **Domain event**: su kien **da xay ra** (DocumentPublished). Handler lang nghe de gui mail, audit.
- **Repository**: cong truy cap aggregate vao DB.

## 2. Quy tac coding

### 2.1 Backend

1. **Don't touch DocumentModel directly** (sau sprint 3). Luon qua repository cua BC.
2. **Don't put logic in controller**. Controller chi:
   - Parse DTO.
   - Goi application service.
   - Serialize response.
3. **Don't call mailSend / audit directly** trong use-case. Phat event, handler xu ly.
4. **Don't reach across BC** bang cach import thang. Neu can user info o Workflow, goi qua interface `UserDirectory`.

### 2.2 Frontend

1. **Don't import tu `components/admin/AdminPrimitives`** (bi lint chan).
2. **Don't import tu `pages/admin/*`** (bi lint chan).
3. **Dat component moi o dau?**
   - Generic UI (DataTable, Dialog...) -> `shared/ui/*`.
   - Admin-specific -> `features/document-workflow/admin/components/*`.
   - Workflow-specific -> `features/document-workflow/components/*`.
4. **API call?** -> dung hook trong `features/document-workflow/use-cases/*`. Khong goi `axios` truc tiep trong component.

## 3. Quy trinh them use-case moi

1. Dinh nghia trong `03-api-contract.md` (endpoint, role, event).
2. Dinh nghia event trong `04-event-catalog.md` (neu co).
3. Backend:
   - Them use-case class vao `application/document/use-cases/<UseCase>.js`.
   - Neu can business rule moi -> them vao domain aggregate.
   - Neu can DB access moi -> them method vao repository tuong ung.
   - Mount route trong `documentWorkflowRoutes.js`.
4. Frontend:
   - Them API call vao `features/document-workflow/use-cases/*Api.ts`.
   - Them hook `use<UseCase>` neu can state.
   - Them UI trong `features/document-workflow/components/*`.
5. Test:
   - Unit test domain (neu them rule).
   - Unit test use-case (mock repo + bus).
   - Contract test HTTP.
6. Cap nhat `02-glossary.md` neu co thuat ngu moi.

## 4. Quy trinh sua bug

1. Viet test reproduce bug (ideally unit test o domain / application).
2. Fix.
3. Chay regression checklist muc tuong ung.
4. Ghi ro trong PR: bug -> fix -> test.

## 5. Local dev

```bash
# Backend
npm install
npm start  # http://localhost:3000

# Frontend (dev)
cd frontend/document-workflow-ui
npm install
npm run dev  # http://localhost:5173

# Frontend (build production)
npm run build
```

## 6. Run test

```bash
# Backend
npm test

# Frontend
cd frontend/document-workflow-ui
npm run lint
npm test
npx playwright test
```

## 7. Commit convention

- `feat(workflow): add publish use-case`
- `fix(admin): role revoke not clearing session`
- `refactor(workflow): extract DocumentRepository`
- `docs(refactor): update event catalog`
- `chore(ci): enable deprecated-import-guard`

## 8. Khi nao ask for help

- Khong ro use-case thuoc BC nao -> hoi tech lead, cap nhat ADR.
- Can them bang DB -> hoi DBA + tao ADR.
- Can them event -> review voi nhom notification de khong trung.

## 9. Tai lieu bat buoc doc

- `readme/refactor/README.md` (chi muc)
- `readme/refactor/02-glossary.md`
- `readme/document-workflow-target-architecture-v2.md`
- `readme/refactor/adr/` (it nhat ADR-0001, 0002, 0003)
- `readme/refactor/11-contributor-guide.md` (tai lieu nay)

## 10. Sai lam thuong gap

- ~~Them method vao `DocumentModel` cho tien~~ -> phai vao repository.
- ~~Gui mail trong controller de nhanh~~ -> phai qua event.
- ~~Import tu `pages/admin/*` vi quen~~ -> CI se chan.
- ~~Copy code tu 1 page sang page khac~~ -> chiet ra `features/*/components` hoac `shared/ui`.
- ~~Bypass use-case goi thang repo tu controller~~ -> luon qua application service.
