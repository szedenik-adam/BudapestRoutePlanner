import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTimetableShapeDistanceValidator,
  createTimetableShapePointIndexer
} from '../realtime-oversampler/shape-point-index.mjs';
import { SpeedGraphBuilder } from '../realtime-oversampler/speed-graph.mjs';

const defaultShapeCoordinates = [[0, 0], [0.001, 0], [0.002, 0]];

function createTimetable({
  stopShapeDist = [0, 100, 200],
  shapePoints = [
    [0, ...defaultShapeCoordinates[0]],
    [100, ...defaultShapeCoordinates[1]],
    [200, ...defaultShapeCoordinates[2]]
  ],
  stopCoordinates = defaultShapeCoordinates,
  onShapeDistanceValidationError = () => {}
} = {}) {
  const timetable = {
    routeMap: { route: 0 },
    stopMap: Object.fromEntries(
      stopCoordinates.map((_, index) => [
        String.fromCharCode(65 + index),
        index
      ])
    ),
    tripMap: { trip: 0 },
    shapes: { shape: shapePoints },
    trips: [{
      route: { _id: 0, name: 'R1' },
      shape_id: 'shape',
      stops: stopCoordinates.map(([lon, lat], index) => ({
        _id: index,
        lon,
        lat
      })),
      stopArr: stopCoordinates.map((_, index) => index * 10),
      stopDep: stopCoordinates.map((_, index) => index * 10),
      stopShapeDist
    }]
  };
  timetable.indexTripShapePoints = createTimetableShapePointIndexer(
    timetable,
    () => {}
  );
  timetable.validateTripShapeDistances = createTimetableShapeDistanceValidator(
    timetable,
    onShapeDistanceValidationError
  );
  return timetable;
}

function createBuilder(options = {}) {
  const builder = new SpeedGraphBuilder(options);
  const summarize = builder.summary.bind(builder);
  builder.summary = () => {
    builder.flushPendingStationaryFeeds();
    return summarize();
  };
  return builder;
}

function vehicleEntity({
  id = 'vehicle',
  label = id,
  tripId = 'trip',
  timestamp,
  sequence,
  stopId,
  stopDistance,
  doorOpen = false,
  currentStatus = 2,
  position
}) {
  return {
    id,
    vehicle: {
      timestamp,
      position,
      trip: { trip_id: tripId },
      current_stop_sequence: sequence,
      current_status: currentStatus,
      stop_id: stopId,
      vehicle: {
        id,
        label,
        '.realcity.vehicle': {
          stop_distance: stopDistance,
          door_open: doorOpen
        }
      }
    }
  };
}

function feed(entity) {
  return {
    header: { timestamp: entity.vehicle.timestamp },
    entity: [entity]
  };
}

function classForDuration(durationSeconds) {
  const builder = createBuilder();
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 1,
    stopId: 'A',
    stopDistance: 0,
    currentStatus: 1
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000 + durationSeconds,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    currentStatus: 1
  })), timetable);

  builder.flushPendingStationaryFeeds();
  const pair = builder.speedGraph.get(JSON.stringify(['A', 'B']));
  return pair && [...pair.classes.keys()][0];
}

test('recalculates stop_distance on a closed-door next-stop change and its quick follow-up', () => {
  const corrections = [];
  const builder = createBuilder({
    onNextStopDistanceCorrection: (incident) => corrections.push(incident)
  });
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 80,
    position: { latitude: 0, longitude: 0.0004 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1005,
    sequence: 3,
    stopId: 'C',
    stopDistance: 180,
    position: { latitude: 0, longitude: 0.0009 }
  })), timetable);

  let state = builder.vehicleStates.get('vehicle');
  const firstGpsMovementMeters = corrections[0].gpsMovementMeters;
  const correctedAfterStopChange =
    80 + 100 - firstGpsMovementMeters;
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].trigger, 'next-stop-change');
  assert.ok(
    Math.abs(
      state.lastFeedSample.reportedStopDistance - correctedAfterStopChange
    ) < 0.1
  );
  assert.equal(state.lastFeedSample.nextStopDistanceCorrectionPending, true);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1007,
    sequence: 3,
    stopId: 'C',
    stopDistance: 50,
    position: { latitude: 0, longitude: 0.0011 }
  })), timetable);

  state = builder.vehicleStates.get('vehicle');
  const secondGpsMovementMeters = corrections[1].gpsMovementMeters;
  assert.equal(corrections.length, 2);
  assert.equal(corrections[1].trigger, 'follow-up-after-next-stop-change');
  assert.equal(corrections[1].vehicleTimeDeltaSeconds, 2);
  assert.ok(
    Math.abs(
      state.lastFeedSample.reportedStopDistance -
        (correctedAfterStopChange - secondGpsMovementMeters)
    ) < 0.1
  );
  assert.equal(state.lastFeedSample.nextStopDistanceCorrectionPending, false);

  const correctedFollowUpDistance =
    state.lastFeedSample.reportedStopDistance;
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1007,
    sequence: 3,
    stopId: 'C',
    stopDistance: 50,
    position: { latitude: 0, longitude: 0.0011 }
  })), timetable);

  state = builder.vehicleStates.get('vehicle');
  assert.equal(corrections.length, 2);
  assert.equal(
    state.lastFeedSample.reportedStopDistance,
    correctedFollowUpDistance
  );
  assert.equal(state.lastFeedSample.nextStopDistanceCorrectionApplied, true);
});

test('keeps next-stop stop_distance correction active after the report catches up', () => {
  const corrections = [];
  const builder = createBuilder({
    onNextStopDistanceCorrection: (incident) => corrections.push(incident)
  });
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 80,
    position: { latitude: 0, longitude: 0.0004 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1005,
    sequence: 3,
    stopId: 'C',
    stopDistance: 180,
    position: { latitude: 0, longitude: 0.0009 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1010,
    sequence: 3,
    stopId: 'C',
    stopDistance: 50,
    position: { latitude: 0, longitude: 0.0011 }
  })), timetable);

  let state = builder.vehicleStates.get('vehicle');
  assert.equal(state.nextStopDistanceCorrectionActive, true);
  assert.equal(corrections.length, 2);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1022,
    sequence: 3,
    stopId: 'C',
    stopDistance: 20,
    position: { latitude: 0, longitude: 0.0013 }
  })), timetable);

  state = builder.vehicleStates.get('vehicle');
  assert.equal(corrections.length, 3);
  assert.equal(
    corrections[2].trigger,
    'continued-after-next-stop-change'
  );
  assert.ok(
    Math.abs(state.lastFeedSample.reportedStopDistance - 80) < 0.1
  );
  assert.equal(state.nextStopDistanceCorrectionActive, true);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1024,
    sequence: 3,
    stopId: 'C',
    stopDistance: 69,
    position: { latitude: 0, longitude: 0.0014 }
  })), timetable);

  state = builder.vehicleStates.get('vehicle');
  assert.equal(corrections.length, 3);
  assert.equal(state.lastFeedSample.reportedStopDistance, 69);
  assert.equal(state.nextStopDistanceCorrectionActive, true);
});

test('resumes a stopped next-stop correction and backfills grace-period feeds', () => {
  const corrections = [];
  const builder = createBuilder({
    onNextStopDistanceCorrection: (incident) => corrections.push(incident)
  });
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 100,
    position: { latitude: 0, longitude: 0.0004 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1005,
    sequence: 3,
    stopId: 'C',
    stopDistance: 180,
    position: { latitude: 0, longitude: 0.0009 }
  })), timetable);

  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.nextStopDistanceCorrectionActive, false);
  assert.equal(state.nextStopDistanceCorrectionGraceSamplesRemaining, 2);
  const initialGraceSample = state.lastFeedSample;
  assert.equal(initialGraceSample.reportedStopDistance, 180);
  assert.equal(initialGraceSample.nextStopDistanceCorrectionApplied, false);
  assert.equal(corrections.length, 0);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1010,
    sequence: 3,
    stopId: 'C',
    stopDistance: 130,
    position: { latitude: 0, longitude: 0.001 }
  })), timetable);

  const graceSample = state.lastFeedSample;
  assert.equal(graceSample.reportedStopDistance, 130);
  assert.equal(graceSample.nextStopDistanceCorrectionApplied, false);
  assert.equal(initialGraceSample.reportedStopDistance, 180);
  assert.equal(state.nextStopDistanceCorrectionGraceSamplesRemaining, 1);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1015,
    sequence: 3,
    stopId: 'C',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.0011 }
  })), timetable);

  const resumedSample = state.lastFeedSample;
  assert.equal(state.nextStopDistanceCorrectionActive, true);
  assert.equal(state.nextStopDistanceCorrectionGraceSamplesRemaining, 0);
  const initialCorrectedDistance =
    200 - corrections[0].gpsMovementMeters;
  assert.ok(
    Math.abs(initialGraceSample.reportedStopDistance -
      initialCorrectedDistance) < 0.1
  );
  assert.ok(graceSample.reportedStopDistance > 130);
  assert.ok(resumedSample.reportedStopDistance > 50);
  assert.equal(initialGraceSample.nextStopDistanceRecalculationApplied, true);
  assert.equal(graceSample.nextStopDistanceRecalculationApplied, true);
  assert.equal(resumedSample.nextStopDistanceRecalculationApplied, true);
  assert.deepEqual(
    corrections
      .filter((incident) =>
        incident.trigger === 'resumed-after-next-stop-change'
      )
      .map((incident) => incident.current),
    [initialGraceSample, graceSample, resumedSample]
  );
  assert.equal(
    corrections.filter((incident) =>
      incident.trigger === 'resumed-after-next-stop-change'
    ).length,
    3
  );
  builder.summary();
});

test('confirms a sub-tolerance next-stop correction with GPS shape evidence', () => {
  const corrections = [];
  const builder = createBuilder({
    onNextStopDistanceCorrection: (incident) => corrections.push(incident)
  });
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 55,
    position: { latitude: 0, longitude: 0.0004 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1005,
    sequence: 3,
    stopId: 'C',
    stopDistance: 125,
    position: { latitude: 0, longitude: 0.0009 }
  })), timetable);

  const state = builder.vehicleStates.get('vehicle');
  const initialGraceSample = state.lastFeedSample;
  assert.equal(initialGraceSample.reportedStopDistance, 125);
  assert.equal(state.nextStopDistanceCorrectionGraceSamplesRemaining, 2);
  assert.equal(corrections.length, 0);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1010,
    sequence: 3,
    stopId: 'C',
    stopDistance: 112,
    position: { latitude: 0, longitude: 0.001 }
  })), timetable);

  const confirmingSample = state.lastFeedSample;
  assert.equal(state.nextStopDistanceCorrectionActive, true);
  assert.equal(state.nextStopDistanceCorrectionGraceSamplesRemaining, 0);
  assert.equal(corrections.length, 2);
  assert.ok(initialGraceSample.reportedStopDistance < 105);
  assert.ok(confirmingSample.reportedStopDistance < 95);
  assert.ok(
    corrections.every((incident) =>
      incident.trigger === 'resumed-after-next-stop-change'
    )
  );
  assert.deepEqual(
    corrections.map((incident) => incident.current),
    [initialGraceSample, confirmingSample]
  );
});

test('discards unconfirmed next-stop correction candidates after grace expires', () => {
  const corrections = [];
  const builder = createBuilder({
    onNextStopDistanceCorrection: (incident) => corrections.push(incident)
  });
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 100,
    position: { latitude: 0, longitude: 0.0004 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1005,
    sequence: 3,
    stopId: 'C',
    stopDistance: 180,
    position: { latitude: 0, longitude: 0.0009 }
  })), timetable);

  const state = builder.vehicleStates.get('vehicle');
  const initialGraceSample = state.lastFeedSample;
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1010,
    sequence: 3,
    stopId: 'C',
    stopDistance: 130,
    position: { latitude: 0, longitude: 0.001 }
  })), timetable);
  const firstGraceSample = state.lastFeedSample;
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1015,
    sequence: 3,
    stopId: 'C',
    stopDistance: 130,
    position: { latitude: 0, longitude: 0.0011 }
  })), timetable);
  const lastGraceSample = state.lastFeedSample;

  assert.equal(state.nextStopDistanceCorrectionActive, false);
  assert.equal(state.nextStopDistanceCorrectionGraceSamplesRemaining, 0);
  assert.equal(state.nextStopDistanceCorrectionGrace, null);
  assert.equal(initialGraceSample.reportedStopDistance, 180);
  assert.equal(firstGraceSample.reportedStopDistance, 130);
  assert.equal(lastGraceSample.reportedStopDistance, 130);
  assert.equal(initialGraceSample.nextStopDistanceCorrectionPending, false);
  assert.equal(initialGraceSample.nextStopDistanceCorrectionApplied, false);
  assert.equal(firstGraceSample.nextStopDistanceCorrectionApplied, false);
  assert.equal(lastGraceSample.nextStopDistanceCorrectionApplied, false);
  assert.equal(corrections.length, 0);
});

test('continues and rebases next-stop correction across door-open feeds', () => {
  const corrections = [];
  const doorOpenCorrections = [];
  const outliers = [];
  const builder = createBuilder({
    onNextStopDistanceCorrection: (incident) => corrections.push(incident),
    onDoorOpenStopDistanceCorrection: (incident) =>
      doorOpenCorrections.push(incident),
    onSpeedOutlier: (incident) => outliers.push(incident)
  });
  const timetable = createTimetable({
    stopShapeDist: [0, 100, 200, 300],
    shapePoints: [
      [0, 0, 0],
      [100, 0.001, 0],
      [200, 0.002, 0],
      [300, 0.003, 0]
    ],
    stopCoordinates: [
      [0, 0],
      [0.001, 0],
      [0.002, 0],
      [0.003, 0]
    ]
  });
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 80,
    position: { latitude: 0, longitude: 0.001 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1005,
    sequence: 3,
    stopId: 'C',
    stopDistance: 180,
    position: { latitude: 0, longitude: 0.0019 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1010,
    sequence: 3,
    stopId: 'C',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.00192 }
  })), timetable);

  const state = builder.vehicleStates.get('vehicle');
  const previousStopDistance = state.lastFeedSample.reportedStopDistance;
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1012,
    sequence: 3,
    stopId: 'C',
    stopDistance: 0,
    doorOpen: true,
    currentStatus: 1,
    position: { latitude: 0, longitude: 0.00193 }
  })), timetable);

  const doorOpenSample = state.lastFeedSample;
  assert.equal(corrections.at(-1).trigger, 'continued-after-next-stop-change');
  assert.equal(doorOpenSample.nextStopDistanceCorrectionApplied, true);
  assert.ok(doorOpenSample.reportedStopDistance > 50);
  assert.ok(doorOpenSample.reportedStopDistance < previousStopDistance);
  assert.equal(state.nextStopDistanceCorrectionActive, true);
  assert.equal(doorOpenCorrections.length, 0);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1019,
    sequence: 4,
    stopId: 'D',
    stopDistance: 0,
    doorOpen: true,
    currentStatus: 2,
    position: { latitude: 0, longitude: 0.0021 }
  })), timetable);
  assert.equal(corrections.at(-1).trigger, 'next-stop-change');
  assert.equal(corrections.at(-1).current.stopId, 'D');
  const transitionGpsMovementMeters =
    corrections.at(-1).gpsMovementMeters;
  assert.equal(corrections.at(-1).reportedStopDistance, 0);
  assert.ok(
    Math.abs(
      state.lastFeedSample.reportedStopDistance -
      (doorOpenSample.reportedStopDistance + 100 -
        transitionGpsMovementMeters)
    ) < 0.1
  );
  assert.equal(state.lastFeedSample.doorOpen, true);
  assert.equal(state.lastFeedSample.nextStopDistanceRecalculationApplied, true);
  assert.equal(state.nextStopDistanceCorrectionActive, true);
  assert.equal(doorOpenCorrections.length, 0);

  builder.summary();
  assert.equal(outliers.length, 0);
});

