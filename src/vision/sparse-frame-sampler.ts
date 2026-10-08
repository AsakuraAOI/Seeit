import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { FrameReference } from "../core/types.js";
import type { FrameExtractor } from "./frame-extractor.js";

export interface SparseFrameSamplingRequest {
  videoId: string;
  videoRef: string;
  duration: number;
  /** Optional local range; omitted retains the historic whole-video behavior. */
  start?: number;
  end?: number;
  /** Defaults to data/{videoId}/frames when omitted. */
  outputDir?: string;
  intervalSeconds?: number;
  includeSceneChanges?: boolean;
  sceneChangeThreshold?: number;
  sceneMinSpacingSeconds?: number;
  maxSceneFrames?: number;
  /** Bound extracted candidates after range/scene selection. */
  maxFrames?: number;
  deduplicationThreshold?: number;
  /** Disable only in tests or one-off force refreshes. */
  useCache?: boolean;
}

export interface SparseFrameSamplingResult {
  /** The compact set which should be sent to the global vision pass. */
  representativeFrames: FrameReference[];
  /** All low-cost candidate frames before visual deduplication. */
  candidateFrames: FrameReference[];
  intervalTimes: number[];
  sceneChangeTimes: number[];
  outputDir: string;
  cacheHit: boolean;
}

export interface FrameDeduplicator {
  selectRepresentativeFrames(
    frames: readonly FrameReference[],
    threshold?: number,
  ): Promise<FrameReference[]>;
}

/**
 * Low-cost duplicate suppression. It compares adjacent sparse samples only,
 * so a later return to a scene remains available as evidence. Adapters may put
 * `perceptualHash`, `fingerprint`, or a numeric `signature` in frame metadata
 * for better similarity; a deterministic file-byte signature is the fallback.
 */
export class SimpleFrameDeduplicator implements FrameDeduplicator {
  public constructor(private readonly defaultThreshold = 0.045) {}

  async selectRepresentativeFrames(
    frames: readonly FrameReference[],
    threshold = this.defaultThreshold,
  ): Promise<FrameReference[]> {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new RangeError("deduplication threshold must be between 0 and 1.");
    }

    const ordered = [...frames].sort((left, right) => left.time - right.time);
    const retained: FrameReference[] = [];
    let previous: FrameSignature | undefined;

    for (const frame of ordered) {
      const current = await signatureFor(frame);
      if (!previous || !current || distance(previous, current) > threshold) {
        retained.push(frame);
        previous = current;
      }
    }
    return retained;
  }
}

/**
 * Sparse sampling is intentionally perception-free: it extracts a limited,
 * deduplicated set of frames but makes zero calls to a VLM. The caller can
 * then send representativeFrames in one VisionProvider.analyzeImages call.
 */
export class SparseFrameSampler {
  public constructor(
    private readonly extractor: FrameExtractor,
    private readonly deduplicator: FrameDeduplicator = new SimpleFrameDeduplicator(),
  ) {}

  async sample(
    request: SparseFrameSamplingRequest,
  ): Promise<SparseFrameSamplingResult> {
    validateRequest(request);
    const outputDir = request.outputDir
      ? resolve(request.outputDir)
      : resolve("data", request.videoId, "frames");
    const config = normalizedConfig(request);
    const cachePath = resolve(outputDir, "representative-frames.json");

    await mkdir(outputDir, { recursive: true });

    if (request.useCache !== false) {
      const cached = await readManifest(cachePath, request.videoRef, request.duration, config);
      if (cached) return { ...cached, outputDir, cacheHit: true };
    }

    const intervalTimes = intervalTimesFor(config.start, config.end, config.intervalSeconds);
    const sceneChangeTimes = config.includeSceneChanges && this.extractor.detectSceneChanges
      ? limitEvenly(
          (await this.extractor.detectSceneChanges({
            videoRef: request.videoRef,
            threshold: config.sceneChangeThreshold,
            minSpacingSeconds: config.sceneMinSpacingSeconds,
          })).filter((time) => time >= config.start && time <= config.end),
          config.maxSceneFrames,
        )
      : [];

    const timeSources = collectTimeSources(intervalTimes, sceneChangeTimes);
    const selectedTimes = config.maxFrames === undefined
      ? [...timeSources.keys()]
      : limitEvenly([...timeSources.keys()], config.maxFrames);
    const candidateFrames = await this.extractor.extractFrames({
      videoRef: request.videoRef,
      times: selectedTimes,
      outputDir,
      metadata: { sampling: "sparse" },
    });
    const annotatedCandidates = candidateFrames
      .map((frame) => annotateFrame(frame, timeSources.get(frame.time) ?? ["interval"]))
      .sort((left, right) => left.time - right.time);
    const representativeFrames = await this.deduplicator.selectRepresentativeFrames(
      annotatedCandidates,
      config.deduplicationThreshold,
    );

    const result: SparseFrameSamplingResult = {
      representativeFrames,
      candidateFrames: annotatedCandidates,
      intervalTimes,
      sceneChangeTimes,
      outputDir,
      cacheHit: false,
    };
    if (request.useCache !== false) {
      await writeManifest(cachePath, request.videoRef, request.duration, config, result);
    }
    return result;
  }
}

