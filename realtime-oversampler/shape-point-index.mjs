function finiteNumber(value) {
  if (value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function lowerBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low < values.length ? low : null;
}

function haversineMeters(first, second) {
  const radians = Math.PI / 180;
  const latitudeDelta = (second.latitude - first.latitude) * radians;
  let longitudeDelta = (second.longitude - first.longitude) * radians;
  if (longitudeDelta > Math.PI) longitudeDelta -= 2 * Math.PI;
  if (longitudeDelta < -Math.PI) longitudeDelta += 2 * Math.PI;
  const latitude = first.latitude * radians;
  const nextLatitude = second.latitude * radians;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude) * Math.cos(nextLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function pointAtDistance(shape, distances, target) {
  const index = lowerBound(distances, target);
  if (index === null) return null;
  if (distances[index] === target) {
    return {
      coordinate: shape[index],
      pointIndex: index
    };
  }
  if (index === 0) return null;

  const previousIndex = index - 1;
  const distanceSpan = distances[index] - distances[previousIndex];
  if (distanceSpan <= 0) return null;
  const fraction = (target - distances[previousIndex]) / distanceSpan;
  let longitudeDelta =
    shape[index].longitude - shape[previousIndex].longitude;
  if (longitudeDelta > 180) longitudeDelta -= 360;
  if (longitudeDelta < -180) longitudeDelta += 360;
  return {
    coordinate: {
      longitude: shape[previousIndex].longitude + longitudeDelta * fraction,
      latitude: shape[previousIndex].latitude +
        (shape[index].latitude - shape[previousIndex].latitude) * fraction
    },
    pointIndex: index
  };
}

function createShapeModel(shape) {
  if (!Array.isArray(shape) || shape.length < 2) {
    return { error: 'common shape is missing or has fewer than two points' };
  }

  const points = shape.map((point) => ({
    distance: finiteNumber(point?.[0]),
    longitude: finiteNumber(point?.[1]),
    latitude: finiteNumber(point?.[2])
  }));
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (point.distance === null ||
        point.longitude === null ||
        point.latitude === null ||
        point.longitude < -180 ||
        point.longitude > 180 ||
        point.latitude < -90 ||
        point.latitude > 90) {
      return { error: `common shape point ${index} has invalid distance or coordinates` };
    }
    if (index > 0 && point.distance < points[index - 1].distance) {
      return { error: `common shape distances decrease at point ${index}` };
    }
  }

  const distances = points.map((point) => point.distance);
  const metersPerUnitSamples = [];
  for (let index = 1; index < points.length; index++) {
    const chainageDelta = distances[index] - distances[index - 1];
    const geometryDelta = haversineMeters(points[index - 1], points[index]);
    if (chainageDelta === 0) {
      if (geometryDelta > 1) {
        return {
          error:
            `common shape moves ${geometryDelta.toFixed(1)} m between points ` +
            `${index - 1} and ${index} without increasing shape distance`
        };
      }
      continue;
    }
    if (geometryDelta > 1) {
      metersPerUnitSamples.push(geometryDelta / chainageDelta);
    }
  }
  if (metersPerUnitSamples.length === 0) {
    return { error: 'common shape has no measurable distance intervals' };
  }

  return {
    points,
    distances,
    metersPerUnit: median(metersPerUnitSamples)
  };
}

function createGeometryShapeModel(shape) {
  if (!Array.isArray(shape) || shape.length < 2) {
    return { error: 'common shape is missing or has fewer than two points' };
  }

  const points = shape.map((point) => ({
    longitude: finiteNumber(point?.[1]),
    latitude: finiteNumber(point?.[2])
  }));
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (point.longitude === null ||
        point.latitude === null ||
        point.longitude < -180 ||
        point.longitude > 180 ||
        point.latitude < -90 ||
        point.latitude > 90) {
      return { error: `common shape point ${index} has invalid coordinates` };
    }
  }

  const distances = [0];
  for (let index = 1; index < points.length; index++) {
    distances.push(
      distances[index - 1] +
      haversineMeters(points[index - 1], points[index])
    );
  }
  if (distances.at(-1) === 0) {
    return { error: 'common shape has no measurable geometry distance' };
  }

  return {
    points: points.map((point, index) => ({
      ...point,
      distance: distances[index]
    })),
    distances,
    metersPerUnit: 1
  };
}

