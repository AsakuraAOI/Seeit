import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  DanmakuEntry,
  MediaSource,
  Transcript,
  VideoMetadata,
  VideoTimeline,
  VideoUnderstanding,
} from "../core/types.js";
import type { PerceptionState } from "../perception/types.js";

export const VIDEO_ARTIFACT_FILES = {
  metadata: "metadata.json",
  timeline: "timeline.json",
  understanding: "understanding.json",
  transcript: "transcript.json",
  danmaku: "danmaku.json",
  perception: "perception-state.json",
} as const;

export type VideoArtifactName = keyof typeof VIDEO_ARTIFACT_FILES;

/** Compact, read-only metadata for interactive video selection. */
export interface StoredVideoSummary {
  videoId: string;
  title?: string;
  duration: number;
  understanding?: {
    status: "base" | "enriched";
    sectionCount: number;
  };
  perception?: {
    observationCount: number;
    unresolvedCount: number;
  };
}

interface CacheEntry<T> {
  key: string;
  createdAt: string;
  value: T;
}

/**
 * Persistent storage for one video's raw evidence and derived artifacts.
 *
 * The source evidence is deliberately stored separately from `understanding`:
 * the latter can be regenerated without losing transcript, danmaku, frames,
 * or ingest metadata.
 */
export class VideoStorage {
  readonly rootDir: string;

  constructor(rootDir = resolve(process.cwd(), "data")) {
    this.rootDir = resolve(rootDir);
  }

  /** Create the standard directory layout for a video if it does not exist. */
  async initialize(videoId: string): Promise<void> {
    const videoDir = this.getVideoDir(videoId);
    await Promise.all([
      mkdir(videoDir, { recursive: true }),
      mkdir(this.getFramesDir(videoId), { recursive: true }),
      mkdir(this.getCacheDir(videoId), { recursive: true }),
    ]);
  }

  getVideoDir(videoId: string): string {
    return this.resolveInRoot(assertSafeVideoId(videoId));
  }

  getFramesDir(videoId: string): string {
    return this.resolveInVideo(videoId, "frames");
  }

  getCacheDir(videoId: string): string {
    return this.resolveInVideo(videoId, "cache");
  }

  getArtifactPath(videoId: string, artifact: VideoArtifactName): string {
    return this.resolveInVideo(videoId, VIDEO_ARTIFACT_FILES[artifact]);
  }

  /**
   * A frame filename must be a single safe path segment. Use this instead of
   * joining user-controlled names into the frame directory.
   */
  getFramePath(videoId: string, filename: string): string {
    return this.resolveInVideo(videoId, "frames", assertSafeFilename(filename));
  }

  async readArtifact<T>(videoId: string, artifact: VideoArtifactName): Promise<T | undefined> {
    return readJsonFile<T>(this.getArtifactPath(videoId, artifact));
  }

  async writeArtifact<T>(videoId: string, artifact: VideoArtifactName, value: T): Promise<void> {
    await writeJsonAtomic(this.getArtifactPath(videoId, artifact), value);
  }

  async readMetadata(videoId: string): Promise<VideoMetadata | undefined> {
    return this.readArtifact<VideoMetadata>(videoId, "metadata");
  }

  async writeMetadata(videoId: string, metadata: VideoMetadata): Promise<void> {
    if (metadata.videoId !== videoId) {
      throw new Error("metadata.videoId must match the storage videoId");
    }
    await this.writeArtifact(videoId, "metadata", metadata);
  }

