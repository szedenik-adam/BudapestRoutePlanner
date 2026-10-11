import assert from 'node:assert/strict';
import test from 'node:test';
import { StatusDisplay } from '../realtime-oversampler/status-display.mjs';

function createSpeedGraph() {
  return {
    speedGraph: { size: 1 },
    routeStopWaitCount: 2,
    lastUpdatedPair: {
      fromStopId: 'A',
      toStopId: 'B',
      classes: new Map([
        ['normal', new Map([[0, { sampleCount: 2, speedSumMps: 10 }]])]
      ]),
      nonStoppingClasses: new Map([
        ['normal', new Map([[0, { sampleCount: 1, speedSumMps: 8 }]])]
      ])
    }
  };
}

test('renders live status frames in place with bucket state', () => {
  const writes = [];
  const output = {
    isTTY: true,
    columns: 100,
    rows: 24,
    write: (text) => writes.push(text)
  };
  const status = new StatusDisplay({
    totalFiles: 3,
    totalBytes: 2_000_000,
    speedGraph: createSpeedGraph(),
    output
  });

  status.start();
  status.beginFile('hour.tar.gz', 1_000_000);
  status.updateFileBytes(500_000);
  status.incrementMessages();
  status.render();
  status.stop({ finished: true });

  const frames = writes.filter((text) => text.includes('Speed-location graph:'));
  assert.equal(frames.length, 4);
  assert.ok(writes.includes('\u001b[1;8r\u001b[8;1H'));
  assert.ok(writes.includes('\u001b[r\u001b[24;1H\r\n\u001b[?25h'));
  assert.ok(frames.every((text) => !text.endsWith('\n')));
  assert.ok(frames.every((text) => text.startsWith('\u001b[9;1H')));
  assert.ok(frames.every((text) => text.endsWith('\u001b[8;1H')));
  assert.ok(frames.every((text) => !text.includes('\u001b[2J')));
  assert.ok(frames.every((text) => text.includes('Processed files: 0 / 3')));
  assert.ok(frames.at(-1).includes('Processed MB: 0.5 MB / 2.0 MB'));
  assert.ok(frames.at(-1).includes('Processed PB messages: 1'));
  assert.ok(frames.at(-1).includes('Created stop-pairs: 1'));
  assert.ok(frames.at(-1).includes('Created route-stop waits: 2'));
  assert.match(frames.at(-1), /Node CPU: (?:--|\d+\.\d+%) \| RAM \(RSS\): \d+\.\d MB/);
  assert.ok(frames.at(-1).includes('Buckets (average speed m/s; sample count in parentheses) for A -> B'));
  assert.ok(frames.at(-1).includes('0m:5.0(2)'));
  assert.ok(frames.at(-1).includes('normal no-stop +/-20s: 0m:8.0(1)'));
});

test('prints only one final status snapshot when output is not a TTY', () => {
  const writes = [];
  const status = new StatusDisplay({
    totalFiles: 0,
    totalBytes: 0,
    speedGraph: createSpeedGraph(),
    output: { isTTY: false, write: (text) => writes.push(text) }
  });

  status.start();
  status.incrementMessages();
  status.stop({ finished: true });

  assert.equal(writes.length, 1);
  assert.ok(writes[0].includes('Processed PB messages: 1'));
  assert.match(writes[0], /Node CPU: (?:--|\d+\.\d+%) \| RAM \(RSS\): \d+\.\d MB/);
});

test('writes live log lines in the scrolling region above the status footer', () => {
  const writes = [];
  const status = new StatusDisplay({
    totalFiles: 1,
    totalBytes: 1_000,
    speedGraph: createSpeedGraph(),
    output: {
      isTTY: true,
      columns: 100,
      rows: 24,
      write: (text) => writes.push(text)
    }
  });

  status.start();
  status.log('GPS signal lost detected\n  vehicle id=7703');
  status.stop({ finished: true });

  const logWrite = writes.find((text) => text.includes('GPS signal lost detected'));
  assert.equal(
    logWrite,
    '\u001b[8;1HGPS signal lost detected\n  vehicle id=7703\n\u001b[8;1H'
  );
});

test('keeps the status footer height fixed as bucket classes populate', () => {
  const writes = [];
  const speedGraph = createSpeedGraph();
  const status = new StatusDisplay({
    totalFiles: 1,
    totalBytes: 1_000,
    speedGraph,
    output: {
      isTTY: true,
      columns: 100,
      rows: 24,
      write: (text) => writes.push(text)
    }
  });

  status.start();
  speedGraph.lastUpdatedPair = null;
  status.render();
  const pair = createSpeedGraph().lastUpdatedPair;
  pair.classes = new Map(
    ['fast', 'normal', 'slow', 'very_slow'].map((trafficClass) => [
      trafficClass,
      new Map([[0, { sampleCount: 1, speedSumMps: 10 }]])
    ])
  );
  pair.nonStoppingClasses = new Map(
    ['fast', 'normal', 'slow', 'very_slow'].map((trafficClass) => [
      trafficClass,
      new Map([[0, { sampleCount: 1, speedSumMps: 8 }]])
    ])
  );
  speedGraph.lastUpdatedPair = pair;
  status.render();
  status.stop({ finished: true });

  const frames = writes.filter((text) => text.includes('Speed-location graph:'));
  assert.equal(frames.length, 4);
  assert.deepEqual(
    frames.map((text) => (text.match(/\r\u001b\[2K/g) ?? []).length),
    [16, 16, 16, 16]
  );
});
