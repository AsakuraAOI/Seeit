import type { QAResult } from "../qa/video-qa.js";
import type { StoredVideoSummary, VideoStorage } from "../storage/video-storage.js";
import type { VideoUnderstandingSystem } from "../system/video-understanding-system.js";

export interface CommonCliOptions {
  configPath?: string;
  dataDir: string;
  json: boolean;
}

export interface ProcessCliCommand extends CommonCliOptions {
  kind: "process";
  video: string;
  videoId?: string;
  force: boolean;
  instruction?: string;
  perceptionEnabled: boolean;
  maxRequests?: number;
  maxFrames?: number;
  maxVisualSeconds?: number;
}

export interface SummarizeCliCommand extends CommonCliOptions {
  kind: "summarize";
  videoId: string;
  instruction?: string;
}

export interface AskCliCommand extends CommonCliOptions {
  kind: "ask";
  videoId: string;
  question: string;
}

export interface StatusCliCommand extends CommonCliOptions {
  kind: "status";
  videoId: string;
}

export interface InteractiveCliCommand {
  kind: "interactive";
  configPath?: string;
  dataDir: string;
}

export interface HelpCliCommand {
  kind: "help";
  json: boolean;
}

export interface VersionCliCommand {
  kind: "version";
  json: boolean;
}

export type CliCommand =
  | ProcessCliCommand
  | SummarizeCliCommand
  | AskCliCommand
  | StatusCliCommand
  | InteractiveCliCommand
  | HelpCliCommand
  | VersionCliCommand;

export interface CliWriter {
  write(chunk: string): void;
}

/** Minimal interactive terminal seam; tests can script it without a TTY. */
export interface CliTerminal extends CliWriter {
  question(prompt: string): Promise<string | undefined>;
  clear?(): void;
  close?(): void;
}

export type CliTerminalFactory = () => Promise<CliTerminal> | CliTerminal;

export interface CliStorage {
  rootDir: string;
  getVideoDir(videoId: string): string;
  getArtifactPath(videoId: string, artifact: "metadata" | "timeline" | "understanding" | "transcript" | "danmaku" | "perception"): string;
  getFramesDir(videoId: string): string;
  getCacheDir(videoId: string): string;
  readMetadata: VideoStorage["readMetadata"];
  readTranscript: VideoStorage["readTranscript"];
  readUnderstanding: VideoStorage["readUnderstanding"];
  readTimeline: VideoStorage["readTimeline"];
  readPerceptionState: VideoStorage["readPerceptionState"];
  listVideoSummaries(): Promise<StoredVideoSummary[]>;
}

export interface CliRuntime {
  system: Pick<VideoUnderstandingSystem, "process" | "summarize" | "ask">;
  storage: CliStorage;
}

export interface CliRuntimeOptions {
  configPath?: string;
  dataDir: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  logger: Pick<Console, "info">;
}

export type CliRuntimeFactory = (options: CliRuntimeOptions) => Promise<CliRuntime>;

export type CliStorageFactory = (dataDir: string, cwd: string) => CliStorage;

export type CliAskResult = QAResult;