function projectPositionOntoShape(
  shapeModel,
  position,
  minShapeDistance,
  maxShapeDistance
) {
  if (!position ||
      !Number.isFinite(position.latitude) ||
      !Number.isFinite(position.longitude) ||
      position.latitude < -90 ||
      position.latitude > 90 ||
      position.longitude < -180 ||
      position.longitude > 180) {
    return null;
  }
  if (minShapeDistance === maxShapeDistance &&
        minShapeDistance === shapeModel.distances[0]) {
      return {
        shapeDistance: minShapeDistance,
        crossTrackMeters: haversineMeters(position, shapeModel.points[0]),
        metersPerUnit: shapeModel.metersPerUnit
      };
  }
  const metersPerDegreeLat = 111132;
  const metersPerDegreeLon =
    111320 * Math.cos(position.latitude * Math.PI / 180);
  let best = null;
  const firstPointIndex = lowerBound(
    shapeModel.distances,
    minShapeDistance
  ) ?? shapeModel.points.length;
  const lastPointIndex = lowerBound(
    shapeModel.distances,
    maxShapeDistance
  ) ?? shapeModel.points.length - 1;

  for (let index = Math.max(1, firstPointIndex);
    index <= lastPointIndex;
    index++) {
    const start = shapeModel.points[index - 1];
    const end = shapeModel.points[index];
    const chainageDelta = end.distance - start.distance;
    if (chainageDelta <= 0) continue;

    const boundedStart = Math.max(start.distance, minShapeDistance);
    const boundedEnd = Math.min(end.distance, maxShapeDistance);
    if (boundedEnd < boundedStart) continue;

    const minimumFraction = (boundedStart - start.distance) / chainageDelta;
    const maximumFraction = (boundedEnd - start.distance) / chainageDelta;
    const startX = (start.longitude - position.longitude) * metersPerDegreeLon;
    const startY = (start.latitude - position.latitude) * metersPerDegreeLat;
    const endX = (end.longitude - position.longitude) * metersPerDegreeLon;
    const endY = (end.latitude - position.latitude) * metersPerDegreeLat;
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const lengthSquared = deltaX ** 2 + deltaY ** 2;
    if (lengthSquared === 0) continue;

    const fraction = Math.max(
      minimumFraction,
      Math.min(
        maximumFraction,
        -(startX * deltaX + startY * deltaY) / lengthSquared
      )
    );
    const projectedPosition = {
      longitude: start.longitude + fraction * (end.longitude - start.longitude),
      latitude: start.latitude + fraction * (end.latitude - start.latitude)
    };
    const crossTrackMeters = haversineMeters(position, projectedPosition);
    if (!best || crossTrackMeters < best.crossTrackMeters) {
      best = {
        shapeDistance: start.distance + fraction * chainageDelta,
        crossTrackMeters,
        metersPerUnit: shapeModel.metersPerUnit
      };
    }
  }

  return best;
}

export function createTimetableShapeProjector(timetable) {
  const shapeModels = new Map();
  return (trip, position, {
    minShapeDistance = Number.NEGATIVE_INFINITY,
    maxShapeDistance = Number.POSITIVE_INFINITY
  } = {}) => {
    const shapeId = String(trip?.shape_id);
    if (!shapeModels.has(shapeId)) {
      const shape = timetable.shapes instanceof Map
        ? timetable.shapes.get(shapeId)
        : timetable.shapes?.[shapeId];
      shapeModels.set(shapeId, createShapeModel(shape));
    }
    const shapeModel = shapeModels.get(shapeId);
    if (shapeModel.error) return null;
    return projectPositionOntoShape(
      shapeModel,
      position,
      minShapeDistance,
      maxShapeDistance
    );
  };
}

