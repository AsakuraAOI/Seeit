import { createHash } from "node:crypto";
import { join } from "node:path";

import type { EvidenceRef, FrameReference, VisualObservation } from "../core/types.js";
import type { VisionProvider } from "../providers/interfaces.js";
import type { VideoStorage } from "../storage/video-storage.js";
import type { FrameExtractor } from "../vision/frame-extractor.js";
import { frameOutputPath } from "../vision/frame-extractor.js";
import type { SparseFrameSampler } from "../vision/sparse-frame-sampler.js";
import { estimateFrames, normalizeRequest } from "./planner.js";
import { normalizePerceptionBudget } from "./policy.js";
import type {
  PerceptionBudget,
  PerceptionExecutionResult,
  PerceptionRequest,
} from "./types.js";

export const MAX_FRAMES_PER_VISION_BATCH = 24;

export interface PerceptionExecutorDependencies {
  videoId: string;
  duration: number;
  videoRef: string;
  frameExtractor: FrameExtractor;
  frameSampler: Pick<SparseFrameSampler, "sample">;
  storage: VideoStorage;
  vision?: VisionProvider;
  instruction?: string;
}

export interface PerceptionExecutorInput {
  requests: readonly PerceptionRequest[];
  budget?: Partial<PerceptionBudget>;
  /** State observations save a storage round trip and support equivalent ranges. */
  existingObservations?: readonly VisualObservation[];
}

/** Executes only a planner-approved finite request list and records provenance. */
export class PerceptionExecutor {
  public constructor(private readonly dependencies: PerceptionExecutorDependencies) {}

  public async execute(input: PerceptionExecutorInput): Promise<PerceptionExecutionResult> {
    const budget = normalizePerceptionBudget(input.budget);
    if (!this.dependencies.vision || input.requests.length === 0) {
      return emptyResult();
    }
    const observations: VisualObservation[] = [];
    const executedRequests: PerceptionRequest[] = [];
    let cacheHits = 0;
    let framesExtracted = 0;
    let visionBatches = 0;
    let visualSeconds = 0;
    const requests = input.requests
      .map((request, index) => normalizeRequest(request, this.dependencies.duration, index))
      .filter((request): request is PerceptionRequest => request !== undefined)
      .sort((left, right) => right.priority - left.priority || left.start - right.start || left.end - right.end);
    for (const request of requests) {
      if (executedRequests.length >= budget.maxRequests) break;
      const remainingFrames = budget.maxFrames - framesExtracted;
      const requestSeconds = request.end - request.start;
      if (remainingFrames <= 0) break;
      if (
        estimateFrames(request) > remainingFrames ||
        (budget.maxVisualSeconds !== undefined && visualSeconds + requestSeconds > budget.maxVisualSeconds)
      ) continue;
      const key = perceptionRequestKey(this.dependencies.videoRef, request);
      const existing = findEquivalentObservation(input.existingObservations ?? [], key)
        ?? await this.dependencies.storage.getCache<VisualObservation>(this.dependencies.videoId, visionCacheKey(key));
      if (existing) {
        observations.push(withProvenance(existing, request, key));
        executedRequests.push(request);
        cacheHits += 1;
        visualSeconds += requestSeconds;
        continue;
      }
      const outcome = await this.executeRequest(request, key, remainingFrames);
      if (!outcome) continue;
      const observation = withProvenance(outcome.observation, request, key);
      await this.dependencies.storage.setCache(this.dependencies.videoId, visionCacheKey(key), observation);
      observations.push(observation);
      executedRequests.push(request);
      framesExtracted += outcome.framesExtracted;
      visionBatches += outcome.visionBatches;
      visualSeconds += requestSeconds;
    }
    return { observations, executedRequests, cacheHits, framesExtracted, visionBatches };
  }

