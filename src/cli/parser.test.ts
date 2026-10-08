import { describe, expect, it } from "vitest";

import { CliUsageError, parseCli } from "./parser.js";

describe("parseCli", () => {
  it("enters interactive mode by default and accepts its explicit storage/config options", () => {
    expect(parseCli([])).toEqual({ kind: "interactive", dataDir: "data" });
    expect(parseCli(["interactive", "--config", "providers.json", "--data-dir", "saved"])).toEqual({
      kind: "interactive", configPath: "providers.json", dataDir: "saved",
    });
    expect(() => parseCli(["interactive", "--json"])).toThrow(CliUsageError);
  });

  it("parses all supported process controls", () => {
    expect(parseCli([
      "process", "clip.mp4", "--video-id", "demo", "--force", "--instruction", "focus charts",
      "--no-perception", "--max-requests", "3", "--max-frames", "12", "--max-visual-seconds", "30.5",
      "--config", "config.json", "--data-dir", "output", "--json",
    ])).toEqual({
      kind: "process",
      video: "clip.mp4",
      videoId: "demo",
      force: true,
      instruction: "focus charts",
      perceptionEnabled: false,
      maxRequests: 3,
      maxFrames: 12,
      maxVisualSeconds: 30.5,
      configPath: "config.json",
      dataDir: "output",
      json: true,
    });
  });

  it("joins multiple ask question tokens while allowing common flags", () => {
    expect(parseCli(["ask", "demo", "what", "happened", "--data-dir", "saved", "at", "5:00"])).toEqual({
      kind: "ask",
      videoId: "demo",
      question: "what happened at 5:00",
      dataDir: "saved",
      json: false,
    });
  });

  it("keeps status storage-only", () => {
    expect(parseCli(["status", "demo", "--data-dir", "saved", "--json"])).toEqual({
      kind: "status",
      videoId: "demo",
      dataDir: "saved",
      json: true,
    });
    expect(() => parseCli(["status", "demo", "--config", "providers.json"])).toThrow(CliUsageError);
  });

  it("supports machine-readable help and version output", () => {
    expect(parseCli(["help", "--json"])).toEqual({ kind: "help", json: true });
    expect(parseCli(["--version", "--json"])).toEqual({ kind: "version", json: true });
  });

  it("preserves JSON subcommand help without requiring its positional argument", () => {
    expect(parseCli(["process", "--help", "--json"])).toEqual({ kind: "help", json: true });
    expect(parseCli(["process", "clip.mp4", "-h", "--json"])).toEqual({ kind: "help", json: true });
    expect(parseCli(["summarize", "--help", "--json"])).toEqual({ kind: "help", json: true });
    expect(parseCli(["ask", "--help", "--json"])).toEqual({ kind: "help", json: true });
    expect(parseCli(["status", "--help", "--json"])).toEqual({ kind: "help", json: true });
  });

  it.each([
    ["process", "clip.mp4", "--max-frames", "0"],
    ["process", "clip.mp4", "--force", "--force"],
    ["process", "clip.mp4", "--unknown"],
    ["process", "--unknown", "--help"],
    ["process", "--force", "--force", "--help"],
    ["process", "--instruction", "--help"],
    ["process", "clip.mp4", "--instruction", "-h"],
    ["process", "--help", "-h"],
    ["ask", "demo", "question", "-x"],
    ["summarize", "demo", "--instruction"],
    ["ask", "demo"],
  ])("rejects invalid syntax: %o", (argv) => {
    expect(() => parseCli(argv)).toThrow(CliUsageError);
  });
});
