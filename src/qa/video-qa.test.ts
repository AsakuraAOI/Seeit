import { describe, expect, it } from "vitest";

import type { VideoTimeline, VideoUnderstanding } from "../core/types.js";
import { FakeLLMProvider } from "../providers/test-providers.js";
import type { VideoAgentTools } from "../tools/video-agent-tools.js";
import { VideoQAService } from "./video-qa.js";

function jsonResponse(value: unknown) {
  return { text: JSON.stringify(value), value };
}

const understanding: VideoUnderstanding = {
  videoId: "qa-1",
  overview: "A speaker explains why practice compounds.",
  contentType: "talk",
  sections: [{
    start: 0,
    end: 60,
    summary: "The speaker argues that feedback makes practice effective.",
    importance: 0.9,
    evidence: [{ type: "subtitle", start: 10, end: 12, ref: "sub-1" }],
  }],
};

const timeline: VideoTimeline = {
  videoId: "qa-1",
  duration: 240,
  items: [{
    id: "sub-1",
    type: "subtitle",
    start: 10,
    end: 12,
    content: "Feedback tells you what to practice next.",
    ref: "sub-1",
  }],
};

describe("VideoQAService", () => {
  it("rejects an uncited confident answer without adding arbitrary citations", async () => {
    const llm = new FakeLLMProvider(jsonResponse({ answer: "Unsupported assertion", sufficient: true, citations: [] }));
    const result = await new VideoQAService({ llm, repository: {
      readUnderstanding: async () => understanding, readTimeline: async () => timeline,
    } }).ask("qa-1", "What was said?");
    expect(result.reliable).toBe(false);
    expect(llm.requests).toHaveLength(1);
  });

  it("refines an ambiguous observation once within the shared budget, preserving answer quality", async () => {
    const calls: number[] = [];
    const llm = new FakeLLMProvider([
      jsonResponse({ answer: "Need label", sufficient: false, perceptionRequests: [{ modality: "frame", start: 20 }] }),
      jsonResponse({ answer: "Label is obscured", sufficient: false, perceptionRequests: [{ modality: "frame", start: 22 }] }),
      jsonResponse({ answer: "RTX 5070 Ti", sufficient: true, citations: [{ type: "frame", start: 22, end: 22, ref: "f22" }] }),
    ]);
    const service = new VideoQAService({ llm, repository: {
      readUnderstanding: async () => understanding, readTimeline: async () => timeline,
    }, getPerceptionTools: () => ({
      getFrame: async (time) => { calls.push(time); return { tool: "getFrame", summary: time === 22 ? "RTX 5070 Ti" : "Obscured label",
        evidence: [{ type: "frame", start: time, end: time, ref: `f${time}` }] }; },
      getFrames: async () => { throw new Error("not needed"); },
    }) });
    const result = await service.ask("qa-1", "What model is selected?");
    expect(result.reliable).toBe(true);
    expect(result.answer).toBe("RTX 5070 Ti");
    expect(calls).toEqual([20, 22]);
    expect(llm.requests).toHaveLength(3);
  });

  it("returns an evidence gap on asynchronous decoder failure without another LLM call", async () => {
    const llm = new FakeLLMProvider(jsonResponse({ answer: "Need frame", sufficient: false, perceptionRequests: [{ modality: "frame", start: 20 }] }));
    const result = await new VideoQAService({ llm, repository: {
      readUnderstanding: async () => understanding, readTimeline: async () => timeline,
    }, getPerceptionTools: () => ({ getFrame: async () => { throw new Error("decoder unavailable"); }, getFrames: async () => { throw new Error("unused"); } })
    }).ask("qa-1", "What is on screen?");
    expect(result.reliable).toBe(false);
    expect(result.observations[0]?.summary).toContain("decoder unavailable");
    expect(llm.requests).toHaveLength(1);
  });

  it("does not spend an extra round on repeated perception requests", async () => {
    const plan = { modality: "frame", start: 20 };
    const llm = new FakeLLMProvider(jsonResponse({ answer: "Still unknown", sufficient: false, perceptionRequests: [plan] }));
    let calls = 0;
    const result = await new VideoQAService({ llm, repository: {
      readUnderstanding: async () => understanding, readTimeline: async () => timeline,
    }, getPerceptionTools: () => ({ getFrame: async (time) => { calls += 1; return { tool: "getFrame", summary: "Unknown label", evidence: [{ type: "frame", start: time, end: time }] }; }, getFrames: async () => { throw new Error("unused"); } })
    }).ask("qa-1", "What is on screen?");
    expect(result.reliable).toBe(false);
    expect(calls).toBe(1);
    expect(llm.requests).toHaveLength(2);
  });

  it("answers directly from persistent understanding and relevant timeline evidence", async () => {
    let reads = 0;
    let reactRequested = 0;
    const llm = new FakeLLMProvider(jsonResponse({
      answer: "它认为反馈能指出下一步该练什么，因此让练习更有效。",
      sufficient: true,
      citations: [{ type: "subtitle", start: 10, end: 12, ref: "sub-1" }],
    }));
    const service = new VideoQAService({
      llm,
      repository: {
        readUnderstanding: async () => {
          reads += 1;
          return understanding;
        },
        readTimeline: async () => {
          reads += 1;
          return timeline;
        },
      },
      getPerceptionTools: () => {
        reactRequested += 1;
        return undefined;
      },
    });

    const result = await service.ask("qa-1", "为什么反馈很重要？");

    expect(result.reliable).toBe(true);
    expect(result.usedReact).toBe(false);
    expect(result.answer).toContain("反馈");
    expect(result.evidence).toContainEqual({ type: "subtitle", start: 10, end: 12, ref: "sub-1" });
    expect(reactRequested).toBe(0);
    expect(reads).toBe(2);
  });

  it("Case E: falls back to a local tool for a timestamp question without reprocessing", async () => {
    let frameCalls = 0;
    const tools = {
      search: async () => ({ tool: "search" as const, summary: "", evidence: [] }),
      readAround: async () => ({ tool: "readAround" as const, summary: "", evidence: [] }),
      getFrame: async () => ({ tool: "getFrame" as const, summary: "", evidence: [] }),
      getFrames: async () => {
        frameCalls += 1;
        return {
          tool: "getFrames" as const,
          summary: "At 3:20, the blue curve crosses the red curve.",
          evidence: [{ type: "frame" as const, start: 195, end: 205, ref: "chart-200.jpg" }],
        };
      },
      getClip: async () => ({ tool: "getClip" as const, summary: "", evidence: [] }),
    } as unknown as VideoAgentTools;
    const llm = new FakeLLMProvider([
      jsonResponse({
        answer: "需要局部回看 3:20 附近画面。",
        sufficient: false,
        citations: [],
        missingInformation: "缺少 3:20 附近的视觉事件。",
        perceptionRequests: [{ modality: "frames", start: 195, end: 205, count: 3 }],
      }),
      jsonResponse({
        action: "answer",
        answer: "3:20 左右蓝线越过红线，升至第一。",
        sufficient: true,
        citations: [{ type: "frame", start: 195, end: 205, ref: "chart-200.jpg" }],
      }),
    ]);
    let understandingReads = 0;
    let timelineReads = 0;
    const chartUnderstanding: VideoUnderstanding = {
      videoId: "qa-1",
      overview: "A chart changes through the video.",
      contentType: "chart",
      sections: [{
        start: 0,
        end: 240,
        summary: "Several ranking curves are visible.",
        importance: 0.6,
        evidence: [{ type: "frame", start: 0, end: 240 }],
      }],
    };
    const service = new VideoQAService({
      llm,
      repository: {
        readUnderstanding: async () => {
          understandingReads += 1;
          return chartUnderstanding;
        },
        readTimeline: async () => {
          timelineReads += 1;
          return { ...timeline, items: [] };
        },
      },
      getPerceptionTools: () => tools,
    });

    const result = await service.ask("qa-1", "3:20发生了什么？");

    expect(result.reliable).toBe(true);
    expect(result.usedReact).toBe(false);
    expect(result.usedPerception).toBe(true);
    expect(llm.requests).toHaveLength(2);
    expect(result.answer).toContain("蓝线");
    expect(result.observations).toHaveLength(1);
    expect(frameCalls).toBe(1);
    expect(understandingReads).toBe(1);
    expect(timelineReads).toBe(1);
  });

  it("does not pretend to know an answer when persistent understanding is absent", async () => {
    const service = new VideoQAService({
      llm: new FakeLLMProvider({ text: "unused" }),
      repository: {
        readUnderstanding: async () => undefined,
        readTimeline: async () => undefined,
      },
    });

    const result = await service.ask("missing", "发生了什么？");

    expect(result.reliable).toBe(false);
    expect(result.answer).toContain("无法从当前视频证据可靠确认");
  });
});
