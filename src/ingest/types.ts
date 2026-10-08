import type { IngestedMedia, MediaSource } from "../core/types.js";

export type { IngestedMedia, MediaSource } from "../core/types.js";

/** An executable adapter for a source descriptor. */
export interface MediaSourceAdapter {
  readonly source: MediaSource;
  ingest(): Promise<IngestedMedia>;
}

/** A registry entry used when callers have a descriptor but not an adapter yet. */
export interface MediaSourceIngestor {
  supports(source: MediaSource): boolean;
  ingest(source: MediaSource): Promise<IngestedMedia>;
}

/**
 * Small dispatcher for local/Bilibili and future source kinds. It avoids
 * spreading source-specific conditionals through the business layer.
 */
export class MediaIngestService {
  public constructor(private readonly ingestors: readonly MediaSourceIngestor[]) {}

  async ingest(source: MediaSource): Promise<IngestedMedia> {
    const ingestor = this.ingestors.find((candidate) => candidate.supports(source));
    if (!ingestor) {
      throw new Error(`No media ingestor is registered for source kind: ${source.kind}.`);
    }
    return ingestor.ingest(source);
  }
}

/** Cache seam for expensive ASR results; storage can provide an implementation. */
export interface IngestCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}
