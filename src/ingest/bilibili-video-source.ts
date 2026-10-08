import type { IngestedMedia, MediaSource } from "../core/types.js";
import type { MediaSourceAdapter, MediaSourceIngestor } from "./types.js";

/**
 * Boundary reserved for a future Bilibili API implementation. Keeping this
 * interface here means the rest of the pipeline never needs Bilibili-specific
 * request/credential code.
 */
export interface BilibiliResolver {
  ingestBilibili(source: MediaSource): Promise<IngestedMedia>;
}

export class BilibiliVideoSource implements MediaSourceAdapter {
  public readonly source: MediaSource;

  public constructor(source: MediaSource | string, private readonly resolver?: BilibiliResolver) {
    this.source = typeof source === "string" ? { kind: "bilibili", uri: source } : source;
    if (this.source.kind !== "bilibili") {
      throw new Error(`BilibiliVideoSource requires kind \"bilibili\", received \"${this.source.kind}\".`);
    }
  }

  async ingest(): Promise<IngestedMedia> {
    if (!this.resolver) {
      throw new Error(
        "Bilibili ingest is reserved but not configured. Supply a BilibiliResolver that obtains video, audio, subtitles, title, description, danmaku, and duration.",
      );
    }
    return this.resolver.ingestBilibili(this.source);
  }
}

export class BilibiliVideoIngestor implements MediaSourceIngestor {
  public constructor(private readonly resolver?: BilibiliResolver) {}

  supports(source: MediaSource): boolean {
    return source.kind === "bilibili";
  }

  ingest(source: MediaSource): Promise<IngestedMedia> {
    return new BilibiliVideoSource(source, this.resolver).ingest();
  }
}
