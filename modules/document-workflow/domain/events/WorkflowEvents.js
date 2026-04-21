const WorkflowEvents = {
  PROPOSAL_CREATED: 'workflow.proposal_created',
  ASSIGNMENT_COMPLETED: 'workflow.assignment_completed',
  DRAFT_STEP3_COMPLETED: 'workflow.draft_step3_completed',
  REVIEW_REJECTED: 'workflow.review_rejected',
  REVIEW_APPROVED_STEP5: 'workflow.review_approved_step5',
  FEEDBACK_ADDED: 'workflow.feedback_added',
  FINALIZE_STEP6_COMPLETED: 'workflow.finalize_step6_completed',
  SUBMIT_STEP7_COMPLETED: 'workflow.submit_step7_completed',
  PUBLISHED: 'workflow.published',
  ARCHIVED: 'workflow.archived',
};

module.exports = {
  WorkflowEvents,
};
