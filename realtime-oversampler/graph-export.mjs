import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { encode } = require('../scripts/external/msgpack.min.js');

const trafficClasses = ['very_slow', 'slow', 'normal', 'fast'];
const trafficClassIndices = new Map(
  trafficClasses.map((trafficClass, index) => [trafficClass, index])
);

function encodeClasses(classes) {
  return [...classes].map(([trafficClass, buckets]) => {
    const classIndex = trafficClassIndices.get(trafficClass);
    if (classIndex === undefined) {
      throw new Error(`Unknown traffic class in speed graph: ${trafficClass}`);
    }
    return [
      classIndex,
      [...buckets]
        .sort(([leftBucket], [rightBucket]) => leftBucket - rightBucket)
        .map(([bucket, aggregate]) => [
          bucket,
          aggregate.sampleCount,
          aggregate.speedSumMps
        ])
    ];
  });
}

export function createGraphExport(speedGraph, summary, {
  archiveFiles,
  decodedMessages
}) {
  const stopIds = [];
  const stopIdIndices = new Map();
  const routeIds = [];
  const routeIdIndices = new Map();

  function internId(id, ids, indices) {
    const normalizedId = String(id);
    let index = indices.get(normalizedId);
    if (index === undefined) {
      index = ids.length;
      ids.push(normalizedId);
      indices.set(normalizedId, index);
    }
    return index;
  }

  const stopPairs = [...speedGraph.speedGraph.values()].map((pair) => [
    internId(pair.fromStopId, stopIds, stopIdIndices),
    internId(pair.toStopId, stopIds, stopIdIndices),
    encodeClasses(pair.classes),
    encodeClasses(pair.nonStoppingClasses)
  ]);

  const waits = [];
  for (const [routeId, stops] of speedGraph.waitingGraph) {
    for (const [stopId, classes] of stops) {
      for (const [trafficClass, aggregate] of classes) {
        const classIndex = trafficClassIndices.get(trafficClass);
        if (classIndex === undefined) {
          throw new Error(`Unknown traffic class in wait graph: ${trafficClass}`);
        }
        waits.push([
          internId(routeId, routeIds, routeIdIndices),
          internId(stopId, stopIds, stopIdIndices),
          classIndex,
          aggregate.sampleCount,
          aggregate.totalSeconds
        ]);
      }
    }
  }

  return {
    version: 1,
    trafficClasses,
    stopIds,
    routeIds,
    stopPairs,
    waits,
    summary,
    source: {
      archiveFiles,
      decodedMessages
    }
  };
}

export function encodeGraphExport(speedGraph, summary, source) {
  return encode(createGraphExport(speedGraph, summary, source));
}
