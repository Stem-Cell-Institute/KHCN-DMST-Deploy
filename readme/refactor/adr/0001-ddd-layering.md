# ADR-0001: Chon DDD layering cho module Document Workflow

- **Status**: Accepted
- **Ngay**: 2026-04-22
- **Bounded Context**: All

## Boi canh

Module `document-workflow` dang o dang "fat controller + monolithic model": logic nghiep vu, query DB, side effect (mail, audit) dan xen trong controller va `DocumentModel`. Kho test, kho mo rong, kho tach mail ra.

## Lua chon xem xet

1. **Tiep tuc hien trang** - khong refactor, chap nhan no ky thuat.
2. **MVC truyen thong** - Controller / Service / Model, nhung khong tach bounded context, khong co domain layer.
3. **DDD 3 layer** (`domain` / `application` / `infrastructure`) + interfaces - ro rang BC, de test, cach lap side effect.
4. **Clean Architecture** day du - them use-case, input/output port ro rang, chi phi cao.

## Quyet dinh

Chon Option 3 (DDD 3 layer) lam target. Clean Architecture (Option 4) la hop ly nhung chi phi di chuyen cao hon muc can thiet o quy mo hien tai.

Layering chuan:

```
interfaces/ (adapters, HTTP controllers)
application/ (use-cases, services, event bus, notification handler)
domain/ (aggregate, VO, events, business rules)
infrastructure/ (repository, mailer, uploader, DB adapter)
```

## He qua

- **Tich cuc**: test domain khong can DB; side effect kiem soat bang event bus; bounded context ro rang; on-boarding developer de hon.
- **Tieu cuc**: tang so folder / file; doi ki nang team voi DDD; can thoi gian di chuyen (~12 sprint).
- **Tac dong team**: can buoi training ngan ve DDD basics, cap nhat contributor guide.

## Thuc thi

- Migration map: xem `document-workflow-target-architecture-v2.md`.
- Guardrail: `no-restricted-imports` chan path cu sau khi da tach.

## Danh gia lai

Sau Sprint 5 (khi controller slim va event bus da live), re-evaluate xem co can upgrade sang Clean Architecture full hay khong.
