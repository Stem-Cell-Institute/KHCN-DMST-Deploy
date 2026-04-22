# ADR-0002: In-process Domain Event Bus

- **Status**: Accepted
- **Ngay**: 2026-04-22
- **Bounded Context**: Workflow, Notification, Admin (cross-cutting)

## Boi canh

Side effect sau mot hanh dong workflow (gui mail, ghi audit log) hien goi truc tiep trong controller. Dieu nay gay:
- Controller phu thuoc vao mail + audit.
- Kho test, kho disable.
- Kho mo rong them handler moi (vi du push notification, re-index search).

Can 1 co che de decouple side effect khoi use-case chinh.

## Lua chon xem xet

1. **Goi truc tiep (hien trang)** - don gian nhat, nhung coupling cao.
2. **In-process EventBus** - 1 object pub/sub trong cung Node process, subscribe o composition root.
3. **External message broker** (RabbitMQ, Kafka) - manh, nhung overkill voi quy mo hien tai (1 server, vai chuc user / phut), them chi phi van hanh.
4. **Node EventEmitter native** - don gian nhung khong co semantic domain event (payload schema, correlationId, ...).

## Quyet dinh

Chon Option 2 (in-process bus custom). Dat tai `application/events/DomainEventBus.js`:
- API: `publish(event)`, `subscribe(type, handler)`.
- Handler chay async, try/catch, log.
- Event tuan theo schema trong `04-event-catalog.md`.

Neu sau nay nhu cau tang (multi-instance, retry, dead-letter), co the swap implementation sang broker ma khong thay doi su dung tai use-case.

## He qua

- **Tich cuc**: decouple side effect, de them handler moi, de mock khi test.
- **Tieu cuc**: khong durable - neu process crash giua chung, event co the mat; khong cross-process.
- **Tac dong team**: developer can hieu event-driven, can guideline handler idempotent.

## Thuc thi

- Sprint 4 trong migration map.
- Contract test: mock bus, kiem tra event duoc publish dung voi payload dung.

## Danh gia lai

Neu di qua multi-instance (Turso + nhieu Node) -> xem xet nang cap Option 3.
