import { describe, expect, it } from "vitest";

import { FakeLLMProvider } from "../providers/test-providers.js";
import { GlobalUnderstandingService } from "./global-understanding.js";

function jsonResponse(value: unknown) {
  return { text: JSON.stringify(value), value };
}

describe("GlobalUnderstandingService", () => {
  it("Case A: grounds a talk in subtitles without requesting visual refinement", async () => {
    const llm = new FakeLLMProvider(jsonResponse({
      overview: "The speaker argues that deliberate practice compounds over time.",
      contentType: "talk",
      sections: [{
        start: 0,
        end: 30,
        summary: "The speaker presents the main claim.",
        importance: 0.9,
        evidence: [{ type: "subtitle", start: 0, end: 30 }],
      }],
      refinementRequests: [],
    }));
    let refinementCalls = 0;
    const service = new GlobalUnderstandingService({
      llm,
      refineVisual: async () => {
        refinementCalls += 1;
        return undefined;
      },
    });

    const result = await service.understand({
      videoId: "talk-1",
      duration: 30,
      title: "Why practice matters",
      description: "A short talk about learning.",
      transcript: [{ start: 0, end: 30, content: "Deliberate practice compounds over time." }],
    });

    expect(result.understanding.contentType).toBe("talk");
    expect(result.understanding.sections[0]?.evidence[0]?.type).toBe("subtitle");
    expect(result.refinementsUsed).toBe(0);
    expect(refinementCalls).toBe(0);
    expect(llm.requests).toHaveLength(1);
  });

  it("Case B: retains description evidence without mislabeling it as visual evidence", async () => {
    const llm = new FakeLLMProvider(jsonResponse({
      overview: "The description explains the otherwise sparse short story.",
      contentType: "story",
      sections: [{
        start: 0,
        end: 12,
        summary: "The uploader description supplies the background and outcome.",
        visual: "A courier is visibly carrying a package through the storm.",
        importance: 0.8,
        evidence: [{ type: "description", start: 0, end: 12, ref: "metadata:description" }],
      }],
    }));

    const result = await new GlobalUnderstandingService({ llm }).understand({
      videoId: "description-1",
      duration: 12,
      title: "Sparse clip",
      description: "A courier returns a lost package to its owner after a storm.",
    });

    expect(result.understanding.sections[0]?.visual).toBeUndefined();
    expect(result.understanding.sections[0]?.evidence).toEqual([
      { type: "description", start: 0, end: 12, ref: "metadata:description" },
    ]);
    const prompt = llm.requests[0]?.messages?.[1]?.content ?? "";
    expect(prompt).toContain("metadata:description");
  });

  it("Case C: uses visual observations for a silent gameplay video", async () => {
    const llm = new FakeLLMProvider(jsonResponse({
      overview: "A player steers around obstacles and reaches the finish.",
      contentType: "gameplay",
      sections: [{
        start: 0,
        end: 20,
        summary: "The player navigates the final obstacle course.",
        visual: "The vehicle avoids two barriers before crossing the finish line.",
        importance: 0.95,
        evidence: [{ type: "frame", start: 0, end: 20 }],
      }],
    }));

    const result = await new GlobalUnderstandingService({ llm }).understand({
      videoId: "game-1",
      duration: 20,
      visualObservations: [{
        start: 0,
        end: 20,
        summary: "A vehicle enters an obstacle course and reaches a finish line.",
        visualEvents: ["Two barriers are avoided."],
      }],
    });

    expect(result.understanding.contentType).toBe("gameplay");
    expect(result.understanding.sections[0]?.visual).toContain("barriers");
    expect(llm.requests[0]?.messages?.[1]?.content).toContain("obstacle course");
  });

  it("Case D: carries a curve-focused instruction into global understanding and caps refinement", async () => {
    const llm = new FakeLLMProvider([
      jsonResponse({
        overview: "A ranking chart changes over time.",
        contentType: "chart",
        sections: [{
          start: 0,
          end: 30,
          summary: "Several lines appear on a ranking chart.",
          importance: 0.8,
          evidence: [{ type: "frame", start: 0, end: 30 }],
        }],
        refinementRequests: [
          { start: 10, end: 20, reason: "Need to identify the leading line after the crossover." },
          { start: 20, end: 25, reason: "Need to confirm the final ranking." },
          { start: 25, end: 30, reason: "This request must be capped." },
        ],
      }),
      jsonResponse({
        overview: "The blue line overtakes the red line and remains first.",
        contentType: "chart",
        sections: [{
          start: 0,
          end: 30,
          summary: "The ranking is stable at first, crosses over midway, then settles.",
          visual: "The blue curve crosses above the red curve near the middle.",
          importance: 0.95,
          evidence: [{ type: "frame", start: 10, end: 20 }],
        }],
      }),
    ]);
    const refinementRequests: Array<{ start: number; end: number }> = [];
    const service = new GlobalUnderstandingService({
      llm,
      refineVisual: async (request) => {
        refinementRequests.push(request);
        return {
          start: request.start,
          end: request.end,
          summary: "The blue curve crosses above the red curve.",
        };
      },
    });

    const result = await service.understand({
      videoId: "chart-1",
      duration: 30,
      instruction: "重点关注曲线/排名变化。",
      visualObservations: [{ start: 0, end: 30, summary: "A multi-line ranking chart." }],
    });

    expect(result.understanding.contentType).toBe("chart");
    expect(result.refinementsUsed).toBe(2);
    expect(refinementRequests).toHaveLength(2);
    expect(llm.requests).toHaveLength(2);
    expect(result.understanding.sections[0]?.visual).toContain("blue curve");
    expect(llm.requests[0]?.messages?.[1]?.content).toContain("重点关注曲线/排名变化");
  });
});