  /**
   * Resolve a previously persisted source without reopening the video. This
   * small filesystem scan is only used when a source descriptor has no stable
   * `videoId`; normal callers take the direct O(1) id path above.
   */
  async findVideoIdBySource(source: Pick<MediaSource, "kind" | "uri">): Promise<string | undefined> {
    let directories: string[];
    try {
      directories = (await readdir(this.rootDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => isSafeVideoId(name))
        .sort();
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw error;
    }

    for (const videoId of directories) {
      try {
        const metadata = await this.readMetadata(videoId);
        if (!metadata?.source) continue;
        if (metadata.source.kind === source.kind && metadata.source.uri === source.uri) {
          return videoId;
        }
      } catch {
        // A corrupt/unrelated directory must not prevent a valid persisted
        // source later in the data root from being found.
      }
    }
    return undefined;
  }

  /**
   * Lists only durable videos with readable metadata, in stable videoId order.
   * Invalid/corrupt sibling directories are ignored so one incomplete import
   * cannot make the interactive picker unusable.
   */
  async listVideoSummaries(): Promise<StoredVideoSummary[]> {
    let videoIds: string[];
    try {
      videoIds = (await readdir(this.rootDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && isSafeVideoId(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }

    const summaries = await Promise.all(videoIds.map((videoId) => this.readVideoSummary(videoId)));
    return summaries.filter((summary): summary is StoredVideoSummary => summary !== undefined);
  }

  async readTimeline(videoId: string): Promise<VideoTimeline | undefined> {
    return this.readArtifact<VideoTimeline>(videoId, "timeline");
  }

  async writeTimeline(videoId: string, timeline: VideoTimeline): Promise<void> {
    if (timeline.videoId !== videoId) {
      throw new Error("timeline.videoId must match the storage videoId");
    }
    await this.writeArtifact(videoId, "timeline", timeline);
  }

  async readUnderstanding(videoId: string): Promise<VideoUnderstanding | undefined> {
    return this.readArtifact<VideoUnderstanding>(videoId, "understanding");
  }

  async writeUnderstanding(videoId: string, understanding: VideoUnderstanding): Promise<void> {
    if (understanding.videoId !== videoId) {
      throw new Error("understanding.videoId must match the storage videoId");
    }
    await this.writeArtifact(videoId, "understanding", understanding);
  }

  async readTranscript<T = Transcript>(videoId: string): Promise<T | undefined> {
    return this.readArtifact<T>(videoId, "transcript");
  }

  async writeTranscript<T = Transcript>(videoId: string, transcript: T): Promise<void> {
    await this.writeArtifact(videoId, "transcript", transcript);
  }

  async readDanmaku<T = DanmakuEntry[]>(videoId: string): Promise<T | undefined> {
    return this.readArtifact<T>(videoId, "danmaku");
  }

  async writeDanmaku<T = DanmakuEntry[]>(videoId: string, danmaku: T): Promise<void> {
    await this.writeArtifact(videoId, "danmaku", danmaku);
  }

  async readPerceptionState(videoId: string): Promise<PerceptionState | undefined> {
    return this.readArtifact<PerceptionState>(videoId, "perception");
  }

  async writePerceptionState(videoId: string, state: PerceptionState): Promise<void> {
    if (state.videoId !== videoId) {
      throw new Error("perception-state.videoId must match the storage videoId");
    }
    if (state.version !== 1 || !Array.isArray(state.observations) || !Array.isArray(state.executedRequests)) {
      throw new TypeError("perception-state has an invalid durable shape");
    }
    await this.writeArtifact(videoId, "perception", state);
  }

  /** Persist an extracted frame atomically and return its absolute reference. */
  async writeFrame(videoId: string, filename: string, data: Uint8Array): Promise<string> {
    const framePath = this.getFramePath(videoId, filename);
    await writeFileAtomically(framePath, data);
    return framePath;
  }

  async readFrame(videoId: string, filename: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(this.getFramePath(videoId, filename));
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Cache keys are SHA-256 addressed, so callers can use descriptive keys or
   * request payloads without making those strings part of a filesystem path.
   */
  getCachePath(videoId: string, cacheKey: string): string {
    const digest = cacheKeyDigest(cacheKey);
    return this.resolveInVideo(videoId, "cache", `${digest}.json`);
  }

  async getCache<T>(videoId: string, cacheKey: string): Promise<T | undefined> {
    const entry = await readJsonFile<CacheEntry<T>>(this.getCachePath(videoId, cacheKey));
    if (!entry || entry.key !== cacheKey || !("value" in entry)) {
      return undefined;
    }
    return entry.value;
  }

  async setCache<T>(videoId: string, cacheKey: string, value: T): Promise<void> {
    if (value === undefined) {
      throw new TypeError("Cache values must not be undefined");
    }

    const entry: CacheEntry<T> = {
      key: assertNonEmptyString(cacheKey, "cacheKey"),
      createdAt: new Date().toISOString(),
      value,
    };
    await writeJsonAtomic(this.getCachePath(videoId, cacheKey), entry);
  }

  /** Alias with a read-oriented name for callers that prefer it. */
  async readCache<T>(videoId: string, cacheKey: string): Promise<T | undefined> {
    return this.getCache(videoId, cacheKey);
  }

  /** Alias with a write-oriented name for callers that prefer it. */
  async writeCache<T>(videoId: string, cacheKey: string, value: T): Promise<void> {
    await this.setCache(videoId, cacheKey, value);
  }

  /**
   * Use a cached expensive result if present, otherwise compute and persist it.
   * This is intentionally a small sequential helper; coordination across
   * separate processes is outside the first-stage storage contract.
   */
  async getOrCreateCache<T>(
    videoId: string,
    cacheKey: string,
    create: () => Promise<T> | T,
  ): Promise<T> {
    const cached = await this.getCache<T>(videoId, cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const value = await create();
    await this.setCache(videoId, cacheKey, value);
    return value;
  }

  private resolveInVideo(videoId: string, ...segments: string[]): string {
    return this.resolveInRoot(assertSafeVideoId(videoId), ...segments);
  }

  private async readVideoSummary(videoId: string): Promise<StoredVideoSummary | undefined> {
    try {
      const [metadata, understanding, perception] = await Promise.all([
        this.readMetadata(videoId),
        this.readUnderstanding(videoId),
        this.readPerceptionState(videoId),
      ]);
      if (!metadata) return undefined;
      return {
        videoId,
        ...(metadata.title?.trim() ? { title: metadata.title.trim() } : {}),
        duration: metadata.duration,
        ...(understanding
          ? { understanding: { status: understanding.status ?? "base", sectionCount: understanding.sections.length } }
          : {}),
        ...(perception
          ? { perception: { observationCount: perception.observations.length, unresolvedCount: perception.unresolved.length } }
          : {}),
      };
    } catch {
      return undefined;
    }
  }

  private resolveInRoot(...segments: string[]): string {
    const resolved = resolve(this.rootDir, ...segments);
    const relativePath = relative(this.rootDir, resolved);

    if (
      relativePath === "" ||
      (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
    ) {
      return resolved;
    }

    throw new Error("Storage path must remain inside the configured data directory");
  }
}

/** Backwards-friendly names for the first filesystem-backed implementation. */
export { VideoStorage as FileStorage, VideoStorage as FileSystemStorage };

export function cacheKeyDigest(cacheKey: string): string {
  return createHash("sha256").update(assertNonEmptyString(cacheKey, "cacheKey")).digest("hex");
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }

  try {
    return JSON.parse(content) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in storage artifact ${filePath}: ${message}`);
  }
}

async function writeJsonAtomic<T>(filePath: string, value: T): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new TypeError("Storage artifacts must be JSON serializable");
  }
  await writeFileAtomically(filePath, `${serialized}\n`);
}

async function writeFileAtomically(filePath: string, data: string | Uint8Array): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });

  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, data);
    // A rename within one directory is atomic on the supported filesystems and
    // ensures a reader sees either the old full file or the new full file.
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertSafeVideoId(videoId: string): string {
  if (!isSafeVideoId(videoId)) {
    throw new TypeError(
      "videoId must use only letters, numbers, dots, underscores, or hyphens and must not start with punctuation",
    );
  }
  return videoId;
}

function isSafeVideoId(videoId: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u.test(videoId);
}

function assertSafeFilename(filename: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(filename)) {
    throw new TypeError("filename must be a single safe path segment");
  }
  return filename;
}

function assertNonEmptyString(value: string, name: string): string {
  if (!value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
