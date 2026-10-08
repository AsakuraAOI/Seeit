import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  EvidenceRef,
  FrameReference,
  TimelineItem,
  VideoTimeline,
  VisualObservation,
} from "../core/types.js";
import type { VisionProvider } from "../providers/interfaces.js";
import {
  TimelineRetriever,
  timelineItemToEvidence,
  type TimelineReadable,
} from "../retrieval/timeline-retriever.js";
import {
  frameOutputPath,
  type ClipReference,
  type FrameExtractor,
} from "../vision/frame-extractor.js";

export const AGENT_TOOL_NAMES = [
  "search",
  "readAround",
  "getFrame",
  "getFrames",
  "getClip",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export const MAX_TOOL_FRAMES = 12;

export interface ToolObservation {
  tool: AgentToolName;
  summary: string;
  evidence: EvidenceRef[];
  timelineItems?: TimelineItem[];
  frames?: FrameReference[];
  clip?: ClipReference;
  visual?: VisualObservation;
}

export interface VideoAgentToolsDependencies {
  videoId: string;
  duration: number;
  videoRef: string;
  timeline: TimelineReadable | VideoTimeline;
  frameExtractor: FrameExtractor;
  vision?: VisionProvider;
  /** Defaults to data/{videoId}/cache, matching filesystem storage layout. */
  cacheDir?: string;
  /** Persist successful active visual evidence into the owning system state. */
  onVisualObservation?: (observation: ToolObservation) => Promise<void> | void;
}

interface CachedToolObservation {
  key: string;
  observation: ToolObservation;
}

export class ToolUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ToolUnavailableError";
  }
}

/**
 * The complete agent tool surface. It has exactly the five operations the
 * ReAct agent is allowed to invoke; video/vision details stay behind it.
 */
export class VideoAgentTools {
  private readonly retriever: TimelineRetriever;
  private readonly cache = new Map<string, Promise<ToolObservation>>();
  private readonly cacheDir: string;

  public constructor(private readonly dependencies: VideoAgentToolsDependencies) {
    if (!dependencies.videoId.trim()) throw new TypeError("videoId is required.");
    if (!dependencies.videoRef.trim()) throw new TypeError("videoRef is required.");
    if (!Number.isFinite(dependencies.duration) || dependencies.duration <= 0) {
      throw new RangeError("duration must be a positive number of seconds.");
    }
    this.retriever = new TimelineRetriever(dependencies.timeline);
    this.cacheDir = dependencies.cacheDir
      ? resolve(dependencies.cacheDir)
      : resolve("data", safePathSegment(dependencies.videoId), "cache");
  }

  /** Search subtitle, description, danmaku, and OCR/text timeline entries. */
  public async search(query: string): Promise<ToolObservation> {
    const safeQuery = requireNonEmpty(query, "query");
    const matches = this.retriever.search(safeQuery, 20);
    const items = matches.map((match) => match.item);
    return {
      tool: "search",
      summary: items.length
        ? `Found ${items.length} matching timeline items for “${safeQuery}”.`
        : `No timeline text matched “${safeQuery}”.`,
      evidence: matches.map((match) => match.evidence),
      timelineItems: items,
    };
  }

  /** Read retained timeline evidence near an absolute video timestamp. */
  public async readAround(time: number, radius = 15): Promise<ToolObservation> {
    const safeTime = this.time(time, "time");
    const safeRadius = finiteNonNegative(radius, "radius");
    const items = this.retriever.readAround(safeTime, safeRadius);
    return {
      tool: "readAround",
      summary: items.length
        ? `Read ${items.length} timeline items around ${safeTime.toFixed(2)}s.`
        : `No retained timeline items around ${safeTime.toFixed(2)}s.`,
      evidence: items.map(timelineItemToEvidence),
      timelineItems: items,
    };
  }

  /** Extract and, when configured, visually analyze one frame. */
  public async getFrame(time: number): Promise<ToolObservation> {
    // Seek positions must stay strictly inside the video duration.
    const safeTime = frameTime(this.time(time, "time"), this.dependencies.duration);
    return this.cached(
      this.observationCacheKey("getFrame", { time: safeTime }),
      "getFrame",
      async () => {
        const frame = await this.dependencies.frameExtractor.extractFrame({
          videoRef: this.dependencies.videoRef,
          time: safeTime,
          outputPath: frameOutputPath(resolve(this.cacheDir, "agent-frames"), safeTime),
        });
        const visual = await this.analyzeFrames([frame], safeTime, safeTime);
        return {
          tool: "getFrame",
          summary: visual
            ? visualSummary(visual)
            : `Extracted frame at ${safeTime.toFixed(2)}s; no vision provider is configured.`,
          evidence: visualEvidence(visual, "frame", safeTime, safeTime, frame.ref),
          frames: [frame],
          ...(visual ? { visual } : {}),
        };
      },
    );
  }

