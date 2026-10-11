import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyGpsDriftScoreDecay,
  getGpsDriftPenalties
} from '../realtime-oversampler/gps-drift-filter.mjs';

test('interpolates speed and acceleration penalties between thresholds', () => {
  assert.equal(getGpsDriftPenalties({
    speedMps: 25,
    accelerationMps2: 5,
    sequenceDelta: 0,
    progressDeltaMeters: 0
  }).total, 100);
  assert.equal(getGpsDriftPenalties({
    speedMps: 32.5,
    accelerationMps2: 7.5,
    sequenceDelta: 0,
    progressDeltaMeters: 0
  }).total, 150);
  assert.equal(getGpsDriftPenalties({
    speedMps: 40,
    accelerationMps2: 10,
    sequenceDelta: 0,
    progressDeltaMeters: 0
  }).total, 200);
});

test('penalizes sequence changes and substantial backward progress', () => {
  const forward = getGpsDriftPenalties({
    speedMps: 0,
    accelerationMps2: 0,
    sequenceDelta: 2,
    progressDeltaMeters: 0
  });
  assert.equal(forward.sequenceIncrementPenalty, 40);

  const backward = getGpsDriftPenalties({
    speedMps: 0,
    accelerationMps2: 0,
    sequenceDelta: -2,
    progressDeltaMeters: -326
  });
  assert.equal(backward.sequenceDecrementPenalty, 160);
  assert.equal(backward.negativeProgressPenalty, 310);

  assert.equal(getGpsDriftPenalties({
    speedMps: 0,
    accelerationMps2: 0,
    sequenceDelta: 0,
    progressDeltaMeters: -10
  }).negativeProgressPenalty, 0);
});

test('decays the previous feed score by one half', () => {
  assert.equal(applyGpsDriftScoreDecay(20, 80), 60);
  assert.equal(applyGpsDriftScoreDecay(0, 400), 65);
});
