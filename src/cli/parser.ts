import type {
  AskCliCommand,
  CliCommand,
  CommonCliOptions,
  InteractiveCliCommand,
  ProcessCliCommand,
  StatusCliCommand,
  SummarizeCliCommand,
} from "./types.js";

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const COMMON_FLAGS = new Set(["--config", "--data-dir", "--json"]);
const PROCESS_FLAGS = new Set([
  ...COMMON_FLAGS,
  "--video-id",
  "--force",
  "--instruction",
  "--no-perception",
  "--max-requests",
  "--max-frames",
  "--max-visual-seconds",
]);
const SUMMARIZE_FLAGS = new Set([...COMMON_FLAGS, "--instruction"]);
const ASK_FLAGS = new Set(COMMON_FLAGS);
// status deliberately stays storage-only: a provider config is meaningless
// there and accepting one would make the command appear to load providers.
const STATUS_FLAGS = new Set(["--data-dir", "--json"]);
const INTERACTIVE_FLAGS = new Set(["--config", "--data-dir"]);
const HELP_FLAGS = new Set(["--help", "-h"]);
const VALUE_FLAGS = new Set([
  "--config",
  "--data-dir",
  "--video-id",
  "--instruction",
  "--max-requests",
  "--max-frames",
  "--max-visual-seconds",
]);

/** Strict, side-effect-free argument parser used by both the binary and tests. */
export function parseCli(argv: readonly string[]): CliCommand {
  if (argv.length === 0) return { kind: "interactive", dataDir: "data" };
  if (isHelp(argv[0]!)) return parseMeta(argv.slice(1), "help");
  if (isVersion(argv[0]!)) return parseMeta(argv.slice(1), "version");

  const [name, ...remaining] = argv;
  if (!name || name.startsWith("-")) {
    throw new CliUsageError(`Unknown command: ${name ?? ""}`.trim());
  }
  if (name === "help") {
    return parseMeta(remaining, "help");
  }
  if (name === "process") return parseProcess(remaining);
  if (name === "summarize") return parseSummarize(remaining);
  if (name === "ask") return parseAsk(remaining);
  if (name === "status") return parseStatus(remaining);
  if (name === "interactive") return parseInteractive(remaining);
  throw new CliUsageError(`Unknown command: ${name}`);
}

function parseInteractive(tokens: readonly string[]): InteractiveCliCommand | { kind: "help"; json: boolean } {
  const { parsed, helpRequested } = splitSubcommandArguments(tokens, INTERACTIVE_FLAGS);
  const common = commonOptions(parsed.values);
  if (helpRequested) {
    validateHelpPositionals(parsed.positionals, 0, "interactive");
    return { kind: "help", json: false };
  }
  if (parsed.positionals.length !== 0) {
    throw new CliUsageError("interactive does not accept positional arguments.");
  }
  return {
    kind: "interactive",
    ...(common.configPath ? { configPath: common.configPath } : {}),
    dataDir: common.dataDir,
  };
}

function parseMeta(tokens: readonly string[], kind: "help" | "version"): CliCommand {
  if (tokens.length === 0) return { kind, json: false };
  if (tokens.length === 1 && tokens[0] === "--json") return { kind, json: true };
  throw new CliUsageError(`${kind} only accepts --json.`);
}

function parseProcess(tokens: readonly string[]): ProcessCliCommand | { kind: "help"; json: boolean } {
  const { parsed, helpRequested } = splitSubcommandArguments(tokens, PROCESS_FLAGS);
  const common = commonOptions(parsed.values);
  const videoId = value(parsed.values, "--video-id");
  const instruction = value(parsed.values, "--instruction");
  const maxRequests = numericOption(parsed.values, "--max-requests", positiveInteger);
  const maxFrames = numericOption(parsed.values, "--max-frames", positiveInteger);
  const maxVisualSeconds = numericOption(parsed.values, "--max-visual-seconds", positiveNumber);
  if (helpRequested) {
    validateHelpPositionals(parsed.positionals, 1, "process");
    return { kind: "help", json: common.json };
  }
  if (parsed.positionals.length !== 1) {
    throw new CliUsageError("process requires exactly one <video> path.");
  }
  return {
    kind: "process",
    ...common,
    video: parsed.positionals[0]!,
    ...(videoId ? { videoId } : {}),
    force: parsed.values.has("--force"),
    ...(instruction ? { instruction } : {}),
    perceptionEnabled: !parsed.values.has("--no-perception"),
    ...(maxRequests === undefined ? {} : { maxRequests }),
    ...(maxFrames === undefined ? {} : { maxFrames }),
    ...(maxVisualSeconds === undefined ? {} : { maxVisualSeconds }),
  };
}

