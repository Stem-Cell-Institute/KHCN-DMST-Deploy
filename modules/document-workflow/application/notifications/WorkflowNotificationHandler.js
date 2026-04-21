const { parseStoredToggles } = require('../../services/documentWorkflowMailRules');
const { WorkflowEvents } = require('../../domain/events/WorkflowEvents');

function dedupeEmails(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function docTypeLabel(code) {
  const map = {
    quy_che: 'Quy chế',
    quy_dinh: 'Quy định',
    noi_quy: 'Nội quy',
    huong_dan: 'Hướng dẫn',
  };
  const key = String(code || '').trim().toLowerCase();
  return map[key] || code || 'N/A';
}

function composeFormalEmail(opts) {
  const o = opts || {};
  const greeting = String(o.greeting || 'Kính gửi Quý đối tác,').trim();
  const closing = String(o.closing || 'Trân trọng,').trim();
  const signature = String(
    o.signature || 'Hệ thống quản lý quy trình ban hành văn bản nội bộ'
  ).trim();
  const paragraphs = (o.paragraphs || [])
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  const details = (o.details || [])
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  const link = String(o.link || '').trim();
  const linkLabel = String(o.linkLabel || 'Xem chi tiết tại:').trim();

  let text = `${greeting}\n\n`;
  if (paragraphs.length) text += `${paragraphs.join('\n\n')}\n\n`;
  if (details.length) text += `${details.map((x) => `- ${x}`).join('\n')}\n\n`;
  if (link) text += `${linkLabel}\n${link}\n\n`;
  text += `${closing}\n${signature}`;

  const htmlParagraphs = paragraphs
    .map((p) => `<p style="margin:0 0 12px 0;">${escapeHtml(p)}</p>`)
    .join('');
  const htmlDetails = details.length
    ? `<ul style="margin:0 0 12px 18px;padding:0;">${details
        .map((d) => `<li style="margin:0 0 6px 0;">${escapeHtml(d)}</li>`)
        .join('')}</ul>`
    : '';
  const htmlLink = link
    ? `<p style="margin:0 0 6px 0;">${escapeHtml(
        linkLabel
      )}</p><p style="margin:0 0 12px 0;"><a href="${escapeHtml(
        link
      )}" target="_blank" rel="noopener noreferrer">${escapeHtml(link)}</a></p>`
    : '';
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;">
<p style="margin:0 0 12px 0;">${escapeHtml(greeting)}</p>
${htmlParagraphs}
${htmlDetails}
${htmlLink}
<p style="margin:0;">${escapeHtml(closing)}<br/><strong>${escapeHtml(
    signature
  )}</strong></p>
</div>`;
  return { text, html };
}

function createWorkflowNotificationHandler(deps) {
  const { settingsRepository, userRepository, mailSend, baseUrl } = deps;

  function getModuleSetting(key, fallback) {
    return settingsRepository.get(key, fallback);
  }

  function documentLink(documentId) {
    const base = String(baseUrl || process.env.BASE_URL || '').replace(/\/$/, '');
    return base
      ? `${base}/quy-trinh-van-ban-noi-bo.html?documentId=${documentId}`
      : `/quy-trinh-van-ban-noi-bo.html?documentId=${documentId}`;
  }

  function send(payload) {
    if (typeof mailSend !== 'function') return;
    Promise.resolve(mailSend(payload)).catch(() => {});
  }

  function sendByToggle(eventKey, buildPayload) {
    if (String(getModuleSetting('email_enabled', '1')) !== '1') return;
    const toggles = parseStoredToggles(
      getModuleSetting('email_notification_toggles', '{}')
    );
    const ev = toggles[eventKey];
    if (!ev || ev.enabled === false) return;
    const payload = buildPayload(ev, toggles);
    if (!payload) return;
    let to = dedupeEmails(payload.to);
    let cc = dedupeEmails(payload.cc).filter((e) => !to.includes(e));
    if (!to.length && cc.length) {
      to = cc;
      cc = [];
    }
    if (!to.length) return;
    send({
      to,
      cc: cc.length ? cc : undefined,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    });
  }

  function register(eventBus) {
    eventBus.subscribe(WorkflowEvents.PROPOSAL_CREATED, ({ record }) => {
      sendByToggle('proposal_created', (ev) => {
        const emails = [];
        if (ev.module_managers) emails.push(...userRepository.getModuleManagerEmails());
        if (ev.master_admins) emails.push(...userRepository.getMasterAdminEmails());
        const to = dedupeEmails(emails);
        if (!to.length) return null;
        const email = composeFormalEmail({
          greeting: 'Kính gửi Thầy/Cô,',
          paragraphs: [`Hồ sơ "${record.title || ''}" vừa được tạo thành công ở bước 1 của quy trình.`],
          details: [`Loại văn bản: ${docTypeLabel(record.doc_type)}`],
          link: documentLink(record.id),
          linkLabel: 'Xem chi tiết hồ sơ tại đường link sau:',
        });
        return {
          to,
          subject: `Thông báo tạo hồ sơ ${docTypeLabel(record.doc_type)}`,
          text: email.text,
          html: email.html,
        };
      });
    });

    eventBus.subscribe(WorkflowEvents.ASSIGNMENT_COMPLETED, ({ documentId, updated, assignedToId }) => {
      sendByToggle('assignment', (ev) => {
        const to = [];
        const cc = [];
        if (ev.assigned_drafter) {
          const e = userRepository.getUserEmailById(assignedToId);
          if (e) to.push(e);
        }
        if (ev.cc_module_managers) cc.push(...userRepository.getModuleManagerEmails());
        if (ev.cc_master_admins) cc.push(...userRepository.getMasterAdminEmails());
        const email = composeFormalEmail({
          greeting: 'Kính gửi Thầy/Cô,',
          paragraphs: [`Thầy/Cô được phân công soạn thảo hồ sơ "${updated.title || ''}".`],
          details: [`Hạn hoàn thành: ${updated.assignment_deadline || 'Chưa đặt'}`],
          link: documentLink(documentId),
          linkLabel: 'Xem chi tiết hồ sơ tại:',
        });
        return {
          to,
          cc,
          subject: `Thông báo phân công soạn thảo hồ sơ "${updated.title || ''}"`,
          text: email.text,
          html: email.html,
        };
      });
    });

    eventBus.subscribe(WorkflowEvents.DRAFT_STEP3_COMPLETED, ({ documentId, updated, recordTitle, attachmentCount }) => {
      sendByToggle('draft_step3_complete', (ev) => {
        const emails = [];
        if (ev.module_managers) emails.push(...userRepository.getModuleManagerEmails());
        if (ev.master_admins) emails.push(...userRepository.getMasterAdminEmails());
        const to = dedupeEmails(emails);
        if (!to.length) return null;
        const email = composeFormalEmail({
          greeting: 'Kính gửi Thầy/Cô,',
          paragraphs: [`Hồ sơ "${updated.title || recordTitle || ''}" đã tải dự thảo và chuyển sang bước 4.`],
          details: [`Số tệp dự thảo: ${attachmentCount}`],
          link: documentLink(documentId),
          linkLabel: 'Xem chi tiết hồ sơ tại:',
        });
        return {
          to,
          subject: `Thông báo hoàn tất bước 3 hồ sơ "${updated.title || recordTitle || ''}"`,
          text: email.text,
          html: email.html,
        };
      });
    });

    eventBus.subscribe(WorkflowEvents.REVIEW_REJECTED, ({ documentId, record, comment }) => {
      sendByToggle('review_rejected', (ev) => {
        const to = [];
        if (ev.assigned_drafter) {
          const e = userRepository.getUserEmailById(record.assigned_to_id);
          if (e) to.push(e);
        }
        if (!to.length) return null;
        const email = composeFormalEmail({
          greeting: 'Kính gửi Thầy/Cô,',
          paragraphs: [`Hồ sơ "${record.title || ''}" đã bị từ chối ở bước thẩm định và được chuyển về bước 3.`],
          details: [`Lý do: ${comment || 'Không có'}`],
          link: documentLink(documentId),
          linkLabel: 'Xem chi tiết hồ sơ tại:',
        });
        return {
          to,
          subject: `Thông báo từ chối thẩm định hồ sơ "${record.title || ''}"`,
          text: email.text,
          html: email.html,
        };
      });
    });

    eventBus.subscribe(WorkflowEvents.REVIEW_APPROVED_STEP5, ({ documentId, record }) => {
      const mode = String(
        getModuleSetting('step5_recipient_mode', 'module_manager_assigned') || ''
      )
        .trim()
        .toLowerCase();
      sendByToggle('review_approved_step5', (ev) => {
        const pool = [];
        if (mode === 'broad_roles') {
          if (ev.broad_role_users) {
            pool.push(
              ...userRepository.getRoleEmails('drafter'),
              ...userRepository.getRoleEmails('leader'),
              ...userRepository.getRoleEmails('reviewer')
            );
          }
          if (ev.assigned_drafter) {
            const e = userRepository.getUserEmailById(record.assigned_to_id);
            if (e) pool.push(e);
          }
          if (ev.module_managers) pool.push(...userRepository.getModuleManagerEmails());
        } else {
          if (ev.module_managers) pool.push(...userRepository.getModuleManagerEmails());
          if (ev.assigned_drafter) {
            const e = userRepository.getUserEmailById(record.assigned_to_id);
            if (e) pool.push(e);
          }
        }
        if (ev.master_admins) pool.push(...userRepository.getMasterAdminEmails());
        const to = dedupeEmails(pool);
        if (!to.length) return null;
        const email = composeFormalEmail({
          greeting: 'Kính gửi Thầy/Cô,',
          paragraphs: [
            `Hồ sơ "${record.title || ''}" đã được duyệt thẩm định và chuyển sang bước 5 (lấy ý kiến góp ý).`,
            'Kính đề nghị Thầy/Cô phối hợp phản hồi góp ý theo quy trình.',
          ],
          link: documentLink(documentId),
          linkLabel: 'Xem chi tiết hồ sơ tại:',
        });
        return {
          to,
          subject: `Thông báo hồ sơ "${record.title || ''}" chuyển sang bước 5`,
          text: email.text,
          html: email.html,
        };
      });
    });

    eventBus.subscribe(WorkflowEvents.FEEDBACK_ADDED, ({ documentId, record, content }) => {
      sendByToggle('feedback_added', (ev) => {
        const emails = [];
        if (ev.module_managers) emails.push(...userRepository.getModuleManagerEmails());
        if (ev.master_admins) emails.push(...userRepository.getMasterAdminEmails());
        const to = dedupeEmails(emails);
        if (!to.length) return null;
        const email = composeFormalEmail({
          greeting: 'Kính gửi Thầy/Cô,',
          paragraphs: [`Hồ sơ "${record.title || ''}" đã có góp ý mới và chuyển sang bước 6.`],
          details: [`Nội dung góp ý (rút gọn): ${content.slice(0, 180)}`],
          link: documentLink(documentId),
          linkLabel: 'Xem chi tiết hồ sơ tại:',
        });
        return {
          to,
          subject: `Thông báo góp ý mới cho hồ sơ "${record.title || ''}"`,
          text: email.text,
          html: email.html,
        };
      });
    });

    eventBus.subscribe(WorkflowEvents.FINALIZE_STEP6_COMPLETED, ({ documentId, updated, recordTitle }) => {
      sendByToggle('finalize_step6', (ev) => {
        const emails = [];
        if (ev.module_managers) emails.push(...userRepository.getModuleManagerEmails());
        if (ev.master_admins) emails.push(...userRepository.getMasterAdminEmails());
        const to = dedupeEmails(emails);
        if (!to.length) return null;
        const email = composeFormalEmail({
          greeting: 'Kính gửi Thầy/Cô,',
          paragraphs: [`Hồ sơ "${updated.title || recordTitle || ''}" đã hoàn thiện dự thảo và chuyển sang bước 7.`],
          link: documentLink(documentId),
          linkLabel: 'Xem chi tiết hồ sơ tại:',
        });
        return {
          to,
          subject: `Thông báo hoàn tất bước 6 hồ sơ "${updated.title || recordTitle || ''}"`,
          text: email.text,
          html: email.html,
        };
      });
    });

    eventBus.subscribe(WorkflowEvents.SUBMIT_STEP7_COMPLETED, ({ documentId, updated, recordTitle }) => {
      sendByToggle('submit_step7', (ev) => {
        const emails = [];
        if (ev.module_managers) emails.push(...userRepository.getModuleManagerEmails());
        if (ev.master_admins) emails.push(...userRepository.getMasterAdminEmails());
        const to = dedupeEmails(emails);
        if (!to.length) return null;
        const email = composeFormalEmail({
          greeting: 'Kính gửi Thầy/Cô,',
          paragraphs: [`Hồ sơ "${updated.title || recordTitle || ''}" đã được trình ký và chuyển sang bước 8.`],
          link: documentLink(documentId),
          linkLabel: 'Xem chi tiết hồ sơ tại:',
        });
        return {
          to,
          subject: `Thông báo trình ký hồ sơ "${updated.title || recordTitle || ''}"`,
          text: email.text,
          html: email.html,
        };
      });
    });

    eventBus.subscribe(WorkflowEvents.PUBLISHED, ({ documentId, updated }) => {
      sendByToggle('published', (ev) => {
        const to = ev.all_registered_emails ? userRepository.getAllEmails() : [];
        if (!to.length) return null;
        const email = composeFormalEmail({
          greeting: 'Kính gửi Thầy/Cô,',
          paragraphs: [`Văn bản "${updated.title || ''}" đã được ban hành.`],
          details: [
            `Số hiệu: ${updated.document_number || 'N/A'}`,
            `Ngày ban hành: ${updated.publish_date || 'N/A'}`,
          ],
          link: documentLink(documentId),
          linkLabel: 'Xem chi tiết văn bản tại:',
        });
        return {
          to,
          subject: `Thông báo ban hành văn bản ${updated.document_number || `#${documentId}`}`,
          text: email.text,
          html: email.html,
        };
      });
    });

    eventBus.subscribe(WorkflowEvents.ARCHIVED, ({ documentId, updated, recordTitle }) => {
      sendByToggle('archived', (ev) => {
        const emails = [];
        if (ev.module_managers) emails.push(...userRepository.getModuleManagerEmails());
        if (ev.master_admins) emails.push(...userRepository.getMasterAdminEmails());
        const to = dedupeEmails(emails);
        if (!to.length) return null;
        const email = composeFormalEmail({
          greeting: 'Kính gửi Thầy/Cô,',
          paragraphs: [`Hồ sơ "${updated.title || recordTitle || ''}" đã được lưu trữ và hoàn tất quy trình.`],
          link: documentLink(documentId),
          linkLabel: 'Xem chi tiết hồ sơ tại:',
        });
        return {
          to,
          subject: `Thông báo lưu trữ hồ sơ "${updated.title || recordTitle || ''}"`,
          text: email.text,
          html: email.html,
        };
      });
    });
  }

  return { register };
}

module.exports = {
  createWorkflowNotificationHandler,
};
