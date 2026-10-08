import { describe, expect, it } from "vitest";

import { runCli } from "./app.js";
import type { CliRuntime, CliStorage, CliTerminal } from "./types.js";

class ScriptedTerminal implements CliTerminal {
  public output = "";
  public readonly prompts: string[] = [];
  public closed = false;

  public constructor(private readonly answers: Array<string | undefined>) {}

  write(chunk: string): void {
    this.output += chunk;
  }

  async question(prompt: string): Promise<string | undefined> {
    this.prompts.push(prompt);
    return this.answers.shift();
  }

  close(): void {
    this.closed = true;
  }
}

interface RuntimeSpy {
  runtime: CliRuntime;
  processCalls: Array<unknown[]>;
  askCalls: Array<unknown[]>;
  summaryCalls: Array<unknown[]>;
}

function createStorage(): CliStorage {
  return {
    rootDir: "/tmp/seeit-data",
    getVideoDir: (videoId) => `/tmp/seeit-data/${videoId}`,
    getArtifactPath: (videoId, artifact) => `/tmp/seeit-data/${videoId}/${artifact}.json`,
    getFramesDir: (videoId) => `/tmp/seeit-data/${videoId}/frames`,
    getCacheDir: (videoId) => `/tmp/seeit-data/${videoId}/cache`,
    readMetadata: async (videoId) => ({ videoId, duration: 42, title: `Title ${videoId}`, source: { kind: "local", uri: "/tmp/demo.mp4" } }),
    readTranscript: async () => ({ source: "original" as const, cues: [{ start: 0, end: 1, content: "hello" }] }),
    readUnderstanding: async (videoId) => ({ videoId, overview: "Overview", contentType: "talk" as const, sections: [] }),
    readTimeline: async (videoId) => ({ videoId, duration: 42, items: [] }),
    readPerceptionState: async () => undefined,
    listVideoSummaries: async () => [{
      videoId: "demo", title: "Demo", duration: 42,
      understanding: { status: "base", sectionCount: 0 },
    }],
  };
}

function createRuntime(storage: CliStorage): RuntimeSpy {
  const processCalls: Array<unknown[]> = [];
  const askCalls: Array<unknown[]> = [];
  const summaryCalls: Array<unknown[]> = [];
  return {
    processCalls,
    askCalls,
    summaryCalls,
    runtime: {
      storage,
      system: {
        process: async (...args: unknown[]) => {
          processCalls.push(args);
          const source = args[0] as { videoId?: string };
          return { videoId: source.videoId ?? "processed", overview: "Processed", contentType: "talk" as const, sections: [], status: "base" as const };
        },
        ask: async (...args: unknown[]) => {
          askCalls.push(args);
          return { answer: "Answer", reliable: true, usedReact: false, evidence: [], observations: [] };
        },
        summarize: async (...args: unknown[]) => {
          summaryCalls.push(args);
          return "Summary";
        },
      } as unknown as CliRuntime["system"],
    },
  };
}

