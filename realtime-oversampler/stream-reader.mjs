import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const protobufRuntimePath = path.join(projectRoot, 'scripts/external/protobuf.minimal.min.js');
const gtfsRealtimeParserPath = path.join(projectRoot, 'scripts/external/protobuf-gtfs-realcity.js');

let decoderPromise;

async function loadFeedMessageDecoder() {
  const module = { exports: {} };
  const context = createContext({ console, module });
  const runtime = await readFile(protobufRuntimePath, 'utf8');
  const parser = await readFile(gtfsRealtimeParserPath, 'utf8');
  runInContext(runtime, context, { filename: protobufRuntimePath });
  context.protobuf = module.exports;
  runInContext(parser, context, { filename: gtfsRealtimeParserPath });

  return (bytes) => {
    context.encodedBytes = bytes;
    return runInContext(
      '$root.transit_realtime.FeedMessage.decode(new Uint8Array(encodedBytes))',
      context
    );
  };
}

export class StreamReader {
  constructor(archivePath, { onProgress } = {}) {
    this.archivePath = archivePath;
    this.onProgress = onProgress;
  }

  async *readMessages() {
    decoderPromise ??= loadFeedMessageDecoder();
    const decodeFeedMessage = await decoderPromise;
    const worker = new Worker(new URL('./stream-reader-worker.mjs', import.meta.url), {
      workerData: { archivePath: this.archivePath }
    });
    const queue = [];
    const waiters = [];
    let completed = false;
    let failure = null;
    const notify = () => waiters.shift()?.();

    worker.on('message', (message) => {
      if (message.type === 'feed') {
        queue.push(message);
      } else if (message.type === 'progress') {
        this.onProgress?.(message.bytesRead);
      } else if (message.type === 'done') {
        completed = true;
      } else if (message.type === 'error') {
        failure = new Error(message.message);
      }
      notify();
    });
    worker.on('error', (error) => {
      failure = error;
      notify();
    });
    worker.on('exit', (code) => {
      if (!completed && !failure) {
        failure = new Error(`Archive reader worker exited unexpectedly with status ${code}`);
      }
      notify();
    });

    const nextFeed = async () => {
      while (queue.length === 0 && !completed && !failure) {
        await new Promise((resolve) => waiters.push(resolve));
      }
      if (queue.length > 0) return queue.shift();
      if (failure) throw failure;
      return null;
    };

    try {
      while (true) {
        const feed = await nextFeed();
        if (feed === null) break;
        const message = decodeFeedMessage(Buffer.from(feed.data));
        worker.postMessage({ type: 'ack' });
        yield { name: feed.name, message };
      }
    } finally {
      await worker.terminate();
    }
  }
}
