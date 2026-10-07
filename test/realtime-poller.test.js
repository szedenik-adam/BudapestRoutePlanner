import assert from 'node:assert/strict';
import { deflateRawSync, gunzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  HourlyArchiveWriter,
  appendChangedResponse,
  loadLastResponseHash,
  pollOnce,
  pruneOldRecords
} from '../realtime-recorder/realtime-poller.mjs';
import { ensureTimetablesForDate } from '../realtime-recorder/timetable-sync-worker.mjs';

async function createOutputDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bprp-realtime-poller-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readArchiveEntries(archivePath) {
  let archiveData;
  let sourcePath = archivePath;
  try {
    archiveData = await readFile(sourcePath);
  } catch (error) {
    if (error.code !== 'ENOENT' || !archivePath.endsWith('.tar.gz')) throw error;
    sourcePath = archivePath.slice(0, -3);
    archiveData = await readFile(sourcePath);
  }
  const tar = archiveData[0] === 0x1f && archiveData[1] === 0x8b
    ? gunzipSync(archiveData)
    : archiveData;
  const entries = [];
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, ''), 8);
    const bodyStart = offset + 512;
    entries.push({ name, body: tar.subarray(bodyStart, bodyStart + size) });
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZipFile(name, content) {
  const filename = Buffer.from(name);
  const body = Buffer.from(content);
  const compressed = deflateRawSync(body);
  const checksum = crc32(body);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(body.length, 22);
  localHeader.writeUInt16LE(filename.length, 26);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(body.length, 24);
  centralHeader.writeUInt16LE(filename.length, 28);
  const centralDirectory = Buffer.concat([centralHeader, filename]);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localHeader.length + filename.length + compressed.length, 16);

  return Buffer.concat([localHeader, filename, compressed, centralDirectory, endRecord]);
}

test('writes changed response bytes as timestamp-named tar entries', async (t) => {
  const outputDirectory = await createOutputDirectory(t);
  const archiveWriter = new HourlyArchiveWriter(outputDirectory);
  const body = Buffer.from([0x0a, 0x03, 0x61, 0x62, 0x63]);
  const timestamp = '2026-10-06T10:00:00.000Z';
  const saved = await appendChangedResponse({
    outputDirectory,
    archiveWriter,
    body,
    timestamp,
    lastHash: null
  });
  await archiveWriter.close();

  assert.equal(saved.changed, true);
  assert.equal(path.basename(saved.outputFile), '2026-10-06T10.tar.gz');
  assert.ok((await readdir(outputDirectory)).includes('2026-10-06T10.tar'));
  const entries = await readArchiveEntries(saved.outputFile);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, '2026-10-06T10-00-00.000Z.pb');
  assert.deepEqual(entries[0].body, body);
  assert.equal(await loadLastResponseHash(outputDirectory), saved.hash);
});

test('does not append an unchanged response', async (t) => {
  const outputDirectory = await createOutputDirectory(t);
  const archiveWriter = new HourlyArchiveWriter(outputDirectory);
  const first = await appendChangedResponse({
    outputDirectory,
    archiveWriter,
    body: Buffer.from('same protobuf payload'),
    timestamp: '2026-10-06T10:00:00.000Z',
    lastHash: null
  });
  const second = await appendChangedResponse({
    outputDirectory,
    archiveWriter,
    body: Buffer.from('same protobuf payload'),
    timestamp: '2026-10-06T10:00:05.000Z',
    lastHash: first.hash
  });
  await archiveWriter.close();

  assert.equal(second.changed, false);
  assert.equal((await readArchiveEntries(first.outputFile)).length, 1);
});

test('polls the vehicle-position endpoint and records only changed response bodies', async (t) => {
  const outputDirectory = await createOutputDirectory(t);
  const archiveWriter = new HourlyArchiveWriter(outputDirectory);
  const body = Buffer.from('vehicle-position protobuf');
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(new URL(url).searchParams.get('key'), 'test key');
    assert.equal(options.headers.accept, 'application/x-protobuf');
    return new Response(body, {
      headers: { 'content-type': 'application/x-protobuf' }
    });
  };

  const first = await pollOnce({
    apiKey: 'test key',
    outputDirectory,
    archiveWriter,
    lastHash: null,
    fetchImpl
  });
  const second = await pollOnce({
    apiKey: 'test key',
    outputDirectory,
    archiveWriter,
    lastHash: first.hash,
    fetchImpl
  });
  await archiveWriter.close();

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(calls, 2);
  assert.equal((await readArchiveEntries(first.outputFile)).length, 1);
});

test('rotates archives by UTC hour', async (t) => {
  const outputDirectory = await createOutputDirectory(t);
  const archiveWriter = new HourlyArchiveWriter(outputDirectory);
  const first = await appendChangedResponse({
    outputDirectory,
    archiveWriter,
    body: Buffer.from('first'),
    timestamp: '2026-10-06T10:59:59.000Z',
    lastHash: null
  });
  const second = await appendChangedResponse({
    outputDirectory,
    archiveWriter,
    body: Buffer.from('second'),
    timestamp: '2026-10-06T11:00:01.000Z',
    lastHash: first.hash
  });
  await archiveWriter.close();

  assert.notEqual(first.outputFile, second.outputFile);
  assert.equal(path.basename(first.outputFile), '2026-10-06T10.tar.gz');
  assert.equal(path.basename(second.outputFile), '2026-10-06T11.tar.gz');
});

