#!/usr/bin/env node

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeGraphExport } from './graph-export.mjs';
import { StreamReader } from './stream-reader.mjs';
import { SpeedGraphBuilder } from './speed-graph.mjs';
import { StatusDisplay } from './status-display.mjs';
import { TimetableLoader } from './timetable-loader.mjs';

const defaultArchiveDirectory = path.join(
  homedir(),
  '.local/share/budapest-route-planner/realtime'
);

function parseArguments(args) {
  const options = {
    archiveDirectory: defaultArchiveDirectory,
    maxArchives: null,
    maxMessages: null,
    skipMessages: 0,
    outputFile: null,
    displayMessages: 'none'
  };
  let directoryProvided = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--max-archives' ||
        argument === '--max-messages' ||
        argument === '--skip-messages') {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${argument} requires a non-negative integer`);
      }
      if (argument === '--max-archives') options.maxArchives = value;
      else if (argument === '--max-messages') options.maxMessages = value;
      else options.skipMessages = value;
    } else if (argument === '--output') {
      const value = args[++index];
      if (!value || value.startsWith('--')) {
        throw new Error('--output requires a file path');
      }
      options.outputFile = path.resolve(value);
    } else if (argument === '--display-messages') {
      const value = args[++index];
      if (!['none', 'first-and-last', 'all'].includes(value)) {
        throw new Error(`${argument} must be one of: none, first-and-last, all`);
      }
      options.displayMessages = value;
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (!directoryProvided) {
      options.archiveDirectory = argument;
      directoryProvided = true;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }

  options.archiveDirectory = path.resolve(options.archiveDirectory);
  return options;
}

function displayMessage(label, { archiveName, name, message }) {
  console.log(`\n${label}: ${archiveName} / ${name}`);
  console.dir(message, { depth: null, colors: Boolean(process.stdout.isTTY) });
}

function formatFeedSource(source) {
  return source
    ? `${source.archiveName} / ${source.feedName}`
    : '<unknown archive/feed>';
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.valueOf())
    ? `${timestamp} epoch seconds`
    : `${date.toISOString()} (${timestamp})`;
}

function formatBackwardTimestampRejection({ sample, previous, secondsBehind }) {
  const vehicleTime = sample.vehicleTimestamp ?? sample.timestamp;
  const previousVehicleTime =
    previous.vehicleTimestamp ?? previous.timestamp;
  return (
    `Backward-timestamp feed rejected: vehicle id=${sample.vehicleId || '<missing>'}, ` +
    `name=${sample.vehicleName || '<missing>'}` +
    `${sample.entityId ? `, entity=${sample.entityId}` : ''}, ` +
    `trip=${sample.tripId}, route=${sample.routeName || '<unknown>'}\n` +
    `  Rejected feed: ${formatFeedSource(sample.source)}; ` +
    `vehicle time ${formatTimestamp(vehicleTime)}; ` +
    `sequence ${sample.stopIndex + 1}, stop ${sample.stopId}; ` +
    `GPS ${formatGpsPosition(sample.position)}; ` +
    `stop_distance ${formatStopDistance(sample)}; ` +
    `progress ${sample.progress.toFixed(1)} m\n` +
    `  Comparison feed: ${formatFeedSource(previous.source)}; ` +
    `vehicle time ${formatTimestamp(previousVehicleTime)}; ` +
    `sequence ${previous.stopIndex + 1}, stop ${previous.stopId}; ` +
    `GPS ${formatGpsPosition(previous.position)}; ` +
    `stop_distance ${formatStopDistance(previous)}; ` +
    `progress ${previous.progress.toFixed(1)} m\n` +
    `  Rejected timestamp is ${secondsBehind.toFixed(1)} s earlier; ` +
    `feed was excluded before corrections and GPS-drift scoring and did not ` +
    `replace the retained feed baseline.`
  );
}

function formatGpsBasedNextStopCorrectionRejection({ sample, previous }) {
  const vehicleTime = sample.vehicleTimestamp ?? sample.timestamp;
  const previousVehicleTime =
    previous.vehicleTimestamp ?? previous.timestamp;
  return (
    `GPS-based next-stop correction rejected feed: ` +
    `vehicle id=${sample.vehicleId || '<missing>'}, ` +
    `name=${sample.vehicleName || '<missing>'}, trip=${sample.tripId}\n` +
    `  Rejected feed: ${formatFeedSource(sample.source)}; ` +
    `vehicle time ${formatTimestamp(vehicleTime)}; ` +
    `sequence ${sample.stopIndex + 1}, stop ${sample.stopId}; ` +
    `GPS ${formatGpsPosition(sample.position)}; ` +
    `stop_distance ${formatStopDistance(sample)}; ` +
    `progress ${sample.progress.toFixed(1)} m\n` +
    `  Retained feed: ${formatFeedSource(previous.source)}; ` +
    `vehicle time ${formatTimestamp(previousVehicleTime)}; ` +
    `sequence ${previous.stopIndex + 1}, stop ${previous.stopId}; ` +
    `GPS ${formatGpsPosition(previous.position)}; ` +
    `stop_distance ${formatStopDistance(previous)}; ` +
    `progress ${previous.progress.toFixed(1)} m\n` +
    `  Active correction could not be carried to this zero-distance feed; ` +
    `the feed was excluded and the retained baseline was preserved.`
  );
}

function formatStopDistance(sample) {
  return `${sample.reportedStopDistance.toFixed(1)} m reported`;
}

function formatGpsPosition(position) {
  return position
    ? `${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)}`
    : '<missing>';
}

function formatGpsSignalLostIncident(incident) {
  const vehicleId = incident.vehicleId || '<missing>';
  const vehicleName = incident.vehicleName || '<missing>';
  const correctedSpeed = incident.correctedSpeedMps === null
    ? 'unavailable'
    : `${incident.correctedSpeedMps.toFixed(1)} m/s`;
  const stationarySamples = incident.stationarySamples.map((sample, index) => {
    const disposition = sample.doorOpen
      ? 'retained (door_open=true)'
      : 'merged';
    return (
      `  Stationary sample ${index + 1} ${disposition}: ` +
      `${formatFeedSource(sample.source)}; ` +
      `vehicle time ${formatTimestamp(sample.vehicleTimestamp)}; ` +
      `GPS ${formatGpsPosition(sample.position)}; ` +
      `progress ${sample.progress.toFixed(1)} m; ` +
      `stop_distance ${formatStopDistance(sample)}`
    );
  }).join('\n');
  return (
    `GPS signal lost detected (inferred from stale-position recovery): ` +
    `vehicle id=${vehicleId}, name=${vehicleName}` +
    `${incident.entityId ? `, entity=${incident.entityId}` : ''}, ` +
    `trip=${incident.tripId}, route=${incident.routeName || '<unknown>'}\n` +
    `  Previous sample: ${formatFeedSource(incident.previous.source)}; ` +
    `vehicle time ${formatTimestamp(incident.previous.vehicleTimestamp)}; ` +
    `GPS ${formatGpsPosition(incident.previous.position)}; ` +
    `progress ${incident.previous.progress.toFixed(1)} m; ` +
    `stop_distance ${formatStopDistance(incident.previous)}\n` +
    `  Initial stationary candidate: ${formatFeedSource(incident.stationary.source)}; ` +
    `vehicle time ${formatTimestamp(incident.stationary.vehicleTimestamp)} ` +
    `(+${incident.stationaryIntervalSeconds.toFixed(1)} s); ` +
    `GPS ${formatGpsPosition(incident.stationary.position)}, moved ` +
    `${incident.stationaryDistanceMeters.toFixed(1)} m; ` +
    `progress ${incident.stationary.progress.toFixed(1)} m; ` +
    `stop_distance ${formatStopDistance(incident.stationary)}\n` +
    `${stationarySamples}\n` +
    `  Recovery sample: ${formatFeedSource(incident.recovery.source)}; ` +
    `vehicle time ${formatTimestamp(incident.recovery.vehicleTimestamp)} ` +
    `(+${incident.recoveryIntervalSeconds.toFixed(1)} s); ` +
    `GPS ${formatGpsPosition(incident.recovery.position)}, moved ` +
    `${incident.recoveryDistanceMeters.toFixed(1)} m from the initial stale position, ` +
    `${incident.lastFeedMovementMeters.toFixed(1)} m from the last stationary feed; ` +
    `progress ${incident.recovery.progress.toFixed(1)} m; ` +
    `stop_distance ${formatStopDistance(incident.recovery)}\n` +
    `  Merged ${incident.mergedSamples.length} stationary sample(s); ` +
    `retained ${incident.preservedDoorOpenSamples.length} door-open sample(s).\n` +
    `  Bridged pair from ${formatFeedSource(incident.bridgedPrevious.source)}: ` +
    `${incident.bridgedElapsedSeconds.toFixed(1)} s, ` +
    `${incident.bridgedProgressMeters.toFixed(1)} m progress; ` +
    `corrected speed (door-adjusted): ${correctedSpeed}`
  );
}

function formatDelayedStopDistanceIncident(incident) {
  const vehicleId = incident.vehicleId || '<missing>';
  const vehicleName = incident.vehicleName || '<missing>';
  const correctedSpeed = incident.correctedSpeedMps === null
    ? 'unavailable'
    : `${incident.correctedSpeedMps.toFixed(1)} m/s`;
  const bufferedSamples = incident.pendingSamples.map((sample, index) => {
    const disposition = sample.doorOpen
      ? 'retained (door_open=true)'
      : 'merged';
    return (
      `  Buffered sample ${index + 1} ${disposition}: ` +
      `${formatFeedSource(sample.source)}; ` +
      `vehicle time ${formatTimestamp(sample.vehicleTimestamp)}; ` +
      `GPS ${formatGpsPosition(sample.position)}; ` +
      `stop_distance ${formatStopDistance(sample)}; ` +
      `progress ${sample.progress.toFixed(1)} m`
    );
  }).join('\n');
  return (
    `Delayed stop_distance update detected: vehicle id=${vehicleId}, ` +
    `name=${vehicleName}` +
    `${incident.entityId ? `, entity=${incident.entityId}` : ''}, ` +
    `trip=${incident.tripId}, route=${incident.routeName || '<unknown>'}\n` +
    `  Previous accepted sample: ${formatFeedSource(incident.previous.source)}; ` +
    `vehicle time ${formatTimestamp(incident.previous.vehicleTimestamp)}; ` +
    `GPS ${formatGpsPosition(incident.previous.position)}; ` +
    `stop_distance ${formatStopDistance(incident.previous)}\n` +
    `${bufferedSamples}\n` +
    `  Updated sample: ${formatFeedSource(incident.updated.source)}; ` +
    `vehicle time ${formatTimestamp(incident.updated.vehicleTimestamp)}; ` +
    `GPS ${formatGpsPosition(incident.updated.position)}; ` +
    `stop_distance ${incident.stopDistanceBefore.toFixed(1)} -> ` +
    `${incident.updated.reportedStopDistance.toFixed(1)} m; ` +
    `GPS moved ${incident.gpsMovementMeters === null
      ? 'unavailable'
      : `${incident.gpsMovementMeters.toFixed(1)} m`}\n` +
    `  Merged ${incident.mergedSamples.length} buffered sample(s); ` +
    `retained ${incident.preservedDoorOpenSamples.length} door-open sample(s).\n` +
    `  Bridged pair from ${formatFeedSource(incident.bridgedPrevious.source)}: ` +
    `${incident.bridgedElapsedSeconds.toFixed(1)} s, ` +
    `${incident.bridgedProgressMeters.toFixed(1)} m progress; ` +
    `corrected speed (door-adjusted): ${correctedSpeed}`
  );
}

function formatDoorOpenStopDistanceCorrection(incident) {
  const vehicleId = incident.vehicleId || '<missing>';
  const vehicleName = incident.vehicleName || '<missing>';
  const previousReportedStopDistance =
    incident.correctedTarget === 'previous'
      ? incident.reportedStopDistance
      : incident.previous.reportedStopDistance;
  const currentReportedStopDistance =
    incident.correctedTarget === 'current'
      ? incident.reportedStopDistance
      : incident.current.reportedStopDistance;
  const correctedFeed = incident.correctedTarget === 'previous'
    ? 'previous door-closed sample'
    : 'door-open sample';
  const correctionBasis = incident.correctionBasis ??
    (incident.correctedTarget === 'previous'
      ? 'previous feed GPS-to-stop distance'
      : 'previous door-closed stop_distance minus GPS movement');
  const vehicleTimeDeltaSeconds =
    Number.isFinite(incident.previous.vehicleTimestamp) &&
    Number.isFinite(incident.current.vehicleTimestamp)
      ? incident.current.vehicleTimestamp - incident.previous.vehicleTimestamp
      : null;
  return (
    `Early door_open zero stop_distance corrected: vehicle id=${vehicleId}, ` +
    `name=${vehicleName}` +
    `${incident.entityId ? `, entity=${incident.entityId}` : ''}, ` +
    `trip=${incident.tripId}, route=${incident.routeName || '<unknown>'}\n` +
    `  Previous door-closed sample: ${formatFeedSource(incident.previous.source)}; ` +
    `vehicle time ${formatTimestamp(incident.previous.vehicleTimestamp)}; ` +
    `GPS ${formatGpsPosition(incident.previous.position)} is ` +
    `${incident.previousDistanceToStopMeters.toFixed(1)} m from the scheduled stop; ` +
    `stop_distance ${previousReportedStopDistance.toFixed(1)} m\n` +
    `  Door-open sample: ${formatFeedSource(incident.current.source)}; ` +
    `vehicle time ${formatTimestamp(incident.current.vehicleTimestamp)}; ` +
    `${vehicleTimeDeltaSeconds === null
      ? ''
      : `delta vehicle time ${vehicleTimeDeltaSeconds} s; `}` +
    `GPS ${formatGpsPosition(incident.current.position)} is ` +
    `${incident.distanceToStopMeters.toFixed(1)} m from the scheduled stop; ` +
    `stop_distance ${currentReportedStopDistance.toFixed(1)} m; GPS moved ` +
    `${incident.gpsMovementMeters.toFixed(1)} m\n` +
    `  Corrected ${correctedFeed} stop_distance ` +
    `${incident.reportedStopDistance.toFixed(1)} -> ` +
    `${incident.correctedStopDistance.toFixed(1)} m using ${correctionBasis}` +
    `${incident.correctedHistoryFeedCount
      ? `; back-corrected ${incident.correctedHistoryFeedCount} pending ` +
        `feeds across ${incident.distinctHistoryObservationCount} distinct ` +
        `GPS observations`
      : ''}` +
    `${incident.candidateSpeedMps === null
      ? ''
      : `\n  Candidate adjusted progress speed ` +
        `${incident.candidateSpeedMps.toFixed(1)} m/s exceeded the ` +
        `${incident.speedThresholdMps.toFixed(1)} m/s correction threshold`}`
  );
}

function formatClosedDoorStopDistanceCorrection(incident) {
  const vehicleId = incident.vehicleId || '<missing>';
  const vehicleName = incident.vehicleName || '<missing>';
  if (incident.correctionBasis === 'shape-projection') {
    return (
      `Closed-door zero stop_distance recalculated from shape: ` +
      `vehicle id=${vehicleId}, name=${vehicleName}` +
      `${incident.entityId ? `, entity=${incident.entityId}` : ''}, ` +
      `trip=${incident.tripId}, route=${incident.routeName || '<unknown>'}\n` +
      `  Previous feed: ${formatFeedSource(incident.previous.source)}; ` +
      `vehicle time ${formatTimestamp(incident.previous.vehicleTimestamp)}; ` +
      `stop_distance ${incident.reportedPreviousStopDistance.toFixed(1)} m ` +
      `matches shape estimate ` +
      `${incident.previousShapeStopDistance.toFixed(1)} m and is unchanged\n` +
      `  Current feed: ${formatFeedSource(incident.current.source)}; ` +
      `vehicle time ${formatTimestamp(incident.current.vehicleTimestamp)}; ` +
      `stop_distance ${incident.reportedStopDistance.toFixed(1)} -> ` +
      `${incident.correctedStopDistance.toFixed(1)} m; shape estimate ` +
      `${incident.currentShapeStopDistance.toFixed(1)} m\n` +
      `  GPS moved ${incident.gpsMovementMeters.toFixed(1)} m and shape ` +
      `distance decreased ${incident.shapeMovementMeters.toFixed(1)} m ` +
      `in ${incident.vehicleTimeDeltaSeconds} s; candidate speed ` +
      `${incident.candidateSpeedMps.toFixed(1)} m/s corrected to ` +
      `${incident.correctedSpeedMps.toFixed(1)} m/s`
    );
  }
  return (
    `Closed-door zero stop_distance snap corrected: ` +
    `vehicle id=${vehicleId}, name=${vehicleName}` +
    `${incident.entityId ? `, entity=${incident.entityId}` : ''}, ` +
    `trip=${incident.tripId}, route=${incident.routeName || '<unknown>'}\n` +
    `  Previous feed: ${formatFeedSource(incident.previous.source)}; ` +
    `vehicle time ${formatTimestamp(incident.previous.vehicleTimestamp)}; ` +
    `GPS ${formatGpsPosition(incident.previous.position)} is ` +
    `${incident.previousDistanceToStopMeters.toFixed(1)} m from the stop; ` +
    `stop_distance ${incident.reportedPreviousStopDistance.toFixed(1)} -> ` +
    `${incident.correctedPreviousStopDistance.toFixed(1)} m\n` +
    `  Current feed: ${formatFeedSource(incident.current.source)}; ` +
    `vehicle time ${formatTimestamp(incident.current.vehicleTimestamp)}; ` +
    `GPS ${formatGpsPosition(incident.current.position)} is ` +
    `${incident.distanceToStopMeters.toFixed(1)} m from the stop; ` +
    `stop_distance ${incident.reportedStopDistance.toFixed(1)} -> ` +
    `${incident.correctedStopDistance.toFixed(1)} m\n` +
    `  GPS moved ${incident.gpsMovementMeters.toFixed(1)} m and closed ` +
    `the stop distance by ${incident.gpsDistanceClosureMeters.toFixed(1)} m ` +
    `in ${incident.vehicleTimeDeltaSeconds} s; candidate speed ` +
    `${incident.candidateSpeedMps.toFixed(1)} m/s corrected to ` +
    `${incident.correctedSpeedMps.toFixed(1)} m/s`
  );
}

function formatNextStopDistanceCorrection(incident) {
  const vehicleId = incident.vehicleId || '<missing>';
  const vehicleName = incident.vehicleName || '<missing>';
  const trigger = incident.trigger === 'next-stop-change'
    ? 'next stop changed'
    : incident.trigger === 'continued-after-next-stop-change'
      ? 'persistent correction after next-stop change'
      : incident.trigger === 'resumed-after-next-stop-change'
        ? 'resumed correction after next-stop change'
        : 'follow-up within five seconds of next-stop change';
  return (
    `Next-stop stop_distance recalculated: vehicle id=${vehicleId}, ` +
    `name=${vehicleName}` +
    `${incident.entityId ? `, entity=${incident.entityId}` : ''}, ` +
    `trip=${incident.tripId}; ${trigger}\n` +
    `  Previous feed: ${formatFeedSource(incident.previous.source)}; ` +
    `vehicle time ${formatTimestamp(incident.previous.vehicleTimestamp)}; ` +
    `stop ${incident.previous.stopId}; ` +
    `stop_distance ${incident.previous.reportedStopDistance.toFixed(1)} m; ` +
    `shape distance ${incident.previous.stopShapeDistance.toFixed(1)} m\n` +
    `  Current feed: ${formatFeedSource(incident.current.source)}; ` +
    `vehicle time ${formatTimestamp(incident.current.vehicleTimestamp)}; ` +
    `stop ${incident.current.stopId}; ` +
    `stop_distance ${incident.reportedStopDistance.toFixed(1)} -> ` +
    `${incident.correctedStopDistance.toFixed(1)} m\n` +
    `  Vehicle time delta: ` +
    `${incident.vehicleTimeDeltaSeconds === null
      ? 'unavailable'
      : `${incident.vehicleTimeDeltaSeconds} s`}; ` +
    `GPS movement ${incident.gpsMovementMeters.toFixed(1)} m; ` +
    `shape-distance delta ${incident.shapeDistanceDelta.toFixed(1)} m`
  );
}

function formatGpsBasedNextStopZeroCorrection(incident) {
  const trigger = incident.trigger === 'next-stop-change'
    ? 'new next stop'
    : 'continued zero report';
  const legValidation = incident.correctionOriginShapeLegsValid
    ? 'valid'
    : 'invalid; geometry-only projection used instead';
  return (
    `GPS-based next-stop zero stop_distance corrected: ` +
    `vehicle id=${incident.vehicleId || '<missing>'}, ` +
    `name=${incident.vehicleName || '<missing>'}` +
    `${incident.entityId ? `, entity=${incident.entityId}` : ''}, ` +
    `trip=${incident.tripId}; trigger=${trigger}\n` +
    `  Previous feed: ${formatFeedSource(incident.previous.source)}; ` +
    `vehicle time ${formatTimestamp(incident.previous.vehicleTimestamp)}; ` +
    `sequence ${incident.previous.stopIndex + 1}, stop ${incident.previous.stopId}; ` +
    `GPS ${formatGpsPosition(incident.previous.position)}; ` +
    `stop_distance ${formatStopDistance(incident.previous)}\n` +
    `  Current feed: ${formatFeedSource(incident.current.source)}; ` +
    `vehicle time ${formatTimestamp(incident.current.vehicleTimestamp)}; ` +
    `sequence ${incident.current.stopIndex + 1}, stop ${incident.current.stopId}; ` +
    `GPS ${formatGpsPosition(incident.current.position)}; ` +
    `stop_distance ${incident.reportedStopDistance.toFixed(1)} -> ` +
    `${incident.correctedStopDistance.toFixed(1)} m effective graph distance\n` +
    `  Geometry projections: previous GPS chainage ` +
    `${incident.previousProjection.shapeDistance.toFixed(1)} m, current GPS chainage ` +
    `${incident.projection.shapeDistance.toFixed(1)} m, ` +
    `movement ${incident.geometryMovementMeters.toFixed(1)} m; ` +
    `${incident.projection.crossTrackMeters.toFixed(1)} m from shape; ` +
    `stop chainage ${incident.stopProjection.shapeDistance.toFixed(1)} m, ` +
    `${incident.stopProjection.crossTrackMeters.toFixed(1)} m from shape; ` +
    `${incident.physicalStopDistance.toFixed(1)} m signed geometry distance to stop; ` +
    `graph-frame calculated stop chainage ` +
    `${incident.calculatedStopShapeDistance.toFixed(1)} m; ` +
    `chainage offset ${incident.chainageOffset.toFixed(1)} m, ` +
    `graph progress ${incident.geometryProgress.toFixed(1)} m; ` +
    `${incident.distanceToStopMeters.toFixed(1)} m direct GPS-to-stop; ` +
    `origin leg validation ${legValidation}\n` +
    `  Zero correction remains active for this next stop until a nonzero ` +
    `stop_distance arrives, the next stop changes, or stop-sequence quarantine begins.`
  );
}

function formatShortIntervalStopDistanceCorrection(incident) {
  if (incident.downstreamStopCorrection) {
    const confirmationFeeds = incident.confirmationSamples
      .map((sample) => formatFeedSource(sample.source))
      .join(' and ');
    return (
      `Short-interval stop_distance reconciled using downstream stop geometry: ` +
      `vehicle id=${incident.vehicleId || '<missing>'}, ` +
      `name=${incident.vehicleName || '<missing>'}` +
      `${incident.entityId ? `, entity=${incident.entityId}` : ''}, ` +
      `trip=${incident.tripId}\n` +
      `  Previous feed: ${formatFeedSource(incident.previous.source)}; ` +
      `stop ${incident.previous.feedStopId}; stop_distance ` +
      `${incident.previousReportedStopDistance.toFixed(1)} -> ` +
      `${incident.previous.reportedStopDistance.toFixed(1)} m\n` +
      `  Current feed: ${formatFeedSource(incident.current.source)}; ` +
      `stop ${incident.current.feedStopId}; stop_distance ` +
      `${incident.currentReportedStopDistance.toFixed(1)} -> ` +
      `${incident.current.reportedStopDistance.toFixed(1)} m\n` +
      `  Rebased to downstream stop ${incident.targetStopId} ` +
      `(index ${incident.targetStopIndex}); GPS trajectory confirmed by ` +
      `${confirmationFeeds}; shape errors ` +
      `${incident.previousShapeError.toFixed(1)} / ` +
      `${incident.currentShapeError.toFixed(1)} m`
    );
  }

  const earlierCorrection = incident.earlierCorrection
    ? `\n  Earlier repeated feed: ` +
      `${formatFeedSource(incident.earlierCorrection.sample.source)}; ` +
      `vehicle time ` +
      `${formatTimestamp(incident.earlierCorrection.sample.vehicleTimestamp)}; ` +
      `GPS ${formatGpsPosition(incident.earlierCorrection.sample.position)}; ` +
      `stop_distance ` +
      `${incident.earlierCorrection.reportedStopDistance.toFixed(1)} -> ` +
      `${incident.earlierCorrection.correctedStopDistance.toFixed(1)} m ` +
      `(shape estimate ` +
      `${incident.earlierCorrection.expectedStopDistance.toFixed(1)} m, ` +
      `prior error ${incident.earlierCorrection.shapeError.toFixed(1)} m, ` +
      `${incident.earlierCorrection.crossTrackMeters.toFixed(1)} m from shape)`
    : '';
  const currentStopDistance = incident.currentDistanceRecalculated
    ? `${incident.currentReportedStopDistance.toFixed(1)} -> ` +
      `${incident.current.reportedStopDistance.toFixed(1)} m`
    : `${incident.current.reportedStopDistance.toFixed(1)} m`;
  return (
    `Short-interval stop_distance reconciled: vehicle id=${incident.vehicleId || '<missing>'}, ` +
    `name=${incident.vehicleName || '<missing>'}` +
    `${incident.entityId ? `, entity=${incident.entityId}` : ''}, ` +
    `trip=${incident.tripId}\n` +
    `  Previous feed: ${formatFeedSource(incident.previous.source)}; ` +
    `vehicle time ${formatTimestamp(incident.previous.vehicleTimestamp)}; ` +
    `GPS ${formatGpsPosition(incident.previous.position)}; stop_distance ` +
    `${incident.reportedStopDistance.toFixed(1)} -> ` +
    `${incident.correctedStopDistance.toFixed(1)} m ` +
    `(shape estimate ${incident.previousExpectedStopDistance.toFixed(1)} m, ` +
    `prior error ${incident.previousShapeError.toFixed(1)} m, ` +
    `${incident.previousCrossTrackMeters.toFixed(1)} m from shape)\n` +
    `  Current feed: ${formatFeedSource(incident.current.source)}; ` +
    `vehicle time ${formatTimestamp(incident.current.vehicleTimestamp)}; ` +
    `GPS ${formatGpsPosition(incident.current.position)}; stop_distance ` +
    `${currentStopDistance} ` +
    `(shape estimate ${incident.currentExpectedStopDistance.toFixed(1)} m, ` +
    `error ${incident.currentShapeError.toFixed(1)} m, ` +
    `${incident.currentCrossTrackMeters.toFixed(1)} m from shape); ` +
    `vehicle time delta ${incident.vehicleTimeDeltaSeconds} s` +
    earlierCorrection
  );
}

function formatRepeatedStaleStopDistanceCorrection(incident) {
  const staleFeeds = incident.staleSamples
    .map((correction) => formatFeedSource(correction.sample.source))
    .join(' and ');
  const rawStopDistance = incident.staleSamples[0].reportedStopDistance;
  return (
    `Repeated stale stop_distance corrected after a persistent update: ` +
    `vehicle id=${incident.vehicleId || '<missing>'}, ` +
    `name=${incident.vehicleName || '<missing>'}` +
    `${incident.entityId ? `, entity=${incident.entityId}` : ''}, ` +
    `trip=${incident.tripId}\n` +
    `  Repeated stale feeds: ${staleFeeds}; stop_distance ` +
    `${rawStopDistance.toFixed(1)} -> ` +
    `${incident.correctedStopDistance.toFixed(1)} m; ` +
    `GPS-to-stop ${incident.staleDistanceToStop.toFixed(1)} m\n` +
    `  First updated feed: ` +
    `${formatFeedSource(incident.freshSample.source)}; stop_distance ` +
    `${incident.freshSample.reportedStopDistance.toFixed(1)} m; ` +
    `GPS-to-stop ${incident.freshDistanceToStop.toFixed(1)} m; GPS movement ` +
    `${incident.gpsMovementMeters.toFixed(1)} m\n` +
    `  Confirmed by ${formatFeedSource(incident.confirmationSample.source)}; ` +
    `stop_distance ` +
    `${incident.confirmationSample.reportedStopDistance.toFixed(1)} m; ` +
    `GPS-to-stop ` +
    `${incident.confirmationDistanceToStop.toFixed(1)} m`
  );
}

function formatShortIntervalStopDistanceCorrectionRejection(incident) {
  const shapeEvidence = incident.previousShapeError === undefined
    ? ''
    : `\n  Shape checks: previous error ` +
      `${incident.previousShapeError.toFixed(1)} m, current error ` +
      `${incident.currentShapeError.toFixed(1)} m; cross-track ` +
      `${incident.previousCrossTrackMeters.toFixed(1)} / ` +
      `${incident.currentCrossTrackMeters.toFixed(1)} m`;
  return (
    `Short-interval stop_distance candidate not reconciled: ` +
    `vehicle id=${incident.vehicleId || '<missing>'}, ` +
    `name=${incident.vehicleName || '<missing>'}` +
    `${incident.entityId ? `, entity=${incident.entityId}` : ''}, ` +
    `trip=${incident.tripId}; reason=${incident.rejectionReason}\n` +
    `  Previous feed: ${formatFeedSource(incident.previous.source)}; ` +
    `vehicle time ${formatTimestamp(incident.previous.vehicleTimestamp)}; ` +
    `stop_distance ${incident.previous.reportedStopDistance.toFixed(1)} m\n` +
    `  Current feed: ${formatFeedSource(incident.current.source)}; ` +
    `vehicle time ${formatTimestamp(incident.current.vehicleTimestamp)}; ` +
    `stop_distance ${incident.current.reportedStopDistance.toFixed(1)} m\n` +
    `  Candidate progress speed ${incident.candidateSpeedMps.toFixed(1)} m/s ` +
    `from a ${incident.stopDistanceDropMeters.toFixed(1)} m stop_distance ` +
    `drop over ${incident.vehicleTimeDeltaSeconds} s${shapeEvidence}`
  );
}

function formatStopSequenceFeed(label, sample) {
  return (
    `  ${label}: ${formatFeedSource(sample.source)}; ` +
    `vehicle time ${formatTimestamp(sample.vehicleTimestamp)}; ` +
    `sequence ${sample.stopIndex + 1}, stop ${sample.stopId}; ` +
    `GPS ${formatGpsPosition(sample.position)}; ` +
    `stop_distance ${sample.reportedStopDistance.toFixed(1)} m; ` +
    `shape_dist_traveled ${sample.stopShapeDistance.toFixed(1)} m; ` +
    `progress ${sample.progress.toFixed(1)} m`
  );
}

function formatPersistentZeroStopDistanceCorrection(incident) {
  return (
    `Persistent shape-based stop_distance correction: ` +
    `vehicle id=${incident.vehicleId || '<missing>'}, ` +
    `name=${incident.vehicleName || '<missing>'}` +
    `${incident.entityId ? `, entity=${incident.entityId}` : ''}, ` +
    `trip=${incident.tripId}, route=${incident.routeName || '<unknown>'}\n` +
    `  Correction started at ${formatFeedSource(incident.startedAt)}; ` +
    `current feed ${formatFeedSource(incident.current.source)}; ` +
    `vehicle time ${formatTimestamp(incident.current.vehicleTimestamp)}\n` +
    `  stop_distance ${incident.reportedStopDistance.toFixed(1)} -> ` +
    `${incident.correctedStopDistance.toFixed(1)} m from valid shape ` +
    `projection (difference ` +
    `${incident.correctionDifferenceMeters.toFixed(1)} m)`
  );
}

function formatStopSequenceRegression(incident) {
  const vehicleId = incident.current.vehicleId || '<missing>';
  const vehicleName = incident.current.vehicleName || '<missing>';
  const gpsDistance = incident.gpsDistanceToStopMeters === null
    ? 'unavailable'
    : `${incident.gpsDistanceToStopMeters.toFixed(1)} m`;
  const difference = incident.differenceMeters === null
    ? 'unavailable'
    : `${incident.differenceMeters.toFixed(1)} m`;
  if (incident.phase === 'started') {
    return (
      `Stop-sequence regression; feed invalidated: vehicle id=${vehicleId}, ` +
      `name=${vehicleName}, trip=${incident.current.tripId}\n` +
      `${formatStopSequenceFeed('Previous accepted feed', incident.previous)}\n` +
      `${formatStopSequenceFeed('Backward-sequence feed', incident.current)}\n` +
      `  GPS-to-stop ${gpsDistance} vs reported stop_distance ` +
      `${incident.current.reportedStopDistance.toFixed(1)} m ` +
      `(difference ${difference}; tolerance ${incident.toleranceMeters} m). ` +
      `Quarantining feeds until GPS validates stop_distance.`
    );
  }

  return (
    `Stop-sequence regression recovered: vehicle id=${vehicleId}, ` +
    `name=${vehicleName}, trip=${incident.current.tripId}; ` +
    `${incident.invalidatedFeedCount} feed(s) invalidated\n` +
    `${formatStopSequenceFeed('Last invalid feed', incident.lastInvalidSample)}\n` +
    `${formatStopSequenceFeed('GPS-validated recovery feed', incident.current)}\n` +
    `  GPS-to-stop ${gpsDistance} vs reported stop_distance ` +
    `${incident.current.reportedStopDistance.toFixed(1)} m ` +
    `(difference ${difference}, within ${incident.toleranceMeters} m). ` +
    `Using recovery feed as a new baseline; no speed transition bridged across ` +
    `the invalid feeds.`
  );
}

function formatGpsDriftRejection(incident) {
  const { sample, penalties } = incident;
  const speed = incident.speedMps === null
    ? 'unavailable'
    : `${incident.speedMps.toFixed(1)} m/s`;
  const acceleration = incident.accelerationMps2 === null
    ? 'unavailable'
    : `${incident.accelerationMps2.toFixed(1)} m/s²`;
  const history = incident.rejectionReason === 'back-propagated'
    ? `recheck score ${incident.recheckPreviousScore.toFixed(1)} contributes ` +
      `${incident.recheckHistoryContribution.toFixed(1)} after decay`
    : `previous score ${incident.previousScore.toFixed(1)} contributes ` +
      `${incident.historyContribution.toFixed(1)} after decay`;
  const backpropagatedProgress =
    incident.backpropagatedProgressPenalty > 0
      ? `, back-propagated progress ` +
        `${incident.backpropagatedProgressPenalty.toFixed(1)} ` +
        `(delta ${incident.backpropagatedProgressDeltaMeters.toFixed(1)} m)`
      : '';
  return (
    `GPS-drift score rejected feed: vehicle id=${incident.vehicleId || '<missing>'}, ` +
    `name=${incident.vehicleName || '<missing>'}, trip=${incident.tripId}; ` +
    `score ${incident.score.toFixed(2)} (>100, ${incident.rejectionReason}; ` +
    `${history})\n` +
    `  Feed: ${formatFeedSource(sample.source)}; ` +
    `vehicle time ${formatTimestamp(sample.vehicleTimestamp ?? sample.timestamp)}; ` +
    `sequence ${sample.stopIndex + 1}, stop ${sample.stopId}; ` +
    `GPS ${formatGpsPosition(sample.position)}; ` +
    `stop_distance ${formatStopDistance(sample)}; ` +
    `progress ${sample.progress.toFixed(1)} m; ` +
    `${incident.duplicateGpsObservation
      ? 'repeated timestamp/location; '
      : ''}` +
    `GPS speed ${speed}; acceleration ${acceleration}; ` +
    `sequence delta ${incident.sequenceDelta >= 0 ? '+' : ''}` +
    `${incident.sequenceDelta}; progress delta ` +
    `${incident.progressDeltaMeters.toFixed(1)} m\n` +
    `  Penalties: speed ${penalties.speedPenalty.toFixed(1)}, ` +
    `acceleration ${penalties.accelerationPenalty.toFixed(1)}, ` +
    `sequence +${penalties.sequenceIncrementPenalty.toFixed(1)}/` +
    `-${penalties.sequenceDecrementPenalty.toFixed(1)}, ` +
    `backward progress ${penalties.negativeProgressPenalty.toFixed(1)}` +
    backpropagatedProgress
  );
}

function formatSpeedOutlier(outlier) {
  const vehicleId = outlier.vehicleId || '<missing>';
  const vehicleName = outlier.vehicleName || '<missing>';
  return (
    `Speed outlier: ${outlier.speedMps.toFixed(1)} m/s ` +
    `(limit ${outlier.limitMps} m/s; speed threshold is diagnostic)\n` +
    `  Detected in: ${formatFeedSource(outlier.current.source)}\n` +
    `  Previous sample: ${formatFeedSource(outlier.previous.source)}\n` +
    `  Vehicle: id=${vehicleId}, name=${vehicleName}` +
    `${outlier.entityId ? `, entity=${outlier.entityId}` : ''}, trip=${outlier.tripId}\n` +
    `  Destination stops: ${outlier.fromStop.id} (${outlier.fromStop.name || '<unnamed>'}) -> ` +
    `${outlier.toStop.id} (${outlier.toStop.name || '<unnamed>'})\n` +
    `  Time: ${formatTimestamp(outlier.previous.timestamp)} -> ` +
    `${formatTimestamp(outlier.current.timestamp)} ` +
    `(${outlier.elapsedSeconds.toFixed(1)} s; adjusted ${outlier.adjustedSeconds.toFixed(1)} s)\n` +
    `  Distance: ${outlier.distanceMeters.toFixed(1)} m travelled; ` +
    `progress ${outlier.previous.progress.toFixed(1)} -> ` +
    `${outlier.current.progress.toFixed(1)} m; ` +
    `door_open ${outlier.previous.doorOpen} -> ${outlier.current.doorOpen}; ` +
    `stop_distance ${formatStopDistance(outlier.previous)} -> ` +
    `${formatStopDistance(outlier.current)}; ` +
    `shape_dist_traveled ${outlier.previous.shapeDistance.toFixed(1)} -> ` +
    `${outlier.current.shapeDistance.toFixed(1)} m ` +
    `(delta ${outlier.shapeDistanceMeters.toFixed(1)} m)`
  );
}

function formatDoorSensorAnomaly(anomaly) {
  const vehicleId = anomaly.vehicleId || '<missing>';
  const vehicleName = anomaly.vehicleName || '<missing>';
  return (
    `Door sensor anomaly: vehicle id=${vehicleId}, name=${vehicleName}, ` +
    `trip=${anomaly.tripId}; door_open stayed true while GPS moved ` +
    `${anomaly.distanceMeters.toFixed(1)} m from its first open sample ` +
    `${formatGpsPosition(anomaly.startPosition)} at ` +
    `${formatTimestamp(anomaly.startTimestamp)} to ` +
    `${formatGpsPosition(anomaly.detectedPosition)} at ` +
    `${formatTimestamp(anomaly.detectedTimestamp)} ` +
    `(threshold ${anomaly.thresholdMeters} m). ` +
    `Marking door_sensor_stuck=true; discarding ` +
    `${anomaly.bufferedFeedCount} buffered feed(s), rejecting the detection ` +
    `feed, and rejecting later feed pairs with door_open=true. ` +
    `Detected in: ${formatFeedSource(anomaly.source)}`
  );
}

function displayResultSummary(
  summary,
  totalMessages,
  skippedMessages,
  archiveCount
) {
  console.info(
    `Parsed ${totalMessages} protobuf message(s); skipped ${skippedMessages} ` +
    `archive message(s) without decoding across ${archiveCount} selected archive(s)`
  );
  console.info(
    `Built speed graph: ${summary.directedStopPairs} directed stop pair(s), ` +
    `${summary.speedBuckets} classified 20m bucket(s), ` +
    `${summary.speedSamples} bucket speed sample(s)`
  );
  console.info(
    `Speed outliers: ${summary.speedOutlierCount} sample transition(s) above ` +
    `${summary.speedOutlierLimitMps} m/s; ` +
    `logged with details; the speed threshold alone does not exclude samples`
  );

  console.info(
    `Average samples per populated class bucket: ${summary.averageSamplesPerBucket.toFixed(2)}`
  );
  console.info('Traffic class distribution (share of bucket speed samples):');
  console.info('  Speed p50/p95 are approximate (0.5 m/s bins); maximum speed is exact.');
  for (const trafficClass of ['very_slow', 'slow', 'normal', 'fast']) {
    const stats = summary.trafficClassStats[trafficClass];
    const rangeDistribution = Object.entries(stats.bucketSampleDistribution)
      .filter(([, bucketCount]) => bucketCount > 0)
      .map(([range, bucketCount]) => {
        const bucketShare = stats.bucketCount > 0
          ? (bucketCount / stats.bucketCount * 100).toFixed(1)
          : '0.0';
        return `${range}: ${bucketCount} (${bucketShare}%)`;
      });
    const speedPercentiles = stats.speedMedianMps === null
      ? 'speed p50/p95/max: n/a'
      : `speed p50/p95/max: ~${stats.speedMedianMps.toFixed(1)}/` +
        `~${stats.speed95thPercentileMps.toFixed(1)}/` +
        `${stats.maximumSpeedMps.toFixed(1)} m/s`;
    const nonStoppingSummary = stats.nonStoppingSpeedSamples > 0
      ? `no-stop +/-20s: ${stats.nonStoppingBucketCount} buckets, ` +
        `${stats.nonStoppingSpeedSamples} samples`
      : 'no-stop +/-20s: none';
    console.info(
      `  ${trafficClass}: ${stats.bucketCount} buckets, ${stats.speedSamples} samples ` +
      `(${stats.speedSampleSharePercent.toFixed(1)}%); samples/bucket ` +
      `avg ${stats.averageSamplesPerBucket.toFixed(2)}, ` +
      `median ${stats.medianSamplesPerBucket ?? 'n/a'}; ` +
      `bucket distribution [${rangeDistribution.join(', ') || 'none'}]; ` +
      `${speedPercentiles}; ${nonStoppingSummary}`
    );
  }

  const totalTrackedLegs =
    summary.classifiedLegs + summary.unclassifiedLegs + summary.pendingLegs;
  const classificationPercent = totalTrackedLegs > 0
    ? (summary.classifiedLegs / totalTrackedLegs * 100).toFixed(1)
    : '0.0';
  const rejectedVehiclePercent = summary.vehicleObservations > 0
    ? (summary.rejectedVehicleObservations / summary.vehicleObservations * 100).toFixed(1)
    : '0.0';
  console.info(
    `Legs with speed data: ${summary.classifiedLegs} classified ` +
    `(${classificationPercent}% of ${totalTrackedLegs}), ${summary.unclassifiedLegs} unclassified, ` +
    `${summary.pendingLegs} pending`
  );
  console.info(
    `Vehicle observations: ${summary.vehicleObservations - summary.rejectedVehicleObservations} usable / ` +
    `${summary.vehicleObservations}; ${summary.rejectedVehicleObservations} rejected ` +
    `(${rejectedVehiclePercent}%), ${summary.rejectedSpeedSamples} rejected speed samples, ` +
    `${summary.rejectedFeedPairs} rejected feed pairs`
  );
  console.info(
    `Stationary stale-GPS vehicle samples skipped and bridged: ` +
    `${summary.stationaryGpsSamplesDropped}`
  );
  console.info(
    `GPS-drift filter: ${summary.gpsDriftRejectedFeeds} feed(s) rejected at score > 100`
  );
  console.info(
    `Door sensor anomalies: ${summary.doorSensorStuckTrips} trip(s) flagged ` +
    `door_sensor_stuck; ${summary.doorSensorRejectedFeedPairs} affected feed pair(s) rejected`
  );
  console.info(
    `Stop-sequence regressions: ${summary.stopSequenceRegressionEpisodes} episode(s), ` +
    `${summary.stopSequenceRegressionRejectedFeeds} feed(s) invalidated, ` +
    `${summary.stopSequenceRegressionRecoveries} recovered`
  );
  console.info(
    `Open-door waits: ${summary.routeStopWaits} route-stops, ` +
    `${summary.routeStopWaitClasses} route-stop classes, ${summary.waitSamples} samples, ` +
    `${summary.doorOpenSeconds.toFixed(1)} seconds; ` +
    `${summary.unattributedWaits} unattributed wait sample(s)`
  );
}

async function processArchive(
  archivePath,
  streamReader,
  messageSkipCount,
  messageLimit,
  displayState,
  timetableLoader,
  speedGraph,
  status
) {
  let decodedCount = 0;
  let completed = true;
  for await (const { name, message } of streamReader.readMessages({
    skipMessages: messageSkipCount
  })) {
    const timetable = await timetableLoader.loadForFeed(message);
    speedGraph.processFeed(message, timetable, {
      archiveName: path.basename(archivePath),
      feedName: name
    });
    const record = { archiveName: path.basename(archivePath), name, message };
    displayState.count++;
    if (displayState.mode === 'all') {
      displayMessage(`Decoded message ${displayState.count}`, record);
    } else if (displayState.mode === 'first-and-last') {
      displayState.first ??= record;
      displayState.last = record;
    }
    decodedCount++;
    status.incrementMessages();
    if (messageLimit !== null && decodedCount >= messageLimit) {
      completed = false;
      break;
    }
  }
  return {
    decodedCount,
    skippedCount: streamReader.skippedMessages,
    completed
  };
}

export async function main(args = process.argv.slice(2)) {
  const {
    archiveDirectory,
    maxArchives,
    maxMessages,
    skipMessages,
    outputFile,
    displayMessages
  } = parseArguments(args);
  if (outputFile) {
    try {
      await stat(outputFile);
      throw new Error(`Output file already exists: ${outputFile}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const entries = await readdir(archiveDirectory, { withFileTypes: true });
  const foundArchives = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tar.gz'))
    .map((entry) => path.join(archiveDirectory, entry.name))
    .sort();

  if (foundArchives.length === 0) {
    console.info(`No .tar.gz archives found in ${archiveDirectory}`);
    return;
  }

  const archives = maxArchives === null
    ? foundArchives
    : foundArchives.slice(0, maxArchives);
  const archiveSizes = await Promise.all(archives.map(async (archivePath) => ({
    path: archivePath,
    size: (await stat(archivePath)).size
  })));
  let totalMessages = 0;
  const displayState = {
    mode: displayMessages,
    count: 0,
    first: null,
    last: null
  };
  const speedGraph = new SpeedGraphBuilder({
    onSpeedOutlier: (outlier) => status.log(formatSpeedOutlier(outlier)),
    onDoorSensorStuck: (anomaly) => status.log(formatDoorSensorAnomaly(anomaly)),
    onGpsSignalLost: (incident) => status.log(formatGpsSignalLostIncident(incident)),
    onDelayedStopDistance: (incident) =>
      status.log(formatDelayedStopDistanceIncident(incident)),
    onNextStopDistanceCorrection: (incident) =>
      status.log(formatNextStopDistanceCorrection(incident)),
    onGpsBasedNextStopZeroCorrection: (incident) =>
      status.log(formatGpsBasedNextStopZeroCorrection(incident)),
    onShortIntervalStopDistanceCorrection: (incident) =>
      status.log(formatShortIntervalStopDistanceCorrection(incident)),
    onRepeatedStaleStopDistanceCorrection: (incident) =>
      status.log(formatRepeatedStaleStopDistanceCorrection(incident)),
    onShortIntervalStopDistanceCorrectionRejected: (incident) =>
      status.log(formatShortIntervalStopDistanceCorrectionRejection(incident)),
    onDoorOpenStopDistanceCorrection: (incident) =>
      status.log(formatDoorOpenStopDistanceCorrection(incident)),
    onClosedDoorStopDistanceCorrection: (incident) =>
      status.log(formatClosedDoorStopDistanceCorrection(incident)),
    onPersistentZeroStopDistanceCorrection: (incident) =>
      status.log(formatPersistentZeroStopDistanceCorrection(incident)),
    onStopSequenceRegression: (incident) =>
      status.log(formatStopSequenceRegression(incident)),
    onGpsDriftRejection: (incident) =>
      status.log(formatGpsDriftRejection(incident)),
    onFeedDisposition: (disposition) => {
      if (disposition.reason === 'timestamp-regression') {
        status.log(formatBackwardTimestampRejection(disposition));
      } else if (
        disposition.reason === 'gps-based-next-stop-correction-failed'
      ) {
        status.log(formatGpsBasedNextStopCorrectionRejection(disposition));
      }
    }
  });
  const status = new StatusDisplay({
    totalFiles: archiveSizes.length,
    totalBytes: archiveSizes.reduce((total, archive) => total + archive.size, 0),
    speedGraph,
    live: true
  });
  const timetableLoader = new TimetableLoader(archiveDirectory, {
    onShapePointIndexIssue: (message) =>
      status.log(`Shape-point indexing issue: ${message}`),
    onShapeDistanceValidationError: (message) =>
      status.log(`Shape-distance validation error: ${message}`)
  });

  let finished = false;
  let totalSkippedMessages = 0;
  status.start();
  try {
    for (const { path: archivePath, size } of archiveSizes) {
      const remainingMessages = maxMessages === null ? null : maxMessages - totalMessages;
      if (remainingMessages !== null && remainingMessages <= 0) break;
      const remainingMessagesToSkip = skipMessages - totalSkippedMessages;
      status.beginFile(path.basename(archivePath), size);
      const result = await processArchive(
        archivePath,
        new StreamReader(archivePath, {
          onProgress: (bytesRead) => status.updateFileBytes(bytesRead)
        }),
        remainingMessagesToSkip,
        remainingMessages,
        displayState,
        timetableLoader,
        speedGraph,
        status
      );
      totalMessages += result.decodedCount;
      totalSkippedMessages += result.skippedCount;
      if (!result.completed) break;
      status.completeFile();
    }
    speedGraph.flushPendingStationaryFeeds();
    finished = true;
  } finally {
    status.stop({ finished });
  }

  if (displayMessages === 'first-and-last' && displayState.first) {
    displayMessage('First decoded message', displayState.first);
    if (displayState.count > 1) {
      displayMessage('Last decoded message', displayState.last);
    }
  }

  const graphSummary = speedGraph.summary();
  displayResultSummary(
    graphSummary,
    totalMessages,
    totalSkippedMessages,
    archives.length
  );
  let output = null;
  if (outputFile) {
    const encoded = encodeGraphExport(speedGraph, graphSummary, {
      archiveFiles: archives.map((archivePath) => path.basename(archivePath)),
      decodedMessages: totalMessages
    });
    await mkdir(path.dirname(outputFile), { recursive: true });
    await writeFile(outputFile, encoded, { flag: 'wx' });
    output = { path: outputFile, bytes: encoded.byteLength };
    console.info(`MessagePack results: ${output.path} (${output.bytes} bytes)`);
  }
  return { speedGraph, summary: graphSummary, output };
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Oversampling failed: ${error.message}`);
    process.exitCode = 1;
  });
}
