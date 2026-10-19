import { createRequire } from 'node:module';
import {
  applyGpsDriftScoreDecay,
  getGpsDriftPenalties,
  getNegativeProgressPenalty,
  gpsDriftLookbackFeeds,
  gpsDriftScoreThreshold
} from './gps-drift-filter.mjs';
import {
  createTimetableShapeDistanceMeasurer,
  createTimetableShapeProjector,
  createTimetableShapeGeometryDistanceMeasurer,
  createTimetableShapeGeometryProjector
} from './shape-point-index.mjs';

const require = createRequire(import.meta.url);
const turf = require('../scripts/external/turf.min.js');

const bucketSizeMeters = 20;
const trafficClasses = Object.freeze({
  fast: 'fast',
  normal: 'normal',
  slow: 'slow',
  verySlow: 'very_slow'
});
const trafficClassOrder = [
  trafficClasses.verySlow,
  trafficClasses.slow,
  trafficClasses.normal,
  trafficClasses.fast
];
const speedHistogramBinWidthMps = 0.5;
const outlierSpeedLimitMps = 35;
const arrivalToleranceMeters = 30;
const nonStoppingWindowSeconds = 20;
const doorSensorGpsMovementThresholdMeters = 100;
const doorSensorLookbackSamples = 12;
const stationaryGpsToleranceMeters = 5;
const stationaryTimestampGapSeconds = 10;
const movingTimestampGapSeconds = 5;
const delayedStopDistanceGpsThresholdMeters = 10;
const gpsStopDistanceToleranceMeters = 50;
const nextStopDistanceCorrectionGraceSampleCount = 2;
const closedDoorStopDistanceSnapRadiusMeters = 100;
const gpsStopDistanceMovementToleranceMeters = 10;
const gpsStopDistanceMovementToleranceRatio = 0.2;
const shortIntervalStopDistanceCorrectionSeconds = 4.5;
const stopDistanceShapeProjectionToleranceMeters = 20;
const staleStopDistanceShapeErrorMeters = 40;
const currentStopDistanceShapeErrorMeters = 20;
const minimumStopDistanceShapeErrorImprovementMeters = 30;
const bucketSampleRanges = [
  { label: '1', min: 1, max: 1 },
  { label: '2-4', min: 2, max: 4 },
  { label: '5-9', min: 5, max: 9 },
  { label: '10-24', min: 10, max: 24 },
  { label: '25+', min: 25, max: Number.POSITIVE_INFINITY }
];

function getValue(map, key) {
  return map instanceof Map ? map.get(key) : map?.[key];
}

function invertIndexMap(map) {
  const result = new Map();
  const entries = map instanceof Map ? map.entries() : Object.entries(map ?? {});
  for (const [id, index] of entries) {
    result.set(Number(index), id);
  }
  return result;
}

