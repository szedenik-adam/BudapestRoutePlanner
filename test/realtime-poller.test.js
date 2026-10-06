import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
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

async function createOutputDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bprp-realtime-poller-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readArchiveEntries(archivePath) {
  const tar = gunzipSync(await readFile(archivePath));
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
  const tarContents = gunzipSync(await readFile(archivePath));
  await writeFile(tarPath, Buffer.concat([
    tarContents.subarray(0, tarContents.length - 1024),
    Buffer.alloc(200, 0x41)
  ]));
  await unlink(archivePath);

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
