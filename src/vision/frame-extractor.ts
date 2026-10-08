import { access, mkdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";

import type { FrameReference } from "../core/types.js";
import type { CommandRunner } from "../ingest/command-runner.js";
import { requireSuccess } from "../ingest/command-runner.js";

export interface FrameExtractionRequest {
  videoRef: string;
  time: number;
  outputPath: string;
  /** Re-extract even when the expected cached file already exists. */
  force?: boolean;
  metadata?: Record<string, unknown>;
}

export interface FramesExtractionRequest {
  videoRef: string;
  times: readonly number[];
  outputDir: string;
  extension?: ".jpg" | ".jpeg" | ".png" | ".webp";
  force?: boolean;
  metadata?: Record<string, unknown>;
}

export interface SceneChangeRequest {
  videoRef: string;
  threshold?: number;
  minSpacingSeconds?: number;
}

export interface ClipExtractionRequest {
  videoRef: string;
  start: number;
  end: number;
  outputPath: string;
  force?: boolean;
}

export interface ClipReference {
  ref: string;
  start: number;
  end: number;
  metadata?: Record<string, unknown>;
}

/**
 * This is also the small surface agent tools need for getFrame/getFrames and
 * getClip.  It does not analyze pixels; VLM calls stay explicitly separate.
 */
export interface FrameExtractor {
  extractFrame(request: FrameExtractionRequest): Promise<FrameReference>;
  extractFrames(request: FramesExtractionRequest): Promise<FrameReference[]>;
  detectSceneChanges?(request: SceneChangeRequest): Promise<number[]>;
  extractClip?(request: ClipExtractionRequest): Promise<ClipReference>;
}

export class FfmpegFrameExtractor implements FrameExtractor {
  public constructor(
    private readonly runner: CommandRunner,
    private readonly executable = "ffmpeg",
  ) {}

  async extractFrame(request: FrameExtractionRequest): Promise<FrameReference> {
    assertTimestamp(request.time, "time");
    const outputPath = absolutePath(request.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });

    if (!request.force && (await exists(outputPath))) {
      return frameReference(request.time, outputPath, request.metadata);
    }

    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      seconds(request.time),
      "-i",
      request.videoRef,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      "-y",
      outputPath,
    ];
    requireSuccess(
      this.executable,
      args,
      await this.runner.run(this.executable, args),
    );
    return frameReference(request.time, outputPath, request.metadata);
  }

  async extractFrames(request: FramesExtractionRequest): Promise<FrameReference[]> {
    const extension = request.extension ?? ".jpg";
    const normalizedTimes = uniqueTimes(request.times);
    const outputDir = absolutePath(request.outputDir);

    await mkdir(outputDir, { recursive: true });
    const frames = normalizedTimes.map((time, index) => frameReference(time,
      resolve(outputDir, `frame-${String(index).padStart(5, "0")}-${timestampSlug(time)}${extension}`), request.metadata));
    const missing: FrameReference[] = [];
    for (const frame of frames) {
      if (request.force || !(await exists(frame.ref))) missing.push(frame);
    }
    // Decode each dense window once. Limit both branches and decoded span;
    // widely separated sparse seeks must not decode the entire source.
    while (missing.length) {
      const firstTime = missing[0]!.time;
      const count = Math.min(12, missing.findIndex((frame) => frame.time - firstTime > 30) < 0
        ? missing.length : missing.findIndex((frame) => frame.time - firstTime > 30));
      const batch = missing.splice(0, count);
      if (batch.length === 1) {
        await this.extractFrame({ videoRef: request.videoRef, time: batch[0]!.time, outputPath: batch[0]!.ref,
          force: request.force, metadata: request.metadata });
        continue;
      }
      const labels = batch.map((_, index) => `[source${index}]`).join("");
      const filter = [`[0:v]split=${batch.length}${labels}`,
        ...batch.map((frame, index) => `[source${index}]select='gte(t,${seconds(frame.time - firstTime)})',trim=end_frame=1,setpts=PTS-STARTPTS[frame${index}]`)].join(";");
      const args = ["-hide_banner", "-loglevel", "error", "-ss", seconds(firstTime), "-i", request.videoRef,
        "-filter_complex_threads", "1", "-filter_complex", filter];
      for (const [index, frame] of batch.entries()) {
        args.push("-map", `[frame${index}]`, "-frames:v", "1", "-threads", "1", "-q:v", "2", "-y", frame.ref);
      }
      requireSuccess(this.executable, args, await this.runner.run(this.executable, args));
      for (const frame of batch) {
        if (!(await exists(frame.ref))) throw new Error(`No frame could be extracted at ${frame.time}s.`);
      }
    }
    return frames;
  }

  async detectSceneChanges(request: SceneChangeRequest): Promise<number[]> {
    const threshold = request.threshold ?? 0.35;
    const minSpacing = request.minSpacingSeconds ?? 0.5;
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
      throw new RangeError("scene change threshold must be between 0 and 1.");
    }
    assertTimestamp(minSpacing, "minSpacingSeconds");

    // showinfo writes pts_time to stderr.  This adds candidate frames only;
    // it never invokes a vision model for every decoded frame.
    const filter = `select='gt(scene,${threshold})',showinfo`;
    const args = [
      "-hide_banner",
      "-loglevel",
      "info",
      "-i",
      request.videoRef,
      "-vf",
      filter,
      "-an",
      "-fps_mode",
      "vfr",
      "-f",
      "null",
      "-",
    ];
    const result = requireSuccess(
      this.executable,
      args,
      await this.runner.run(this.executable, args),
    );
    const observed = `${result.stdout}\n${result.stderr}`;
    const times = [...observed.matchAll(/pts_time:([\d.+-]+)/g)]
      .map((match) => Number.parseFloat(match[1]))
      .filter((time) => Number.isFinite(time) && time >= 0)
      .sort((left, right) => left - right);

    const selected: number[] = [];
    for (const time of times) {
      if (selected.length === 0 || time - selected[selected.length - 1] >= minSpacing) {
        selected.push(time);
      }
    }
    return selected;
  }

  async extractClip(request: ClipExtractionRequest): Promise<ClipReference> {
    assertTimestamp(request.start, "start");
    assertTimestamp(request.end, "end");
    if (request.end <= request.start) {
      throw new RangeError("clip end must be greater than clip start.");
    }

    const outputPath = absolutePath(request.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    if (!request.force && (await exists(outputPath))) {
      return { ref: outputPath, start: request.start, end: request.end };
    }

    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      seconds(request.start),
      "-i",
      request.videoRef,
      "-t",
      seconds(request.end - request.start),
      "-map",
      "0",
      "-c",
      "copy",
      "-y",
      outputPath,
    ];
    requireSuccess(
      this.executable,
      args,
      await this.runner.run(this.executable, args),
    );
    return { ref: outputPath, start: request.start, end: request.end };
  }
}

export function frameOutputPath(
  outputDir: string,
  time: number,
  extension = ".jpg",
): string {
  assertTimestamp(time, "time");
  const safeExtension = extension.startsWith(".") ? extension : `.${extension}`;
  return resolve(absolutePath(outputDir), `frame-${timestampSlug(time)}${safeExtension}`);
}

function frameReference(
  time: number,
  ref: string,
  metadata?: Record<string, unknown>,
): FrameReference {
  return {
    time,
    ref,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function uniqueTimes(times: readonly number[]): number[] {
  const values = times.map((time) => {
    assertTimestamp(time, "frame time");
    return time;
  });
  return [...new Set(values)].sort((left, right) => left - right);
}

function timestampSlug(time: number): string {
  return time.toFixed(3).replace(".", "_");
}

function seconds(value: number): string {
  return value.toFixed(3);
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number.`);
  }
}

function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Convenience for callers choosing a safe extension from a desired path. */
export function imageExtension(path: string): ".jpg" | ".jpeg" | ".png" | ".webp" {
  const extension = extname(path).toLowerCase();
  return extension === ".png" || extension === ".webp" || extension === ".jpeg"
    ? extension
    : ".jpg";
}
