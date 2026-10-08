import { describe, expect, it } from "vitest";
import { boundQaPerceptionPlan, QA_PERCEPTION_LIMITS } from "./perception-plan.js";

describe("finite QA perception budget", () => {
  it("limits maliciously oversized model plans without rejecting all useful work", () => {
    const plan = boundQaPerceptionPlan(Array.from({ length: 100 }, (_, i) => ({ modality: "frames", start: i * 100, end: i * 100 + 100, count: 999 })), 5000);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.length).toBeLessThanOrEqual(2);
    expect(plan.reduce((sum, request) => sum + request.count, 0)).toBeLessThanOrEqual(QA_PERCEPTION_LIMITS.maxFrames);
    expect(plan.reduce((sum, request) => sum + request.end - request.start, 0)).toBeLessThanOrEqual(30);
  });

  it("ignores malformed and duplicated requests and stops when the shared budget is exhausted", () => {
    expect(boundQaPerceptionPlan([{ modality: "clip", start: 10 }, { modality: "frame", start: -1 }, { modality: "frame", start: NaN }], 100)).toEqual([]);
    expect(boundQaPerceptionPlan([{ modality: "frame", start: 10 }, { modality: "frame", start: 10.02 }], 100)).toHaveLength(1);
    expect(boundQaPerceptionPlan([{ modality: "frame", start: 10 }], 100, { maxRequests: 0, maxFrames: 12, maxVisualSeconds: 30 })).toEqual([]);
    expect(boundQaPerceptionPlan([{ modality: "frame", start: 100 }], 100)[0]?.start).toBeLessThan(100);
  });
});