interface NormalizedSamplingConfig {
  start: number;
  end: number;
  intervalSeconds: number;
  includeSceneChanges: boolean;
  sceneChangeThreshold: number;
  sceneMinSpacingSeconds: number;
  maxSceneFrames: number;
  maxFrames?: number;
  deduplicationThreshold: number;
}

interface SamplingManifest {
  version: 1;
  videoRef: string;
  duration: number;
  config: NormalizedSamplingConfig;
  result: Omit<SparseFrameSamplingResult, "outputDir" | "cacheHit">;
}

type FrameSignature =
  | { kind: "numbers"; values: number[] }
  | { kind: "bits"; value: string }
  | { kind: "text"; value: string };

function normalizedConfig(request: SparseFrameSamplingRequest): NormalizedSamplingConfig {
  const start = request.start ?? 0;
  const end = request.end ?? request.duration;
  return {
    start,
    end,
    intervalSeconds: request.intervalSeconds ?? 2,
    includeSceneChanges: request.includeSceneChanges ?? false,
    sceneChangeThreshold: request.sceneChangeThreshold ?? 0.35,
    sceneMinSpacingSeconds: request.sceneMinSpacingSeconds ?? 0.5,
    maxSceneFrames: request.maxSceneFrames ?? 80,
    ...(request.maxFrames === undefined ? {} : { maxFrames: request.maxFrames }),
    deduplicationThreshold: request.deduplicationThreshold ?? 0.045,
  };
}

function validateRequest(request: SparseFrameSamplingRequest): void {
  if (!request.videoId.trim()) throw new Error("videoId is required for sparse sampling.");
  if (!request.videoRef.trim()) throw new Error("videoRef is required for sparse sampling.");
  if (!Number.isFinite(request.duration) || request.duration < 0) {
    throw new RangeError("duration must be a finite, non-negative number.");
  }
  const config = normalizedConfig(request);
  if (!Number.isFinite(config.start) || !Number.isFinite(config.end) || config.start < 0 || config.end > request.duration || config.end <= config.start) {
    throw new RangeError("sampling start/end must be a non-degenerate range inside duration.");
  }
  if (!Number.isFinite(config.intervalSeconds) || config.intervalSeconds <= 0) {
    throw new RangeError("intervalSeconds must be greater than zero.");
  }
  if (!Number.isFinite(config.sceneChangeThreshold) || config.sceneChangeThreshold <= 0 || config.sceneChangeThreshold >= 1) {
    throw new RangeError("sceneChangeThreshold must be between 0 and 1.");
  }
  if (!Number.isFinite(config.sceneMinSpacingSeconds) || config.sceneMinSpacingSeconds < 0) {
    throw new RangeError("sceneMinSpacingSeconds must be non-negative.");
  }
  if (!Number.isInteger(config.maxSceneFrames) || config.maxSceneFrames < 0) {
    throw new RangeError("maxSceneFrames must be a non-negative integer.");
  }
  if (config.maxFrames !== undefined && (!Number.isInteger(config.maxFrames) || config.maxFrames < 1)) {
    throw new RangeError("maxFrames must be a positive integer when provided.");
  }
}

function intervalTimesFor(start: number, end: number, intervalSeconds: number): number[] {
  const times: number[] = [];
  for (let time = start; time < end; time += intervalSeconds) {
    // Limit precision so equivalent interval/scene timestamps merge reliably.
    times.push(Number(time.toFixed(3)));
  }
  if (times.length === 0) times.push(Number(((start + end) / 2).toFixed(3)));
  return times;
}

function collectTimeSources(
  intervalTimes: readonly number[],
  sceneTimes: readonly number[],
): Map<number, Array<"interval" | "scene-change">> {
  const sources = new Map<number, Array<"interval" | "scene-change">>();
  const add = (time: number, source: "interval" | "scene-change") => {
    const normalized = Number(time.toFixed(3));
    const list = sources.get(normalized) ?? [];
    if (!list.includes(source)) list.push(source);
    sources.set(normalized, list);
  };
  intervalTimes.forEach((time) => add(time, "interval"));
  sceneTimes.forEach((time) => add(time, "scene-change"));
  return new Map([...sources.entries()].sort(([left], [right]) => left - right));
}

function annotateFrame(
  frame: FrameReference,
  sources: readonly ("interval" | "scene-change")[],
): FrameReference {
  return {
    ...frame,
    metadata: {
      ...frame.metadata,
      sampleSources: [...sources],
    },
  };
}

