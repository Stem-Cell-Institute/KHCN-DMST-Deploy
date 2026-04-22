# 08 - Rollback Runbook

Runbook hanh dong khi sprint refactor gay su co production. Muc tieu: quay ve trang thai on dinh trong **< 15 phut**.

## 1. Khi nao rollback

Rollback ngay khi 1 trong cac dieu kien xuat hien sau deploy:
- Error rate `5xx` tang > 5x baseline trong 5 phut lien tuc.
- Luong workflow core (publish, assign) **fail > 10%**.
- Email khong gui duoc (kiem tra `mail_send_failure` log).
- Login / session loi hang loat.
- Admin SPA khong load duoc (white screen).

## 2. Thu tu uu tien

1. **Revert commit / tag** -> deploy lai ban truoc.
2. **Feature flag tat** (neu co) -> disable use-case moi.
3. **Khoi dong lai service** -> fix transient issue.

## 3. Quy trinh rollback theo sprint

### Sprint 0-2 (domain + application carve-out)
- Rollback: `git revert <merge-sha>` hoac `git checkout <tag truoc>` + re-deploy.
- Rui ro tom them: **thap**, chu yeu di chuyen code.

### Sprint 3 (split repositories)
- Rollback: revert + kiem tra khong co DDL thay doi. Neu co: chay migration down tuong ung.

### Sprint 4 (event bus + notification)
- Rollback: revert + dam bao **mail cu duoc goi lai** trong controller (co the can cherry-pick lai logic mail tam thoi).
- Kiem tra: sau rollback, test gui mail `assign` va `publish` on.

### Sprint 5 (slim controller)
- Rollback: revert, khong anh huong schema.

### Sprint 6-9 (frontend)
- Rollback: deploy lai bundle cu tu `dist/` duoc backup truoc moi release.
- Khong can rollback backend.

### Sprint 10 (CI guardrail + hard deprecate)
- Rollback: gan nhu khong can - chi anh huong build.

## 4. Lenh cu the

### Backend (Node + PM2 hoac systemd)
```bash
git fetch --all
git checkout <tag-truoc>
npm ci --production
pm2 restart khcn-dmst
```

### Backend (Docker)
```bash
docker pull <registry>/khcn-dmst:<tag-truoc>
docker compose up -d
```

### Frontend
```bash
cd frontend/document-workflow-ui
git checkout <tag-truoc>
npm ci
npm run build
# Restart server de backend pick up dist moi
pm2 restart khcn-dmst
```

### Database rollback
- **Ko co migration schema breaking** o Sprint 0-2, 4-9 -> khong can rollback DB.
- **Sprint 3**: neu da tach ensureSchema, bao dam migration down script ton tai.

## 5. Sau rollback

- [ ] Thong bao team trong kenh `#deploy` / `#incident`.
- [ ] Tao incident ticket: timeline, impact, root cause.
- [ ] Viet postmortem trong vong 48h.
- [ ] Cap nhat checklist nay neu thieu buoc.

## 6. Truoc moi release

- [ ] Tag git `refactor/sprint-<N>-pre-release` truoc khi merge.
- [ ] Backup `dist/` frontend vao folder `backup/frontend-dist/<date>`.
- [ ] Backup DB (snapshot file hoac Turso branch).
- [ ] Xac nhan nguoi on-call co the SSH vao server trong vong 5 phut.

## 7. Lien he khan cap

| Role | Ten | Lien he |
|---|---|---|
| On-call backend | ______ | ______ |
| On-call frontend | ______ | ______ |
| DevOps | ______ | ______ |
| Product owner | ______ | ______ |

## 8. Metric giam sat sau deploy (30 phut dau)

- Error rate 5xx, 4xx.
- Response p95 cac endpoint chinh.
- Mail delivery success rate.
- Login success rate.
- Admin SPA 200/404.

Neu 1 metric lech > 20% so baseline -> chuan bi rollback.
