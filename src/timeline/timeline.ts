import type { TimelineItem, TimelineItemType, VideoTimeline } from "../core/types.js";

export interface TimelineSearchOptions {
  /** Restrict the search to a subset of timeline item kinds. */
  types?: TimelineItemType[];
  /** Maximum number of matching items to return. */
  limit?: number;
}

/**
 * In-memory access to a video's unified timeline.
 *
 * This intentionally uses small, deterministic full-text scoring instead of a
 * vector index. It is enough to select useful source evidence for QA while
 * keeping the first implementation portable and easy to persist.
 */
export class Timeline {
  readonly videoId: string;
  readonly duration: number;

  private readonly entries: TimelineItem[] = [];
  private readonly entryIds = new Set<string>();

  constructor(timeline: VideoTimeline);
  constructor(videoId: string, duration: number, items?: TimelineItem[]);
  constructor(
    timelineOrVideoId: VideoTimeline | string,
    suppliedDuration?: number,
    suppliedItems: TimelineItem[] = [],
  ) {
    if (typeof timelineOrVideoId === "string") {
      this.videoId = requireNonEmptyString(timelineOrVideoId, "videoId");
      this.duration = requireSeconds(suppliedDuration, "duration");

      for (const item of suppliedItems) {
        this.add(item);
      }
      return;
    }

    this.videoId = requireNonEmptyString(timelineOrVideoId.videoId, "videoId");
    this.duration = requireSeconds(timelineOrVideoId.duration, "duration");

    for (const item of timelineOrVideoId.items) {
      this.add(item);
    }
  }

  /** A defensive copy so callers cannot mutate the durable timeline by accident. */
  get items(): TimelineItem[] {
    return this.entries.map(copyItem);
  }

  /**
   * Add one source item. Duplicate ids are rejected because ids are the stable
   * handles used by persisted evidence and tools.
   */
  add(item: TimelineItem): this {
    validateItem(item);

    if (this.entryIds.has(item.id)) {
      throw new Error(`Timeline item id already exists: ${item.id}`);
    }

    this.entryIds.add(item.id);
    this.entries.push(copyItem(item));
    this.entries.sort(compareTimelineItems);
    return this;
  }

  /**
   * Return source items whose intervals overlap the inclusive time range.
   * Items without an end are treated as point-in-time observations.
   */
  range(start: number, end: number): TimelineItem[] {
    requireSeconds(start, "start");
    requireSeconds(end, "end");

    if (end < start) {
      throw new RangeError("range end must be greater than or equal to start");
    }

    return this.entries
      .filter((item) => {
        const itemEnd = item.end ?? item.start;
        return item.start <= end && itemEnd >= start;
      })
      .map(copyItem);
  }

  /**
   * Search text-bearing timeline items with simple deterministic full-text
   * scoring. Full phrase matches rank ahead of token-only matches.
   */
  searchText(query: string, options: TimelineSearchOptions = {}): TimelineItem[] {
    if (typeof query !== "string") {
      throw new TypeError("query must be a string");
    }

    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) {
      return [];
    }

    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
      throw new RangeError("search limit must be a non-negative integer");
    }

    const allowedTypes = options.types ? new Set(options.types) : undefined;
    const terms = normalizedQuery.split(" ").filter(Boolean);
    const compactQuery = compactText(normalizedQuery);

    const matches = this.entries.flatMap((item) => {
      if (!item.content || (allowedTypes && !allowedTypes.has(item.type))) {
        return [];
      }

      const score = scoreText(item.content, normalizedQuery, compactQuery, terms);
      return score === 0 ? [] : [{ item, score }];
    });

    matches.sort((left, right) => {
      return (
        right.score - left.score ||
        left.item.start - right.item.start ||
        (left.item.end ?? left.item.start) - (right.item.end ?? right.item.start) ||
        left.item.id.localeCompare(right.item.id)
      );
    });

    const limit = options.limit ?? matches.length;
    return matches.slice(0, limit).map(({ item }) => copyItem(item));
  }

  /** Return a serializable snapshot suitable for `timeline.json`. */
  toJSON(): VideoTimeline {
    return {
      videoId: this.videoId,
      duration: this.duration,
      items: this.items,
    };
  }
}

function compareTimelineItems(left: TimelineItem, right: TimelineItem): number {
  return (
    left.start - right.start ||
    (left.end ?? left.start) - (right.end ?? right.start) ||
    left.id.localeCompare(right.id)
  );
}

function copyItem(item: TimelineItem): TimelineItem {
  return {
    ...item,
    metadata: item.metadata ? { ...item.metadata } : undefined,
  };
}

function validateItem(item: TimelineItem): void {
  if (!item || typeof item !== "object") {
    throw new TypeError("timeline item must be an object");
  }

  requireNonEmptyString(item.id, "timeline item id");
  requireSeconds(item.start, "timeline item start");

  if (item.end !== undefined) {
    requireSeconds(item.end, "timeline item end");
    if (item.end < item.start) {
      throw new RangeError("timeline item end must be greater than or equal to start");
    }
  }

  if (!isTimelineItemType(item.type)) {
    throw new TypeError(`Unsupported timeline item type: ${String(item.type)}`);
  }
}

function isTimelineItemType(value: unknown): value is TimelineItemType {
  return (
    value === "subtitle" ||
    value === "description" ||
    value === "danmaku" ||
    value === "frame" ||
    value === "clip" ||
    value === "ocr"
  );
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireSeconds(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number of seconds greater than or equal to zero`);
  }
  return value;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactText(value: string): string {
  return value.replace(/\s/g, "");
}

function scoreText(
  content: string,
  normalizedQuery: string,
  compactQuery: string,
  terms: string[],
): number {
  const normalizedContent = normalizeText(content);
  if (!normalizedContent) {
    return 0;
  }

  const compactContent = compactText(normalizedContent);
  const phraseIndex = normalizedContent.indexOf(normalizedQuery);
  const compactPhraseIndex = compactQuery ? compactContent.indexOf(compactQuery) : -1;
  const matchedTerms = terms.filter((term) => normalizedContent.includes(term));

  if (phraseIndex < 0 && compactPhraseIndex < 0 && matchedTerms.length !== terms.length) {
    return 0;
  }

  let score = matchedTerms.length * 10;

  if (phraseIndex >= 0 || compactPhraseIndex >= 0) {
    const firstMatch = phraseIndex >= 0 ? phraseIndex : compactPhraseIndex;
    // Prefer a direct phrase match, with a tiny stable preference for an early
    // mention when two items otherwise contain the same phrase.
    score += 100 + 1 / (firstMatch + 1);
  }

  for (const term of matchedTerms) {
    score += countOccurrences(normalizedContent, term);
  }

  return score;
}

function countOccurrences(value: string, term: string): number {
  if (!term) {
    return 0;
  }

  let count = 0;
  let start = 0;
  while (start < value.length) {
    const index = value.indexOf(term, start);
    if (index < 0) {
      break;
    }
    count += 1;
    start = index + term.length;
  }
  return count;
}
