# HƯỚNG DẪN TRIỂN KHAI HỆ THỐNG TRACKING HỒ SƠ

## 📌 TỔNG QUAN

Tài liệu này hướng dẫn cách triển khai hệ thống theo dõi tiến trình hồ sơ vào website SCI-ACE hiện có.

---

## 🎯 MỤC TIÊU

1. **Theo dõi real-time**: Admin/Hội đồng thấy được tiến trình từng hồ sơ
2. **Cảnh báo tự động**: Nhắc nhở khi quá hạn hoặc sắp đến hạn
3. **Báo cáo thống kê**: Dashboard tổng quan về tất cả hồ sơ
4. **Email tự động**: Thông báo đến đúng người đúng thời điểm

---

## 📁 CẤU TRÚC DATABASE

### 1. **Table: submissions**

```sql
CREATE TABLE submissions (
    id VARCHAR(50) PRIMARY KEY,           -- Mã hồ sơ (vd: #2024-045)
    title VARCHAR(500) NOT NULL,          -- Tên đề tài
    submittedBy VARCHAR(255) NOT NULL,    -- Email nghiên cứu viên
    submittedByName VARCHAR(255),         -- Họ tên
    
    -- Trạng thái tổng quan
    status ENUM(
        'DRAFT',                          -- Nháp
        'SUBMITTED',                      -- Đã nộp
        'VALIDATED',                      -- Đã kiểm tra
        'NEED_REVISION',                  -- Cần bổ sung
        'UNDER_REVIEW',                   -- Đang đánh giá
        'IN_MEETING',                     -- Đang họp
        'APPROVED',                       -- Đã phê duyệt
        'REJECTED',                       -- Không chấp thuận
        'IMPLEMENTATION',                 -- Đang thực hiện
        'COMPLETED'                       -- Hoàn thành
    ) DEFAULT 'DRAFT',
    
    -- Giai đoạn hiện tại
    currentStage INT DEFAULT 1,           -- 1-8
    
    -- Timestamps
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    submittedAt DATETIME,                 -- Ngày nộp
    validatedAt DATETIME,                 -- Ngày kiểm tra
    assignedAt DATETIME,                  -- Ngày phân công
    meetingAt DATETIME,                   -- Ngày họp
    approvedAt DATETIME,                  -- Ngày phê duyệt
    completedAt DATETIME,                 -- Ngày hoàn thành
    
    -- Người xử lý hiện tại
    currentHandler VARCHAR(255),          -- Email người đang xử lý
    currentHandlerRole ENUM('secretary', 'chair', 'reviewer', 'researcher'),
    
    -- Thời hạn
    deadline DATETIME,                    -- Thời hạn xử lý
    isOverdue BOOLEAN DEFAULT FALSE,      -- Quá hạn?
    
    -- Metadata
    notes TEXT,                           -- Ghi chú
    rejectionReason TEXT,                 -- Lý do từ chối (nếu có)
    
    INDEX idx_status (status),
    INDEX idx_stage (currentStage),
    INDEX idx_submittedBy (submittedBy),
    INDEX idx_deadline (deadline)
);
```

### 2. **Table: submission_stages**

Theo dõi chi tiết từng giai đoạn

```sql
CREATE TABLE submission_stages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    submissionId VARCHAR(50) NOT NULL,
    
    stage INT NOT NULL,                   -- 1-8
    stageName VARCHAR(100),               -- Tên giai đoạn
    status ENUM('pending', 'in_progress', 'completed', 'skipped'),
    
    startedAt DATETIME,
    completedAt DATETIME,
    completedBy VARCHAR(255),             -- Email người hoàn thành
    
    -- Thời gian dự kiến
    estimatedDays INT,                    -- Số ngày dự kiến
    actualDays INT,                       -- Số ngày thực tế
    
    notes TEXT,
    
    FOREIGN KEY (submissionId) REFERENCES submissions(id),
    INDEX idx_submission_stage (submissionId, stage)
);
```

### 3. **Table: submission_files**

Quản lý file upload

