import { createInterface } from "node:readline/promises";

import type { Readable, Writable } from "node:stream";

import type { CliTerminal } from "./types.js";

export interface NodeTerminalOptions {
  input?: Readable;
  output?: Writable;
}

/** Node readline adapter kept at the binary edge; interactive logic is injectable. */
export function createNodeTerminal(options: NodeTerminalOptions = {}): CliTerminal {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const readline = createInterface({ input, output, terminal: "isTTY" in input && input.isTTY === true });
  let closed = false;
  const queuedLines: string[] = [];
  let waiting: ((line: string | undefined) => void) | undefined;

  // `readline.question()` can lose subsequent lines from a pipe while the
  // shell is handling the previous command. Queue line events explicitly so
  // `printf '/videos\\n/status\\n' | seeit interactive` is deterministic.
  readline.on("line", (line: string) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(line);
      return;
    }
    queuedLines.push(line);
  });

  readline.on("SIGINT", () => {
    closed = true;
    readline.close();
  });
  readline.on("close", () => {
    closed = true;
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(undefined);
    }
  });

  return {
    write: (chunk) => output.write(chunk),
    question: async (prompt) => {
      output.write(prompt);
      const queued = queuedLines.shift();
      if (queued !== undefined) return queued;
      if (closed) return undefined;
      return new Promise<string | undefined>((resolve) => { waiting = resolve; });
    },
    clear: () => output.write("\x1Bc"),
    close: () => readline.close(),
  };
}
