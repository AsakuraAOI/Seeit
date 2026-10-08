import type { FrameExtractor } from "../vision/frame-extractor.js";
import type { VisualProfile } from "./types.js";

export interface VisualProfileInput {
  duration: number;
  videoRef: string;
  frameExtractor: FrameExtractor;
  detectSceneChanges?: boolean;
}

/**
 * Collects cheap, non-semantic visual signals. Scene detection decodes video
 * but never extracts images or calls a VisionProvider, so failures are safe.
 */
export async function buildVisualProfile(input: VisualProfileInput): Promise<VisualProfile> {
  if (!Number.isFinite(input.duration) || input.duration <= 0) {
    throw new RangeError("duration must be a positive finite number.");
  }
  let timestamps: number[] = [];
  let sceneDetectionPerformed = false;
  if (input.detectSceneChanges !== false && input.frameExtractor.detectSceneChanges) {
    try {
      timestamps = (await input.frameExtractor.detectSceneChanges({ videoRef: input.videoRef }))
        .filter((time) => Number.isFinite(time) && time >= 0 && time <= input.duration)
        .map((time) => Number(time.toFixed(3)))
        .sort((left, right) => left - right)
        .filter((time, index, values) => index === 0 || values[index - 1] !== time);
      sceneDetectionPerformed = true;
    } catch {
      // Scene profiling is an optimization, not a reason to reject ingest.
      timestamps = [];
    }
  }
  return {
    duration: input.duration,
    sceneDetectionPerformed,
    sampledFrameCount: 0,
    sceneChangeTimestamps: timestamps,
    sceneChangeCount: timestamps.length,
    sceneChangeRate: timestamps.length / Math.max(input.duration, 1),
  };
}
