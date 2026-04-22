<!--
  PR template cho repo KHCN-DMST.
  Phan "DDD Refactor Checklist" bat buoc tick du [x] de CI job `pr-checklist` pass.
  Nếu PR KHÔNG cham vao module document-workflow, van co the tick [x] nhu placeholder.
-->

## Ngu canh

- Module:
- Sprint tham chieu (neu co):
- Lien ket su co / yeu cau:

## Thay doi chinh

-

## DDD Refactor Checklist (bat buoc)

- [ ] Backend: mailSend duoc publish qua event bus
- [ ] Backend: khong import DocumentModel ngoai repository
- [ ] Frontend: khong import `@/components/admin/AdminPrimitives`
- [ ] Frontend: `npm run build` xanh
- [ ] Frontend: `npm run lint` xanh

## Test plan

- [ ] Unit tests
- [ ] Integration / smoke tests
- [ ] Manual regression theo `readme/refactor/06-regression-checklist.md`

## Rollback plan

- Link rollback runbook: `readme/refactor/08-rollback-runbook.md`
- Chien luoc rollback neu su co:

## Ghi chu them

-
