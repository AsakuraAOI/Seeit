import { buildProcessResult, buildStatusResult, formatDuration, presentAsk, presentProcess, presentStatus } from "./presenters.js";
import type {
  CliRuntime,
  CliRuntimeFactory,
  CliStorage,
  CliTerminal,
  ProcessCliCommand,
} from "./types.js";

const INTERACTIVE_HELP = `Interactive commands:
  /videos                     List persisted videos (no provider needed)
  /open <videoId>             Select a persisted video; /switch is an alias
  /process                    Process a local video through guided prompts
  /summary [instruction]      Summarize the current video
  /status                     Show durable status for the current video
  /clear                      Clear the terminal
  /help                       Show this help
  /exit, /quit                Exit

With a current video selected, enter ordinary text to ask a question.`;

export interface InteractiveSessionOptions {
  terminal: CliTerminal;
  storage: CliStorage;
  dataDir: string;
  configPath?: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  createRuntime: CliRuntimeFactory;
}

/** A small readline-style shell; every command failure is recoverable in-session. */
export async function runInteractiveSession(options: InteractiveSessionOptions): Promise<number> {
  let currentVideoId: string | undefined;
  let runtime: CliRuntime | undefined;

  const getRuntime = async (): Promise<CliRuntime> => {
    if (runtime) return runtime;
    runtime = await options.createRuntime({
      ...(options.configPath ? { configPath: options.configPath } : {}),
      dataDir: options.dataDir,
      cwd: options.cwd,
      env: options.env,
      logger: { info: (message: string) => options.terminal.write(`${message}\n`) },
    });
    return runtime;
  };

  options.terminal.write([
    "SeeIt interactive shell",
    `Data dir: ${options.storage.rootDir}`,
    "Current video: none",
    "Type /help for commands. Process a local video with /process.",
  ].join("\n") + "\n");

  try {
    while (true) {
      const input = await options.terminal.question(currentVideoId ? `seeit (${currentVideoId})> ` : "seeit> ");
      if (input === undefined) {
        options.terminal.write("Goodbye.\n");
        return 0;
      }
      const line = input.trim();
      if (!line) continue;

      try {
        if (!line.startsWith("/")) {
          if (!currentVideoId) {
            options.terminal.write("No current video. Use /open <videoId> or /process first.\n");
            continue;
          }
          const answer = await (await getRuntime()).system.ask(currentVideoId, line);
          options.terminal.write(presentAsk(answer));
          continue;
        }

        const action = await runSlashCommand(line, {
          ...options,
          getRuntime,
          getCurrentVideoId: () => currentVideoId,
          setCurrentVideoId: (videoId) => { currentVideoId = videoId; },
        });
        if (action === "exit") {
          options.terminal.write("Goodbye.\n");
          return 0;
        }
      } catch (error) {
        options.terminal.write(`Error: ${friendlyInteractiveError(error)}\n`);
      }
    }
  } finally {
    options.terminal.close?.();
  }
}

interface SlashCommandContext extends InteractiveSessionOptions {
  getRuntime(): Promise<CliRuntime>;
  getCurrentVideoId(): string | undefined;
  setCurrentVideoId(videoId: string): void;
}