test('replays deferred next-stop corrections after sequence quarantine', () => {
  const corrections = [];
  const regressions = [];
  const builder = createBuilder({
    onNextStopDistanceCorrection: (incident) => corrections.push(incident),
    onStopSequenceRegression: (incident) => regressions.push(incident)
  });
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 80,
    position: { latitude: 0, longitude: 0.0004 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1005,
    sequence: 3,
    stopId: 'C',
    stopDistance: 180,
    position: { latitude: 0, longitude: 0.0009 }
  })), timetable);

  const state = builder.vehicleStates.get('vehicle');
  builder.flushPendingGpsDriftSamples(state, true);
  assert.equal(state.nextStopDistanceCorrectionActive, true);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1010,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.0016 }
  })), timetable);
  builder.flushPendingGpsDriftSamples(state, true);
  assert.equal(state.stopSequenceRegression !== null, true);
  assert.equal(regressions[0].phase, 'started');

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1020,
    sequence: 3,
    stopId: 'C',
    stopDistance: 100,
    position: { latitude: 0, longitude: 0.0011 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1025,
    sequence: 3,
    stopId: 'C',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.0015 }
  })), timetable);

  const deferredSample = state.lastFeedSample;
  assert.equal(
    deferredSample.nextStopDistanceCorrectionDeferred,
    true
  );
  assert.equal(state.nextStopDistanceCorrectionActive, true);
  builder.flushPendingGpsDriftSamples(state, true);

  const replayedSample = state.lastSample;
  assert.equal(state.stopSequenceRegression, null);
  assert.equal(regressions.at(-1).phase, 'recovered');
  assert.equal(replayedSample.timestamp, 1025);
  assert.equal(replayedSample.nextStopDistanceCorrectionDeferred, false);
  assert.equal(replayedSample.nextStopDistanceRecalculationApplied, true);
  assert.ok(replayedSample.reportedStopDistance > 50);
  assert.ok(replayedSample.reportedStopDistance < 60);
  assert.equal(state.nextStopDistanceCorrectionActive, true);
  assert.equal(corrections.at(-1).trigger, 'continued-after-next-stop-change');
  assert.ok(state.recentSpeedTransitions.at(-1).speedMps < 35);
});

test('checks short-interval corrections before deferred predecessors are committed', () => {
  const corrections = [];
  const outliers = [];
  const builder = createBuilder({
    onShortIntervalStopDistanceCorrection: (incident) =>
      corrections.push(incident),
    onSpeedOutlier: (incident) => outliers.push(incident)
  });
  const timetable = createTimetable();

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 3,
    stopId: 'C',
    stopDistance: 200,
    position: { latitude: 0, longitude: 0.002 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1020,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.0022 }
  })), timetable);

  const state = builder.vehicleStates.get('vehicle');
  builder.flushPendingGpsDriftSamples(state, true);
  assert.notEqual(state.stopSequenceRegression, null);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1040,
    sequence: 3,
    stopId: 'C',
    stopDistance: 144,
    position: { latitude: 0, longitude: 0.00115 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1042,
    sequence: 3,
    stopId: 'C',
    stopDistance: 70,
    position: { latitude: 0, longitude: 0.00125 }
  })), timetable);
  builder.flushPendingGpsDriftSamples(state, true);

  assert.equal(state.stopSequenceRegression, null);
  assert.equal(corrections.length, 1);
  assert.ok(
    Math.abs(corrections[0].vehicleTimeDeltaSeconds - 2) < 0.01
  );
  assert.ok(corrections[0].reportedStopDistance > 140);
  assert.ok(corrections[0].correctedStopDistance > 80);
  assert.ok(corrections[0].correctedStopDistance < 83);
  assert.ok(state.recentSpeedTransitions.at(-1).speedMps < 35);
  assert.equal(outliers.length, 0);
});

test('carries an active correction across a valid next-stop change when the report catches up', () => {
  const builder = createBuilder();
  const timetable = createTimetable({
    stopShapeDist: [0, 100, 200, 300],
    shapePoints: [
      [0, 0, 0],
      [100, 0.001, 0],
      [200, 0.002, 0],
      [300, 0.003, 0]
    ],
    stopCoordinates: [
      [0, 0],
      [0.001, 0],
      [0.002, 0],
      [0.003, 0]
    ]
  });
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 80,
    position: { latitude: 0, longitude: 0.0004 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1005,
    sequence: 3,
    stopId: 'C',
    stopDistance: 180,
    position: { latitude: 0, longitude: 0.0009 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1007,
    sequence: 3,
    stopId: 'C',
    stopDistance: 50,
    position: { latitude: 0, longitude: 0.0011 }
  })), timetable);

  assert.equal(
    builder.vehicleStates.get('vehicle').nextStopDistanceCorrectionActive,
    true
  );

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1019,
    sequence: 4,
    stopId: 'D',
    stopDistance: 180,
    position: { latitude: 0, longitude: 0.0013 }
  })), timetable);

  const state = builder.vehicleStates.get('vehicle');
  assert.equal(
    state.nextStopDistanceCorrectionActive,
    true
  );
  assert.equal(state.nextStopDistanceCorrectionSample.stopId, 'D');
  assert.equal(state.lastFeedSample.reportedStopDistance, 180);
});

test('corrects and carries a GPS-derived zero stop_distance after a next-stop change', () => {
  const corrections = [];
  const builder = createBuilder({
    onGpsBasedNextStopZeroCorrection: (incident) => corrections.push(incident)
  });
  const timetable = createTimetable({
    stopShapeDist: [0, 100, 50000],
    shapePoints: [
      [0, 0, 0],
      [100, 0.001, 0],
      [50000, 0.002, 0],
      [50050, 0.003, 0]
    ]
  });

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 80,
    position: { latitude: 0, longitude: 0.001 }
  })), timetable);
  const previousProgress =
    builder.vehicleStates.get('vehicle').lastFeedSample.progress;
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1005,
    sequence: 3,
    stopId: 'C',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.0011 }
  })), timetable);

  let state = builder.vehicleStates.get('vehicle');
  assert.equal(timetable.trips[0].shapeDistanceLegValid[1], false);
  assert.equal(state.lastFeedSample.feedReportedStopDistance, 0);
  assert.ok(state.lastFeedSample.reportedStopDistance > 49950);
  assert.ok(state.lastFeedSample.reportedStopDistance < 50000);
  assert.ok(state.lastFeedSample.progress > previousProgress);
  assert.ok(state.lastFeedSample.progress < previousProgress + 20);
  assert.equal(state.gpsBasedZeroStopDistanceCorrection.stopId, 'C');
  assert.equal(corrections[0].trigger, 'next-stop-change');
  assert.equal(corrections[0].shapeLegsValid, false);
  assert.ok(corrections[0].physicalStopDistance > 95);
  assert.ok(corrections[0].physicalStopDistance < 105);
  assert.ok(corrections[0].chainageOffset > 49800);
  assert.ok(Math.abs(
    state.lastFeedSample.progress -
      previousProgress - corrections[0].geometryMovementMeters
  ) < 0.01);
  builder.flushPendingStationaryFeeds();
  state = builder.vehicleStates.get('vehicle');
  assert.equal(state.recentSpeedTransitions.length, 1);
  assert.ok(Math.abs(
    state.recentSpeedTransitions[0].speedMps -
      corrections[0].geometryMovementMeters / 5
  ) < 0.01);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1010,
    sequence: 3,
    stopId: 'C',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.0013 }
  })), timetable);

  state = builder.vehicleStates.get('vehicle');
  assert.equal(state.lastFeedSample.feedReportedStopDistance, 0);
  assert.ok(state.lastFeedSample.reportedStopDistance > 49930);
  assert.ok(state.lastFeedSample.reportedStopDistance < 49960);
  assert.equal(corrections[1].trigger, 'continued-zero');

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1015,
    sequence: 3,
    stopId: 'C',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.0019 }
  })), timetable);

  state = builder.vehicleStates.get('vehicle');
  assert.equal(state.lastFeedSample.feedReportedStopDistance, 0);
  assert.ok(state.lastFeedSample.reportedStopDistance > 49800);
  assert.ok(state.lastFeedSample.reportedStopDistance < 49900);
  assert.ok(state.lastFeedSample.progress > 100);
  assert.equal(state.gpsBasedZeroStopDistanceCorrection.stopId, 'C');
  assert.equal(corrections[2].trigger, 'continued-zero');
  assert.ok(corrections[2].physicalStopDistance < 50);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1020,
    sequence: 3,
    stopId: 'C',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.0021 }
  })), timetable);

  state = builder.vehicleStates.get('vehicle');
  assert.equal(state.lastFeedSample.feedReportedStopDistance, 0);
  assert.ok(state.lastFeedSample.reportedStopDistance > 49800);
  assert.ok(state.lastFeedSample.reportedStopDistance < 50000);
  assert.equal(state.gpsBasedZeroStopDistanceCorrection.stopId, 'C');
  assert.equal(corrections[3].trigger, 'continued-zero');
  assert.ok(corrections[3].physicalStopDistance < 0);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1025,
    sequence: 3,
    stopId: 'C',
    stopDistance: 70,
    position: { latitude: 0, longitude: 0.0022 }
  })), timetable);

  state = builder.vehicleStates.get('vehicle');
  assert.equal(state.lastFeedSample.reportedStopDistance, 70);
  assert.equal(state.gpsBasedZeroStopDistanceCorrection, null);
  assert.equal(corrections.length, 4);
});

test('leaves a next-stop zero unchanged when GPS is already near the stop', () => {
  const corrections = [];
  const builder = createBuilder({
    onGpsBasedNextStopZeroCorrection: (incident) => corrections.push(incident)
  });
  const timetable = createTimetable({
    stopShapeDist: [0, 100, 50000],
    shapePoints: [
      [0, 0, 0],
      [100, 0.001, 0],
      [50000, 0.002, 0]
    ]
  });

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 80,
    position: { latitude: 0, longitude: 0.001 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1005,
    sequence: 3,
    stopId: 'C',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.0019 }
  })), timetable);

  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.lastFeedSample.reportedStopDistance, 0);
  assert.equal(state.gpsBasedZeroStopDistanceCorrection, null);
  assert.equal(corrections.length, 0);
});

test('rejects a zero feed when an active GPS correction cannot project it', () => {
  const dispositions = [];
  const corrections = [];
  const builder = createBuilder({
    onFeedDisposition: (disposition) => dispositions.push(disposition),
    onGpsBasedNextStopZeroCorrection: (incident) =>
      corrections.push(incident)
  });
  const timetable = createTimetable({
    stopShapeDist: [0, 100, 50000],
    shapePoints: [
      [0, 0, 0],
      [100, 0.001, 0],
      [50000, 0.002, 0]
    ]
  });

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 80,
    position: { latitude: 0, longitude: 0.001 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1005,
    sequence: 3,
    stopId: 'C',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.0011 }
  })), timetable);

  const state = builder.vehicleStates.get('vehicle');
  const retainedSample = state.lastFeedSample;
  assert.equal(state.gpsBasedZeroStopDistanceCorrection.stopId, 'C');

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1010,
    sequence: 3,
    stopId: 'C',
    stopDistance: 0,
    position: { latitude: 0.0003, longitude: 0.0012 }
  })), timetable);

  assert.equal(state.lastFeedSample, retainedSample);
  assert.equal(state.gpsBasedZeroStopDistanceCorrection.stopId, 'C');
  assert.equal(dispositions.length, 1);
  assert.equal(
    dispositions[0].reason,
    'gps-based-next-stop-correction-failed'
  );
  assert.equal(dispositions[0].sample.vehicleTimestamp, 1010);
  assert.equal(dispositions[0].previous, retainedSample);
  assert.equal(builder.rejectedSamples, 1);
  assert.equal(builder.rejectedVehicleObservations, 1);
  assert.equal(builder.rejectedFeedPairs, 1);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1015,
    sequence: 3,
    stopId: 'C',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.0015 }
  })), timetable);

  assert.equal(state.lastFeedSample.vehicleTimestamp, 1015);
  assert.equal(corrections.at(-1).trigger, 'continued-zero');
  assert.equal(dispositions.length, 1);
});

test('reconciles a stale previous stop_distance from a shape-consistent short-interval update', () => {
  const corrections = [];
  const builder = createBuilder({
    onShortIntervalStopDistanceCorrection: (incident) =>
      corrections.push(incident)
  });
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 250,
    position: { latitude: 0, longitude: 0.0004 }
  })), timetable);
  const state = builder.vehicleStates.get('vehicle');
  const previous = state.lastFeedSample;

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1001,
    sequence: 2,
    stopId: 'B',
    stopDistance: 56,
    position: { latitude: 0, longitude: 0.0005 }
  })), timetable);

  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].previous, previous);
  assert.equal(corrections[0].reportedStopDistance, 250);
  assert.ok(
    Math.abs(
      previous.reportedStopDistance -
        corrections[0].previousExpectedStopDistance
    ) < 1
  );
  assert.equal(previous.stopDistance, previous.reportedStopDistance);
  assert.equal(previous.distanceToStop, previous.reportedStopDistance);
  assert.equal(
    previous.progress,
    previous.stopShapeDistance - previous.reportedStopDistance
  );
  assert.ok(corrections[0].previousShapeError >= 40);
  assert.ok(corrections[0].currentShapeError <= 20);
});

test('also reconciles one earlier feed in the same repeated stale-distance run', () => {
  const corrections = [];
  const builder = createBuilder({
    onShortIntervalStopDistanceCorrection: (incident) =>
      corrections.push(incident)
  });
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 990,
    sequence: 2,
    stopId: 'B',
    stopDistance: 300,
    position: { latitude: 0, longitude: 0.0002 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 250,
    position: { latitude: 0, longitude: 0.0004 }
  })), timetable);
  const earlier = builder.vehicleStates.get('vehicle').lastFeedSample;
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1001,
    sequence: 2,
    stopId: 'B',
    stopDistance: 250,
    position: { latitude: 0, longitude: 0.0005 }
  })), timetable);
  const previous = builder.vehicleStates.get('vehicle').lastFeedSample;
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1002,
    sequence: 2,
    stopId: 'B',
    stopDistance: 56,
    position: { latitude: 0, longitude: 0.0006 }
  })), timetable);

  assert.equal(corrections.length, 1);
  const { earlierCorrection } = corrections[0];
  assert.equal(earlierCorrection.sample, earlier);
  assert.equal(earlierCorrection.reportedStopDistance, 250);
  assert.ok(earlierCorrection.correctedStopDistance > 75);
  assert.ok(earlierCorrection.correctedStopDistance < 80);
  assert.equal(earlier.reportedStopDistance, earlierCorrection.correctedStopDistance);
  assert.equal(earlier.stopDistanceCorrectionRawValue, 250);
  assert.equal(previous.reportedStopDistance, corrections[0].correctedStopDistance);
  assert.equal(
    earlier.progress,
    earlier.stopShapeDistance - earlier.reportedStopDistance
  );
});

