import { describe, expect, it } from "vitest";

import type { FrameReference } from "../core/types.js";
import type { FrameExtractor } from "../vision/frame-extractor.js";
import { buildVisualProfile } from "./visual-profile.js";

describe("buildVisualProfile", () => {
  it("sorts and deduplicates cheap scene timestamps without extracting frames", async () => {
    let frameExtractions = 0;
    const extractor: FrameExtractor = {
      extractFrame: async (): Promise<FrameReference> => {
        frameExtractions += 1;
        return { time: 0, ref: "unused" };
      },
      extractFrames: async (): Promise<FrameReference[]> => {
        frameExtractions += 1;
        return [];
      },
      detectSceneChanges: async () => [3, 1, 3, 2.0004, 2.0001, -1, 11],
    };

    const profile = await buildVisualProfile({ duration: 10, videoRef: "memory://video", frameExtractor: extractor });

    expect(profile).toMatchObject({ sampledFrameCount: 0, sceneChangeTimestamps: [1, 2, 3], sceneChangeCount: 3, sceneChangeRate: 0.3 });
    expect(frameExtractions).toBe(0);
  });
});
