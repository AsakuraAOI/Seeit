import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type {
  DanmakuEntry,
  IngestedMedia,
  MediaSource,
  TimelineItem,
  VideoMetadata,
  VideoTimeline,
  VideoUnderstanding,
  VisualObservation,
} from "../core/types.js";
import type { MediaIngestService } from "../ingest/types.js";
import type { LLMProvider, VisionProvider } from "../providers/interfaces.js";
import { createStorageQaRepository, VideoQAService, type QAResult } from "../qa/video-qa.js";
import { VideoSummarizer } from "../summary/summarizer.js";
import { VideoStorage } from "../storage/video-storage.js";
import { Timeline } from "../timeline/timeline.js";
import { VideoAgentTools } from "../tools/video-agent-tools.js";
import { BaseUnderstandingService, UnderstandingEnricher } from "../understanding/index.js";
import {
  buildVisualProfile,
  normalizePerceptionBudget,
  normalizePerceptionPolicy,
  PerceptionExecutor,
  PerceptionPlanner,
  type PerceptionBudget,
  type PerceptionPolicy,
  type PerceptionState,
} from "../perception/index.js";
import type { FrameExtractor } from "../vision/frame-extractor.js";
import type { SparseFrameSampler } from "../vision/sparse-frame-sampler.js";
import { ReactAgent } from "../agent/react-agent.js";

/**
 * Only the public `ingest` operation is needed here, so tests and alternative
 * source dispatchers can be injected without coupling the system facade to a
 * concrete provider implementation.
 */
export type MediaIngestor = Pick<MediaIngestService, "ingest">;

/** The public sampling surface used by selective perception execution. */
export type FrameSampler = Pick<SparseFrameSampler, "sample">;

export interface VideoUnderstandingSystemDependencies {
  ingest: MediaIngestor;
  frameSampler: FrameSampler;
  frameExtractor: FrameExtractor;
  storage: VideoStorage;
  llm: LLMProvider;
  vision?: VisionProvider;
  /** @deprecated Use perception.budget.maxRequests; no global vision pass remains. */
  maxVisualRefinements?: number;
  /** Safe defaults are used when older callers omit this optional policy. */
  perception?: Partial<PerceptionPolicy>;
  /** Injectable diagnostics without coupling the library to a logging framework. */
  logger?: Pick<Console, "info">;
}

export interface VideoProcessingOptions {
  /** Rebuild a derived understanding even when one is already persisted. */
  force?: boolean;
  /** A focus applied to base understanding and any selective observations. */
  instruction?: string;
  /** Opt in to a full-video scene scan; skipped by default to avoid decoding the entire video. */
  includeSceneChanges?: boolean;
  /** Per-call override for the bounded deterministic perception planner. */
  perceptionBudget?: Partial<PerceptionBudget>;
  /** Per-call switch for process-time perception; QA active perception is unaffected. */
  perceptionEnabled?: boolean;
}

export type UnderstandOptions = VideoProcessingOptions;

const REPRESENTATIVE_DANMAKU_LIMIT = 80;

/**
 * The application facade that wires the deliberately small modules into the
 * intended flow: durable global understanding first, then lazy local
 * perception through finite QA plans.
 */
export class VideoUnderstandingSystem {
  private readonly summarizer: VideoSummarizer;
  private readonly qa: VideoQAService;

  public constructor(private readonly dependencies: VideoUnderstandingSystemDependencies) {
    this.summarizer = new VideoSummarizer({ llm: dependencies.llm });
    this.qa = new VideoQAService({
      repository: createStorageQaRepository(dependencies.storage),
      llm: dependencies.llm,
      getPerceptionTools: (videoId) => this.getPerceptionTools(videoId),
    });
  }

  /**
   * Ingest and globally understand one media source. When a caller supplies a
   * stable `source.videoId`, a persisted understanding is returned before any
   * ingestion, ASR, frame extraction, vision, or LLM work is started.
   */
  public async understand(
    source: MediaSource,
    options: VideoProcessingOptions = {},
  ): Promise<VideoUnderstanding> {
    const knownVideoId = sourceVideoId(source);
    if (!options.force && knownVideoId) {
      const cached = await this.dependencies.storage.readUnderstanding(knownVideoId);
      if (cached) return cached;
    }
    if (!options.force && !knownVideoId) {
      const persistedVideoId = await this.dependencies.storage.findVideoIdBySource(
        normalizedSourceForLookup(source),
      );
      if (persistedVideoId) {
        const cached = await this.dependencies.storage.readUnderstanding(persistedVideoId);
        if (cached) return cached;
      }
    }

    const media = await this.dependencies.ingest.ingest(source);

    // Some adapters discover their canonical id only while ingesting. This
    // still prevents needless sampling/VLM/LLM work after that one resolution.
    if (!options.force && media.videoId !== knownVideoId) {
      const cached = await this.dependencies.storage.readUnderstanding(media.videoId);
      if (cached) return cached;
    }

    return this.processIngestedMedia(media, options);
  }

