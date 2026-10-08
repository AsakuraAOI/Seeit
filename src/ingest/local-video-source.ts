import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, parse, resolve } from "node:path";

import type {
  DanmakuEntry,
  IngestedMedia,
  MediaAsset,
  MediaSource,
  SubtitleCue,
  Transcript,
} from "../core/types.js";
import type { ASRProvider } from "../providers/interfaces.js";
import { transcriptCues } from "../providers/interfaces.js";
import { NodeCommandRunner, requireSuccess, type CommandRunner } from "./command-runner.js";
import {
  FfprobeMediaProbe,
  firstAudioStream,
  hasAudioStream,
  probeDuration,
  probeTags,
  type FfprobeResult,
  type MediaProbe,
} from "./ffprobe.js";
import { FileIngestCache } from "./cache.js";
import { readDanmakuFile } from "./danmaku.js";
import { readSubtitleFile } from "./subtitle.js";
import type { IngestCache, MediaSourceAdapter, MediaSourceIngestor } from "./types.js";

export interface LocalVideoSourceOptions {
  videoId?: string;
  title?: string;
  description?: string;
  duration?: number;
  language?: string;
  subtitlePath?: string;
  danmakuPath?: string;
  /** Searches conventional sidecars such as movie.srt and movie.danmaku.json. */
  discoverSidecars?: boolean;
  asrProvider?: ASRProvider;
  cache?: IngestCache;
  /**
   * Resolves the durable cache directory for one video. Applications that use
   * a custom VideoStorage root should provide this so ASR JSON and extracted
   * audio live alongside the rest of that video's evidence.
   */
  cacheDirForVideo?: (videoId: string) => string;
  probe?: MediaProbe;
  /** Injected in tests; defaults to the production runner. */
  commandRunner?: CommandRunner;
}

/**
 * Local source adapter. Original text subtitles are always preferred; ASR is
 * invoked only when no usable original subtitle was found.
 */
export class LocalVideoSource implements MediaSourceAdapter {
  public readonly source: MediaSource;

  private readonly options: LocalVideoSourceOptions;

  public constructor(source: MediaSource | string, options: LocalVideoSourceOptions = {}) {
    if (typeof source === "string") {
      this.source = { kind: "local", uri: source, videoId: options.videoId };
    } else {
      if (source.kind !== "local") {
        throw new Error(`LocalVideoSource requires kind \"local\", received \"${source.kind}\".`);
      }
      this.source = source;
    }
    this.options = options;
  }

  async ingest(): Promise<IngestedMedia> {
    const videoRef = absolutePath(this.source.uri);
    const [sidecarMetadata, probe] = await Promise.all([
      this.discoverSidecars() === false
        ? Promise.resolve<Record<string, unknown>>({})
        : readMetadataSidecar(videoRef),
      this.readProbe(),
    ]);
    const duration = this.options.duration ?? probeDuration(probe ?? {});
    if (duration === undefined) {
      throw new Error(
        `Cannot determine duration for local video ${videoRef}. Provide duration or a working MediaProbe.`,
      );
    }
    const videoId = this.options.videoId ?? this.source.videoId ?? metadataString(this.source, "videoId") ?? makeVideoId(videoRef);
    const tags: Record<string, string> = probe ? probeTags(probe) : {};
    const title = firstDefined(
      this.options.title,
      metadataString(this.source, "title"),
      stringValue(sidecarMetadata.title),
      tags.title,
      parse(videoRef).name,
    );
    const description = firstDefined(
      this.options.description,
      metadataString(this.source, "description"),
      stringValue(sidecarMetadata.description),
      tags.description,
      tags.comment,
      await this.readDescriptionSidecar(videoRef),
    );
    const video: MediaAsset = {
      type: "video",
      ref: videoRef,
      mimeType: mediaMimeType(videoRef),
    };
    const audio = probe && hasAudioStream(probe)
      ? {
          type: "audio" as const,
          ref: videoRef,
          metadata: {
            streamIndex: firstAudioStream(probe)?.index,
            embeddedIn: videoRef,
          },
        }
      : undefined;
    const transcript = await this.loadTranscript({ videoId, videoRef, audioRef: audio?.ref ?? videoRef, duration });
    const danmaku = await this.loadDanmaku(videoRef);

    return {
      videoId,
      source: {
        ...this.source,
        uri: videoRef,
        videoId,
      },
      duration,
      video,
      ...(audio === undefined ? {} : { audio }),
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      ...(transcript === undefined ? {} : { transcript }),
      ...(danmaku.length === 0 ? {} : { danmaku }),
      metadata: {
        ...(this.source.metadata ?? {}),
        localPath: videoRef,
        ...(probe === undefined ? {} : { ffprobe: probe }),
        transcriptSource: transcript?.source ?? "none",
      },
    };
  }

