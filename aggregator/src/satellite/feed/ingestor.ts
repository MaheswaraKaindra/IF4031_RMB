import type { Logger } from 'pino';
import type { IFeedLog } from './log.js';
import { SatelliteSseClient, type SseClientOptions } from './sseClient.js';

export type FeedIngestorOptions = Omit<SseClientOptions, 'resumeOffset' | 'onFrame'> & { log: IFeedLog; logger: Logger };

/** Stores every frame (raw, by offset) before the stream position moves on; the log tail is the durable received offset. */
export function createFeedIngestor(opts: FeedIngestorOptions): SatelliteSseClient {
    const { log, ...clientOpts } = opts;
    return new SatelliteSseClient({
        ...clientOpts,
        resumeOffset: async () => (await log.tail()) + 1,
        onFrame: async ({ offset, frame }) => {
            await log.append([{ offset, kind: frame.event, raw: frame.data, received_at: new Date().toISOString() }]);
        },
    });
}