export function createTimetableShapeDistanceMeasurer(timetable) {
  const shapeModels = new Map();
  return (trip, startShapeDistance, endShapeDistance) => {
    const shapeId = String(trip?.shape_id);
    if (!shapeModels.has(shapeId)) {
      const shape = timetable.shapes instanceof Map
        ? timetable.shapes.get(shapeId)
        : timetable.shapes?.[shapeId];
      shapeModels.set(shapeId, createShapeModel(shape));
    }
    const shapeModel = shapeModels.get(shapeId);
    if (shapeModel.error) return null;

    const measurement = measureShapeLength(
      shapeModel,
      startShapeDistance,
      endShapeDistance,
      0
    );
    return measurement.error ? null : measurement.lengthMeters;
  };
}

export function createTimetableShapeGeometryProjector(timetable) {
  const shapeModels = new Map();
  return (trip, position, {
    minShapePointIndex = 0,
    maxShapePointIndex
  } = {}) => {
    const shapeId = String(trip?.shape_id);
    if (!shapeModels.has(shapeId)) {
      const shape = timetable.shapes instanceof Map
        ? timetable.shapes.get(shapeId)
        : timetable.shapes?.[shapeId];
      shapeModels.set(shapeId, createGeometryShapeModel(shape));
    }
    const shapeModel = shapeModels.get(shapeId);
    if (shapeModel.error) return null;
    const parsedMinimumIndex = Number(minShapePointIndex);
    const parsedMaximumIndex = maxShapePointIndex === undefined
      ? shapeModel.points.length - 1
      : Number(maxShapePointIndex);
    if (!Number.isFinite(parsedMinimumIndex) ||
        !Number.isFinite(parsedMaximumIndex)) {
      return null;
    }
    const minimumIndex = Math.max(
      0,
      Math.floor(parsedMinimumIndex)
    );
    const maximumIndex = Math.min(
      shapeModel.points.length - 1,
      Math.floor(parsedMaximumIndex)
    );
    if (minimumIndex > maximumIndex) return null;
    return projectPositionOntoShape(
      shapeModel,
      position,
      shapeModel.distances[minimumIndex],
      shapeModel.distances[maximumIndex]
    );
  };
}

export function createTimetableShapeGeometryDistanceMeasurer(timetable) {
  const shapeModels = new Map();
  return (trip, startGeometryDistance, endGeometryDistance) => {
    const shapeId = String(trip?.shape_id);
    if (!shapeModels.has(shapeId)) {
      const shape = timetable.shapes instanceof Map
        ? timetable.shapes.get(shapeId)
        : timetable.shapes?.[shapeId];
      shapeModels.set(shapeId, createGeometryShapeModel(shape));
    }
    const shapeModel = shapeModels.get(shapeId);
    if (shapeModel.error) return null;

    const measurement = measureShapeLength(
      shapeModel,
      startGeometryDistance,
      endGeometryDistance,
      0
    );
    return measurement.error ? null : measurement.lengthMeters;
  };
}

