# Realtime Position Oversampler

## Overview 

This console app processes recorded vehicle feeds into an in-memory speed/location graph. It requires **Node.js 22 or newer**. Only completed `.tar.gz` archives are processed (active, uncompressed `.tar` files are intentionally skipped).

### Script Catalog

* **`oversample.mjs`**: Discovers completed `.tar.gz` archives, reports parsed feeds, loads the timetable effective on each feed's timestamp date, and passes decoded samples to `speed-graph.mjs`.
* **`stream-reader.mjs`**: Decodes protobuf entries (`.pb` files) on a worker thread and feed the decoded messages to the underlying system. It delegates archive disk I/O, gzip extraction, and tar reading to an isolated background worker thread (**`stream-reader-worker.mjs`**). After parsing, it passes decoded feeds back to the main thread.
* **`timetable-loader.mjs`**: Loads and caches daily timetables for the currently processed feeds. The loader selects the latest dated daily timetable on or before the feed date, then selects a common snapshot valid by that daily timetable's start date whose range matches its `c_range`. The parsed timetable is cached until a different effective daily timetable is selected. Reuses existing scripts in `scripts/`.
* **`status-display.mjs`**: Refreshes a fixed terminal dashboard every 500ms without scrolling when stdout is a TTY (otherwise, one final status snapshot is printed).
  * Displays archive/file progress, compressed archive MB read, decoded protobuf messages, graph counts, MB/s and messages/s, estimated remaining time, Node process CPU usage and resident memory (RSS), and the most recently updated stop-pair's bucket averages and sample counts.
  * Bucket values are average speeds in m/s; the number in parentheses is the sample count.
  * CPU usage is measured against one logical core, so it can exceed 100% when multiple Node threads are busy.
  * Explicit `--display-messages` modes print decoded messages separately: `all` is verbose, while `first-and-last` prints selected messages after processing.
* **`gps-drift-filter.mjs`**: Evaluates vehicle position changes to detect and reject anomalous GPS drifts. Using linear penalty functions across speed, acceleration, and sequence changes, it computes a cumulative drift score that triggers feed rejections and back-propagated validation checks whenever positioning errors exceed a threshold.
* **`graph-export.mjs`**: Serializes the calculated speed graph into a compressed binary format. It encapsulates speed histograms, stop-pair metrics, waiting aggregations, and performance summaries into MessagePack format.
* **`shape-point-index.mjs`**: Handles spatial indexing and geometric validation of transit shapes and stop coordinates. It provides lazy binary-search indexing of stops along common shape paths and validates stop-distance intervals against geodesic segment lengths to identify spatial discrepancies.
* **`speed-graph.mjs`**: Constructs the speed graph from cleaned vehicle feeds. It builds travel performance around directed stop-pairs. Each stop-pair maintains 20-meter distance buckets for each traffic class (very slow, slow, normal, fast) to map granular spatial speeds along the route.

## Shape Indexing & Validation Rules (`shape-point-index.mjs`)

* **Lazy Indexing**: When a realtime feed references a trip, stop indexing is lazily initialized via `createTimetableShapePointIndexer`, assigning `trip.stopShapePointIndex` from original shape distances coming from the timetable's `shape_dist_traveled` values and common shape points.
* **Binary Search**: Lookups are performed using the `lowerBound` function over monotonic shape distances without projecting coordinates or rewriting GTFS values. Missing or non-monotonic shape distances trigger warnings via `createTimetableShapePointIndexer`.
* **Shape-Distance Validation**: Consecutive stop-distance intervals are checked via `createTimetableShapeDistanceValidator` and `measureShapeLength`, validating geodesic lengths using `haversineMeters` and the shape's median meters-per-distance-unit ratio from `createShapeModel`.
* **Error Thresholds**: Deviations greater than **20%** or **25 m** (whichever is larger), or stop distances more than **25 m** outside the shape range, are reported as errors with details.
* **Exclusions**: Invalid legs are marked via `shapeDistanceLegValid` on the trip object and excluded from speed buckets and shape-crossing arrival interpolation.

## SpeedGraphBuilder & Processing Logic (`speed-graph.mjs`)

**`speed-graph.mjs`**'s `SpeedGraphBuilder` class processes vehicle feeds and builds the speed graph.

