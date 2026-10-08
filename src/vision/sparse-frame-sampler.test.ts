import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { FrameReference } from "../core/types.js";
import type { ClipExtractionRequest, ClipReference, FrameExtractionRequest, FrameExtractor, FramesExtractionRequest, SceneChangeRequest } from "./frame-extractor.js";
import { SparseFrameSampler } from "./sparse-frame-sampler.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

class FakeExtractor implements FrameExtractor {
  public readonly frameRequests: FramesExtractionRequest[] = [];
  public sceneRequests: SceneChangeRequest[] = [];

  public constructor(private readonly sceneTimes: readonly number[] = []) {}

  async extractFrame(request: FrameExtractionRequest): Promise<FrameReference> {
    return { time: request.time, ref: request.outputPath };
  }

  async extractFrames(request: FramesExtractionRequest): Promise<FrameReference[]> {
    this.frameRequests.push(request);
    return request.times.map((time) => ({
      time,
      ref: `memory://frame-${time}`,
      metadata: { perceptualHash: time < 3 ? "0000" : "1111" },
    }));
  }

  async detectSceneChanges(request: SceneChangeRequest): Promise<number[]> {
    this.sceneRequests.push(request);
    return [...this.sceneTimes];
  }

  async extractClip(request: ClipExtractionRequest): Promise<ClipReference> {
    return { ref: request.outputPath, start: request.start, end: request.end };
  }
}

describe("SparseFrameSampler", () => {
  it("samples every two seconds, adds scene candidates, and removes adjacent visual duplicates", async () => {
    const extractor = new FakeExtractor([3]);
    const result = await new SparseFrameSampler(extractor).sample({
      videoId: "video-1",
      videoRef: "memory://video",
      duration: 5,
      outputDir: join(tmpdir(), "unused-see-it-frames"),
      includeSceneChanges: true,
      useCache: false,
    });

    expect(result.intervalTimes).toEqual([0, 2, 4]);
    expect(result.sceneChangeTimes).toEqual([3]);
    expect(extractor.frameRequests[0]?.times).toEqual([0, 2, 3, 4]);
    // 0 and 2 share a pHash; 3 and 4 share another one.
    expect(result.representativeFrames.map((frame) => frame.time)).toEqual([0, 3]);
    expect(result.candidateFrames.find((frame) => frame.time === 3)?.metadata).toMatchObject({
      sampleSources: ["scene-change"],
    });
  });

  it("reuses its representative-frame manifest instead of extracting again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seeit-sampling-"));
    temporaryDirectories.push(directory);
    const extractor = new FileWritingExtractor();
    const sampler = new SparseFrameSampler(extractor);
    const request = {
      videoId: "cached-video",
      videoRef: "memory://video",
      duration: 3,
      outputDir: directory,
    };

    const first = await sampler.sample(request);
    const second = await sampler.sample(request);

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(extractor.calls).toBe(1);
  });
});

class FileWritingExtractor extends FakeExtractor {
  public calls = 0;

  override async extractFrames(request: FramesExtractionRequest): Promise<FrameReference[]> {
    this.calls += 1;
    await mkdir(request.outputDir, { recursive: true });
    return Promise.all(request.times.map(async (time) => {
      const ref = join(request.outputDir, `test-${time}.jpg`);
      await writeFile(ref, `same-frame-${time}`);
      return { time, ref, metadata: { perceptualHash: String(time) } };
    }));
  }
}