function measureShapeLength(
  shapeModel,
  startDistance,
  endDistance,
  boundaryToleranceMeters
) {
  const { points, distances } = shapeModel;
  const boundaryToleranceUnits =
    boundaryToleranceMeters / shapeModel.metersPerUnit;
  if (startDistance < distances[0] - boundaryToleranceUnits ||
      endDistance > distances.at(-1) + boundaryToleranceUnits ||
      endDistance < distances[0] - boundaryToleranceUnits ||
      startDistance > distances.at(-1) + boundaryToleranceUnits) {
    return {
      error:
        `stop distances are outside common shape range ` +
        `[${distances[0]}, ${distances.at(-1)}] by more than ` +
        `${boundaryToleranceMeters.toFixed(1)} m`
    };
  }

  const measuredStartDistance = Math.min(
    Math.max(startDistance, distances[0]),
    distances.at(-1)
  );
  const measuredEndDistance = Math.min(
    Math.max(endDistance, distances[0]),
    distances.at(-1)
  );
  const start = pointAtDistance(points, distances, measuredStartDistance);
  const end = pointAtDistance(points, distances, measuredEndDistance);
  if (!start || !end) {
    return { error: 'could not locate stop distances on the common shape' };
  }

  let lengthMeters = 0;
  let previous = start.coordinate;
  let pointIndex = lowerBound(distances, measuredStartDistance);
  if (pointIndex !== null && distances[pointIndex] === measuredStartDistance) {
    pointIndex++;
  }
  for (; pointIndex !== null &&
      pointIndex < points.length &&
      distances[pointIndex] < measuredEndDistance;
    pointIndex++) {
    const point = points[pointIndex];
    lengthMeters += haversineMeters(previous, point);
    previous = point;
  }
  lengthMeters += haversineMeters(previous, end.coordinate);
  return {
    lengthMeters,
    startPointIndex: start.pointIndex,
    endPointIndex: end.pointIndex,
    measuredStartDistance,
    measuredEndDistance
  };
}

export function createTimetableShapePointIndexer(
  timetable,
  onIssue = (message) => console.warn(message)
) {
  const shapeDistancesById = new Map();
  const indexedTrips = new Map();
  const tripIdsByIndex = new Map(
    Object.entries(timetable.tripMap ?? {}).map(([id, index]) => [Number(index), id])
  );

  return (tripIndex) => {
    if (indexedTrips.has(tripIndex)) return indexedTrips.get(tripIndex);
    const trip = timetable.trips?.[tripIndex];
    if (!trip) {
      indexedTrips.set(tripIndex, false);
      return false;
    }

    const tripId = trip.originalInd ?? tripIdsByIndex.get(tripIndex) ?? String(tripIndex);
    const shapeId = String(trip.shape_id);
    if (!shapeDistancesById.has(shapeId)) {
      const shape = timetable.shapes instanceof Map
        ? timetable.shapes.get(shapeId)
        : timetable.shapes?.[shapeId];
      const distances = Array.isArray(shape)
        ? shape.map((point) => finiteNumber(point?.[0]))
        : [];
      const isMonotonic = distances.length > 0 &&
        distances.every((distance, index) =>
          distance !== null &&
          (index === 0 || distance >= distances[index - 1])
        );
      if (!isMonotonic) {
        onIssue(`common shape ${shapeId} has missing or non-monotonic shape distances`);
      }
      shapeDistancesById.set(shapeId, isMonotonic ? distances : null);
    }

    const shapeDistances = shapeDistancesById.get(shapeId);
    if (!Array.isArray(trip.stopShapeDist)) {
      onIssue(`trip ${tripId} shape ${shapeId} has no stop shape distances`);
      indexedTrips.set(tripIndex, false);
      return false;
    }
    trip.stopShapePointIndex = trip.stopShapeDist.map((distance) => {
      const target = finiteNumber(distance);
      return target === null || !shapeDistances
        ? null
        : lowerBound(shapeDistances, target);
    });
    indexedTrips.set(tripIndex, true);
    return true;
  };
}