function limitEvenly(times: readonly number[], maximum: number): number[] {
  const unique = [...new Set(times.map((time) => Number(time.toFixed(3))))]
    .filter((time) => Number.isFinite(time) && time >= 0)
    .sort((left, right) => left - right);
  if (maximum === 0) return [];
  if (unique.length <= maximum) return unique;
  return Array.from({ length: maximum }, (_, index) => {
    const sourceIndex = Math.round((index * (unique.length - 1)) / (maximum - 1 || 1));
    return unique[sourceIndex];
  });
}

async function signatureFor(frame: FrameReference): Promise<FrameSignature | undefined> {
  const metadataSignature = readMetadataSignature(frame.metadata);
  if (metadataSignature) return metadataSignature;

  try {
    const bytes = await readFile(frame.ref);
    if (bytes.length === 0) return undefined;
    return { kind: "numbers", values: compactByteSignature(bytes) };
  } catch {
    // A remote/non-file reference is still valid input for a vision provider.
    // Do not discard it merely because the local deduplicator cannot read it.
    return undefined;
  }
}

function readMetadataSignature(
  metadata: Record<string, unknown> | undefined,
): FrameSignature | undefined {
  const candidate = metadata?.perceptualHash ?? metadata?.fingerprint ?? metadata?.signature;
  if (Array.isArray(candidate) && candidate.every((value) => typeof value === "number")) {
    return { kind: "numbers", values: candidate as number[] };
  }
  if (typeof candidate !== "string" || !candidate) return undefined;
  const compact = candidate.replace(/\s/g, "");
  return /^[01]+$/.test(compact)
    ? { kind: "bits", value: compact }
    : { kind: "text", value: compact };
}

function compactByteSignature(bytes: Uint8Array): number[] {
  const bucketCount = 64;
  const values: number[] = [];
  // Skip a small header region when possible; otherwise this still detects exact
  // duplicates and often suppresses near-identical image encodes cheaply.
  const start = Math.min(64, Math.max(0, bytes.length - 1));
  const usable = bytes.subarray(start);
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const from = Math.floor((bucket * usable.length) / bucketCount);
    const to = Math.max(from + 1, Math.floor(((bucket + 1) * usable.length) / bucketCount));
    let total = 0;
    for (let index = from; index < Math.min(to, usable.length); index += 1) total += usable[index];
    values.push(total / Math.max(1, Math.min(to, usable.length) - from));
  }
  return values;
}

function distance(left: FrameSignature, right: FrameSignature): number {
  if (left.kind === "numbers" && right.kind === "numbers") {
    if (left.values.length !== right.values.length || left.values.length === 0) return 1;
    return left.values.reduce(
      (total, value, index) => total + Math.abs(value - right.values[index]) / 255,
      0,
    ) / left.values.length;
  }
  if (left.kind === "bits" && right.kind === "bits") {
    if (left.value.length !== right.value.length || left.value.length === 0) return 1;
    let differing = 0;
    for (let index = 0; index < left.value.length; index += 1) {
      if (left.value[index] !== right.value[index]) differing += 1;
    }
    return differing / left.value.length;
  }
  return left.kind === "text" && right.kind === "text" && left.value === right.value
    ? 0
    : 1;
}

async function readManifest(
  path: string,
  videoRef: string,
  duration: number,
  config: NormalizedSamplingConfig,
): Promise<Omit<SparseFrameSamplingResult, "outputDir" | "cacheHit"> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as SamplingManifest;
    if (
      parsed.version !== 1 ||
      parsed.videoRef !== videoRef ||
      parsed.duration !== duration ||
      JSON.stringify(parsed.config) !== JSON.stringify(config) ||
      !(await allFramesExist(parsed.result.representativeFrames))
    ) {
      return undefined;
    }
    return parsed.result;
  } catch {
    return undefined;
  }
}

async function allFramesExist(frames: readonly FrameReference[]): Promise<boolean> {
  try {
    await Promise.all(frames.map((frame) => access(frame.ref)));
    return true;
  } catch {
    return false;
  }
}

async function writeManifest(
  path: string,
  videoRef: string,
  duration: number,
  config: NormalizedSamplingConfig,
  result: SparseFrameSamplingResult,
): Promise<void> {
  const manifest: SamplingManifest = {
    version: 1,
    videoRef,
    duration,
    config,
    result: {
      representativeFrames: result.representativeFrames,
      candidateFrames: result.candidateFrames,
      intervalTimes: result.intervalTimes,
      sceneChangeTimes: result.sceneChangeTimes,
    },
  };
  try {
    await writeFile(path, JSON.stringify(manifest, undefined, 2), "utf8");
  } catch {
    // Frame extraction remains useful if a caller gave a non-writable cache
    // directory. The source video must never be invalidated because caching failed.
  }
}