function parseSummarize(tokens: readonly string[]): SummarizeCliCommand | { kind: "help"; json: boolean } {
  const { parsed, helpRequested } = splitSubcommandArguments(tokens, SUMMARIZE_FLAGS);
  const common = commonOptions(parsed.values);
  const instruction = value(parsed.values, "--instruction");
  if (helpRequested) {
    validateHelpPositionals(parsed.positionals, 1, "summarize");
    return { kind: "help", json: common.json };
  }
  if (parsed.positionals.length !== 1) {
    throw new CliUsageError("summarize requires exactly one <videoId>.");
  }
  return {
    kind: "summarize",
    ...common,
    videoId: parsed.positionals[0]!,
    ...(instruction ? { instruction } : {}),
  };
}

function parseAsk(tokens: readonly string[]): AskCliCommand | { kind: "help"; json: boolean } {
  const { parsed, helpRequested } = splitSubcommandArguments(tokens, ASK_FLAGS);
  const common = commonOptions(parsed.values);
  if (helpRequested) return { kind: "help", json: common.json };
  if (parsed.positionals.length < 2) {
    throw new CliUsageError("ask requires <videoId> and a non-empty <question>.");
  }
  return {
    kind: "ask",
    ...common,
    videoId: parsed.positionals[0]!,
    question: parsed.positionals.slice(1).join(" ").trim(),
  };
}

function parseStatus(tokens: readonly string[]): StatusCliCommand | { kind: "help"; json: boolean } {
  const { parsed, helpRequested } = splitSubcommandArguments(tokens, STATUS_FLAGS);
  const common = commonOptions(parsed.values);
  if (helpRequested) {
    validateHelpPositionals(parsed.positionals, 1, "status");
    return { kind: "help", json: common.json };
  }
  if (parsed.positionals.length !== 1) {
    throw new CliUsageError("status requires exactly one <videoId>.");
  }
  return { kind: "status", ...common, videoId: parsed.positionals[0]! };
}

function splitSubcommandArguments(
  tokens: readonly string[],
  allowed: ReadonlySet<string>,
): { parsed: ReturnType<typeof splitArguments>; helpRequested: boolean } {
  const parsed = splitArguments(tokens, new Set([...allowed, ...HELP_FLAGS]));
  const helpCount = [...HELP_FLAGS].filter((flag) => parsed.values.has(flag)).length;
  if (helpCount > 1) {
    throw new CliUsageError("Only one help option may be provided.");
  }
  return { parsed, helpRequested: helpCount === 1 };
}

function validateHelpPositionals(positionals: readonly string[], maximum: number, command: string): void {
  if (positionals.length > maximum) {
    throw new CliUsageError(`${command} accepts at most ${maximum} positional argument${maximum === 1 ? "" : "s"} with --help.`);
  }
}

function splitArguments(tokens: readonly string[], allowed: ReadonlySet<string>): {
  positionals: string[];
  values: Map<string, string | true>;
} {
  const values = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (!allowed.has(token)) throw new CliUsageError(`Unsupported option: ${token}`);
    if (values.has(token)) throw new CliUsageError(`Option may only be provided once: ${token}`);
    if (!VALUE_FLAGS.has(token)) {
      values.set(token, true);
      continue;
    }
    const next = tokens[index + 1];
    // Do not consume short help flags (or negative-looking budget values) as
    // a value. Both cases are malformed CLI syntax and must stay on the usage
    // path rather than accidentally reaching a command runtime.
    if (!next || next.startsWith("-")) throw new CliUsageError(`Option requires a value: ${token}`);
    values.set(token, next);
    index += 1;
  }
  return { positionals, values };
}

function commonOptions(values: Map<string, string | true>): CommonCliOptions {
  const configPath = value(values, "--config");
  const dataDir = value(values, "--data-dir") ?? "data";
  if (!dataDir.trim()) throw new CliUsageError("--data-dir must not be empty.");
  return {
    ...(configPath ? { configPath } : {}),
    dataDir,
    json: values.has("--json"),
  };
}

function value(values: Map<string, string | true>, flag: string): string | undefined {
  const result = values.get(flag);
  if (typeof result !== "string") return undefined;
  if (!result.trim()) throw new CliUsageError(`${flag} must not be empty.`);
  return result;
}

function numericOption(
  values: Map<string, string | true>,
  flag: string,
  parse: (raw: string, flag: string) => number,
): number | undefined {
  const raw = value(values, flag);
  return raw === undefined ? undefined : parse(raw, flag);
}

function positiveInteger(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function positiveNumber(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliUsageError(`${flag} must be a positive finite number.`);
  }
  return parsed;
}

function isHelp(value: string): boolean {
  return value === "--help" || value === "-h";
}

function isVersion(value: string): boolean {
  return value === "--version" || value === "-V";
}