  private async executeRequest(
    request: PerceptionRequest,
    key: string,
    remainingFrames: number,
  ): Promise<{ observation: VisualObservation; framesExtracted: number; visionBatches: number } | undefined> {
    const vision = this.dependencies.vision;
    if (!vision) return undefined;
    if (request.modality === "clip" && this.dependencies.frameExtractor.extractClip && vision.analyzeClip) {
      const clip = await this.dependencies.frameExtractor.extractClip({
        videoRef: this.dependencies.videoRef,
        start: request.start,
        end: request.end,
        outputPath: join(this.dependencies.storage.getCacheDir(this.dependencies.videoId), "perception-clips", `${perceptionCacheDirectoryName(key)}.mp4`),
      });
      const observation = await vision.analyzeClip({
        videoId: this.dependencies.videoId,
        clip: { ref: clip.ref, start: request.start, end: request.end },
        instruction: instructionFor(request, this.dependencies.instruction),
        metadata: { perceptionRequestId: request.id, perceptionKey: key },
      });
      return { observation: withSourceRef(observation, clip.ref), framesExtracted: 0, visionBatches: 1 };
    }

    const frames = request.modality === "frame"
      ? [await this.dependencies.frameExtractor.extractFrame({
          videoRef: this.dependencies.videoRef,
          time: frameTime((request.start + request.end) / 2, this.dependencies.duration),
          outputPath: frameOutputPath(
            join(this.dependencies.storage.getCacheDir(this.dependencies.videoId), "perception-frames"),
            frameTime((request.start + request.end) / 2, this.dependencies.duration),
          ),
          metadata: { perceptionRequestId: request.id, perceptionKey: key },
        })]
      : await this.extractLocalFrames(request, key, remainingFrames);
    if (frames.length === 0) return undefined;
    const result = await analyzeImageBatches(
      vision,
      this.dependencies.videoId,
      frames,
      request,
      this.dependencies.instruction,
    );
    return { observation: withSourceRef(result.observation, frames[0]?.ref), framesExtracted: frames.length, visionBatches: result.batches };
  }

  private async extractLocalFrames(
    request: PerceptionRequest,
    key: string,
    remainingFrames: number,
  ): Promise<FrameReference[]> {
    const desired = Math.min(estimateFrames(request), remainingFrames);
    const result = await this.dependencies.frameSampler.sample({
      videoId: this.dependencies.videoId,
      videoRef: this.dependencies.videoRef,
      duration: this.dependencies.duration,
      start: request.start,
      end: request.end,
      maxFrames: desired,
      // Scene changes are collected once by VisualProfile. Re-running a
      // full-video detector for every local request would defeat selectivity.
      includeSceneChanges: false,
      outputDir: join(
        this.dependencies.storage.getCacheDir(this.dependencies.videoId),
        "perception-frames",
        perceptionCacheDirectoryName(key),
      ),
    });
    return result.representativeFrames.slice(0, desired);
  }
}

export function perceptionRequestKey(videoRef: string, request: Pick<PerceptionRequest, "modality" | "start" | "end">): string {
  // 100 ms bins safely unify equivalent seeks such as 100.0 and 100.02.
  return `${request.modality}:${videoRef}:${quantize(request.start)}:${quantize(request.end)}`;
}

