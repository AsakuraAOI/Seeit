import type { DanmakuEntry, Transcript, VideoTimeline, VideoUnderstanding } from "../core/types.js";
import type { LLMProvider } from "../providers/interfaces.js";
import type { PerceptionRequest, VisualProfile } from "../perception/types.js";
import { GlobalUnderstandingService } from "./global-understanding.js";

export interface BaseUnderstandingInput {
  videoId: string;
  duration: number;
  title?: string;
  description?: string;
  transcript?: Transcript;
  danmaku?: readonly DanmakuEntry[];
  timeline: VideoTimeline;
  visualProfile: VisualProfile;
  instruction?: string;
}

export interface BaseUnderstandingResult {
  understanding: VideoUnderstanding;
  perceptionRequests: PerceptionRequest[];
}

/**
 * Builds a useful persistent understanding solely from cheap evidence. It
 * intentionally wires no visual refiner: asking to see a range is data, not a
 * side effect of the base pass.
 */
export class BaseUnderstandingService {
  public constructor(private readonly dependencies: { llm: LLMProvider }) {}

  public async build(input: BaseUnderstandingInput): Promise<BaseUnderstandingResult> {
    const result = await new GlobalUnderstandingService({ llm: this.dependencies.llm }).understand({
      videoId: input.videoId,
      duration: input.duration,
      ...(input.title ? { title: input.title } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.transcript ? { transcript: input.transcript } : {}),
      ...(input.danmaku ? { representativeDanmaku: input.danmaku } : {}),
      timeline: input.timeline,
      visualProfile: {
        duration: input.visualProfile.duration,
        sceneDetectionPerformed: input.visualProfile.sceneDetectionPerformed,
        sceneChangeCount: input.visualProfile.sceneChangeCount,
        sceneChangeRate: input.visualProfile.sceneChangeRate,
      },
      ...(input.instruction ? { instruction: input.instruction } : {}),
    });
    return {
      understanding: {
        ...result.understanding,
        status: "base",
      },
      perceptionRequests: result.perceptionRequests ?? [],
    };
  }
}