test('reconciles shape-confirmed candidates through the extended interval but not without evidence', () => {
  for (const {
    timestampDelta,
    doorOpen,
    currentPosition,
    flushPrevious,
    expectedCorrectionCount
  } of [
    {
      timestampDelta: 4,
      doorOpen: false,
      currentPosition: { latitude: 0, longitude: 0.0005 },
      flushPrevious: false,
      expectedCorrectionCount: 1
    },
    {
      timestampDelta: 4.5,
      doorOpen: false,
      currentPosition: { latitude: 0, longitude: 0.0005 },
      flushPrevious: false,
      expectedCorrectionCount: 1
    },
    {
      timestampDelta: 1,
      doorOpen: true,
      currentPosition: { latitude: 0, longitude: 0.0005 },
      flushPrevious: false,
      expectedCorrectionCount: 0
    },
    {
      timestampDelta: 1,
      doorOpen: false,
      currentPosition: { latitude: 0.001, longitude: 0.0005 },
      flushPrevious: false,
      expectedCorrectionCount: 0
    },
    {
      timestampDelta: 1,
      doorOpen: false,
      currentPosition: { latitude: 0, longitude: 0.0005 },
      flushPrevious: true,
      expectedCorrectionCount: 0
    }
  ]) {
    const corrections = [];
    const builder = createBuilder({
      onShortIntervalStopDistanceCorrection: (incident) =>
        corrections.push(incident)
    });
    const timetable = createTimetable();
    builder.processFeed(feed(vehicleEntity({
      timestamp: 1000,
      sequence: 2,
      stopId: 'B',
      stopDistance: 250,
      position: { latitude: 0, longitude: 0.0004 }
    })), timetable);
    const state = builder.vehicleStates.get('vehicle');
    if (flushPrevious) builder.flushPendingGpsDriftSamples(state, true);
    builder.processFeed(feed(vehicleEntity({
      timestamp: 1000 + timestampDelta,
      sequence: 2,
      stopId: 'B',
      stopDistance: 56,
      doorOpen,
      position: currentPosition
    })), timetable);

    assert.equal(corrections.length, expectedCorrectionCount);
    assert.equal(state.lastFeedSample.reportedStopDistance, 56);
  }
});

test('reconciles a stale previous stop_distance across six seconds with shape evidence', () => {
  const corrections = [];
  const outliers = [];
  const builder = createBuilder({
    onShortIntervalStopDistanceCorrection: (incident) =>
      corrections.push(incident),
    onSpeedOutlier: (incident) => outliers.push(incident)
  });
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 400,
    position: { latitude: 0, longitude: 0.0004 }
  })), timetable);
  const state = builder.vehicleStates.get('vehicle');
  const previous = state.lastFeedSample;

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1006,
    sequence: 2,
    stopId: 'B',
    stopDistance: 56,
    position: { latitude: 0, longitude: 0.0005 }
  })), timetable);

  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].previous, previous);
  assert.equal(corrections[0].vehicleTimeDeltaSeconds, 6);
  assert.ok(previous.reportedStopDistance > 65);
  assert.ok(previous.reportedStopDistance < 70);
  assert.ok(corrections[0].previousShapeError > 300);
  assert.ok(corrections[0].currentShapeError < 20);
  assert.ok(previous.progress < state.lastFeedSample.progress);

  builder.flushPendingStationaryFeeds();
  assert.equal(outliers.length, 0);
});

test('recalculates both stop distances when same-leg reports share a shape offset', () => {
  const corrections = [];
  const outliers = [];
  const builder = createBuilder({
    onShortIntervalStopDistanceCorrection: (incident) =>
      corrections.push(incident),
    onSpeedOutlier: (incident) => outliers.push(incident)
  });
  const timetable = createTimetable();
  const previousPosition = { latitude: 0, longitude: 0.0004 };
  const currentPosition = { latitude: 0, longitude: 0.0005 };
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 200,
    position: previousPosition
  })), timetable);
  const previous = builder.vehicleStates.get('vehicle').lastFeedSample;

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1001,
    sequence: 2,
    stopId: 'B',
    stopDistance: 120,
    position: currentPosition
  })), timetable);

  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].previous, previous);
  assert.equal(corrections[0].currentDistanceRecalculated, true);
  assert.equal(corrections[0].currentReportedStopDistance, 120);
  assert.ok(Math.abs(previous.reportedStopDistance - 66.7) < 1);
  assert.ok(
    Math.abs(
      corrections[0].current.reportedStopDistance - 55.6
    ) < 1
  );
  assert.equal(previous.stopDistanceCorrectionRawValue, 200);
  assert.equal(
    corrections[0].current.stopDistanceCorrectionRawValue,
    120
  );

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1001,
    sequence: 2,
    stopId: 'B',
    stopDistance: 120,
    position: currentPosition
  })), timetable);
  assert.ok(
    Math.abs(
      builder.vehicleStates.get('vehicle').lastFeedSample.reportedStopDistance -
        55.6
    ) < 1
  );

  builder.flushPendingStationaryFeeds();
  assert.equal(outliers.length, 0);
});

test('corrects repeated stale stop_distance only after a GPS-consistent update persists', () => {
  const corrections = [];
  const builder = createBuilder({
    onRepeatedStaleStopDistanceCorrection: (incident) =>
      corrections.push(incident)
  });
  const timetable = createTimetable({
    stopCoordinates: [[0, 0], [0.0015, 0], [0.002, 0]]
  });
  const stalePosition = { latitude: 0, longitude: 0.0003 };
  const freshPosition = { latitude: 0, longitude: 0.0006 };
  const confirmationPosition = { latitude: 0, longitude: 0.0007 };
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 300,
    position: stalePosition
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 300,
    position: stalePosition
  })), timetable);
  const state = builder.vehicleStates.get('vehicle');
  const staleSamples = state.pendingStationaryFeeds.samples
    .map((entry) => entry.sample);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1006,
    sequence: 2,
    stopId: 'B',
    stopDistance: 100,
    position: freshPosition
  })), timetable);
  assert.equal(corrections.length, 0);
  assert.equal(staleSamples[0].reportedStopDistance, 300);
  assert.equal(staleSamples[1].reportedStopDistance, 300);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1012,
    sequence: 2,
    stopId: 'B',
    stopDistance: 89,
    position: confirmationPosition
  })), timetable);

  assert.equal(corrections.length, 1);
  assert.deepEqual(
    corrections[0].staleSamples.map((correction) => correction.sample),
    staleSamples.slice(0, 2)
  );
  assert.ok(
    Math.abs(staleSamples[0].reportedStopDistance - 133.4) < 1
  );
  assert.equal(
    staleSamples[0].reportedStopDistance,
    staleSamples[1].reportedStopDistance
  );
  assert.equal(staleSamples[0].stopDistanceCorrectionRawValue, 300);
  assert.equal(state.lastFeedSample.feedReportedStopDistance, 89);
  assert.equal(state.lastFeedSample.reportedStopDistance, 89);
  const freshEntry = state.pendingStationaryFeeds.samples.find(
    (entry) => entry.sample === corrections[0].freshSample
  );
  assert.equal(
    freshEntry.progressDeltaMeters,
    freshEntry.sample.progress - freshEntry.previousSample.progress
  );
});

test('does not correct repeated stale feeds without a confirmed GPS-consistent report', () => {
  for (const confirmation of [
    null,
    {
      timestamp: 1012,
      stopDistance: 10,
      position: { latitude: 0, longitude: 0.0007 }
    },
    {
      timestamp: 1012,
      stopDistance: 100,
      position: { latitude: 0, longitude: 0.0006 }
    }
  ]) {
    const corrections = [];
    const builder = createBuilder({
      onRepeatedStaleStopDistanceCorrection: (incident) =>
        corrections.push(incident)
    });
    const timetable = createTimetable({
      stopCoordinates: [[0, 0], [0.0015, 0], [0.002, 0]]
    });
    const stalePosition = { latitude: 0, longitude: 0.0003 };
    builder.processFeed(feed(vehicleEntity({
      timestamp: 1000,
      sequence: 2,
      stopId: 'B',
      stopDistance: 300,
      position: stalePosition
    })), timetable);
    builder.processFeed(feed(vehicleEntity({
      timestamp: 1000,
      sequence: 2,
      stopId: 'B',
      stopDistance: 300,
      position: stalePosition
    })), timetable);
    builder.processFeed(feed(vehicleEntity({
      timestamp: 1006,
      sequence: 2,
      stopId: 'B',
      stopDistance: 100,
      position: { latitude: 0, longitude: 0.0006 }
    })), timetable);
    const staleSamples = builder.vehicleStates.get('vehicle')
      .pendingStationaryFeeds.samples
      .slice(0, 2)
      .map((entry) => entry.sample);

    if (confirmation) {
      builder.processFeed(feed(vehicleEntity({
        timestamp: confirmation.timestamp,
        sequence: 2,
        stopId: 'B',
        stopDistance: confirmation.stopDistance,
        position: confirmation.position
      })), timetable);
    }

    assert.equal(corrections.length, 0);
    assert.deepEqual(
      staleSamples.map((sample) => sample.reportedStopDistance),
      [300, 300]
    );
  }
});

test('keeps shape-confirmed stop-distance reconciliation bounded to eight seconds', () => {
  const corrections = [];
  const rejections = [];
  const builder = createBuilder({
    onShortIntervalStopDistanceCorrection: (incident) =>
      corrections.push(incident),
    onShortIntervalStopDistanceCorrectionRejected: (incident) =>
      rejections.push(incident)
  });
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 400,
    position: { latitude: 0, longitude: 0.0004 }
  })), timetable);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1008,
    sequence: 2,
    stopId: 'B',
    stopDistance: 56,
    position: { latitude: 0, longitude: 0.0005 }
  })), timetable);

  assert.equal(corrections.length, 0);
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].candidateSpeedMps, 43);
  assert.equal(rejections[0].rejectionReason, 'interval-outside-window');
});

test('rejects an extended-interval correction when the current distance disagrees with GPS', () => {
  const corrections = [];
  const rejections = [];
  const builder = createBuilder({
    onShortIntervalStopDistanceCorrection: (incident) =>
      corrections.push(incident),
    onShortIntervalStopDistanceCorrectionRejected: (incident) =>
      rejections.push(incident)
  });
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 400,
    position: { latitude: 0, longitude: 0.0004 }
  })), timetable);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1006,
    sequence: 2,
    stopId: 'B',
    stopDistance: 10,
    position: { latitude: 0, longitude: 0.0005 }
  })), timetable);

  assert.equal(corrections.length, 0);
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].rejectionReason, 'current-shape-error-too-large');
  assert.ok(rejections[0].currentShapeError > 20);
});

test('reports the failed gate for an outlier-sized short-interval stop-distance candidate', () => {
  const rejections = [];
  const builder = createBuilder({
    onShortIntervalStopDistanceCorrectionRejected: (incident) =>
      rejections.push(incident)
  });
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 110,
    position: { latitude: 0, longitude: 0.0004 }
  })), timetable);
  const state = builder.vehicleStates.get('vehicle');
  const previous = state.lastFeedSample;

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1001,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: { latitude: 0.00016, longitude: 0.0005 }
  })), timetable);

  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].previous, previous);
  assert.equal(rejections[0].rejectionReason, 'current-shape-error-too-large');
  assert.equal(rejections[0].candidateSpeedMps, 110);
  assert.ok(rejections[0].currentShapeError > 20);
});

test('confirms a downstream-leg correction before rebasing stale stop metadata', () => {
  const corrections = [];
  const rejections = [];
  const builder = createBuilder({
    onShortIntervalStopDistanceCorrection: (incident) =>
      corrections.push(incident),
    onShortIntervalStopDistanceCorrectionRejected: (incident) =>
      rejections.push(incident)
  });
  const timetable = createTimetable({
    stopShapeDist: [0, 111.2, 222.4, 333.6],
    shapePoints: [
      [0, 0, 0],
      [111.2, 0.001, 0],
      [222.4, 0.001, 0.001],
      [333.6, 0.002, 0.001]
    ],
    stopCoordinates: [
      [0, 0],
      [0.001, 0],
      [0.001, 0.001],
      [0.002, 0.001]
    ]
  });
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 78,
    position: { latitude: 0.0003, longitude: 0.001 }
  })), timetable);
  const state = builder.vehicleStates.get('vehicle');
  const previous = state.lastFeedSample;
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1001,
    sequence: 2,
    stopId: 'B',
    stopDistance: 12,
    position: { latitude: 0.0004, longitude: 0.001 }
  })), timetable);

  const candidate = state.lastFeedSample;
  assert.equal(previous.reportedStopDistance, 78);
  assert.equal(candidate.reportedStopDistance, 12);
  assert.equal(state.pendingDownstreamStopDistanceCorrection.current, candidate);
  assert.equal(corrections.length, 0);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1001,
    sequence: 2,
    stopId: 'B',
    stopDistance: 12,
    position: { latitude: 0.0004, longitude: 0.001 }
  })), timetable);
  assert.equal(corrections.length, 0);
  assert.equal(state.pendingDownstreamStopDistanceCorrection.current, candidate);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1002,
    sequence: 3,
    stopId: 'C',
    stopDistance: 56,
    position: { latitude: 0.0005, longitude: 0.001 }
  })), timetable);
  assert.equal(corrections.length, 0);
  assert.equal(state.pendingDownstreamStopDistanceCorrection.current, candidate);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1003,
    sequence: 3,
    stopId: 'C',
    stopDistance: 45,
    position: { latitude: 0.0006, longitude: 0.001 }
  })), timetable);

  assert.equal(state.pendingDownstreamStopDistanceCorrection, null);
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].downstreamStopCorrection, true);
  assert.equal(corrections[0].targetStopId, 'C');
  assert.equal(previous.stopIndex, 2);
  assert.equal(candidate.stopIndex, 2);
  assert.equal(previous.stopId, 'C');
  assert.equal(candidate.stopId, 'C');
  assert.ok(previous.reportedStopDistance > 75);
  assert.ok(previous.reportedStopDistance < 80);
  assert.ok(candidate.reportedStopDistance > 64);
  assert.ok(candidate.reportedStopDistance < 69);
  assert.ok(candidate.progress > previous.progress);
  assert.ok(candidate.progress - previous.progress < 12);
  assert.equal(rejections[0].rejectionReason,
    'downstream-leg-correction-awaiting-confirmation');
});

test('discards a tentative downstream correction when GPS returns to the old leg', () => {
  const corrections = [];
  const rejections = [];
  const builder = createBuilder({
    onShortIntervalStopDistanceCorrection: (incident) =>
      corrections.push(incident),
    onShortIntervalStopDistanceCorrectionRejected: (incident) =>
      rejections.push(incident)
  });
  const timetable = createTimetable({
    stopShapeDist: [0, 111.2, 222.4, 333.6],
    shapePoints: [
      [0, 0, 0],
      [111.2, 0.001, 0],
      [222.4, 0.001, 0.001],
      [333.6, 0.002, 0.001]
    ],
    stopCoordinates: [
      [0, 0],
      [0.001, 0],
      [0.001, 0.001],
      [0.002, 0.001]
    ]
  });
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 78,
    position: { latitude: 0.0003, longitude: 0.001 }
  })), timetable);
  const state = builder.vehicleStates.get('vehicle');
  const previous = state.lastFeedSample;
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1001,
    sequence: 2,
    stopId: 'B',
    stopDistance: 12,
    position: { latitude: 0.0004, longitude: 0.001 }
  })), timetable);
  const candidate = state.lastFeedSample;
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1002,
    sequence: 3,
    stopId: 'C',
    stopDistance: 56,
    position: { latitude: 0.0006, longitude: 0.001 }
  })), timetable);
  assert.ok(state.pendingDownstreamStopDistanceCorrection);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1003,
    sequence: 3,
    stopId: 'C',
    stopDistance: 60,
    position: { latitude: 0, longitude: 0.0005 }
  })), timetable);

  assert.equal(state.pendingDownstreamStopDistanceCorrection, null);
  assert.equal(corrections.length, 0);
  assert.equal(previous.reportedStopDistance, 78);
  assert.equal(candidate.reportedStopDistance, 12);
  assert.equal(
    rejections.at(-1).rejectionReason,
    'downstream-confirmation-off-shape'
  );
});

test('reports when an outlier-sized stop-distance candidate is outside the correction window', () => {
  const rejections = [];
  const builder = createBuilder({
    onShortIntervalStopDistanceCorrectionRejected: (incident) =>
      rejections.push(incident)
  });
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 500,
    position: { latitude: 0, longitude: 0 }
  })), timetable);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1008,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.0001 }
  })), timetable);

  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].rejectionReason, 'interval-outside-window');
  assert.equal(rejections[0].candidateSpeedMps, 62.5);
});

