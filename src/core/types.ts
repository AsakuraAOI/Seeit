/**
 * The durable, model-independent representation of a single source item on a
 * video's timeline. All timestamps are seconds from the beginning of the
 * video.
 */
export interface TimelineItem {
  id: string;
  start: number;
  end?: number;

  type: "subtitle" | "description" | "danmaku" | "frame" | "clip" | "ocr";

  content?: string;
  ref?: string;

  metadata?: Record<string, unknown>;
}

export interface VideoTimeline {
  videoId: string;
  duration: number;
  items: TimelineItem[];
}

export interface EvidenceRef {
  type: "subtitle" | "description" | "danmaku" | "frame" | "clip";

  start?: number;
  end?: number;
  ref?: string;
  /** The bounded perception request that produced this visual evidence. */
  perceptionRequestId?: string;
}

/** A question deliberately left open until more evidence is acquired. */
export interface UnresolvedQuestion {
  question: string;
  reason: string;
  start?: number;
  end?: number;
  sectionId?: string;
  priority?: number;
}

export interface UnderstandingSection {
  start: number;
  end: number;

  summary: string;
  visual?: string;

  importance: number;

  evidence: EvidenceRef[];
}

export type ContentType =
  | "general"
  | "talk"
  | "document"
  | "gameplay"
  | "animation"
  | "chart"
  | "story";

export interface VideoUnderstanding {
  videoId: string;

  overview: string;

  contentType: ContentType;

  sections: UnderstandingSection[];

  /** `base` uses cheap evidence only; `enriched` includes visual observations. */
  status?: "base" | "enriched";
  /** Explicitly retained gaps make later active perception purposeful. */
  unresolved?: UnresolvedQuestion[];
}

export type TimelineItemType = TimelineItem["type"];
export type EvidenceType = EvidenceRef["type"];

/**
 * A source descriptor, rather than an executable source adapter. `uri` is a
 * local file path for local media and a canonical URL or platform identifier
 * for remote media such as Bilibili.
 */
export interface MediaSource {
  kind: "local" | "bilibili";
  uri: string;
  videoId?: string;
  metadata?: Record<string, unknown>;
}

export type MediaAssetType = "video" | "audio" | "subtitle" | "danmaku";

/** A persisted or temporary media artifact addressable by an adapter. */
export interface MediaAsset {
  type: MediaAssetType;
  ref: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export interface VideoMetadata {
  videoId: string;
  duration: number;
  title?: string;
  description?: string;
  source?: MediaSource;
  metadata?: Record<string, unknown>;
}

export interface SubtitleCue {
  id?: string;
  start: number;
  end: number;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface Transcript {
  cues: SubtitleCue[];
  language?: string;
  /** `original` means a source subtitle was available; `asr` was generated. */
  source?: "original" | "asr";
  metadata?: Record<string, unknown>;
}

export interface DanmakuEntry {
  id?: string;
  start: number;
  content: string;
  end?: number;
  metadata?: Record<string, unknown>;
}

/** The normalized result of ingest, before it is converted into a timeline. */
export interface IngestedMedia {
  videoId: string;
  source: MediaSource;
  duration: number;
  video: MediaAsset;
  audio?: MediaAsset;
  title?: string;
  description?: string;
  transcript?: Transcript;
  danmaku?: DanmakuEntry[];
  metadata?: Record<string, unknown>;
}

/** A frame extracted from the original video. */
export interface FrameReference {
  time: number;
  ref: string;
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
}

/** Input that a vision adapter can resolve from a file reference or bytes. */
export interface VisionImageInput {
  time: number;
  ref?: string;
  data?: Uint8Array;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

/** Input that a vision adapter can resolve from a file reference or bytes. */
export interface VisionClipInput {
  start: number;
  end: number;
  ref?: string;
  data?: Uint8Array;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export interface ObservationRange {
  start: number;
  end: number;
  reason: string;
}

/**
 * A deliberately compact visual interpretation. It captures salient evidence
 * for an interval without requiring a model description for every frame.
 */
export interface VisualObservation {
  start: number;
  end: number;
  summary: string;
  notableVisuals?: string[];
  visualEvents?: string[];
  contentTypeHints?: ContentType[];
  suggestedRanges?: ObservationRange[];
  evidence?: EvidenceRef[];
  metadata?: Record<string, unknown>;
}
