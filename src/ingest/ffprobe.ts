import type { CommandRunner } from "./command-runner.js";
import { requireSuccess } from "./command-runner.js";

export interface ProbedStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  duration?: string | number;
  width?: number;
  height?: number;
  tags?: Record<string, string>;
  [key: string]: unknown;
}

export interface ProbedFormat {
  filename?: string;
  duration?: string | number;
  size?: string | number;
  format_name?: string;
  tags?: Record<string, string>;
  [key: string]: unknown;
}

export interface FfprobeResult {
  streams?: ProbedStream[];
  format?: ProbedFormat;
}

export interface MediaProbe {
  probe(mediaRef: string): Promise<FfprobeResult>;
}

/** ffprobe-backed metadata reader. Its runner is injected for testability. */
export class FfprobeMediaProbe implements MediaProbe {
  public constructor(
    private readonly runner: CommandRunner,
    private readonly executable = "ffprobe",
  ) {}

  async probe(mediaRef: string): Promise<FfprobeResult> {
    const args = [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      mediaRef,
    ];
    const result = requireSuccess(
      this.executable,
      args,
      await this.runner.run(this.executable, args),
    );

    try {
      return JSON.parse(result.stdout) as FfprobeResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`ffprobe returned invalid JSON for ${mediaRef}: ${message}`);
    }
  }
}

export function probeDuration(probe: FfprobeResult): number | undefined {
  const formatDuration = toFiniteSeconds(probe.format?.duration);
  if (formatDuration !== undefined) return formatDuration;

  const streamDurations = (probe.streams ?? [])
    .map((stream) => toFiniteSeconds(stream.duration))
    .filter((duration): duration is number => duration !== undefined);
  return streamDurations.length ? Math.max(...streamDurations) : undefined;
}

export function probeTags(probe: FfprobeResult): Record<string, string> {
  const tags: Record<string, string> = {};
  const copy = (source?: Record<string, string>) => {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (typeof value === "string" && value.trim()) tags[key.toLowerCase()] = value;
    }
  };

  copy(probe.format?.tags);
  for (const stream of probe.streams ?? []) copy(stream.tags);
  return tags;
}

export function hasAudioStream(probe: FfprobeResult): boolean {
  return (probe.streams ?? []).some((stream) => stream.codec_type === "audio");
}

export function firstAudioStream(probe: FfprobeResult): ProbedStream | undefined {
  return (probe.streams ?? []).find((stream) => stream.codec_type === "audio");
}

function toFiniteSeconds(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const numberValue = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(numberValue) && numberValue >= 0
    ? numberValue
    : undefined;
}
