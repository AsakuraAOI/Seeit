import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { VideoStorage, cacheKeyDigest } from "./video-storage.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeStorage(): Promise<VideoStorage> {
  const root = await mkdtemp(join(tmpdir(), "seeit-storage-"));
  temporaryRoots.push(root);
  return new VideoStorage(root);
}

describe("VideoStorage", () => {
  it("persists the standard artifacts in the expected layout", async () => {
    const storage = await makeStorage();
    await storage.initialize("video-1");

    await storage.writeMetadata("video-1", {
      videoId: "video-1",
      duration: 42,
      title: "A local video",
      description: "Description is durable source evidence.",
    });
    await storage.writeTimeline("video-1", {
      videoId: "video-1",
      duration: 42,
      items: [{ id: "description", start: 0, type: "description", content: "Source description" }],
    });
    await storage.writeUnderstanding("video-1", {
      videoId: "video-1",
      overview: "A short explanation.",
      contentType: "talk",
      sections: [],
    });
    await storage.writeTranscript("video-1", {
      source: "original",
      cues: [{ start: 0, end: 1, content: "Hello" }],
    });
    await storage.writeDanmaku("video-1", [{ start: 2, content: "nice" }]);
    await storage.writePerceptionState("video-1", {
      version: 1, videoId: "video-1", candidateRequests: [], plannedRequests: [], executedRequests: [], observations: [], unresolved: [],
      stats: { generatedRequests: 0, plannedRequests: 0, executedRequests: 0, deferredRequests: 0, framesExtracted: 0, visionBatches: 0, cacheHits: 0 },
    });

    await expect(access(storage.getFramesDir("video-1"))).resolves.toBeUndefined();
    await expect(access(storage.getCacheDir("video-1"))).resolves.toBeUndefined();
    await expect(storage.readMetadata("video-1")).resolves.toMatchObject({ title: "A local video" });
    await expect(storage.readTimeline("video-1")).resolves.toMatchObject({ duration: 42 });
    await expect(storage.readUnderstanding("video-1")).resolves.toMatchObject({ contentType: "talk" });
    await expect(storage.readTranscript("video-1")).resolves.toMatchObject({ source: "original" });
    await expect(storage.readDanmaku("video-1")).resolves.toEqual([{ start: 2, content: "nice" }]);
    await expect(storage.readPerceptionState("video-1")).resolves.toMatchObject({ version: 1, videoId: "video-1" });

    const storedJson = await readFile(storage.getArtifactPath("video-1", "timeline"), "utf8");
    expect(JSON.parse(storedJson)).toMatchObject({ videoId: "video-1" });
  });

  it("reuses expensive cache results and addresses arbitrary keys safely", async () => {
    const storage = await makeStorage();
    let calls = 0;

    const first = await storage.getOrCreateCache("video-1", "asr:version-1:source.wav", async () => {
      calls += 1;
      return { transcript: "cached" };
    });
    const second = await storage.getOrCreateCache("video-1", "asr:version-1:source.wav", async () => {
      calls += 1;
      return { transcript: "should not run" };
    });

    expect(first).toEqual({ transcript: "cached" });
    expect(second).toEqual({ transcript: "cached" });
    expect(calls).toBe(1);

    const pathForHostileLookingKey = storage.getCachePath("video-1", "vision:../../not-a-path");
    expect(relative(storage.getCacheDir("video-1"), pathForHostileLookingKey)).not.toContain("..");
    expect(pathForHostileLookingKey).toContain(cacheKeyDigest("vision:../../not-a-path"));
  });

  it("writes frame bytes and blocks path traversal attempts", async () => {
    const storage = await makeStorage();
    const framePath = await storage.writeFrame("video-1", "frame-0001.jpg", new Uint8Array([1, 2, 3]));

    expect(Array.from((await storage.readFrame("video-1", "frame-0001.jpg")) ?? [])).toEqual([1, 2, 3]);
    expect(framePath).toBe(storage.getFramePath("video-1", "frame-0001.jpg"));
    expect(() => storage.getVideoDir("../outside")).toThrow(/videoId/);
    expect(() => storage.getFramePath("video-1", "../../outside.jpg")).toThrow(/filename/);
  });

  it("lists readable persisted videos in stable order without scanning from callers", async () => {
    const storage = await makeStorage();
    await storage.writeMetadata("zeta", { videoId: "zeta", duration: 9, title: "Zeta" });
    await storage.writeMetadata("alpha", { videoId: "alpha", duration: 3 });
    await storage.writeUnderstanding("alpha", {
      videoId: "alpha", overview: "Ready", contentType: "talk", sections: [], status: "enriched",
    });
    await storage.writePerceptionState("alpha", {
      version: 1, videoId: "alpha", candidateRequests: [], plannedRequests: [], executedRequests: [], observations: [], unresolved: [],
      stats: { generatedRequests: 0, plannedRequests: 0, executedRequests: 0, deferredRequests: 0, framesExtracted: 0, visionBatches: 0, cacheHits: 0 },
    });
    await mkdir(join(storage.rootDir, "incomplete"), { recursive: true });

    await expect(storage.listVideoSummaries()).resolves.toEqual([
      {
        videoId: "alpha", duration: 3,
        understanding: { status: "enriched", sectionCount: 0 },
        perception: { observationCount: 0, unresolvedCount: 0 },
      },
      { videoId: "zeta", title: "Zeta", duration: 9 },
    ]);
  });
});