describe("interactive CLI", () => {
  it("enters from no arguments; videos/open/status remain storage-only", async () => {
    const storage = createStorage();
    const terminal = new ScriptedTerminal(["/videos", "/open demo", "/status", "/exit"]);
    let runtimeCalls = 0;
    const code = await runCli({
      argv: [], terminal, createStorage: () => storage,
      createRuntime: async () => {
        runtimeCalls += 1;
        return createRuntime(storage).runtime;
      },
    });

    expect(code).toBe(0);
    expect(runtimeCalls).toBe(0);
    expect(terminal.output).toContain("SeeIt interactive shell");
    expect(terminal.output).toContain("- demo | Demo");
    expect(terminal.output).toContain("Current video: demo");
    expect(terminal.output).toContain("videoId: demo");
    expect(terminal.closed).toBe(true);
  });

  it("opens a video, answers ordinary chat, and summarizes through one lazy runtime", async () => {
    const storage = createStorage();
    const terminal = new ScriptedTerminal(["/open", "demo", "What happened?", "/summary concise", "/exit"]);
    const spy = createRuntime(storage);
    let runtimeCalls = 0;
    const code = await runCli({
      argv: ["interactive"], terminal, createStorage: () => storage,
      createRuntime: async () => { runtimeCalls += 1; return spy.runtime; },
    });

    expect(code).toBe(0);
    expect(runtimeCalls).toBe(1);
    expect(spy.askCalls).toEqual([["demo", "What happened?"]]);
    expect(spy.summaryCalls).toEqual([["demo", "concise"]]);
    expect(terminal.output).toContain("Answer");
    expect(terminal.output).toContain("Summary");
  });

  it("guides process prompts, forwards inputs, and automatically selects the result", async () => {
    const storage = createStorage();
    const terminal = new ScriptedTerminal([
      "/process", "C:/media/my demo.mp4", "new-video", "focus the chart", "y", "What changed?", "/exit",
    ]);
    const spy = createRuntime(storage);
    const code = await runCli({
      argv: ["interactive", "--data-dir", "saved"], terminal, createStorage: () => storage,
      createRuntime: async () => spy.runtime,
    });

    expect(code).toBe(0);
    expect(spy.processCalls[0]).toEqual([
      { kind: "local", uri: "C:/media/my demo.mp4", videoId: "new-video" },
      expect.objectContaining({ instruction: "focus the chart", perceptionEnabled: false }),
    ]);
    expect(spy.askCalls).toEqual([["new-video", "What changed?"]]);
    expect(terminal.output).toContain("Current video: new-video");
  });

  it("re-prompts only the perception confirmation when its answer is invalid", async () => {
    const storage = createStorage();
    const terminal = new ScriptedTerminal([
      "/process", "C:/media/demo.mp4", "kept-video", "keep these answers", "maybe", "n", "/exit",
    ]);
    const spy = createRuntime(storage);
    const code = await runCli({
      argv: [], terminal, createStorage: () => storage,
      createRuntime: async () => spy.runtime,
    });

    expect(code).toBe(0);
    expect(spy.processCalls).toHaveLength(1);
    expect(spy.processCalls[0]?.[0]).toEqual({ kind: "local", uri: "C:/media/demo.mp4", videoId: "kept-video" });
    expect(spy.processCalls[0]?.[1]).toEqual(expect.objectContaining({ instruction: "keep these answers", perceptionEnabled: true }));
    expect(terminal.prompts.filter((prompt) => prompt === "Local video path: ")).toHaveLength(1);
    expect(terminal.prompts.filter((prompt) => prompt === "Disable process perception? [y/N]: ")).toHaveLength(2);
    expect(terminal.output).toContain("Please answer y or n.");
  });

  it("keeps the shell alive after unknown commands and errors, then exits on EOF", async () => {
    const storage = createStorage();
    const terminal = new ScriptedTerminal(["/unknown", "/summary", undefined]);
    const code = await runCli({ argv: [], terminal, createStorage: () => storage });

    expect(code).toBe(0);
    expect(terminal.output).toContain("Unknown interactive command: /unknown");
    expect(terminal.output).toContain("Error: No current video");
    expect(terminal.output).toContain("Goodbye.");
  });

  it("recovers from a lazy runtime failure without blocking later storage-only status", async () => {
    const storage = createStorage();
    const terminal = new ScriptedTerminal(["/open demo", "What happened?", "/status", "/exit"]);
    let runtimeCalls = 0;
    const code = await runCli({
      argv: [], terminal, createStorage: () => storage,
      createRuntime: async () => {
        runtimeCalls += 1;
        throw new Error("provider unavailable");
      },
    });

    expect(code).toBe(0);
    expect(runtimeCalls).toBe(1);
    expect(terminal.output).toContain("Error: provider unavailable");
    expect(terminal.output).toContain("videoId: demo");
    expect(terminal.output).toContain("Goodbye.");
  });
});
