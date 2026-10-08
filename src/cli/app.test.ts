import { describe, expect, it } from "vitest";

import type { CliRuntime, CliWriter } from "./types.js";
import { runCli } from "./app.js";

class CaptureWriter implements CliWriter {
  public output = "";

  write(chunk: string): void {
    this.output += chunk;
  }
}

function createRuntime(): CliRuntime {
  const storage = {
    rootDir: "/tmp/seeit-data",
    getVideoDir: (videoId: string) => `/tmp/seeit-data/${videoId}`,
    getArtifactPath: (videoId: string, artifact: string) => `/tmp/seeit-data/${videoId}/${artifact}.json`,
    getFramesDir: (videoId: string) => `/tmp/seeit-data/${videoId}/frames`,
    getCacheDir: (videoId: string) => `/tmp/seeit-data/${videoId}/cache`,
    readMetadata: async (videoId: string) => ({ videoId, duration: 25, source: { kind: "local" as const, uri: "/tmp/clip.mp4" } }),
    readTranscript: async () => ({ cues: [{ start: 0, end: 2, content: "hello" }], source: "original" as const }),
    readUnderstanding: async (videoId: string) => ({ videoId, overview: "Overview", contentType: "talk" as const, sections: [] }),
    readTimeline: async (videoId: string) => ({ videoId, duration: 25, items: [] }),
    listVideoSummaries: async () => [],
    readPerceptionState: async () => ({
      version: 1 as const,
      videoId: "demo",
      candidateRequests: [],
      plannedRequests: [],
      executedRequests: [],
      observations: [],
      unresolved: [],
      stats: { generatedRequests: 0, plannedRequests: 0, executedRequests: 0, deferredRequests: 0, framesExtracted: 0, visionBatches: 0, cacheHits: 0 },
    }),
  };
  return {
    storage: storage as unknown as CliRuntime["storage"],
    system: {
      process: async (source) => ({
        videoId: source.videoId ?? "generated",
        overview: "Overview",
        contentType: "talk" as const,
        sections: [],
        status: "base" as const,
      }),
      summarize: async () => "Summary text",
      ask: async () => ({ answer: "Answer text", reliable: true, usedReact: false, evidence: [], observations: [] }),
    } as unknown as CliRuntime["system"],
  };
}

describe("runCli", () => {
  it("keeps JSON stdout clean while system diagnostics go to stderr", async () => {
    const stdout = new CaptureWriter();
    const stderr = new CaptureWriter();
    let logger: { info(message: string): void } | undefined;
    let receivedOptions: unknown;
    const runtime = createRuntime();
    const original = runtime.system.process;
    runtime.system.process = (async (...args: Parameters<typeof original>) => {
      logger?.info("[process] base understanding generated");
      receivedOptions = args[1];
      return original(...args);
    }) as typeof runtime.system.process;

    const code = await runCli({
      argv: ["process", "clip.mp4", "--video-id", "demo", "--no-perception", "--json"],
      stdout,
      stderr,
      createRuntime: async (options) => {
        logger = options.logger;
        return runtime;
      },
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.output)).toMatchObject({ command: "process", videoId: "demo" });
    expect(stderr.output).toContain("[process] base understanding generated");
    expect(receivedOptions).toMatchObject({ perceptionEnabled: false, perceptionBudget: {} });
  });

  it("uses storage directly for status and never initializes the provider runtime", async () => {
    const stdout = new CaptureWriter();
    const storage = createRuntime().storage;
    const code = await runCli({
      argv: ["status", "demo", "--json"],
      stdout,
      createStorage: () => storage,
      createRuntime: async () => {
        throw new Error("runtime must not be created for status");
      },
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.output)).toMatchObject({ command: "status", videoId: "demo" });
  });

  it("emits subcommand JSON help without creating a runtime", async () => {
    const stdout = new CaptureWriter();
    const code = await runCli({
      argv: ["process", "clip.mp4", "--help", "--json"],
      stdout,
      createRuntime: async () => {
        throw new Error("runtime must not be created for help");
      },
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.output)).toMatchObject({ command: "help" });
  });

  it("does not let subcommand help suppress an invalid flag", async () => {
    const stdout = new CaptureWriter();
    const stderr = new CaptureWriter();
    const code = await runCli({
      argv: ["process", "--unknown", "--help", "--json"],
      stdout,
      stderr,
    });

    expect(code).toBe(2);
    expect(stdout.output).toBe("");
    expect(JSON.parse(stderr.output)).toMatchObject({ error: { code: "usage", message: "Unsupported option: --unknown" } });
  });

  it("does not create a runtime when a value option is followed by short help", async () => {
    const stdout = new CaptureWriter();
    const stderr = new CaptureWriter();
    const code = await runCli({
      argv: ["process", "clip.mp4", "--instruction", "-h", "--json"],
      stdout,
      stderr,
      createRuntime: async () => {
        throw new Error("runtime must not be created for malformed values");
      },
    });

    expect(code).toBe(2);
    expect(stdout.output).toBe("");
    expect(JSON.parse(stderr.output)).toMatchObject({ error: { code: "usage" } });
  });

  it("uses exit code 2 for parsing failures and reports JSON errors on stderr", async () => {
    const stdout = new CaptureWriter();
    const stderr = new CaptureWriter();
    const code = await runCli({ argv: ["process", "clip.mp4", "--max-frames", "0", "--json"], stdout, stderr });

    expect(code).toBe(2);
    expect(stdout.output).toBe("");
    expect(JSON.parse(stderr.output)).toMatchObject({ error: { code: "usage" } });
  });
});
