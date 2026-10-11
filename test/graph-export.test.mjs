import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { encodeGraphExport } from '../realtime-oversampler/graph-export.mjs';

const require = createRequire(import.meta.url);
const { decode } = require('../scripts/external/msgpack.min.js');

test('encodes speed buckets, waits, summary, and source metadata', () => {
  const speedGraph = {
    speedGraph: new Map([[
      '["A","B"]',
      {
        fromStopId: 'A',
        toStopId: 'B',
        classes: new Map([[
          'fast',
          new Map([
            [20, { sampleCount: 1, speedSumMps: 8.5 }],
            [0, { sampleCount: 2, speedSumMps: 11 }]
          ])
        ]]),
        nonStoppingClasses: new Map([[
          'fast',
          new Map([[20, { sampleCount: 1, speedSumMps: 8.5 }]])
        ]])
      }
    ]]),
    waitingGraph: new Map([[
      'R1',
      new Map([[
        'A',
        new Map([['fast', { sampleCount: 2, totalSeconds: 7.5 }]])
      ]])
    ]])
  };
  const summary = { directedStopPairs: 1, speedBuckets: 2 };
  const document = decode(encodeGraphExport(speedGraph, summary, {
    archiveFiles: ['feeds.tar.gz'],
    decodedMessages: 12
  }));

  assert.equal(document.version, 1);
  assert.deepEqual(document.trafficClasses, ['very_slow', 'slow', 'normal', 'fast']);
  assert.deepEqual(document.stopIds, ['A', 'B']);
  assert.deepEqual(document.routeIds, ['R1']);
  assert.deepEqual(document.stopPairs, [[
    0,
    1,
    [[3, [[0, 2, 11], [20, 1, 8.5]]]],
    [[3, [[20, 1, 8.5]]]]
  ]]);
  assert.deepEqual(document.waits, [[0, 0, 3, 2, 7.5]]);
  assert.deepEqual(document.summary, summary);
  assert.deepEqual(document.source, {
    archiveFiles: ['feeds.tar.gz'],
    decodedMessages: 12
  });
});
