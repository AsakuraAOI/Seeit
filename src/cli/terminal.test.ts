import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createNodeTerminal } from "./terminal.js";

describe("createNodeTerminal", () => {
  it("queues piped lines that arrive before the next shell prompt", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const terminal = createNodeTerminal({ input, output });
    input.end("/videos\n/status\n");
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(terminal.question("one> ")).resolves.toBe("/videos");
    await expect(terminal.question("two> ")).resolves.toBe("/status");
    await expect(terminal.question("three> ")).resolves.toBeUndefined();
  });
});
