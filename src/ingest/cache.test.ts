import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { FileIngestCache } from "./cache.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("FileIngestCache", () => {
  it("persists values using safe opaque filenames", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seeit-asr-cache-"));
    temporaryDirectories.push(directory);
    const key = "asr:../../source.mp4";
    const first = new FileIngestCache(directory);
    await first.set(key, { cues: [{ start: 0, content: "cached" }] });

    const second = new FileIngestCache(directory);
    await expect(second.get<{ cues: Array<{ content: string }> }>(key)).resolves.toEqual({
      cues: [{ start: 0, content: "cached" }],
    });
    expect(first.pathFor(key)).not.toContain("..");
  });
});
