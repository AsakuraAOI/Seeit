import type {
  DanmakuEntry,
  EvidenceRef,
  TimelineItem,
  Transcript,
  VideoTimeline,
  VideoUnderstanding,
} from "../core/types.js";
import type { LLMProvider } from "../providers/interfaces.js";
import type { PerceptionRequest } from "../perception/types.js";

/** A time-addressable textual item accepted by the global understanding pass. */
export interface TimedText {
  start: number;
  end?: number;
  content: string;
  ref?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Deliberately shape-compatible with provider VisualObservation while allowing
 * callers to retain provider-specific metadata. All timestamps are seconds.
 */
export interface VisualObservationLike {
  start?: number;
  end?: number;
  time?: number;
  summary?: string;
  content?: string;
  visual?: string;
  description?: string;
  ref?: string;
  evidence?: EvidenceRef[];
  notableVisuals?: string[];
  visualEvents?: string[];
  contentTypeHints?: string[];
  needsRefinement?: boolean;
  metadata?: Record<string, unknown>;
}

export interface VisualRefinementRequest {
  videoId: string;
  start: number;
  end: number;
  reason: string;
  instruction?: string;
}

export type VisualRefiner = (
  request: VisualRefinementRequest,
) => Promise<VisualObservationLike | undefined>;

export interface GlobalUnderstandingInput {
  videoId: string;
  duration: number;
  title?: string;
  description?: string;
  /** May be a transcript string or already time-aligned subtitle entries. */
  transcript?: string | readonly TimedText[] | Transcript;
  /** A preselected danmaku subset is preferred for the global prompt. */
  representativeDanmaku?: readonly TimedText[] | readonly DanmakuEntry[];
  /** Compatibility alias when the caller has not separately sampled danmaku. */
  danmaku?: readonly TimedText[] | readonly DanmakuEntry[];
  visualObservations?: readonly VisualObservationLike[];
  /** Optional retained timeline; its source evidence is included if supplied. */
  timeline?: VideoTimeline | { items: readonly TimelineItem[] };
  /** Cheap non-semantic scene signals, never visual facts. */
  visualProfile?: Record<string, unknown>;
  /** A user focus that changes the global pass, not only the final summary. */
  instruction?: string;
}

export interface GlobalUnderstandingDependencies {
  llm: LLMProvider;
  /** Optional lazy local perception callback; never invoked more than the cap. */
  refineVisual?: VisualRefiner;
  maxVisualRefinements?: number;
}

export interface GlobalUnderstandingResult {
  understanding: VideoUnderstanding;
  refinementsUsed: number;
  /** Candidate requests are only proposals until a PerceptionPlanner accepts them. */
  perceptionRequests?: PerceptionRequest[];
}

export interface SummaryDependencies {
  llm?: LLMProvider;
}

export interface AnswerCitation {
  evidence: EvidenceRef;
  note?: string;
}

export interface DirectAnswer {
  answer: string;
  sufficient: boolean;
  missingInformation?: string;
  citations: AnswerCitation[];
}