```sql
CREATE TABLE submission_files (
    id INT AUTO_INCREMENT PRIMARY KEY,
    submissionId VARCHAR(50) NOT NULL,
    
    fileType VARCHAR(50) NOT NULL,        -- 'SCI-ACE-01', 'SCI-ACE-02', etc.
    fileName VARCHAR(255) NOT NULL,
    filePath VARCHAR(500) NOT NULL,
    fileSize INT,                         -- Bytes
    
    uploadedBy VARCHAR(255) NOT NULL,
    uploadedByRole VARCHAR(50),
    uploadedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    version INT DEFAULT 1,                -- Phiên bản (nếu upload lại)
    isLatest BOOLEAN DEFAULT TRUE,
    
    stage INT,                            -- Giai đoạn nào upload
    
    FOREIGN KEY (submissionId) REFERENCES submissions(id),
    INDEX idx_submission_files (submissionId, fileType)
);
```

### 4. **Table: reviewers**

Quản lý phản biện

```sql
CREATE TABLE reviewers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    submissionId VARCHAR(50) NOT NULL,
    
    reviewerEmail VARCHAR(255) NOT NULL,
    reviewerName VARCHAR(255),
    
    assignedAt DATETIME,
    assignedBy VARCHAR(255),              -- Chủ tịch phân công
    
    deadline DATETIME,
    completedAt DATETIME,
    
    status ENUM('assigned', 'in_progress', 'completed', 'overdue'),
    
    -- Kết luận
    decision ENUM('approve', 'conditional', 'reject'),
    comments TEXT,
    
    -- File phiếu nhận xét
    reviewFileId INT,                     -- Link to submission_files
    
    FOREIGN KEY (submissionId) REFERENCES submissions(id),
    INDEX idx_reviewer (submissionId, reviewerEmail)
);
```

### 5. **Table: notifications**

Log thông báo email

```sql
CREATE TABLE notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    submissionId VARCHAR(50),
    
    type VARCHAR(50),                     -- 'submission_received', 'review_reminder', etc.
    recipient VARCHAR(255),
    subject VARCHAR(500),
    body TEXT,
    
    sentAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    status ENUM('pending', 'sent', 'failed'),
    
    INDEX idx_submission_notif (submissionId),
    INDEX idx_recipient (recipient)
);
```

### 6. **Table: activity_log**

Lịch sử thay đổi

```sql
CREATE TABLE activity_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    submissionId VARCHAR(50) NOT NULL,
    
    action VARCHAR(100),                  -- 'status_changed', 'file_uploaded', etc.
    performedBy VARCHAR(255),
    performedByRole VARCHAR(50),
    
    oldValue TEXT,
    newValue TEXT,
    
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (submissionId) REFERENCES submissions(id),
    INDEX idx_submission_log (submissionId)
);
```

---

## 🔧 API ENDPOINTS CẦN THIẾT

### **1. Quản lý hồ sơ**

```javascript
// GET /api/submissions
// Lấy danh sách hồ sơ (với filter, sort, pagination)
// Query params: ?status=UNDER_REVIEW&stage=5&page=1&limit=20

// GET /api/submissions/:id
// Xem chi tiết 1 hồ sơ

// GET /api/submissions/:id/timeline
// Lấy timeline của hồ sơ (tất cả giai đoạn + files + logs)

// PATCH /api/submissions/:id/status
// Cập nhật trạng thái
// Body: { status: 'VALIDATED', currentStage: 4, currentHandler: 'email@sci.edu.vn' }

// PATCH /api/submissions/:id/stage
// Chuyển giai đoạn
// Body: { stage: 5, notes: 'Đã phân công phản biện' }
```

### **2. Quản lý files**

```javascript
// GET /api/submissions/:id/files
// Lấy danh sách files của hồ sơ

// GET /api/submissions/:id/files/required
// Kiểm tra files còn thiếu theo giai đoạn hiện tại

// POST /api/submissions/:id/files
// Upload file
// Body: FormData with file + fileType + stage

// GET /api/files/:fileId/download
// Tải file
```

### **3. Quản lý phản biện**

