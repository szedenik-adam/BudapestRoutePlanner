#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';

export const POLL_INTERVAL_MS = 5_000;
export const RETENTION_DAYS = 30;
export const VEHICLE_POSITIONS_URL = 'https://go.bkk.hu/api/query/v1/ws/gtfs-rt/full/VehiclePositions.pb';

const STATE_FILE = '.last-response-sha256';
const REQUEST_TIMEOUT_MS = 10_000;
const TAR_BLOCK_SIZE = 512;
const TAR_TRAILER_SIZE = TAR_BLOCK_SIZE * 2;
const TAR_TRAILER = Buffer.alloc(TAR_TRAILER_SIZE);

function getLocalTimetableDirectories() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repositoryDirectory = path.resolve(scriptDirectory, '..', 'timetable-generator', 'budapest');
  const currentDirectory = path.resolve(process.cwd(), 'timetable-generator', 'budapest');
  const configuredDirectory = process.env.GTFS_TIMETABLE_SOURCE_DIR;
  const candidates = [
    configuredDirectory && path.resolve(configuredDirectory, 'timetable'),
    configuredDirectory && path.resolve(configuredDirectory),
    path.join(repositoryDirectory, 'timetable'),
    repositoryDirectory,
    path.join(currentDirectory, 'timetable'),
    currentDirectory
  ].filter(Boolean);
  return [...new Set(candidates)];
}

function getDefaultOutputDirectory() {
  const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
  return path.resolve(
    process.env.REALTIME_DATA_DIR ||
    path.join(dataHome, 'budapest-route-planner', 'realtime')
  );
}

export class TimetableAcquisitionWorker {
  constructor(outputDirectory, {
    localDirectories = getLocalTimetableDirectories(),
    remoteBaseUrl = process.env.GTFS_TIMETABLE_URL || 'https://bprp.pages.dev/timetable/'
  } = {}) {
    this.closed = false;
    this.worker = new Worker(new URL('./timetable-sync-worker.mjs', import.meta.url), {
      workerData: { outputDirectory, localDirectories, remoteBaseUrl }
    });
    this.worker.on('message', (message) => {
      if (message.type === 'complete') {
        const commonUpdate = message.commonPath ? `; saved ${message.commonPath}` : '';
        console.info(`Timetable ready for ${message.date}: ${message.dayPath}${commonUpdate}`);
      } else if (message.type === 'error') {
        console.error(`Timetable retrieval failed for ${message.date}: ${message.message}`);
      }
    });
    this.worker.on('error', (error) => {
      console.error(`Timetable worker failed: ${error.message}`);
    });
    this.worker.on('exit', (code) => {
      if (!this.closed && code !== 0) {
        console.error(`Timetable worker exited with status ${code}`);
      }
    });
  }

  ensureForHour(hour) {
    if (this.closed) return;
    const request = { type: 'ensure', hour, date: `${hour.slice(0, 10)}` };
    try {
      this.worker.postMessage(request);
    } catch (error) {
      console.error(`Could not queue timetable retrieval for ${request.date}: ${error.message}`);
    }
  }

  async close() {
    this.closed = true;
    await this.worker.terminate();
  }
}

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

function utcHour(date) {
  return date.toISOString().slice(0, 13);
}

function getOldestRetainedDay(now, retentionDays) {
  const oldestDate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - retentionDays + 1
  ));
  return utcDay(oldestDate);
}

function writeTarOctal(header, offset, length, value) {
  const encoded = `${Math.trunc(value).toString(8).padStart(length - 1, '0')}\0`;
  if (encoded.length > length) throw new RangeError('Tar numeric field is too large');
  header.write(encoded, offset, length, 'ascii');
}

