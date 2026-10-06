import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { parentPort, workerData } from 'node:worker_threads';

const DAY_MS = 24 * 60 * 60 * 1000;
const EPOCH_DAY = Date.UTC(2000, 0, 1);
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 60_000;

function dayNumberForDate(date) {
  const dateMs = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(dateMs) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid timetable date: ${date}`);
  }
  return Math.round((dateMs - EPOCH_DAY) / DAY_MS);
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

export function extractZipEntry(zipData, expectedName) {
  const minimumEocdOffset = Math.max(0, zipData.length - 65_557);
  let eocdOffset = -1;
  for (let offset = zipData.length - 22; offset >= minimumEocdOffset; offset--) {
    if (zipData.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('Invalid ZIP: end-of-central-directory record not found');
  if (zipData.readUInt16LE(eocdOffset + 4) !== 0 || zipData.readUInt16LE(eocdOffset + 6) !== 0) {
    throw new Error('Multi-disk ZIP archives are not supported');
  }

  const entryCount = zipData.readUInt16LE(eocdOffset + 10);
  let directoryOffset = zipData.readUInt32LE(eocdOffset + 16);
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
    if (directoryOffset + 46 > zipData.length ||
        zipData.readUInt32LE(directoryOffset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory');
    }

    const flags = zipData.readUInt16LE(directoryOffset + 8);
    const method = zipData.readUInt16LE(directoryOffset + 10);
    const checksum = zipData.readUInt32LE(directoryOffset + 16);
    const compressedSize = zipData.readUInt32LE(directoryOffset + 20);
    const uncompressedSize = zipData.readUInt32LE(directoryOffset + 24);
    const nameLength = zipData.readUInt16LE(directoryOffset + 28);
    const extraLength = zipData.readUInt16LE(directoryOffset + 30);
    const commentLength = zipData.readUInt16LE(directoryOffset + 32);
    const localHeaderOffset = zipData.readUInt32LE(directoryOffset + 42);
    const nameOffset = directoryOffset + 46;
    const entryName = zipData.subarray(nameOffset, nameOffset + nameLength).toString('utf8');

    if (entryName.split('/').at(-1) === expectedName) {
      if ((flags & 1) !== 0) throw new Error(`Encrypted ZIP entry is not supported: ${entryName}`);
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
        throw new Error(`ZIP64 entry is not supported: ${entryName}`);
      }
      if (localHeaderOffset + 30 > zipData.length ||
          zipData.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error(`Invalid ZIP local header: ${entryName}`);
      }

      const localNameLength = zipData.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = zipData.readUInt16LE(localHeaderOffset + 28);
      const contentOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const contentEnd = contentOffset + compressedSize;
      if (contentEnd > zipData.length) throw new Error(`Truncated ZIP entry: ${entryName}`);

      const compressedData = zipData.subarray(contentOffset, contentEnd);
      let content;
      if (method === 0) {
        content = Buffer.from(compressedData);
      } else if (method === 8) {
        content = inflateRawSync(compressedData, { maxOutputLength: 512 * 1024 * 1024 });
      } else {
        throw new Error(`Unsupported ZIP compression method ${method}: ${entryName}`);
      }

      if (content.length !== uncompressedSize || crc32(content) !== checksum) {
        throw new Error(`Corrupt ZIP entry: ${entryName}`);
      }
      return content;
    }

    directoryOffset += 46 + nameLength + extraLength + commentLength;
  }

  throw new Error(`ZIP entry not found: ${expectedName}`);
}

function getJsonContent(source, expectedName) {
  const content = source.isZip ? extractZipEntry(source.data, expectedName) : source.data;
  const parsed = JSON.parse(content.toString('utf8'));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${expectedName} must contain a JSON object or array`);
  }
  return content;
}