  /** Alias for callers that prefer an explicit processing verb. */
  public async process(
    source: MediaSource,
    options: VideoProcessingOptions = {},
  ): Promise<VideoUnderstanding> {
    return this.understand(source, options);
  }

  /** Summaries only read the persistent derived understanding. */
  public async summarize(videoId: string, instruction?: string): Promise<string> {
    const understanding = await this.dependencies.storage.readUnderstanding(requireVideoId(videoId));
    if (!understanding) {
      throw new Error(`No persisted VideoUnderstanding exists for videoId: ${videoId}`);
    }
    return this.summarizer.summarize(understanding, instruction);
  }

  /** QA deliberately delegates to the persistent-understanding-first service. */
  public async ask(videoId: string, question: string): Promise<QAResult> {
    return this.qa.ask(requireVideoId(videoId), question);
  }

  /**
   * Legacy opt-in agent factory. Default QA uses getPerceptionTools directly.
   * This method never invokes ingest or global processing.
   */
  public async getReactAgent(videoId: string): Promise<ReactAgent | undefined> {
    const tools = await this.getPerceptionTools(videoId);
    return tools ? new ReactAgent({ llm: this.dependencies.llm, tools }) : undefined;
  }

  /** Finite QA perception uses media tools directly, without an agent action loop. */
  public async getPerceptionTools(videoId: string): Promise<VideoAgentTools | undefined> {
    const safeVideoId = requireVideoId(videoId);
    const [metadata, timeline] = await Promise.all([
      this.dependencies.storage.readMetadata(safeVideoId),
      this.dependencies.storage.readTimeline(safeVideoId),
    ]);
    if (!metadata || !timeline) return undefined;

    const videoRef = persistedVideoRef(metadata);
    const duration = usableDuration(metadata.duration, timeline.duration);
    if (!videoRef || duration === undefined) return undefined;

    const tools = new VideoAgentTools({
      videoId: safeVideoId,
      duration,
      videoRef,
      timeline,
      frameExtractor: this.dependencies.frameExtractor,
      ...(this.dependencies.vision ? { vision: this.dependencies.vision } : {}),
      cacheDir: this.dependencies.storage.getCacheDir(safeVideoId),
      onVisualObservation: async (observation) => this.persistActiveObservation(safeVideoId, observation),
    });
    return tools;
  }

