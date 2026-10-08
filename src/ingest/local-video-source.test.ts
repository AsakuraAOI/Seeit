import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { FakeASRProvider } from "../providers/test-providers.js";
import { MemoryIngestCache } from "./cache.js";
import { FakeCommandRunner } from "./command-runner.js";
import type { MediaProbe } from "./ffprobe.js";
import { LocalVideoSource } from "./local-video-source.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "seeit-ingest-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "clip.mp4"), "not-a-real-video");
  return directory;
}

const probe: MediaProbe = {
  async probe() {
    return {
      format: {
        duration: "12.5",
        tags: { title: "Tagged title", description: "Tagged description" },
      },
      streams: [{ index: 0, codec_type: "video" }, { index: 1, codec_type: "audio" }],
    };
  },
};

describe("LocalVideoSource", () => {
  it("uses original subtitles before ASR and preserves local sidecar evidence", async () => {
    const directory = await fixtureDirectory();
    const videoPath = join(directory, "clip.mp4");
    await writeFile(
      join(directory, "clip.srt"),
      "1\n00:00:00,000 --> 00:00:02,000\nOriginal words\n",
    );
    await writeFile(
      join(directory, "clip.metadata.json"),
      JSON.stringify({ description: "Sidecar description" }),
    );
    await writeFile(
      join(directory, "clip.danmaku.json"),
      JSON.stringify([{ progress: 1500, content: "nice timing" }]),
    );
    const asr = new FakeASRProvider([{ start: 0, end: 1, content: "ASR should not run" }]);

    const ingested = await new LocalVideoSource(videoPath, { probe, asrProvider: asr }).ingest();

    expect(ingested.duration).toBe(12.5);
    expect(ingested.title).toBe("Tagged title");
    expect(ingested.description).toBe("Sidecar description");
    expect(ingested.audio?.metadata).toMatchObject({ streamIndex: 1 });
    expect(ingested.transcript).toMatchObject({
      source: "original",
      cues: [{ start: 0, end: 2, content: "Original words" }],
    });
    expect(ingested.danmaku).toMatchObject([{ start: 1.5, content: "nice timing" }]);
    expect(asr.requests).toHaveLength(0);
  });

  it("falls back to ASR once and reuses a supplied cache", async () => {
    const directory = await fixtureDirectory();
    const videoPath = join(directory, "clip.mp4");
    const asr = new FakeASRProvider([{ start: 1, end: 2, content: "Generated transcript" }]);
    const cache = new MemoryIngestCache();
    const commands = new FakeCommandRunner({ exitCode: 0, stdout: "", stderr: "" });
    const source = new LocalVideoSource(videoPath, {
      probe,
      asrProvider: asr,
      cache,
      language: "zh",
      videoId: "clip-001",
      commandRunner: commands,
    });

    const first = await source.ingest();
    const second = await source.ingest();

    expect(first.transcript).toMatchObject({ source: "asr", cues: [{ content: "Generated transcript" }] });
    expect(second.transcript?.metadata).toMatchObject({ cacheHit: true });
    expect(asr.requests).toHaveLength(1);
    // 视频容器先抽取成 WAV 再送 ASR；抽取文件复用、只执行一次
    expect(commands.calls).toHaveLength(1);
    expect(commands.calls[0]).toMatchObject({ command: "ffmpeg" });
    expect(commands.calls[0]?.args).toContain("-acodec");
    expect(asr.requests[0]).toMatchObject({
      audioRef: resolve("data", "clip-001", "cache", "extracted-audio.wav"),
      language: "zh",
    });
  });

  it("uses an injected video cache directory for extracted audio and ASR cache", async () => {
    const directory = await fixtureDirectory();
    const videoPath = join(directory, "clip.mp4");
    const cacheDirectory = join(directory, "custom-data", "clip-003", "cache");
    const asr = new FakeASRProvider([{ start: 0, end: 1, content: "Cached in custom data root" }]);
    const commands = new FakeCommandRunner({ exitCode: 0, stdout: "", stderr: "" });

    const source = new LocalVideoSource(videoPath, {
      probe,
      asrProvider: asr,
      commandRunner: commands,
      videoId: "clip-003",
      cacheDirForVideo: (videoId) => join(directory, "custom-data", videoId, "cache"),
    });
    await source.ingest();

    expect(asr.requests[0]?.audioRef).toBe(join(cacheDirectory, "extracted-audio.wav"));
    expect(commands.calls[0]?.args).toContain(join(cacheDirectory, "extracted-audio.wav"));
    expect((await readdir(cacheDirectory)).some((name) => name.endsWith(".json"))).toBe(true);
  });

  it("passes pure audio files straight through to ASR", async () => {
    const directory = await fixtureDirectory();
    const audioPath = join(directory, "clip.wav");
    await writeFile(audioPath, "wav-bytes");
    const asr = new FakeASRProvider([{ start: 1, end: 2, content: "Generated transcript" }]);
    const commands = new FakeCommandRunner({ exitCode: 0, stdout: "", stderr: "" });
    const source = new LocalVideoSource(audioPath, {
      duration: 12.5,
      asrProvider: asr,
      commandRunner: commands,
      videoId: "clip-002",
    });

    await source.ingest();

    expect(commands.calls).toHaveLength(0);
    expect(asr.requests[0]).toMatchObject({ audioRef: audioPath });
  });
});