function makeTarHeader(name, size, timestamp) {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(name, 0, 100, 'utf8');
  writeTarOctal(header, 100, 8, 0o640);
  writeTarOctal(header, 108, 8, process.getuid?.() ?? 0);
  writeTarOctal(header, 116, 8, process.getgid?.() ?? 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, Math.floor(new Date(timestamp).getTime() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function parseTarOctal(field) {
  const value = field.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]*$/.test(value)) return null;
  const parsed = Number.parseInt(value || '0', 8);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isValidTarHeader(header) {
  const expectedChecksum = parseTarOctal(header.subarray(148, 156));
  if (expectedChecksum === null) return false;

  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of checksumHeader) checksum += byte;
  return checksum === expectedChecksum;
}

async function writeAllAt(fileHandle, buffer, position) {
  let written = 0;
  while (written < buffer.length) {
    const result = await fileHandle.write(
      buffer,
      written,
      buffer.length - written,
      position + written
    );
    if (result.bytesWritten === 0) throw new Error('Failed to write tar archive data');
    written += result.bytesWritten;
  }
}

async function recoverTarFile(tarPath) {
  const fileHandle = await open(tarPath, 'r+');
  try {
    const { size } = await fileHandle.stat();
    const header = Buffer.alloc(TAR_BLOCK_SIZE);
    let validEnd = 0;

    while (validEnd + TAR_BLOCK_SIZE <= size) {
      const { bytesRead } = await fileHandle.read(header, 0, TAR_BLOCK_SIZE, validEnd);
      if (bytesRead !== TAR_BLOCK_SIZE || header.every((byte) => byte === 0)) break;
      if (!isValidTarHeader(header)) break;

      const entrySize = parseTarOctal(header.subarray(124, 136));
      if (entrySize === null) break;
      const paddedSize = Math.ceil(entrySize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
      const nextOffset = validEnd + TAR_BLOCK_SIZE + paddedSize;
      if (nextOffset > size) break;
      validEnd = nextOffset;
    }

    const tailLength = size - validEnd;
    let hasValidTrailer = false;
    if (tailLength >= TAR_TRAILER_SIZE) {
      const trailer = Buffer.alloc(TAR_TRAILER_SIZE);
      const { bytesRead } = await fileHandle.read(trailer, 0, TAR_TRAILER_SIZE, validEnd);
      hasValidTrailer = bytesRead === TAR_TRAILER_SIZE && trailer.equals(TAR_TRAILER);
    }

    await fileHandle.truncate(validEnd);
    await writeAllAt(fileHandle, TAR_TRAILER, validEnd);
    return {
      validEnd,
      discardedBytes: hasValidTrailer ? tailLength - TAR_TRAILER_SIZE : tailLength
    };
  } finally {
    await fileHandle.close();
  }
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

export async function loadLastResponseHash(outputDirectory) {
  try {
    const hash = (await readFile(path.join(outputDirectory, STATE_FILE), 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`Invalid response hash in ${STATE_FILE}`);
    }
    return hash;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export class HourlyArchiveWriter {
  constructor(outputDirectory, { onHourOpened = null } = {}) {
    this.outputDirectory = outputDirectory;
    this.onHourOpened = onHourOpened;
    this.activeHour = null;
    this.tarPath = null;
    this.archivePath = null;
    this.fileHandle = null;
    this.validEnd = 0;
  }

  async openHour(hour) {
    const archivePath = path.join(this.outputDirectory, `${hour}.tar.gz`);
    const tarPath = path.join(this.outputDirectory, `${hour}.tar`);

    if (!(await fileExists(tarPath))) {
      if (await fileExists(archivePath)) {
        const temporaryTarPath = `${tarPath}.${process.pid}.tmp`;
        await pipeline(
          createReadStream(archivePath),
          createGunzip(),
          createWriteStream(temporaryTarPath, { mode: 0o600 })
        );
        await rename(temporaryTarPath, tarPath);
      } else {
        await writeFile(tarPath, TAR_TRAILER, { mode: 0o600 });
      }
    }

    const recovery = await recoverTarFile(tarPath);
    this.validEnd = recovery.validEnd;
    if (recovery.discardedBytes > 0) {
      console.warn(
        `Recovered ${path.basename(tarPath)} by discarding ${recovery.discardedBytes} incomplete trailing byte(s)`
      );
    }
    this.fileHandle = await open(tarPath, 'r+');
    this.activeHour = hour;
    this.tarPath = tarPath;
    this.archivePath = archivePath;
    this.onHourOpened?.(hour);
  }

  async append(body, timestamp) {
    const capturedAt = new Date(timestamp).toISOString();
    const hour = utcHour(new Date(capturedAt));

    if (this.activeHour !== hour || !this.fileHandle) {
      await this.finishActiveHour();
      await this.openHour(hour);
    }

    const tarName = `${capturedAt.replace(/:/g, '-')}.pb`;
    if (Buffer.byteLength(tarName) > 100) {
      throw new RangeError('Timestamped tar entry name exceeds the USTAR limit');
    }

    const responseBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const header = makeTarHeader(tarName, responseBody.length, capturedAt);
    const paddingSize = (TAR_BLOCK_SIZE - (responseBody.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    const entry = Buffer.concat([
      header,
      responseBody,
      Buffer.alloc(paddingSize),
      TAR_TRAILER
    ]);

    await this.fileHandle.truncate(this.validEnd);
    await writeAllAt(this.fileHandle, entry, this.validEnd);
    this.validEnd += header.length + responseBody.length + paddingSize;

    return this.archivePath;
  }

  async finishActiveHour({ compress = true } = {}) {
    if (!this.activeHour) return;

    if (this.fileHandle) {
      await this.fileHandle.truncate(this.validEnd);
      await writeAllAt(this.fileHandle, TAR_TRAILER, this.validEnd);
      await this.fileHandle.sync();
      await this.fileHandle.close();
      this.fileHandle = null;
    }

    if (compress) {
      const temporaryArchivePath = `${this.archivePath}.${process.pid}.tmp`;
      await pipeline(
        createReadStream(this.tarPath),
        createGzip(),
        createWriteStream(temporaryArchivePath, { mode: 0o600 })
      );
      await rename(temporaryArchivePath, this.archivePath);
      await unlink(this.tarPath);
    }

    this.activeHour = null;
    this.tarPath = null;
    this.archivePath = null;
    this.validEnd = 0;
  }

  async close() {
    await this.finishActiveHour({ compress: false });
  }
}

export async function appendChangedResponse({
  outputDirectory,
  archiveWriter,
  body,
  timestamp = new Date(),
  lastHash
}) {
  const responseBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const hash = createHash('sha256').update(responseBody).digest('hex');
  if (hash === lastHash) return { changed: false, hash };

  const capturedAt = new Date(timestamp).toISOString();
  await mkdir(outputDirectory, { recursive: true });
  if (!archiveWriter) throw new Error('An hourly archive writer is required');
  const outputFile = await archiveWriter.append(responseBody, capturedAt);

  const statePath = path.join(outputDirectory, STATE_FILE);
  const temporaryStatePath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryStatePath, `${hash}\n`, { mode: 0o600 });
  await rename(temporaryStatePath, statePath);

  return {
    changed: true,
    hash,
    outputFile,
    timestamp: capturedAt
  };
}

export async function pruneOldRecords(outputDirectory, now = new Date(), retentionDays = RETENTION_DAYS) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new RangeError('retentionDays must be a positive integer');
  }

  await mkdir(outputDirectory, { recursive: true });
  const oldestDay = getOldestRetainedDay(now, retentionDays);
  const entries = await readdir(outputDirectory, { withFileTypes: true });
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^(\d{4}-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3])\.tar(?:\.gz)?|\.ndjson)$/.exec(entry.name);
    if (!match) continue;

    const fileDate = new Date(`${match[1]}T00:00:00.000Z`);
    if (Number.isNaN(fileDate.getTime()) || utcDay(fileDate) !== match[1]) continue;
    if (match[1] < oldestDay) {
      await unlink(path.join(outputDirectory, entry.name));
      removed++;
    }
  }

  return removed;
}

async function fetchVehiclePositions(apiKey, shutdownSignal, fetchImpl) {
  const url = new URL(VEHICLE_POSITIONS_URL);
  url.searchParams.set('key', apiKey);
  const requestSignal = AbortSignal.any([
    shutdownSignal,
    AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  ]);
  const response = await fetchImpl(url, {
    headers: { accept: 'application/x-protobuf' },
    signal: requestSignal
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Vehicle positions request returned HTTP ${response.status}`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0) throw new Error('Vehicle positions response was empty');

  return {
    body,
    timestamp: new Date()
  };
}

export async function pollOnce({
  apiKey,
  outputDirectory,
  archiveWriter,
  lastHash,
  fetchImpl = fetch,
  shutdownSignal = new AbortController().signal
}) {
  const response = await fetchVehiclePositions(apiKey, shutdownSignal, fetchImpl);
  return appendChangedResponse({
    outputDirectory,
    archiveWriter,
    body: response.body,
    timestamp: response.timestamp,
    lastHash
  });
}

export async function runRealtimePoller({
  apiKey = process.env.REALTIME_API_KEY,
  outputDirectory = getDefaultOutputDirectory(),
  intervalMs = POLL_INTERVAL_MS,
  retentionDays = RETENTION_DAYS,
  fetchImpl = fetch
} = {}) {
  if (!apiKey) throw new Error('REALTIME_API_KEY must be set');
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new RangeError('intervalMs must be a positive integer');
  }
  if (typeof fetchImpl !== 'function') throw new Error('A Node.js fetch implementation is required');

  await mkdir(outputDirectory, { recursive: true });
  let lastHash = await loadLastResponseHash(outputDirectory);
  const timetableWorker = new TimetableAcquisitionWorker(outputDirectory);
  const archiveWriter = new HourlyArchiveWriter(outputDirectory, {
    onHourOpened: (hour) => timetableWorker.ensureForHour(hour)
  });
  let lastPrunedDay = '';
  const shutdown = new AbortController();
  const handleShutdown = () => shutdown.abort();
  process.once('SIGINT', handleShutdown);
  process.once('SIGTERM', handleShutdown);

  console.info(`Recording changed vehicle-position responses to ${outputDirectory}`);

  try {
    while (!shutdown.signal.aborted) {
      const startedAt = Date.now();
      const today = utcDay(new Date());
      if (today !== lastPrunedDay) {
        const removed = await pruneOldRecords(outputDirectory, new Date(), retentionDays);
        if (removed > 0) console.info(`Removed ${removed} expired recorder file(s)`);
        lastPrunedDay = today;
      }

      try {
        const result = await pollOnce({
          apiKey,
          outputDirectory,
          archiveWriter,
          lastHash,
          fetchImpl,
          shutdownSignal: shutdown.signal
        });
        lastHash = result.hash;
      } catch (error) {
        if (shutdown.signal.aborted) break;
        console.error(`[${new Date().toISOString()}] Poll failed: ${error.message}`);
      }

      const waitMs = Math.max(0, intervalMs - (Date.now() - startedAt));
      try {
        await delay(waitMs, undefined, { signal: shutdown.signal });
      } catch (error) {
        if (error.name !== 'AbortError') throw error;
      }
    }
  } finally {
    process.off('SIGINT', handleShutdown);
    process.off('SIGTERM', handleShutdown);
    try {
      await archiveWriter.close();
    } finally {
      await timetableWorker.close();
    }
  }

  console.info('Realtime poller stopped');
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runRealtimePoller().catch((error) => {
    console.error(`Realtime poller stopped: ${error.message}`);
    process.exitCode = 1;
  });
}