  private async processIngestedMedia(
    media: IngestedMedia,
    options: VideoProcessingOptions,
  ): Promise<VideoUnderstanding> {
    validateIngestedMedia(media);
    const { storage } = this.dependencies;
    await storage.initialize(media.videoId);
    const previousState = await storage.readPerceptionState(media.videoId);

    // Persist original evidence before any model call. A failed visual or LLM
    // request must not make the source transcript/metadata disappear.
    await Promise.all([
      storage.writeMetadata(media.videoId, metadataFromMedia(media)),
      storage.writeTranscript(media.videoId, media.transcript ?? { cues: [] }),
      storage.writeDanmaku(media.videoId, media.danmaku ?? []),
    ]);

    this.log("[process] building cheap textual timeline");
    const timeline = buildTextTimeline(media);
    for (const observation of previousState?.observations ?? []) {
      addVisualObservationToTimeline(timeline, observation, media.duration, "persisted-visual");
    }
    await storage.writeTimeline(media.videoId, timeline.toJSON());

    const profile = (options.includeSceneChanges && previousState?.visualProfile?.sceneDetectionPerformed !== true
      ? undefined : previousState?.visualProfile) ?? await buildVisualProfile({
      duration: media.duration,
      videoRef: media.video.ref,
      frameExtractor: this.dependencies.frameExtractor,
      detectSceneChanges: options.includeSceneChanges ?? false,
    });
    this.log(`[perception] visual profile: sceneChangeRate=${profile.sceneChangeRate.toFixed(4)}`);

    this.log("[process] building base understanding");
    const base = await new BaseUnderstandingService({ llm: this.dependencies.llm }).build({
      videoId: media.videoId,
      duration: media.duration,
      ...(media.title ? { title: media.title } : {}),
      ...(media.description ? { description: media.description } : {}),
      ...(media.transcript ? { transcript: media.transcript } : {}),
      danmaku: representativeDanmaku(media.danmaku ?? []),
      timeline: timeline.toJSON(),
      visualProfile: profile,
      ...(options.instruction?.trim() ? { instruction: options.instruction.trim() } : {}),
    });
    // A failed optional perception stage must leave a usable durable base.
    await storage.writeUnderstanding(media.videoId, base.understanding);
    const policy = normalizePerceptionPolicy({
      ...(this.dependencies.perception ?? {}),
      budget: normalizePerceptionBudget({
        ...(this.dependencies.perception?.budget ?? {}),
        ...(options.perceptionBudget ?? {}),
      }),
    });
    const plan = new PerceptionPlanner().plan({
      duration: media.duration,
      understanding: base.understanding,
      candidates: base.perceptionRequests,
      transcript: media.transcript,
      timeline: timeline.toJSON(),
      visualProfile: profile,
      budget: policy.budget,
      enabled: options.perceptionEnabled ?? policy.enabled,
    });
    this.log(`[perception] planner generated ${plan.generatedCount} requests; executing ${plan.requests.length} under budget`);
    let execution = {
      observations: [] as VisualObservation[], executedRequests: [] as import("../perception/types.js").PerceptionRequest[], cacheHits: 0, framesExtracted: 0, visionBatches: 0,
    };
    if (plan.requests.length > 0 && (options.perceptionEnabled ?? policy.enabled) && this.dependencies.vision) {
      execution = await new PerceptionExecutor({
        videoId: media.videoId,
        duration: media.duration,
        videoRef: media.video.ref,
        frameExtractor: this.dependencies.frameExtractor,
        frameSampler: this.dependencies.frameSampler,
        storage,
        vision: this.dependencies.vision,
        ...(options.instruction?.trim() ? { instruction: options.instruction.trim() } : {}),
      }).execute({
        requests: plan.requests,
        budget: policy.budget,
        existingObservations: previousState?.observations,
      });
    } else {
      this.log("[perception] no visual perception required");
    }
    for (const observation of execution.observations) {
      addVisualObservationToTimeline(timeline, observation, media.duration, "perception");
    }
    const unresolved = dedupeUnresolved([
      ...removeResolvedUnresolved(base.understanding.unresolved ?? [], execution.executedRequests),
      ...plan.deferred,
      ...plan.requests
        .filter((request) => !execution.executedRequests.some((executed) => executed.id === request.id))
        .map((request) => ({ question: request.question, reason: "Visual perception was not available or did not produce evidence.", start: request.start, end: request.end, priority: request.priority })),
    ]);
    const observations = dedupeObservations([...(previousState?.observations ?? []), ...execution.observations]);
    const executedRequests = mergeExecutedRequests(
      previousState?.executedRequests ?? [],
      execution.executedRequests,
    );
    const { unresolved: _baseUnresolved, ...baseWithoutUnresolved } = base.understanding;
    const understandingBeforeEnrichment: VideoUnderstanding = {
      ...baseWithoutUnresolved,
      ...(unresolved.length ? { unresolved } : {}),
    };
    const finalUnderstanding = execution.observations.length > 0
      ? await new UnderstandingEnricher({ llm: this.dependencies.llm }).enrich({
          base: understandingBeforeEnrichment,
          observations: execution.observations,
        })
      : understandingBeforeEnrichment;
    const state: PerceptionState = {
      version: 1,
      videoId: media.videoId,
      visualProfile: profile,
      candidateRequests: base.perceptionRequests,
      plannedRequests: plan.requests,
      executedRequests,
      observations,
      unresolved,
      stats: {
        generatedRequests: plan.generatedCount,
        plannedRequests: plan.requests.length,
        executedRequests: executedRequests.length,
        deferredRequests: unresolved.length,
        framesExtracted: execution.framesExtracted,
        visionBatches: execution.visionBatches,
        cacheHits: execution.cacheHits,
      },
    };
    await Promise.all([
      storage.writeTimeline(media.videoId, timeline.toJSON()),
      storage.writePerceptionState(media.videoId, state),
      storage.writeUnderstanding(media.videoId, finalUnderstanding),
    ]);
    this.log(`[understanding] persisted ${finalUnderstanding.status ?? "base"} understanding with ${execution.observations.length} new visual observations`);
    return finalUnderstanding;
  }