* **Progress Calculation**: Trip resolution and along-route progress are computed in `resolveSample` using reported destination-stop `shape_dist_traveled - stop_distance`.
* **Arrival Classification**: Feed series between two stops are classified using `classifyDuration` into performance categories (`very_slow`, `slow`, `normal`, `fast`) depending on how well the vehicle kept to the schedule.
* **Bucket Aggregation**: Speeds are aggregated into every crossed **20m along-route bucket** (`bucketSizeMeters = 20`) via `collectSpeedBucketSamples` and `addSpeedSample`.
* **Speed Timing**: `getSpeedCalculation` always uses the full vehicle-timestamp interval for speed calculations (halving times when door_open=true is present is dropped because door_open transitions seems to instantly trigger a feed update).
* **Non-Stopping Windows**: Crossings with no door-open observation within **+/-20 seconds** are tracked via `getStopCrossings`, `addNonStoppingWindow`, `collectNonStoppingWindowSamples`, and `finalizeNonStoppingWindows` to produce a parallel non-stopping bucket subset.
* **Waiting Aggregation**: Open-door waiting contributions are collected and aggregated via `collectWaiting`, `addWaitingContribution`, `flushWaiting`, and `addWaiting`.

----
## Anomaly Corrections (`speed-graph.mjs`, `gps-drift-filter.mjs`)

Before graph calculations, the builder stages up to (**12**) feeds per vehicle in a shared lookback buffer (`gpsDriftLookbackFeeds`).

### 1. GPS-Drift Scoring & Feed Rejection (`speed-graph.mjs`, `gps-drift-filter.mjs`)
* Scores are computed by `stageGpsDriftSample` using penalties from `getGpsDriftPenalties`:
  * **GPS-derived speed**: Evaluated via `linearPenalty` starting at 25 m/s up to 40 m/s.
  * **Absolute acceleration**: Evaluated via `linearPenalty` starting at 5 m/s² up to 10 m/s².
  * **Stop-sequence changes**: Penalized by sequence increments (`+20`) and decrements (`+80`).
  * **Backward progress**: Calculated via `getNegativeProgressPenalty` for negative progress beyond 10 meters.
* Historical scores are decayed using `applyGpsDriftScoreDecay` with a decay factor of `gpsDriftScoreDecay` (0.5) and ceiling `gpsDriftHistoricalScoreCeiling` (130).
* If a score exceeds `gpsDriftScoreThreshold` (**100**), the feed is rejected and preceding entries are rechecked via `recheckGpsDriftEntry`. Rejections and back-propagated penalties are processed and drained via `drainOldestGpsDriftSample`.
* Logged as "GPS-drift score rejected feed".

### 2. Stationary Stale GPS Recovery (`speed-graph.mjs`)
* In case of GPS signal lost, stale locations may be reported before receiving accurate location which leads to sudden jumps.
* The code detects stationary gaps using `getPendingStationaryGpsRun` and validates recovery movement via `getStationaryGpsRecovery`. Stale closed-door samples are merged out when recovery criteria are met and logged as `GPS signal lost detected`.
* Logged as "GPS signal lost detected (inferred from stale-position recovery)".

### 3. Delayed `stop_distance` Updates (`speed-graph.mjs`)
* The feed provider sometimes delays the calculation of `stop_distance` which leads to incorrect speed values.
* These occurences are identified by `isDelayedStopDistanceCandidate` and processed/flushed via `flushPendingDelayedStopDistanceSamples`.
* When GPS movement exceeds thresholds it doesn't recalculates the `stop_distance`-s, instead it merges them (dropping the invalid feeds).
* Logged as "Delayed stop_distance update detected".

### 4. Next-Stop `stop_distance` Recalculation (`speed-graph.mjs`)
* Delayed `stop_distance` updates can also occur when a feed's "next stop" changes, leaving the reported `stop_distance` based on the previous feed's location.
* Managed by `correctNextStopDistance` to rebase stop distance when a trip's next stop changes and the current feed has closed doors.
* If this recalculation differs from the reported value by more than 50 m, the correction remains active for later feeds, including updates more than five seconds apart and feeds received while doors are open. An active correction also carries across a forward next-stop change when the intervening shape legs are valid, using the prior corrected distance, shape-distance delta, and GPS movement to rebase the new stop pair. A report within 20 m is accepted for that feed but does not clear the correction; it is cleared when the trip changes or the next-stop transition cannot be validated.
* If the corrected `stop_distance` differs from the reported value by 50 m or less, the correction is held unapplied during a two distinct feed grace window. A later same-stop report confirms the correction if it differs from the predicted trajectory by more than 50 m, or if valid GPS shape projections place every candidate correction within 20 m while at least one raw report is farther away. On confirmation, all buffered grace-window samples are recalculated together; otherwise, the candidates are discarded when the window expires and reported distances remain unchanged.
* Feeds awaiting staged processing while a stop-sequence regression is confirmed or quarantined defer correction. After recovery, accepted feeds replay corrections in order from the last accepted feed, with a one-feed lookahead so corrections that revise the predecessor run before it is committed; rejected feeds never become correction anchors.
* Logged as "Next-stop stop_distance recalculated".

