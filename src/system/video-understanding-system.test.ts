import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { IngestedMedia, MediaSource, VideoUnderstanding, VisualObservation } from "../core/types.js";
import { FakeLLMProvider, FakeVisionProvider } from "../providers/test-providers.js";
import { VideoStorage } from "../storage/video-storage.js";
import type { FrameExtractor } from "../vision/frame-extractor.js";
import type { SparseFrameSamplingRequest, SparseFrameSamplingResult } from "../vision/sparse-frame-sampler.js";
import { VideoUnderstandingSystem } from "./video-understanding-system.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("VideoUnderstandingSystem adaptive perception", () => {
  it("persists the grounded base if optional vision later fails", async () => {
    const fixture = await makeFixture({ duration: 100, transcript: completeTranscript(100), baseResponse: understandingWithGap(100) });
    vi.spyOn(fixture.vision, "analyzeImages").mockRejectedValue(new Error("vision unavailable"));
    await expect(fixture.system.process(fixture.source)).rejects.toThrow("vision unavailable");
    expect((await fixture.storage.readUnderstanding("video-1"))?.status).toBe("base");
  });

  it("processes a 60-minute text-dominant static video with zero VisionProvider calls", async () => {
    const fixture = await makeFixture({ duration: 3_600, transcript: completeTranscript(3_600) });

    const first = await fixture.system.process(fixture.source);
    const second = await fixture.system.process(fixture.source);

    expect(first).toEqual(second);
    expect(first.status).toBe("base");
    expect(fixture.ingest.ingest).toHaveBeenCalledTimes(1);
    expect(fixture.frameSampler.sample).not.toHaveBeenCalled();
    expect(fixture.vision.imageRequests).toHaveLength(0);
    expect(await fixture.storage.readPerceptionState("video-1")).toMatchObject({
      stats: { executedRequests: 0 },
    });
  });

  it("routes a local visual reference to only its nearby time range", async () => {
    const fixture = await makeFixture({
      duration: 1_200,
      transcript: {
        source: "original",
        cues: [
          { start: 0, end: 300, content: "This is an ordinary explanation with enough text evidence." },
          { start: 310, end: 312, content: "大家看屏幕左边这个参数。" },
          { start: 330, end: 1_200, content: "The explanation continues without another visual reference." },
        ],
      },
    });

    await fixture.system.process(fixture.source);

    expect(fixture.frameSampler.sample).toHaveBeenCalledTimes(1);
    const request = fixture.frameSampler.sample.mock.calls[0]?.[0] as SparseFrameSamplingRequest;
    expect(request.start).toBeGreaterThan(290);
    expect(request.end).toBeLessThan(330);
    expect(fixture.vision.imageRequests).toHaveLength(1);
    expect(fixture.vision.imageRequests[0]?.images.length).toBeLessThanOrEqual(12);
    const state = await fixture.storage.readPerceptionState("video-1");
    expect(state?.plannedRequests).toHaveLength(1);
    expect(state?.plannedRequests[0]).toMatchObject({ purpose: "resolve_visual_reference" });

    await fixture.system.process(fixture.source, { force: true });
    const forced = await fixture.storage.readPerceptionState("video-1");
    expect(forced?.executedRequests).toHaveLength(1);
    expect(forced?.stats.cacheHits).toBe(1);
    expect(fixture.vision.imageRequests).toHaveLength(1);
  });

  it("falls back to broad representative visual perception when transcript evidence is absent", async () => {
    const fixture = await makeFixture({ duration: 90, transcript: { cues: [] } });

    const understanding = await fixture.system.process(fixture.source);

    expect(fixture.frameSampler.sample).toHaveBeenCalledTimes(1);
    expect(fixture.vision.imageRequests.length).toBeGreaterThan(0);
    expect(understanding.status).toBe("enriched");
    expect(understanding.sections[0]?.visual).toContain("visual scene");
  });

  it("reuses persisted understanding before ingest when source has no explicit video id", async () => {
    const fixture = await makeFixture({ sourceHasVideoId: false, transcript: completeTranscript(10) });

    await fixture.system.process(fixture.source);
    await fixture.system.process(fixture.source);

    expect(fixture.ingest.ingest).toHaveBeenCalledTimes(1);
    expect(fixture.frameSampler.sample).not.toHaveBeenCalled();
    expect(fixture.vision.imageRequests).toHaveLength(0);
  });

  it("clears an executed base unresolved gap but retains an unexecuted budgeted gap", async () => {
    const baseResponse = understandingWithGap(100);
    const completed = await makeFixture({
      duration: 100,
      transcript: completeTranscript(100),
      baseResponse,
      visionObservation: { start: 30, end: 40, summary: "The product label is visible.", metadata: { ocr: "RTX 5070 Ti" } },
    });

    const completedUnderstanding = await completed.system.process(completed.source);

    expect(completedUnderstanding.unresolved).toBeUndefined();
    expect((await completed.storage.readPerceptionState("video-1"))?.unresolved).toEqual([]);
    expect((await completed.storage.readTimeline("video-1"))?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ocr", content: "RTX 5070 Ti" }),
    ]));

    const deferred = await makeFixture({ duration: 100, transcript: completeTranscript(100), baseResponse });
    const deferredUnderstanding = await deferred.system.process(deferred.source, {
      perceptionBudget: { maxRequests: 1, maxFrames: 1, maxVisualSeconds: 30 },
    });

    expect(deferred.vision.imageRequests).toHaveLength(0);
    expect(deferredUnderstanding.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ question: "What label is visible?", start: 30, end: 40 }),
    ]));
    expect((await deferred.storage.readPerceptionState("video-1"))?.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ question: "What label is visible?" }),
    ]));
  });

  it("persists QA active perception so a second ask does not call vision again", async () => {
    const root = await mkdtemp(join(tmpdir(), "seeit-active-"));
    temporaryRoots.push(root);
    const storage = new VideoStorage(root);
    await storage.initialize("active-1");
    await storage.writeMetadata("active-1", { videoId: "active-1", duration: 120, source: { kind: "local", uri: "C:/media/active.mp4" }, metadata: { videoRef: "C:/media/active.mp4" } });
    await storage.writeTimeline("active-1", { videoId: "active-1", duration: 120, items: [] });
    await storage.writeUnderstanding("active-1", {
      videoId: "active-1", overview: "Text evidence leaves a visual gap.", contentType: "general",
      sections: [{ start: 0, end: 120, summary: "A visual fact remains unknown.", importance: 0.5, evidence: [{ type: "description", start: 0, end: 120, ref: "metadata:description" }] }],
    });
    const vision = new FakeVisionProvider({ images: { start: 0, end: 0, summary: "The product label says RTX 5070 Ti." } });
    const llm = new FakeLLMProvider([
      { text: "", value: { answer: "Need the frame.", sufficient: false, citations: [], perceptionRequests: [{ modality: "frame", start: 100 }] } },
      { text: "", value: { answer: "It is RTX 5070 Ti.", sufficient: true, citations: [{ type: "frame", start: 100, end: 100 }] } },
    ]);
    const frameExtractor: FrameExtractor = {
      extractFrame: async ({ time, outputPath }) => ({ time, ref: outputPath }),
      extractFrames: async ({ times, outputDir }) => times.map((time, index) => ({ time, ref: join(outputDir, `${index}.jpg`) })),
    };
    const system = new VideoUnderstandingSystem({
      ingest: { ingest: async () => { throw new Error("ingest must not run during ask"); } },
      frameSampler: { sample: async () => { throw new Error("sampling must not run during ask"); } },
      frameExtractor, storage, llm, vision, logger: { info: () => undefined },
    });

    await system.ask("active-1", "作者最后买的是哪张显卡？");
    await system.ask("active-1", "是 5070 还是 5070 Ti？");

    expect(vision.imageRequests).toHaveLength(1);
    expect((await storage.readPerceptionState("active-1"))?.observations).toHaveLength(1);
    expect((await storage.readTimeline("active-1"))?.items.some((item) => item.content?.includes("RTX 5070 Ti"))).toBe(true);
    expect((await storage.readUnderstanding("active-1"))?.sections[0]?.visual).toContain("RTX 5070 Ti");
    expect(llm.requests).toHaveLength(3);
  });
});

