import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTimetableShapeProjector,
  createTimetableShapeDistanceValidator,
  createTimetableShapePointIndexer
} from '../realtime-oversampler/shape-point-index.mjs';

function makeTrip(stopShapeDist) {
  return {
    originalInd: 'trip-1',
    shape_id: 'shape-1',
    stopShapeDist
  };
}

test('indexes stops by raw shape distances without mutating GTFS values', () => {
  const shape = [
    [0, 0, 0],
    [100, 0.001, 0],
    [200, 0.002, 0]
  ];
  const trip = makeTrip([0, 20, 100, 101, 200, 250]);
  const unreferencedTrip = makeTrip([0, 98765]);
  const originalShape = structuredClone(shape);
  const originalStopDistances = [...trip.stopShapeDist];
  const messages = [];
  const timetable = {
    shapes: { 'shape-1': shape },
    trips: [trip, unreferencedTrip]
  };
  const indexTrip = createTimetableShapePointIndexer(
    timetable,
    (message) => messages.push(message)
  );
  const indexed = indexTrip(0);

  assert.equal(indexed, true);
  assert.deepEqual(shape, originalShape);
  assert.deepEqual(trip.stopShapeDist, originalStopDistances);
  assert.deepEqual(trip.stopShapePointIndex, [0, 1, 1, 2, 2, null]);
  assert.equal(unreferencedTrip.stopShapePointIndex, undefined);
  assert.equal(indexTrip(0), true);
  assert.deepEqual(messages, []);
});

test('reports non-monotonic source shape distances without changing them', () => {
  const shape = [[0, 0, 0], [200, 0.001, 0], [100, 0.002, 0]];
  const trip = makeTrip([0, 100, 200]);
  const originalShape = structuredClone(shape);
  const messages = [];

  const timetable = { shapes: { 'shape-1': shape }, trips: [trip] };
  const indexTrip = createTimetableShapePointIndexer(
    timetable,
    (message) => messages.push(message)
  );
  const indexed = indexTrip(0);

  assert.deepEqual(shape, originalShape);
  assert.deepEqual(trip.stopShapeDist, [0, 100, 200]);
  assert.deepEqual(trip.stopShapePointIndex, [null, null, null]);
  assert.equal(indexed, true);
  assert.equal(indexTrip(0), true);
  assert.equal(messages.length, 1);
});

test('accepts a consistent large chainage offset', () => {
  const shape = [
    [24728, 0, 0],
    [24828, 0.001, 0],
    [24928, 0.002, 0]
  ];
  const trip = makeTrip([24728, 24828, 24928]);
  trip.stops = [{ _id: 'A' }, { _id: 'B' }, { _id: 'C' }];
  const errors = [];
  const timetable = {
    shapes: { 'shape-1': shape },
    trips: [trip]
  };
  const validateTrip = createTimetableShapeDistanceValidator(
    timetable,
    (message) => errors.push(message)
  );

  assert.deepEqual(validateTrip(0), [true, true]);
  assert.deepEqual(errors, []);
});

test('allows small endpoint differences within the geometry tolerance', () => {
  const shape = [
    [7, 0, 0],
    [107, 0.001, 0],
    [207, 0.002, 0]
  ];
  const trip = makeTrip([0, 100, 200]);
  trip.stops = [{ _id: 'A' }, { _id: 'B' }, { _id: 'C' }];
  const errors = [];
  const timetable = {
    shapes: { 'shape-1': shape },
    trips: [trip]
  };
  const validateTrip = createTimetableShapeDistanceValidator(
    timetable,
    (message) => errors.push(message)
  );

  assert.deepEqual(validateTrip(0), [true, true]);
  assert.deepEqual(errors, []);
});

test('projects GPS positions onto the trip shape within requested chainage bounds', () => {
  const shape = [
    [0, 0, 0],
    [100, 0.001, 0],
    [200, 0.002, 0]
  ];
  const timetable = { shapes: { 'shape-1': shape } };
  const projectPosition = createTimetableShapeProjector(timetable);
  const position = { longitude: 0.0005, latitude: 0.0001 };
  const projection = projectPosition(makeTrip([0, 100, 200]), position, {
    minShapeDistance: 0,
    maxShapeDistance: 100
  });

  assert.ok(projection);
  assert.ok(Math.abs(projection.shapeDistance - 50) < 0.01);
  assert.ok(Math.abs(projection.crossTrackMeters - 11.1) < 0.2);
  assert.ok(Math.abs(projection.metersPerUnit - 1.113) < 0.01);
});

test('reports detailed errors and rejects legs with out-of-range shape distances', () => {
  const shape = [
    [0, 0, 0],
    [100, 0.001, 0],
    [200, 0.002, 0]
  ];
  const trip = makeTrip([0, 1000, 200]);
  trip.stops = [{ _id: 'A' }, { _id: 'B' }, { _id: 'C' }];
  const originalShapeDistances = [...trip.stopShapeDist];
  const errors = [];
  const timetable = {
    shapes: { 'shape-1': shape },
    trips: [trip]
  };
  const validateTrip = createTimetableShapeDistanceValidator(
    timetable,
    (message) => errors.push(message)
  );

  assert.deepEqual(validateTrip(0), [false, false]);
  assert.equal(validateTrip(0).length, 2);
  assert.deepEqual(trip.stopShapeDist, originalShapeDistances);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /trip trip-1 \(route <missing>\), shape shape-1/);
  assert.match(errors[0], /stop A \(sequence 1\) -> B \(sequence 2\)/);
  assert.match(errors[0], /0 -> 1000/);
  assert.match(errors[0], /outside common shape range \[0, 200\]/);
});