test('corrects a closed-door near-stop zero snap using matching GPS movement', () => {
  const incidents = [];
  const outliers = [];
  const builder = createBuilder({
    onClosedDoorStopDistanceCorrection: (incident) => incidents.push(incident),
    onSpeedOutlier: (incident) => outliers.push(incident)
  });
  const timetable = createTimetable({
    shapePoints: [
      [0, 19, 47.5],
      [100, 19.00134, 47.5],
      [200, 19.00268, 47.5]
    ],
    stopCoordinates: [
      [19, 47.5],
      [19.00134, 47.5],
      [19.00268, 47.5]
    ]
  });
  const previous = vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 399,
    position: { latitude: 47.5, longitude: 19.00024 }
  });
  const current = vehicleEntity({
    timestamp: 1008,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: { latitude: 47.5, longitude: 19.00107 }
  });

  builder.processFeed(feed(previous), timetable);
  builder.processFeed(feed(previous), timetable);
  const repeatedBaseline = builder.vehicleStates.get('vehicle').lastSample;
  builder.processFeed(feed(current), timetable);
  builder.flushPendingStationaryFeeds();

  assert.equal(incidents.length, 1);
  const incident = incidents[0];
  assert.equal(incident.reportedPreviousStopDistance, 399);
  assert.equal(incident.reportedStopDistance, 0);
  assert.ok(incident.correctedPreviousStopDistance > 75);
  assert.ok(incident.correctedPreviousStopDistance < 90);
  assert.ok(incident.correctedStopDistance > 10);
  assert.ok(incident.correctedStopDistance < 30);
  assert.ok(incident.candidateSpeedMps > 35);
  assert.ok(incident.correctedSpeedMps <= 35);

  const state = builder.vehicleStates.get('vehicle');
  assert.equal(
    incident.previous.reportedStopDistance,
    incident.correctedPreviousStopDistance
  );
  assert.equal(
    repeatedBaseline.reportedStopDistance,
    incident.correctedPreviousStopDistance
  );
  assert.equal(
    state.lastSample.reportedStopDistance,
    incident.correctedStopDistance
  );
  assert.equal(state.lastSample.stopDistance, incident.correctedStopDistance);
  assert.equal(state.lastSample.distanceToStop, incident.correctedStopDistance);
  assert.ok(state.recentSpeedTransitions[0].speedMps <= 35);
  assert.equal(outliers.length, 0);
});

test('preserves a shape-backed distance when a nearby route loop mimics a stop snap', () => {
  const incidents = [];
  const outliers = [];
  const builder = createBuilder({
    onClosedDoorStopDistanceCorrection: (incident) => incidents.push(incident),
    onSpeedOutlier: (incident) => outliers.push(incident)
  });
  const positionAtMeters = (x, y = 0) => ({
    latitude: 47.5 + y / 111320,
    longitude: 19 + x / (111320 * Math.cos(47.5 * Math.PI / 180))
  });
  const shapePoint = (distance, x, y = 0) => {
    const position = positionAtMeters(x, y);
    return [distance, position.longitude, position.latitude];
  };
  const firstMovementMeters = Math.hypot(9.4, 52);
  const loopSideMeters = 106.6;
  const loopStartDistance = firstMovementMeters;
  const timetable = createTimetable({
    stopShapeDist: [0, 500],
    shapePoints: [
      shapePoint(0, -30, 52),
      shapePoint(loopStartDistance, -20.6),
      shapePoint(loopStartDistance + loopSideMeters, -20.6, loopSideMeters),
      shapePoint(loopStartDistance + 2 * loopSideMeters, 86, loopSideMeters),
      shapePoint(loopStartDistance + 3 * loopSideMeters, 86),
      shapePoint(loopStartDistance + 4 * loopSideMeters, -20.6),
      shapePoint(loopStartDistance + 4 * loopSideMeters + 16.5, -4.1),
      shapePoint(loopStartDistance + 4 * loopSideMeters + 21, 0)
    ],
    stopCoordinates: [
      [
        positionAtMeters(-30, 52).longitude,
        positionAtMeters(-30, 52).latitude
      ],
      [positionAtMeters(0).longitude, positionAtMeters(0).latitude]
    ]
  });

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 500,
    position: positionAtMeters(-30, 52)
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1010,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: positionAtMeters(-20.6)
  })), timetable);
  const shapeCorrectedSample =
    builder.vehicleStates.get('vehicle').lastFeedSample;
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1010,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: positionAtMeters(-20.6)
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1065,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: positionAtMeters(-4.1)
  })), timetable);
  builder.flushPendingStationaryFeeds();

  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].correctionBasis, 'shape-projection');
  assert.ok(shapeCorrectedSample.reportedStopDistance > 400);
  assert.equal(outliers.length, 0);
  assert.ok(
    builder.vehicleStates.get('vehicle').recentSpeedTransitions.every(
      (transition) => transition.speedMps <= 35
    )
  );
});

test('keeps GPS-supported snap corrections for uncorrected positive reports', () => {
  const incidents = [];
  const outliers = [];
  const builder = createBuilder({
    onClosedDoorStopDistanceCorrection: (incident) => incidents.push(incident),
    onSpeedOutlier: (incident) => outliers.push(incident)
  });
  const positionAtMeters = (x, y = 0) => ({
    latitude: 47.5 + y / 111320,
    longitude: 19 + x / (111320 * Math.cos(47.5 * Math.PI / 180))
  });
  const shapePoint = (distance, x, y = 0) => {
    const position = positionAtMeters(x, y);
    return [distance, position.longitude, position.latitude];
  };
  const timetable = createTimetable({
    stopShapeDist: [0, 500],
    shapePoints: [
      shapePoint(0, -374.4),
      shapePoint(345, -29.4),
      shapePoint(357.4, -17),
      shapePoint(397.4, -17, 40),
      shapePoint(437.4, 23, 40),
      shapePoint(477.4, 23),
      shapePoint(500, 0)
    ],
    stopCoordinates: [
      [
        positionAtMeters(-374.4).longitude,
        positionAtMeters(-374.4).latitude
      ],
      [positionAtMeters(0).longitude, positionAtMeters(0).latitude]
    ]
  });

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 155,
    position: positionAtMeters(-29.4)
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1003,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: positionAtMeters(-17)
  })), timetable);
  builder.flushPendingStationaryFeeds();

  assert.equal(incidents.length, 1);
  assert.ok(incidents[0].correctedPreviousStopDistance > 25);
  assert.ok(incidents[0].correctedPreviousStopDistance < 35);
  assert.ok(incidents[0].correctedStopDistance > 10);
  assert.ok(incidents[0].correctedStopDistance < 25);
  assert.equal(outliers.length, 0);
});

test('corrects only a closed-door zero that conflicts with a matching shape projection', () => {
  const incidents = [];
  const builder = createBuilder({
    onClosedDoorStopDistanceCorrection: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable({
    stopShapeDist: [0, 500],
    shapePoints: [
      [0, 19, 47.5],
      [500, 19.0067, 47.5]
    ],
    stopCoordinates: [
      [19, 47.5],
      [19.0067, 47.5]
    ]
  });
  const previous = vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 462,
    position: { latitude: 47.5, longitude: 19.00048 }
  });
  const current = vehicleEntity({
    timestamp: 1009,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: { latitude: 47.5, longitude: 19.0011 }
  });

  builder.processFeed(feed(previous), timetable);
  builder.processFeed(feed(current), timetable);
  builder.flushPendingStationaryFeeds();

  const incident = incidents[0];
  const state = builder.vehicleStates.get('vehicle');
  assert.equal(incidents.length, 1);
  assert.equal(incident.correctionBasis, 'shape-projection');
  assert.equal(incident.reportedPreviousStopDistance, 462);
  assert.equal(incident.correctedPreviousStopDistance, 462);
  assert.equal(incident.previous.reportedStopDistance, 462);
  assert.equal(incident.reportedStopDistance, 0);
  assert.ok(
    Math.abs(
      incident.previousShapeStopDistance - 462
    ) <= 20
  );
  assert.ok(incident.currentShapeStopDistance > 400);
  assert.equal(
    state.lastSample.reportedStopDistance,
    incident.currentShapeStopDistance
  );
  assert.ok(state.recentSpeedTransitions[0].speedMps <= 35);
});

test('keeps a shape-based zero correction active until the reported distance matches shape', () => {
  const continuedCorrections = [];
  const builder = createBuilder({
    onPersistentZeroStopDistanceCorrection: (incident) =>
      continuedCorrections.push(incident)
  });
  const timetable = createTimetable({
    stopShapeDist: [0, 500],
    shapePoints: [
      [0, 19, 47.5],
      [500, 19.0067, 47.5]
    ],
    stopCoordinates: [
      [19, 47.5],
      [19.0067, 47.5]
    ]
  });

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 462,
    position: { latitude: 47.5, longitude: 19.00048 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1009,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: { latitude: 47.5, longitude: 19.0011 }
  })), timetable);

  let state = builder.vehicleStates.get('vehicle');
  assert.ok(state.persistentShapeZeroStopDistanceCorrection);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1014,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    doorOpen: true,
    position: { latitude: 47.5, longitude: 19.0012 }
  })), timetable);

  state = builder.vehicleStates.get('vehicle');
  assert.equal(state.lastFeedSample.feedReportedStopDistance, 0);
  assert.ok(state.lastFeedSample.reportedStopDistance > 0);
  assert.equal(continuedCorrections.length, 1);
  assert.equal(continuedCorrections[0].reportedStopDistance, 0);
  assert.equal(
    state.lastFeedSample.reportedStopDistance,
    continuedCorrections[0].correctedStopDistance
  );
  assert.ok(state.persistentShapeZeroStopDistanceCorrection);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1020,
    sequence: 2,
    stopId: 'B',
    stopDistance: 180,
    doorOpen: true,
    position: { latitude: 47.5, longitude: 19.0043 }
  })), timetable);

  state = builder.vehicleStates.get('vehicle');
  assert.equal(state.lastFeedSample.reportedStopDistance, 180);
  assert.equal(state.persistentShapeZeroStopDistanceCorrection, null);
  assert.equal(continuedCorrections.length, 1);
});

test('does not shape-correct a closed-door zero after a sub-200m report', () => {
  const incidents = [];
  const builder = createBuilder({
    onClosedDoorStopDistanceCorrection: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable({
    stopShapeDist: [0, 190],
    shapePoints: [
      [0, 19, 47.5],
      [190, 19.00255, 47.5]
    ],
    stopCoordinates: [
      [19, 47.5],
      [19.00255, 47.5]
    ]
  });
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 150,
    position: { latitude: 47.5, longitude: 19.00054 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1009,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: { latitude: 47.5, longitude: 19.00116 }
  })), timetable);
  builder.flushPendingStationaryFeeds();

  assert.equal(incidents.length, 0);
  assert.equal(
    builder.vehicleStates.get('vehicle').lastSample.reportedStopDistance,
    0
  );
});

test('reuses a stop-distance correction for an identical same-timestamp feed', () => {
  const incidents = [];
  const outliers = [];
  const feedDispositions = [];
  const builder = createBuilder({
    onClosedDoorStopDistanceCorrection: (incident) => incidents.push(incident),
    onSpeedOutlier: (incident) => outliers.push(incident),
    onFeedDisposition: (disposition) => feedDispositions.push(disposition)
  });
  const timetable = createTimetable();
  const previous = vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 73,
    position: { latitude: 0, longitude: 0.000627 }
  });
  const current = vehicleEntity({
    timestamp: 1001,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.000752 }
  });

  builder.processFeed(feed(previous), timetable);
  builder.processFeed(feed(current), timetable);
  builder.processFeed(feed(current), timetable);
  builder.flushPendingStationaryFeeds();

  assert.equal(incidents.length, 1);
  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.lastFeedSample.feedReportedStopDistance, 0);
  assert.equal(
    state.lastFeedSample.reportedStopDistance,
    incidents[0].correctedStopDistance
  );
  assert.equal(outliers.length, 0);
  assert.ok(feedDispositions.some((disposition) =>
    disposition.kind === 'pair-rejected' &&
    disposition.reason === 'non-positive-elapsed-time'
  ));
  assert.ok(Math.abs(state.recentSpeedTransitions[0].speedMps - 13.9) < 0.2);
});

test('corrects a closed-door zero snap even when the reported speed is below 35 m/s', () => {
  const incidents = [];
  const builder = createBuilder({
    onClosedDoorStopDistanceCorrection: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable({
    shapePoints: [
      [0, 19, 47.5],
      [100, 19.00134, 47.5],
      [200, 19.00268, 47.5]
    ],
    stopCoordinates: [
      [19, 47.5],
      [19.00134, 47.5],
      [19.00268, 47.5]
    ]
  });
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 25,
    position: { latitude: 47.5, longitude: 19.00024 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1008,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: { latitude: 47.5, longitude: 19.00107 }
  })), timetable);
  builder.flushPendingStationaryFeeds();

  assert.equal(incidents.length, 1);
  assert.ok(incidents[0].candidateSpeedMps < 35);
  assert.equal(
    builder.vehicleStates.get('vehicle').lastSample.reportedStopDistance,
    incidents[0].correctedStopDistance
  );
});

test('applies a GPS-supported snap correction even when corrected speed stays above 35 m/s', () => {
  const incidents = [];
  const builder = createBuilder({
    onClosedDoorStopDistanceCorrection: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable({
    shapePoints: [
      [0, 19, 47.5],
      [100, 19.00134, 47.5],
      [200, 19.00268, 47.5]
    ],
    stopCoordinates: [
      [19, 47.5],
      [19.00134, 47.5],
      [19.00268, 47.5]
    ]
  });
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 399,
    position: { latitude: 47.5, longitude: 19.00024 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1001,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: { latitude: 47.5, longitude: 19.00107 }
  })), timetable);
  builder.flushPendingStationaryFeeds();

  assert.equal(incidents.length, 1);
  assert.ok(incidents[0].correctedSpeedMps > 35);
  assert.equal(
    builder.vehicleStates.get('vehicle').lastSample.reportedStopDistance,
    incidents[0].correctedStopDistance
  );
});

test('leaves a closed-door zero unchanged when GPS movement does not support the snap', () => {
  const incidents = [];
  const builder = createBuilder({
    onClosedDoorStopDistanceCorrection: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable({
    shapePoints: [
      [0, 19, 47.5],
      [100, 19.00134, 47.5],
      [200, 19.00268, 47.5]
    ],
    stopCoordinates: [
      [19, 47.5],
      [19.00134, 47.5],
      [19.00268, 47.5]
    ]
  });
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 399,
    position: { latitude: 47.5, longitude: 19.00024 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1008,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: { latitude: 47.5005, longitude: 19.00134 }
  })), timetable);
  builder.flushPendingStationaryFeeds();

  assert.equal(incidents.length, 0);
  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.recentSpeedTransitions[0].speedMps, 399 / 8);
});

test('does not correct a closed-door snap after its previous feed leaves the GPS buffer', () => {
  const incidents = [];
  const builder = createBuilder({
    onClosedDoorStopDistanceCorrection: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 110,
    position: { latitude: 0, longitude: 0.0004 }
  })), timetable);
  const state = builder.vehicleStates.get('vehicle');
  builder.flushPendingGpsDriftSamples(state, true);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1001,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.0005 }
  })), timetable);

  assert.equal(incidents.length, 0);
  assert.equal(state.lastFeedSample.reportedStopDistance, 0);
});

