import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { parentPort, workerData } from 'node:worker_threads';

const TAR_BLOCK_SIZE = 512;
const MAX_BUFFERED_FEEDS = 2;
let bufferedFeeds = 0;
const capacityWaiters = [];

parentPort.on('message', (message) => {
  if (message.type !== 'ack') return;
  bufferedFeeds--;
  capacityWaiters.shift()?.();
});

async function waitForCapacity() {
  if (bufferedFeeds < MAX_BUFFERED_FEEDS) return;
  await new Promise((resolve) => capacityWaiters.push(resolve));
}

async function* readTarEntries(archivePath) {
  const source = createReadStream(archivePath);
  let compressedBytesRead = 0;
  let nextProgressBytes = 256 * 1024;
  source.on('data', (chunk) => {
    compressedBytesRead += chunk.length;
    if (compressedBytesRead >= nextProgressBytes) {
      parentPort.postMessage({ type: 'progress', bytesRead: compressedBytesRead });
      nextProgressBytes = compressedBytesRead + 256 * 1024;
    }
  });
  const stream = source.pipe(createGunzip());
  let pending = Buffer.alloc(0);
  let entry = null;

  for await (const chunk of stream) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

    while (true) {
      if (!entry) {
        if (pending.length < TAR_BLOCK_SIZE) break;
        const header = pending.subarray(0, TAR_BLOCK_SIZE);
        if (header.every((byte) => byte === 0)) return;

        const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
        if (!/^[0-7]+$/.test(sizeText)) {
          throw new Error(`Invalid tar entry size in ${archivePath}`);
        }
        const size = Number.parseInt(sizeText, 8);
        if (!Number.isSafeInteger(size)) {
          throw new Error(`Tar entry is too large in ${archivePath}`);
        }

        entry = {
          name: header.subarray(0, 100).toString('utf8').replace(/\0.*$/, ''),
          size,
          paddedSize: Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
        };
        pending = pending.subarray(TAR_BLOCK_SIZE);
      }

      if (pending.length < entry.paddedSize) break;
      const currentEntry = entry;
      const data = pending.subarray(0, currentEntry.size);
      pending = pending.subarray(currentEntry.paddedSize);
      entry = null;
      yield { name: currentEntry.name, data };
    }
  }

  if (entry || pending.length > 0) {
    throw new Error(`Truncated tar archive: ${archivePath}`);
  }
  parentPort.postMessage({ type: 'progress', bytesRead: compressedBytesRead });
}

async function readArchive() {
  for await (const entry of readTarEntries(workerData.archivePath)) {
    if (!entry.name.endsWith('.pb')) continue;
    await waitForCapacity();

    const data = Uint8Array.from(entry.data);
    bufferedFeeds++;
    parentPort.postMessage(
      { type: 'feed', name: entry.name, data: data.buffer },
      [data.buffer]
    );
  }
  parentPort.postMessage({ type: 'done' });
}

readArchive().catch((error) => {
  parentPort.postMessage({ type: 'error', message: error.message });
});
