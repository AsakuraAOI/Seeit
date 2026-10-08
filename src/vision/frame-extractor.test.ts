import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { FakeCommandRunner } from "../ingest/command-runner.js";
import { FfmpegFrameExtractor } from "./frame-extractor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("FfmpegFrameExtractor", () => {
  it("extracts a dense interval in one process and reuses every cached output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seeit-batch-"));
    temporaryDirectories.push(directory);
    const runner = new FakeCommandRunner(async (_command, args) => {
      for (const arg of args.filter((arg) => arg.endsWith(".jpg"))) await writeFile(arg, "image");
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const extractor = new FfmpegFrameExtractor(runner);
    const request = { videoRef: "clip.mp4", times: [1, 2, 3, 4], outputDir: directory };
    const frames = await extractor.extractFrames(request);
    expect(frames.map((frame) => frame.time)).toEqual([1, 2, 3, 4]);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.args).toContain("-filter_complex");
    await extractor.extractFrames(request);
    expect(runner.calls).toHaveLength(1);
  });

  it("splits widely separated timestamps into bounded decoder windows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seeit-windows-"));
    temporaryDirectories.push(directory);
    const runner = new FakeCommandRunner(async (_command, args) => {
      for (const arg of args.filter((arg) => arg.endsWith(".jpg"))) await writeFile(arg, "image");
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await new FfmpegFrameExtractor(runner).extractFrames({ videoRef: "clip.mp4", times: [0, 2, 400, 402], outputDir: directory });
    expect(runner.calls).toHaveLength(2);
  });

  it("routes frame, clip, and scene work through an injected command runner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seeit-frame-extractor-"));
    temporaryDirectories.push(directory);
    const runner = new FakeCommandRunner((command, args) => ({
      exitCode: 0,
      stdout: "",
      stderr: args.includes("showinfo")
        ? ""
        : "[Parsed_showinfo_1] n:0 pts:0 pts_time:1.250\n[Parsed_showinfo_1] n:1 pts:0 pts_time:4.000",
    }));
    const extractor = new FfmpegFrameExtractor(runner, "fake-ffmpeg");
    const framePath = join(directory, "frame.jpg");

    const frame = await extractor.extractFrame({
      videoRef: "clip.mp4",
      time: 1.25,
      outputPath: framePath,
    });
    const scenes = await extractor.detectSceneChanges({ videoRef: "clip.mp4", threshold: 0.4 });
    const clip = await extractor.extractClip({
      videoRef: "clip.mp4",
      start: 1,
      end: 3,
      outputPath: join(directory, "clip.mp4"),
    });

    expect(frame).toMatchObject({ time: 1.25, ref: framePath });
    expect(scenes).toEqual([1.25, 4]);
    expect(clip).toMatchObject({ start: 1, end: 3 });
    expect(runner.calls.map((call) => call.command)).toEqual([
      "fake-ffmpeg",
      "fake-ffmpeg",
      "fake-ffmpeg",
    ]);
    expect(runner.calls[1]?.args).toContain("select='gt(scene,0.4)',showinfo");
  });

  it("uses an existing output frame as the extraction cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seeit-frame-cache-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "already.jpg");
    await writeFile(outputPath, "cached image");
    const runner = new FakeCommandRunner({ exitCode: 0, stdout: "", stderr: "" });

    await expect(
      new FfmpegFrameExtractor(runner).extractFrame({
        videoRef: "clip.mp4",
        time: 0,
        outputPath,
      }),
    ).resolves.toMatchObject({ ref: outputPath });
    expect(runner.calls).toHaveLength(0);
  });
});