  private async readProbe(): Promise<FfprobeResult | undefined> {
    if (this.options.probe) return this.options.probe.probe(absolutePath(this.source.uri));
    // An explicit duration makes testing and metadata-only imports possible
    // without requiring ffprobe to be installed.
    if (this.options.duration !== undefined) return undefined;
    return new FfprobeMediaProbe(this.options.commandRunner ?? new NodeCommandRunner())
      .probe(absolutePath(this.source.uri));
  }

  private async loadTranscript(context: {
    videoId: string;
    videoRef: string;
    audioRef: string;
    duration: number;
  }): Promise<Transcript | undefined> {
    const subtitlePath = await this.findSubtitlePath(context.videoRef);
    if (subtitlePath) {
      const cues = await readSubtitleFile(subtitlePath);
      if (cues.length > 0) {
        return {
          cues: decorateOriginalCues(cues, subtitlePath),
          language: this.options.language,
          source: "original",
          metadata: { ref: subtitlePath },
        };
      }
    }

    if (!this.options.asrProvider) return undefined;
    const cacheKey = await asrCacheKey(context.videoId, context.videoRef, this.options.language);
    const cache = this.options.cache ?? new FileIngestCache(this.cacheDirectory(context.videoId));
    const cached = await cache.get<Transcript>(cacheKey);
    if (cached && Array.isArray(cached.cues)) {
      return { ...cached, source: "asr", metadata: { ...cached.metadata, cacheHit: true } };
    }

    const audioRef = await this.prepareAsrAudio(context.audioRef, context.videoId);
    const asrResult = await this.options.asrProvider.transcribe({
      audioRef,
      videoId: context.videoId,
      language: this.options.language,
      duration: context.duration,
      metadata: { sourceVideoRef: context.videoRef },
    });
    const transcript: Transcript = {
      cues: normalizeCues(transcriptCues(asrResult)),
      language: Array.isArray(asrResult) ? this.options.language : asrResult.language ?? this.options.language,
      source: "asr",
      metadata: {
        ...(Array.isArray(asrResult) ? {} : asrResult.metadata),
        cacheHit: false,
      },
    };
    await cache.set(cacheKey, transcript);
    return transcript;
  }

  /**
   * ASR services such as SiliconFlow's Qwen3-ASR reject video containers, so
   * embedded audio is extracted to a 16 kHz mono WAV first. Pure audio files
   * pass through untouched. The extracted file lives in the ingest cache and
   * is reused across runs.
   */
  private async prepareAsrAudio(audioRef: string, videoId: string): Promise<string> {
    if (isPureAudio(audioRef)) return audioRef;
    const runner = this.options.commandRunner ?? new NodeCommandRunner();
    const output = join(this.cacheDirectory(videoId), "extracted-audio.wav");
    if (await fileExists(output)) return output;
    await mkdir(dirname(output), { recursive: true });
    const args = [
      "-y", "-v", "error",
      "-i", audioRef,
      "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
      output,
    ];
    const result = await runner.run("ffmpeg", args, { timeoutMs: 600_000 });
    requireSuccess("ffmpeg", args, result);
    return output;
  }

  private async loadDanmaku(videoRef: string): Promise<DanmakuEntry[]> {
    const explicit = this.options.danmakuPath ?? metadataString(this.source, "danmakuPath");
    const path = explicit ? absolutePath(explicit) : await this.findSidecar(videoRef, [".danmaku.json", ".danmaku.xml"]);
    if (!path) return [];
    return readDanmakuFile(path);
  }

  private cacheDirectory(videoId: string): string {
    return this.options.cacheDirForVideo?.(videoId) ?? defaultCacheDirectory(videoId);
  }

  private async findSubtitlePath(videoRef: string): Promise<string | undefined> {
    const explicit = this.options.subtitlePath ?? metadataString(this.source, "subtitlePath");
    if (explicit) return (await fileExists(absolutePath(explicit))) ? absolutePath(explicit) : undefined;
    if (this.discoverSidecars() === false) return undefined;
    return this.findSidecar(videoRef, [".srt", ".vtt", ".ass", ".ssa", ".subtitle.json"]);
  }