async function runSlashCommand(line: string, context: SlashCommandContext): Promise<"continue" | "exit"> {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(line);
  if (!match) {
    context.terminal.write("Unknown interactive command. Type /help.\n");
    return "continue";
  }
  const command = match[1]!.toLocaleLowerCase();
  const argument = match[2]?.trim() ?? "";
  if (command === "exit" || command === "quit") return "exit";
  if (command === "help") {
    context.terminal.write(`${INTERACTIVE_HELP}\n`);
    return "continue";
  }
  if (command === "clear") {
    if (context.terminal.clear) context.terminal.clear();
    else context.terminal.write("\x1Bc");
    return "continue";
  }
  if (command === "videos") {
    const videos = await context.storage.listVideoSummaries();
    if (videos.length === 0) {
      context.terminal.write("No persisted videos in this data directory.\n");
      return "continue";
    }
    context.terminal.write(`${videos.map(formatVideo).join("\n")}\n`);
    return "continue";
  }
  if (command === "open" || command === "switch") {
    const videoId = argument || await prompt(context.terminal, "videoId: ");
    if (videoId === undefined) return "exit";
    if (!videoId) {
      context.terminal.write("videoId is required.\n");
      return "continue";
    }
    const metadata = await context.storage.readMetadata(videoId);
    if (!metadata) throw new Error(`No persisted video artifacts found for videoId: ${videoId}.`);
    context.setCurrentVideoId(videoId);
    context.terminal.write(`Current video: ${videoId}\n`);
    return "continue";
  }
  if (command === "status") {
    const videoId = requireCurrentVideo(context.getCurrentVideoId());
    context.terminal.write(presentStatus(await buildStatusResult(videoId, context.storage)));
    return "continue";
  }
  if (command === "process") {
    const outcome = await processFromPrompts(context);
    return outcome;
  }
  if (command === "summary") {
    const videoId = requireCurrentVideo(context.getCurrentVideoId());
    const summary = await (await context.getRuntime()).system.summarize(videoId, argument || undefined);
    context.terminal.write(`${summary}\n`);
    return "continue";
  }
  context.terminal.write(`Unknown interactive command: /${command}. Type /help.\n`);
  return "continue";
}

async function processFromPrompts(context: SlashCommandContext): Promise<"continue" | "exit"> {
  const video = await prompt(context.terminal, "Local video path: ");
  if (video === undefined) return "exit";
  if (!video) {
    context.terminal.write("A local video path is required.\n");
    return "continue";
  }
  const videoId = await prompt(context.terminal, "videoId (optional): ");
  if (videoId === undefined) return "exit";
  const instruction = await prompt(context.terminal, "Instruction (optional): ");
  if (instruction === undefined) return "exit";
  const disablePerception = await promptDisablePerception(context.terminal);
  if (disablePerception === undefined) return "exit";
  const command: ProcessCliCommand = {
    kind: "process",
    video,
    ...(videoId ? { videoId } : {}),
    force: false,
    ...(instruction ? { instruction } : {}),
    perceptionEnabled: !disablePerception,
    dataDir: context.dataDir,
    json: false,
  };
  const result = await buildProcessResult(command, await context.getRuntime());
  context.setCurrentVideoId(result.videoId as string);
  context.terminal.write(presentProcess(result));
  context.terminal.write(`Current video: ${result.videoId}\n`);
  return "continue";
}

async function prompt(terminal: CliTerminal, label: string): Promise<string | undefined> {
  const value = await terminal.question(label);
  return value === undefined ? undefined : value.trim();
}

function parseYesNo(value: string): boolean | undefined {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === "" || normalized === "n" || normalized === "no") return false;
  if (normalized === "y" || normalized === "yes") return true;
  return undefined;
}

/** Keep the guided process context intact when only the final confirmation is invalid. */
async function promptDisablePerception(terminal: CliTerminal): Promise<boolean | undefined> {
  while (true) {
    const value = await prompt(terminal, "Disable process perception? [y/N]: ");
    if (value === undefined) return undefined;
    const parsed = parseYesNo(value);
    if (parsed !== undefined) return parsed;
    terminal.write("Please answer y or n.\n");
  }
}

function requireCurrentVideo(videoId: string | undefined): string {
  if (!videoId) throw new Error("No current video. Use /open <videoId> or /process first.");
  return videoId;
}

function formatVideo(video: { videoId: string; title?: string; duration: number; understanding?: { status: string; sectionCount: number }; perception?: { observationCount: number; unresolvedCount: number } }): string {
  const understanding = video.understanding
    ? `${video.understanding.status}, ${video.understanding.sectionCount} sections`
    : "missing";
  const perception = video.perception
    ? `${video.perception.observationCount} observations, ${video.perception.unresolvedCount} unresolved`
    : "missing";
  return `- ${video.videoId} | ${video.title ?? "(untitled)"} | ${formatDuration(video.duration)} | understanding: ${understanding} | perception: ${perception}`;
}

function friendlyInteractiveError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.replace(/[\r\n]+/g, " ");
  return "The command could not be completed.";
}
