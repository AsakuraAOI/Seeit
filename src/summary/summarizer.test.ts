import { describe, expect, it } from "vitest";

import type { VideoUnderstanding } from "../core/types.js";
import { FakeLLMProvider } from "../providers/test-providers.js";
import { summarize, VideoSummarizer } from "./summarizer.js";

const understanding: VideoUnderstanding = {
  videoId: "summary-1",
  overview: "A chart shows a late change in ranking.",
  contentType: "chart",
  sections: [
    {
      start: 0,
      end: 10,
      summary: "The lines begin close together.",
      visual: "The red line leads narrowly.",
      importance: 0.4,
      evidence: [{ type: "frame", start: 0, end: 10 }],
    },
    {
      start: 10,
      end: 20,
      summary: "The blue line rises into first place.",
      visual: "A crossover occurs near the middle.",
      importance: 0.95,
      evidence: [{ type: "frame", start: 10, end: 20 }],
    },
  ],
};

describe("VideoSummarizer", () => {
  it("uses content-type-specific deterministic structure from VideoUnderstanding only", async () => {
    const result = await summarize(understanding);

    expect(result).toContain("## 时间阶段");
    expect(result).toContain("## 关键变化");
    expect(result).toContain("## 趋势");
    expect(result).toContain("blue line rises");
  });

  it("gives an explicit user instruction priority in the model prompt", async () => {
    const llm = new FakeLLMProvider({
      text: '{"summary":"蓝线在中段完成反超，之后保持领先。"}',
      value: { summary: "蓝线在中段完成反超，之后保持领先。" },
    });
    const result = await new VideoSummarizer({ llm }).summarize(
      understanding,
      "重点关注曲线/排名变化。",
    );

    expect(result).toBe("蓝线在中段完成反超，之后保持领先。");
    const prompt = llm.requests[0]?.messages?.[1]?.content ?? "";
    expect(prompt).toContain("重点关注曲线/排名变化");
    expect(prompt).toContain("A chart shows a late change");
    expect(prompt).not.toContain("raw video");
  });

  it("falls back to grounded deterministic output for malformed model JSON", async () => {
    const llm = new FakeLLMProvider({ text: "not JSON" });
    const result = await new VideoSummarizer({ llm }).summarize(understanding);

    expect(result).toContain("A chart shows a late change in ranking.");
    expect(result).toContain("## 时间阶段");
  });
});