  private discoverSidecars(): boolean {
    return this.options.discoverSidecars ?? true;
  }

  private async findSidecar(videoRef: string, suffixes: readonly string[]): Promise<string | undefined> {
    const parsed = parse(videoRef);
    const direct = suffixes.map((suffix) => join(parsed.dir, `${parsed.name}${suffix}`));
    for (const candidate of direct) {
      if (await fileExists(candidate)) return candidate;
    }

    // Also accept language-labelled source captions, e.g. lecture.zh-CN.srt.
    try {
      const candidates = (await readdir(parsed.dir))
        .filter((name) => name.startsWith(`${parsed.name}.`))
        .filter((name) => suffixes.some((suffix) => name.toLowerCase().endsWith(suffix)))
        .sort();
      return candidates.length ? join(parsed.dir, candidates[0]) : undefined;
    } catch {
      return undefined;
    }
  }

  private async readDescriptionSidecar(videoRef: string): Promise<string | undefined> {
    if (this.discoverSidecars() === false) return undefined;
    const candidate = await this.findSidecar(videoRef, [".description.txt"]);
    if (!candidate) return undefined;
    try {
      const content = (await readFile(candidate, "utf8")).trim();
      return content || undefined;
    } catch {
      return undefined;
    }
  }
}

/** Registry-compatible local source entry point. */
export class LocalVideoIngestor implements MediaSourceIngestor {
  public constructor(private readonly options: Omit<LocalVideoSourceOptions, "videoId"> = {}) {}

  supports(source: MediaSource): boolean {
    return source.kind === "local";
  }

  ingest(source: MediaSource): Promise<IngestedMedia> {
    return new LocalVideoSource(source, this.options).ingest();
  }
}

function decorateOriginalCues(cues: readonly SubtitleCue[], ref: string): SubtitleCue[] {
  return normalizeCues(cues).map((cue) => ({
    ...cue,
    metadata: { ...cue.metadata, ref, source: "original" },
  }));
}

function normalizeCues(cues: readonly SubtitleCue[]): SubtitleCue[] {
  return cues
    .map((cue, index) => ({
      ...cue,
      id: cue.id ?? `subtitle-${index}`,
      start: Number(cue.start),
      end: Number(cue.end),
      content: cue.content.trim(),
    }))
    .filter(
      (cue) =>
        Number.isFinite(cue.start) &&
        cue.start >= 0 &&
        Number.isFinite(cue.end) &&
        cue.end >= cue.start &&
        cue.content.length > 0,
    );
}

async function readMetadataSidecar(videoRef: string): Promise<Record<string, unknown>> {
  const parsed = parse(videoRef);
  const candidate = join(parsed.dir, `${parsed.name}.metadata.json`);
  try {
    const raw = JSON.parse(await readFile(candidate, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function asrCacheKey(videoId: string, videoRef: string, language?: string): Promise<string> {
  let version = "missing";
  try {
    const info = await stat(videoRef);
    version = `${info.size}:${info.mtimeMs}`;
  } catch {
    // A caller may use a virtual/remote local mount. The source identity still
    // gives a stable cache key in that case.
  }
  return `asr:${videoId}:${createHash("sha256").update(`${videoRef}:${version}:${language ?? ""}`).digest("hex")}`;
}

function makeVideoId(videoRef: string): string {
  const stem = basename(videoRef, extname(videoRef))
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/giu, "-")
    .replace(/^-+|-+$/g, "") || "video";
  const suffix = createHash("sha1").update(videoRef).digest("hex").slice(0, 10);
  return `${stem}-${suffix}`;
}

function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function firstDefined(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

function metadataString(source: MediaSource, key: string): string | undefined {
  const value = source.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const PURE_AUDIO_EXTENSIONS = new Set([
  ".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac", ".aiff",
]);

function isPureAudio(path: string): boolean {
  return PURE_AUDIO_EXTENSIONS.has(extname(path).toLowerCase());
}

function mediaMimeType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".mov": return "video/quicktime";
    case ".mkv": return "video/x-matroska";
    case ".avi": return "video/x-msvideo";
    default: return undefined;
  }
}

function defaultCacheDirectory(videoId: string): string {
  const safeVideoId = videoId.replace(/[^A-Za-z0-9._-]+/g, "_") || "video";
  return resolve("data", safeVideoId, "cache");
}
