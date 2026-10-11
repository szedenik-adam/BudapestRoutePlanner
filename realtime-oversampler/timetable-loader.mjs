import { readdir, readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTimetableShapeDistanceValidator,
  createTimetableShapePointIndexer
} from './shape-point-index.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jszipPath = path.join(projectRoot, 'scripts/external/jszip.min.js');
const gtfsParserPath = path.join(projectRoot, 'scripts/gtfs.js');
const timetableParserPath = path.join(projectRoot, 'scripts/timetableLoader.js');
const quietConsole = { log() {}, info() {}, warn() {}, error() {} };

function commonVersion(name) {
  const dateFirst = /^(\d{4}-\d{2}-\d{2})-common(?:-(\d+))?\.json(\.zip)?$/.exec(name);
  const nameFirst = /^common-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.json(\.zip)?$/.exec(name);
  const match = dateFirst || nameFirst;
  if (!match) return null;
  return {
    name,
    date: match[1],
    version: Number(match[2] || 1),
    zipped: Boolean(match[3])
  };
}

async function findDailyTimetable(directory, date, dayNumber) {
  const entries = await readdir(directory, { withFileTypes: true });
  const datedTimetables = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = /^(\d{4}-\d{2}-\d{2})-(\d+)\.json(\.zip)?$/.exec(entry.name);
      if (!match) return null;
      return {
        name: entry.name,
        date: match[1],
        zipped: Boolean(match[3])
      };
    })
    .filter((timetable) => timetable && timetable.date <= date)
    .sort((left, right) =>
      right.date.localeCompare(left.date) ||
      Number(right.zipped) - Number(left.zipped)
    );

  if (datedTimetables.length > 0) {
    const timetable = datedTimetables[0];
    return {
      ...timetable,
      path: path.join(directory, timetable.name),
      data: await readFile(path.join(directory, timetable.name))
    };
  }

  const hasDatedTimetables = entries.some((entry) =>
    entry.isFile() && /^\d{4}-\d{2}-\d{2}-\d+\.json(\.zip)?$/.test(entry.name)
  );
  if (hasDatedTimetables) {
    throw new Error(`No daily timetable valid on or before ${date} found in ${directory}`);
  }

  for (const name of [`${dayNumber}.json.zip`, `${dayNumber}.json`]) {
    try {
      return {
        name,
        date,
        path: path.join(directory, name),
        data: await readFile(path.join(directory, name))
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`No daily timetable found for ${date} (day ${dayNumber}) in ${directory}`);
}

async function findCommonTimetables(directory, date) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => commonVersion(entry.name))
    .filter((version) => version && version.date <= date)
    .sort((left, right) =>
      right.date.localeCompare(left.date) ||
      right.version - left.version ||
      Number(right.zipped) - Number(left.zipped)
    )
    .map((version) => ({
      ...version,
      path: path.join(directory, version.name)
    }));
}

function hasMatchingCommonRange(common, daily) {
  return Array.isArray(common.range) &&
    Array.isArray(daily.c_range) &&
    common.range[0] === daily.c_range[0] &&
    common.range[1] === daily.c_range[1];
}

async function findCompatibleCommonTimetable(context, directory, date, daily) {
  const candidates = await findCommonTimetables(directory, date);
  if (candidates.length === 0) {
    throw new Error(`No common timetable valid on ${date} found in ${directory}`);
  }

  for (const candidate of candidates) {
    candidate.data = await readFile(candidate.path);
    const commonContent = candidate.name.endsWith('.zip')
      ? (await context.ExtractZips([candidate.data]))[0]
      : candidate.data.toString('utf8');
    candidate.json = context.ParseJsons([commonContent])[0];
    if (hasMatchingCommonRange(candidate.json, daily)) return candidate;
  }

  throw new Error(
    `No common timetable valid on ${date} matches daily timetable range ` +
    `${daily.c_range?.join('-') ?? 'unknown'}`
  );
}

export class TimetableLoader {
  constructor(timetableDirectory, {
    onShapePointIndexIssue = (message) => console.warn(message),
    onShapeDistanceValidationError = (message) => console.error(message)
  } = {}) {
    this.timetableDirectory = timetableDirectory;
    this.onShapePointIndexIssue = onShapePointIndexIssue;
    this.onShapeDistanceValidationError = onShapeDistanceValidationError;
    this.cache = null;
    this.parserContextPromise = null;
  }

  async getParserContext() {
    this.parserContextPromise ??= this.createParserContext();
    return this.parserContextPromise;
  }

  async createParserContext() {
    const context = createContext({
      Blob,
      Buffer,
      TextDecoder,
      TextEncoder,
      Uint8Array,
      console: quietConsole,
      setImmediate,
      clearImmediate,
      performance
    });
    for (const filePath of [jszipPath, gtfsParserPath, timetableParserPath]) {
      runInContext(await readFile(filePath, 'utf8'), context, { filename: filePath });
    }
    return context;
  }

  async loadForFeed(message) {
    const rawTimestamp = message.header?.timestamp;
    const timestamp = typeof rawTimestamp?.toNumber === 'function'
      ? rawTimestamp.toNumber()
      : Number(rawTimestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      throw new Error('GTFS-RT feed header has no valid timestamp');
    }

    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const context = await this.getParserContext();
    const dayNumber = context.date2days(date);
    const daily = await findDailyTimetable(this.timetableDirectory, date, dayNumber);
    if (this.cache?.dailyPath === daily.path) return this.cache.timetable;

    const dailyContent = daily.name.endsWith('.zip')
      ? (await context.ExtractZips([daily.data]))[0]
      : daily.data.toString('utf8');
    daily.json = context.ParseJsons([dailyContent])[0];
    const common = await findCompatibleCommonTimetable(
      context,
      this.timetableDirectory,
      daily.date,
      daily.json
    );
    const timetable = context.initRoutes(
      common.json,
      daily.json,
      context.date2days(daily.date)
    );
    const indexTripShapePoints = createTimetableShapePointIndexer(
      timetable,
      (message) => {
        this.onShapePointIndexIssue(
          `daily ${daily.name}, common ${common.name}: ${message}`
        );
      }
    );
    const validateTripShapeDistances = createTimetableShapeDistanceValidator(
      timetable,
      (message) => {
        this.onShapeDistanceValidationError(
          `daily ${daily.name}, common ${common.name}: ${message}`
        );
      }
    );
    Object.defineProperty(timetable, 'indexTripShapePoints', {
      value: indexTripShapePoints
    });
    Object.defineProperty(timetable, 'validateTripShapeDistances', {
      value: validateTripShapeDistances
    });
    this.cache = {
      commonPath: common.path,
      dailyPath: daily.path,
      timetable
    };
    return timetable;
  }
}