test('resumes an existing compressed archive after restart', async (t) => {
  const outputDirectory = await createOutputDirectory(t);
  const firstWriter = new HourlyArchiveWriter(outputDirectory);
  const first = await appendChangedResponse({
    outputDirectory,
    archiveWriter: firstWriter,
    body: Buffer.from('first protobuf'),
    timestamp: '2026-10-06T10:00:00.000Z',
    lastHash: null
  });
  await firstWriter.close();

  const secondWriter = new HourlyArchiveWriter(outputDirectory);
  const second = await appendChangedResponse({
    outputDirectory,
    archiveWriter: secondWriter,
    body: Buffer.from('second protobuf'),
    timestamp: '2026-10-06T10:30:00.000Z',
    lastHash: first.hash
  });
  await secondWriter.close();

  const entries = await readArchiveEntries(second.outputFile);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.body.toString()), ['first protobuf', 'second protobuf']);
});

test('discards an incomplete tar entry when resuming an archive', async (t) => {
  const outputDirectory = await createOutputDirectory(t);
  const firstWriter = new HourlyArchiveWriter(outputDirectory);
  const first = await appendChangedResponse({
    outputDirectory,
    archiveWriter: firstWriter,
    body: Buffer.from('complete protobuf'),
    timestamp: '2026-10-06T10:00:00.000Z',
    lastHash: null
  });
  await firstWriter.close();

  const archivePath = first.outputFile;
  const tarPath = archivePath.slice(0, -3);
  const tarContents = await readFile(tarPath);
  await writeFile(tarPath, Buffer.concat([
    tarContents.subarray(0, tarContents.length - 1024),
    Buffer.alloc(200, 0x41)
  ]));

  const secondWriter = new HourlyArchiveWriter(outputDirectory);
  const second = await appendChangedResponse({
    outputDirectory,
    archiveWriter: secondWriter,
    body: Buffer.from('next protobuf'),
    timestamp: '2026-10-06T10:30:00.000Z',
    lastHash: first.hash
  });
  await secondWriter.close();

  const entries = await readArchiveEntries(second.outputFile);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.body.toString()), ['complete protobuf', 'next protobuf']);
});

test('retains the current 30 UTC days and prunes older archives', async (t) => {
  const outputDirectory = await createOutputDirectory(t);
  for (const name of ['2026-09-06T12.tar.gz', '2026-09-07T11.tar', 'notes.txt']) {
    await writeFile(path.join(outputDirectory, name), '');
  }

  const removed = await pruneOldRecords(outputDirectory, new Date('2026-10-06T12:00:00.000Z'));
  const remaining = (await readdir(outputDirectory)).sort();

  assert.equal(removed, 1);
  assert.deepEqual(remaining, ['2026-09-07T11.tar', 'notes.txt']);
});

test('checks common timetable only when acquiring a missing day timetable', async (t) => {
  const outputDirectory = await createOutputDirectory(t);
  const localDirectory = path.join(outputDirectory, 'generated');
  await mkdir(localDirectory);
  const date = '2026-10-06';
  const dayNumber = Math.round(
    (Date.parse(`${date}T00:00:00.000Z`) - Date.UTC(2000, 0, 1)) / 86_400_000
  );
  await writeFile(path.join(localDirectory, `${dayNumber}.json`), '{"day":1}');
  const commonV1 = createZipFile('common.json', '{"version":1}');
  const commonV2 = createZipFile('common.json', '{"version":2}');
  await writeFile(path.join(localDirectory, 'common.json.zip'), commonV1);
  let remoteCommon = commonV1;
  let requests = 0;
  const fetchImpl = async () => {
    requests++;
    return new Response(remoteCommon);
  };
  const options = {
    date,
    outputDirectory,
    localDirectories: [localDirectory],
    remoteBaseUrl: 'https://example.test/timetable/',
    fetchImpl
  };

  await ensureTimetablesForDate(options);
  remoteCommon = commonV2;
  await writeFile(path.join(localDirectory, 'common.json.zip'), commonV2);
  const nextHour = await ensureTimetablesForDate(options);
  const files = (await readdir(outputDirectory)).sort();

  assert.equal(requests, 1);
  assert.equal(nextHour.commonPath, null);
  assert.deepEqual(files.filter((name) => name.includes('-common')), [
    '2026-10-06-common.json.zip'
  ]);
});

test('retries common timetable retrieval if it failed before storing the day timetable', async (t) => {
  const outputDirectory = await createOutputDirectory(t);
  const date = '2026-10-06';
  const dayNumber = Math.round(
    (Date.parse(`${date}T00:00:00.000Z`) - Date.UTC(2000, 0, 1)) / 86_400_000
  );
  const dayZip = createZipFile(`${dayNumber}.json`, '{"day":1}');
  const commonZip = createZipFile('common.json', '{"version":1}');
  let commonRequests = 0;
  const fetchImpl = async (url) => {
    if (new URL(url).pathname.endsWith('common.json.zip')) {
      commonRequests++;
      if (commonRequests === 1) return new Response('failed', { status: 500 });
      return new Response(commonZip);
    }
    return new Response(dayZip);
  };
  const options = {
    date,
    outputDirectory,
    localDirectories: [],
    remoteBaseUrl: 'https://example.test/timetable/',
    fetchImpl
  };

  await assert.rejects(ensureTimetablesForDate(options), /HTTP 500/);
  const afterFailure = await readdir(outputDirectory);
  assert.ok(!afterFailure.includes(`${date}-${dayNumber}.json.zip`));

  const result = await ensureTimetablesForDate(options);
  assert.equal(commonRequests, 2);
  assert.equal(path.basename(result.dayPath), `${date}-${dayNumber}.json.zip`);
  assert.equal(path.basename(result.commonPath), `${date}-common.json.zip`);
});