test('does not apply next-stop distance corrections across open doors or at five seconds', () => {
  for (const {
    followUpSeconds,
    transitionDoorOpen,
    followUpStopDistance,
    expectedCorrectionCount
  } of [
    {
      followUpSeconds: 5,
      transitionDoorOpen: false,
      followUpStopDistance: 102,
      expectedCorrectionCount: 0
    },
    {
      followUpSeconds: 2,
      transitionDoorOpen: true,
      followUpStopDistance: 50,
      expectedCorrectionCount: 0
    }
  ]) {
    const corrections = [];
    const builder = createBuilder({
      onNextStopDistanceCorrection: (incident) => corrections.push(incident)
    });
    const timetable = createTimetable();
    builder.processFeed(feed(vehicleEntity({
      timestamp: 1000,
      sequence: 2,
      stopId: 'B',
      stopDistance: 80,
      position: { latitude: 0, longitude: 0.0004 }
    })), timetable);
    builder.processFeed(feed(vehicleEntity({
      timestamp: 1005,
      sequence: 3,
      stopId: 'C',
      stopDistance: 150,
      doorOpen: transitionDoorOpen,
      position: { latitude: 0, longitude: 0.0009 }
    })), timetable);
    builder.processFeed(feed(vehicleEntity({
      timestamp: 1005 + followUpSeconds,
      sequence: 3,
      stopId: 'C',
      stopDistance: followUpStopDistance,
      position: { latitude: 0, longitude: 0.0011 }
    })), timetable);

    assert.equal(corrections.length, expectedCorrectionCount);
    if (!transitionDoorOpen) {
      builder.processFeed(feed(vehicleEntity({
        timestamp: 1015,
        sequence: 3,
        stopId: 'C',
        stopDistance: 80,
        position: { latitude: 0, longitude: 0.0013 }
      })), timetable);
      const state = builder.vehicleStates.get('vehicle');
      assert.equal(state.nextStopDistanceCorrectionGraceSamplesRemaining, 0);
      assert.equal(state.nextStopDistanceCorrectionActive, false);
      assert.equal(state.lastFeedSample.reportedStopDistance, 80);
    }
  }
});

test('uses the full elapsed time for every door-state transition', () => {
  const cases = [
    { previousDoorOpen: false, currentDoorOpen: true, expectedSpeedMps: 2 },
    { previousDoorOpen: true, currentDoorOpen: false, expectedSpeedMps: 2 },
    { previousDoorOpen: true, currentDoorOpen: true, expectedSpeedMps: 2 }
  ];

  for (const {
    previousDoorOpen,
    currentDoorOpen,
    expectedSpeedMps
  } of cases) {
    const builder = createBuilder();
    const timetable = createTimetable();
    builder.processFeed(feed(vehicleEntity({
      timestamp: 1000,
      sequence: 2,
      stopId: 'B',
      stopDistance: 100,
      doorOpen: previousDoorOpen
    })), timetable);
    builder.processFeed(feed(vehicleEntity({
      timestamp: 1010,
      sequence: 2,
      stopId: 'B',
      stopDistance: 80,
      doorOpen: currentDoorOpen
    })), timetable);
    builder.flushPendingStationaryFeeds();

    assert.equal(
      builder.vehicleStates.get('vehicle').recentSpeedTransitions[0].speedMps,
      expectedSpeedMps
    );
  }
});

test('recalculates zero stop_distance on open-door feeds away from the stop', () => {
  const timetable = createTimetable({
    shapePoints: [
      [0, 19, 47.5],
      [100, 19.00134, 47.5],
      [200, 19.00268, 47.5]
    ],
    stopCoordinates: [
      [19, 47.5],
      [19.00134, 47.5],
      [19.00268, 47.5]
    ]
  });

  for (const elapsedSeconds of [2, 10]) {
    const incidents = [];
    const builder = createBuilder({
      onDoorOpenStopDistanceCorrection: (incident) => incidents.push(incident)
    });
    const previous = vehicleEntity({
      timestamp: 1000,
      sequence: 2,
      stopId: 'B',
      stopDistance: 70,
      position: { latitude: 47.5, longitude: 19.00040 }
    });
    const current = vehicleEntity({
      timestamp: 1000 + elapsedSeconds,
      sequence: 2,
      stopId: 'B',
      stopDistance: 0,
      doorOpen: true,
      currentStatus: 1,
      position: { latitude: 47.5, longitude: 19.00044 }
    });

    builder.processFeed(feed(previous), timetable);
    builder.processFeed(feed(current), timetable);
    builder.flushPendingStationaryFeeds();

    const state = builder.vehicleStates.get('vehicle');
    assert.equal(incidents.length, 1);
    const gpsMovementMeters = incidents[0].gpsMovementMeters;
    assert.equal(incidents[0].reportedStopDistance, 0);
    assert.ok(
      Math.abs(
        state.lastSample.reportedStopDistance - (70 - gpsMovementMeters)
      ) < 0.1
    );
    assert.ok(incidents[0].distanceToStopMeters > 50);
    assert.ok(
      Math.abs(state.recentSpeedTransitions[0].speedMps -
        gpsMovementMeters / elapsedSeconds) < 0.1
    );
  }
});

test('uses the valid shape projection for a later open-door zero after a shape-confirmed closed-door feed', () => {
  const incidents = [];
  const builder = createBuilder({
    onDoorOpenStopDistanceCorrection: (incident) => incidents.push(incident)
  });
  const longitudeAtMeters = (meters) =>
    19 + meters / (111320 * Math.cos(47.5 * Math.PI / 180));
  const latitudeAtMeters = (meters) => 47.5 + meters / 111320;
  const routePoints = [
    [0, 0, 0],
    [120, 120, 0],
    [240, 120, 120],
    [360, 240, 120],
    [600, 240, -120],
    [802, 95, 20],
    [972, 265, 20]
  ];
  const shapePoints = routePoints.map(([distance, x, y]) => [
    distance,
    longitudeAtMeters(x),
    latitudeAtMeters(y)
  ]);
  const timetable = createTimetable({
    stopShapeDist: [0, 972],
    shapePoints,
    stopCoordinates: [
      [longitudeAtMeters(0), latitudeAtMeters(0)],
      [longitudeAtMeters(265), latitudeAtMeters(20)]
    ]
  });
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 972,
    position: {
      latitude: latitudeAtMeters(0),
      longitude: longitudeAtMeters(0)
    }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1060,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    doorOpen: true,
    position: {
      latitude: latitudeAtMeters(20),
      longitude: longitudeAtMeters(95)
    }
  })), timetable);
  builder.flushPendingStationaryFeeds();

  const incident = incidents[0];
  const state = builder.vehicleStates.get('vehicle');
  assert.equal(incidents.length, 1);
  assert.equal(
    incident.correctionBasis,
    'valid shape projection anchored by the previous closed-door stop_distance'
  );
  assert.equal(incident.reportedStopDistance, 0);
  assert.equal(incident.previous.reportedStopDistance, 972);
  assert.ok(incident.correctedStopDistance > 160);
  assert.ok(incident.correctedStopDistance < 180);
  assert.equal(
    state.lastSample.reportedStopDistance,
    incident.correctedStopDistance
  );
});

test('trusts door-open zero stop_distance within 50m of the stop', () => {
  const incidents = [];
  const builder = createBuilder({
    onDoorOpenStopDistanceCorrection: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable({
    shapePoints: [
      [0, 19, 47.5],
      [100, 19.00134, 47.5],
      [200, 19.00268, 47.5]
    ],
    stopCoordinates: [
      [19, 47.5],
      [19.00134, 47.5],
      [19.00268, 47.5]
    ]
  });
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 10,
    position: { latitude: 47.5, longitude: 19.00120 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1002,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    doorOpen: true,
    currentStatus: 1,
    position: { latitude: 47.5, longitude: 19.00134 }
  })), timetable);
  builder.flushPendingStationaryFeeds();

  assert.equal(incidents.length, 0);
  assert.equal(
    builder.vehicleStates.get('vehicle').lastSample.reportedStopDistance,
    0
  );
});

test('corrects a near-stop door-open zero that causes a progress-speed spike', () => {
  const incidents = [];
  const builder = createBuilder({
    onDoorOpenStopDistanceCorrection: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable({
    shapePoints: [
      [0, 19, 47.5],
      [100, 19.00134, 47.5],
      [200, 19.00268, 47.5]
    ],
    stopCoordinates: [
      [19, 47.5],
      [19.00134, 47.5],
      [19.00268, 47.5]
    ]
  });
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 42,
    position: { latitude: 47.5, longitude: 19.00178 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1001,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    doorOpen: true,
    currentStatus: 1,
    position: { latitude: 47.5, longitude: 19.00180 }
  })), timetable);
  builder.flushPendingStationaryFeeds();

  const state = builder.vehicleStates.get('vehicle');
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].correctedTarget, 'current');
  assert.equal(incidents[0].candidateSpeedMps, 42);
  assert.ok(incidents[0].distanceToStopMeters > 0);
  assert.ok(incidents[0].distanceToStopMeters <= 50);
  assert.ok(
    Math.abs(
      state.lastSample.reportedStopDistance -
        incidents[0].distanceToStopMeters
    ) < 0.1
  );
  assert.ok(state.recentSpeedTransitions.at(-1).speedMps <= 35);
});

test('quarantines backward stop sequences until GPS validates stop_distance', () => {
  const incidents = [];
  const feedDispositions = [];
  const builder = createBuilder({
    onStopSequenceRegression: (incident) => incidents.push(incident),
    onFeedDisposition: (disposition) => feedDispositions.push(disposition)
  });
  const stopCoordinates = [
    [19, 47.5],
    [19.00134, 47.5],
    [19.00268, 47.5],
    [19.00402, 47.5],
    [19.00536, 47.5]
  ];
  const timetable = createTimetable({
    stopShapeDist: [0, 100, 200, 300, 400],
    shapePoints: [
      [0, 19, 47.5],
      [100, 19.00134, 47.5],
      [200, 19.00268, 47.5],
      [300, 19.00402, 47.5],
      [400, 19.00536, 47.5],
      [500, 19.00670, 47.5]
    ],
    stopCoordinates
  });

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 3,
    stopId: 'C',
    stopDistance: 200,
    currentStatus: 2,
    position: { latitude: 47.5, longitude: 19.00268 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1020,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: { latitude: 47.5, longitude: 19.003 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1030,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: { latitude: 47.5, longitude: 19.003 }
  })), timetable);

  builder.flushPendingStationaryFeeds();
  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.lastSample.timestamp, 1000);
  assert.equal(state.stopSequenceRegression.invalidatedFeedCount, 2);
  assert.equal(builder.summary().stopSequenceRegressionRejectedFeeds, 2);
  assert.equal(
    feedDispositions.filter((disposition) =>
      disposition.reason === 'stop-sequence-regression'
    ).length,
    2
  );

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1040,
    sequence: 5,
    stopId: 'E',
    stopDistance: 0,
    currentStatus: 1,
    position: { latitude: 47.5, longitude: 19.00536 }
  })), timetable);

  builder.flushPendingStationaryFeeds();
  assert.equal(incidents.length, 2);
  assert.equal(incidents[0].phase, 'started');
  assert.equal(incidents[0].current.stopIndex, 1);
  assert.ok(incidents[0].differenceMeters > 50);
  assert.equal(incidents[1].phase, 'recovered');
  assert.equal(incidents[1].invalidatedFeedCount, 2);
  assert.ok(incidents[1].differenceMeters <= 50);
  assert.equal(state.stopSequenceRegression, null);
  assert.equal(state.lastSample.timestamp, 1040);
  assert.equal(state.lastSample.stopIndex, 4);
  assert.equal(state.recentSpeedTransitions.length, 0);
  assert.equal(builder.summary().stopSequenceRegressionRecoveries, 1);
});

test('quarantines a backward sequence across a trip change', () => {
  const incidents = [];
  const builder = createBuilder({
    onStopSequenceRegression: (incident) => incidents.push(incident)
  });
  const stopCoordinates = [
    [19, 47.5],
    [19.00134, 47.5],
    [19.00268, 47.5],
    [19.00402, 47.5],
    [19.00536, 47.5]
  ];
  const timetable = createTimetable({
    stopShapeDist: [0, 100, 200, 300, 400],
    shapePoints: [
      [0, 19, 47.5],
      [100, 19.00134, 47.5],
      [200, 19.00268, 47.5],
      [300, 19.00402, 47.5],
      [400, 19.00536, 47.5],
      [500, 19.00670, 47.5]
    ],
    stopCoordinates
  });
  timetable.tripMap['next-trip'] = 0;

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 3,
    stopId: 'C',
    stopDistance: 0,
    position: { latitude: 47.5, longitude: 19.00268 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1005,
    tripId: 'next-trip',
    sequence: 2,
    stopId: 'B',
    stopDistance: 100,
    position: { latitude: 47.5, longitude: 19.00536 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1010,
    tripId: 'next-trip',
    sequence: 5,
    stopId: 'E',
    stopDistance: 0,
    position: { latitude: 47.5, longitude: 19.00536 }
  })), timetable);

  builder.flushPendingStationaryFeeds();
  const state = builder.vehicleStates.get('vehicle');
  assert.equal(incidents.length, 2);
  assert.equal(incidents[0].phase, 'started');
  assert.equal(incidents[0].previous.tripId, 'trip');
  assert.equal(incidents[0].current.tripId, 'next-trip');
  assert.equal(incidents[1].phase, 'recovered');
  assert.equal(incidents[1].invalidatedFeedCount, 1);
  assert.equal(state.stopSequenceRegression, null);
  assert.equal(state.lastSample.timestamp, 1010);
  assert.equal(state.recentSpeedTransitions.length, 0);
  assert.equal(builder.summary().stopSequenceRegressionRejectedFeeds, 1);
});

test('accepts a backward sequence at a trip change when GPS validates it', () => {
  const incidents = [];
  const builder = createBuilder({
    onStopSequenceRegression: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable();
  timetable.tripMap['next-trip'] = 0;

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 3,
    stopId: 'C',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.002 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1005,
    tripId: 'next-trip',
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.001 }
  })), timetable);

  assert.equal(incidents.length, 0);
  assert.equal(builder.vehicleStates.get('vehicle').lastSample.timestamp, 1005);
  assert.equal(builder.summary().stopSequenceRegressionEpisodes, 0);
  assert.equal(builder.summary().stopSequenceRegressionRejectedFeeds, 0);
});

test('corrects repeated lagging feeds on a near-stop door-open zero transition', () => {
  const incidents = [];
  const outliers = [];
  const builder = createBuilder({
    onDoorOpenStopDistanceCorrection: (incident) => incidents.push(incident),
    onSpeedOutlier: (incident) => outliers.push(incident)
  });
  const timetable = createTimetable({
    shapePoints: [
      [0, 19.19261, 47.396871],
      [100, 19.195292, 47.396871],
      [200, 19.19797, 47.396871]
    ],
    stopCoordinates: [
      [19.19261, 47.396871],
      [19.195292, 47.396871],
      [19.19797, 47.396871]
    ]
  });
  const previous = vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 246,
    position: { latitude: 47.396871, longitude: 19.195018 }
  });
  const current = vehicleEntity({
    timestamp: 1005,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    doorOpen: true,
    currentStatus: 1,
    position: { latitude: 47.396871, longitude: 19.19538 }
  });

  builder.processFeed(feed(previous), timetable);
  builder.processFeed(feed(previous), timetable);
  const repeatedBaseline = builder.vehicleStates.get('vehicle').lastSample;
  builder.processFeed(feed(current), timetable);
  builder.flushPendingStationaryFeeds();

  const state = builder.vehicleStates.get('vehicle');
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].correctedTarget, 'previous');
  assert.equal(incidents[0].correctedHistoryFeedCount, 0);
  const previousDistanceToStopMeters =
    incidents[0].previousDistanceToStopMeters;
  assert.equal(incidents[0].reportedStopDistance, 246);
  assert.ok(previousDistanceToStopMeters < 50);
  assert.ok(incidents[0].distanceToStopMeters < 50);
  assert.ok(
    Math.abs(
      incidents[0].previous.reportedStopDistance - previousDistanceToStopMeters
    ) < 0.1
  );
  assert.ok(
    Math.abs(
      repeatedBaseline.reportedStopDistance - previousDistanceToStopMeters
    ) < 0.1
  );
  assert.ok(state.recentSpeedTransitions[0].speedMps < 35);
  assert.equal(outliers.length, 0);
});

