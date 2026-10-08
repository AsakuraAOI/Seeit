import { describe, expect, it } from "vitest";

import { FakeCommandRunner } from "./command-runner.js";
import { FfprobeMediaProbe, hasAudioStream, probeDuration, probeTags } from "./ffprobe.js";

describe("FfprobeMediaProbe", () => {
  it("uses the injected runner and normalizes useful metadata", async () => {
    const runner = new FakeCommandRunner({
      exitCode: 0,
      stdout: JSON.stringify({
        format: { duration: "19.25", tags: { TITLE: "Local title" } },
        streams: [{ codec_type: "video" }, { index: 2, codec_type: "audio" }],
      }),
      stderr: "",
    });
    const result = await new FfprobeMediaProbe(runner, "fake-ffprobe").probe("clip.mp4");

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      command: "fake-ffprobe",
      args: expect.arrayContaining(["-show_format", "-show_streams", "clip.mp4"]),
    });
    expect(probeDuration(result)).toBe(19.25);
    expect(probeTags(result)).toMatchObject({ title: "Local title" });
    expect(hasAudioStream(result)).toBe(true);
  });
});
