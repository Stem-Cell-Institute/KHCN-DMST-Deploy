'use strict';

const EVENT_TYPES = Object.freeze({
  DocumentCreated: 'document.created',
  DocumentAssigned: 'document.assigned',
  DraftSaved: 'document.draft_saved',
  DocumentReviewed: 'document.reviewed',
  FeedbackAdded: 'document.feedback_added',
  DraftFinalized: 'document.draft_finalized',
  DocumentSubmitted: 'document.submitted',
  DocumentPublished: 'document.published',
  DocumentArchived: 'document.archived',
  DocumentAborted: 'document.aborted',
});

function createEvent(type, payload, meta) {
  return {
    type,
    v: 1,
    occurredAt: new Date().toISOString(),
    actorId: (meta && meta.actorId) || null,
    actorName: (meta && meta.actorName) || null,
    correlationId: (meta && meta.correlationId) || null,
    payload: payload || {},
  };
}

module.exports = {
  EVENT_TYPES,
  createEvent,
};
