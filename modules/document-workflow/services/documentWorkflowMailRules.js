/**
 * Cấu hình bật/tắt email theo tình huống (module quy trình văn bản nội bộ).
 * Đồng bộ với logic trong documentWorkflowController.js (safeSendMail).
 */

const DEFAULT_EMAIL_NOTIFICATION_TOGGLES = {
  proposal_created: {
    enabled: true,
    module_managers: true,
    master_admins: false,
  },
  assignment: {
    enabled: true,
    assigned_drafter: true,
    cc_module_managers: true,
    cc_master_admins: false,
  },
  draft_step3_complete: {
    enabled: true,
    module_managers: true,
    master_admins: false,
  },
  review_rejected: {
    enabled: true,
    assigned_drafter: true,
  },
  review_approved_step5: {
    enabled: true,
    module_managers: true,
    assigned_drafter: true,
    broad_role_users: true,
    master_admins: false,
  },
  feedback_added: {
    enabled: true,
    module_managers: true,
    master_admins: false,
  },
  finalize_step6: {
    enabled: true,
    module_managers: true,
    master_admins: false,
  },
  submit_step7: {
    enabled: true,
    module_managers: true,
    master_admins: false,
  },
  published: {
    enabled: true,
    all_registered_emails: true,
  },
  archived: {
    enabled: true,
    module_managers: true,
    master_admins: false,
  },
};

/** Mô tả hiển thị trong Admin (tiếng Việt) */
const EMAIL_EVENT_CATALOG = [
  {
    key: 'proposal_created',
    title: 'Hồ sơ mới (bước 1)',
    when: 'Người đề xuất tạo hồ sơ mới.',
    recipientsNote: 'Workflow Manager (role module_manager). Có thể bật thêm Master Admin.',
  },
  {
    key: 'assignment',
    title: 'Phân công soạn thảo (bước 2)',
    when: 'Lãnh đạo đơn vị phân công người soạn thảo.',
    recipientsNote:
      'Người được phân công (soạn thảo); CC: Workflow Manager và tùy chọn Master Admin.',
  },
  {
    key: 'draft_step3_complete',
    title: 'Hoàn tất dự thảo bước 3',
    when: 'Người soạn thảo nộp dự thảo và chuyển bước 4.',
    recipientsNote: 'Workflow Manager (theo dõi tiến độ).',
  },
  {
    key: 'review_rejected',
    title: 'Từ chối thẩm định (bước 4)',
    when: 'Người thẩm định chọn từ chối.',
    recipientsNote: 'Email tới người được phân công soạn thảo.',
  },
  {
    key: 'review_approved_step5',
    title: 'Đạt thẩm định → bước 5',
    when: 'Người thẩm định duyệt, chuyển sang lấy ý kiến góp ý.',
    recipientsNote:
      'Theo cấu hình “Chế độ người nhận bước 5” (Workflow Manager + người soạn thảo, hoặc mở rộng Drafter/Leader/Reviewer). Có thể tắt từng nhóm.',
  },
  {
    key: 'feedback_added',
    title: 'Có góp ý mới (bước 5)',
    when: 'Thêm nội dung góp ý, chuyển bước 6.',
    recipientsNote: 'Workflow Manager.',
  },
  {
    key: 'finalize_step6',
    title: 'Hoàn thiện sau góp ý (bước 6)',
    when: 'Người soạn thảo hoàn thiện dự thảo và file đính kèm.',
    recipientsNote: 'Workflow Manager.',
  },
  {
    key: 'submit_step7',
    title: 'Trình ký (bước 7)',
    when: 'Nộp bộ hồ sơ trình ký.',
    recipientsNote: 'Workflow Manager.',
  },
  {
    key: 'published',
    title: 'Ban hành (bước 8)',
    when: 'Đăng số hiệu, ngày ban hành và file scan.',
    recipientsNote: 'Gửi tới mọi tài khoản có email trong bảng users (thông báo rộng).',
  },
  {
    key: 'archived',
    title: 'Lưu trữ / hậu kiểm (bước 9)',
    when: 'Đánh dấu lưu trữ sau khi hoàn tất quy trình.',
    recipientsNote: 'Workflow Manager.',
  },
];

function deepMergeEventToggles(stored) {
  const out = JSON.parse(JSON.stringify(DEFAULT_EMAIL_NOTIFICATION_TOGGLES));
  if (!stored || typeof stored !== 'object') return out;
  for (const key of Object.keys(out)) {
    if (stored[key] && typeof stored[key] === 'object') {
      out[key] = { ...out[key], ...stored[key] };
    }
  }
  return out;
}

function parseStoredToggles(raw) {
  if (raw == null || raw === '') return deepMergeEventToggles(null);
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return deepMergeEventToggles(parsed);
  } catch (_) {
    return deepMergeEventToggles(null);
  }
}

module.exports = {
  DEFAULT_EMAIL_NOTIFICATION_TOGGLES,
  EMAIL_EVENT_CATALOG,
  deepMergeEventToggles,
  parseStoredToggles,
};