  /** Uniformly sample a local interval and analyze the batch in one VLM call. */
  public async getFrames(
    start: number,
    end: number,
    count: number,
  ): Promise<ToolObservation> {
    // Frame seeks must stay strictly inside the video duration.
    const duration = this.dependencies.duration;
    const [checkedStart, checkedEnd] = this.range(start, end);
    const safeStart = frameTime(checkedStart, duration);
    const safeEnd = Math.max(frameTime(checkedEnd, duration), safeStart);
    if (!Number.isInteger(count) || count < 1 || count > MAX_TOOL_FRAMES) {
      throw new RangeError(`count must be an integer from 1 to ${MAX_TOOL_FRAMES}.`);
    }
    return this.cached(
      this.observationCacheKey("getFrames", { start: safeStart, end: safeEnd, count }),
      "getFrames",
      async () => {
        const times = uniformTimes(safeStart, safeEnd, count);
        const frames = await this.dependencies.frameExtractor.extractFrames({
          videoRef: this.dependencies.videoRef,
          times,
          outputDir: resolve(this.cacheDir, "agent-frames"),
        });
        const visual = await this.analyzeFrames(frames, safeStart, safeEnd);
        return {
          tool: "getFrames",
          summary: visual
            ? visualSummary(visual)
            : `Extracted ${frames.length} frames from ${safeStart.toFixed(2)}s to ${safeEnd.toFixed(2)}s; no vision provider is configured.`,
          evidence: visualEvidence(visual, "frame", safeStart, safeEnd, frames[0]?.ref),
          frames,
          ...(visual ? { visual } : {}),
        };
      },
    );
  }

  /** Extract a local clip and use clip analysis only if the provider supports it. */
  public async getClip(start: number, end: number): Promise<ToolObservation> {
    const [safeStart, safeEnd] = this.range(start, end);
    return this.cached(
      this.observationCacheKey("getClip", { start: safeStart, end: safeEnd }),
      "getClip",
      async () => {
        const extractor = this.dependencies.frameExtractor;
        if (!extractor.extractClip) {
          throw new ToolUnavailableError("getClip is unavailable because this media adapter cannot extract clips.");
        }
        const clip = await extractor.extractClip({
          videoRef: this.dependencies.videoRef,
          start: safeStart,
          end: safeEnd,
          outputPath: resolve(
            this.cacheDir,
            "agent-clips",
            `clip-${timeSlug(safeStart)}-${timeSlug(safeEnd)}.mp4`,
          ),
        });
        const vision = this.dependencies.vision;
        const visual = vision?.analyzeClip
          ? await vision.analyzeClip({
              videoId: this.dependencies.videoId,
              clip: { ref: clip.ref, start: safeStart, end: safeEnd },
              instruction: "Describe only salient events and visual facts needed to answer a local video question.",
            })
          : undefined;

        return {
          tool: "getClip",
          summary: visual
            ? visualSummary(visual)
            : `Extracted clip from ${safeStart.toFixed(2)}s to ${safeEnd.toFixed(2)}s; clip analysis is not supported by the current vision provider.`,
          evidence: visualEvidence(visual, "clip", safeStart, safeEnd, clip.ref),
          clip,
          ...(visual ? { visual } : {}),
        };
      },
    );
  }

  private async analyzeFrames(
    frames: readonly FrameReference[],
    start: number,
    end: number,
  ): Promise<VisualObservation | undefined> {
    const vision = this.dependencies.vision;
    if (!vision) return undefined;
    return vision.analyzeImages({
      videoId: this.dependencies.videoId,
      start,
      end,
      images: frames.map((frame) => ({
        ref: frame.ref,
        time: frame.time,
        metadata: frame.metadata,
      })),
      instruction: "Describe only the salient visual evidence for the requested video time range.",
    });
  }

  private cached(
    key: string,
    tool: AgentToolName,
    operation: () => Promise<ToolObservation>,
  ): Promise<ToolObservation> {
    const existing = this.cache.get(key);
    if (existing) return existing;
    const pending = this.readPersistentObservation(key, tool)
      .then(async (persisted) => {
        if (persisted) {
          await this.persistVisualObservation(persisted);
          return persisted;
        }
        const observation = await operation();
        // Caching is an optimization: a full/durable storage failure must not
        // discard a valid local observation that was just obtained.
        await this.writePersistentObservation(key, observation).catch(() => undefined);
        await this.persistVisualObservation(observation);
        return observation;
      })
      .catch((error: unknown) => {
        this.cache.delete(key);
        throw error;
      });
    this.cache.set(key, pending);
    return pending;
  }

