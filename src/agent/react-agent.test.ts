import { describe, expect, it } from "vitest";

import type { VideoUnderstanding } from "../core/types.js";
import { FakeLLMProvider } from "../providers/test-providers.js";
import type { VideoAgentTools } from "../tools/video-agent-tools.js";
import { MAX_REACT_STEPS, ReactAgent } from "./react-agent.js";

const understanding: VideoUnderstanding = {
  videoId: "react-1",
  overview: "A chart changes late in the video.",
  contentType: "chart",
  sections: [{
    start: 0,
    end: 60,
    summary: "The chart is shown throughout.",
    importance: 0.6,
    evidence: [{ type: "frame", start: 0, end: 60 }],
  }],
};

function jsonResponse(value: unknown) {
  return { text: JSON.stringify(value), value };
}

describe("ReactAgent", () => {
  it("uses a local visual tool, retains its observation as evidence, then answers", async () => {
    let frameCalls = 0;
    const tools = {
      search: async () => ({ tool: "search" as const, summary: "", evidence: [] }),
      readAround: async () => ({ tool: "readAround" as const, summary: "", evidence: [] }),
      getFrame: async () => ({ tool: "getFrame" as const, summary: "", evidence: [] }),
      getFrames: async () => {
        frameCalls += 1;
        return {
          tool: "getFrames" as const,
          summary: "The blue curve overtakes the red curve at 3:20.",
          evidence: [{ type: "frame" as const, start: 195, end: 205, ref: "frame-200.jpg" }],
        };
      },
      getClip: async () => ({ tool: "getClip" as const, summary: "", evidence: [] }),
    } as unknown as VideoAgentTools;
    const llm = new FakeLLMProvider([
      jsonResponse({
        action: "getFrames",
        args: { start: 195, end: 205, count: 3 },
        missingInformation: "Need the visual crossover at 3:20.",
      }),
      jsonResponse({
        action: "answer",
        answer: "3:20 左右蓝线超过红线并升至第一。",
        sufficient: true,
        citations: [{ type: "frame", start: 195, end: 205, ref: "frame-200.jpg" }],
      }),
    ]);

    const result = await new ReactAgent({ llm, tools }).run({
      question: "3:20 发生了什么？",
      understanding,
      knownEvidence: [{ evidence: { type: "frame", start: 0, end: 60 }, content: "Chart" }],
      missingInformation: "Need a local visual observation.",
    });

    expect(result.reliable).toBe(true);
    expect(result.answer).toContain("蓝线");
    expect(result.steps).toBe(1);
    expect(result.observations).toHaveLength(1);
    expect(result.evidence).toContainEqual({ type: "frame", start: 195, end: 205, ref: "frame-200.jpg" });
    expect(frameCalls).toBe(1);
  });

  it("stops at MAX_REACT_STEPS and clearly refuses to guess", async () => {
    let calls = 0;
    const tools = {
      search: async () => {
        calls += 1;
        return { tool: "search" as const, summary: "No match", evidence: [] };
      },
      readAround: async () => ({ tool: "readAround" as const, summary: "", evidence: [] }),
      getFrame: async () => ({ tool: "getFrame" as const, summary: "", evidence: [] }),
      getFrames: async () => ({ tool: "getFrames" as const, summary: "", evidence: [] }),
      getClip: async () => ({ tool: "getClip" as const, summary: "", evidence: [] }),
    } as unknown as VideoAgentTools;
    const llm = new FakeLLMProvider(jsonResponse({ action: "search", args: { query: "unknown fact" } }));

    const result = await new ReactAgent({ llm, tools }).run({
      question: "谁拿到了隐藏奖杯？",
      understanding,
    });

    expect(result.reliable).toBe(false);
    expect(result.steps).toBe(MAX_REACT_STEPS);
    expect(result.answer).toContain("无法从当前视频证据可靠确认");
    expect(calls).toBe(MAX_REACT_STEPS);
  });

  it("does not accept an unanalysed media reference as reliable evidence", async () => {
    const tools = {
      search: async () => ({ tool: "search" as const, summary: "", evidence: [] }),
      readAround: async () => ({ tool: "readAround" as const, summary: "", evidence: [] }),
      getFrame: async () => ({
        tool: "getFrame" as const,
        summary: "Extracted frame at 10.00s; no vision provider is configured.",
        evidence: [],
        frames: [{ time: 10, ref: "frame-10.jpg" }],
      }),
      getFrames: async () => ({ tool: "getFrames" as const, summary: "", evidence: [] }),
      getClip: async () => ({ tool: "getClip" as const, summary: "", evidence: [] }),
    } as unknown as VideoAgentTools;
    const llm = new FakeLLMProvider([
      jsonResponse({ action: "getFrame", args: { time: 10 } }),
      jsonResponse({
        action: "answer",
        answer: "画面里出现了奖杯。",
        sufficient: true,
        citations: [{ type: "frame", start: 10, end: 10, ref: "frame-10.jpg" }],
      }),
    ]);

    const result = await new ReactAgent({ llm, tools }).run({
      question: "10 秒时出现了什么？",
      understanding,
    });

    expect(result.reliable).toBe(false);
    expect(result.answer).toContain("无法从当前视频证据可靠确认");
  });
});
