import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FrameReference } from "../core/types.js";
import { FakeVisionProvider } from "../providers/test-providers.js";
import type { ClipReference, FrameExtractor } from "../vision/frame-extractor.js";
import { VideoAgentTools } from "./video-agent-tools.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeCacheDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "seeit-tools-"));
  temporaryRoots.push(directory);
  return directory;
}

class FakeExtractor implements FrameExtractor {
  public frameCalls = 0;
  public framesCalls = 0;
  public clipCalls = 0;

  async extractFrame(request: { time: number }): Promise<FrameReference> {
    this.frameCalls += 1;
    return { time: request.time, ref: `/frames/${request.time}.jpg` };
  }

  async extractFrames(request: { times: readonly number[] }): Promise<FrameReference[]> {
    this.framesCalls += 1;
    return request.times.map((time) => ({ time, ref: `/frames/${time}.jpg` }));
  }

  async extractClip(request: { start: number; end: number }): Promise<ClipReference> {
    this.clipCalls += 1;
    return { ref: `/clips/${request.start}-${request.end}.mp4`, start: request.start, end: request.end };
  }
}

describe("VideoAgentTools", () => {
  it("searches and reads the existing unified timeline without video extraction", async () => {
    const extractor = new FakeExtractor();
    const tools = new VideoAgentTools({
      videoId: "tools-1",
      duration: 60,
      videoRef: "/video.mp4",
      frameExtractor: extractor,
      timeline: {
        videoId: "tools-1",
        duration: 60,
        items: [
          { id: "sub", type: "subtitle", start: 10, end: 12, content: "排名发生变化" },
          { id: "ocr", type: "ocr", start: 11, content: "蓝线第一" },
          { id: "dan", type: "danmaku", start: 30, content: "太精彩了" },
        ],
      },
    });

    const search = await tools.search("排名");
    const around = await tools.readAround(11, 2);

    expect(search.timelineItems?.map((item) => item.id)).toContain("sub");
    expect(search.evidence.some((item) => item.type === "subtitle")).toBe(true);
    expect(around.timelineItems?.map((item) => item.id)).toEqual(["sub", "ocr"]);
    expect(extractor.frameCalls).toBe(0);
  });

  it("extracts a bounded batch once and sends it to one visual analysis request", async () => {
    const cacheDir = await makeCacheDir();
    const extractor = new FakeExtractor();
    const vision = new FakeVisionProvider({
      images: {
        start: 20,
        end: 30,
        summary: "A blue line overtakes a red line.",
        visualEvents: ["Crossover"],
      },
    });
    const tools = new VideoAgentTools({
      videoId: "tools-2",
      duration: 60,
      videoRef: "/video.mp4",
      frameExtractor: extractor,
      vision,
      timeline: { videoId: "tools-2", duration: 60, items: [] },
      cacheDir,
    });

    const first = await tools.getFrames(20, 30, 3);
    const second = await tools.getFrames(20, 30, 3);

    expect(first.visual?.summary).toContain("blue line");
    expect(first.frames).toHaveLength(3);
    expect(first.evidence).toEqual([{ type: "frame", start: 20, end: 30, ref: "/frames/20.jpg" }]);
    expect(second).toBe(first);
    expect(extractor.framesCalls).toBe(1);
    expect(vision.imageRequests).toHaveLength(1);
    expect(vision.imageRequests[0]?.images.map((item) => item.time)).toEqual([20, 25, 30]);
  });

  it("does not treat unanalysed frames or clips as evidence", async () => {
    const cacheDir = await makeCacheDir();
    const extractor = new FakeExtractor();
    const tools = new VideoAgentTools({
      videoId: "tools-3",
      duration: 60,
      videoRef: "/video.mp4",
      frameExtractor: extractor,
      timeline: { videoId: "tools-3", duration: 60, items: [] },
      cacheDir,
    });

    const frame = await tools.getFrame(3);
    const frames = await tools.getFrames(3, 6, 2);
    const result = await tools.getClip(3, 6);

    expect(frame.frames?.[0]?.ref).toContain("/frames/3.jpg");
    expect(frame.evidence).toEqual([]);
    expect(frames.frames).toHaveLength(2);
    expect(frames.evidence).toEqual([]);
    expect(result.clip?.ref).toContain("/clips/3-6.mp4");
    expect(result.visual).toBeUndefined();
    expect(result.evidence).toEqual([]);
  });

  it("does not create clip evidence when a vision provider lacks clip analysis", async () => {
    const cacheDir = await makeCacheDir();
    const extractor = new FakeExtractor();
    const imageOnlyVision = {
      analyzeImages: async () => ({ start: 0, end: 0, summary: "unused" }),
    };
    const tools = new VideoAgentTools({
      videoId: "tools-clip-no-analysis",
      duration: 60,
      videoRef: "/video.mp4",
      frameExtractor: extractor,
      vision: imageOnlyVision,
      timeline: { videoId: "tools-clip-no-analysis", duration: 60, items: [] },
      cacheDir,
    });

    const result = await tools.getClip(3, 6);

    expect(result.clip?.ref).toContain("/clips/3-6.mp4");
    expect(result.evidence).toEqual([]);
  });

  it("reuses a persisted visual observation across tool instances", async () => {
    const cacheDir = await makeCacheDir();
    const extractor = new FakeExtractor();
    const vision = new FakeVisionProvider({
      images: { start: 20, end: 30, summary: "Blue line takes first place." },
    });
    const dependencies = {
      videoId: "tools-persistent-cache",
      duration: 60,
      videoRef: "/video.mp4",
      frameExtractor: extractor,
      vision,
      timeline: { videoId: "tools-persistent-cache", duration: 60, items: [] },
      cacheDir,
    };

    const first = await new VideoAgentTools(dependencies).getFrames(20, 30, 3);
    const second = await new VideoAgentTools(dependencies).getFrames(20.02, 30.01, 3);

    expect(first.visual?.summary).toBe("Blue line takes first place.");
    expect(second).toEqual(first);
    expect(extractor.framesCalls).toBe(1);
    expect(vision.imageRequests).toHaveLength(1);
  });

  it("clamps finite agent timestamps at duration boundaries instead of passing them through", async () => {
    const cacheDir = await makeCacheDir();
    const extractor = new FakeExtractor();
    const tools = new VideoAgentTools({
      videoId: "tools-clamp", duration: 60, videoRef: "/video.mp4", frameExtractor: extractor,
      timeline: { videoId: "tools-clamp", duration: 60, items: [] }, cacheDir,
    });

    await tools.getFrame(600);
    await tools.getFrames(59.9, 600, 2);

    expect(extractor.frameCalls).toBe(1);
    expect(extractor.framesCalls).toBe(1);
  });
});
