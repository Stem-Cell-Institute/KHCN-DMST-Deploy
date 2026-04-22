'use strict';

const { EVENT_TYPES } = require('../../domain/events');

/**
 * Ghi audit log khi co su kien admin (user/unit/setting changed).
 * Hien tai controller admin goi truc tiep auditLogRepository.append nen handler nay
 * dang dat cho - san sang nhan them event cross-BC trong tuong lai.
 */
function createAuditLogHandler(deps) {
  const { auditLogRepository } = deps;

  function register(bus) {
    const unsubs = [];

    const forward = (actionName, mapper) => (event) => {
      try {
        const data = mapper(event);
        auditLogRepository.append({
          user_id: (event.actorId != null ? event.actorId : null),
          action: actionName,
          target_type: 'document',
          target_id: (data && data.documentId) || null,
          old_value: null,
          new_value: JSON.stringify(data || {}),
          ip_address: null,
          user_agent: null,
        });
      } catch (_) {}
    };

    unsubs.push(
      bus.subscribe(EVENT_TYPES.DocumentPublished, forward('document_published', (e) => e.payload))
    );
    unsubs.push(
      bus.subscribe(EVENT_TYPES.DocumentArchived, forward('document_archived', (e) => e.payload))
    );
    unsubs.push(
      bus.subscribe(EVENT_TYPES.DocumentAborted, forward('document_aborted', (e) => e.payload))
    );

    return () => unsubs.forEach((fn) => fn && fn());
  }

  return { register };
}

module.exports = { createAuditLogHandler };