```javascript
// POST /api/submissions/:id/reviewers
// Phân công phản biện
// Body: { reviewerEmail: 'abc@sci.edu.vn', deadline: '2026-02-15' }

// GET /api/submissions/:id/reviewers
// Lấy danh sách phản biện

// PATCH /api/reviewers/:reviewerId
// Cập nhật trạng thái phản biện
// Body: { status: 'completed', decision: 'approve', reviewFileId: 123 }

// POST /api/reviewers/:reviewerId/remind
// Gửi email nhắc nhở
```

### **4. Dashboard & Thống kê**

```javascript
// GET /api/dashboard/stats
// Thống kê tổng quan
// Response: { total, pending, overdue, completed, avgProcessTime }

// GET /api/dashboard/by-status
// Thống kê theo trạng thái

// GET /api/dashboard/by-stage
// Thống kê theo giai đoạn

// GET /api/dashboard/overdue
// Danh sách hồ sơ quá hạn

// GET /api/dashboard/upcoming-deadlines
// Danh sách sắp đến hạn
```

### **5. Thông báo**

```javascript
// GET /api/notifications
// Lấy thông báo của user

// POST /api/notifications/send
// Gửi email thủ công
// Body: { submissionId, type, recipient, subject, body }
```

---

## 🖥️ GIAO DIỆN DASHBOARD

### **1. Trang Dashboard chính** (`/dashboard` hoặc `/quan-tri.html`)

#### Layout:

```
┌─────────────────────────────────────────────────────────────┐
│  📊 DASHBOARD QUẢN LÝ HỒ SƠ ĐẠO ĐỨC                         │
├─────────────────────────────────────────────────────────────┤
│  📈 Thống kê:  Tổng: 45  |  Chờ xử lý: 12  |  Quá hạn: 3   │
├─────────────────────────────────────────────────────────────┤
│  [Tab: Tất cả] [Tab: Quá hạn 🔴] [Tab: Đang xử lý]         │
│                                                              │
│  🔍 [Tìm kiếm...] [Filter: Trạng thái ▾] [Sort: Ngày ▾]   │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 🔴 #2024-045 - Nghiên cứu tế bào gốc chuột           │  │
│  │ 📍 Giai đoạn 5: Chờ phản biện (2/2)                  │  │
│  │ ⏰ QUÁ HẠN 2 ngày - TS. Trần Văn C chưa nộp          │  │
│  │ [Nhắc nhở] [Xem chi tiết]                            │  │
│  └──────────────────────────────────────────────────────┘  │
│  ...                                                         │
└─────────────────────────────────────────────────────────────┘
```

#### Code mẫu (HTML + JS):

