import { describe, expect, it } from "vitest";

import type { Transcript, VideoTimeline, VideoUnderstanding } from "../core/types.js";
import { estimateFrames, PerceptionPlanner } from "./planner.js";

const understanding: VideoUnderstanding = {
  videoId: "video-1", overview: "Base", contentType: "talk",
  sections: [{ start: 0, end: 3_600, summary: "Base", importance: 0.5, evidence: [{ type: "subtitle", start: 0, end: 3_600 }] }],
};

describe("PerceptionPlanner", () => {
  it("retains useful silent-video coverage under a small frame budget", () => {
    const plan = new PerceptionPlanner().plan({ duration: 60, understanding, budget: { maxFrames: 12 } });
    expect(plan.requests.length).toBeGreaterThan(0);
    expect(plan.requests.reduce((sum, request) => sum + estimateFrames(request), 0)).toBeLessThanOrEqual(12);
    expect(plan.requests.at(-1)?.end).toBeCloseTo(60);
    expect(new PerceptionPlanner().plan({ duration: 60, understanding, budget: { maxFrames: 1 } }).requests).toHaveLength(1);
  });

  it("does not treat a five-second introduction as sufficient text for an hour-long video", () => {
    const plan = new PerceptionPlanner().plan({ duration: 3600, understanding,
      transcript: { cues: [{ start: 0, end: 5, content: "A short introduction with more than twenty-four characters." }] } });
    expect(plan.requests.length).toBeGreaterThan(0);
  });

  it("clamps, merges overlapping requests, and leaves budgeted work unresolved", () => {
    const plan = new PerceptionPlanner().plan({
      duration: 100,
      understanding,
      candidates: [
        request("first", -5, 12, 0.6),
        request("same-range", 1, 13, 0.9),
        request("later", 40, 90, 0.8),
        request("outside", 100, 101, 1),
      ],
      transcript: { cues: [{ start: 0, end: 100, content: "Enough transcript evidence to prevent the silent-video fallback." }] },
      budget: { maxRequests: 1, maxFrames: 12, maxVisualSeconds: 30 },
    });

    expect(plan.generatedCount).toBe(3);
    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0]).toMatchObject({ start: 0, end: 13, priority: 0.9 });
    expect(plan.deferred).toHaveLength(1);
    expect(plan.deferred[0]).toMatchObject({ start: 40, end: 90 });
  });

  it("recognizes a local textual visual reference rather than sampling the whole video", () => {
    const timeline: VideoTimeline = {
      videoId: "video-1", duration: 1_200,
      items: [{ id: "cue-1", type: "subtitle", start: 310, end: 312, content: "大家看屏幕左边这个参数，the presenter is continuing a detailed explanation." }],
    };
    const transcript: Transcript = { cues: timeline.items.map(({ start, end, content }) => ({ start, end: end ?? start, content: content ?? "" })) };
    const plan = new PerceptionPlanner().plan({ duration: 1_200, understanding, timeline, transcript });

    const local = plan.requests.find((request) => request.purpose === "resolve_visual_reference");
    expect(local?.start).toBeGreaterThan(290);
    expect(local?.end).toBeLessThan(330);
    expect(plan.requests.reduce((sum, request) => sum + estimateFrames(request), 0)).toBeLessThanOrEqual(48);
  });

  it("spreads a bounded broad fallback across a long no-text video", () => {
    const plan = new PerceptionPlanner().plan({
      duration: 5_000,
      understanding,
      transcript: { cues: [] },
      budget: { maxRequests: 8, maxFrames: 48, maxVisualSeconds: 120 },
    });

    expect(plan.requests.length).toBeGreaterThan(1);
    expect(plan.requests).toHaveLength(8);
    expect(plan.requests[0]).toMatchObject({ start: 0, purpose: "understand_scene" });
    expect(plan.requests.at(-1)?.end).toBeCloseTo(5_000, 6);
    expect(plan.requests.reduce((total, request) => total + request.end - request.start, 0)).toBeLessThanOrEqual(120);
    expect(plan.requests.reduce((total, request) => total + estimateFrames(request), 0)).toBeLessThanOrEqual(48);
  });
});

function request(id: string, start: number, end: number, priority: number) {
  return {
    id, start, end, priority, modality: "frames" as const, purpose: "fill_visual_gap" as const,
    question: id,
  };
}
