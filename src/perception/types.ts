import type { EvidenceRef, UnresolvedQuestion, VisualObservation } from "../core/types.js";

export type PerceptionModality = "frame" | "frames" | "clip";

export type PerceptionPurpose =
  | "resolve_visual_reference"
  | "read_screen"
  | "identify_object"
  | "identify_action"
  | "understand_scene"
  | "verify_claim"
  | "fill_visual_gap";

/** A bounded, time-addressable request for new visual evidence. */
export interface PerceptionRequest {
  id: string;
  modality: PerceptionModality;
  start: number;
  end: number;
  purpose: PerceptionPurpose;
  question: string;
  reason?: string;
  /** Higher values are executed first. Values are normalized to [0, 1]. */
  priority: number;
  sectionId?: string;
}

/** Hard limits applied to every deterministic process-time plan. */
export interface PerceptionBudget {
  maxRequests: number;
  maxFrames: number;
  maxVisualSeconds?: number;
}

/** Pixel-independent signals used as one planner input, never a classifier. */
export interface VisualProfile {
  duration: number;
  /** False means sceneChangeRate is unknown, not evidence of a static video. */
  sceneDetectionPerformed?: boolean;
  sampledFrameCount: number;
  sceneChangeTimestamps: number[];
  sceneChangeCount: number;
  sceneChangeRate: number;
  staticRatio?: number;
  motionScore?: number;
  slideLikeChangeRate?: number;
}

export interface PerceptionExecutionStats {
  generatedRequests: number;
  plannedRequests: number;
  executedRequests: number;
  deferredRequests: number;
  framesExtracted: number;
  visionBatches: number;
  cacheHits: number;
}

/** Durable evidence accumulated by process-time and QA-time perception. */
export interface PerceptionState {
  version: 1;
  videoId: string;
  visualProfile?: VisualProfile;
  candidateRequests: PerceptionRequest[];
  plannedRequests: PerceptionRequest[];
  executedRequests: PerceptionRequest[];
  observations: VisualObservation[];
  unresolved: UnresolvedQuestion[];
  stats: PerceptionExecutionStats;
}

export interface PerceptionExecutionResult {
  observations: VisualObservation[];
  executedRequests: PerceptionRequest[];
  cacheHits: number;
  framesExtracted: number;
  visionBatches: number;
}

export interface PerceptionPlan {
  requests: PerceptionRequest[];
  deferred: UnresolvedQuestion[];
  generatedCount: number;
}

export type ProvenancedVisualObservation = VisualObservation & {
  evidence: EvidenceRef[];
  metadata: Record<string, unknown>;
};
