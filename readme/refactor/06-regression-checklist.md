# 06 - Regression Checklist theo use-case

Checklist de chay tay (hoac automate) sau moi sprint refactor. Moi muc danh dau `[ ]` khi chua chay, `[x]` khi OK, `[!]` khi co issue.

> Mo template nay vao PR va tick theo sprint. Luu trong `readme/refactor/sprint-logs/<sprint>/regression.md`.

## Thong tin
- Sprint: ______
- Commit: ______
- Nguoi chay: ______
- Ngay: ______

## 1. Workflow BC

### 1.1 Tao ho so (Create)
- [ ] Tao voi day du truong: thanh cong.
- [ ] Tao thieu `title`: loi 400, message VN.
- [ ] User khong co role `creator`: loi 403.
- [ ] Sau tao, document o buoc 1, history co entry "Created".
- [ ] Khong co mail gui (expected).

### 1.2 Phan cong (Assign)
- [ ] Admin phan cong hop le: document chuyen buoc 2, `assigned_to` cap nhat.
- [ ] Assignee nhan duoc mail (neu rule bat).
- [ ] Phan cong lai cho nguoi khac: mail lan 2 gui toi assignee moi.
- [ ] Audit log ghi event `DocumentAssigned`.
- [ ] User khong phai admin: loi 403.

### 1.3 Soan thao (SaveDraft)
- [ ] Assignee upload file step 3: file luu `uploads/documents/<id>/step_3/`.
- [ ] Nguoi khac assignee khong upload duoc: 403.
- [ ] Ghi history "DraftSaved".

### 1.4 Review
- [ ] Reviewer approve: document chuyen buoc 5, mail ve assignee.
- [ ] Reviewer request-changes: document quay buoc 3, mail ve assignee.
- [ ] User khong phai reviewer: 403.
- [ ] Audit log ghi event.

### 1.5 Gop y (Feedback)
- [ ] Reviewer them feedback o buoc 4: feedback luu, mail gui assignee.
- [ ] Feedback hien thi o frontend timeline.

### 1.6 Hoan thien (Finalize)
- [ ] Assignee upload ban hoan thien buoc 5: chuyen buoc 6.
- [ ] Mail gui reviewer/approver theo rule.

### 1.7 Nop (Submit)
- [ ] Submit sang approver thanh cong.
- [ ] Mail gui approver.

### 1.8 Phe duyet (Approve)
- [ ] Approver approve: document chuyen buoc 8.
- [ ] Mail gui publisher.

### 1.9 Ban hanh (Publish)
- [ ] Publisher publish: document chuyen buoc 8 (hoac 9 tuy model), `published_at` set.
- [ ] Mail broadcast theo rule trong admin settings.
- [ ] Kiem toggle tat notification: KHONG co mail gui.

### 1.10 Luu tru (Archive)
- [ ] Admin archive: chuyen buoc 9.
- [ ] Khong con action sua/xoa tren UI.

### 1.11 Attachment
- [ ] Remove attachment: file xoa khoi disk hoac soft-delete record.
- [ ] Khong the remove attachment o buoc da hoan thanh.

## 2. Admin BC

### 2.1 User management
- [ ] List user co phan trang.
- [ ] Assign role: phan quyen co hieu luc ngay (reload session).
- [ ] Revoke role: phan quyen bi go.
- [ ] Audit log `UserRoleChanged` xuat hien.

### 2.2 Unit management
- [ ] CRUD unit chay day du.
- [ ] Xoa unit co ho so dang tham chieu: bi tu choi (FK constraint hoac validation).

### 2.3 Module settings
- [ ] Update setting: luu xuong DB.
- [ ] Cache invalidate (neu co).
- [ ] Audit log ghi event.

### 2.4 Audit logs
- [ ] List audit, filter theo action.
- [ ] Paging hoat dong.

### 2.5 Email rules
- [ ] Toggle rule on/off -> rule co tac dung ngay (thu bang use-case lien quan).

## 3. Frontend boundary

- [ ] `App.tsx` khong con import tu `components/admin/AdminPrimitives`.
- [ ] `App.tsx` khong con import tu `pages/admin/*`.
- [ ] CI guardrail `deprecated-import-guard` pass.
- [ ] `npm run lint` 0 error.
- [ ] `npm run build` thanh cong.

## 4. Backend boundary

- [ ] Controller workflow < 200 dong (sau sprint 5).
- [ ] Khong con goi `mailSend` truc tiep trong controller (sau sprint 4).
- [ ] `DocumentModel` khong con duoc import truc tiep ngoai repository (sau sprint 3).

## 5. Performance

- [ ] Response p95 khong ty le tang > 20% so baseline.
- [ ] Bundle size khong tang > 10% so baseline.

## 6. Rollback readiness

- [ ] Co commit revert chuan bi san cho sprint hien tai.
- [ ] Runbook rollback (`08-rollback-runbook.md`) doc lai, con chinh xac.

## 7. Ky xac nhan

- [ ] Tech lead: ______
- [ ] QA: ______
- [ ] Product owner: ______