```html
<!-- dashboard.html -->
<div id="dashboard-container">
    <!-- Stats Cards -->
    <div class="stats-grid">
        <div class="stat-card">
            <div class="stat-number" id="total-count">45</div>
            <div class="stat-label">Tổng hồ sơ</div>
        </div>
        <div class="stat-card warning">
            <div class="stat-number" id="pending-count">12</div>
            <div class="stat-label">Chờ xử lý</div>
        </div>
        <div class="stat-card danger">
            <div class="stat-number" id="overdue-count">3</div>
            <div class="stat-label">Quá hạn</div>
        </div>
        <div class="stat-card success">
            <div class="stat-number" id="completed-count">8</div>
            <div class="stat-label">Hoàn thành (tháng này)</div>
        </div>
    </div>

    <!-- Filters -->
    <div class="filters">
        <input type="text" id="search" placeholder="🔍 Tìm kiếm theo mã HS, tên đề tài...">
        <select id="filter-status">
            <option value="">Tất cả trạng thái</option>
            <option value="UNDER_REVIEW">Đang đánh giá</option>
            <option value="IN_MEETING">Đang họp</option>
            <!-- ... -->
        </select>
        <select id="filter-stage">
            <option value="">Tất cả giai đoạn</option>
            <option value="5">Giai đoạn 5</option>
            <!-- ... -->
        </select>
    </div>

    <!-- Submissions List -->
    <div id="submissions-list"></div>
</div>

<script>
async function loadDashboard() {
    // Load stats
    const stats = await fetch('/api/dashboard/stats').then(r => r.json());
    document.getElementById('total-count').textContent = stats.total;
    document.getElementById('pending-count').textContent = stats.pending;
    document.getElementById('overdue-count').textContent = stats.overdue;
    document.getElementById('completed-count').textContent = stats.completedThisMonth;

    // Load submissions
    const submissions = await fetch('/api/submissions?sort=-deadline').then(r => r.json());
    renderSubmissions(submissions);
}

function renderSubmissions(submissions) {
    const container = document.getElementById('submissions-list');
    container.innerHTML = submissions.map(s => `
        <div class="submission-card ${s.isOverdue ? 'overdue' : ''}">
            <div class="submission-header">
                <h4>${s.id} - ${s.title}</h4>
                <span class="badge badge-${s.status.toLowerCase()}">${getStatusText(s.status)}</span>
            </div>
            <div class="submission-body">
                <p>📍 Giai đoạn ${s.currentStage}: ${getStageText(s.currentStage)}</p>
                <p>👤 Nghiên cứu viên: ${s.submittedByName} (${s.submittedBy})</p>
                ${s.isOverdue ? `<p class="overdue-text">⏰ QUÁ HẠN ${getDaysOverdue(s.deadline)} ngày</p>` : ''}
                ${s.deadline ? `<p>⏰ Hạn xử lý: ${formatDate(s.deadline)}</p>` : ''}
            </div>
            <div class="submission-actions">
                <button onclick="viewDetail('${s.id}')">Xem chi tiết</button>
                ${s.isOverdue ? `<button onclick="sendReminder('${s.id}')">Gửi nhắc nhở</button>` : ''}
            </div>
        </div>
    `).join('');
}

loadDashboard();
</script>
```

### **2. Trang chi tiết hồ sơ** (`/submissions/:id`)

#### Layout:

```
┌─────────────────────────────────────────────────────────────┐
│  ← Quay lại Dashboard                                       │
├─────────────────────────────────────────────────────────────┤
│  HỒ SƠ #2024-048: Nghiên cứu enzyme gan chuột              │
│  Nghiên cứu viên: nguyenvana@sci.edu.vn                    │
│  Ngày nộp: 15/01/2026                                      │
├─────────────────────────────────────────────────────────────┤
│  [Tab: Timeline] [Tab: Files] [Tab: Logs]                  │
│                                                              │
│  TIMELINE:                                                   │
│  ✅ GĐ1: Chuẩn bị hồ sơ (14/01)                            │
│  ✅ GĐ2: Nộp hồ sơ (15/01)                                 │
│  ✅ GĐ3: Kiểm tra (17/01) - Thư ký Nguyễn Thị X            │
│  ✅ GĐ4: Phân công (18/01) - Chủ tịch                      │
│  ⏳ GĐ5: Đánh giá (50%)                                     │
│      ✅ PGS.TS. Nguyễn Thị B (20/01)                       │
│      ⏳ TS. Trần Văn C (Còn 5 ngày)                         │
│  ⬜ GĐ6: Họp Hội đồng                                       │
│  ⬜ GĐ7: Cấp Quyết định                                      │
│  ⬜ GĐ8: Thực hiện                                          │
└─────────────────────────────────────────────────────────────┘
```

#### Code mẫu:

