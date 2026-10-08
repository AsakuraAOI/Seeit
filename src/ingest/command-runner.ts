import { spawn } from "node:child_process";

/** A deliberately tiny seam around process execution, so tests never need ffmpeg. */
export interface CommandRunner {
  run(command: string, args: readonly string[], options?: CommandRunOptions): Promise<CommandResult>;
}

export interface CommandRunOptions {
  cwd?: string;
  timeoutMs?: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class CommandExecutionError extends Error {
  public constructor(
    public readonly command: string,
    public readonly args: readonly string[],
    public readonly result: CommandResult,
  ) {
    super(
      `${command} exited with code ${result.exitCode}: ${result.stderr || result.stdout}`,
    );
    this.name = "CommandExecutionError";
  }
}

/** The production runner; it intentionally does not invoke a shell. */
export class NodeCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: readonly string[],
    options: CommandRunOptions = {},
  ): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        callback();
      };

      child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (exitCode) =>
        finish(() =>
          resolve({
            exitCode: exitCode ?? -1,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          }),
        ),
      );

      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          child.kill();
          finish(() =>
            reject(
              new Error(
                `${command} timed out after ${options.timeoutMs}ms.`,
              ),
            ),
          );
        }, options.timeoutMs);
      }
    });
  }
}

/** A recording fake for unit tests and deterministic local adapters. */
export class FakeCommandRunner implements CommandRunner {
  public readonly calls: Array<{
    command: string;
    args: readonly string[];
    options?: CommandRunOptions;
  }> = [];

  public constructor(
    private readonly handler:
      | CommandResult
      | ((
          command: string,
          args: readonly string[],
          options?: CommandRunOptions,
        ) => CommandResult | Promise<CommandResult>),
  ) {}

  async run(
    command: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult> {
    this.calls.push({ command, args: [...args], options });
    return typeof this.handler === "function"
      ? this.handler(command, args, options)
      : this.handler;
  }
}

export function requireSuccess(
  command: string,
  args: readonly string[],
  result: CommandResult,
): CommandResult {
  if (result.exitCode !== 0) {
    throw new CommandExecutionError(command, args, result);
  }
  return result;
}
