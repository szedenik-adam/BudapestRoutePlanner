#!/usr/bin/env node

import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamReader } from './stream-reader.mjs';
import {
  createTimetableShapeDistanceMeasurer,
  createTimetableShapeProjector
} from './shape-point-index.mjs';
import { SpeedGraphBuilder } from './speed-graph.mjs';
import { TimetableLoader } from './timetable-loader.mjs';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const require = createRequire(import.meta.url);
const turf = require('../scripts/external/turf.min.js');
const shapeProjectors = new WeakMap();
const shapeDistanceMeasurers = new WeakMap();
const stopIdsByIndex = new WeakMap();

function usage() {
  return (
    'Usage: node realtime-oversampler/analyze-speed-outlier.mjs ' +
    '<archive.tar.gz> <speed-mps|max> <feeds-before> <feeds-after>\n' +
    'Use a path or an archive name from recorded-content/. Numeric speeds ' +
    'match the speed shown to one decimal place.'
  );
}

function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.info(usage());
    process.exit(0);
  }
  if (args.length !== 4) throw new Error(usage());

  const [archiveArgument, speedArgument, beforeArgument, afterArgument] = args;
  const speed = speedArgument === 'max' ? 'max' : Number(speedArgument);
  const feedsBefore = Number(beforeArgument);
  const feedsAfter = Number(afterArgument);

  if (speed !== 'max' && (!Number.isFinite(speed) || speed <= 35)) {
    throw new Error('speed-mps must be greater than 35, or use "max"');
  }
  for (const [name, value] of [
    ['feeds-before', feedsBefore],
    ['feeds-after', feedsAfter]
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer`);
    }
  }

  return { archiveArgument, speed, feedsBefore, feedsAfter };
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function resolveArchive(archiveArgument) {
  const candidates = [
    path.resolve(archiveArgument),
    path.join(projectRoot, 'recorded-content', path.basename(archiveArgument))
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error(`Archive not found: ${archiveArgument}`);
}

function numeric(value) {
  if (value === null || value === undefined) return null;
  const number = typeof value?.toNumber === 'function'
    ? value.toNumber()
    : Number(value);
  return Number.isFinite(number) ? number : null;
}

function indexedValue(map, key) {
  return map instanceof Map ? map.get(key) : map?.[key];
}

function getStopIdByIndex(timetable, index) {
  let stopIds = stopIdsByIndex.get(timetable);
  if (!stopIds) {
    stopIds = new Map();
    const entries = timetable.stopMap instanceof Map
      ? timetable.stopMap.entries()
      : Object.entries(timetable.stopMap ?? {});
    for (const [id, stopIndex] of entries) {
      stopIds.set(Number(stopIndex), String(id));
    }
    stopIdsByIndex.set(timetable, stopIds);
  }
  return stopIds.get(Number(index)) ?? null;
}

function getShapeProjector(timetable) {
  let projectPosition = shapeProjectors.get(timetable);
  if (!projectPosition) {
    projectPosition = createTimetableShapeProjector(timetable);
    shapeProjectors.set(timetable, projectPosition);
  }
  return projectPosition;
}

function getShapeDistanceMeasurer(timetable) {
  let measureShapeDistance = shapeDistanceMeasurers.get(timetable);
  if (!measureShapeDistance) {
    measureShapeDistance = createTimetableShapeDistanceMeasurer(timetable);
    shapeDistanceMeasurers.set(timetable, measureShapeDistance);
  }
  return measureShapeDistance;
}

function getCalculatedNextStop(trip, shapeDistance) {
  if (!Array.isArray(trip?.stops) || shapeDistance === null) return null;
  return trip.stops
    .map((stop, index) => ({
      stop,
      index,
      shapeDistance: numeric(trip.stopShapeDist?.[index])
    }))
    .filter((entry) =>
      entry.shapeDistance !== null &&
      entry.shapeDistance >= shapeDistance
    )
    .sort((left, right) =>
      left.shapeDistance - right.shapeDistance ||
      left.index - right.index
    )[0] ?? null;
}

function timestampText(timestamp) {
  if (timestamp === null) return 'n/a';
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.valueOf()) ? String(timestamp) : date.toISOString();
}

function gpsDistanceMeters(first, second) {
  if (!first || !second) return null;
  return turf.distance(
    turf.point([first.longitude, first.latitude]),
    turf.point([second.longitude, second.latitude]),
    { units: 'meters' }
  );
}

function sameVehicle(entity, incident) {
  const vehicle = entity.vehicle;
  const descriptor = vehicle?.vehicle;
  if (!vehicle || !descriptor) return false;
  if (incident.vehicleId) return String(descriptor.id ?? '') === incident.vehicleId;
  if (incident.vehicleName) {
    return String(descriptor.label ?? '') === incident.vehicleName;
  }
  return incident.entityId && String(entity.id ?? '') === incident.entityId;
}

function getVehicleKey(entity) {
  const vehicle = entity.vehicle;
  const descriptor = vehicle?.vehicle;
  const key = descriptor?.id ?? descriptor?.label ?? entity.id;
  return key === undefined || key === null || key === ''
    ? null
    : String(key);
}

function formatFeedDisposition(disposition) {
  if (disposition.reason === 'timestamp-regression') {
    return `REJECTED: timestamp rollback ` +
      `(${formatNumber(disposition.secondsBehind, 1)}s)`;
  }
  if (disposition.reason === 'gps-drift') {
    return `REJECTED: GPS drift (${disposition.rejectionReason})`;
  }
  if (disposition.reason === 'stop-sequence-regression') {
    return 'REJECTED: stop-sequence regression';
  }
  if (disposition.reason === 'invalid-observation') {
    return 'REJECTED: invalid observation';
  }
  if (disposition.reason === 'stationary-gps-merged') {
    return 'DROPPED: stale GPS (bridged)';
  }
  if (disposition.reason === 'non-positive-elapsed-time') {
    return 'PAIR REJECTED: non-positive elapsed time';
  }
  if (disposition.reason === 'backward-progress') {
    return 'PAIR REJECTED: backward progress';
  }
  if (disposition.reason === 'stuck-door-sensor') {
    return 'PAIR REJECTED: stuck door sensor';
  }
  return `${disposition.kind.toUpperCase()}: ${disposition.reason}`;
}

function observationRows(record, incident, feedDispositions) {
  const rows = [];
  for (const entity of record.message.entity ?? []) {
    if (!sameVehicle(entity, incident)) continue;

    const vehicle = entity.vehicle;
    const descriptor = vehicle.vehicle;
    const realcity = descriptor['.realcity.vehicle'] ?? {};
    const dispositions = feedDispositions.get(record.index)
      ?.get(getVehicleKey(entity)) ?? [];
    const tripId = String(vehicle.trip?.trip_id ?? '');
    const tripIndex = indexedValue(record.timetable.tripMap, tripId);
    const trip = tripIndex === undefined
      ? null
      : record.timetable.trips[Number(tripIndex)];
    const sequence = numeric(vehicle.current_stop_sequence);
    const stopIndex = sequence === null ? -1 : sequence - 1;
    const stopId = String(vehicle.stop_id ?? '');
    const mappedStopIndex = indexedValue(record.timetable.stopMap, stopId);
    const stop = trip?.stops?.[stopIndex];
    const stopShapeDistance = numeric(trip?.stopShapeDist?.[stopIndex]);
    const stopDistance = numeric(realcity.stop_distance);
    const vehicleTimestamp = numeric(vehicle.timestamp) ??
      numeric(record.message.header?.timestamp);
    const latitude = numeric(vehicle.position?.latitude);
    const longitude = numeric(vehicle.position?.longitude);
    const position = latitude === null || longitude === null
      ? null
      : { latitude, longitude };
    const projectPosition = getShapeProjector(record.timetable);
    const wholeShapeProjection = position && trip
      ? projectPosition(trip, position)
      : null;
    const reportedProgress = stopShapeDistance === null || stopDistance === null
      ? null
      : stopShapeDistance - stopDistance;
    const reportedShapePointProjection =
      position && trip && reportedProgress !== null
        ? projectPosition(trip, position, {
          minShapeDistance: reportedProgress,
          maxShapeDistance: reportedProgress
        })
        : null;
    const calculatedNextStop = getCalculatedNextStop(
      trip,
      wholeShapeProjection?.shapeDistance ?? null
    );
    const calculatedStopDistance = calculatedNextStop && wholeShapeProjection
      ? getShapeDistanceMeasurer(record.timetable)(
        trip,
        wholeShapeProjection.shapeDistance,
        calculatedNextStop.shapeDistance
      )
      : null;

    rows.push({
      feedIndex: record.index,
      relativeFeed: record.relativeFeed,
      endpoint: record.endpoint,
      feedName: record.name,
      vehicleTimestamp: timestampText(vehicleTimestamp),
      vehicleTimestampSeconds: vehicleTimestamp,
      dispositions: dispositions.map(formatFeedDisposition),
      tripId,
      route: trip?.route?.name ?? 'n/a',
      sequence: sequence ?? 'n/a',
      stopId,
      stopName: stop && Number(stop._id) === Number(mappedStopIndex)
        ? (stop.name || 'unnamed')
        : 'unresolved',
      gps: latitude === null || longitude === null
        ? 'n/a'
        : `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
      position,
      gpsToWholeShapeMeters: wholeShapeProjection?.crossTrackMeters ?? null,
      gpsToReportedShapePointMeters:
        reportedShapePointProjection?.crossTrackMeters ?? null,
      calculatedStopDistanceMeters: calculatedStopDistance,
      calculatedNextStop: calculatedNextStop
        ? {
          sequence: calculatedNextStop.index + 1,
          id: getStopIdByIndex(
            record.timetable,
            calculatedNextStop.stop._id
          ) ?? String(calculatedNextStop.stop._id ?? ''),
          name: calculatedNextStop.stop.name || 'unnamed'
        }
        : null,
      doorOpen: realcity.door_open === true,
      stopDistance,
      stopShapeDistance,
      progress: reportedProgress
    });
  }
  return rows;
}

