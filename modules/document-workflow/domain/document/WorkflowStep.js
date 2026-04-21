function parseId(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function stepForward(currentStep, forcedNextStep) {
  if (forcedNextStep != null) return forcedNextStep;
  return Math.min(9, Math.max(1, Number(currentStep) + 1));
}

module.exports = {
  parseId,
  stepForward,
};