test('corrects a consistent lagging stop_distance history back to shape projections', () => {
  const incidents = [];
  const outliers = [];
  const builder = createBuilder({
    onDoorOpenStopDistanceCorrection: (incident) => incidents.push(incident),
    onSpeedOutlier: (incident) => outliers.push(incident)
  });
  const latitude = 47.5;
  const longitudeAtMeters = (meters) =>
    19 + meters / (111320 * Math.cos(latitude * Math.PI / 180));
  const positionAtMeters = (meters) => ({
    latitude,
    longitude: longitudeAtMeters(meters)
  });
  const timetable = createTimetable({
    shapePoints: [
      [0, longitudeAtMeters(0), latitude],
      [100, longitudeAtMeters(100), latitude],
      [200, longitudeAtMeters(200), latitude]
    ],
    stopCoordinates: [
      [longitudeAtMeters(0), latitude],
      [longitudeAtMeters(100), latitude],
      [longitudeAtMeters(200), latitude]
    ]
  });
  const history = [];
  for (const [timestamp, position, stopDistance] of [
    [1000, 40, 140],
    [1005, 55, 125],
    [1010, 70, 110]
  ]) {
    builder.processFeed(feed(vehicleEntity({
      timestamp,
      sequence: 2,
      stopId: 'B',
      stopDistance,
      position: positionAtMeters(position)
    })), timetable);
    history.push(builder.vehicleStates.get('vehicle').lastFeedSample);
  }

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1015,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    doorOpen: true,
    currentStatus: 1,
    position: positionAtMeters(95)
  })), timetable);
  builder.flushPendingStationaryFeeds();

  const incident = incidents[0];
  const state = builder.vehicleStates.get('vehicle');
  assert.equal(incidents.length, 1);
  assert.equal(
    incident.correctionBasis,
    'consistent same-stop history with valid shape projections'
  );
  assert.equal(incident.correctedHistoryFeedCount, 3);
  assert.equal(incident.distinctHistoryObservationCount, 3);
  for (const [index, expectedDistance] of [60, 45, 30].entries()) {
    assert.ok(
      Math.abs(history[index].reportedStopDistance - expectedDistance) < 0.2
    );
  }
  assert.ok(Math.abs(incident.correctedStopDistance - 30) < 0.2);
  assert.ok(state.recentSpeedTransitions.at(-1).speedMps < 35);
  assert.equal(outliers.length, 0);
});

test('does not recover a stop-sequence regression from an unchanged repeated feed', () => {
  const incidents = [];
  const builder = createBuilder({
    onStopSequenceRegression: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 3,
    stopId: 'C',
    stopDistance: 0,
    position: { latitude: 0, longitude: 0.002 }
  })), timetable);

  const state = builder.vehicleStates.get('vehicle');
  const baseline = state.lastSample;
  const rejected = {
    ...baseline,
    source: { archiveName: 'archive', feedName: 'rejected.pb' },
    timestamp: 1010,
    vehicleTimestamp: 1010,
    stopIndex: 1,
    stopId: 'B',
    stopShapeDistance: 100,
    stopPosition: { latitude: 0, longitude: 0.001 },
    feedReportedStopDistance: 0,
    reportedStopDistance: 371,
    doorOpen: true,
    position: { latitude: 0, longitude: 0.001 }
  };
  state.stopSequenceRegression = {
    previous: baseline,
    firstInvalidSample: rejected,
    lastInvalidSample: rejected,
    invalidatedFeedCount: 1
  };
  const repeated = {
    ...rejected,
    source: { archiveName: 'archive', feedName: 'repeated.pb' },
    reportedStopDistance: 0
  };

  const recovered = builder.recoverStopSequenceRegression(state, repeated, {
    gpsDistanceToStopMeters: 48,
    differenceMeters: 48,
    toleranceMeters: 50,
    validates: true
  });

  assert.equal(recovered, false);
  assert.equal(state.stopSequenceRegression.lastInvalidSample, rejected);
  assert.equal(state.lastSample, baseline);
  assert.equal(incidents.length, 0);
});

test('leaves nonzero door-open stop_distance values unchanged', () => {
  const incidents = [];
  const builder = createBuilder({
    onDoorOpenStopDistanceCorrection: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable({
    shapePoints: [
      [0, 19, 47.5],
      [100, 19.00134, 47.5],
      [200, 19.00268, 47.5]
    ],
    stopCoordinates: [
      [19, 47.5],
      [19.00134, 47.5],
      [19.00268, 47.5]
    ]
  });
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 70,
    position: { latitude: 47.5, longitude: 19.00040 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1002,
    sequence: 2,
    stopId: 'B',
    stopDistance: 25,
    doorOpen: true,
    position: { latitude: 47.5, longitude: 19.00044 }
  })), timetable);
  builder.flushPendingStationaryFeeds();

  assert.equal(incidents.length, 0);
  assert.equal(
    builder.vehicleStates.get('vehicle').lastSample.reportedStopDistance,
    25
  );
});

test('keeps correcting zero stop_distance while doors remain open and far from the stop', () => {
  const incidents = [];
  const builder = createBuilder({
    onDoorOpenStopDistanceCorrection: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable({
    shapePoints: [
      [0, 19, 47.5],
      [100, 19.00134, 47.5],
      [200, 19.00268, 47.5]
    ],
    stopCoordinates: [
      [19, 47.5],
      [19.00134, 47.5],
      [19.00268, 47.5]
    ]
  });
  const basePosition = { latitude: 47.5, longitude: 19.00040 };
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 70,
    position: basePosition
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1002,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    doorOpen: true,
    position: { latitude: 47.5, longitude: 19.00044 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1004,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    doorOpen: true,
    position: { latitude: 47.5, longitude: 19.00048 }
  })), timetable);
  builder.flushPendingStationaryFeeds();

  const state = builder.vehicleStates.get('vehicle');
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].reportedStopDistance, 0);
  assert.ok(
    Math.abs(
      state.lastSample.reportedStopDistance -
        (70 - incidents[0].gpsMovementMeters * 2)
    ) < 0.1
  );
});

test('classifies complete stop pairs and aggregates speeds and open-door waits', () => {
  const builder = createBuilder();
  const timetable = createTimetable();
  const samples = [
    vehicleEntity({
      timestamp: 1000,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      doorOpen: true,
      currentStatus: 1
    }),
    vehicleEntity({
      timestamp: 1001,
      sequence: 2,
      stopId: 'B',
      stopDistance: 80
    }),
    vehicleEntity({
      timestamp: 1005,
      sequence: 2,
      stopId: 'B',
      stopDistance: 0,
    }),
    vehicleEntity({
      timestamp: 1006,
      sequence: 2,
      stopId: 'B',
      stopDistance: 0,
      doorOpen: true,
      currentStatus: 1
    })
  ];
  for (const sample of samples) builder.processFeed(feed(sample), timetable);
  builder.flushPendingStationaryFeeds();

  const pair = builder.speedGraph.get(JSON.stringify(['A', 'B']));
  const fastBuckets = pair.classes.get('fast');
  assert.equal(fastBuckets.size, 5);
  assert.equal(fastBuckets.get(0).sampleCount, 1);
  assert.equal(fastBuckets.get(0).speedSumMps, 20);
  for (let bucket = 1; bucket < 5; bucket++) {
    assert.equal(fastBuckets.get(bucket).speedSumMps, 20);
  }

  const routeWaits = builder.waitingGraph.get('route');
  assert.equal(routeWaits.get('A').get('fast').totalSeconds, 0.5);
  assert.equal(routeWaits.get('B').get('fast').totalSeconds, 0.5);

  const summary = builder.summary();
  const fastStats = summary.trafficClassStats.fast;
  assert.equal(summary.speedBuckets, 5);
  assert.equal(summary.speedSamples, 5);
  assert.equal(summary.averageSamplesPerBucket, 1);
  assert.equal(fastStats.bucketCount, 5);
  assert.equal(fastStats.speedSamples, 5);
  assert.equal(fastStats.speedSampleSharePercent, 100);
  assert.equal(fastStats.averageSamplesPerBucket, 1);
  assert.equal(fastStats.medianSamplesPerBucket, 1);
  assert.equal(fastStats.bucketSampleDistribution['1'], 5);
  assert.equal(fastStats.speedMedianMps, 20.25);
  assert.equal(fastStats.speed95thPercentileMps, 20.25);
  assert.equal(fastStats.maximumSpeedMps, 20);
  assert.equal(summary.classifiedLegs, 1);
  assert.equal(summary.pendingLegs, 0);
  assert.equal(summary.vehicleObservations, 4);
  assert.equal(summary.rejectedVehicleObservations, 0);
  assert.equal(summary.rejectedFeedPairs, 0);
});

test('uses the specified fast, normal, slow, and very-slow thresholds', () => {
  assert.equal(classForDuration(8.4), 'fast');
  assert.equal(classForDuration(8.5), 'normal');
  assert.equal(classForDuration(11.5), 'normal');
  assert.equal(classForDuration(11.6), 'slow');
  assert.equal(classForDuration(15), 'slow');
  assert.equal(classForDuration(15.1), 'very_slow');
});

test('rejects high-drift feeds and rechecks buffered preceding feeds', () => {
  const rejections = [];
  const feedDispositions = [];
  const builder = createBuilder({
    onGpsDriftRejection: (rejection) => rejections.push(rejection),
    onFeedDisposition: (disposition) => feedDispositions.push(disposition)
  });
  const timetable = createTimetable();
  const commonSample = {
    sequence: 2,
    stopId: 'B',
    stopDistance: 50
  };

  builder.processFeed(feed(vehicleEntity({
    ...commonSample,
    timestamp: 1000,
    position: { latitude: 47.5, longitude: 19 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    ...commonSample,
    timestamp: 1005,
    position: { latitude: 47.5, longitude: 19.00268 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    ...commonSample,
    timestamp: 1006,
    position: { latitude: 47.5, longitude: 19.00268 }
  })), timetable);
  builder.flushPendingStationaryFeeds();

  assert.deepEqual(
    rejections.map(({ rejectionReason }) => rejectionReason),
    ['back-propagated', 'direct']
  );
  assert.equal(builder.vehicleStates.get('vehicle').lastSample.timestamp, 1000);
  assert.equal(builder.summary().gpsDriftRejectedFeeds, 2);
  assert.equal(builder.summary().rejectedVehicleObservations, 2);
  assert.deepEqual(
    feedDispositions.map(({ reason }) => reason),
    ['gps-drift', 'gps-drift']
  );
});

test('back-propagates rejection using stop-distance-based progress reversals', () => {
  const rejections = [];
  const builder = createBuilder({
    onGpsDriftRejection: (rejection) => rejections.push(rejection)
  });
  const timetable = createTimetable();
  const position = { latitude: 47.5, longitude: 19 };

  for (const sample of [
    {
      timestamp: 1000,
      sequence: 3,
      stopId: 'C',
      stopDistance: 150
    },
    {
      timestamp: 1005,
      sequence: 3,
      stopId: 'C',
      stopDistance: 0
    },
    {
      timestamp: 1010,
      sequence: 3,
      stopId: 'C',
      stopDistance: 150
    }
  ]) {
    builder.processFeed(feed(vehicleEntity({
      ...sample,
      position
    })), timetable);
  }
  builder.flushPendingStationaryFeeds();

  const jumpedFeedRejection = rejections.find(
    ({ sample }) => sample.vehicleTimestamp === 1005
  );
  assert.equal(jumpedFeedRejection.rejectionReason, 'back-propagated');
  assert.equal(jumpedFeedRejection.progressDeltaMeters, 150);
  assert.equal(jumpedFeedRejection.backpropagatedProgressDeltaMeters, -150);
  assert.equal(jumpedFeedRejection.backpropagatedProgressPenalty, 140);
  assert.equal(builder.vehicleStates.get('vehicle').lastSample.timestamp, 1000);
  assert.equal(
    builder.speedGraph.has(JSON.stringify(['B', 'C'])),
    false
  );
});

test('scores repeated timestamp and GPS-position feeds from the prior distinct fix', () => {
  const rejections = [];
  const builder = createBuilder({
    onGpsDriftRejection: (rejection) => rejections.push(rejection)
  });
  const timetable = createTimetable();
  const commonSample = {
    sequence: 2,
    stopId: 'B',
    stopDistance: 50
  };
  const firstPosition = { latitude: 47.5, longitude: 19 };
  const jumpedPosition = { latitude: 47.5, longitude: 19.00036 };

  for (const sample of [
    { timestamp: 1000, position: firstPosition },
    { timestamp: 1001, position: firstPosition },
    { timestamp: 1002, position: jumpedPosition },
    { timestamp: 1002, position: jumpedPosition }
  ]) {
    builder.processFeed(feed(vehicleEntity({
      ...commonSample,
      ...sample
    })), timetable);
  }
  builder.flushPendingStationaryFeeds();

  const repeatedFeedRejection = rejections.find(
    (rejection) => rejection.duplicateGpsObservation
  );
  assert.ok(repeatedFeedRejection);
  assert.ok(repeatedFeedRejection.score > 100);
  assert.ok(repeatedFeedRejection.speedMps > 25);
  assert.equal(builder.vehicleStates.get('vehicle').lastSample.timestamp, 1001);
});

test('ignores backward-timestamp feeds without replacing the correction baseline', () => {
  const feedDispositions = [];
  const builder = createBuilder({
    onFeedDisposition: (disposition) => feedDispositions.push(disposition)
  });
  const timetable = createTimetable();
  const commonSample = {
    sequence: 2,
    stopId: 'B',
    stopDistance: 50,
    position: { latitude: 47.5, longitude: 19 }
  };

  builder.processFeed(feed(vehicleEntity({
    ...commonSample,
    timestamp: 1000
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    ...commonSample,
    timestamp: 1010
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    ...commonSample,
    timestamp: 1005,
    stopDistance: 0
  })), timetable);

  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.lastFeedSample.timestamp, 1010);
  assert.equal(state.lastFeedSample.reportedStopDistance, 50);
  assert.equal(feedDispositions.length, 1);
  assert.equal(feedDispositions[0].reason, 'timestamp-regression');
  assert.equal(feedDispositions[0].sample.timestamp, 1005);
  assert.equal(feedDispositions[0].previous.timestamp, 1010);

  builder.processFeed(feed(vehicleEntity({
    ...commonSample,
    timestamp: 1015
  })), timetable);

  assert.equal(state.lastFeedSample.timestamp, 1015);
  const summary = builder.summary();
  assert.equal(summary.vehicleObservations, 4);
  assert.equal(summary.rejectedSamples, 1);
  assert.equal(summary.rejectedVehicleObservations, 1);
  assert.equal(summary.rejectedFeedPairs, 1);
});

test('aggregates speed buckets across routes and keeps waits route-specific', () => {
  const builder = createBuilder();
  const timetable = createTimetable();
  timetable.routeMap.route2 = 1;
  timetable.tripMap.trip2 = 1;
  timetable.trips.push({
    route: { _id: 1, name: 'R2' },
    shape_id: 'shape',
    stops: defaultShapeCoordinates.map(([lon, lat], index) => ({
      _id: index,
      lon,
      lat
    })),
    stopArr: [0, 10, 20],
    stopDep: [0, 10, 20],
    stopShapeDist: [0, 100, 200]
  });

  for (const [id, tripId] of [['one', 'trip'], ['two', 'trip2']]) {
    builder.processFeed(feed(vehicleEntity({
      id,
      tripId,
      timestamp: 1000,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      doorOpen: true,
      currentStatus: 1
    })), timetable);
    builder.processFeed(feed(vehicleEntity({
      id,
      tripId,
      timestamp: 1002,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      doorOpen: true,
      currentStatus: 1
    })), timetable);
    builder.processFeed(feed(vehicleEntity({
      id,
      tripId,
      timestamp: 1003,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      currentStatus: 1
    })), timetable);
    builder.processFeed(feed(vehicleEntity({
      id,
      tripId,
      timestamp: 1010,
      sequence: 2,
      stopId: 'B',
      stopDistance: 0,
      currentStatus: 1
    })), timetable);
    builder.processFeed(feed(vehicleEntity({
      id,
      tripId,
      timestamp: 1011,
      sequence: 2,
      stopId: 'B',
      stopDistance: 0,
      doorOpen: true,
      currentStatus: 1
    })), timetable);
  }
  builder.flushPendingStationaryFeeds();

  const pair = builder.speedGraph.get(JSON.stringify(['A', 'B']));
  const normalBuckets = pair.classes.get('normal');
  assert.equal(normalBuckets.get(0).sampleCount, 2);
  assert.equal(normalBuckets.get(0).speedSumMps, 2 * (100 / 7));
  assert.equal(builder.waitingGraph.get('route').get('A').get('normal').totalSeconds, 2.5);
  assert.equal(builder.waitingGraph.get('route2').get('A').get('normal').totalSeconds, 2.5);
  assert.equal(builder.waitingGraph.get('route').get('B').get('normal').totalSeconds, 0.5);
  assert.equal(builder.waitingGraph.get('route2').get('B').get('normal').totalSeconds, 0.5);

  const normalStats = builder.summary().trafficClassStats.normal;
  assert.equal(normalStats.bucketCount, 5);
  assert.equal(normalStats.speedSamples, 10);
  assert.equal(normalStats.bucketSampleDistribution['2-4'], 5);
});

test('tracks unclassified and pending legs with speed observations', () => {
  const builder = createBuilder();
  const timetable = createTimetable();
  const samples = [
    vehicleEntity({
      timestamp: 1000,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50
    }),
    vehicleEntity({
      timestamp: 1005,
      sequence: 3,
      stopId: 'C',
      stopDistance: 50
    }),
    vehicleEntity({
      timestamp: 1010,
      sequence: 3,
      stopId: 'C',
      stopDistance: 10
    })
  ];
  for (const sample of samples) builder.processFeed(feed(sample), timetable);

  const summary = builder.summary();
  assert.equal(summary.classifiedLegs, 0);
  assert.equal(summary.unclassifiedLegs, 1);
  assert.equal(summary.pendingLegs, 1);
  assert.equal(summary.speedSamples, 0);
});

test('uses stop_distance for movement while the timetable shape distance stays fixed', () => {
  const builder = createBuilder();
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 999,
    sequence: 1,
    stopId: 'A',
    stopDistance: 0,
    currentStatus: 1
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 80
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1001,
    sequence: 2,
    stopId: 'B',
    stopDistance: 60
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1002,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    currentStatus: 1
  })), timetable);

  builder.flushPendingStationaryFeeds();
  const pair = builder.speedGraph.get(JSON.stringify(['A', 'B']));
  const fastBuckets = pair.classes.get('fast');
  assert.equal(fastBuckets.get(0).speedSumMps, 20);
  assert.equal(fastBuckets.get(1).speedSumMps, 20);
  assert.equal(fastBuckets.get(2).speedSumMps, 60);
  assert.equal(fastBuckets.get(3).speedSumMps, 60);
  assert.equal(fastBuckets.get(4).speedSumMps, 60);
  assert.equal(builder.summary().rejectedFeedPairs, 0);
});