  private log(message: string): void {
    (this.dependencies.logger ?? console).info(message);
  }

  private async persistActiveObservation(
    videoId: string,
    observation: import("../tools/video-agent-tools.js").ToolObservation,
  ): Promise<void> {
    if (!observation.visual) return;
    const [state, persistedTimeline, understanding] = await Promise.all([
      this.dependencies.storage.readPerceptionState(videoId),
      this.dependencies.storage.readTimeline(videoId),
      this.dependencies.storage.readUnderstanding(videoId),
    ]);
    if (!persistedTimeline) return;
    const identity = activeObservationIdentity(observation);
    const requestId = `active-${identity}`;
    const visual: VisualObservation = {
      ...observation.visual,
      evidence: (observation.visual.evidence?.length ? observation.visual.evidence : observation.evidence).map((evidence) => ({
        ...evidence,
        perceptionRequestId: requestId,
      })),
      metadata: {
        ...(observation.visual.metadata ?? {}),
        perceptionRequestId: requestId,
        perceptionKey: `active:${identity}`,
        source: "qa-active-perception",
      },
    };
    const timeline = new Timeline(persistedTimeline);
    addVisualObservationToTimeline(timeline, visual, persistedTimeline.duration, "active-visual");
    const existing = state ?? emptyPerceptionState(videoId);
    const observations = dedupeObservations([...existing.observations, visual]);
    const updated: PerceptionState = {
      ...existing,
      observations,
      stats: { ...existing.stats, cacheHits: existing.stats.cacheHits },
    };
    await Promise.all([
      this.dependencies.storage.writeTimeline(videoId, timeline.toJSON()),
      this.dependencies.storage.writePerceptionState(videoId, updated),
      ...(understanding ? [new UnderstandingEnricher().enrich({ base: understanding, observations: [visual] })
        .then((enriched) => this.dependencies.storage.writeUnderstanding(videoId, enriched))] : []),
    ]);
  }
}

function metadataFromMedia(media: IngestedMedia): VideoMetadata {
  return {
    videoId: media.videoId,
    duration: media.duration,
    ...(media.title ? { title: media.title } : {}),
    ...(media.description ? { description: media.description } : {}),
    source: media.source,
    metadata: {
      ...(media.metadata ?? {}),
      // This durable ref is the sole source opened by the later local tools.
      videoRef: media.video.ref,
      ...(media.audio ? { audioRef: media.audio.ref } : {}),
    },
  };
}

