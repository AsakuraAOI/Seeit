import { describe, expect, it } from "vitest";

import {
  FakeASRProvider,
  FakeVisionProvider,
  FunctionLLMProvider,
  FunctionVisionProvider,
} from "./test-providers.js";

describe("provider test adapters", () => {
  it("records vision and ASR requests without any vendor dependency", async () => {
    const vision = new FakeVisionProvider({
      images: { start: 0, end: 2, summary: "A title card." },
    });
    const asr = new FakeASRProvider([{ start: 0, end: 1, content: "Hello" }]);

    await vision.analyzeImages({ images: [{ time: 0, ref: "frame.jpg" }] });
    await asr.transcribe({ audioRef: "audio.wav" });

    expect(vision.imageRequests).toHaveLength(1);
    expect(vision.analyzeClip).toBeUndefined();
    expect(asr.requests).toEqual([{ audioRef: "audio.wav" }]);
  });

  it("adapts a function-shaped LLM provider", async () => {
    const provider = new FunctionLLMProvider(async (request) => ({ text: request.prompt ?? "" }));
    await expect(provider.generate({ prompt: "summarize" })).resolves.toMatchObject({ text: "summarize" });
  });

  it("keeps clip analysis absent when a function provider did not opt into it", () => {
    const provider = new FunctionVisionProvider(async () => ({
      start: 0,
      end: 0,
      summary: "frame",
    }));
    expect(provider.analyzeClip).toBeUndefined();
  });
});
