export const gpsDriftLookbackFeeds = 12;
export const gpsDriftScoreThreshold = 100;
export const gpsDriftScoreDecay = 0.5;
export const gpsDriftHistoricalScoreCeiling = 130;

function linearPenalty(value, start, maximum) {
  if (!Number.isFinite(value) || value < start) return 0;
  if (value >= maximum) return 100;
  return 50 + ((value - start) * 50) / (maximum - start);
}

export function getGpsDriftPenalties({
  speedMps,
  accelerationMps2,
  sequenceDelta,
  progressDeltaMeters
}) {
  const speedPenalty = linearPenalty(speedMps, 25, 40);
  const accelerationPenalty = linearPenalty(
    Math.abs(accelerationMps2),
    5,
    10
  );
  const sequenceIncrementPenalty =
    sequenceDelta > 0 ? sequenceDelta * 20 : 0;
  const sequenceDecrementPenalty =
    sequenceDelta < 0 ? Math.abs(sequenceDelta) * 80 : 0;
  const negativeProgressPenalty =
    getNegativeProgressPenalty(progressDeltaMeters);

  return {
    speedPenalty,
    accelerationPenalty,
    sequenceIncrementPenalty,
    sequenceDecrementPenalty,
    negativeProgressPenalty,
    total: speedPenalty + accelerationPenalty +
      sequenceIncrementPenalty + sequenceDecrementPenalty +
      negativeProgressPenalty
  };
}

export function applyGpsDriftScoreDecay(localPenalty, previousScore) {
  return localPenalty +
    Math.min(previousScore, gpsDriftHistoricalScoreCeiling) *
      gpsDriftScoreDecay;
}

export function getNegativeProgressPenalty(progressDeltaMeters) {
  return progressDeltaMeters < -10
    ? Math.floor((-progressDeltaMeters - 10) / 10) * 10
    : 0;
}