test('uses the full elapsed time for a door-open transition', () => {
  const builder = createBuilder();
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 1,
    stopId: 'A',
    stopDistance: 0,
    currentStatus: 1
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1005,
    sequence: 2,
    stopId: 'B',
    stopDistance: 50,
    doorOpen: true
  })), timetable);
  builder.flushPendingStationaryFeeds();

  assert.equal(
    builder.vehicleStates.get('vehicle').pendingSpeeds.get(1)[0].speedMps,
    10
  );
});

test('flags a stuck door sensor after 100m from the first open-door GPS position', () => {
  const anomalies = [];
  const builder = createBuilder({
    onDoorSensorStuck: (anomaly) => anomalies.push(anomaly)
  });
  const timetable = createTimetable();
  const samples = [
    vehicleEntity({
      timestamp: 1000,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      doorOpen: true,
      currentStatus: 1,
      position: { latitude: 0, longitude: 0 }
    }),
    vehicleEntity({
      timestamp: 1010,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      doorOpen: true,
      currentStatus: 1,
      position: { latitude: 0, longitude: 0.00036 }
    }),
    vehicleEntity({
      timestamp: 1020,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      doorOpen: true,
      currentStatus: 1,
      position: { latitude: 0, longitude: 0.00072 }
    }),
    vehicleEntity({
      timestamp: 1030,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      doorOpen: true,
      currentStatus: 1,
      position: { latitude: 0, longitude: 0.001 }
    })
  ];
  for (const sample of samples) builder.processFeed(feed(sample), timetable);

  builder.flushPendingStationaryFeeds();
  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.doorSensorStuck, true);
  assert.equal(builder.summary().doorSensorStuckTrips, 1);
  assert.equal(builder.summary().doorSensorRejectedFeedPairs, 3);
  assert.equal(builder.summary().rejectedFeedPairs, 3);
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].startTimestamp, 1000);
  assert.equal(anomalies[0].detectedTimestamp, 1030);
  assert.equal(anomalies[0].bufferedFeedCount, 3);
  assert.ok(anomalies[0].distanceMeters >= 100);
  assert.equal(state.pendingDoorOpenSensorSamples, null);
  assert.equal(state.lastSample.timestamp, 1030);
});

test('flushes buffered open-door samples normally if doors close before movement threshold', () => {
  const builder = createBuilder();
  const timetable = createTimetable();
  const samples = [
    vehicleEntity({
      timestamp: 1000,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      doorOpen: true,
      currentStatus: 1,
      position: { latitude: 0, longitude: 0 }
    }),
    vehicleEntity({
      timestamp: 1010,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      doorOpen: true,
      currentStatus: 1,
      position: { latitude: 0, longitude: 0.00025 }
    }),
    vehicleEntity({
      timestamp: 1020,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      doorOpen: true,
      currentStatus: 1,
      position: { latitude: 0, longitude: 0.0005 }
    }),
    vehicleEntity({
      timestamp: 1030,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      doorOpen: false,
      position: { latitude: 0, longitude: 0.00055 }
    })
  ];
  for (const sample of samples) builder.processFeed(feed(sample), timetable);

  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.doorSensorStuck, false);
  assert.equal(builder.summary().doorSensorStuckTrips, 0);
  assert.equal(builder.summary().doorSensorRejectedFeedPairs, 0);
  assert.equal(state.pendingDoorOpenSensorSamples, null);
  assert.equal(state.lastSample.timestamp, 1030);
});

test('caps the door-open sensor lookback at 12 feeds', () => {
  const builder = createBuilder();
  const timetable = createTimetable();
  for (let timestamp = 1000; timestamp < 1015; timestamp++) {
    builder.processFeed(feed(vehicleEntity({
      timestamp,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      doorOpen: true,
      position: { latitude: 0, longitude: 0 }
    })), timetable);
  }

  const state = builder.vehicleStates.get('vehicle');
  const pending = state.pendingDoorOpenSensorSamples;
  assert.ok(pending.samples.length + (pending.initialSample ? 1 : 0) <= 12);
  assert.ok(state.lastSample.timestamp < 1014);

  builder.flushPendingStationaryFeeds();

  assert.equal(state.pendingDoorOpenSensorSamples, null);
  assert.equal(state.lastSample.timestamp, 1014);
  assert.equal(state.doorSensorStuck, false);
});

test('adds parallel non-stopping buckets only around door-closed stop crossings', () => {
  const builder = createBuilder();
  const timetable = createTimetable();
  const samples = [
    vehicleEntity({
      timestamp: 1000,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      currentStatus: 1
    }),
    vehicleEntity({
      timestamp: 1005,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50
    }),
    vehicleEntity({
      timestamp: 1015,
      sequence: 3,
      stopId: 'C',
      stopDistance: 0
    }),
    vehicleEntity({
      timestamp: 1030,
      sequence: 3,
      stopId: 'C',
      stopDistance: 0
    })
  ];
  for (const sample of samples) builder.processFeed(feed(sample), timetable);
  builder.flushPendingStationaryFeeds();

  const pair = builder.speedGraph.get(JSON.stringify(['A', 'B']));
  assert.ok(pair.classes.get('fast').size > 0);
  assert.ok(pair.nonStoppingClasses.get('fast').size > 0);
  assert.equal(builder.summary().trafficClassStats.fast.nonStoppingSpeedSamples > 0, true);
});

test('clips non-stopping samples to the time window around a passed stop', () => {
  const builder = createBuilder();
  const timetable = createTimetable();
  timetable.trips[0].stopArr = [0, 20, 40];
  const samples = [
    vehicleEntity({
      timestamp: 1000,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      currentStatus: 1
    }),
    vehicleEntity({
      timestamp: 1025,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50
    }),
    vehicleEntity({
      timestamp: 1040,
      sequence: 3,
      stopId: 'C',
      stopDistance: 0
    }),
    vehicleEntity({
      timestamp: 1051,
      sequence: 3,
      stopId: 'C',
      stopDistance: 0
    })
  ];
  for (const sample of samples) builder.processFeed(feed(sample), timetable);

  builder.flushPendingStationaryFeeds();
  const pair = builder.speedGraph.get(JSON.stringify(['A', 'B']));
  const mainSamples = [...pair.classes.get('slow').values()]
    .reduce((total, bucket) => total + bucket.sampleCount, 0);
  const nonStoppingSamples = [...pair.nonStoppingClasses.get('slow').values()]
    .reduce((total, bucket) => total + bucket.sampleCount, 0);
  assert.ok(nonStoppingSamples > 0);
  assert.ok(nonStoppingSamples < mainSamples);
});

test('door-open evidence prevents a crossing from creating non-stopping buckets', () => {
  const builder = createBuilder();
  const timetable = createTimetable();
  const samples = [
    vehicleEntity({
      timestamp: 1000,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      currentStatus: 1
    }),
    vehicleEntity({
      timestamp: 1005,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50
    }),
    vehicleEntity({
      timestamp: 1015,
      sequence: 3,
      stopId: 'C',
      stopDistance: 0,
      doorOpen: true
    })
  ];
  for (const sample of samples) builder.processFeed(feed(sample), timetable);
  builder.flushPendingStationaryFeeds();

  const pair = builder.speedGraph.get(JSON.stringify(['A', 'B']));
  assert.equal(pair.nonStoppingClasses.size, 0);
});

test('door-open evidence later in the window cancels pending non-stopping samples', () => {
  const builder = createBuilder();
  const timetable = createTimetable();
  const samples = [
    vehicleEntity({
      timestamp: 1000,
      sequence: 1,
      stopId: 'A',
      stopDistance: 0,
      currentStatus: 1
    }),
    vehicleEntity({
      timestamp: 1005,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50
    }),
    vehicleEntity({
      timestamp: 1015,
      sequence: 3,
      stopId: 'C',
      stopDistance: 50
    }),
    vehicleEntity({
      timestamp: 1020,
      sequence: 3,
      stopId: 'C',
      stopDistance: 40,
      doorOpen: true
    }),
    vehicleEntity({
      timestamp: 1031,
      sequence: 3,
      stopId: 'C',
      stopDistance: 40
    })
  ];
  for (const sample of samples) builder.processFeed(feed(sample), timetable);

  builder.flushPendingStationaryFeeds();
  const pair = builder.speedGraph.get(JSON.stringify(['A', 'B']));
  assert.equal(pair.nonStoppingClasses.size, 0);
});

test('uses raw shape chainage without modifying source distances or requiring geometry bounds', () => {
  const rawShapeDistance = [0, 24728, 24828];
  const timetable = createTimetable({
    stopShapeDist: rawShapeDistance,
    shapePoints: [
      [0, 0, 0],
      [24728, 0.222, 0],
      [24828, 0.223, 0]
    ]
  });
  const originalShape = structuredClone(timetable.shapes.shape);
  const originalStopDistances = [...timetable.trips[0].stopShapeDist];
  const builder = createBuilder();

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1010,
    sequence: 2,
    stopId: 'B',
    stopDistance: 24607
  })), timetable);

  const sample = builder.vehicleStates.get('vehicle').lastSample;
  assert.equal(sample.reportedStopDistance, 24607);
  assert.equal(sample.progress, 121);
  assert.equal(sample.distanceToStop, 24607);
  assert.deepEqual(timetable.shapes.shape, originalShape);
  assert.deepEqual(timetable.trips[0].stopShapeDist, originalStopDistances);
  assert.equal(builder.summary().rejectedVehicleObservations, 0);
});

test('rejects shape-distance legs outside the shape and logs detailed errors', () => {
  const validationErrors = [];
  const timetable = createTimetable({
    stopShapeDist: [0, 10000, 200],
    onShapeDistanceValidationError: (message) => validationErrors.push(message)
  });
  const builder = createBuilder();

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 1,
    stopId: 'A',
    stopDistance: 0,
    currentStatus: 1
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1010,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    currentStatus: 1
  })), timetable);

  assert.equal(builder.speedGraph.size, 0);
  assert.equal(builder.summary().speedSamples, 0);
  assert.equal(validationErrors.length, 2);
  assert.match(validationErrors[0], /trip trip \(route 0\), shape shape/);
  assert.match(validationErrors[0], /stop 0 \(sequence 1\) -> 1 \(sequence 2\)/);
  assert.match(validationErrors[0], /0 -> 10000/);
  assert.match(validationErrors[0], /outside common shape range \[0, 200\]/);
});

test('reports over-limit speed samples with source and vehicle-stop details', () => {
  const outliers = [];
  const builder = createBuilder({
    onSpeedOutlier: (outlier) => outliers.push(outlier)
  });
  const timetable = createTimetable();
  timetable.trips[0].stops[0].name = 'Stop A';
  timetable.trips[0].stops[1].name = 'Stop B';
  builder.processFeed(feed(vehicleEntity({
    id: 'bus-17',
    label: 'Vehicle 42',
    timestamp: 1000,
    sequence: 1,
    stopId: 'A',
    stopDistance: 0,
    currentStatus: 1
  })), timetable, {
    archiveName: '2026-10-06T11.tar.gz',
    feedName: 'feed-1.pb'
  });
  builder.processFeed(feed(vehicleEntity({
    id: 'bus-17',
    label: 'Vehicle 42',
    timestamp: 1001,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    currentStatus: 1
  })), timetable, {
    archiveName: '2026-10-06T11.tar.gz',
    feedName: 'feed-2.pb'
  });

  builder.flushPendingStationaryFeeds();
  assert.equal(outliers.length, 1);
  assert.equal(outliers[0].speedMps, 100);
  assert.equal(outliers[0].limitMps, 35);
  assert.equal(outliers[0].vehicleId, 'bus-17');
  assert.equal(outliers[0].vehicleName, 'Vehicle 42');
  assert.deepEqual(outliers[0].fromStop, { id: 'A', name: 'Stop A' });
  assert.deepEqual(outliers[0].toStop, { id: 'B', name: 'Stop B' });
  assert.equal(outliers[0].previous.source.feedName, 'feed-1.pb');
  assert.equal(outliers[0].current.source.feedName, 'feed-2.pb');
  assert.equal(outliers[0].elapsedSeconds, 1);
  assert.equal(outliers[0].distanceMeters, 100);
  assert.equal(outliers[0].previous.reportedStopDistance, 0);
  assert.equal(outliers[0].current.reportedStopDistance, 0);
  assert.equal(builder.summary().speedOutlierCount, 1);

  const boundaryOutliers = [];
  const boundaryBuilder = createBuilder({
    onSpeedOutlier: (outlier) => boundaryOutliers.push(outlier)
  });
  boundaryBuilder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 1,
    stopId: 'A',
    stopDistance: 0,
    currentStatus: 1
  })), timetable);
  boundaryBuilder.processFeed(feed(vehicleEntity({
    timestamp: 1000 + 100 / 35,
    sequence: 2,
    stopId: 'B',
    stopDistance: 0,
    currentStatus: 1
  })), timetable);
  assert.equal(boundaryOutliers.length, 0);
});