async function findFile(directories, names) {
  for (const directory of directories) {
    for (const name of names) {
      const filePath = path.join(directory, name);
      try {
        return {
          name,
          path: filePath,
          data: await readFile(filePath),
          isZip: name.endsWith('.zip')
        };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return null;
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

async function findValidFile(directories, names, expectedName) {
  for (const directory of directories) {
    for (const name of names) {
      const filePath = path.join(directory, name);
      let source;
      try {
        source = {
          name,
          path: filePath,
          data: await readFile(filePath),
          isZip: name.endsWith('.zip')
        };
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }

      try {
        getJsonContent(source, expectedName);
        return source;
      } catch (error) {
        console.warn(`Ignoring invalid timetable ${source.path}: ${error.message}`);
      }
    }
  }
  return null;
}

async function readStoredDay(timetableDirectory, dayNumber, date) {
  const datedNames = [`${date}-${dayNumber}.json.zip`, `${date}-${dayNumber}.json`];
  const legacyNames = [`${dayNumber}.json.zip`, `${dayNumber}.json`];
  const names = [...datedNames, ...legacyNames];
  for (const name of names) {
    const source = await findFile([timetableDirectory], [name]);
    if (!source) continue;
    try {
      getJsonContent(source, `${dayNumber}.json`);
    } catch (error) {
      console.warn(`Ignoring invalid stored timetable ${source.path}: ${error.message}`);
      continue;
    }
    if (legacyNames.includes(name)) {
      const extension = source.isZip ? '.json.zip' : '.json';
      const datedName = `${date}-${dayNumber}${extension}`;
      const datedPath = path.join(timetableDirectory, datedName);
      await rename(source.path, datedPath);
      source.name = datedName;
      source.path = datedPath;
    }
    return source;
  }
  return null;
}

function commonVersionInfo(name) {
  const datedMatch = /^(\d{4}-\d{2}-\d{2})-common(?:-(\d+))?\.json(\.zip)?$/.exec(name);
  const legacyMatch = /^common-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.json(\.zip)?$/.exec(name);
  const match = datedMatch || legacyMatch;
  if (!match) return null;
  return {
    date: match[1],
    sequence: Number(match[2] || 1),
    name,
    isZip: Boolean(match[3]),
    legacy: !datedMatch
  };
}

async function readCommonVersions(timetableDirectory) {
  const entries = await readdir(timetableDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => commonVersionInfo(entry.name))
    .filter(Boolean)
    .sort((left, right) =>
      left.date.localeCompare(right.date) || left.sequence - right.sequence
    );
}

async function migrateCommonFilenames(timetableDirectory) {
  const versions = await readCommonVersions(timetableDirectory);
  for (const version of versions.filter((item) => item.legacy)) {
    const extension = version.isZip ? '.json.zip' : '.json';
    let sequence = version.sequence;
    let suffix = sequence === 1 ? '' : `-${sequence}`;
    let targetName = `${version.date}-common${suffix}${extension}`;
    let targetPath = path.join(timetableDirectory, targetName);

    if (await fileExists(targetPath)) {
      const [legacyData, datedData] = await Promise.all([
        readFile(path.join(timetableDirectory, version.name)),
        readFile(targetPath)
      ]);
      if (legacyData.equals(datedData)) {
        await unlink(path.join(timetableDirectory, version.name));
        continue;
      }

      const dateVersions = versions.filter((item) => item.date === version.date);
      sequence = Math.max(...dateVersions.map((item) => item.sequence)) + 1;
      do {
        suffix = `-${sequence++}`;
        targetName = `${version.date}-common${suffix}${extension}`;
        targetPath = path.join(timetableDirectory, targetName);
      } while (await fileExists(targetPath));
    }

    await rename(path.join(timetableDirectory, version.name), targetPath);
  }
}

async function latestStoredCommon(timetableDirectory, isZip) {
  const versions = (await readCommonVersions(timetableDirectory))
    .filter((version) => version.isZip === isZip);
  for (const version of versions.toReversed()) {
    const source = await findFile([timetableDirectory], [version.name]);
    if (!source) continue;
    try {
      return { ...version, content: getJsonContent(source, 'common.json') };
    } catch (error) {
      console.warn(`Ignoring invalid stored common timetable ${source.path}: ${error.message}`);
    }
  }
  return null;
}

async function writeAtomic(filePath, data) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, data, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function saveCommonIfChanged(source, date, timetableDirectory) {
  const content = getJsonContent(source, 'common.json');
  const latest = await latestStoredCommon(timetableDirectory, source.isZip);
  if (latest?.content.equals(content)) return null;

  const versions = await readCommonVersions(timetableDirectory);
  const currentDateVersions = versions.filter((version) => version.date === date);
  const sequence = currentDateVersions.length === 0
    ? 1
    : Math.max(...currentDateVersions.map((version) => version.sequence)) + 1;
  const suffix = sequence === 1 ? '' : `-${sequence}`;
  const extension = source.isZip ? '.json.zip' : '.json';
  const filePath = path.join(timetableDirectory, `${date}-common${suffix}${extension}`);
  await writeAtomic(filePath, source.data);
  return filePath;
}

async function fetchSource(url, expectedName, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Timetable request returned HTTP ${response.status}: ${url}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  const source = { name: expectedName, data, isZip: expectedName.endsWith('.zip') };
  getJsonContent(source, expectedName.replace(/\.zip$/, ''));
  return source;
}

export async function ensureTimetablesForDate({
  date,
  outputDirectory,
  localDirectories = [],
  remoteBaseUrl = 'https://bprp.pages.dev/timetable/',
  fetchImpl = fetch
}) {
  const dayNumber = dayNumberForDate(date);
  const timetableDirectory = outputDirectory;
  await mkdir(timetableDirectory, { recursive: true });
  await migrateCommonFilenames(timetableDirectory);

  let daySource = await readStoredDay(timetableDirectory, dayNumber, date);
  if (!daySource) {
    daySource = await findValidFile(
      localDirectories,
      [`${dayNumber}.json.zip`, `${dayNumber}.json`],
      `${dayNumber}.json`
    );
    if (!daySource) {
      daySource = await fetchSource(
        new URL(`${dayNumber}.json.zip`, remoteBaseUrl),
        `${dayNumber}.json.zip`,
        fetchImpl
      );
    }
    const extension = daySource.isZip ? '.json.zip' : '.json';
    const dayName = `${date}-${dayNumber}${extension}`;
    const dayPath = path.join(timetableDirectory, dayName);
    await writeAtomic(dayPath, daySource.data);
    daySource = { ...daySource, name: dayName };
  }

  const localCommon = await findValidFile(
    localDirectories,
    ['common.json.zip', 'common.json'],
    'common.json'
  );
  if (localCommon) {
    await saveCommonIfChanged(localCommon, date, timetableDirectory);
  }

  const remoteCommon = await fetchSource(
    new URL('common.json.zip', remoteBaseUrl),
    'common.json.zip',
    fetchImpl
  );
  const commonPath = await saveCommonIfChanged(remoteCommon, date, timetableDirectory);

  return {
    date,
    dayNumber,
    dayPath: path.join(timetableDirectory, daySource.name),
    commonPath
  };
}

if (parentPort) {
  const pending = [];
  const pendingHours = new Set();
  const completedHours = new Set();
  let processing = false;

  async function processQueue() {
    if (processing || pending.length === 0) return;
    processing = true;
    const request = pending.shift();

    try {
      const result = await ensureTimetablesForDate({
        date: request.date,
        outputDirectory: workerData.outputDirectory,
        localDirectories: workerData.localDirectories,
        remoteBaseUrl: workerData.remoteBaseUrl
      });
      completedHours.add(request.hour);
      parentPort.postMessage({ type: 'complete', hour: request.hour, ...result });
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        hour: request.hour,
        date: request.date,
        message: error.message
      });
      setTimeout(() => enqueue(request), RETRY_DELAY_MS).unref();
    } finally {
      pendingHours.delete(request.hour);
      processing = false;
      void processQueue();
    }
  }

  function enqueue(request) {
    if (completedHours.has(request.hour) || pendingHours.has(request.hour)) return;
    pendingHours.add(request.hour);
    pending.push(request);
    void processQueue();
  }

  parentPort.on('message', (message) => {
    if (message.type === 'ensure') enqueue(message);
  });
}
