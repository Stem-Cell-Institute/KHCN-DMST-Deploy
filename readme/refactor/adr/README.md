# ADR Index - Document Workflow Refactor

Cac quyet dinh kien truc cho du an refactor. Moi ADR mo ta **bai toan, lua chon, ly do, he qua**.

## Danh sach

| # | Tieu de | Status | Ngay |
|---|---|---|---|
| 0001 | [Chon DDD layering cho module](./0001-ddd-layering.md) | Accepted | 2026-04-22 |
| 0002 | [In-process Domain Event Bus](./0002-in-process-event-bus.md) | Accepted | 2026-04-22 |
| 0003 | [Split DocumentModel theo Bounded Context](./0003-split-repositories.md) | Accepted | 2026-04-22 |

## Status life-cycle

- `Proposed` -> `Accepted` / `Rejected` -> `Superseded` (khi co ADR moi thay the).

## Khi nao viet ADR moi

- Thay doi pattern kien truc (DI, event bus, persistence).
- Thay doi bounded context (them/bot/nhap).
- Chon technology moi (thay multer, thay sqlite).
- Thay doi quy uoc API (versioning, error envelope).

Copy [_template.md](./_template.md) khi tao ADR moi. Dat ten `NNNN-<slug>.md` voi NNNN la so thu tu tiep theo.