  private observationCacheKey(
    tool: "getFrame" | "getFrames" | "getClip",
    parameters: Record<string, number>,
  ): string {
    const payload = JSON.stringify({
      version: 1,
      videoId: this.dependencies.videoId,
      videoRef: this.dependencies.videoRef,
      tool,
      parameters: Object.fromEntries(Object.entries(parameters).map(([name, value]) => [name, canonicalToolTime(value)])),
      visualMode: {
        images: this.dependencies.vision !== undefined,
        clips: this.dependencies.vision?.analyzeClip !== undefined,
      },
    });
    return createHash("sha256").update(payload).digest("hex");
  }

  private async readPersistentObservation(
    key: string,
    tool: AgentToolName,
  ): Promise<ToolObservation | undefined> {
    try {
      const serialized = await readFile(this.observationCachePath(key), "utf8");
      const parsed = JSON.parse(serialized) as unknown;
      if (!isCachedObservation(parsed, key, tool)) return undefined;
      return parsed.observation;
    } catch {
      // Missing, partial, or legacy cache files are safe to recompute.
      return undefined;
    }
  }

  private async writePersistentObservation(
    key: string,
    observation: ToolObservation,
  ): Promise<void> {
    const path = this.observationCachePath(key);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    const payload: CachedToolObservation = { key, observation };
    try {
      await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, "utf8");
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private observationCachePath(key: string): string {
    return resolve(this.cacheDir, "agent-observations", `${key}.json`);
  }

  private async persistVisualObservation(observation: ToolObservation): Promise<void> {
    if (!observation.visual || !this.dependencies.onVisualObservation) return;
    // Persistence augments a valid answer; it must not turn a successful local
    // observation into a failed ReAct step if storage is temporarily unavailable.
    await Promise.resolve(this.dependencies.onVisualObservation(observation)).catch(() => undefined);
  }

  private time(value: number, name: string): number {
    finiteNonNegative(value, name);
    return Math.min(value, this.dependencies.duration);
  }

  private range(start: number, end: number): [number, number] {
    const safeStart = this.time(start, "start");
    const safeEnd = this.time(end, "end");
    if (safeEnd > safeStart) return [safeStart, safeEnd];
    // Clamp model-proposed boundary ranges to one seekable local interval.
    const epsilon = Math.min(0.1, this.dependencies.duration / 2);
    return [Math.max(0, safeStart - epsilon), Math.min(this.dependencies.duration, safeStart + epsilon)];
  }
}

function visualEvidence(
  visual: VisualObservation | undefined,
  type: "frame" | "clip",
  start: number,
  end: number,
  fallbackRef?: string,
): EvidenceRef[] {
  if (!visual) return [];
  if (visual.evidence && visual.evidence.length > 0) return visual.evidence;
  return [{ type, start, end, ...(fallbackRef ? { ref: fallbackRef } : {}) }];
}

function visualSummary(visual: VisualObservation): string {
  const details = [
    visual.summary,
    ...(visual.visualEvents ?? []),
    ...(visual.notableVisuals ?? []),
  ].filter((item, index, values) => item.trim() && values.indexOf(item) === index);
  return details.join(" ");
}

function uniformTimes(start: number, end: number, count: number): number[] {
  if (count === 1) return [(start + end) / 2];
  const span = end - start;
  return Array.from({ length: count }, (_, index) => start + (span * index) / (count - 1));
}

/**
 * Frame seek positions must land on an existing frame. Fast seeks resolve to
 * the next frame at or after the position, so a position inside the trailing
 * gap (duration - last frame) yields no frame; keep a 0.1s margin.
 */
function frameTime(value: number, duration: number): number {
  return Math.min(Math.max(0, duration - 0.1), Math.max(0, value));
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function requireNonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_") || "video";
}

function timeSlug(value: number): string {
  return value.toFixed(3).replace(".", "_");
}

function canonicalToolTime(value: number): number {
  return Math.round(value * 10) / 10;
}

function isCachedObservation(
  value: unknown,
  key: string,
  tool: AgentToolName,
): value is CachedToolObservation {
  if (!isRecord(value) || value.key !== key || !isRecord(value.observation)) return false;
  const observation = value.observation;
  return (
    observation.tool === tool &&
    typeof observation.summary === "string" &&
    Array.isArray(observation.evidence) &&
    observation.evidence.every(isEvidenceRef)
  );
}

function isEvidenceRef(value: unknown): value is EvidenceRef {
  if (!isRecord(value) || !["subtitle", "description", "danmaku", "frame", "clip"].includes(String(value.type))) {
    return false;
  }
  return (
    (value.start === undefined || (typeof value.start === "number" && Number.isFinite(value.start))) &&
    (value.end === undefined || (typeof value.end === "number" && Number.isFinite(value.end))) &&
    (value.ref === undefined || typeof value.ref === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