```html
<div id="submission-detail">
    <div class="breadcrumb">
        <a href="/dashboard">← Quay lại Dashboard</a>
    </div>
    
    <div class="submission-header">
        <h2 id="submission-title"></h2>
        <span class="status-badge" id="status-badge"></span>
    </div>

    <div class="tabs">
        <button class="tab active" onclick="showTab('timeline')">Timeline</button>
        <button class="tab" onclick="showTab('files')">Files</button>
        <button class="tab" onclick="showTab('logs')">Activity Log</button>
    </div>

    <div id="tab-timeline" class="tab-content active">
        <div id="timeline-container"></div>
    </div>

    <div id="tab-files" class="tab-content">
        <div id="files-container"></div>
    </div>

    <div id="tab-logs" class="tab-content">
        <div id="logs-container"></div>
    </div>
</div>

<script>
async function loadSubmissionDetail(id) {
    const data = await fetch(`/api/submissions/${id}/timeline`).then(r => r.json());
    
    document.getElementById('submission-title').textContent = 
        `${data.id}: ${data.title}`;
    document.getElementById('status-badge').textContent = 
        getStatusText(data.status);
    
    renderTimeline(data.stages);
    renderFiles(data.files);
    renderLogs(data.logs);
}

function renderTimeline(stages) {
    const container = document.getElementById('timeline-container');
    container.innerHTML = stages.map(stage => {
        const icon = stage.status === 'completed' ? '✅' : 
                    stage.status === 'in_progress' ? '⏳' : '⬜';
        return `
            <div class="timeline-item ${stage.status}">
                <div class="timeline-marker">${icon}</div>
                <div class="timeline-content">
                    <h4>GĐ${stage.stage}: ${stage.stageName}</h4>
                    ${stage.completedAt ? `<p>✓ Hoàn thành: ${formatDate(stage.completedAt)}</p>` : ''}
                    ${stage.notes ? `<p>${stage.notes}</p>` : ''}
                    ${renderStageDetails(stage)}
                </div>
            </div>
        `;
    }).join('');
}

function renderStageDetails(stage) {
    // Hiển thị chi tiết riêng cho từng giai đoạn
    if (stage.stage === 5 && stage.reviewers) {
        return stage.reviewers.map(r => `
            <div class="reviewer-item">
                ${r.status === 'completed' ? '✅' : '⏳'} ${r.reviewerName}
                ${r.completedAt ? `(${formatDate(r.completedAt)})` : `(Còn ${getDaysLeft(r.deadline)} ngày)`}
            </div>
        `).join('');
    }
    return '';
}
</script>
```

---

## 📧 HỆ THỐNG EMAIL TỰ ĐỘNG

### **Trigger Events:**

1. **Khi nghiên cứu viên nộp hồ sơ (GĐ2)**
   - Gửi đến: Nghiên cứu viên (xác nhận)
   - Gửi đến: Thư ký (thông báo có hồ sơ mới)

2. **Khi Thư ký kiểm tra xong (GĐ3)**
   - Nếu hợp lệ → Gửi đến: Chủ tịch (yêu cầu phân công)
   - Nếu thiếu → Gửi đến: Nghiên cứu viên (yêu cầu bổ sung)

3. **Khi Chủ tịch phân công (GĐ4)**
   - Gửi đến: Các phản biện được chọn (kèm file hồ sơ)
   - Gửi đến: Thư ký (để theo dõi)

4. **Nhắc nhở phản biện (GĐ5)**
   - Trước hạn 2 ngày: Email nhắc lần 1
   - Quá hạn 1 ngày: Email nhắc lần 2
   - Quá hạn 3 ngày: Email nhắc lần 3 + CC Chủ tịch

5. **Khi đủ phản biện (GĐ5→6)**
   - Gửi đến: Chủ tịch (lên lịch họp)
   - Gửi đến: Toàn thể Hội đồng (thông báo lịch họp)

6. **Sau họp (GĐ6→7)**
   - Nếu chấp thuận → Gửi đến: Chủ tịch (cấp QĐ)
   - Nếu có điều kiện → Gửi đến: Nghiên cứu viên (yêu cầu sửa)
   - Nếu từ chối → Gửi đến: Nghiên cứu viên (thông báo kết quả)

7. **Khi cấp Quyết định (GĐ7)**
   - Gửi đến: Nghiên cứu viên (kèm file QĐ)
   - Gửi đến: Thư ký (lưu trữ)

8. **Nhắc báo cáo định kỳ (GĐ8)**
   - Trước hạn 7 ngày: Email nhắc
   - Quá hạn: Email nhắc + CC Chủ tịch

### **Code mẫu Email Service:**

```javascript
// emailService.js
const nodemailer = require('nodemailer');

const templates = {
    submission_received: {
        subject: '[SCI-ACE] Đã nhận hồ sơ {submissionId}',
        body: `
Kính gửi {recipientName},

Hệ thống đã nhận được hồ sơ xét duyệt đạo đức của bạn.