function formatNumber(value, digits = 1) {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function addGpsDeltas(rows) {
  let previous = null;
  for (const row of rows) {
    const deltaMeters = previous
      ? gpsDistanceMeters(previous.position, row.position)
      : null;
    const deltaSeconds = previous &&
        previous.vehicleTimestampSeconds !== null &&
        row.vehicleTimestampSeconds !== null
      ? row.vehicleTimestampSeconds - previous.vehicleTimestampSeconds
      : null;
    row.gpsDeltaMeters = deltaMeters;
    row.gpsDeltaSeconds = deltaSeconds;
    row.gpsSpeedMps = deltaMeters !== null &&
        deltaSeconds !== null &&
        deltaSeconds > 0
      ? deltaMeters / deltaSeconds
      : null;
    previous = row;
  }
  return rows;
}

function printOutlier(
  incident,
  records,
  archiveFeedCount,
  feedsBefore,
  feedsAfter,
  feedDispositions
) {
  const adjustedSpeed = incident.distanceMeters / incident.adjustedSeconds;
  const gpsDistance = gpsDistanceMeters(
    incident.previous.position,
    incident.current.position
  );
  const gpsSpeed = gpsDistance !== null && incident.elapsedSeconds > 0
    ? gpsDistance / incident.elapsedSeconds
    : null;
  console.info(`Archive: ${incident.current.source.archiveName}`);
  console.info(
    `Outlier current feed: ${incident.current.feedIndex} of ${archiveFeedCount}`
  );
  console.info(
    `Largest matching outlier: ${incident.speedMps.toFixed(6)} m/s ` +
    `(diagnostic threshold ${incident.limitMps} m/s)`
  );
  console.info(
    `Vehicle: ${incident.vehicleName || '<unnamed>'} ` +
    `(id ${incident.vehicleId || '<missing>'})` +
    `${incident.entityId ? `; entity ${incident.entityId}` : ''}`
  );
  console.info(`Trip: ${incident.tripId}; route: ${incident.routeId ?? 'n/a'}`);
  console.info(
    `Stops: ${incident.fromStop.id} (${incident.fromStop.name || 'unnamed'}) -> ` +
    `${incident.toStop.id} (${incident.toStop.name || 'unnamed'})`
  );
  console.info(
    `Previous: ${incident.previous.source.feedName} at ` +
    `${timestampText(incident.previous.timestamp)}; current: ` +
    `${incident.current.source.feedName} at ` +
    `${timestampText(incident.current.timestamp)}`
  );
  console.info(
    `Elapsed: ${incident.elapsedSeconds.toFixed(3)} s; adjusted: ` +
    `${incident.adjustedSeconds.toFixed(3)} s; traveled: ` +
    `${incident.distanceMeters.toFixed(3)} m; calculated speed: ` +
    `${adjustedSpeed.toFixed(6)} m/s`
  );
  console.info(
    `GPS endpoint delta: ${formatNumber(gpsDistance, 2)} m over ` +
    `${incident.elapsedSeconds.toFixed(3)} s = ${formatNumber(gpsSpeed, 2)} m/s`
  );
  console.info(
    `Progress: ${incident.previous.progress.toFixed(1)} -> ` +
    `${incident.current.progress.toFixed(1)} m; effective ` +
    `stop_distance: ${incident.previous.reportedStopDistance.toFixed(1)} -> ` +
    `${incident.current.reportedStopDistance.toFixed(1)} m; ` +
    `door_open: ${incident.previous.doorOpen} -> ${incident.current.doorOpen}`
  );
  console.info(
    `Shape distance: ${incident.previous.shapeDistance.toFixed(1)} -> ` +
    `${incident.current.shapeDistance.toFixed(1)} m ` +
    `(delta ${incident.shapeDistanceMeters.toFixed(1)} m)`
  );
  console.info(
    `Timeline: ${feedsBefore} preceding and ${feedsAfter} following archive feed(s); ` +
    `rows below include observations for this vehicle only.`
  );
  console.info(
    'GPS-to-shape is the nearest distance to the full trip shape; GPS-to-reported-point ' +
    'uses the reported next stop chainage minus stop_distance. Calculated stop distance ' +
    'and next stop come from the nearest full-shape GPS projection.'
  );
  console.info(
    'Rejected or dropped feeds, and rejected feed pairs, are labeled in the table; ' +
    'their raw values remain visible.'
  );

  const center = incident.current.feedIndex;
  const windowRecords = records.filter((record) =>
    record.index >= center - feedsBefore &&
    record.index <= center + feedsAfter
  );
  const rows = addGpsDeltas(
    windowRecords.flatMap((record) =>
      observationRows(record, incident, feedDispositions)
    )
  );
  if (rows.length === 0) {
    console.info('No matching vehicle observations found in the selected feed window.');
    return;
  }

  const headers = [
    'Feed',
    'Offset',
    'Endpoint',
    'Entry',
    'Graph disposition',
    'Vehicle time',
    'Trip',
    'Route',
    'Stop seq',
    'Stop',
    'GPS (lat, lon)',
    'GPS Δ (m)',
    'Vehicle Δt (s)',
    'GPS speed (m/s)',
    'GPS to shape (m)',
    'GPS to reported point (m)',
    'Calculated stop distance (m)',
    'Calculated next stop',
    'Door',
    'Reported stop_distance (m)',
    'Shape distance (m)',
    'Progress (m)'
  ];
  const table = rows.map((row) => [
    row.feedIndex,
    row.relativeFeed === 0
      ? 'OUTLIER'
      : `${row.relativeFeed > 0 ? '+' : ''}${row.relativeFeed}`,
    row.endpoint,
    row.feedName,
    row.dispositions.join('; '),
    row.vehicleTimestamp,
    row.tripId,
    row.route,
    row.sequence,
    `${row.stopId} (${row.stopName})`,
    row.gps,
    formatNumber(row.gpsDeltaMeters, 2),
    formatNumber(row.gpsDeltaSeconds, 1),
    formatNumber(row.gpsSpeedMps, 2),
    formatNumber(row.gpsToWholeShapeMeters),
    formatNumber(row.gpsToReportedShapePointMeters),
    formatNumber(row.calculatedStopDistanceMeters),
    row.calculatedNextStop
      ? `${row.calculatedNextStop.sequence}: ${row.calculatedNextStop.id} ` +
        `(${row.calculatedNextStop.name})`
      : 'n/a',
    row.doorOpen,
    formatNumber(row.stopDistance),
    formatNumber(row.stopShapeDistance),
    formatNumber(row.progress)
  ]);
  console.table(table.map((values) => Object.fromEntries(
    headers.map((header, index) => [header, values[index]])
  )));
}

async function main(args = process.argv.slice(2)) {
  const { archiveArgument, speed, feedsBefore, feedsAfter } = parseArguments(args);
  const archivePath = await resolveArchive(archiveArgument);
  if (!archivePath.endsWith('.tar.gz')) {
    throw new Error(`Expected a completed .tar.gz archive: ${archivePath}`);
  }

  const records = [];
  const feedDispositions = new Map();
  const historyLimit = Math.max(feedsBefore + 16, 16);
  let feedCount = 0;
  let processingRecord = null;
  let selected = null;
  const archiveName = path.basename(archivePath);
  const timetableLoader = new TimetableLoader(path.dirname(archivePath), {
    onShapePointIndexIssue: () => {},
    onShapeDistanceValidationError: () => {}
  });
  const matchesSpeed = (incident) =>
    speed === 'max' || incident.speedMps.toFixed(1) === speed.toFixed(1);

  const speedGraph = new SpeedGraphBuilder({
    onFeedDisposition(disposition) {
      const source = disposition.sample?.source ?? disposition.source;
      const feedIndex = source?.feedIndex;
      const vehicleKey = disposition.sample?.vehicleKey ??
        (disposition.entity ? getVehicleKey(disposition.entity) : null);
      if (feedIndex === undefined) {
        throw new Error('Feed disposition is missing its archive feed');
      }
      if (vehicleKey === null) return;
      let byVehicle = feedDispositions.get(feedIndex);
      if (!byVehicle) {
        byVehicle = new Map();
        feedDispositions.set(feedIndex, byVehicle);
      }
      const dispositions = byVehicle.get(vehicleKey) ?? [];
      dispositions.push(disposition);
      byVehicle.set(vehicleKey, dispositions);
    },
    onSpeedOutlier(incident) {
      if (!matchesSpeed(incident)) return;
      if (speed === 'max' &&
          selected &&
          incident.speedMps <= selected.incident.speedMps) {
        return;
      }
      if (speed !== 'max' &&
          selected &&
          incident.speedMps <= selected.incident.speedMps) {
        return;
      }

      const endpointName = incident.current.source?.feedName;
      const endpointRecord = processingRecord?.name === endpointName
        ? processingRecord
        : records.find((record) => record.name === endpointName);
      if (!endpointRecord) {
        throw new Error(`Could not locate outlier feed entry ${endpointName}`);
      }
      incident.current.feedIndex = endpointRecord.index;
      selected = {
        incident,
        currentRecord: endpointRecord,
        after: [],
        before: records.filter(
          (record) => record.index < endpointRecord.index
        ).slice(feedsBefore > 0 ? -feedsBefore : records.length)
      };
      selected.after = records.filter(
        (record) => record.index > endpointRecord.index
      ).slice(0, feedsAfter);
    }
  });

  for await (const { name, message } of new StreamReader(archivePath).readMessages()) {
    const timetable = await timetableLoader.loadForFeed(message);
    const record = {
      index: ++feedCount,
      name,
      message,
      timetable,
      relativeFeed: null,
      endpoint: ''
    };
    processingRecord = record;
    speedGraph.processFeed(message, timetable, {
      archiveName,
      feedName: name,
      feedIndex: record.index
    });
    processingRecord = null;

    records.push(record);
    if (records.length > historyLimit) records.shift();
    if (selected && record.index > selected.incident.current.feedIndex &&
        selected.after.length < feedsAfter) {
      selected.after.push(record);
    }
  }
  speedGraph.flushPendingStationaryFeeds();

  if (!selected) {
    if (speed === 'max') {
      throw new Error(`No speed outliers above 35 m/s found in ${archiveName}`);
    }
    throw new Error(
      `No outlier displayed as ${speed.toFixed(1)} m/s found in ${archiveName}`
    );
  }

  const contextRecords = [
    ...selected.before,
    selected.currentRecord,
    ...records,
    ...selected.after
  ].reduce((unique, record) => {
    if (!unique.some((item) => item.index === record.index)) unique.push(record);
    return unique;
  }, []);
  const center = selected.incident.current.feedIndex;
  const timeline = contextRecords
    .filter((record) =>
      record.index >= center - feedsBefore &&
      record.index <= center + feedsAfter
    )
    .sort((left, right) => left.index - right.index)
    .map((record) => ({
      ...record,
      relativeFeed: record.index - center,
      endpoint: record.name === selected.incident.previous.source.feedName
        ? 'previous'
        : record.name === selected.incident.current.source.feedName
          ? 'current'
          : ''
    }));
  printOutlier(
    selected.incident,
    timeline,
    feedCount,
    feedsBefore,
    feedsAfter,
    feedDispositions
  );
}

main().catch((error) => {
  console.error(`Speed-outlier analysis failed: ${error.message}`);
  process.exitCode = 1;
});