test('drops a stationary stale-GPS feed and bridges its previous and next samples', () => {
  const incidents = [];
  const feedDispositions = [];
  const builder = createBuilder({
    onGpsSignalLost: (incident) => incidents.push(incident),
    onFeedDisposition: (disposition) => feedDispositions.push(disposition)
  });
  const timetable = createTimetable();
  const samples = [
    vehicleEntity({
      timestamp: 1000,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50,
      position: { latitude: 47.5, longitude: 19 }
    }),
    vehicleEntity({
      timestamp: 1016,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50,
      position: { latitude: 47.5, longitude: 19 }
    }),
    vehicleEntity({
      timestamp: 1017,
      sequence: 2,
      stopId: 'B',
      stopDistance: 4,
      position: { latitude: 47.500419, longitude: 19 }
    })
  ];

  for (const [index, sample] of samples.entries()) {
    builder.processFeed(feed(sample), timetable, { feedName: `feed-${index}.pb` });
    if (index === 1) {
      const state = builder.vehicleStates.get('vehicle');
      assert.equal(state.lastSample.timestamp, 1000);
      assert.equal(state.pendingStationaryFeeds.samples[1].sample.timestamp, 1016);
    }
  }

  builder.flushPendingStationaryFeeds();
  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.pendingStationaryFeeds, null);
  assert.equal(state.lastSample.timestamp, 1017);
  assert.equal(state.recentSpeedTransitions.length, 1);
  assert.equal(state.recentSpeedTransitions[0].previous.timestamp, 1000);
  assert.equal(state.recentSpeedTransitions[0].current.timestamp, 1017);
  assert.ok(Math.abs(state.recentSpeedTransitions[0].speedMps - 46 / 17) < 0.01);
  assert.equal(builder.summary().stationaryGpsSamplesDropped, 1);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].previous.source.feedName, 'feed-0.pb');
  assert.equal(incidents[0].stationary.source.feedName, 'feed-1.pb');
  assert.equal(incidents[0].recovery.source.feedName, 'feed-2.pb');
  assert.equal(incidents[0].routeName, 'R1');
  assert.equal(incidents[0].stationaryIntervalSeconds, 16);
  assert.equal(incidents[0].recoveryIntervalSeconds, 1);
  assert.equal(incidents[0].stationaryDistanceMeters, 0);
  assert.ok(incidents[0].recoveryDistanceMeters > 5);
  assert.deepEqual(
    feedDispositions.map(({ kind, reason }) => [kind, reason]),
    [['dropped', 'stationary-gps-merged']]
  );
  assert.equal(incidents[0].bridgedElapsedSeconds, 17);
  assert.equal(incidents[0].bridgedProgressMeters, 46);
  assert.ok(Math.abs(incidents[0].correctedSpeedMps - 46 / 17) < 0.01);
  assert.equal(
    incidents[0].correctedSpeedMps,
    state.recentSpeedTransitions[0].speedMps
  );
  assert.equal(incidents[0].mergedSamples.length, 1);
  assert.equal(incidents[0].preservedDoorOpenSamples.length, 0);
});

test('merges multiple consecutive stationary feeds before a GPS recovery', () => {
  const incidents = [];
  const builder = createBuilder({
    onGpsSignalLost: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable();
  const position = { latitude: 47.5, longitude: 19 };
  const samples = [
    vehicleEntity({
      timestamp: 1000,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50,
      position
    }),
    ...[1016, 1017, 1018, 1019].map((timestamp) => vehicleEntity({
      timestamp,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50,
      position
    })),
    vehicleEntity({
      timestamp: 1020,
      sequence: 2,
      stopId: 'B',
      stopDistance: 4,
      position: { latitude: 47.500419, longitude: 19 }
    })
  ];

  for (const sample of samples) builder.processFeed(feed(sample), timetable);

  builder.flushPendingStationaryFeeds();
  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.lastSample.timestamp, 1020);
  assert.equal(state.pendingStationaryFeeds, null);
  assert.equal(state.recentSpeedTransitions.length, 1);
  assert.equal(state.recentSpeedTransitions[0].previous.timestamp, 1000);
  assert.equal(state.recentSpeedTransitions[0].current.timestamp, 1020);
  assert.equal(builder.summary().stationaryGpsSamplesDropped, 4);
  assert.equal(incidents.length, 1);
  assert.deepEqual(
    incidents[0].mergedSamples.map((sample) => sample.timestamp),
    [1016, 1017, 1018, 1019]
  );
  assert.equal(incidents[0].bridgedElapsedSeconds, 20);
  assert.ok(Math.abs(incidents[0].correctedSpeedMps - 46 / 20) < 0.01);
});

test('merges a stale stop_distance feed when the next sample updates the distance', () => {
  const incidents = [];
  const builder = createBuilder({
    onDelayedStopDistance: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable();
  const samples = [
    vehicleEntity({
      timestamp: 1000,
      sequence: 2,
      stopId: 'B',
      stopDistance: 70,
      position: { latitude: 47.5, longitude: 19 }
    }),
    vehicleEntity({
      timestamp: 1011,
      sequence: 2,
      stopId: 'B',
      stopDistance: 70,
      position: { latitude: 47.50126, longitude: 19 }
    }),
    vehicleEntity({
      timestamp: 1012,
      sequence: 2,
      stopId: 'B',
      stopDistance: 15,
      position: { latitude: 47.501375, longitude: 19 }
    })
  ];

  for (const [index, sample] of samples.entries()) {
    builder.processFeed(feed(sample), timetable, { feedName: `feed-${index}.pb` });
  }

  builder.flushPendingStationaryFeeds();
  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.pendingDelayedStopDistanceFeeds, null);
  assert.equal(state.lastSample.timestamp, 1012);
  assert.equal(state.recentSpeedTransitions.length, 1);
  assert.equal(state.recentSpeedTransitions[0].previous.timestamp, 1000);
  assert.equal(state.recentSpeedTransitions[0].current.timestamp, 1012);
  assert.ok(Math.abs(state.recentSpeedTransitions[0].speedMps - 55 / 12) < 0.01);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].previous.source.feedName, 'feed-0.pb');
  assert.equal(incidents[0].mergedSamples[0].source.feedName, 'feed-1.pb');
  assert.equal(incidents[0].updated.source.feedName, 'feed-2.pb');
  assert.ok(incidents[0].gpsMovementMeters > 10);
  assert.ok(Math.abs(incidents[0].correctedSpeedMps - 55 / 12) < 0.01);
});

test('requires more than 10m of GPS movement and does not buffer door-open feeds', () => {
  const timetable = createTimetable();
  const smallMovementBuilder = createBuilder();
  smallMovementBuilder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 70,
    position: { latitude: 47.5, longitude: 19 }
  })), timetable);
  smallMovementBuilder.processFeed(feed(vehicleEntity({
    timestamp: 1011,
    sequence: 2,
    stopId: 'B',
    stopDistance: 70,
    position: { latitude: 47.50008, longitude: 19 }
  })), timetable);
  smallMovementBuilder.flushPendingStationaryFeeds();
  assert.equal(
    smallMovementBuilder.vehicleStates.get('vehicle').pendingDelayedStopDistanceFeeds,
    null
  );

  const doorOpenBuilder = createBuilder();
  doorOpenBuilder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 70,
    position: { latitude: 47.5, longitude: 19 }
  })), timetable);
  doorOpenBuilder.processFeed(feed(vehicleEntity({
    timestamp: 1011,
    sequence: 2,
    stopId: 'B',
    stopDistance: 70,
    doorOpen: true,
    position: { latitude: 47.50126, longitude: 19 }
  })), timetable);
  const pendingDoorOpenState =
    doorOpenBuilder.vehicleStates.get('vehicle');
  doorOpenBuilder.flushPendingGpsDriftSamples(pendingDoorOpenState, true);
  assert.equal(pendingDoorOpenState.pendingDelayedStopDistanceFeeds, null);
  assert.equal(pendingDoorOpenState.lastSample.timestamp, 1000);
  assert.equal(pendingDoorOpenState.pendingDoorOpenSensorSamples.samples.length, 1);
  doorOpenBuilder.flushPendingStationaryFeeds();
  assert.equal(pendingDoorOpenState.lastSample.timestamp, 1011);
  assert.equal(pendingDoorOpenState.lastSample.doorOpen, true);
});

test('flushes pending delayed stop_distance samples when no update arrives', () => {
  const builder = createBuilder();
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 70,
    position: { latitude: 47.5, longitude: 19 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1011,
    sequence: 2,
    stopId: 'B',
    stopDistance: 70,
    position: { latitude: 47.50126, longitude: 19 }
  })), timetable);

  builder.flushPendingStationaryFeeds();

  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.pendingDelayedStopDistanceFeeds, null);
  assert.equal(state.lastSample.timestamp, 1011);
});

test('caps the delayed stop_distance lookback at 12 samples', () => {
  const incidents = [];
  const builder = createBuilder({
    onDelayedStopDistance: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable();
  const position = { latitude: 47.50126, longitude: 19 };
  const timestamps = [1000, 1011, ...Array.from(
    { length: 12 },
    (_, index) => 1012 + index
  )];

  for (const timestamp of timestamps) {
    const isInitial = timestamp === 1000;
    builder.processFeed(feed(vehicleEntity({
      timestamp,
      sequence: 2,
      stopId: 'B',
      stopDistance: 70,
      position: isInitial
        ? { latitude: 47.5, longitude: 19 }
        : position
    })), timetable);
  }

  const state = builder.vehicleStates.get('vehicle');
  builder.flushPendingGpsDriftSamples(state, true);
  assert.equal(state.pendingDelayedStopDistanceFeeds.samples.length, 12);
  assert.equal(state.lastSample.timestamp, 1011);

  builder.processFeed(feed(vehicleEntity({
    timestamp: 1025,
    sequence: 2,
    stopId: 'B',
    stopDistance: 15,
    position: { latitude: 47.501375, longitude: 19 }
  })), timetable);

  builder.flushPendingGpsDriftSamples(state, true);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].mergedSamples.length, 12);
  assert.equal(incidents[0].bridgedPrevious.timestamp, 1011);
});

test('flushes delayed stop_distance candidates at a destination-stop change', () => {
  const incidents = [];
  const builder = createBuilder({
    onDelayedStopDistance: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable();
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1000,
    sequence: 2,
    stopId: 'B',
    stopDistance: 70,
    position: { latitude: 47.5, longitude: 19 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1011,
    sequence: 2,
    stopId: 'B',
    stopDistance: 70,
    position: { latitude: 47.50126, longitude: 19 }
  })), timetable);
  builder.processFeed(feed(vehicleEntity({
    timestamp: 1012,
    sequence: 3,
    stopId: 'C',
    stopDistance: 100,
    position: { latitude: 47.501375, longitude: 19 }
  })), timetable);

  builder.flushPendingStationaryFeeds();
  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.pendingDelayedStopDistanceFeeds, null);
  assert.equal(state.lastSample.timestamp, 1012);
  assert.equal(incidents.length, 0);
});

test('preserves door-open stationary feeds while merging adjacent closed-door feeds', () => {
  const incidents = [];
  const builder = createBuilder({
    onGpsSignalLost: (incident) => incidents.push(incident)
  });
  const timetable = createTimetable();
  const position = { latitude: 47.5, longitude: 19 };
  const samples = [
    vehicleEntity({
      timestamp: 1000,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50,
      position
    }),
    vehicleEntity({
      timestamp: 1016,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50,
      position,
      doorOpen: true
    }),
    vehicleEntity({
      timestamp: 1017,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50,
      position
    }),
    vehicleEntity({
      timestamp: 1018,
      sequence: 2,
      stopId: 'B',
      stopDistance: 4,
      position: { latitude: 47.500419, longitude: 19 }
    })
  ];

  for (const sample of samples) builder.processFeed(feed(sample), timetable);
  builder.flushPendingStationaryFeeds();

  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.lastSample.timestamp, 1018);
  assert.equal(state.pendingStationaryFeeds, null);
  assert.equal(builder.summary().stationaryGpsSamplesDropped, 1);
  assert.equal(incidents.length, 1);
  assert.deepEqual(
    incidents[0].mergedSamples.map((sample) => sample.timestamp),
    [1017]
  );
  assert.deepEqual(
    incidents[0].preservedDoorOpenSamples.map((sample) => sample.timestamp),
    [1016]
  );
  assert.ok(state.doorOpenObservations.some(
    (observation) => observation.timestamp === 1016 && observation.doorOpen
  ));
  assert.equal(incidents[0].bridgedPrevious.timestamp, 1016);
});

test('limits the stationary GPS lookback to 12 pending samples', () => {
  const builder = createBuilder();
  const timetable = createTimetable();
  const position = { latitude: 47.5, longitude: 19 };
  const timestamps = [1000, 1016, ...Array.from(
    { length: 12 },
    (_, index) => 1017 + index
  )];

  for (const timestamp of timestamps) {
    builder.processFeed(feed(vehicleEntity({
      timestamp,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50,
      position
    })), timetable);
  }

  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.pendingStationaryFeeds.samples.length, 12);
  assert.equal(state.lastSample.timestamp, 1016);
});

test('keeps a stationary feed when the following timestamp interval is not under five seconds', () => {
  const builder = createBuilder();
  const timetable = createTimetable();
  const samples = [
    vehicleEntity({
      timestamp: 1000,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50,
      position: { latitude: 47.5, longitude: 19 }
    }),
    vehicleEntity({
      timestamp: 1011,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50,
      position: { latitude: 47.5, longitude: 19 }
    }),
    vehicleEntity({
      timestamp: 1016,
      sequence: 2,
      stopId: 'B',
      stopDistance: 40,
      position: { latitude: 47.5002, longitude: 19 }
    })
  ];

  for (const sample of samples) builder.processFeed(feed(sample), timetable);

  builder.flushPendingStationaryFeeds();
  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.lastSample.timestamp, 1016);
  assert.equal(state.pendingStationaryFeeds, null);
  assert.equal(state.recentSpeedTransitions.length, 1);
  assert.equal(state.recentSpeedTransitions[0].previous.timestamp, 1011);
  assert.equal(builder.summary().stationaryGpsSamplesDropped, 0);
});

test('does not use feed-header timestamps to identify a vehicle GPS recovery', () => {
  const builder = createBuilder();
  const timetable = createTimetable();
  const samples = [
    vehicleEntity({
      timestamp: undefined,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50,
      position: { latitude: 47.5, longitude: 19 }
    }),
    vehicleEntity({
      timestamp: undefined,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50,
      position: { latitude: 47.5, longitude: 19 }
    }),
    vehicleEntity({
      timestamp: undefined,
      sequence: 2,
      stopId: 'B',
      stopDistance: 40,
      position: { latitude: 47.5002, longitude: 19 }
    })
  ];

  for (const [index, sample] of samples.entries()) {
    builder.processFeed({
      ...feed(sample),
      header: { timestamp: [1000, 1016, 1017][index] }
    }, timetable);
  }

  builder.flushPendingStationaryFeeds();
  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.pendingStationaryFeeds, null);
  assert.equal(state.lastSample.timestamp, 1017);
  assert.equal(builder.summary().stationaryGpsSamplesDropped, 0);
});

test('flushes a delayed stationary feed when no confirming sample arrives', () => {
  const builder = createBuilder();
  const timetable = createTimetable();
  for (const timestamp of [1000, 1011]) {
    builder.processFeed(feed(vehicleEntity({
      timestamp,
      sequence: 2,
      stopId: 'B',
      stopDistance: 50,
      position: { latitude: 47.5, longitude: 19 }
    })), timetable);
  }

  builder.flushPendingStationaryFeeds();

  const state = builder.vehicleStates.get('vehicle');
  assert.equal(state.pendingStationaryFeeds, null);
  assert.equal(state.lastSample.timestamp, 1011);
  assert.equal(builder.summary().stationaryGpsSamplesDropped, 0);
});