/** Filesystem-safe addressing for a descriptive cache key that may contain a Windows path. */
export function perceptionCacheDirectoryName(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function visionCacheKey(key: string): string {
  return `perception:vision:v1:${key}`;
}

function findEquivalentObservation(observations: readonly VisualObservation[], key: string): VisualObservation | undefined {
  return observations.find((observation) => observation.metadata?.perceptionKey === key);
}

async function analyzeImageBatches(
  vision: VisionProvider,
  videoId: string,
  frames: readonly FrameReference[],
  request: PerceptionRequest,
  extraInstruction: string | undefined,
): Promise<{ observation: VisualObservation; batches: number }> {
  const observations: VisualObservation[] = [];
  for (let index = 0; index < frames.length; index += MAX_FRAMES_PER_VISION_BATCH) {
    const batch = frames.slice(index, index + MAX_FRAMES_PER_VISION_BATCH);
    observations.push(await vision.analyzeImages({
      videoId,
      start: Math.min(...batch.map((frame) => frame.time)),
      end: Math.max(...batch.map((frame) => frame.time)),
      images: batch.map((frame) => ({ time: frame.time, ref: frame.ref, ...(frame.metadata ? { metadata: frame.metadata } : {}) })),
      instruction: instructionFor(request, extraInstruction),
      metadata: { perceptionRequestId: request.id, batch: observations.length + 1 },
    }));
  }
  return { observation: mergeObservations(observations), batches: observations.length };
}

function withProvenance(observation: VisualObservation, request: PerceptionRequest, key: string): VisualObservation {
  const fallback: EvidenceRef = {
    type: request.modality === "clip" ? "clip" : "frame",
    start: request.start,
    end: request.end,
    perceptionRequestId: request.id,
    ...(typeof observation.metadata?.sourceRef === "string" ? { ref: observation.metadata.sourceRef } : {}),
  };
  const evidence = [...(observation.evidence ?? []), fallback].map((item) => ({
    ...item,
    start: finiteInRange(item.start, request.start, request.end),
    end: finiteInRange(item.end, request.start, request.end),
    perceptionRequestId: request.id,
  }));
  return {
    ...observation,
    start: request.start,
    end: request.end,
    evidence: dedupeEvidence(evidence),
    metadata: {
      ...(observation.metadata ?? {}),
      perceptionRequestId: request.id,
      perceptionKey: key,
      modality: request.modality,
      purpose: request.purpose,
    },
  };
}

function withSourceRef(observation: VisualObservation, sourceRef: string | undefined): VisualObservation {
  return {
    ...observation,
    metadata: { ...(observation.metadata ?? {}), ...(sourceRef ? { sourceRef } : {}) },
  };
}

function mergeObservations(observations: readonly VisualObservation[]): VisualObservation {
  if (observations.length === 1) return observations[0]!;
  const all = <T,>(read: (observation: VisualObservation) => T[] | undefined): T[] | undefined => {
    const values = observations.flatMap((observation) => read(observation) ?? []);
    return values.length ? values : undefined;
  };
  return {
    start: Math.min(...observations.map((observation) => observation.start)),
    end: Math.max(...observations.map((observation) => observation.end)),
    summary: observations.map((observation, index) => `[batch ${index + 1}] ${observation.summary}`).join("\n"),
    ...(all((observation) => observation.notableVisuals) ? { notableVisuals: all((observation) => observation.notableVisuals) } : {}),
    ...(all((observation) => observation.visualEvents) ? { visualEvents: all((observation) => observation.visualEvents) } : {}),
    ...(all((observation) => observation.contentTypeHints) ? { contentTypeHints: all((observation) => observation.contentTypeHints) } : {}),
    evidence: observations.flatMap((observation) => observation.evidence ?? []),
  };
}

function instructionFor(request: PerceptionRequest, extra: string | undefined): string {
  return [
    "Inspect only this requested visual range. Do not infer unobserved parts of the video.",
    `Purpose: ${request.purpose}.`,
    `Question: ${request.question}`,
    request.reason ? `Reason: ${request.reason}` : "",
    extra?.trim() ? `User focus: ${extra.trim()}` : "",
  ].filter(Boolean).join(" ");
}

function frameTime(time: number, duration: number): number {
  return Math.min(Math.max(0, duration - 0.1), Math.max(0, time));
}

function finiteInRange(value: number | undefined, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(fallback, value));
}

function quantize(time: number): string {
  return (Math.round(time * 10) / 10).toFixed(1);
}

function dedupeEvidence(evidence: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.type}:${item.ref ?? ""}:${item.start ?? ""}:${item.end ?? ""}:${item.perceptionRequestId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptyResult(): PerceptionExecutionResult {
  return { observations: [], executedRequests: [], cacheHits: 0, framesExtracted: 0, visionBatches: 0 };
}
