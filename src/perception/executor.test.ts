import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FrameReference } from "../core/types.js";
import { FakeVisionProvider } from "../providers/test-providers.js";
import { VideoStorage } from "../storage/video-storage.js";
import type { FrameExtractor } from "../vision/frame-extractor.js";
import type { SparseFrameSamplingRequest, SparseFrameSamplingResult } from "../vision/sparse-frame-sampler.js";
import { perceptionCacheDirectoryName, PerceptionExecutor } from "./executor.js";
import type { PerceptionRequest } from "./types.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PerceptionExecutor", () => {
  it("uses a filesystem-safe directory for request keys containing a local Windows path", () => {
    const name = perceptionCacheDirectoryName("frames:C:\\media\\video.mp4:0.0:10.0");
    expect(name).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reuses canonicalized equivalent requests without another extraction or VLM call", async () => {
    const fixture = await makeFixture();
    const first = frameRequest("one", 100, 100.2);
    const second = frameRequest("two", 100.02, 100.21);

    await fixture.executor.execute({ requests: [first] });
    const cached = await fixture.executor.execute({ requests: [second] });

    expect(fixture.extractFrame).toHaveBeenCalledTimes(1);
    expect(fixture.vision.imageRequests).toHaveLength(1);
    expect(cached.cacheHits).toBe(1);
    expect(cached.observations[0]?.evidence?.[0]?.perceptionRequestId).toBe("two");
  });

  it("keeps VLM image batches at 24 frames or fewer for broad selective perception", async () => {
    const fixture = await makeFixture();
    await fixture.executor.execute({
      requests: [{ ...frameRequest("broad", 0, 90), modality: "frames" }],
      budget: { maxRequests: 1, maxFrames: 48 },
    });

    expect(fixture.vision.imageRequests.length).toBeGreaterThan(1);
    expect(fixture.vision.imageRequests.every((request) => request.images.length <= 24)).toBe(true);
  });

  it("never passes out-of-duration timestamps to the frame extractor", async () => {
    const fixture = await makeFixture();
    await fixture.executor.execute({ requests: [frameRequest("edge", 199.8, 200)] });

    expect(fixture.extractFrame.mock.calls[0]?.[0].time).toBeLessThan(200);
    expect(fixture.extractFrame.mock.calls[0]?.[0].time).toBeGreaterThanOrEqual(0);
  });

  it("skips an over-budget high-priority request and still executes a later fitting request", async () => {
    const fixture = await makeFixture();
    const result = await fixture.executor.execute({
      requests: [
        { ...frameRequest("small", 80, 82), priority: 0.1 },
        { ...frameRequest("too-long", 0, 50), modality: "frames", priority: 0.9 },
      ],
      budget: { maxRequests: 2, maxFrames: 8, maxVisualSeconds: 10 },
    });

    expect(result.executedRequests.map((request) => request.id)).toEqual(["small"]);
    expect(fixture.extractFrame).toHaveBeenCalledTimes(1);
    expect(fixture.vision.imageRequests).toHaveLength(1);
  });
});

async function makeFixture(): Promise<{
  executor: PerceptionExecutor;
  vision: FakeVisionProvider;
  extractFrame: ReturnType<typeof vi.fn>;
}> {
  const root = await mkdtemp(join(tmpdir(), "seeit-executor-"));
  temporaryRoots.push(root);
  const storage = new VideoStorage(root);
  const extractFrame = vi.fn(async ({ time, outputPath }: { time: number; outputPath: string }): Promise<FrameReference> => ({ time, ref: outputPath }));
  const frameExtractor: FrameExtractor = {
    extractFrame,
    extractFrames: async ({ times, outputDir }) => times.map((time, index) => ({ time, ref: join(outputDir, `${index}.jpg`) })),
  };
  const frameSampler = {
    sample: vi.fn(async (request: SparseFrameSamplingRequest): Promise<SparseFrameSamplingResult> => {
      const count = request.maxFrames ?? 1;
      const start = request.start ?? 0;
      const end = request.end ?? 1;
      const representativeFrames = Array.from({ length: count }, (_, index) => ({
        time: start + ((end - start) * index) / Math.max(1, count - 1), ref: `memory://frame-${index}`,
      }));
      return { representativeFrames, candidateFrames: representativeFrames, intervalTimes: [], sceneChangeTimes: [], outputDir: request.outputDir ?? "", cacheHit: false };
    }),
  };
  const vision = new FakeVisionProvider({ images: { start: 0, end: 1, summary: "Observed scene." } });
  return {
    executor: new PerceptionExecutor({ videoId: "video-1", duration: 200, videoRef: "memory://video", frameExtractor, frameSampler, storage, vision }),
    vision, extractFrame,
  };
}

function frameRequest(id: string, start: number, end: number): PerceptionRequest {
  return { id, modality: "frame", start, end, purpose: "verify_claim", question: "What is visible?", priority: 0.9 };
}