function toSeconds(value) {
  const seconds = typeof value?.toNumber === 'function'
    ? value.toNumber()
    : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function toFiniteNumber(value) {
  if (value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function recheckGpsDriftEntry(entry, nextSample, propagatedScore) {
  const progressDeltaMeters = entry.sample.tripId === nextSample.tripId
    ? nextSample.progress - entry.sample.progress
    : 0;
  const progressPenalty = getNegativeProgressPenalty(progressDeltaMeters);
  if (progressPenalty > entry.backpropagatedProgressPenalty) {
    entry.backpropagatedProgressPenalty = progressPenalty;
    entry.backpropagatedProgressDeltaMeters = progressDeltaMeters;
  }
  entry.recheckPreviousScore = propagatedScore;
  entry.recheckHistoryContribution =
    applyGpsDriftScoreDecay(0, propagatedScore);
  const recheckedScore = applyGpsDriftScoreDecay(
    entry.localPenalty + entry.backpropagatedProgressPenalty,
    propagatedScore
  );
  entry.score = Math.max(entry.score, recheckedScore);
  return entry.score;
}

function getPosition(position) {
  const latitude = toFiniteNumber(position?.latitude);
  const longitude = toFiniteNumber(position?.longitude);
  if (latitude === null ||
      latitude < -90 ||
      latitude > 90 ||
      longitude === null ||
      longitude < -180 ||
      longitude > 180) {
    return null;
  }
  return { latitude, longitude };
}

function getPositionDistanceMeters(first, second) {
  if (!first || !second) return null;
  return turf.distance(
    turf.point([first.longitude, first.latitude]),
    turf.point([second.longitude, second.latitude]),
    { units: 'meters' }
  );
}

function getShapeProjectedStopDistance(sample, projectPositionOnShape) {
  const stopIndex = sample.stopIndex;
  const shapeStartDistance = toFiniteNumber(
    sample.trip.stopShapeDist?.[stopIndex - 1]
  );
  const shapeEndDistance = toFiniteNumber(
    sample.trip.stopShapeDist?.[stopIndex]
  );
  if (sample.trip.shapeDistanceLegValid?.[stopIndex - 1] !== true ||
      shapeStartDistance === null ||
      shapeEndDistance === null ||
      shapeEndDistance <= shapeStartDistance ||
      Math.abs(shapeEndDistance - sample.stopShapeDistance) > 0.01) {
    return null;
  }

  const projection = projectPositionOnShape(
    sample.trip,
    sample.position,
    {
      minShapeDistance: shapeStartDistance,
      maxShapeDistance: shapeEndDistance
    }
  );
  if (!projection ||
      projection.crossTrackMeters >
        stopDistanceShapeProjectionToleranceMeters) {
    return null;
  }

  const expectedStopDistance =
    (shapeEndDistance - projection.shapeDistance) *
    projection.metersPerUnit;
  return Number.isFinite(expectedStopDistance)
    ? expectedStopDistance
    : null;
}

function setReportedStopDistance(sample, stopDistance) {
  sample.reportedStopDistance = stopDistance;
  sample.stopDistance = stopDistance;
  sample.distanceToStop = stopDistance;
  sample.progress = sample.stopShapeDistance - stopDistance;
  sample.stopDistanceCorrectionApplied = true;
  sample.stopDistanceCorrectionRawValue = sample.feedReportedStopDistance;
}

function getStopShapePointBounds(trip, stopIndex) {
  const stopPointIndex = trip?.stopShapePointIndex?.[stopIndex];
  if (!Number.isInteger(stopPointIndex)) return null;
  const previousStopPointIndex = stopIndex > 0
    ? trip.stopShapePointIndex?.[stopIndex - 1]
    : stopPointIndex;
  if (!Number.isInteger(previousStopPointIndex) ||
      previousStopPointIndex > stopPointIndex) {
    return null;
  }
  return {
    minShapePointIndex: Math.max(0, previousStopPointIndex - 1),
    maxShapePointIndex: stopPointIndex + 1,
    stopPointIndex
  };
}

function getVehicleKey(entity) {
  const vehicle = entity.vehicle;
  const key = vehicle.vehicle?.id ?? vehicle.vehicle?.label ?? entity.id;
  return key === undefined || key === null || key === ''
    ? null
    : String(key);
}

function classifyDuration(actualSeconds, expectedSeconds) {
  if (!Number.isFinite(actualSeconds) ||
      !Number.isFinite(expectedSeconds) ||
      actualSeconds <= 0 ||
      expectedSeconds <= 0) {
    return null;
  }

  const ratio = actualSeconds / expectedSeconds;
  if (ratio < 0.85) return trafficClasses.fast;
  if (ratio <= 1.15) return trafficClasses.normal;
  if (ratio <= 1.5) return trafficClasses.slow;
  return trafficClasses.verySlow;
}

function getTimetableIndexes(timetable) {
  return {
    stopIdByIndex: invertIndexMap(timetable.stopMap),
    routeIdByIndex: invertIndexMap(timetable.routeMap),
    projectPositionOnShape: createTimetableShapeProjector(timetable),
    measureShapeDistance: createTimetableShapeDistanceMeasurer(timetable),
    projectPositionOnShapeGeometry:
      createTimetableShapeGeometryProjector(timetable),
    measureShapeGeometryDistance:
      createTimetableShapeGeometryDistanceMeasurer(timetable)
  };
}

function resolveSample(entity, headerTimestamp, timetable, indexes, source) {
  const vehicle = entity.vehicle;
  const vehicleDescriptor = vehicle.vehicle;
  const vehicleKey = getVehicleKey(entity);
  const tripId = vehicle.trip?.trip_id;
  const sequence = Number(vehicle.current_stop_sequence);
  const stopId = vehicle.stop_id;
  const vehicleTimestamp = toSeconds(vehicle.timestamp);
  const rawTimestamp = vehicleTimestamp ?? toSeconds(headerTimestamp);

  if (!vehicleKey ||
      !tripId ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      !stopId ||
      rawTimestamp === null) {
    return null;
  }

  const tripIndex = getValue(timetable.tripMap, tripId);
  if (tripIndex === undefined ||
      tripIndex === null ||
      !Number.isInteger(Number(tripIndex))) {
    return null;
  }
  const numericTripIndex = Number(tripIndex);
  const trip = timetable.trips[numericTripIndex];
  timetable.indexTripShapePoints?.(numericTripIndex);
  timetable.validateTripShapeDistances?.(numericTripIndex);
  const stopIndex = sequence - 1;
  const scheduledStop = trip?.stops[stopIndex];
  const mappedStopIndex = getValue(timetable.stopMap, stopId);
  if (!scheduledStop ||
      Number(scheduledStop._id) !== Number(mappedStopIndex)) {
    return null;
  }

  const realcityDescriptor = vehicleDescriptor?.['.realcity.vehicle'];
  if (!realcityDescriptor ||
      !Object.hasOwn(realcityDescriptor, 'stop_distance')) {
    return null;
  }
  const reportedStopDistance = toFiniteNumber(realcityDescriptor.stop_distance);
  const stopShapeDistance = toFiniteNumber(trip.stopShapeDist?.[stopIndex]);
  if (reportedStopDistance === null ||
      reportedStopDistance < 0 ||
      stopShapeDistance === null) {
    return null;
  }
  const progress = stopShapeDistance - reportedStopDistance;
  const stopPosition = getPosition({
    latitude: scheduledStop.lat,
    longitude: scheduledStop.lon
  });

  const routeId = indexes.routeIdByIndex.get(Number(trip.route?._id));
  return {
    vehicleKey,
    vehicleId: vehicleDescriptor?.id ? String(vehicleDescriptor.id) : '',
    vehicleName: vehicleDescriptor?.label ? String(vehicleDescriptor.label) : '',
    entityId: entity.id ? String(entity.id) : '',
    source,
    timestamp: rawTimestamp,
    vehicleTimestamp,
    position: getPosition(vehicle.position),
    tripId,
    routeName: trip.route?.name ? String(trip.route.name) : '',
    trip,
    routeId,
    stopIndex,
    stopId: String(stopId),
    stopPosition,
    stopShapeDistance,
    reportedStopDistance,
    feedReportedStopDistance: reportedStopDistance,
    stopDistance: reportedStopDistance,
    progress,
    distanceToStop: reportedStopDistance,
    nextStopDistanceCorrectionPending: false,
    nextStopDistanceCorrectionApplied: false,
    nextStopDistanceRecalculationApplied: false,
    nextStopDistanceCorrectionRawStopDistance: null,
    nextStopDistanceCorrectionDeferred: false,
    stopDistanceCorrectionApplied: false,
    stopDistanceCorrectionRawValue: null,
    doorOpen: realcityDescriptor.door_open === true,
    currentStatus: vehicle.current_status
  };
}

function makeVehicleState(sample, indexes) {
  return {
    lastSample: sample,
    lastFeedSample: sample,
    lastProcessedFeedSample: sample,
    lastDoorClosedSample: sample.doorOpen ? null : sample,
    doorOpenStopDistanceCorrectionLogged: false,
    nextStopDistanceCorrectionActive: false,
    nextStopDistanceCorrectionSample: null,
    nextStopDistanceCorrectionGraceSamplesRemaining: 0,
    nextStopDistanceCorrectionGrace: null,
    indexes,
    lastObservedSample: sample,
    pendingDelayedStopDistanceFeeds: null,
    pendingStationaryFeeds: null,
    lastGpsDriftSample: sample,
    lastGpsDriftDistinctSample: sample,
    lastGpsDriftPriorDistinctSample: null,
    lastGpsDriftSpeedMps: null,
    lastGpsDriftScore: 0,
    stopSequenceRegression: null,
    gpsBasedZeroStopDistanceCorrection: null,
    trip: sample.trip,
    routeId: sample.routeId,
    stopIdByIndex: indexes.stopIdByIndex,
    arrivals: new Map(),
    legClasses: new Map(),
    pendingSpeeds: new Map(),
    pendingWaits: new Map(),
    pendingNonStoppingSpeeds: new Map(),
    nonStoppingSpeedKeys: new Map(),
    nonStoppingWindows: [],
    nonStoppingStopsSeen: new Set(),
    recentSpeedTransitions: [],
    doorOpenObservations: [{
      timestamp: sample.timestamp,
      doorOpen: sample.doorOpen
    }],
    doorOpenMovementEvidence: sample.doorOpen
      ? {
          startTimestamp: sample.timestamp,
          firstSample: sample,
          firstPosition: sample.position,
          distanceMeters: 0
        }
      : null,
    pendingDoorOpenSensorSamples: sample.doorOpen
      ? { initialSample: sample, samples: [] }
      : null,
    doorSensorStuck: false
  };
}

function addPendingSpeed(state, stopIndex, sample) {
  const samples = state.pendingSpeeds.get(stopIndex) ?? [];
  samples.push(sample);
  state.pendingSpeeds.set(stopIndex, samples);
}

function addPendingWait(state, stopIndex, seconds) {
  if (seconds <= 0) return;
  const pending = state.pendingWaits.get(stopIndex) ?? {
    sampleCount: 0,
    totalSeconds: 0
  };
  pending.sampleCount++;
  pending.totalSeconds += seconds;
  state.pendingWaits.set(stopIndex, pending);
}

function getSpeedCalculation(previous, current, elapsedSeconds) {
  if (current.progress <= previous.progress) return null;
  // Door-state transitions usually carry a fresh vehicle timestamp, so
  // halving those intervals would assume the event happened at the midpoint.
  const adjustedSeconds =
    previous.doorOpen && current.doorOpen ? elapsedSeconds / 2 : elapsedSeconds;
  if (adjustedSeconds <= 0) return null;
  const distanceMeters = current.progress - previous.progress;
  return {
    adjustedSeconds,
    distanceMeters,
    speedMps: distanceMeters / adjustedSeconds
  };
}

function getFrequencyPercentile(frequencies, total, percentile) {
  if (total === 0) return null;
  const target = Math.ceil(total * percentile);
  let cumulative = 0;
  const entries = [...frequencies.entries()].sort(([left], [right]) => left - right);
  for (const [value, count] of entries) {
    cumulative += count;
    if (cumulative >= target) return value;
  }
  return entries.at(-1)?.[0] ?? null;
}

function getFrequencyMedian(frequencies, total) {
  if (total === 0) return null;
  const lowerRank = Math.floor((total + 1) / 2);
  const upperRank = Math.floor((total + 2) / 2);
  let cumulative = 0;
  let lowerValue = null;
  const entries = [...frequencies.entries()].sort(([left], [right]) => left - right);
  for (const [value, count] of entries) {
    cumulative += count;
    if (lowerValue === null && cumulative >= lowerRank) lowerValue = value;
    if (cumulative >= upperRank) return (lowerValue + value) / 2;
  }
  return entries.at(-1)?.[0] ?? null;
}

export class SpeedGraphBuilder {
  constructor({
    onSpeedOutlier = () => {},
    onDoorSensorStuck = () => {},
    onGpsSignalLost = () => {},
    onDelayedStopDistance = () => {},
    onNextStopDistanceCorrection = () => {},
    onShortIntervalStopDistanceCorrection = () => {},
    onShortIntervalStopDistanceCorrectionRejected = () => {},
    onDoorOpenStopDistanceCorrection = () => {},
    onClosedDoorStopDistanceCorrection = () => {},
    onStopSequenceRegression = () => {},
    onGpsDriftRejection = () => {},
    onFeedDisposition = () => {},
    onGpsBasedNextStopZeroCorrection = () => {}
  } = {}) {
    this.onSpeedOutlier = onSpeedOutlier;
    this.onDoorSensorStuck = onDoorSensorStuck;
    this.onGpsSignalLost = onGpsSignalLost;
    this.onDelayedStopDistance = onDelayedStopDistance;
    this.onNextStopDistanceCorrection = onNextStopDistanceCorrection;
    this.onShortIntervalStopDistanceCorrection =
      onShortIntervalStopDistanceCorrection;
    this.onShortIntervalStopDistanceCorrectionRejected =
      onShortIntervalStopDistanceCorrectionRejected;
    this.onDoorOpenStopDistanceCorrection = onDoorOpenStopDistanceCorrection;
    this.onClosedDoorStopDistanceCorrection =
      onClosedDoorStopDistanceCorrection;
    this.onStopSequenceRegression = onStopSequenceRegression;
    this.onGpsDriftRejection = onGpsDriftRejection;
    this.onFeedDisposition = onFeedDisposition;
    this.onGpsBasedNextStopZeroCorrection =
      onGpsBasedNextStopZeroCorrection;
    this.speedGraph = new Map();
    this.waitingGraph = new Map();
    this.vehicleStates = new Map();
    this.timetableIndexes = new WeakMap();
    this.activeTimetable = null;
    this.lastUpdatedPair = null;
    this.routeStopWaitCount = 0;
    this.rejectedSamples = 0;
    this.vehicleObservations = 0;
    this.rejectedVehicleObservations = 0;
    this.rejectedSpeedSamples = 0;
    this.rejectedFeedPairs = 0;
    this.stationaryGpsSamplesDropped = 0;
    this.classifiedLegs = 0;
    this.pendingLegs = 0;
    this.speedOutlierCount = 0;
    this.doorSensorStuckTrips = 0;
    this.doorSensorRejectedFeedPairs = 0;
    this.stopSequenceRegressionEpisodes = 0;
    this.stopSequenceRegressionRejectedFeeds = 0;
    this.stopSequenceRegressionRecoveries = 0;
    this.gpsDriftRejectedFeeds = 0;
    this.unattributedWaits = 0;
    this.unclassifiedLegs = 0;
    this.nextSpeedTransitionId = 0;
    this.speedHistograms = new Map(
      trafficClassOrder.map((trafficClass) => [trafficClass, new Map()])
    );
    this.maximumSpeedByClass = new Map();
  }

  getIndexes(timetable) {
    let indexes = this.timetableIndexes.get(timetable);
    if (!indexes) {
      indexes = getTimetableIndexes(timetable);
      this.timetableIndexes.set(timetable, indexes);
    }
    return indexes;
  }

  processFeed(message, timetable, source = null) {
    if (this.activeTimetable !== timetable) {
      this.flushPendingStationaryFeeds();
      this.vehicleStates.clear();
      this.activeTimetable = timetable;
    }

    const indexes = this.getIndexes(timetable);
    for (const entity of message.entity ?? []) {
      if (!entity.vehicle) continue;
      this.vehicleObservations++;
      let sample = resolveSample(
        entity,
        message.header?.timestamp,
        timetable,
        indexes,
        source
      );
      if (!sample) {
        this.onFeedDisposition({
          kind: 'rejected',
          reason: 'invalid-observation',
          entity,
          source
        });
        this.rejectedSamples++;
        this.rejectedVehicleObservations++;
        continue;
      }

      let state = this.vehicleStates.get(sample.vehicleKey);
      if (!state) {
        state = makeVehicleState(sample, indexes);
        state.graphBaselinePending = true;
        this.vehicleStates.set(sample.vehicleKey, state);
        this.stageGpsDriftSample(state, sample, { baseline: true });
        continue;
      }

      if (state.lastFeedSample.tripId !== sample.tripId) {
        this.flushPendingGpsDriftSamples(state, true);
        const regression = state.stopSequenceRegression;
        if (!regression) {
          this.flushPendingDelayedStopDistanceSamples(state);
          this.flushPendingDoorOpenSensorSamples(state);
        }
        const previous = state.graphBaselinePending ? null : state.lastSample;
        const previousGpsDriftScore = state.lastGpsDriftScore;
        state = makeVehicleState(sample, indexes);
        state.graphBaselinePending = false;
        state.lastGpsDriftScore = previousGpsDriftScore;
        if (regression) state.stopSequenceRegression = regression;
        this.vehicleStates.set(sample.vehicleKey, state);
        if (regression) {
          const validation = this.validateStopDistanceWithGps(sample);
          if (validation.validates) {
            this.recoverStopSequenceRegression(state, sample, validation);
          } else {
            this.invalidateStopSequenceRegressionFeed(state, sample);
          }
        } else if (previous && sample.stopIndex < previous.stopIndex) {
          const validation = this.validateStopDistanceWithGps(sample);
          if (validation.validates) {
            this.recordSampleArrival(state, sample);
          } else {
            this.startStopSequenceRegression(
              state,
              sample,
              previous,
              validation
            );
          }
        } else {
          this.recordSampleArrival(state, sample);
        }
        continue;
      }

      if (sample.timestamp < state.lastFeedSample.timestamp) {
        this.onFeedDisposition({
          kind: 'rejected',
          reason: 'timestamp-regression',
          sample,
          previous: state.lastFeedSample,
          secondsBehind: state.lastFeedSample.timestamp - sample.timestamp
        });
        this.rejectedSamples++;
        this.rejectedVehicleObservations++;
        this.rejectedFeedPairs++;
        continue;
      }

      const correctionReplayPending =
        state.stopSequenceRegression ||
        state.pendingStationaryFeeds?.samples.some((entry) =>
          entry.sample.nextStopDistanceCorrectionDeferred
        );
      if (correctionReplayPending) {
        sample.nextStopDistanceCorrectionDeferred = true;
      } else {
        sample = this.correctNextStopDistance(
          state,
          sample,
          indexes.projectPositionOnShapeGeometry,
          indexes.measureShapeGeometryDistance
        );
      }
      if (!sample) continue;
      if (!sample.nextStopDistanceCorrectionDeferred) {
        sample = this.correctDoorOpenStopDistance(state, sample);
        sample = this.correctShortIntervalStopDistance(
          state,
          sample,
          indexes.projectPositionOnShape
        );
      }
      if (!sample.nextStopDistanceCorrectionDeferred &&
          state.nextStopDistanceCorrectionActive &&
          state.nextStopDistanceCorrectionSample?.tripId === sample.tripId &&
          state.nextStopDistanceCorrectionSample.stopIndex ===
            sample.stopIndex &&
          state.nextStopDistanceCorrectionSample.stopId === sample.stopId) {
        state.nextStopDistanceCorrectionSample = sample;
      }
      this.stageGpsDriftSample(state, sample);
      state.lastFeedSample = sample;
      if (!sample.doorOpen &&
          !sample.nextStopDistanceCorrectionDeferred) {
        state.lastDoorClosedSample = sample;
        state.doorOpenStopDistanceCorrectionLogged = false;
      }
    }
  }

  stageGpsDriftSample(state, sample, { baseline = false } = {}) {
    const previous = state.lastGpsDriftSample;
    const duplicateGpsObservation = !baseline &&
      previous.tripId === sample.tripId &&
      previous.vehicleTimestamp !== null &&
      previous.vehicleTimestamp === sample.vehicleTimestamp &&
      previous.position !== null &&
      sample.position !== null &&
      previous.position.latitude === sample.position.latitude &&
      previous.position.longitude === sample.position.longitude;
    let speedPrevious = duplicateGpsObservation
      ? state.lastGpsDriftPriorDistinctSample ?? previous
      : previous;
    const pendingSamples = state.pendingStationaryFeeds?.samples ?? [];
    const firstPendingSample =
      pendingSamples.find((entry) => !entry.baseline)?.sample;
    if (!duplicateGpsObservation &&
        firstPendingSample &&
        this.isStationaryFeedCandidate(state.lastSample, firstPendingSample) &&
        getPositionDistanceMeters(previous.position, sample.position) >
          stationaryGpsToleranceMeters &&
        sample.vehicleTimestamp !== null &&
        previous.vehicleTimestamp !== null &&
        sample.vehicleTimestamp - previous.vehicleTimestamp <
          movingTimestampGapSeconds) {
      speedPrevious = state.lastSample;
    }
    const elapsedSeconds = speedPrevious.vehicleTimestamp !== null &&
        sample.vehicleTimestamp !== null
      ? sample.vehicleTimestamp - speedPrevious.vehicleTimestamp
      : null;
    const gpsDistanceMeters = getPositionDistanceMeters(
      speedPrevious.position,
      sample.position
    );
    const speedMps = elapsedSeconds !== null &&
        elapsedSeconds > 0 &&
        gpsDistanceMeters !== null
      ? gpsDistanceMeters / elapsedSeconds
      : null;
    const accelerationMps2 = speedMps !== null &&
        state.lastGpsDriftSpeedMps !== null &&
        elapsedSeconds !== null &&
        elapsedSeconds > 0
      ? (speedMps - state.lastGpsDriftSpeedMps) / elapsedSeconds
      : null;
    const sameTrip = previous.tripId === sample.tripId;
    const sequenceDelta = sameTrip
      ? sample.stopIndex - previous.stopIndex
      : 0;
    const progressDeltaMeters = sameTrip
      ? sample.progress - previous.progress
      : 0;
    const penalties = getGpsDriftPenalties({
      speedMps,
      accelerationMps2,
      sequenceDelta,
      progressDeltaMeters
    });
    const previousScore = state.lastGpsDriftScore;
    const historyContribution = applyGpsDriftScoreDecay(0, previousScore);
    const score = applyGpsDriftScoreDecay(
      penalties.total,
      previousScore
    );
    const entry = {
      sample,
      baseline,
      duplicateGpsObservation,
      previousSample: previous,
      penalties,
      speedMps,
      accelerationMps2,
      sequenceDelta,
      progressDeltaMeters,
      previousScore,
      historyContribution,
      localPenalty: penalties.total,
      score,
      rejected: score > gpsDriftScoreThreshold,
      rejectionReason: score > gpsDriftScoreThreshold ? 'direct' : null,
      recheckPreviousScore: null,
      recheckHistoryContribution: null,
      backpropagatedProgressDeltaMeters: null,
      backpropagatedProgressPenalty: 0
    };
    const pending = state.pendingStationaryFeeds ?? { samples: [] };
    state.pendingStationaryFeeds = pending;
    pending.samples.push(entry);

    if (entry.rejected) {
      let propagatedScore = score;
      let nextSample = sample;
      for (let index = pending.samples.length - 2; index >= 0; index--) {
        const preceding = pending.samples[index];
        preceding.score = recheckGpsDriftEntry(
          preceding,
          nextSample,
          propagatedScore
        );
        if (preceding.score <= gpsDriftScoreThreshold) break;
        preceding.rejected = true;
        preceding.rejectionReason = 'back-propagated';
        propagatedScore = preceding.score;
        nextSample = preceding.sample;
      }
    }

    state.lastGpsDriftSample = sample;
    if (!baseline && !duplicateGpsObservation) {
      state.lastGpsDriftPriorDistinctSample =
        state.lastGpsDriftDistinctSample;
      state.lastGpsDriftDistinctSample = sample;
    }
    state.lastGpsDriftSpeedMps = speedMps;
    state.lastGpsDriftScore = score;
    while (pending.samples.length > gpsDriftLookbackFeeds) {
      this.drainOldestGpsDriftSample(state);
    }
  }

  recalculatePendingGpsDriftScores(state) {
    const entries = state.pendingStationaryFeeds?.samples;
    if (!entries?.length) return;

    let previousScore = entries[0].previousScore;
    const directRejectionIndices = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const sameTrip = entry.previousSample.tripId === entry.sample.tripId;
      entry.sequenceDelta = sameTrip
        ? entry.sample.stopIndex - entry.previousSample.stopIndex
        : 0;
      entry.progressDeltaMeters = sameTrip
        ? entry.sample.progress - entry.previousSample.progress
        : 0;
      entry.penalties = getGpsDriftPenalties({
        speedMps: entry.speedMps,
        accelerationMps2: entry.accelerationMps2,
        sequenceDelta: entry.sequenceDelta,
        progressDeltaMeters: entry.progressDeltaMeters
      });
      entry.localPenalty = entry.penalties.total;
      entry.previousScore = previousScore;
      entry.historyContribution = applyGpsDriftScoreDecay(0, previousScore);
      entry.score = applyGpsDriftScoreDecay(entry.localPenalty, previousScore);
      entry.rejected = entry.score > gpsDriftScoreThreshold;
      entry.rejectionReason = entry.rejected ? 'direct' : null;
      entry.recheckPreviousScore = null;
      entry.recheckHistoryContribution = null;
      entry.backpropagatedProgressDeltaMeters = null;
      entry.backpropagatedProgressPenalty = 0;
      if (entry.rejected) directRejectionIndices.push(index);
      previousScore = entry.score;
    }
    state.lastGpsDriftScore = previousScore;

    for (const index of directRejectionIndices) {
      let propagatedScore = entries[index].score;
      let nextSample = entries[index].sample;
      for (let precedingIndex = index - 1; precedingIndex >= 0; precedingIndex--) {
        const preceding = entries[precedingIndex];
        preceding.score = recheckGpsDriftEntry(
          preceding,
          nextSample,
          propagatedScore
        );
        if (preceding.score <= gpsDriftScoreThreshold) break;
        preceding.rejected = true;
        preceding.rejectionReason = 'back-propagated';
        propagatedScore = preceding.score;
        nextSample = preceding.sample;
      }
    }
  }

  drainOldestGpsDriftSample(state) {
    const pending = state.pendingStationaryFeeds;
    if (!pending?.samples.length) return;
    const head = pending.samples[0];
    if (head.rejected) {
      pending.samples.shift();
      this.gpsDriftRejectedFeeds++;
      this.rejectedSamples++;
      this.rejectedVehicleObservations++;
      this.onFeedDisposition({
        kind: 'rejected',
        reason: 'gps-drift',
        sample: head.sample,
        rejectionReason: head.rejectionReason,
        score: head.score
      });
      this.onGpsDriftRejection({
        vehicleId: head.sample.vehicleId,
        vehicleName: head.sample.vehicleName,
        entityId: head.sample.entityId,
        tripId: head.sample.tripId,
        routeName: head.sample.routeName,
        sample: head.sample,
        duplicateGpsObservation: head.duplicateGpsObservation,
        score: head.score,
        penalties: head.penalties,
        speedMps: head.speedMps,
        accelerationMps2: head.accelerationMps2,
        sequenceDelta: head.sequenceDelta,
        progressDeltaMeters: head.progressDeltaMeters,
        previousScore: head.previousScore,
        historyContribution: head.historyContribution,
        recheckPreviousScore: head.recheckPreviousScore,
        recheckHistoryContribution: head.recheckHistoryContribution,
        backpropagatedProgressDeltaMeters:
          head.backpropagatedProgressDeltaMeters,
        backpropagatedProgressPenalty: head.backpropagatedProgressPenalty,
        rejectionReason: head.rejectionReason
      });
      return;
    }

    const stationary = this.getPendingStationaryGpsRun(state, pending);
    if (stationary?.recovery) {
      const { samples, recovery, details } = stationary;
      const stationaryPrevious = state.lastSample;
      pending.samples.splice(0, samples.length);
      const mergedSamples = [];
      const preservedDoorOpenSamples = [];
      for (const entry of samples) {
        const sample = entry.sample;
        if (sample.doorOpen) {
          preservedDoorOpenSamples.push(sample);
          this.processStagedSample(state, sample);
        } else {
          mergedSamples.push(sample);
        }
      }
      this.flushPendingDoorOpenSensorSamples(state);
      this.stationaryGpsSamplesDropped += mergedSamples.length;
      for (const sample of mergedSamples) {
        this.onFeedDisposition({
          kind: 'dropped',
          reason: 'stationary-gps-merged',
          sample
        });
      }
      const bridgedPrevious = state.lastSample;
      const recoverySample = recovery.sample;
      const bridgedElapsedSeconds =
        recoverySample.timestamp - bridgedPrevious.timestamp;
      const bridgedProgressMeters =
        recoverySample.progress - bridgedPrevious.progress;
      const correctedSpeedMps = getSpeedCalculation(
        bridgedPrevious,
        recoverySample,
        bridgedElapsedSeconds
      )?.speedMps ?? null;
      this.onGpsSignalLost({
        vehicleId: recoverySample.vehicleId,
        vehicleName: recoverySample.vehicleName,
        entityId: recoverySample.entityId,
        tripId: recoverySample.tripId,
        routeName: recoverySample.routeName,
        previous: stationaryPrevious,
        stationary: samples[0].sample,
        stationarySamples: samples.map((entry) => entry.sample),
        mergedSamples,
        preservedDoorOpenSamples,
        recovery: recoverySample,
        ...details,
        bridgedPrevious,
        bridgedElapsedSeconds,
        bridgedProgressMeters,
        correctedSpeedMps
      });
      return;
    }

    if (state.stopSequenceRegression) {
      const validation = this.validateStopDistanceWithGps(head.sample);
      if (validation.validates) {
        this.recoverStopSequenceRegression(state, head.sample, validation);
        this.replayNextDeferredSample(state, pending, head.sample);
      } else {
        pending.samples.shift();
        this.invalidateStopSequenceRegressionFeed(state, head.sample);
        return;
      }
      pending.samples.shift();
      return;
    }

    if (!state.graphBaselinePending &&
        head.sample.stopIndex < state.lastSample.stopIndex) {
      pending.samples.shift();
      this.processStagedSample(state, head.sample);
      return;
    }

    if (state.graphBaselinePending) {
      this.processStagedSample(state, head.sample);
      this.replayNextDeferredSample(state, pending, head.sample);
      pending.samples.shift();
      return;
    }

    if (head.sample.nextStopDistanceCorrectionDeferred) {
      const replayedSample = this.replayDeferredStopDistanceCorrections(
        state,
        head.sample,
        state.lastProcessedFeedSample
      );
      if (!replayedSample) {
        pending.samples.shift();
        this.recalculatePendingGpsDriftScores(state);
        return;
      }
    }

    this.replayNextDeferredSample(state, pending, head.sample);
    pending.samples.shift();
    this.processStagedSample(state, head.sample);
  }

  replayNextDeferredSample(state, pending, previous) {
    const entry = pending.samples[1];
    if (!entry ||
        entry.rejected ||
        !entry.sample.nextStopDistanceCorrectionDeferred ||
        entry.sample.stopIndex < previous.stopIndex) {
      return;
    }

    const replayedSample = this.replayDeferredStopDistanceCorrections(
      state,
      entry.sample,
      previous
    );
    if (!replayedSample) {
      pending.samples.splice(1, 1);
      this.recalculatePendingGpsDriftScores(state);
    }
  }

  getPendingStationaryGpsRun(state, pending) {
    const first = pending.samples[0]?.sample;
    if (!first || !this.isStationaryFeedCandidate(state.lastSample, first)) {
      return null;
    }
    const stationaryDistanceMeters = getPositionDistanceMeters(
      state.lastSample.position,
      first.position
    );
    const samples = [];
    for (const entry of pending.samples) {
      const sample = entry.sample;
      const distance = getPositionDistanceMeters(first.position, sample.position);
      if (sample.vehicleTimestamp === null ||
          first.vehicleTimestamp === null ||
          distance === null ||
          distance > stationaryGpsToleranceMeters) {
        break;
      }
      samples.push(entry);
    }
    if (!samples.length) return null;

    const next = pending.samples[samples.length];
    if (!next || next.rejected || samples.some((entry) => entry.rejected)) {
      return { samples, recovery: null };
    }
    const recovery = this.getStationaryGpsRecovery({
      initialPrevious: state.lastSample,
      initialSample: first,
      stationaryPosition: first.position,
      samples: samples.map((entry) => entry.sample),
      stationaryIntervalSeconds:
        first.vehicleTimestamp - state.lastSample.vehicleTimestamp,
      stationaryDistanceMeters
    }, next.sample);
    return {
      samples,
      recovery: recovery ? next : null,
      details: recovery
    };
  }

  processStagedSample(state, sample) {
    if (state.graphBaselinePending) {
      state.graphBaselinePending = false;
      state.lastSample = sample;
      state.lastObservedSample = sample;
      state.lastProcessedFeedSample = sample;
      state.lastDoorClosedSample = sample.doorOpen ? null : sample;
      state.doorOpenStopDistanceCorrectionLogged = false;
      state.recentSpeedTransitions = [];
      state.doorOpenObservations = [{
        timestamp: sample.timestamp,
        doorOpen: sample.doorOpen
      }];
      state.doorOpenMovementEvidence = sample.doorOpen
        ? {
            startTimestamp: sample.timestamp,
            firstSample: sample,
            firstPosition: sample.position,
            distanceMeters: 0
          }
        : null;
      state.pendingDoorOpenSensorSamples = sample.doorOpen
        ? { initialSample: sample, samples: [] }
        : null;
      state.pendingDelayedStopDistanceFeeds = null;
      state.nonStoppingWindows = [];
      if (!sample.doorOpen) this.recordSampleArrival(state, sample);
      return;
    }

    if (state.stopSequenceRegression) {
      const validation = this.validateStopDistanceWithGps(sample);
      if (validation.validates) {
        this.recoverStopSequenceRegression(state, sample, validation);
      } else {
        this.invalidateStopSequenceRegressionFeed(state, sample);
      }
      return;
    }

    if (sample.stopIndex < state.lastSample.stopIndex) {
      this.flushPendingDelayedStopDistanceSamples(state);
      this.flushPendingDoorOpenSensorSamples(state);
      if (sample.stopIndex < state.lastSample.stopIndex) {
        this.startStopSequenceRegression(state, sample);
        return;
      }
    }

    if (sample.nextStopDistanceCorrectionDeferred) {
      sample = this.replayDeferredStopDistanceCorrections(
        state,
        sample,
        state.lastProcessedFeedSample
      );
      if (!sample) return;
    }

    state.lastProcessedFeedSample = sample;
    this.processObservedSample(state, sample);
  }

  replayDeferredStopDistanceCorrections(state, sample, previous) {
    const latestFeedSample = state.lastFeedSample;
    const lastSample = state.lastSample;
    state.lastFeedSample = previous;
    state.lastSample = previous;
    sample.nextStopDistanceCorrectionDeferred = false;

    try {
      sample = this.correctNextStopDistance(
        state,
        sample,
        state.indexes.projectPositionOnShapeGeometry,
        state.indexes.measureShapeGeometryDistance,
        previous
      );
      if (sample) {
        sample = this.correctDoorOpenStopDistance(state, sample);
        sample = this.correctShortIntervalStopDistance(
          state,
          sample,
          state.indexes.projectPositionOnShape
        );
        if (state.nextStopDistanceCorrectionActive &&
            state.nextStopDistanceCorrectionSample?.tripId === sample.tripId &&
            state.nextStopDistanceCorrectionSample.stopIndex ===
              sample.stopIndex &&
            state.nextStopDistanceCorrectionSample.stopId === sample.stopId) {
          state.nextStopDistanceCorrectionSample = sample;
        }
      }
    } finally {
      state.lastFeedSample = latestFeedSample;
      state.lastSample = lastSample;
    }

    if (!sample) return null;
    this.recalculatePendingGpsDriftScores(state);
    if (!sample.doorOpen) {
      state.lastDoorClosedSample = sample;
      state.doorOpenStopDistanceCorrectionLogged = false;
    }
    return sample;
  }

  flushPendingGpsDriftSamples(state, force = false) {
    const pending = state.pendingStationaryFeeds;
    if (!pending) return;
    while (pending.samples.length &&
        (force || pending.samples.length > gpsDriftLookbackFeeds)) {
      this.drainOldestGpsDriftSample(state);
    }
    if (pending.samples.length === 0) state.pendingStationaryFeeds = null;
  }

  validateStopDistanceWithGps(sample) {
    const gpsDistanceToStopMeters = getPositionDistanceMeters(
      sample.position,
      sample.stopPosition
    );
    const differenceMeters = gpsDistanceToStopMeters === null
      ? null
      : Math.abs(gpsDistanceToStopMeters - sample.reportedStopDistance);
    return {
      gpsDistanceToStopMeters,
      differenceMeters,
      toleranceMeters: gpsStopDistanceToleranceMeters,
      validates: differenceMeters !== null &&
        differenceMeters <= gpsStopDistanceToleranceMeters
    };
  }

  // Rebase stop distance at a stop change and once more if the provider quickly settles it.
  correctNextStopDistance(
    state,
    sample,
    projectPositionOnShape,
    measureShapeDistance,
    previousFeedSample = state.lastFeedSample
  ) {
    const correctionSample = state.nextStopDistanceCorrectionSample;
    const correctionGrace = state.nextStopDistanceCorrectionGrace;
    const continuingCorrection = state.nextStopDistanceCorrectionActive &&
      correctionSample?.tripId === sample.tripId &&
      correctionSample.stopIndex === sample.stopIndex &&
      correctionSample.stopId === sample.stopId;
    const continuingGrace =
      state.nextStopDistanceCorrectionGraceSamplesRemaining > 0 &&
      correctionGrace?.anchorSample.tripId === sample.tripId &&
      correctionGrace.anchorSample.stopIndex === sample.stopIndex &&
      correctionGrace.anchorSample.stopId === sample.stopId;
    const previous = continuingCorrection
      ? correctionSample
      : continuingGrace
        ? correctionGrace.previousSample
        : previousFeedSample;
    const pendingStopSequenceRegression =
      state.lastSample?.tripId === sample.tripId &&
      sample.stopIndex < state.lastSample.stopIndex;
    if (pendingStopSequenceRegression) {
      state.gpsBasedZeroStopDistanceCorrection = null;
      sample.nextStopDistanceCorrectionPending = false;
      sample.nextStopDistanceCorrectionDeferred = true;
      return sample;
    }
    if (state.stopSequenceRegression) {
      state.gpsBasedZeroStopDistanceCorrection = null;
      sample.nextStopDistanceCorrectionPending = false;
      sample.nextStopDistanceCorrectionDeferred = true;
      return sample;
    }
    const sameTrip = previous.tripId === sample.tripId;
    const nextStopChanged = sameTrip &&
      sample.stopIndex >= previous.stopIndex &&
      (sample.stopIndex !== previous.stopIndex ||
        sample.stopId !== previous.stopId);
    const gpsBasedCorrection = state.gpsBasedZeroStopDistanceCorrection;
    if (gpsBasedCorrection &&
        (!sameTrip ||
         sample.stopIndex !== gpsBasedCorrection.stopIndex ||
         sample.stopId !== gpsBasedCorrection.stopId ||
         sample.reportedStopDistance !== 0)) {
      state.gpsBasedZeroStopDistanceCorrection = null;
    }
    const shapeLegsValid = !nextStopChanged ||
      Array.from(
        { length: sample.stopIndex - previous.stopIndex },
        (_, index) => previous.stopIndex + index
      ).every((legIndex) =>
        sample.trip.shapeDistanceLegValid?.[legIndex] !== false
      );
    const eligibleNextStopChange = nextStopChanged && shapeLegsValid;
    const correctionContinuesAcrossNextStopChange =
      state.nextStopDistanceCorrectionActive &&
      sample.stopIndex > previous.stopIndex &&
      eligibleNextStopChange;
    const sampleDoorsClosed = !sample.doorOpen;
    const doorsClosed = !previous.doorOpen && sampleDoorsClosed;
    if (!sameTrip ||
        (nextStopChanged &&
         !correctionContinuesAcrossNextStopChange)) {
      for (const candidate of
        state.nextStopDistanceCorrectionGrace?.candidates ?? []) {
        candidate.sample.nextStopDistanceCorrectionPending = false;
      }
      state.nextStopDistanceCorrectionActive = false;
      state.nextStopDistanceCorrectionSample = null;
      state.nextStopDistanceCorrectionGraceSamplesRemaining = 0;
      state.nextStopDistanceCorrectionGrace = null;
    }
    const persistentCorrectionActive =
      state.nextStopDistanceCorrectionActive;
    const vehicleTimeDeltaSeconds =
      previous.vehicleTimestamp !== null &&
      sample.vehicleTimestamp !== null
        ? sample.vehicleTimestamp - previous.vehicleTimestamp
        : null;
    const repeatedCorrectedUpdate = vehicleTimeDeltaSeconds === 0 &&
      previous.nextStopDistanceCorrectionApplied &&
      sameTrip &&
      previous.stopIndex === sample.stopIndex &&
      previous.stopId === sample.stopId &&
      sample.feedReportedStopDistance ===
        previous.nextStopDistanceCorrectionRawStopDistance;
    if (repeatedCorrectedUpdate) {
      setReportedStopDistance(sample, previous.reportedStopDistance);
      sample.nextStopDistanceCorrectionPending =
        previous.nextStopDistanceCorrectionPending;
      sample.nextStopDistanceCorrectionApplied = true;
      sample.nextStopDistanceRecalculationApplied =
        previous.nextStopDistanceRecalculationApplied;
      sample.nextStopDistanceCorrectionRawStopDistance =
        previous.nextStopDistanceCorrectionRawStopDistance;
      return sample;
    }
    if (continuingGrace && !(vehicleTimeDeltaSeconds > 0)) {
      return sample;
    }

    if (state.gpsBasedZeroStopDistanceCorrection &&
        sample.reportedStopDistance === 0) {
      const activeCorrection = state.gpsBasedZeroStopDistanceCorrection;
      if (this.correctGpsBasedNextStopZeroDistance(
        state,
        previous,
        sample,
        projectPositionOnShape,
        measureShapeDistance,
        'continued-zero',
        shapeLegsValid,
        activeCorrection.shapePointBounds
      )) {
        return sample;
      }
      this.rejectedSamples++;
      this.rejectedVehicleObservations++;
      this.rejectedFeedPairs++;
      this.onFeedDisposition({
        kind: 'rejected',
        reason: 'gps-based-next-stop-correction-failed',
        sample,
        previous
      });
      return null;
    }

    if (continuingGrace) {
      const gpsMovementMeters = getPositionDistanceMeters(
        previous.position,
        sample.position
      );
      if (gpsMovementMeters === null) return sample;

      const shapeDistanceDelta =
        sample.stopShapeDistance - previous.stopShapeDistance;
      const correctedStopDistance = Math.max(
        0,
        correctionGrace.predictedStopDistance +
          shapeDistanceDelta -
          gpsMovementMeters
      );
      const correctionDifference = Math.abs(
        correctedStopDistance - sample.reportedStopDistance
      );
      const correction = {
        sample,
        previous,
        vehicleTimeDeltaSeconds,
        reportedStopDistance: sample.reportedStopDistance,
        correctedStopDistance,
        gpsMovementMeters,
        shapeDistanceDelta
      };
      const resumedCorrections = [
        ...correctionGrace.candidates,
        correction
      ];
      let shapeConfirmsCorrection = false;
      if (correctionDifference <= gpsStopDistanceToleranceMeters) {
        const shapeEvidence = resumedCorrections.map((candidate) => {
          const expectedStopDistance = getShapeProjectedStopDistance(
            candidate.sample,
            projectPositionOnShape
          );
          return expectedStopDistance === null
            ? null
            : {
                reportedError: Math.abs(
                  candidate.reportedStopDistance - expectedStopDistance
                ),
                correctedError: Math.abs(
                  candidate.correctedStopDistance - expectedStopDistance
                )
              };
        });
        shapeConfirmsCorrection =
          shapeEvidence.every((evidence) =>
            evidence !== null &&
            evidence.correctedError <=
              stopDistanceShapeProjectionToleranceMeters
          ) &&
          shapeEvidence.some((evidence) =>
            evidence.reportedError >
              stopDistanceShapeProjectionToleranceMeters
          );
      }
      if (correctionDifference > gpsStopDistanceToleranceMeters ||
          shapeConfirmsCorrection) {
        state.nextStopDistanceCorrectionActive = true;
        for (const resumedCorrection of resumedCorrections) {
          const correctedSample = resumedCorrection.sample;
          correctedSample.nextStopDistanceCorrectionPending = false;
          correctedSample.nextStopDistanceCorrectionApplied = true;
          correctedSample.nextStopDistanceRecalculationApplied = true;
          correctedSample.nextStopDistanceCorrectionRawStopDistance =
            correctedSample.feedReportedStopDistance;
          setReportedStopDistance(
            correctedSample,
            resumedCorrection.correctedStopDistance
          );
          this.onNextStopDistanceCorrection({
            trigger: 'resumed-after-next-stop-change',
            vehicleId: correctedSample.vehicleId,
            vehicleName: correctedSample.vehicleName,
            entityId: correctedSample.entityId,
            tripId: correctedSample.tripId,
            previous: resumedCorrection.previous,
            current: correctedSample,
            vehicleTimeDeltaSeconds:
              resumedCorrection.vehicleTimeDeltaSeconds,
            reportedStopDistance:
              resumedCorrection.reportedStopDistance,
            correctedStopDistance:
              resumedCorrection.correctedStopDistance,
            gpsMovementMeters: resumedCorrection.gpsMovementMeters,
            shapeDistanceDelta: resumedCorrection.shapeDistanceDelta
          });
        }
        state.nextStopDistanceCorrectionSample = sample;
        state.nextStopDistanceCorrectionGraceSamplesRemaining = 0;
        state.nextStopDistanceCorrectionGrace = null;
        return sample;
      }

      correctionGrace.candidates.push(correction);
      correctionGrace.previousSample = sample;
      correctionGrace.predictedStopDistance = correctedStopDistance;
      state.nextStopDistanceCorrectionGraceSamplesRemaining--;
      if (state.nextStopDistanceCorrectionGraceSamplesRemaining === 0) {
        for (const candidate of correctionGrace.candidates) {
          candidate.sample.nextStopDistanceCorrectionPending = false;
        }
        state.nextStopDistanceCorrectionGrace = null;
      }
      return sample;
    }

    const followUpAfterStopChange = sampleDoorsClosed &&
      shapeLegsValid &&
      previous.nextStopDistanceCorrectionPending &&
      vehicleTimeDeltaSeconds > 0 &&
      vehicleTimeDeltaSeconds < 5;

    sample.nextStopDistanceCorrectionPending =
      eligibleNextStopChange && sampleDoorsClosed;
    if (nextStopChanged &&
        !correctionContinuesAcrossNextStopChange &&
        sampleDoorsClosed &&
        sample.reportedStopDistance === 0 &&
        this.correctGpsBasedNextStopZeroDistance(
         state,
         previous,
         sample,
         projectPositionOnShape,
         measureShapeDistance,
         'next-stop-change',
         shapeLegsValid
        )) {
      return sample;
    }
    if ((!sampleDoorsClosed && !persistentCorrectionActive) ||
        (!eligibleNextStopChange &&
         !followUpAfterStopChange &&
         !persistentCorrectionActive)) {
      return sample;
    }

    const gpsMovementMeters = getPositionDistanceMeters(
      previous.position,
      sample.position
    );
    if (gpsMovementMeters === null) return sample;

    const shapeDistanceDelta =
      sample.stopShapeDistance - previous.stopShapeDistance;
    const correctedStopDistance = Math.max(
      0,
      previous.reportedStopDistance +
        shapeDistanceDelta -
        gpsMovementMeters
    );
    const correctionDifference = Math.abs(
      correctedStopDistance - sample.reportedStopDistance
    );
    if (persistentCorrectionActive &&
        correctionDifference <= stopDistanceShapeProjectionToleranceMeters) {
      if (correctionContinuesAcrossNextStopChange) {
        state.nextStopDistanceCorrectionSample = sample;
      }
      return sample;
    }
    if (correctionDifference < 0.1) {
      return sample;
    }

    state.nextStopDistanceCorrectionActive = persistentCorrectionActive
      ? correctionDifference > stopDistanceShapeProjectionToleranceMeters
      : (eligibleNextStopChange || followUpAfterStopChange) &&
        correctionDifference > gpsStopDistanceToleranceMeters;
    if (eligibleNextStopChange &&
        !state.nextStopDistanceCorrectionActive &&
        correctionDifference <= gpsStopDistanceToleranceMeters) {
      const correction = {
        sample,
        previous,
        vehicleTimeDeltaSeconds,
        reportedStopDistance: sample.reportedStopDistance,
        correctedStopDistance,
        gpsMovementMeters,
        shapeDistanceDelta
      };
      state.nextStopDistanceCorrectionSample = null;
      state.nextStopDistanceCorrectionGraceSamplesRemaining =
        nextStopDistanceCorrectionGraceSampleCount;
      state.nextStopDistanceCorrectionGrace = {
        anchorSample: sample,
        previousSample: sample,
        predictedStopDistance: correctedStopDistance,
        candidates: [correction]
      };
      return sample;
    }

    const reportedStopDistance = sample.reportedStopDistance;
    sample.nextStopDistanceCorrectionApplied = true;
    sample.nextStopDistanceRecalculationApplied = true;
    sample.nextStopDistanceCorrectionRawStopDistance = reportedStopDistance;
    setReportedStopDistance(sample, correctedStopDistance);
    state.nextStopDistanceCorrectionSample =
      state.nextStopDistanceCorrectionActive ? sample : null;
    this.onNextStopDistanceCorrection({
      trigger: eligibleNextStopChange
        ? 'next-stop-change'
        : followUpAfterStopChange
          ? 'follow-up-after-next-stop-change'
          : 'continued-after-next-stop-change',
      vehicleId: sample.vehicleId,
      vehicleName: sample.vehicleName,
      entityId: sample.entityId,
      tripId: sample.tripId,
      previous,
      current: sample,
      vehicleTimeDeltaSeconds,
      reportedStopDistance,
      correctedStopDistance,
      gpsMovementMeters,
      shapeDistanceDelta
    });
    return sample;
  }

  correctGpsBasedNextStopZeroDistance(
    state,
    previous,
    sample,
    projectPositionOnShape,
    measureShapeDistance,
    trigger,
    shapeLegsValid,
    shapePointBounds = null
  ) {
    const vehicleTimeDeltaSeconds =
      previous.vehicleTimestamp !== null &&
      sample.vehicleTimestamp !== null
        ? sample.vehicleTimestamp - previous.vehicleTimestamp
        : null;
    if (vehicleTimeDeltaSeconds === null ||
        vehicleTimeDeltaSeconds <= 0 ||
        !previous.position ||
        !sample.position ||
        !sample.stopPosition) {
      return false;
    }

    const bounds = shapePointBounds ??
      getStopShapePointBounds(sample.trip, sample.stopIndex);
    if (!bounds) return false;
    const projection = projectPositionOnShape(
      sample.trip,
      sample.position,
      bounds
    );
    const previousProjection = projectPositionOnShape(
      sample.trip,
      previous.position,
      bounds
    );
    const stopProjection = projectPositionOnShape(
      sample.trip,
      sample.stopPosition,
      {
        minShapePointIndex: Math.max(0, bounds.stopPointIndex - 1),
        maxShapePointIndex: bounds.stopPointIndex + 1
      }
    );
    if (!projection ||
        !previousProjection ||
        !stopProjection ||
        previousProjection.crossTrackMeters >
          stopDistanceShapeProjectionToleranceMeters ||
        projection.crossTrackMeters >
          stopDistanceShapeProjectionToleranceMeters ||
        stopProjection.crossTrackMeters >
          stopDistanceShapeProjectionToleranceMeters ||
        projection.shapeDistance < previousProjection.shapeDistance ||
        (trigger === 'next-stop-change' &&
         stopProjection.shapeDistance < projection.shapeDistance)) {
      return false;
    }

    const stopIsAhead =
      stopProjection.shapeDistance >= projection.shapeDistance;
    const physicalStopDistanceMagnitude = stopIsAhead
      ? measureShapeDistance(
        sample.trip,
        projection.shapeDistance,
        stopProjection.shapeDistance
      )
      : measureShapeDistance(
        sample.trip,
        stopProjection.shapeDistance,
        projection.shapeDistance
      );
    const physicalStopDistance = physicalStopDistanceMagnitude === null
      ? null
      : stopIsAhead
        ? physicalStopDistanceMagnitude
        : -physicalStopDistanceMagnitude;
    const geometryMovementMeters = measureShapeDistance(
      sample.trip,
      previousProjection.shapeDistance,
      projection.shapeDistance
    );
    const distanceToStopMeters = getPositionDistanceMeters(
      sample.position,
      sample.stopPosition
    );
    if (physicalStopDistance === null ||
        !Number.isFinite(physicalStopDistance) ||
        (trigger === 'next-stop-change' && physicalStopDistance < 0) ||
        geometryMovementMeters === null ||
        !Number.isFinite(geometryMovementMeters) ||
        geometryMovementMeters < 0 ||
        distanceToStopMeters === null ||
        distanceToStopMeters >
          Math.abs(physicalStopDistance) +
            stopDistanceShapeProjectionToleranceMeters) {
      return false;
    }

    if (trigger === 'next-stop-change' &&
        physicalStopDistance <= gpsStopDistanceToleranceMeters) {
      return false;
    }

    const geometryProgress = previous.progress + geometryMovementMeters;
    const calculatedStopShapeDistance = geometryProgress + physicalStopDistance;
    const chainageOffset =
      sample.stopShapeDistance - calculatedStopShapeDistance;
    const correctedStopDistance = physicalStopDistance + chainageOffset;
    if (!Number.isFinite(correctedStopDistance) ||
        correctedStopDistance < 0) {
      return false;
    }

    const reportedStopDistance = sample.reportedStopDistance;
    sample.nextStopDistanceCorrectionPending = false;
    sample.nextStopDistanceCorrectionApplied = true;
    sample.nextStopDistanceCorrectionRawStopDistance =
      sample.feedReportedStopDistance;
    setReportedStopDistance(sample, correctedStopDistance);
    if (trigger === 'next-stop-change') {
      state.gpsBasedZeroStopDistanceCorrection = {
        tripId: sample.tripId,
        stopIndex: sample.stopIndex,
        stopId: sample.stopId,
        startedAt: sample.source,
        shapeLegsValid,
        shapePointBounds: bounds
      };
    }
    this.onGpsBasedNextStopZeroCorrection({
      trigger,
      vehicleId: sample.vehicleId,
      vehicleName: sample.vehicleName,
      entityId: sample.entityId,
      tripId: sample.tripId,
      previous,
      current: sample,
      reportedStopDistance,
      correctedStopDistance,
      physicalStopDistance,
      calculatedStopShapeDistance,
      chainageOffset,
      geometryMovementMeters,
      geometryProgress,
      vehicleTimeDeltaSeconds,
      projection,
      previousProjection,
      stopProjection,
      distanceToStopMeters,
      shapeLegsValid,
      correctionStartedAt:
        state.gpsBasedZeroStopDistanceCorrection?.startedAt ?? sample.source,
      correctionOriginShapeLegsValid:
        state.gpsBasedZeroStopDistanceCorrection?.shapeLegsValid ??
        shapeLegsValid
    });
    return true;
  }

  correctShortIntervalStopDistance(state, sample, projectPositionOnShape) {
    const previous = state.lastFeedSample;
    const vehicleTimeDeltaSeconds =
      previous.vehicleTimestamp !== null &&
      sample.vehicleTimestamp !== null
        ? sample.vehicleTimestamp - previous.vehicleTimestamp
        : null;
    const sameStop = previous.tripId === sample.tripId &&
      previous.stopIndex === sample.stopIndex &&
      previous.stopId === sample.stopId &&
      previous.stopShapeDistance === sample.stopShapeDistance;
    const stopDistanceDropMeters =
      previous.reportedStopDistance - sample.reportedStopDistance;
    const candidateSpeedMps = sameStop &&
        !previous.doorOpen &&
        !sample.doorOpen &&
        vehicleTimeDeltaSeconds > 0 &&
        stopDistanceDropMeters > 0
      ? stopDistanceDropMeters / vehicleTimeDeltaSeconds
      : null;
    const reject = (rejectionReason, evidence = {}) => {
      if (candidateSpeedMps > outlierSpeedLimitMps) {
        this.onShortIntervalStopDistanceCorrectionRejected({
          vehicleId: sample.vehicleId,
          vehicleName: sample.vehicleName,
          entityId: sample.entityId,
          tripId: sample.tripId,
          previous,
          current: sample,
          vehicleTimeDeltaSeconds,
          stopDistanceDropMeters,
          candidateSpeedMps,
          rejectionReason,
          ...evidence
        });
      }
      return sample;
    };
    if (!(candidateSpeedMps > outlierSpeedLimitMps)) return sample;
    if (state.stopSequenceRegression) {
      return reject('stop-sequence-regression');
    }
    if (vehicleTimeDeltaSeconds === null || vehicleTimeDeltaSeconds <= 0) {
      return reject('invalid-vehicle-time-delta');
    }
    if (vehicleTimeDeltaSeconds >= shortIntervalStopDistanceCorrectionSeconds) {
      return reject('interval-outside-window');
    }
    if (previous.tripId !== sample.tripId) return reject('trip-changed');
    if (previous.trip !== sample.trip) return reject('trip-reference-changed');
    if (previous.stopIndex !== sample.stopIndex ||
        previous.stopId !== sample.stopId) {
      return reject('stop-changed');
    }
    if (previous.doorOpen || sample.doorOpen) {
      return reject('door-open');
    }
    if (previous.nextStopDistanceCorrectionApplied ||
        sample.nextStopDistanceCorrectionApplied) {
      return reject('next-stop-correction-already-applied');
    }
    if (previous.stopShapeDistance !== sample.stopShapeDistance) {
      return reject('stop-shape-distance-changed');
    }
    if (sample.trip.shapeDistanceLegValid?.[sample.stopIndex - 1] !== true) {
      return reject('shape-leg-invalid');
    }
    if (!previous.position || !sample.position) {
      return reject('gps-position-missing');
    }

    const pendingSamples = state.pendingStationaryFeeds?.samples;
    if (!pendingSamples?.some((entry) => entry.sample === previous)) {
      return reject('previous-sample-not-buffered');
    }

    const shapeStartDistance = toFiniteNumber(
      sample.trip.stopShapeDist?.[sample.stopIndex - 1]
    );
    const shapeEndDistance = toFiniteNumber(
      sample.trip.stopShapeDist?.[sample.stopIndex]
    );
    if (shapeStartDistance === null ||
        shapeEndDistance === null ||
        shapeEndDistance <= shapeStartDistance ||
        Math.abs(shapeEndDistance - sample.stopShapeDistance) > 0.01) {
      return reject('shape-distance-bounds-invalid');
    }

    const previousProjection = projectPositionOnShape(
      sample.trip,
      previous.position,
      {
        minShapeDistance: shapeStartDistance,
        maxShapeDistance: shapeEndDistance
      }
    );
    const currentProjection = projectPositionOnShape(
      sample.trip,
      sample.position,
      {
        minShapeDistance: shapeStartDistance,
        maxShapeDistance: shapeEndDistance
      }
    );
    if (!previousProjection ||
        !currentProjection) {
      return reject('shape-projection-unavailable');
    }
    if (previousProjection.crossTrackMeters >
        stopDistanceShapeProjectionToleranceMeters ||
        currentProjection.crossTrackMeters >
        stopDistanceShapeProjectionToleranceMeters) {
      return reject('gps-too-far-from-shape', {
        previousCrossTrackMeters: previousProjection.crossTrackMeters,
        currentCrossTrackMeters: currentProjection.crossTrackMeters
      });
    }

    const metersPerUnit = currentProjection.metersPerUnit;
    const previousExpectedStopDistance =
      (shapeEndDistance - previousProjection.shapeDistance) * metersPerUnit;
    const currentExpectedStopDistance =
      (shapeEndDistance - currentProjection.shapeDistance) * metersPerUnit;
    const previousShapeError = Math.abs(
      previous.reportedStopDistance - previousExpectedStopDistance
    );
    const currentShapeError = Math.abs(
      sample.reportedStopDistance - currentExpectedStopDistance
    );
    const shapeEvidence = {
      previousExpectedStopDistance,
      currentExpectedStopDistance,
      previousShapeError,
      currentShapeError,
      previousCrossTrackMeters: previousProjection.crossTrackMeters,
      currentCrossTrackMeters: currentProjection.crossTrackMeters
    };
    if (previousShapeError < staleStopDistanceShapeErrorMeters) {
      return reject('previous-shape-error-too-small', shapeEvidence);
    }
    if (currentShapeError > currentStopDistanceShapeErrorMeters) {
      return reject('current-shape-error-too-large', shapeEvidence);
    }
    if (previousShapeError - currentShapeError <
        minimumStopDistanceShapeErrorImprovementMeters) {
      return reject('shape-error-improvement-too-small', shapeEvidence);
    }

    const correctedPreviousStopDistance =
      sample.reportedStopDistance +
      (currentProjection.shapeDistance - previousProjection.shapeDistance) *
        metersPerUnit;
    if (correctedPreviousStopDistance < 0 ||
        Math.abs(
          correctedPreviousStopDistance - previousExpectedStopDistance
        ) > stopDistanceShapeProjectionToleranceMeters) {
      return reject('reconstructed-previous-distance-inconsistent', {
        ...shapeEvidence,
        correctedPreviousStopDistance
      });
    }

    let earlierCorrection = null;
    const previousPendingIndex = pendingSamples.findIndex(
      (entry) => entry.sample === previous
    );
    const earlier = previousPendingIndex > 0
      ? pendingSamples[previousPendingIndex - 1].sample
      : null;
    const earlierTimeDeltaSeconds =
      earlier?.vehicleTimestamp !== null &&
      earlier?.vehicleTimestamp !== undefined &&
      sample.vehicleTimestamp !== null
        ? sample.vehicleTimestamp - earlier.vehicleTimestamp
        : null;
    if (earlier &&
        earlier.tripId === sample.tripId &&
        earlier.trip === sample.trip &&
        earlier.stopIndex === sample.stopIndex &&
        earlier.stopId === sample.stopId &&
        earlier.stopShapeDistance === sample.stopShapeDistance &&
        earlier.feedReportedStopDistance ===
          previous.feedReportedStopDistance &&
        earlier.reportedStopDistance === earlier.feedReportedStopDistance &&
        previous.reportedStopDistance === previous.feedReportedStopDistance &&
        !earlier.doorOpen &&
        earlierTimeDeltaSeconds > 0 &&
        earlierTimeDeltaSeconds < shortIntervalStopDistanceCorrectionSeconds &&
        !earlier.nextStopDistanceCorrectionApplied &&
        !earlier.stopDistanceCorrectionApplied &&
        earlier.position) {
      const earlierProjection = projectPositionOnShape(
        sample.trip,
        earlier.position,
        {
          minShapeDistance: shapeStartDistance,
          maxShapeDistance: shapeEndDistance
        }
      );
      if (earlierProjection &&
          earlierProjection.crossTrackMeters <=
            stopDistanceShapeProjectionToleranceMeters &&
          earlierProjection.shapeDistance <= previousProjection.shapeDistance &&
          previousProjection.shapeDistance <= currentProjection.shapeDistance) {
        const earlierExpectedStopDistance =
          (shapeEndDistance - earlierProjection.shapeDistance) *
          metersPerUnit;
        const earlierShapeError = Math.abs(
          earlier.reportedStopDistance - earlierExpectedStopDistance
        );
        const correctedEarlierStopDistance =
          sample.reportedStopDistance +
          (currentProjection.shapeDistance - earlierProjection.shapeDistance) *
            metersPerUnit;
        if (earlierShapeError >= staleStopDistanceShapeErrorMeters &&
            earlierShapeError - currentShapeError >=
              minimumStopDistanceShapeErrorImprovementMeters &&
            correctedEarlierStopDistance >= 0 &&
            Math.abs(
              correctedEarlierStopDistance - earlierExpectedStopDistance
            ) <= stopDistanceShapeProjectionToleranceMeters) {
          earlierCorrection = {
            sample: earlier,
            reportedStopDistance: earlier.reportedStopDistance,
            correctedStopDistance: correctedEarlierStopDistance,
            expectedStopDistance: earlierExpectedStopDistance,
            shapeError: earlierShapeError,
            crossTrackMeters: earlierProjection.crossTrackMeters
          };
          setReportedStopDistance(earlier, correctedEarlierStopDistance);
        }
      }
    }

    const reportedStopDistance = previous.reportedStopDistance;
    setReportedStopDistance(previous, correctedPreviousStopDistance);
    this.recalculatePendingGpsDriftScores(state);
    this.onShortIntervalStopDistanceCorrection({
      vehicleId: sample.vehicleId,
      vehicleName: sample.vehicleName,
      entityId: sample.entityId,
      tripId: sample.tripId,
      previous,
      current: sample,
      vehicleTimeDeltaSeconds,
      reportedStopDistance,
      correctedStopDistance: correctedPreviousStopDistance,
      previousExpectedStopDistance,
      currentExpectedStopDistance,
      previousShapeError,
      currentShapeError,
      previousCrossTrackMeters: previousProjection.crossTrackMeters,
      currentCrossTrackMeters: currentProjection.crossTrackMeters,
      earlierCorrection
    });
    return sample;
  }

  startStopSequenceRegression(
    state,
    sample,
    previous = state.lastSample,
    validation = this.validateStopDistanceWithGps(sample)
  ) {
    const correctionSample = state.nextStopDistanceCorrectionSample;
    const canKeepCorrectionBaseline =
      state.nextStopDistanceCorrectionActive &&
      previous?.tripId === sample.tripId &&
      correctionSample?.tripId === previous.tripId &&
      correctionSample.stopIndex === previous.stopIndex &&
      correctionSample.stopId === previous.stopId;
    if (canKeepCorrectionBaseline) {
      state.nextStopDistanceCorrectionSample = previous;
    } else {
      state.nextStopDistanceCorrectionActive = false;
      state.nextStopDistanceCorrectionSample = null;
    }
    state.nextStopDistanceCorrectionGraceSamplesRemaining = 0;
    state.nextStopDistanceCorrectionGrace = null;
    state.gpsBasedZeroStopDistanceCorrection = null;
    state.lastProcessedFeedSample = previous;
    state.lastDoorClosedSample = previous?.doorOpen ? null : previous;

    for (const entry of state.pendingStationaryFeeds?.samples ?? []) {
      const pendingSample = entry.sample;
      if (pendingSample.nextStopDistanceCorrectionApplied ||
          pendingSample.stopDistanceCorrectionApplied) {
        setReportedStopDistance(
          pendingSample,
          pendingSample.feedReportedStopDistance
        );
        pendingSample.nextStopDistanceCorrectionApplied = false;
        pendingSample.nextStopDistanceRecalculationApplied = false;
        pendingSample.nextStopDistanceCorrectionRawStopDistance = null;
        pendingSample.stopDistanceCorrectionApplied = false;
        pendingSample.stopDistanceCorrectionRawValue = null;
      }
      pendingSample.nextStopDistanceCorrectionDeferred = true;
    }
    this.recalculatePendingGpsDriftScores(state);

    const regression = {
      previous,
      firstInvalidSample: sample,
      lastInvalidSample: sample,
      invalidatedFeedCount: 0
    };
    state.stopSequenceRegression = regression;
    this.invalidateStopSequenceRegressionFeed(state, sample);
    this.stopSequenceRegressionEpisodes++;
    this.onStopSequenceRegression({
      phase: 'started',
      previous,
      current: sample,
      firstInvalidSample: sample,
      invalidatedFeedCount: regression.invalidatedFeedCount,
      ...validation
    });
  }

  invalidateStopSequenceRegressionFeed(state, sample) {
    const regression = state.stopSequenceRegression;
    regression.lastInvalidSample = sample;
    regression.invalidatedFeedCount++;
    this.stopSequenceRegressionRejectedFeeds++;
    this.rejectedSamples++;
    this.rejectedVehicleObservations++;
    this.onFeedDisposition({
      kind: 'rejected',
      reason: 'stop-sequence-regression',
      sample
    });
    state.lastFeedSample = sample;
  }

  recoverStopSequenceRegression(state, sample, validation) {
    const regression = state.stopSequenceRegression;
    state.stopSequenceRegression = null;
    const correctionSample = state.nextStopDistanceCorrectionSample;
    const correctionMatchesRecoveredStop =
      state.nextStopDistanceCorrectionActive &&
      correctionSample?.tripId === sample.tripId &&
      correctionSample.stopIndex === sample.stopIndex &&
      correctionSample.stopId === sample.stopId;
    if (correctionMatchesRecoveredStop) {
      state.nextStopDistanceCorrectionSample = sample;
    } else {
      state.nextStopDistanceCorrectionActive = false;
      state.nextStopDistanceCorrectionSample = null;
    }
    state.nextStopDistanceCorrectionGraceSamplesRemaining = 0;
    state.nextStopDistanceCorrectionGrace = null;
    state.gpsBasedZeroStopDistanceCorrection = null;
    this.stopSequenceRegressionRecoveries++;
    this.onStopSequenceRegression({
      phase: 'recovered',
      previous: regression.previous,
      firstInvalidSample: regression.firstInvalidSample,
      lastInvalidSample: regression.lastInvalidSample,
      current: sample,
      invalidatedFeedCount: regression.invalidatedFeedCount,
      ...validation
    });

    state.lastSample = sample;
    state.lastObservedSample = sample;
    state.lastFeedSample = sample;
    state.lastProcessedFeedSample = sample;
    sample.nextStopDistanceCorrectionDeferred = false;
    state.lastDoorClosedSample = sample.doorOpen ? null : sample;
    state.doorOpenStopDistanceCorrectionLogged = false;
    state.recentSpeedTransitions = [];
    state.doorOpenObservations = [{
      timestamp: sample.timestamp,
      doorOpen: sample.doorOpen
    }];
    state.doorOpenMovementEvidence = sample.doorOpen
      ? {
          startTimestamp: sample.timestamp,
          firstSample: sample,
          firstPosition: sample.position,
          distanceMeters: 0
        }
      : null;
    state.pendingDoorOpenSensorSamples = sample.doorOpen
      ? { initialSample: sample, samples: [] }
      : null;
    state.nonStoppingWindows = [];
    state.pendingDelayedStopDistanceFeeds = null;
    if (!sample.doorOpen) this.recordSampleArrival(state, sample);
  }

  inheritRepeatedStopDistanceCorrection(state, sample) {
    const previous = state.lastFeedSample;
    if (state.stopSequenceRegression ||
        !previous?.stopDistanceCorrectionApplied ||
        sample.vehicleTimestamp === null ||
        previous.vehicleTimestamp !== sample.vehicleTimestamp ||
        previous.stopDistanceCorrectionRawValue !==
          sample.feedReportedStopDistance ||
        previous.tripId !== sample.tripId ||
        previous.trip !== sample.trip ||
        previous.stopIndex !== sample.stopIndex ||
        previous.stopId !== sample.stopId ||
        previous.stopShapeDistance !== sample.stopShapeDistance ||
        previous.doorOpen !== sample.doorOpen ||
        !previous.position ||
        !sample.position ||
        previous.position.latitude !== sample.position.latitude ||
        previous.position.longitude !== sample.position.longitude) {
      return false;
    }

    setReportedStopDistance(sample, previous.reportedStopDistance);
    sample.nextStopDistanceRecalculationApplied =
      previous.nextStopDistanceRecalculationApplied;
    return true;
  }

  correctRepeatedStopDistanceSamples(state, sample, correctedDistance) {
    const isRepeatedObservation = (candidate) =>
      candidate &&
      candidate !== sample &&
      candidate.vehicleTimestamp === sample.vehicleTimestamp &&
      candidate.feedReportedStopDistance === sample.feedReportedStopDistance &&
      candidate.tripId === sample.tripId &&
      candidate.trip === sample.trip &&
      candidate.stopIndex === sample.stopIndex &&
      candidate.stopId === sample.stopId &&
      candidate.stopShapeDistance === sample.stopShapeDistance &&
      candidate.doorOpen === sample.doorOpen &&
      candidate.position?.latitude === sample.position?.latitude &&
      candidate.position?.longitude === sample.position?.longitude;

    if (isRepeatedObservation(state.lastSample)) {
      setReportedStopDistance(state.lastSample, correctedDistance);
    }
    const pendingSamples = state.pendingStationaryFeeds?.samples ?? [];
    const sampleIndex = pendingSamples.findIndex(
      (entry) => entry.sample === sample
    );
    for (let index = sampleIndex - 1; index >= 0; index--) {
      const earlier = pendingSamples[index].sample;
      if (!isRepeatedObservation(earlier)) break;
      setReportedStopDistance(earlier, correctedDistance);
    }
  }

  correctDoorOpenStopDistance(state, sample) {
    if (this.inheritRepeatedStopDistanceCorrection(state, sample)) {
      return sample;
    }
    if (!sample.doorOpen) {
      return this.correctClosedDoorStopDistanceSnap(state, sample);
    }

    const previous = state.lastDoorClosedSample;
    if (state.doorSensorStuck ||
        sample.reportedStopDistance !== 0 ||
        !previous ||
        previous.tripId !== sample.tripId ||
        previous.stopIndex !== sample.stopIndex ||
        previous.stopId !== sample.stopId) {
      return sample;
    }

    const distanceToStopMeters = getPositionDistanceMeters(
      sample.position,
      sample.stopPosition
    );
    if (distanceToStopMeters === null) return sample;

    const gpsMovementMeters = getPositionDistanceMeters(
      previous.position,
      sample.position
    );
    if (gpsMovementMeters === null) return sample;

    if (distanceToStopMeters <= gpsStopDistanceToleranceMeters) {
      const previousFeed = state.lastFeedSample;
      if (!previousFeed ||
          previousFeed.doorOpen ||
          previousFeed !== previous) {
        return sample;
      }
      const previousDistanceToStopMeters = getPositionDistanceMeters(
        previousFeed.position,
        sample.stopPosition
      );
      if (previousDistanceToStopMeters === null) return sample;

      const elapsedSeconds = sample.timestamp - previousFeed.timestamp;
      const candidateSpeed = getSpeedCalculation(
        previousFeed,
        sample,
        elapsedSeconds
      );
      if (candidateSpeed?.speedMps > outlierSpeedLimitMps &&
          distanceToStopMeters > 0) {
        const correctedProgress =
          sample.stopShapeDistance - distanceToStopMeters;
        const correctedCandidateSpeed = getSpeedCalculation(
          previousFeed,
          { ...sample, progress: correctedProgress },
          elapsedSeconds
        );
        if (!correctedCandidateSpeed ||
            correctedCandidateSpeed.speedMps <= outlierSpeedLimitMps) {
          const reportedStopDistance = sample.reportedStopDistance;
          setReportedStopDistance(sample, distanceToStopMeters);
          this.reportDoorOpenStopDistanceCorrection(state, {
            sample,
            previous: previousFeed,
            correctedTarget: 'current',
            correctionBasis: 'current GPS-to-stop distance after zero ' +
              'stop_distance caused an adjusted progress-speed spike',
            candidateSpeedMps: candidateSpeed.speedMps,
            speedThresholdMps: outlierSpeedLimitMps,
            reportedStopDistance,
            correctedStopDistance: distanceToStopMeters,
            gpsMovementMeters,
            previousDistanceToStopMeters,
            distanceToStopMeters
          });
          return sample;
        }
      }

      if (previousFeed.reportedStopDistance -
          previousDistanceToStopMeters <= gpsStopDistanceToleranceMeters) {
        return sample;
      }

      if ((state.nextStopDistanceCorrectionActive ||
           state.nextStopDistanceCorrectionGraceSamplesRemaining > 0) &&
          previousFeed.nextStopDistanceRecalculationApplied) {
        return sample;
      }

      const reportedStopDistance = previousFeed.reportedStopDistance;
      setReportedStopDistance(previousFeed, previousDistanceToStopMeters);
      this.correctRepeatedStopDistanceSamples(
        state,
        previousFeed,
        previousDistanceToStopMeters
      );
      this.recalculatePendingGpsDriftScores(state);
      this.reportDoorOpenStopDistanceCorrection(state, {
        sample,
        previous: previousFeed,
        correctedTarget: 'previous',
        reportedStopDistance,
        correctedStopDistance: previousDistanceToStopMeters,
        gpsMovementMeters,
        previousDistanceToStopMeters,
        distanceToStopMeters
      });
      return sample;
    }

    const correctedStopDistance = Math.max(
      0,
      previous.reportedStopDistance - gpsMovementMeters
    );
    if (correctedStopDistance === sample.reportedStopDistance) return sample;

    const reportedStopDistance = sample.reportedStopDistance;
    setReportedStopDistance(sample, correctedStopDistance);
    this.reportDoorOpenStopDistanceCorrection(state, {
      sample,
      previous,
      correctedTarget: 'current',
      reportedStopDistance,
      correctedStopDistance,
      gpsMovementMeters,
      previousDistanceToStopMeters: getPositionDistanceMeters(
        previous.position,
        sample.stopPosition
      ),
      distanceToStopMeters
    });
    return sample;
  }

  correctClosedDoorStopDistanceSnap(state, sample) {
    const previous = state.lastFeedSample;
    if (state.stopSequenceRegression ||
        sample.doorOpen ||
        sample.reportedStopDistance !== 0 ||
        !previous ||
        previous.doorOpen ||
        previous.tripId !== sample.tripId ||
        previous.trip !== sample.trip ||
        previous.stopIndex !== sample.stopIndex ||
        previous.stopId !== sample.stopId ||
        previous.stopShapeDistance !== sample.stopShapeDistance ||
        previous.nextStopDistanceCorrectionApplied ||
        sample.nextStopDistanceCorrectionApplied ||
        previous.reportedStopDistance <= 0 ||
        !previous.position ||
        !sample.position) {
      return sample;
    }

    const vehicleTimeDeltaSeconds =
      Number.isFinite(previous.vehicleTimestamp) &&
      Number.isFinite(sample.vehicleTimestamp)
        ? sample.vehicleTimestamp - previous.vehicleTimestamp
        : null;
    if (!(vehicleTimeDeltaSeconds > 0)) return sample;

    const candidateSpeedMps =
      (previous.reportedStopDistance - sample.reportedStopDistance) /
      vehicleTimeDeltaSeconds;

    const previousDistanceToStopMeters = getPositionDistanceMeters(
      previous.position,
      sample.stopPosition
    );
    const distanceToStopMeters = getPositionDistanceMeters(
      sample.position,
      sample.stopPosition
    );
    const gpsMovementMeters = getPositionDistanceMeters(
      previous.position,
      sample.position
    );
    if (previousDistanceToStopMeters === null ||
        distanceToStopMeters === null ||
        gpsMovementMeters === null ||
        previousDistanceToStopMeters > closedDoorStopDistanceSnapRadiusMeters ||
        distanceToStopMeters > closedDoorStopDistanceSnapRadiusMeters) {
      return sample;
    }

    const gpsDistanceClosureMeters =
      previousDistanceToStopMeters - distanceToStopMeters;
    const gpsMovementToleranceMeters = Math.max(
      gpsStopDistanceMovementToleranceMeters,
      gpsMovementMeters * gpsStopDistanceMovementToleranceRatio
    );
    if (!(gpsDistanceClosureMeters > 0) ||
        !(gpsMovementMeters > 0) ||
        Math.abs(gpsMovementMeters - gpsDistanceClosureMeters) >
          gpsMovementToleranceMeters) {
      return sample;
    }

    const correctedSpeedMps =
      gpsDistanceClosureMeters / vehicleTimeDeltaSeconds;

    const pendingSamples = state.pendingStationaryFeeds?.samples;
    if (!pendingSamples?.some((entry) => entry.sample === previous)) {
      return sample;
    }

    const reportedPreviousStopDistance = previous.reportedStopDistance;
    const reportedStopDistance = sample.reportedStopDistance;
    setReportedStopDistance(previous, previousDistanceToStopMeters);
    this.correctRepeatedStopDistanceSamples(
      state,
      previous,
      previousDistanceToStopMeters
    );
    setReportedStopDistance(sample, distanceToStopMeters);
    this.recalculatePendingGpsDriftScores(state);
    this.onClosedDoorStopDistanceCorrection({
      vehicleId: sample.vehicleId,
      vehicleName: sample.vehicleName,
      entityId: sample.entityId,
      tripId: sample.tripId,
      routeName: sample.routeName,
      previous,
      current: sample,
      reportedPreviousStopDistance,
      reportedStopDistance,
      correctedPreviousStopDistance: previousDistanceToStopMeters,
      correctedStopDistance: distanceToStopMeters,
      previousDistanceToStopMeters,
      distanceToStopMeters,
      gpsMovementMeters,
      gpsDistanceClosureMeters,
      vehicleTimeDeltaSeconds,
      candidateSpeedMps,
      correctedSpeedMps
    });
    return sample;
  }

  reportDoorOpenStopDistanceCorrection(state, {
    sample,
    previous,
    correctedTarget,
    reportedStopDistance,
    correctedStopDistance,
    gpsMovementMeters,
    previousDistanceToStopMeters,
    distanceToStopMeters,
    correctionBasis = null,
    candidateSpeedMps = null,
    speedThresholdMps = null
  }) {
    if (state.doorOpenStopDistanceCorrectionLogged) return;
    this.onDoorOpenStopDistanceCorrection({
      vehicleId: sample.vehicleId,
      vehicleName: sample.vehicleName,
      entityId: sample.entityId,
      tripId: sample.tripId,
      routeName: sample.routeName,
      previous,
      current: sample,
      correctedTarget,
      reportedStopDistance,
      correctedStopDistance,
      gpsMovementMeters,
      previousDistanceToStopMeters,
      distanceToStopMeters,
      correctionBasis,
      candidateSpeedMps,
      speedThresholdMps
    });
    state.doorOpenStopDistanceCorrectionLogged = true;
  }

  bufferDoorOpenSensorSample(state, sample) {
    const pending = state.pendingDoorOpenSensorSamples ?? {
      initialSample: null,
      samples: []
    };
    state.pendingDoorOpenSensorSamples = pending;
    pending.samples.push(sample);
    while (pending.samples.length +
        (pending.initialSample ? 1 : 0) > doorSensorLookbackSamples) {
      if (pending.initialSample) {
        this.recordSampleArrival(state, pending.initialSample);
        pending.initialSample = null;
      }
      this.commitSample(state, pending.samples.shift(), true);
    }
    if (!pending.initialSample && pending.samples.length === 0) {
      state.pendingDoorOpenSensorSamples = null;
    }
  }

  discardPendingDoorOpenSensorSamples(state, pending) {
    const rejectedPairs = pending.samples.length;
    this.rejectedFeedPairs += rejectedPairs;
    this.doorSensorRejectedFeedPairs += rejectedPairs;
    state.pendingDoorOpenSensorSamples = null;
    state.recentSpeedTransitions = [];
    state.nonStoppingWindows = [];
  }

  flushPendingDoorOpenSensorSamples(state) {
    const pending = state.pendingDoorOpenSensorSamples;
    if (!pending) return;
    state.pendingDoorOpenSensorSamples = null;
    if (pending.initialSample) {
      this.recordSampleArrival(state, pending.initialSample);
    }
    for (const sample of pending.samples) this.commitSample(state, sample, true);
  }

  processObservedSample(state, sample) {
    if (sample.doorOpen) {
      if (!state.doorSensorStuck) {
        const pending = state.pendingDoorOpenSensorSamples ?? {
          initialSample: null,
          samples: []
        };
        if (this.updateDoorSensorEvidence(state, sample, pending)) {
          this.discardPendingDoorOpenSensorSamples(state, pending);
        }
      }
    } else {
      this.flushPendingDoorOpenSensorSamples(state);
      this.updateDoorSensorEvidence(state, sample);
    }

    const pendingStopDistance = state.pendingDelayedStopDistanceFeeds;
    if (pendingStopDistance) {
      if (sample.stopIndex !== pendingStopDistance.stopIndex ||
          sample.stopId !== pendingStopDistance.stopId) {
        this.flushPendingDelayedStopDistanceSamples(state);
      } else if (sample.vehicleTimestamp !== null &&
          sample.reportedStopDistance !== pendingStopDistance.stopDistance) {
        state.pendingDelayedStopDistanceFeeds = null;
        const mergedSamples = [];
        const preservedDoorOpenSamples = [];
        for (const pendingSample of pendingStopDistance.samples) {
          if (pendingSample.doorOpen) {
            preservedDoorOpenSamples.push(pendingSample);
            this.commitSample(state, pendingSample);
          } else {
            mergedSamples.push(pendingSample);
          }
        }
        this.flushPendingDoorOpenSensorSamples(state);
        const bridgedPrevious = state.lastSample;
        const bridgedElapsedSeconds = sample.timestamp - bridgedPrevious.timestamp;
        const bridgedProgressMeters = sample.progress - bridgedPrevious.progress;
        const correctedSpeedMps = getSpeedCalculation(
          bridgedPrevious,
          sample,
          bridgedElapsedSeconds
        )?.speedMps ?? null;
        this.onDelayedStopDistance({
          vehicleId: sample.vehicleId,
          vehicleName: sample.vehicleName,
          entityId: sample.entityId,
          tripId: sample.tripId,
          routeName: sample.routeName,
          previous: pendingStopDistance.previous,
          initialPrevious: pendingStopDistance.initialPrevious,
          pendingSamples: pendingStopDistance.samples,
          mergedSamples,
          preservedDoorOpenSamples,
          updated: sample,
          stopDistanceBefore: pendingStopDistance.stopDistance,
          gpsMovementMeters: getPositionDistanceMeters(
            pendingStopDistance.initialPrevious.position,
            sample.position
          ),
          bridgedPrevious,
          bridgedElapsedSeconds,
          bridgedProgressMeters,
          correctedSpeedMps
        });
        this.commitSample(state, sample);
        return;
      }

      if (sample.vehicleTimestamp !== null &&
          !sample.doorOpen &&
          sample.position !== null &&
          sample.reportedStopDistance === pendingStopDistance.stopDistance) {
        pendingStopDistance.samples.push(sample);
        while (pendingStopDistance.samples.length > gpsDriftLookbackFeeds) {
          const oldest = pendingStopDistance.samples.shift();
          this.commitSample(state, oldest);
          pendingStopDistance.previous = state.lastSample;
        }
        return;
      }

      this.flushPendingDelayedStopDistanceSamples(state);
    }

    if (this.isDelayedStopDistanceCandidate(state.lastSample, sample)) {
      state.pendingDelayedStopDistanceFeeds = {
        initialPrevious: state.lastSample,
        previous: state.lastSample,
        stopIndex: sample.stopIndex,
        stopId: sample.stopId,
        stopDistance: sample.reportedStopDistance,
        samples: [sample]
      };
      return;
    }

    this.commitSample(state, sample);
  }

  isDelayedStopDistanceCandidate(previous, current) {
    if (current.doorOpen ||
        previous.stopIndex !== current.stopIndex ||
        previous.stopId !== current.stopId ||
        previous.vehicleTimestamp === null ||
        current.vehicleTimestamp === null ||
        current.reportedStopDistance !== previous.reportedStopDistance) {
      return false;
    }
    const gpsMovementMeters =
      getPositionDistanceMeters(previous.position, current.position);
    return gpsMovementMeters !== null &&
      gpsMovementMeters > delayedStopDistanceGpsThresholdMeters;
  }

  isStationaryFeedCandidate(previous, current) {
    if (previous.vehicleTimestamp === null ||
        current.vehicleTimestamp === null ||
        current.vehicleTimestamp - previous.vehicleTimestamp <=
          stationaryTimestampGapSeconds) {
      return false;
    }
    const distance = getPositionDistanceMeters(previous.position, current.position);
    return distance !== null && distance <= stationaryGpsToleranceMeters;
  }

  getStationaryGpsRecovery(pending, next) {
    const stationary = pending.samples.at(-1);
    if (stationary.vehicleTimestamp === null || next.vehicleTimestamp === null) {
      return null;
    }
    const recoveryIntervalSeconds =
      next.vehicleTimestamp - stationary.vehicleTimestamp;
    if (recoveryIntervalSeconds <= 0 ||
        recoveryIntervalSeconds >= movingTimestampGapSeconds) {
      return null;
    }
    const recoveryDistanceMeters =
      getPositionDistanceMeters(pending.stationaryPosition, next.position);
    const lastFeedMovementMeters =
      getPositionDistanceMeters(stationary.position, next.position);
    if (recoveryDistanceMeters === null ||
        recoveryDistanceMeters <= stationaryGpsToleranceMeters) {
      return null;
    }
    if (lastFeedMovementMeters === null ||
        lastFeedMovementMeters <= stationaryGpsToleranceMeters) {
      return null;
    }
    return {
      stationaryIntervalSeconds: pending.stationaryIntervalSeconds,
      recoveryIntervalSeconds,
      stationaryDistanceMeters: pending.stationaryDistanceMeters,
      recoveryDistanceMeters,
      lastFeedMovementMeters
    };
  }

  commitSample(state, sample, bypassDoorOpenBuffer = false) {
    if (!bypassDoorOpenBuffer && sample.doorOpen && !state.doorSensorStuck) {
      this.bufferDoorOpenSensorSample(state, sample);
      return;
    }
    if (!sample.doorOpen) this.flushPendingDoorOpenSensorSamples(state);
    if (this.processTransition(state, sample)) state.lastSample = sample;
    this.recordSampleArrival(state, sample);
  }

  recordSampleArrival(state, sample) {
    if (sample.distanceToStop >= 0 &&
        sample.distanceToStop <= arrivalToleranceMeters &&
        (sample.doorOpen || sample.currentStatus === 1) &&
        !(state.doorSensorStuck && sample.doorOpen)) {
      this.recordArrival(state, sample.stopIndex, sample.timestamp);
    }
  }

  flushPendingDelayedStopDistanceSamples(state) {
    if (!state.pendingDelayedStopDistanceFeeds) return;
    const { samples } = state.pendingDelayedStopDistanceFeeds;
    state.pendingDelayedStopDistanceFeeds = null;
    for (const sample of samples) this.commitSample(state, sample);
  }

  flushPendingStationaryFeeds() {
    for (const state of this.vehicleStates.values()) {
      this.flushPendingGpsDriftSamples(state, true);
      this.flushPendingDelayedStopDistanceSamples(state);
      this.flushPendingDoorOpenSensorSamples(state);
    }
  }

  processTransition(state, sample) {
    const previous = state.lastSample;
    const previousObserved = state.lastObservedSample;
    const observedElapsedSeconds = sample.timestamp - previousObserved.timestamp;
    const elapsedSeconds = sample.timestamp - previous.timestamp;
    if (elapsedSeconds <= 0) {
      this.rejectedFeedPairs++;
      this.onFeedDisposition({
        kind: 'pair-rejected',
        reason: 'non-positive-elapsed-time',
        sample,
        previous
      });
      return false;
    }
    if (sample.progress < previous.progress) {
      this.rejectedFeedPairs++;
      this.onFeedDisposition({
        kind: 'pair-rejected',
        reason: 'backward-progress',
        sample,
        previous
      });
      return false;
    }

    const rejectForStuckSensor =
      state.doorSensorStuck && (previous.doorOpen || sample.doorOpen);
    if (observedElapsedSeconds > 0) {
      if (!rejectForStuckSensor) {
        this.collectWaiting(state, previousObserved, sample, observedElapsedSeconds);
      }
      state.lastObservedSample = sample;
    }

    const historyCutoff = previous.timestamp - nonStoppingWindowSeconds;
    state.recentSpeedTransitions = state.recentSpeedTransitions.filter(
      (transition) => transition.current.timestamp >= historyCutoff
    );
    state.doorOpenObservations = state.doorOpenObservations.filter(
      (observation) => observation.timestamp >= historyCutoff
    );
    state.doorOpenObservations.push({
      timestamp: sample.timestamp,
      doorOpen: sample.doorOpen
    });
    this.updateNonStoppingWindowsForDoorEvidence(state, sample);

    if (rejectForStuckSensor) {
      this.rejectedFeedPairs++;
      this.doorSensorRejectedFeedPairs++;
      this.onFeedDisposition({
        kind: 'pair-rejected',
        reason: 'stuck-door-sensor',
        sample,
        previous
      });
      this.finalizeNonStoppingWindows(state, sample.timestamp);
      return true;
    }

    this.collectSpeeds(state, previous, sample, elapsedSeconds);
    for (const crossing of this.getStopCrossings(state, previous, sample, elapsedSeconds)) {
      if (!previous.doorOpen && !sample.doorOpen) {
        this.addNonStoppingWindow(state, crossing);
      }
      this.recordArrival(state, crossing.stopIndex, crossing.timestamp);
    }
    this.finalizeNonStoppingWindows(state, sample.timestamp);
    return true;
  }

  updateDoorSensorEvidence(state, current, pending) {
    if (!current.doorOpen) {
      state.doorOpenMovementEvidence = null;
      return false;
    }

    if (!state.doorOpenMovementEvidence) {
      state.doorOpenMovementEvidence = {
        startTimestamp: current.timestamp,
        firstSample: current,
        firstPosition: current.position,
        distanceMeters: 0
      };
    }

    const evidence = state.doorOpenMovementEvidence;
    if (!evidence.firstPosition && current.position) {
      evidence.firstSample = current;
      evidence.firstPosition = current.position;
      evidence.startTimestamp = current.timestamp;
    }
    evidence.distanceMeters = getPositionDistanceMeters(
      evidence.firstPosition,
      current.position
    ) ?? 0;
    if (state.doorSensorStuck ||
        evidence.distanceMeters < doorSensorGpsMovementThresholdMeters) {
      return false;
    }

    state.doorSensorStuck = true;
    this.doorSensorStuckTrips++;
    this.onDoorSensorStuck({
      vehicleId: current.vehicleId,
      vehicleName: current.vehicleName,
      tripId: current.tripId,
      source: current.source,
      firstOpenSample: evidence.firstSample,
      startTimestamp: evidence.startTimestamp,
      detectedTimestamp: current.timestamp,
      startPosition: evidence.firstPosition,
      detectedPosition: current.position,
      distanceMeters: evidence.distanceMeters,
      thresholdMeters: doorSensorGpsMovementThresholdMeters,
      bufferedFeedCount:
        pending.samples.length + (pending.initialSample ? 1 : 0)
    });
    return true;
  }

  collectWaiting(state, previous, current, elapsedSeconds) {
    const byStop = new Map();
    if (previous.doorOpen) {
      byStop.set(previous.stopIndex, (byStop.get(previous.stopIndex) ?? 0) + elapsedSeconds / 2);
    }
    if (current.doorOpen) {
      byStop.set(current.stopIndex, (byStop.get(current.stopIndex) ?? 0) + elapsedSeconds / 2);
    }
    for (const [stopIndex, seconds] of byStop) {
      this.addWaitingContribution(state, stopIndex, seconds);
    }
  }

  collectSpeeds(state, previous, current, elapsedSeconds) {
    const calculation = getSpeedCalculation(previous, current, elapsedSeconds);
    if (!calculation) return;
    const { adjustedSeconds, distanceMeters: distance, speedMps } = calculation;
    const transition = {
      id: this.nextSpeedTransitionId++,
      previous,
      current,
      speedMps
    };
    state.recentSpeedTransitions.push(transition);

    if (speedMps > outlierSpeedLimitMps) {
      const fromStop = state.trip.stops[previous.stopIndex];
      const toStop = state.trip.stops[current.stopIndex];
      this.speedOutlierCount++;
      this.onSpeedOutlier({
        limitMps: outlierSpeedLimitMps,
        speedMps,
        vehicleId: current.vehicleId,
        vehicleName: current.vehicleName,
        entityId: current.entityId,
        tripId: current.tripId,
        routeId: current.routeId,
        fromStop: {
          id: previous.stopId,
          name: fromStop?.name ?? ''
        },
        toStop: {
          id: current.stopId,
          name: toStop?.name ?? ''
        },
        previous: {
          source: previous.source,
          timestamp: previous.timestamp,
          position: previous.position,
          doorOpen: previous.doorOpen,
          reportedStopDistance: previous.reportedStopDistance,
          progress: previous.progress,
          shapeDistance: Number(state.trip.stopShapeDist[previous.stopIndex])
        },
        current: {
          source: current.source,
          timestamp: current.timestamp,
          position: current.position,
          doorOpen: current.doorOpen,
          reportedStopDistance: current.reportedStopDistance,
          progress: current.progress,
          shapeDistance: Number(state.trip.stopShapeDist[current.stopIndex])
        },
        distanceMeters: distance,
        shapeDistanceMeters:
          Number(state.trip.stopShapeDist[current.stopIndex]) -
          Number(state.trip.stopShapeDist[previous.stopIndex]),
        elapsedSeconds,
        adjustedSeconds
      });
    }

    const speedSamples = this.collectSpeedBucketSamples(
      state,
      transition,
      previous.progress,
      current.progress
    );
    for (const { stopIndex, sample } of speedSamples) {
      if (!state.pendingSpeeds.get(stopIndex)?.length) this.pendingLegs++;
      addPendingSpeed(state, stopIndex, sample);
    }
    for (const window of state.nonStoppingWindows) {
      this.collectNonStoppingWindowSamples(state, window, transition);
    }
  }

  collectSpeedBucketSamples(state, transition, progressStart, progressEnd) {
    if (progressEnd <= progressStart) return [];
    const { previous, current, speedMps } = transition;
    const stopDistances = state.trip.stopShapeDist;
    const firstStopIndex = Math.max(
      1,
      Math.min(previous.stopIndex, current.stopIndex)
    );
    const lastStopIndex = Math.min(
      stopDistances.length - 1,
      Math.max(previous.stopIndex, current.stopIndex) + 1
    );
    const samples = [];

    for (let stopIndex = firstStopIndex; stopIndex <= lastStopIndex; stopIndex++) {
      if (state.trip.shapeDistanceLegValid?.[stopIndex - 1] === false) continue;
      const segmentStart = Number(stopDistances[stopIndex - 1]);
      const segmentEnd = Number(stopDistances[stopIndex]);
      const overlapStart = Math.max(progressStart, segmentStart);
      const overlapEnd = Math.min(progressEnd, segmentEnd);
      const segmentLength = segmentEnd - segmentStart;
      if (!Number.isFinite(segmentLength) ||
          segmentLength <= 0 ||
          overlapEnd <= overlapStart) {
        continue;
      }

      const localStart = overlapStart - segmentStart;
      const localEnd = overlapEnd - segmentStart;
      const firstBucket = Math.floor(localStart / bucketSizeMeters);
      const lastBucket = Math.ceil(localEnd / bucketSizeMeters) - 1;
      for (let bucket = firstBucket; bucket <= lastBucket; bucket++) {
        samples.push({
          stopIndex,
          sample: {
            sampleKey: `${transition.id}:${stopIndex}:${bucket}`,
            fromStopId: state.stopIdByIndex.get(
              Number(state.trip.stops[stopIndex - 1]._id)
            ),
            toStopId: state.stopIdByIndex.get(
              Number(state.trip.stops[stopIndex]._id)
            ),
            bucket,
            speedMps
          }
        });
      }
    }
    return samples;
  }

  getStopCrossings(state, previous, current, elapsedSeconds) {
    if (current.progress < previous.progress) return [];
    const progressDelta = current.progress - previous.progress;
    const crossings = [];
    for (let stopIndex = 1; stopIndex < state.trip.stopShapeDist.length; stopIndex++) {
      if (state.trip.shapeDistanceLegValid?.[stopIndex - 1] === false) continue;
      const stopDistance = Number(state.trip.stopShapeDist[stopIndex]);
      if (stopDistance < previous.progress || stopDistance > current.progress) continue;
      const progress = stopDistance - previous.progress;
      const fraction = progressDelta === 0 ? 1 : progress / progressDelta;
      crossings.push({
        stopIndex,
        timestamp: previous.timestamp + elapsedSeconds * fraction
      });
    }
    return crossings;
  }

  updateNonStoppingWindowsForDoorEvidence(state, sample) {
    if (!sample.doorOpen) return;
    for (const window of state.nonStoppingWindows) {
      if (sample.timestamp >= window.start && sample.timestamp <= window.end) {
        window.hasDoorOpen = true;
        window.samples.clear();
      }
    }
  }

  addNonStoppingWindow(state, crossing) {
    if (state.nonStoppingStopsSeen.has(crossing.stopIndex)) return;
    state.nonStoppingStopsSeen.add(crossing.stopIndex);
    const windowStart = crossing.timestamp - nonStoppingWindowSeconds;
    const windowEnd = crossing.timestamp + nonStoppingWindowSeconds;
    const window = {
      stopIndex: crossing.stopIndex,
      start: windowStart,
      end: windowEnd,
      hasDoorOpen: state.doorOpenObservations.some((observation) =>
        observation.doorOpen &&
        observation.timestamp >= windowStart &&
        observation.timestamp <= windowEnd
      ),
      samples: new Map()
    };
    if (window.hasDoorOpen) return;

    state.nonStoppingWindows.push(window);
    for (const transition of state.recentSpeedTransitions) {
      this.collectNonStoppingWindowSamples(state, window, transition);
    }
  }

  collectNonStoppingWindowSamples(state, window, transition) {
    const { previous, current } = transition;
    if (window.hasDoorOpen ||
        previous.doorOpen ||
        current.doorOpen ||
        current.timestamp <= window.start ||
        previous.timestamp >= window.end) {
      return;
    }

    const intervalStart = Math.max(previous.timestamp, window.start);
    const intervalEnd = Math.min(current.timestamp, window.end);
    const elapsedSeconds = current.timestamp - previous.timestamp;
    if (intervalEnd <= intervalStart || elapsedSeconds <= 0) return;
    const progressDelta = current.progress - previous.progress;
    const progressStart = previous.progress +
      progressDelta * (intervalStart - previous.timestamp) / elapsedSeconds;
    const progressEnd = previous.progress +
      progressDelta * (intervalEnd - previous.timestamp) / elapsedSeconds;

    for (const { stopIndex, sample } of this.collectSpeedBucketSamples(
      state,
      transition,
      progressStart,
      progressEnd
    )) {
      window.samples.set(sample.sampleKey, { stopIndex, sample });
    }
  }

  finalizeNonStoppingWindows(state, timestamp) {
    const activeWindows = [];
    for (const window of state.nonStoppingWindows) {
      if (timestamp < window.end) {
        activeWindows.push(window);
        continue;
      }
      if (window.hasDoorOpen) continue;
      for (const { stopIndex, sample } of window.samples.values()) {
        this.addPendingNonStoppingSpeed(state, stopIndex, sample);
      }
    }
    state.nonStoppingWindows = activeWindows;
  }

  addPendingNonStoppingSpeed(state, stopIndex, sample) {
    const keys = state.nonStoppingSpeedKeys.get(stopIndex) ?? new Set();
    if (keys.has(sample.sampleKey)) return;
    keys.add(sample.sampleKey);
    state.nonStoppingSpeedKeys.set(stopIndex, keys);

    const trafficClass = state.legClasses.get(stopIndex);
    if (trafficClass) {
      this.addSpeedSample(sample, trafficClass, true);
      return;
    }
    const samples = state.pendingNonStoppingSpeeds.get(stopIndex) ?? [];
    samples.push(sample);
    state.pendingNonStoppingSpeeds.set(stopIndex, samples);
  }

  recordArrival(state, stopIndex, timestamp) {
    if (state.arrivals.has(stopIndex)) return;
    state.arrivals.set(stopIndex, timestamp);
    if (stopIndex === 0) return;

    const previousArrival = state.arrivals.get(stopIndex - 1);
    const actualDuration = timestamp - previousArrival;
    const expectedDuration =
      Number(state.trip.stopArr?.[stopIndex]) -
      Number(state.trip.stopArr?.[stopIndex - 1]);
    const trafficClass = previousArrival === undefined
      ? null
      : classifyDuration(actualDuration, expectedDuration);

    const samples = state.pendingSpeeds.get(stopIndex) ?? [];
    const nonStoppingSamples =
      state.pendingNonStoppingSpeeds.get(stopIndex) ?? [];
    state.pendingSpeeds.delete(stopIndex);
    state.pendingNonStoppingSpeeds.delete(stopIndex);
    if (samples.length > 0) this.pendingLegs--;

    if (!trafficClass) {
      if (samples.length > 0 || nonStoppingSamples.length > 0) {
        this.unclassifiedLegs++;
      }
      return;
    }

    if (samples.length > 0) this.classifiedLegs++;
    state.legClasses.set(stopIndex, trafficClass);
    for (const sample of samples) this.addSpeedSample(sample, trafficClass);
    for (const sample of nonStoppingSamples) {
      this.addSpeedSample(sample, trafficClass, true);
    }
    this.flushWaiting(state, stopIndex, trafficClass);
    if (stopIndex === 1) {
      this.flushWaiting(state, 0, trafficClass);
    }
  }

  addSpeedSample(sample, trafficClass, nonStopping = false) {
    if (!sample.fromStopId || !sample.toStopId) {
      this.rejectedSamples++;
      this.rejectedSpeedSamples++;
      return;
    }

    const pairKey = JSON.stringify([sample.fromStopId, sample.toStopId]);
    let pair = this.speedGraph.get(pairKey);
    if (!pair) {
      pair = {
        fromStopId: sample.fromStopId,
        toStopId: sample.toStopId,
        classes: new Map(),
        nonStoppingClasses: new Map()
      };
      this.speedGraph.set(pairKey, pair);
    }
    this.lastUpdatedPair = pair;

    const trafficClassBuckets = nonStopping
      ? pair.nonStoppingClasses
      : pair.classes;
    let buckets = trafficClassBuckets.get(trafficClass);
    if (!buckets) {
      buckets = new Map();
      trafficClassBuckets.set(trafficClass, buckets);
    }
    const aggregate = buckets.get(sample.bucket) ?? {
      sampleCount: 0,
      speedSumMps: 0
    };
    aggregate.sampleCount++;
    aggregate.speedSumMps += sample.speedMps;
    buckets.set(sample.bucket, aggregate);

    if (!nonStopping) {
      const speedBin = Math.floor(sample.speedMps / speedHistogramBinWidthMps);
      const speedHistogram = this.speedHistograms.get(trafficClass);
      speedHistogram.set(speedBin, (speedHistogram.get(speedBin) ?? 0) + 1);
      this.maximumSpeedByClass.set(
        trafficClass,
        Math.max(this.maximumSpeedByClass.get(trafficClass) ?? 0, sample.speedMps)
      );
    }
  }

  addWaitingContribution(state, stopIndex, seconds) {
    const trafficClass = stopIndex === 0
      ? state.legClasses.get(1)
      : state.legClasses.get(stopIndex);
    if (!trafficClass) {
      addPendingWait(state, stopIndex, seconds);
      return;
    }
    this.addWaiting(state, stopIndex, trafficClass, seconds, 1);
  }

  flushWaiting(state, stopIndex, trafficClass) {
    const pending = state.pendingWaits.get(stopIndex);
    if (!pending) return;
    state.pendingWaits.delete(stopIndex);
    this.addWaiting(
      state,
      stopIndex,
      trafficClass,
      pending.totalSeconds,
      pending.sampleCount
    );
  }

  addWaiting(state, stopIndex, trafficClass, seconds, sampleCount) {
    if (!state.routeId) {
      this.unattributedWaits += sampleCount;
      return;
    }
    const stopId = state.stopIdByIndex.get(Number(state.trip.stops[stopIndex]?._id));
    if (!stopId) {
      this.unattributedWaits += sampleCount;
      return;
    }

    let route = this.waitingGraph.get(state.routeId);
    if (!route) {
      route = new Map();
      this.waitingGraph.set(state.routeId, route);
    }
    let stop = route.get(stopId);
    if (!stop) {
      stop = new Map();
      route.set(stopId, stop);
      this.routeStopWaitCount++;
    }
    const aggregate = stop.get(trafficClass) ?? {
      sampleCount: 0,
      totalSeconds: 0
    };
    aggregate.sampleCount += sampleCount;
    aggregate.totalSeconds += seconds;
    stop.set(trafficClass, aggregate);
  }

  summary() {
    let speedBuckets = 0;
    let speedSamples = 0;
    const classStats = new Map(trafficClassOrder.map((trafficClass) => [
      trafficClass,
      {
        bucketCount: 0,
        speedSamples: 0,
        bucketSampleFrequencies: new Map(),
        nonStoppingBucketCount: 0,
        nonStoppingSpeedSamples: 0
      }
    ]));
    for (const pair of this.speedGraph.values()) {
      for (const [trafficClass, buckets] of pair.classes) {
        const stats = classStats.get(trafficClass);
        speedBuckets += buckets.size;
        for (const aggregate of buckets.values()) {
          speedSamples += aggregate.sampleCount;
          stats.bucketCount++;
          stats.speedSamples += aggregate.sampleCount;
          stats.bucketSampleFrequencies.set(
            aggregate.sampleCount,
            (stats.bucketSampleFrequencies.get(aggregate.sampleCount) ?? 0) + 1
          );
        }
      }
      for (const [trafficClass, buckets] of pair.nonStoppingClasses ?? []) {
        const stats = classStats.get(trafficClass);
        for (const aggregate of buckets.values()) {
          stats.nonStoppingBucketCount++;
          stats.nonStoppingSpeedSamples += aggregate.sampleCount;
        }
      }
    }

    const trafficClassStats = {};
    for (const trafficClass of trafficClassOrder) {
      const stats = classStats.get(trafficClass);
      const bucketSampleDistribution = Object.fromEntries(
        bucketSampleRanges.map(({ label }) => [label, 0])
      );
      for (const [sampleCount, bucketCount] of stats.bucketSampleFrequencies) {
        const range = bucketSampleRanges.find(
          ({ min, max }) => sampleCount >= min && sampleCount <= max
        );
        if (range) bucketSampleDistribution[range.label] += bucketCount;
      }

      const speedHistogram = this.speedHistograms.get(trafficClass);
      const speedBinMedian = getFrequencyMedian(speedHistogram, stats.speedSamples);
      const speedBin95th = getFrequencyPercentile(speedHistogram, stats.speedSamples, 0.95);
      trafficClassStats[trafficClass] = {
        bucketCount: stats.bucketCount,
        speedSamples: stats.speedSamples,
        nonStoppingBucketCount: stats.nonStoppingBucketCount,
        nonStoppingSpeedSamples: stats.nonStoppingSpeedSamples,
        nonStoppingAverageSamplesPerBucket:
          stats.nonStoppingBucketCount > 0
            ? stats.nonStoppingSpeedSamples / stats.nonStoppingBucketCount
            : 0,
        speedSampleSharePercent: speedSamples > 0
          ? stats.speedSamples / speedSamples * 100
          : 0,
        averageSamplesPerBucket: stats.bucketCount > 0
          ? stats.speedSamples / stats.bucketCount
          : 0,
        medianSamplesPerBucket: getFrequencyMedian(
          stats.bucketSampleFrequencies,
          stats.bucketCount,
          0.5
        ),
        bucketSampleDistribution,
        speedMedianMps: speedBinMedian === null
          ? null
          : (speedBinMedian + 0.5) * speedHistogramBinWidthMps,
        speed95thPercentileMps: speedBin95th === null
          ? null
          : (speedBin95th + 0.5) * speedHistogramBinWidthMps,
        maximumSpeedMps: this.maximumSpeedByClass.get(trafficClass) ?? null
      };
    }

    let routeStopWaitClasses = 0;
    let waitSamples = 0;
    let doorOpenSeconds = 0;
    for (const stops of this.waitingGraph.values()) {
      for (const classes of stops.values()) {
        routeStopWaitClasses += classes.size;
        for (const aggregate of classes.values()) {
          waitSamples += aggregate.sampleCount;
          doorOpenSeconds += aggregate.totalSeconds;
        }
      }
    }

    return {
      directedStopPairs: this.speedGraph.size,
      speedBuckets,
      speedSamples,
      averageSamplesPerBucket: speedBuckets > 0 ? speedSamples / speedBuckets : 0,
      trafficClassStats,
      routeStopWaits: this.routeStopWaitCount,
      routeStopWaitClasses,
      waitSamples,
      doorOpenSeconds,
      rejectedSamples: this.rejectedSamples,
      vehicleObservations: this.vehicleObservations,
      rejectedVehicleObservations: this.rejectedVehicleObservations,
      rejectedSpeedSamples: this.rejectedSpeedSamples,
      rejectedFeedPairs: this.rejectedFeedPairs,
      stationaryGpsSamplesDropped: this.stationaryGpsSamplesDropped,
      classifiedLegs: this.classifiedLegs,
      speedOutlierCount: this.speedOutlierCount,
      doorSensorStuckTrips: this.doorSensorStuckTrips,
      doorSensorRejectedFeedPairs: this.doorSensorRejectedFeedPairs,
      gpsDriftRejectedFeeds: this.gpsDriftRejectedFeeds,
      stopSequenceRegressionEpisodes: this.stopSequenceRegressionEpisodes,
      stopSequenceRegressionRejectedFeeds:
        this.stopSequenceRegressionRejectedFeeds,
      stopSequenceRegressionRecoveries: this.stopSequenceRegressionRecoveries,
      speedOutlierLimitMps: outlierSpeedLimitMps,
      unattributedWaits: this.unattributedWaits,
      unclassifiedLegs: this.unclassifiedLegs,
      pendingLegs: this.pendingLegs
    };
  }
}