Mã hồ sơ: {submissionId}
Tên đề tài: {title}
Ngày nộp: {submittedAt}

Hồ sơ của bạn sẽ được Thư ký Hội đồng kiểm tra trong vòng 3 ngày làm việc.

Trân trọng,
Hệ thống SCI-ACE
        `
    },
    
    review_assigned: {
        subject: '[SCI-ACE] Yêu cầu phản biện hồ sơ {submissionId}',
        body: `
Kính gửi {recipientName},

Bạn được phân công phản biện hồ sơ xét duyệt đạo đức:

Mã hồ sơ: {submissionId}
Tên đề tài: {title}
Nghiên cứu viên: {submittedByName}

Thời hạn hoàn thành: {deadline}

Vui lòng đánh giá và upload phiếu nhận xét SCI-ACE-PĐG trước thời hạn.

[Truy cập hệ thống] [Tải hồ sơ]

Trân trọng,
        `
    },
    
    review_reminder: {
        subject: '[SCI-ACE] Nhắc nhở: Đánh giá hồ sơ {submissionId}',
        body: `
Kính gửi {recipientName},

Bạn được phân công phản biện hồ sơ {submissionId}.

Thời hạn: {deadline} ({daysLeft} ngày)

Vui lòng hoàn thành đánh giá để Hội đồng có thể tiến hành họp thẩm định.

[Truy cập hệ thống]

Trân trọng,
        `
    },
    
    decision_approved: {
        subject: '[SCI-ACE] ✅ Đề nghị đã được chấp thuận - QĐ {decisionNumber}',
        body: `
Kính gửi {recipientName},

Hội đồng Đạo đức đã CHẤP THUẬN đề nghị của bạn.

Số Quyết định: {decisionNumber}
Có hiệu lực từ: {effectiveFrom} đến {effectiveTo}

Bạn có thể tải Quyết định (2 phiên bản) tại hệ thống.

LƯU Ý:
- Báo cáo định kỳ 6 tháng/lần
- Mọi thay đổi phải được phê duyệt trước

[Tải Quyết định tiếng Việt] [Tải Decision (English)]

Trân trọng,
Chủ tịch Hội đồng
        `
    }
};

async function sendEmail(type, submissionData, recipientEmail) {
    const template = templates[type];
    const subject = interpolate(template.subject, submissionData);
    const body = interpolate(template.body, submissionData);
    
    // Send email using nodemailer
    // ...
    
    // Log notification
    await logNotification({
        submissionId: submissionData.id,
        type,
        recipient: recipientEmail,
        subject,
        body,
        status: 'sent'
    });
}

function interpolate(str, data) {
    return str.replace(/{(\w+)}/g, (match, key) => data[key] || match);
}
```

---

## ⏰ HỆ THỐNG CRON JOBS

Chạy định kỳ để kiểm tra và gửi nhắc nhở

```javascript
// cronJobs.js
const cron = require('node-cron');

// Chạy mỗi ngày lúc 9h sáng
cron.schedule('0 9 * * *', async () => {
    console.log('Checking overdue submissions...');
    
    // 1. Kiểm tra hồ sơ quá hạn
    const overdue = await checkOverdueSubmissions();
    for (const sub of overdue) {
        await sendOverdueReminder(sub);
    }
    
    // 2. Kiểm tra phản biện sắp đến hạn
    const upcomingReviews = await checkUpcomingReviewDeadlines();
    for (const review of upcomingReviews) {
        if (review.daysLeft === 2) {
            await sendReviewReminder(review);
        }
    }
    
    // 3. Kiểm tra báo cáo định kỳ sắp đến hạn
    const upcomingReports = await checkUpcomingReportDeadlines();
    for (const report of upcomingReports) {
        if (report.daysLeft === 7) {
            await sendReportReminder(report);
        }
    }
});

async function checkOverdueSubmissions() {
    return await db.query(`
        SELECT * FROM submissions 
        WHERE deadline < NOW() 
        AND status NOT IN ('APPROVED', 'REJECTED', 'COMPLETED')
    `);
}

async function checkUpcomingReviewDeadlines() {
    return await db.query(`
        SELECT r.*, s.title, s.id as submissionId
        FROM reviewers r
        JOIN submissions s ON r.submissionId = s.id
        WHERE r.status = 'assigned'
        AND DATEDIFF(r.deadline, NOW()) <= 2
        AND DATEDIFF(r.deadline, NOW()) >= 0
    `);
}
```

