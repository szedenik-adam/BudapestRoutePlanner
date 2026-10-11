const UPDATE_INTERVAL_MS = 500;
const trafficClasses = ['fast', 'normal', 'slow', 'very_slow'];
const STATUS_BLOCK_MAX_LINES = 7 + 1 + trafficClasses.length * 2;

function formatMegabytes(bytes) {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function formatCpuPercent(value) {
  return value === null ? '--' : `${value.toFixed(1)}%`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'estimating';
  const wholeSeconds = Math.floor(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;
  return `${String(hours).padStart(2, '0')}:` +
    `${String(minutes).padStart(2, '0')}:` +
    `${String(remainder).padStart(2, '0')}`;
}

function truncate(line, width) {
  if (line.length <= width) return line;
  if (width <= 3) return line.slice(0, width);
  return `${line.slice(0, Math.max(0, width - 3))}...`;
}

function getBucketLines(pair) {
  const lines = [
    pair
      ? `Buckets (average speed m/s; sample count in parentheses) for ` +
        `${pair.fromStopId} -> ${pair.toStopId}`
      : 'Stop-pair buckets: waiting for a classified leg'
  ];
  for (const trafficClass of trafficClasses) {
    const buckets = pair?.classes.get(trafficClass);
    const nonStoppingBuckets = pair?.nonStoppingClasses?.get(trafficClass);
    for (const [label, values] of [
      [trafficClass, buckets],
      [`${trafficClass} no-stop +/-20s`, nonStoppingBuckets]
    ]) {
      if (!values || values.size === 0) {
        lines.push(`  ${label}: -`);
        continue;
      }

      const sortedBuckets = [...values.entries()].sort(
        ([left], [right]) => left - right
      );
      const shownBuckets = sortedBuckets.slice(0, 8).map(([bucket, aggregate]) => {
        const averageSpeed = aggregate.speedSumMps / aggregate.sampleCount;
        return `${bucket * 20}m:${averageSpeed.toFixed(1)}(${aggregate.sampleCount})`;
      });
      const remainingCount = sortedBuckets.length - shownBuckets.length;
      if (remainingCount > 0) shownBuckets.push(`+${remainingCount} buckets`);
      lines.push(`  ${label}: ${shownBuckets.join(' ')}`);
    }
  }
  return lines;
}

export class StatusDisplay {
  constructor({
    totalFiles,
    totalBytes,
    speedGraph,
    output = process.stdout,
    live = true
  }) {
    this.totalFiles = totalFiles;
    this.totalBytes = totalBytes;
    this.speedGraph = speedGraph;
    this.output = output;
    this.live = live && Boolean(output.isTTY);
    this.startedAt = 0;
    this.timer = null;
    this.completedFiles = 0;
    this.completedBytes = 0;
    this.currentFileName = null;
    this.currentFileSize = 0;
    this.currentFileBytes = 0;
    this.processedMessages = 0;
    this.finished = false;
    this.lastCpuSampleAt = 0;
    this.lastCpuUsage = null;
    this.cpuPercent = null;
    this.rssBytes = 0;
    this.liveHeight = 0;
    this.statusRows = 0;
    this.statusTopRow = 0;
    this.logBottomRow = 0;
  }

  start() {
    this.startedAt = performance.now();
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuSampleAt = performance.now();
    this.rssBytes = process.memoryUsage().rss;
    if (this.live) {
      this.output.write('\u001b[?25l');
      this.configureLiveRegion();
      this.render();
      this.timer = setInterval(() => this.render(), UPDATE_INTERVAL_MS);
    }
  }

  configureLiveRegion() {
    const height = this.output.rows > 1
      ? this.output.rows
      : STATUS_BLOCK_MAX_LINES + 1;
    this.liveHeight = height;
    this.statusRows = Math.min(STATUS_BLOCK_MAX_LINES, height - 1);
    this.logBottomRow = height - this.statusRows;
    this.statusTopRow = this.logBottomRow + 1;
    this.output.write(
      `\u001b[1;${this.logBottomRow}r\u001b[${this.logBottomRow};1H`
    );
  }

  beginFile(name, size) {
    this.currentFileName = name;
    this.currentFileSize = size;
    this.currentFileBytes = 0;
    this.render();
  }

  updateFileBytes(bytes) {
    this.currentFileBytes = Math.max(
      this.currentFileBytes,
      Math.min(bytes, this.currentFileSize)
    );
  }

  completeFile() {
    this.completedFiles++;
    this.completedBytes += this.currentFileSize;
    this.currentFileName = null;
    this.currentFileSize = 0;
    this.currentFileBytes = 0;
    this.render();
  }

  incrementMessages() {
    this.processedMessages++;
  }

  log(message) {
    const text = String(message).replace(/\r/g, '');
    if (this.live) {
      this.output.write(
        `\u001b[${this.logBottomRow};1H${text}\n` +
        `\u001b[${this.logBottomRow};1H`
      );
      return;
    }
    this.output.write(`${text}\n`);
  }

  updateResourceUsage(forceCpuSample = false) {
    this.rssBytes = process.memoryUsage().rss;
    const currentCpuUsage = process.cpuUsage();
    const now = performance.now();
    const elapsedMilliseconds = now - this.lastCpuSampleAt;
    if (elapsedMilliseconds <= 0 || (elapsedMilliseconds < 100 && !forceCpuSample)) return;

    const cpuMicroseconds =
      currentCpuUsage.user - this.lastCpuUsage.user +
      currentCpuUsage.system - this.lastCpuUsage.system;
    this.cpuPercent = cpuMicroseconds / (elapsedMilliseconds * 1000) * 100;
    this.lastCpuUsage = currentCpuUsage;
    this.lastCpuSampleAt = now;
  }

  render({ forceCpuSample = false } = {}) {
    this.updateResourceUsage(forceCpuSample);
    const elapsedSeconds = Math.max((performance.now() - this.startedAt) / 1000, 0.001);
    const currentBytes = this.currentFileName ? this.currentFileBytes : 0;
    const processedBytes = Math.min(
      this.totalBytes,
      this.completedBytes + currentBytes
    );
    const megabytesPerSecond = processedBytes / elapsedSeconds / 1_000_000;
    const messagesPerSecond = this.processedMessages / elapsedSeconds;
    const remainingBytes = Math.max(0, this.totalBytes - processedBytes);
    const remainingSeconds = megabytesPerSecond > 0
      ? remainingBytes / (megabytesPerSecond * 1_000_000)
      : Number.POSITIVE_INFINITY;
    const stopPairCount = this.speedGraph.speedGraph.size;
    const routeStopWaitCount = this.speedGraph.routeStopWaitCount;
    const lines = [
      this.finished ? 'Speed-location graph: run finished' : 'Speed-location graph: processing',
      `Processed files: ${this.completedFiles} / ${this.totalFiles}` +
        (this.currentFileName ? ` | Current: ${this.currentFileName}` : ''),
      `Processed MB: ${formatMegabytes(processedBytes)} / ${formatMegabytes(this.totalBytes)}`,
      `Processed PB messages: ${this.processedMessages}`,
      `Created stop-pairs: ${stopPairCount} | ` +
        `Created route-stop waits: ${routeStopWaitCount}`,
      `Processing speed: ${megabytesPerSecond > 0 ? `${megabytesPerSecond.toFixed(2)} MB/s` : '--'}, ` +
        `${messagesPerSecond.toFixed(1)} feeds/s | ` +
        `Remaining time: ${formatDuration(remainingSeconds)}`,
      `Node CPU: ${formatCpuPercent(this.cpuPercent)} | RAM (RSS): ${formatMegabytes(this.rssBytes)}`,
      ...getBucketLines(this.speedGraph.lastUpdatedPair)
    ];
    const height = this.output.rows > 1
      ? this.output.rows
      : STATUS_BLOCK_MAX_LINES + 1;
    const width = this.output.columns > 1
      ? this.output.columns - 1
      : Number.POSITIVE_INFINITY;

    if (this.live) {
      if (height !== this.liveHeight) this.configureLiveRegion();
      const visibleLines = lines.slice(-this.statusRows);
      const paddedLines = [
        ...Array(this.statusRows - visibleLines.length).fill(''),
        ...visibleLines
      ];
      const text = paddedLines
        .map((line) => `\r\u001b[2K${truncate(line, width)}`)
        .join('\n');
      this.output.write(
        `\u001b[${this.statusTopRow};1H${text}\u001b[${this.logBottomRow};1H`
      );
    } else if (this.finished) {
      const visibleLines = lines.slice(0, Math.max(1, height - 1));
      const text = visibleLines.map((line) => truncate(line, width)).join('\n');
      this.output.write(`${text}\n`);
    }
  }

  stop({ finished = false } = {}) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.finished = finished;
    this.render({ forceCpuSample: true });
    if (this.live) {
      this.output.write(
        `\u001b[r\u001b[${this.liveHeight};1H\r\n\u001b[?25h`
      );
    }
  }
}