export function createTimetableShapeDistanceValidator(
  timetable,
  onFailure = (message) => console.error(message)
) {
  const shapeModels = new Map();
  const tripResults = new Map();
  const tripIdsByIndex = new Map(
    Object.entries(timetable.tripMap ?? {}).map(([id, index]) => [Number(index), id])
  );

  return (tripIndex) => {
    if (tripResults.has(tripIndex)) return tripResults.get(tripIndex);
    const trip = timetable.trips?.[tripIndex];
    if (!trip) {
      tripResults.set(tripIndex, []);
      return [];
    }

    const tripId = trip.originalInd ?? tripIdsByIndex.get(tripIndex) ?? String(tripIndex);
    const shapeId = String(trip.shape_id);
    if (!shapeModels.has(shapeId)) {
      const shape = timetable.shapes instanceof Map
        ? timetable.shapes.get(shapeId)
        : timetable.shapes?.[shapeId];
      shapeModels.set(shapeId, createShapeModel(shape));
    }
    const shapeModel = shapeModels.get(shapeId);
    const stopCount = Math.max(
      trip.stops?.length ?? 0,
      Array.isArray(trip.stopShapeDist) ? trip.stopShapeDist.length : 0
    );
    const validLegs = [];

    for (let stopIndex = 1; stopIndex < stopCount; stopIndex++) {
      const startDistance = finiteNumber(trip.stopShapeDist?.[stopIndex - 1]);
      const endDistance = finiteNumber(trip.stopShapeDist?.[stopIndex]);
      const startStop = trip.stops?.[stopIndex - 1];
      const endStop = trip.stops?.[stopIndex];
      const startStopId = startStop?._id ?? '<missing>';
      const endStopId = endStop?._id ?? '<missing>';
      let details;
      let valid = false;

      if (startDistance === null || endDistance === null) {
        details =
          `stop shape distances are missing or non-numeric ` +
          `(${trip.stopShapeDist?.[stopIndex - 1] ?? 'missing'} -> ` +
          `${trip.stopShapeDist?.[stopIndex] ?? 'missing'})`;
      } else if (endDistance <= startDistance) {
        details =
          `stop shape-distance delta is not positive ` +
          `(${endDistance - startDistance})`;
      } else if (shapeModel.error) {
        details = shapeModel.error;
      } else {
        const measurement = measureShapeLength(
          shapeModel,
          startDistance,
          endDistance,
          25
        );
        if (measurement.error) {
          details = measurement.error;
        } else {
          const chainageDelta = endDistance - startDistance;
          const expectedMeters = chainageDelta * shapeModel.metersPerUnit;
          const deviationMeters = Math.abs(
            measurement.lengthMeters - expectedMeters
          );
          const toleranceMeters = Math.max(25, expectedMeters * 0.2);
          valid = deviationMeters <= toleranceMeters;
          details =
            `shape_dist_traveled delta=${chainageDelta.toFixed(1)} units, ` +
            `shape points ${measurement.startPointIndex}->${measurement.endPointIndex}, ` +
            `measured chainage=${measurement.measuredStartDistance.toFixed(1)}->` +
            `${measurement.measuredEndDistance.toFixed(1)}, ` +
            `geometry=${measurement.lengthMeters.toFixed(1)} m, ` +
            `expected=${expectedMeters.toFixed(1)} m ` +
            `(${shapeModel.metersPerUnit.toFixed(6)} m/unit), ` +
            `deviation=${deviationMeters.toFixed(1)} m, ` +
            `tolerance=${toleranceMeters.toFixed(1)} m`;
        }
      }

      validLegs[stopIndex - 1] = valid;
      if (!valid) {
        const routeId = trip.route?._id ?? '<missing>';
        onFailure(
          `Invalid shape distance for trip ${tripId} (route ${routeId}), ` +
          `shape ${shapeId}, stop ${startStopId} (sequence ${stopIndex}) -> ` +
          `${endStopId} (sequence ${stopIndex + 1}): ` +
          `${startDistance ?? 'missing'} -> ${endDistance ?? 'missing'}; ${details}`
        );
      }
    }

    tripResults.set(tripIndex, validLegs);
    Object.defineProperty(trip, 'shapeDistanceLegValid', {
      configurable: true,
      value: validLegs
    });
    return validLegs;
  };
}
