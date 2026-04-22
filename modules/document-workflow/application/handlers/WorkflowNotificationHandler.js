'use strict';

const { EVENT_TYPES } = require('../../domain/events');

/**
 * Lang nghe domain event va gui mail tuong ung.
 * Day la noi TAP TRUNG duy nhat xu ly mail cho workflow, giu hanh vi 1:1 voi controller cu.
 */
function createWorkflowNotificationHandler(deps) {
  const { userRepository, settingsRepository, mailSend, baseUrl } = deps;

  function safeSendMail(payload) {
    if (typeof mailSend !== 'function') return;
    Promise.resolve(mailSend(payload)).catch(() => {});
  }

  function resolveRecipients(_eventKey, fallbackRecipients) {
    return Array.from(new Set((fallbackRecipients || []).filter(Boolean)));
  }

  function documentLink(documentId) {
    const base = String(baseUrl || process.env.BASE_URL || '').replace(/\/$/, '');
    return base
      ? `${base}/quy-trinh-van-ban-noi-bo.html?documentId=${documentId}`
      : `/quy-trinh-van-ban-noi-bo.html?documentId=${documentId}`;
  }

  function composeFormalEmail(lines) {
    return (
      `Kính gửi Thầy/Cô,\n\n` +
      `${(lines || []).filter(Boolean).join('\n')}\n\n` +
      `Trân trọng,\n` +
      `Hệ thống quản lý quy trình ban hành văn bản nội bộ`
    );
  }

  const handlers = {
    [EVENT_TYPES.DocumentCreated](event) {
      const { documentId, title, docType } = event.payload || {};
      safeSendMail({
        to: userRepository.getModuleManagerEmails(),
        subject: `[Quy trình ban hành văn bản] Hồ sơ mới được tạo: #${documentId}`,
        text: composeFormalEmail([
          `Hồ sơ "${title || ''}" vừa được tạo ở bước 1.`,
          `Loại văn bản: ${docType || 'N/A'}`,
          `Xem chi tiết: ${documentLink(documentId)}`,
        ]),
      });
    },

    [EVENT_TYPES.DocumentAssigned](event) {
      const { documentId, title, assignedToId, deadline } = event.payload || {};
      const to = userRepository.findEmailById(assignedToId);
      const toList = resolveRecipients('assign', to ? [to] : []);
      const ccList = userRepository.getModuleManagerEmails().filter((x) => !toList.includes(x));
      safeSendMail({
        to: toList,
        cc: ccList,
        subject: `[Quy trình ban hành văn bản] Phân công soạn thảo hồ sơ #${documentId}`,
        text: composeFormalEmail([
          `Quý Thầy/Cô được phân công soạn thảo hồ sơ: ${title || ''}`,
          `Hạn hoàn thành: ${deadline || 'chưa đặt'}`,
          `Xem chi tiết: ${documentLink(documentId)}`,
        ]),
      });
    },

    [EVENT_TYPES.DraftSaved](event) {
      const { documentId, title, attachmentCount } = event.payload || {};
      safeSendMail({
        to: userRepository.getModuleManagerEmails(),
        subject: `[Quy trình ban hành văn bản] Hồ sơ #${documentId} hoàn tất bước 3`,
        text: composeFormalEmail([
          `Hồ sơ "${title || ''}" đã upload dự thảo và chuyển sang bước 4.`,
          `Số file dự thảo: ${attachmentCount || 0}`,
          `Xem chi tiết: ${documentLink(documentId)}`,
        ]),
      });
    },

    [EVENT_TYPES.DocumentReviewed](event) {
      const { documentId, title, action, comment, assignedToId } = event.payload || {};
      if (action === 'reject') {
        const to = userRepository.findEmailById(assignedToId);
        safeSendMail({
          to: resolveRecipients('review_reject', to ? [to] : []),
          subject: `[Quy trình ban hành văn bản] Hồ sơ #${documentId} bị từ chối thẩm định`,
          text: composeFormalEmail([
            `Hồ sơ "${title || ''}" đã bị từ chối ở bước thẩm định và quay về bước 3.`,
            `Lý do: ${comment || 'Không có'}`,
            `Xem chi tiết: ${documentLink(documentId)}`,
          ]),
        });
        return;
      }
      const mode = String(
        settingsRepository.get('step5_recipient_mode', 'module_manager_assigned') || ''
      )
        .trim()
        .toLowerCase();
      const recipients =
        mode === 'broad_roles'
          ? Array.from(
              new Set(
                [
                  ...userRepository.getEmailsByRole('drafter'),
                  ...userRepository.getEmailsByRole('leader'),
                  ...userRepository.getEmailsByRole('reviewer'),
                  userRepository.findEmailById(assignedToId),
                ].filter(Boolean)
              )
            )
          : Array.from(
              new Set(
                [
                  ...userRepository.getModuleManagerEmails(),
                  userRepository.findEmailById(assignedToId),
                ].filter(Boolean)
              )
            );
      safeSendMail({
        to: resolveRecipients('step5_approved', recipients),
        subject: `[Quy trình ban hành văn bản] Hồ sơ #${documentId} đã chuyển sang bước 5`,
        text: composeFormalEmail([
          `Hồ sơ "${title || ''}" đã được duyệt thẩm định và chuyển sang bước 5 (lấy ý kiến góp ý).`,
          `Kính đề nghị Quý Thầy/Cô phối hợp phản hồi góp ý theo quy trình.`,
          `Xem chi tiết: ${documentLink(documentId)}`,
        ]),
      });
    },

    [EVENT_TYPES.FeedbackAdded](event) {
      const { documentId, title, contentPreview } = event.payload || {};
      safeSendMail({
        to: userRepository.getModuleManagerEmails(),
        subject: `[Quy trình ban hành văn bản] Hồ sơ #${documentId} có góp ý mới (bước 5)`,
        text: composeFormalEmail([
          `Hồ sơ "${title || ''}" đã có góp ý và chuyển sang bước 6.`,
          `Nội dung góp ý (rút gọn): ${contentPreview || ''}`,
          `Xem chi tiết: ${documentLink(documentId)}`,
        ]),
      });
    },

    [EVENT_TYPES.DraftFinalized](event) {
      const { documentId, title } = event.payload || {};
      safeSendMail({
        to: userRepository.getModuleManagerEmails(),
        subject: `[Quy trình ban hành văn bản] Hồ sơ #${documentId} hoàn tất bước 6`,
        text: composeFormalEmail([
          `Hồ sơ "${title || ''}" đã hoàn thiện dự thảo và chuyển sang bước 7.`,
          `Xem chi tiết: ${documentLink(documentId)}`,
        ]),
      });
    },

    [EVENT_TYPES.DocumentSubmitted](event) {
      const { documentId, title } = event.payload || {};
      safeSendMail({
        to: userRepository.getModuleManagerEmails(),
        subject: `[Quy trình ban hành văn bản] Hồ sơ #${documentId} hoàn tất bước 7`,
        text: composeFormalEmail([
          `Hồ sơ "${title || ''}" đã trình ký và chuyển sang bước 8.`,
          `Xem chi tiết: ${documentLink(documentId)}`,
        ]),
      });
    },

    [EVENT_TYPES.DocumentPublished](event) {
      const { documentId, title, documentNumber, publishDate } = event.payload || {};
      safeSendMail({
        to: resolveRecipients('publish', userRepository.getAllEmails()),
        subject: `[Quy trình ban hành văn bản] Văn bản mới được ban hành: ${documentNumber || `#${documentId}`}`,
        text: composeFormalEmail([
          `Văn bản "${title || ''}" đã được ban hành.`,
          `Số hiệu: ${documentNumber || 'N/A'}`,
          `Ngày ban hành: ${publishDate || 'N/A'}`,
          `Xem chi tiết: ${documentLink(documentId)}`,
        ]),
      });
    },

    [EVENT_TYPES.DocumentArchived](event) {
      const { documentId, title } = event.payload || {};
      safeSendMail({
        to: userRepository.getModuleManagerEmails(),
        subject: `[Quy trình ban hành văn bản] Hồ sơ #${documentId} hoàn tất bước 9`,
        text: composeFormalEmail([
          `Hồ sơ "${title || ''}" đã lưu trữ/hậu kiểm.`,
          `Xem chi tiết: ${documentLink(documentId)}`,
        ]),
      });
    },

    [EVENT_TYPES.DocumentAborted]() {
      // Hien tai controller khong gui mail khi abort; giu nguyen.
    },
  };

  function register(bus) {
    const unsubs = [];
    for (const [type, handler] of Object.entries(handlers)) {
      unsubs.push(bus.subscribe(type, handler));
    }
    return () => unsubs.forEach((fn) => fn && fn());
  }

  return { register };
}

module.exports = { createWorkflowNotificationHandler };