### 5. Short-Interval `stop_distance` Recalculation (`speed-graph.mjs`)
* Due to the feed provider sometimes delaying the calculation of the `stop_distance`, we may experience a sudden, extreme drop over a short time window (< 8 seconds), implying an impossible speed spike (> 35 m/s). This happens because the previous sample reported a stale, heavily inflated distance that abruptly corrected itself.
* Handled by `correctShortIntervalStopDistance`, which recalculates the previous sample's reported stop distance using shape projections. If both reports are above their shape-derived distances, the current report is still materially off but closer to shape, and the projected movement is forward, both samples are recalculated from their own projections. Corrections require valid projections on the same stop leg and consistent reconstructed distances; pairs of eight seconds or more are rejected. If the immediately preceding feed repeats the same stale distance, its `stop_distance` is also recalculated (rechecking earlier feeds are needed because the error correction is triggered by sudden `stop_distance` change which might not be present in the previous feed).
* If GPS is too far from the reported stop's shape leg but both samples project consistently onto the downstream leg, the correction is held tentative. Two later, distinct, forward GPS fixes must confirm that trajectory; a return to the earlier leg or inconsistent movement discards the candidate. On confirmation, buffered samples are rebased to that downstream stop and their distances and progress are recalculated together.
* Logged as "Short-interval stop_distance reconciled".
* As a separate low-cost fallback, repeated identical stale observations are corrected only after a later stop-distance report persists on a distinct GPS fix. The updated reports and reconstructed stale distance must agree with direct GPS-to-stop distances; the stale copies are adjusted using GPS displacement, with no speed threshold or shape projection. This is logged as "Repeated stale stop_distance corrected after a persistent update".

### 6. Early Zero `stop_distance` Correction (`speed-graph.mjs`)
* The feed provider may report zero `stop_distance` before the vehicle actually reaching the stop. This could happen from snapping or the vehicle opening its doors before the stop due to being unable to pull into the stop. False `stop_distance=0` values lead to incorrect speed calculations so they have to be corrected.
* Positive-to-zero `stop_distance` transitions (regardless of implied speed) treated as near-stop snaps if GPS fixes are within **100 m** of the scheduled stop and closure agrees with GPS displacement within **10 m or 20%**. 
* **Open-Door Zero Distance Handling**: Managed by `correctDoorOpenStopDistance` to correct zero reported distances using GPS-to-stop proximity checks and candidate speed thresholds. When a valid same-leg shape projection is available and the previous closed-door report matches its projection, the current open-door zero is recalculated from shape instead. Logged as "Early door_open zero stop_distance corrected".
* Both open-door and closed-door corrections that adjust a preceding feed also correct matching same-timestamp GPS duplicates, so a buffered graph baseline cannot retain a stale distance.
* Shape-backed zero corrections stay active for later feeds at the same trip and stop, recalculating each feed from its valid shape projection. The correction clears when the reported `stop_distance` is within 20 m of that projection, or the trip/stop changes. Logged as "Persistent shape-based stop_distance correction".
* The open-door correction does not overwrite a preceding feed already recalculated by correction #4; correction #4 continues through door-open feeds for the same next stop.
* **Closed-Door Zero Distance Snaps**: Managed by `correctClosedDoorStopDistanceSnap` to correct positive-to-zero distance drops when GPS fixes are within range and closure agrees with movement. A direct GPS snap is not applied when the previous feed was a corrected zero, its corrected distance agrees with a valid shape projection, but its straight-line distance to the stop contradicts that projection. For a drop from at least 200 m to zero that fails the direct-distance check, a valid shape leg can instead correct only the zero-distance feed when the previous report agrees with its shape projection and projected movement agrees with GPS movement. Logged as "Closed-door zero stop_distance snap corrected" or "Closed-door zero stop_distance recalculated from shape".

### 7. Backward Stop Sequence Quarantine (`speed-graph.mjs`)
* GPS boundary bouncing or manual accidental premature advance then manual rollback could cause invalid `next_stop` values in the feed.
* Quarantines vehicles moving backward in stop sequence using `startStopSequenceRegression`, invalidating feeds via `invalidateStopSequenceRegressionFeed`, and resuming via `recoverStopSequenceRegression` and `validateStopDistanceWithGps`. Quarantined feeds contribute no data; an unchanged repeat of the last rejected observation cannot recover the sequence, and the first validated feed ends quarantine as a new baseline.
* Logged as "Stop-sequence regression".

