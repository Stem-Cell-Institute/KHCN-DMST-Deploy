'use strict';

const STEP_MIN = 1;
const STEP_MAX = 9;

const STEP_NAMES = Object.freeze({
  1: 'proposal',
  2: 'assigned',
  3: 'drafting',
  4: 'review',
  5: 'feedback',
  6: 'finalize',
  7: 'submit',
  8: 'publish',
  9: 'archive',
});

function normalizeStep(value) {
  const n = Math.max(STEP_MIN, Math.min(STEP_MAX, Number(value) || STEP_MIN));
  return n;
}

function stepForward(currentStep, forcedNextStep) {
  if (forcedNextStep != null) return normalizeStep(forcedNextStep);
  return normalizeStep(Number(currentStep) + 1);
}

function isWorkflowActive(status) {
  const s = String(status || '').trim().toLowerCase();
  return s !== 'aborted' && s !== 'archived';
}

module.exports = {
  STEP_MIN,
  STEP_MAX,
  STEP_NAMES,
  normalizeStep,
  stepForward,
  isWorkflowActive,
};
