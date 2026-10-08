import type {
  FrameReference,
  SubtitleCue,
  Transcript,
  VisionClipInput,
  VisionImageInput,
  VisualObservation,
} from "../core/types.js";

export type { VisionClipInput, VisionImageInput } from "../core/types.js";

/**
 * A small, provider-neutral contract for text generation.  Business modules
 * should depend on this interface instead of a vendor SDK.
 */
export interface LLMProvider {
  generate<T = string>(request: LLMRequest): Promise<LLMResponse<T>>;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  /** Use messages for chat-shaped providers; prompt is useful for simple ones. */
  messages?: LLMMessage[];
  prompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** A caller may ask the provider to deserialize a structured response. */
  responseFormat?: "text" | "json";
  metadata?: Record<string, unknown>;
}

export interface LLMResponse<T = string> {
  /** The provider's textual response, retained even for structured output. */
  text: string;
  /** Parsed output when the provider or caller has one. */
  value?: T;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface VisionProvider {
  /** Analyze a batch of representative images in one request when possible. */
  analyzeImages(request: VisionImageAnalysisRequest): Promise<VisualObservation>;
  /** Optional because many providers only accept images. */
  analyzeClip?(request: VisionClipAnalysisRequest): Promise<VisualObservation>;
}

export interface VisionImageAnalysisRequest {
  images: VisionImageInput[];
  videoId?: string;
  /** The time range represented by this batch, in seconds from video start. */
  start?: number;
  end?: number;
  instruction?: string;
  metadata?: Record<string, unknown>;
}

export interface VisionClipAnalysisRequest {
  clip: VisionClipInput;
  videoId?: string;
  instruction?: string;
  metadata?: Record<string, unknown>;
}

export interface ASRProvider {
  transcribe(request: ASRRequest): Promise<Transcript | SubtitleCue[]>;
}

export interface ASRRequest {
  /** An audio file, or a video file whose audio stream should be decoded. */
  audioRef: string;
  videoId?: string;
  language?: string;
  /** Timestamps must always be seconds from the start of the source video. */
  start?: number;
  end?: number;
  /** Total duration of the audio in seconds; used when the service returns whole-file text without segment timestamps. */
  duration?: number;
  metadata?: Record<string, unknown>;
}

/** Converts the deliberately flexible ASR result into subtitle cues. */
export function transcriptCues(
  result: Transcript | SubtitleCue[],
): SubtitleCue[] {
  return Array.isArray(result) ? result : result.cues;
}

/** Creates image inputs directly from sampled frames without leaking provider details. */
export function visionInputsFromFrames(
  frames: readonly FrameReference[],
): VisionImageInput[] {
  return frames.map((frame) => ({
    ref: frame.ref,
    time: frame.time,
    metadata: frame.metadata,
  }));
}