/** Builds only durable textual evidence; visual observations are appended later. */
function buildTextTimeline(media: IngestedMedia): Timeline {
  const timeline = new Timeline(media.videoId, media.duration);
  const ids = new Set<string>();
  const add = (baseId: string, item: Omit<TimelineItem, "id">): void => {
    let id = baseId;
    let suffix = 1;
    while (ids.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    ids.add(id);
    timeline.add({ id, ...item });
  };

  if (media.description?.trim()) {
    add("description:0", {
      type: "description",
      start: 0,
      end: media.duration,
      content: media.description.trim(),
      ref: "metadata:description",
      metadata: { provenance: "description" },
    });
  }

  for (const [index, cue] of (media.transcript?.cues ?? []).entries()) {
    const range = normalizedRange(cue.start, cue.end, media.duration);
    if (!range || !cue.content.trim()) continue;
    add(cue.id ?? `subtitle:${index}`, {
      type: "subtitle",
      start: range.start,
      end: range.end,
      content: cue.content.trim(),
      ...(referenceFromMetadata(cue.metadata) ?? referenceFromMetadata(media.transcript?.metadata)
        ? {
            ref: referenceFromMetadata(cue.metadata) ?? referenceFromMetadata(media.transcript?.metadata),
          }
        : {}),
      metadata: {
        ...(cue.metadata ?? {}),
        ...(media.transcript?.source ? { source: media.transcript.source } : {}),
      },
    });
  }

  for (const [index, entry] of (media.danmaku ?? []).entries()) {
    const range = normalizedRange(entry.start, entry.end ?? entry.start, media.duration);
    if (!range || !entry.content.trim()) continue;
    add(entry.id ?? `danmaku:${index}`, {
      type: "danmaku",
      start: range.start,
      ...(entry.end === undefined ? {} : { end: range.end }),
      content: entry.content.trim(),
      ...(referenceFromMetadata(entry.metadata) ? { ref: referenceFromMetadata(entry.metadata) } : {}),
      ...(entry.metadata ? { metadata: { ...entry.metadata } } : {}),
    });
  }

  return timeline;
}

function representativeDanmaku(entries: readonly DanmakuEntry[]): DanmakuEntry[] {
  const unique = entries
    .filter((entry) => entry.content.trim() && Number.isFinite(entry.start) && entry.start >= 0)
    .sort((left, right) => left.start - right.start || left.content.localeCompare(right.content))
    .filter((entry, index, values) =>
      values.findIndex((candidate) => candidate.content.trim() === entry.content.trim()) === index,
    );
  if (unique.length <= REPRESENTATIVE_DANMAKU_LIMIT) return [...unique];

  return Array.from({ length: REPRESENTATIVE_DANMAKU_LIMIT }, (_, index) => {
    const sourceIndex = Math.round((index * (unique.length - 1)) / (REPRESENTATIVE_DANMAKU_LIMIT - 1));
    return unique[sourceIndex]!;
  });
}

function ocrItemsFromObservation(
  observation: VisualObservation,
  duration: number,
): Array<Omit<TimelineItem, "id">> {
  const metadata = observation.metadata ?? {};
  const candidates = [metadata.ocr, metadata.ocrText, metadata.ocrLines]
    .flatMap((value) => (Array.isArray(value) ? value : [value]));

  return candidates.flatMap((candidate) => {
    if (typeof candidate === "string" && candidate.trim()) {
      const range = normalizedRange(observation.start, observation.end, duration);
      return range
        ? [{ type: "ocr" as const, start: range.start, end: range.end, content: candidate.trim() }]
        : [];
    }
    if (!isRecord(candidate)) return [];
    const text = stringValue(candidate.text) ?? stringValue(candidate.content);
    const range = normalizedRange(
      numberValue(candidate.start) ?? observation.start,
      numberValue(candidate.end) ?? observation.end,
      duration,
    );
    if (!text || !range) return [];
    return [{
      type: "ocr" as const,
      start: range.start,
      end: range.end,
      content: text,
      ...(stringValue(candidate.ref) ? { ref: stringValue(candidate.ref) } : {}),
      metadata: { provenance: "vision-ocr" },
    }];
  });
}

function visualTextForTimeline(observation: VisualObservation): string {
  return [observation.summary, ...(observation.visualEvents ?? []), ...(observation.notableVisuals ?? [])]
    .filter((value, index, values) => value.trim() && values.indexOf(value) === index)
    .join(" ");
}

function addVisualObservationToTimeline(
  timeline: Timeline,
  observation: VisualObservation,
  duration: number,
  provenance: string,
): void {
  const range = normalizedRange(observation.start, observation.end, duration);
  const content = visualTextForTimeline(observation);
  if (!range || !content) return;
  const identity = observation.metadata?.perceptionKey
    ?? observation.metadata?.perceptionRequestId
    ?? `${range.start}:${range.end}:${content}`;
  const digest = createHash("sha256").update(String(identity)).digest("hex").slice(0, 16);
  const id = `visual:${digest}`;
  if (timeline.items.some((item) => item.id === id)) return;
  const evidence = observation.evidence?.[0];
  timeline.add({
    id,
    type: evidence?.type === "clip" ? "clip" : "frame",
    start: range.start,
    end: range.end,
    content,
    ...(evidence?.ref ? { ref: evidence.ref } : {}),
    metadata: {
      provenance,
      ...(observation.metadata ?? {}),
      ...(evidence?.perceptionRequestId ? { perceptionRequestId: evidence.perceptionRequestId } : {}),
    },
  });
  for (const [index, ocr] of ocrItemsFromObservation(observation, duration).entries()) {
    const ocrId = `${id}:ocr:${index}`;
    if (!timeline.items.some((item) => item.id === ocrId)) {
      timeline.add({ id: ocrId, ...ocr });
    }
  }
}

function dedupeObservations(observations: readonly VisualObservation[]): VisualObservation[] {
  const seen = new Set<string>();
  return observations.filter((observation) => {
    const key = String(observation.metadata?.perceptionKey
      ?? observation.metadata?.perceptionRequestId
      ?? `${observation.start}:${observation.end}:${observation.summary}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeUnresolved(items: NonNullable<VideoUnderstanding["unresolved"]>): NonNullable<VideoUnderstanding["unresolved"]> {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.start ?? ""}:${item.end ?? ""}:${item.question}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function removeResolvedUnresolved(
  unresolved: NonNullable<VideoUnderstanding["unresolved"]>,
  executed: readonly import("../perception/types.js").PerceptionRequest[],
): NonNullable<VideoUnderstanding["unresolved"]> {
  return unresolved.filter((gap) => !executed.some((request) => unresolvedMatchesRequest(gap, request)));
}

function unresolvedMatchesRequest(
  gap: NonNullable<VideoUnderstanding["unresolved"]>[number],
  request: import("../perception/types.js").PerceptionRequest,
): boolean {
  if (gap.sectionId && request.sectionId && gap.sectionId !== request.sectionId) return false;
  if (gap.sectionId && request.sectionId && gap.sectionId === request.sectionId) return true;
  if (gap.start === undefined || gap.end === undefined) return false;
  return gap.start < request.end && gap.end > request.start;
}

function mergeExecutedRequests(
  previous: readonly import("../perception/types.js").PerceptionRequest[],
  current: readonly import("../perception/types.js").PerceptionRequest[],
): import("../perception/types.js").PerceptionRequest[] {
  const seen = new Set<string>();
  return [...previous, ...current].filter((request) => {
    const key = `${request.modality}:${request.purpose}:${request.start.toFixed(1)}:${request.end.toFixed(1)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptyPerceptionState(videoId: string): PerceptionState {
  return {
    version: 1,
    videoId,
    candidateRequests: [],
    plannedRequests: [],
    executedRequests: [],
    observations: [],
    unresolved: [],
    stats: {
      generatedRequests: 0,
      plannedRequests: 0,
      executedRequests: 0,
      deferredRequests: 0,
      framesExtracted: 0,
      visionBatches: 0,
      cacheHits: 0,
    },
  };
}

function activeObservationIdentity(observation: import("../tools/video-agent-tools.js").ToolObservation): string {
  const evidence = observation.evidence[0];
  const payload = `${observation.tool}:${evidence?.type ?? "frame"}:${evidence?.start ?? 0}:${evidence?.end ?? evidence?.start ?? 0}:${evidence?.ref ?? ""}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function persistedVideoRef(metadata: VideoMetadata): string | undefined {
  const fromMetadata = stringValue(metadata.metadata?.videoRef);
  return fromMetadata ?? metadata.source?.uri;
}

function sourceVideoId(source: MediaSource): string | undefined {
  return stringValue(source.videoId) ?? stringValue(source.metadata?.videoId);
}

function normalizedSourceForLookup(source: MediaSource): MediaSource {
  return {
    ...source,
    uri: source.kind === "local" ? resolve(source.uri) : source.uri.trim(),
  };
}

function referenceFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  return stringValue(metadata?.ref);
}

function normalizedRange(
  start: number,
  end: number,
  duration: number,
): { start: number; end: number } | undefined {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const safeStart = clampTime(start, duration);
  const safeEnd = clampTime(end, duration);
  return safeEnd >= safeStart ? { start: safeStart, end: safeEnd } : undefined;
}

function clampTime(value: number, duration: number): number {
  return Math.min(duration, Math.max(0, value));
}

function usableDuration(...values: number[]): number | undefined {
  return values.find((value) => Number.isFinite(value) && value > 0);
}

function validateIngestedMedia(media: IngestedMedia): void {
  requireVideoId(media.videoId);
  if (!Number.isFinite(media.duration) || media.duration <= 0) {
    throw new RangeError("Ingested media duration must be a positive number of seconds.");
  }
  if (!media.video?.ref?.trim()) {
    throw new TypeError("Ingested media must include a video asset reference.");
  }
}

function requireVideoId(videoId: string): string {
  if (typeof videoId !== "string" || !videoId.trim()) {
    throw new TypeError("videoId must be a non-empty string.");
  }
  return videoId.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