### 8. Backward Vehicle-Timestamp Rejection (`speed-graph.mjs`)
* Rejects feeds that arrive with a vehicle timestamp older than the current baseline. This prevents stale states from corrupting distance or speed calculations.
* Checked in `processFeed` before any correction; rejected samples are excluded.
* Logged as "Backward-timestamp feed rejected".

### 9. GPS-Based Zero `stop_distance` After Next-Stop Change (`speed-graph.mjs`)
* Addresses a provider glitch where a next-stop change combined with corrupted GTFS shape distances (`shape_dist_traveled`) causes the feed to report an erroneous zero `stop_distance` even though GPS shows the vehicle is still far away. This issue lasts until `next_stop` is reached).
* When triggered during a closed-door next-stop change, `correctGpsBasedNextStopZeroDistance` uses shape geometry to calculate the true distance. It also takes into account the corrupted `shape_dist_traveled` to prevent false jumps during speed calculation. To activate, the stop_distance error must be more than **50 m**.
* Subsequent `stop_distance=0` feeds are corrected until the next stop changes, or backward stop sequence quarantine begins (7th anomaly correction).
* Rejects subsequent stop_distance=0 feeds that fail geometric validation, preserving the previous valid baseline.
* Logged as "GPS-based next-stop zero stop_distance corrected".

## Output

* **Diagnostics & Logging**: Feed-to-feed speeds **> 35 m/s** are logged as detected (alongside timestamp rejections, GPS-based next-stop corrections, GPS-loss, delayed stop distance, door corrections, and sensor anomalies). During TTY runs, logs use the scrolling region above the status footer.
* **Completion Output**: Prints overall and per-class bucket sample counts, mean/median samples per populated bucket, and bucket distributions by sample ranges (`1`, `2–4`, `5–9`, `10–24`, and `25+`).
* Also reports approximate median and 95th-percentile speeds using **0.5 m/s histogram bins**, exact maximum speed, classified/unclassified/pending legs, rejected observations/samples/pairs, and open-door wait coverage.

## CLI Usage & Options

* **Run with defaults**:
```sh
node realtime-oversampler/oversample.mjs
```

* **Specify recorder directory**:
```sh
node realtime-oversampler/oversample.mjs /path/to/realtime
```

* **Limit archives and messages, or skip to a feed range** (`--max-archives`, `--max-messages`, and `--skip-messages` accept `0`):
```sh
node realtime-oversampler/oversample.mjs /path/to/realtime \
  --max-archives 2 --skip-messages 300 --max-messages 5
```
`--skip-messages` skips that many archive entries across selected archives without protobuf decoding.
`--max-messages` then limits the number of messages processed after the skip.

* **Display decoded messages** (options: `none` [default], `first-and-last`, `all`):
```sh
node realtime-oversampler/oversample.mjs /path/to/realtime --display-messages all
```

* **Inspect a speed outlier** (use an archive path or a name in `recorded-content/`; speed values match the displayed one-decimal value, or use `max`):
```sh
node realtime-oversampler/analyze-speed-outlier.mjs \
  2026-10-06T11.tar.gz max 10 10
```
The last two arguments specify archive feed messages before and after the outlier's current feed.
The report includes transition and GPS delta/speed details, plus a vehicle-only table with shape
offsets, GPS-derived stop distance and next stop, and graph disposition. Rejected observations and
feed pairs are labeled; raw values remain visible. Stale-GPS feeds that were dropped and bridged
are marked too.

* **Export graph and health summary**:
```sh
node realtime-oversampler/oversample.mjs recorded-content \
  --output realtime-oversampler/output/speed-location-graph.msgpack
```
*(Created only if it doesn't already exist. Uses vendored `@msgpack/msgpack` 3.1.3 UMD build in `scripts/external/`; no npm install required.)*

## Output Data Structure & Decoding

The exported MessagePack document contains `version`, `trafficClasses`, `stopIds`, `routeIds`, `stopPairs`, `waits`, `summary`, and `source` fields.

* `stopPairs` row format: `[fromStopIndex, toStopIndex, classes, nonStoppingClasses]`
* Class row format: `[trafficClassIndex, buckets]` where each bucket is `[20mBucketIndex, sampleCount, speedSumMps]`
* Average bucket speed: `speedSumMps / sampleCount`
* `waits` row format: `[routeIndex, stopIndex, trafficClassIndex, sampleCount, totalSeconds]`

**Decoding in Node.js**:

```js
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { decode } = createRequire(import.meta.url)(
  './scripts/external/msgpack.min.js'
);
const graph = decode(await readFile('realtime-oversampler/output/speed-location-graph.msgpack'));
```
