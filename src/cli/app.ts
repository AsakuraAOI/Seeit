import { runInteractiveSession } from "./interactive.js";
import { CliUsageError, parseCli } from "./parser.js";
import { buildProcessResult, buildStatusResult, presentAsk, presentProcess, presentStatus } from "./presenters.js";
import { createCliRuntime, createCliStorage } from "./runtime.js";
import { createNodeTerminal } from "./terminal.js";
import type {
  CliCommand,
  CliRuntimeFactory,
  CliStorageFactory,
  CliTerminal,
  CliTerminalFactory,
  CliWriter,
} from "./types.js";

export const CLI_HELP = `SeeIt — adaptive multimodal video understanding

Usage:
  seeit                              Start the interactive shell
  seeit interactive [options]        Start the interactive shell explicitly
  seeit process <video> [options]
  seeit summarize <videoId> [options]
  seeit ask <videoId> <question...> [options]
  seeit status <videoId> [--data-dir <path>] [--json]

Common batch options:
  --config <path>       Provider configuration (defaults to SEEIT_CONFIG or seeit.config.json)
  --data-dir <path>     Persistent data root (default: data)
  --json                Emit one machine-readable JSON result on stdout

process options:
  --video-id <id>       Stable persistence identifier
  --force               Rebuild derived understanding, retaining raw evidence/cache
  --instruction <text>  Focus base understanding and selective perception
  --no-perception       Disable process-time visual perception
  --max-requests <n>    Positive bound for process-time visual requests
  --max-frames <n>      Positive bound for extracted visual frames
  --max-visual-seconds <n>  Positive visual-duration budget

Interactive commands:
  /videos, /open <videoId>, /process, /summary [instruction], /status, /help, /clear, /exit

Other commands:
  seeit help | --help | -h
  seeit --version | -V
`;

export interface RunCliOptions {
  argv: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  stdout?: CliWriter;
  stderr?: CliWriter;
  terminal?: CliTerminal;
  createTerminal?: CliTerminalFactory;
  version?: string;
  createRuntime?: CliRuntimeFactory;
  createStorage?: CliStorageFactory;
}

/**
 * Application boundary with injectable terminal, storage, and runtime. It
 * never invokes process.exit, so the binary and tests retain lifecycle control.
 */
export async function runCli(options: RunCliOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const version = options.version ?? "0.1.0";
  let command: CliCommand | undefined;
  try {
    command = parseCli(options.argv);
    if (command.kind === "help") {
      writeSuccess(stdout, command.json, { command: "help", text: CLI_HELP }, CLI_HELP);
      return 0;
    }
    if (command.kind === "version") {
      writeSuccess(stdout, command.json, { command: "version", version }, `${version}\n`);
      return 0;
    }
    if (command.kind === "interactive") {
      const storage = (options.createStorage ?? createCliStorage)(command.dataDir, cwd);
      const terminal = options.terminal ?? await (options.createTerminal ?? createNodeTerminal)();
      return runInteractiveSession({
        terminal,
        storage,
        dataDir: command.dataDir,
        ...(command.configPath ? { configPath: command.configPath } : {}),
        cwd,
        env,
        createRuntime: options.createRuntime ?? createCliRuntime,
      });
    }
    if (command.kind === "status") {
      const storage = (options.createStorage ?? createCliStorage)(command.dataDir, cwd);
      const result = await buildStatusResult(command.videoId, storage);
      writeSuccess(stdout, command.json, result, presentStatus(result));
      return 0;
    }

    const logger = { info: (message: string) => stderr.write(`${message}\n`) };
    const runtime = await (options.createRuntime ?? createCliRuntime)({
      ...(command.configPath ? { configPath: command.configPath } : {}),
      dataDir: command.dataDir,
      cwd,
      env,
      logger,
    });
    if (command.kind === "process") {
      const result = await buildProcessResult(command, runtime);
      writeSuccess(stdout, command.json, result, presentProcess(result));
      return 0;
    }
    if (command.kind === "summarize") {
      const summary = await runtime.system.summarize(command.videoId, command.instruction);
      writeSuccess(stdout, command.json, { command: "summarize", videoId: command.videoId, summary }, `${summary}\n`);
      return 0;
    }
    const answer = await runtime.system.ask(command.videoId, command.question);
    writeSuccess(stdout, command.json, { command: "ask", videoId: command.videoId, ...answer }, presentAsk(answer));
    return 0;
  } catch (error) {
    const usage = error instanceof CliUsageError;
    const message = friendlyError(error);
    const json = command?.kind === "interactive" ? false : command?.json ?? options.argv.includes("--json");
    const payload = { error: { code: usage ? "usage" : "runtime", message } };
    stderr.write(json ? `${JSON.stringify(payload)}\n` : `${usage ? "Usage error" : "Error"}: ${message}\n`);
    if (usage && !json) stderr.write("Run `seeit help` for usage.\n");
    return usage ? 2 : 1;
  }
}

function writeSuccess(stdout: CliWriter, json: boolean, payload: object, human: string): void {
  stdout.write(json ? `${JSON.stringify(payload)}\n` : human);
}

function friendlyError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.replace(/[\r\n]+/g, " ");
  return "The command could not be completed.";
}
