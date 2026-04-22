# 12 - Sprint Tracker Template

Copy template nay vao `readme/refactor/sprint-logs/<sprint-number>/tracker.md` khi bat dau sprint. Cap nhat hang ngay.

## Sprint <N> - <Ten sprint>

- **Thoi gian**: YYYY-MM-DD -> YYYY-MM-DD
- **Muc tieu**: (1 cau)
- **Tech lead**: ______
- **Contributors**: ______

## 1. Goal

<Mo ta 2-3 cau: sprint nay se mang target architecture tu trang thai A sang trang thai B.>

## 2. Story / Task

| # | Task | Owner | Status | PR |
|---|---|---|---|---|
| 1 | | | todo / doing / done | |
| 2 | | | | |
| 3 | | | | |

## 3. Definition of Done

Thay bang DoD cua sprint cu the. Vi du Sprint 2:

- [ ] Application service co du 8 method (assign, saveDraft, review, addFeedback, finalize, submit, publish, archive).
- [ ] Controller chi parse + goi service + serialize.
- [ ] Unit test use-case pass 100%.
- [ ] Contract test HTTP pass.
- [ ] CI guardrail xanh.
- [ ] Regression checklist ticked (file trong sprint-logs).
- [ ] Tai lieu cap nhat (API contract, glossary neu can).

## 4. Risk tracking

| Risk | Mitigation | Status |
|---|---|---|
| | | |

## 5. Daily log

### YYYY-MM-DD
- <Ten>: <cong viec hom nay / blocker>

### YYYY-MM-DD
- ...

## 6. Metrics (cuoi sprint)

| Metric | Truoc | Sau | Delta |
|---|---|---|---|
| Controller LOC | | | |
| DocumentModel LOC | | | |
| Bundle size | | | |
| Test coverage | | | |
| Lint warning | | | |

## 7. Retrospective (cuoi sprint)

- **Lam tot**: 
- **Can cai thien**: 
- **Quyet dinh rut kinh nghiem**: 

## 8. Artifacts

- [ ] Tag git `refactor/sprint-<N>-done`
- [ ] Regression log: `readme/refactor/sprint-logs/<N>/regression.md`
- [ ] Release notes: `readme/refactor/sprint-logs/<N>/release-notes.md`
- [ ] Postmortem (neu co incident): `readme/refactor/sprint-logs/<N>/postmortem.md`
- [ ] ADR moi (neu co): `readme/refactor/adr/NNNN-*.md`

## 9. Link

- Epic tracker: <jira/github-project-url>
- Target architecture: `readme/document-workflow-target-architecture-v2.md`
- Next sprint: `readme/refactor/sprint-logs/<N+1>/tracker.md`