async function makeFixture(options: {
  duration?: number;
  transcript?: IngestedMedia["transcript"];
  sourceHasVideoId?: boolean;
  baseResponse?: unknown;
  visionObservation?: VisualObservation;
} = {}): Promise<{
  system: VideoUnderstandingSystem;
  storage: VideoStorage;
  source: MediaSource;
  ingest: { ingest: ReturnType<typeof vi.fn> };
  frameSampler: { sample: ReturnType<typeof vi.fn> };
  vision: FakeVisionProvider;
}> {
  const root = await mkdtemp(join(tmpdir(), "seeit-system-"));
  temporaryRoots.push(root);
  const storage = new VideoStorage(root);
  const source: MediaSource = {
    kind: "local",
    uri: "C:/media/example.mp4",
    ...(options.sourceHasVideoId === false ? {} : { videoId: "video-1" }),
  };
  const duration = options.duration ?? 10;
  const media: IngestedMedia = {
    videoId: "video-1",
    source: { ...source, uri: resolve(source.uri), videoId: "video-1" },
    duration,
    video: { type: "video", ref: "C:/media/example.mp4" },
    title: "Demo video",
    description: "A durable source description for grounding the base understanding.",
    transcript: options.transcript ?? completeTranscript(duration),
  };
  const ingest = { ingest: vi.fn(async (): Promise<IngestedMedia> => media) };
  const frameSampler = {
    sample: vi.fn(async (request: SparseFrameSamplingRequest): Promise<SparseFrameSamplingResult> => ({
      representativeFrames: [
        { time: request.start ?? 0, ref: "C:/frames/local-0.jpg" },
        { time: request.end ?? duration, ref: "C:/frames/local-1.jpg" },
      ],
      candidateFrames: [], intervalTimes: [], sceneChangeTimes: [], outputDir: request.outputDir ?? "", cacheHit: false,
    })),
  };
  const frameExtractor: FrameExtractor = {
    extractFrame: async ({ time, outputPath }) => ({ time, ref: outputPath }),
    extractFrames: async ({ times, outputDir }) => times.map((time, index) => ({ time, ref: join(outputDir, `frame-${index}.jpg`) })),
    detectSceneChanges: async () => [],
  };
  const vision = new FakeVisionProvider({ images: options.visionObservation ?? { start: 0, end: duration, summary: "A local visual scene is observed." } });
  const llm = new FakeLLMProvider({ text: "", value: options.baseResponse ?? baseUnderstanding(duration) });
  const system = new VideoUnderstandingSystem({ ingest, frameSampler, frameExtractor, storage, llm, vision, logger: { info: () => undefined } });
  return { system, storage, source, ingest, frameSampler, vision };
}

function completeTranscript(duration: number): NonNullable<IngestedMedia["transcript"]> {
  return { source: "original", cues: [{ start: 0, end: duration, content: "A complete spoken explanation establishes the video topic and conclusion." }] };
}

function baseUnderstanding(duration: number): VideoUnderstanding {
  return {
    videoId: "video-1", overview: "A grounded explanation of the video.", contentType: "talk",
    sections: [{ start: 0, end: duration, summary: "The speaker explains the main topic.", importance: 0.8, evidence: [{ type: "description", start: 0, end: duration, ref: "metadata:description" }] }],
  };
}

function understandingWithGap(duration: number): Record<string, unknown> {
  return {
    ...baseUnderstanding(duration),
    perceptionRequests: [{
      start: 30, end: 40, modality: "frames", purpose: "read_screen",
      question: "What label is visible?", reason: "The speaker refers to a label.", priority: 0.9, sectionId: "section-label",
    }],
    unresolved: [{
      question: "What label is visible?", reason: "The label needs visual inspection.", start: 30, end: 40, priority: 0.9, sectionId: "section-label",
    }],
  };
}