---

## 📊 DASHBOARD WIDGETS

### **1. Biểu đồ thống kê**

```html
<!-- Chart.js hoặc Recharts -->
<canvas id="statusChart"></canvas>
<script>
const ctx = document.getElementById('statusChart').getContext('2d');
const chart = new Chart(ctx, {
    type: 'pie',
    data: {
        labels: ['Nháp', 'Đã nộp', 'Đang đánh giá', 'Đã phê duyệt', 'Từ chối'],
        datasets: [{
            data: [5, 8, 12, 15, 1],
            backgroundColor: ['#9E9E9E', '#2196F3', '#FF9800', '#4CAF50', '#F44336']
        }]
    }
});
</script>
```

### **2. Progress Bar cho từng hồ sơ**

```html
<div class="progress-bar">
    <div class="progress-fill" style="width: 62.5%">
        Giai đoạn 5/8 (62.5%)
    </div>
</div>
```

### **3. Calendar View cho lịch họp**

```html
<!-- FullCalendar.js -->
<div id="calendar"></div>
<script>
const calendar = new FullCalendar.Calendar(calendarEl, {
    events: [
        {
            title: 'Họp HĐ - HS #2024-045',
            start: '2026-01-28',
            color: '#1A4D2E'
        }
    ]
});
</script>
```

---

## 🔐 PHÂN QUYỀN TRUY CẬP

### **Matrix quyền:**

| Chức năng | Nghiên cứu viên | Thư ký | Thành viên HĐ | Chủ tịch | Admin |
|-----------|----------------|--------|---------------|----------|-------|
| Xem hồ sơ của mình | ✅ | - | - | - | ✅ |
| Xem tất cả hồ sơ | - | ✅ | ✅ | ✅ | ✅ |
| Nộp/sửa hồ sơ | ✅ | - | - | - | - |
| Kiểm tra hồ sơ | - | ✅ | - | - | ✅ |
| Phân công phản biện | - | - | - | ✅ | ✅ |
| Đánh giá hồ sơ | - | - | ✅ | ✅ | - |
| Cấp Quyết định | - | - | - | ✅ | ✅ |
| Xóa hồ sơ | - | - | - | - | ✅ |
| Xem Dashboard | - | ✅ | ✅ | ✅ | ✅ |
| Xuất báo cáo | - | ✅ | - | ✅ | ✅ |

---

## 🚀 TRIỂN KHAI

### **Bước 1: Cập nhật Database**

```bash
# Chạy migration
node scripts/migrate-database.js
```

### **Bước 2: Cài đặt dependencies**

```bash
npm install nodemailer node-cron chart.js
```

### **Bước 3: Cấu hình Email**

```javascript
// config/email.js
module.exports = {
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
};
```

### **Bước 4: Deploy**

```bash
# Build frontend
npm run build

# Start backend
npm start

# Start cron jobs
node cronJobs.js &
```

---

## 📱 RESPONSIVE DESIGN

Dashboard cần responsive cho mobile:

```css
/* Mobile first */
.submission-card {
    padding: 1rem;
    margin-bottom: 1rem;
}

@media (min-width: 768px) {
    .stats-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 1rem;
    }
}
```

---

## 📖 TÀI LIỆU THAM KHẢO

- [Chart.js Documentation](https://www.chartjs.org/)
- [Nodemailer Guide](https://nodemailer.com/)
- [Node-cron Usage](https://www.npmjs.com/package/node-cron)
- [MySQL Index Optimization](https://dev.mysql.com/doc/)

---

*Hướng dẫn này có thể được điều chỉnh theo stack công nghệ cụ thể của dự án.*

**Phiên bản:** 1.0  
**Cập nhật:** 03/02/2026
