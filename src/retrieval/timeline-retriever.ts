import type {
  EvidenceRef,
  TimelineItem,
  VideoTimeline,
} from "../core/types.js";

/**
 * The small surface the reasoning layer needs from a timeline.  Keeping this
 * structural makes the retriever usable with both the in-memory Timeline class
 * and a timeline loaded directly from storage.
 */
export interface TimelineReadable {
  readonly videoId?: string;
  readonly duration?: number;
  readonly items?: TimelineItem[];
  range?(start: number, end: number): TimelineItem[];
  searchText?(query: string): TimelineItem[];
}

export interface RetrievedTimelineEvidence {
  item: TimelineItem;
  score: number;
  evidence: EvidenceRef;
}

export interface RelevantTimelineOptions {
  limit?: number;
  start?: number;
  end?: number;
}

const SOURCE_WEIGHT: Record<TimelineItem["type"], number> = {
  subtitle: 1,
  description: 1.15,
  danmaku: 0.75,
  frame: 1,
  clip: 1,
  ocr: 1,
};

/** Converts raw timeline entries into compact, citeable evidence. */
export function timelineItemToEvidence(item: TimelineItem): EvidenceRef {
  // OCR is attached to a frame in the current compact EvidenceRef vocabulary.
  const type: EvidenceRef["type"] = item.type === "ocr" ? "frame" : item.type;

  return {
    type,
    start: item.start,
    ...(item.end === undefined ? {} : { end: item.end }),
    ...(item.ref === undefined ? {} : { ref: item.ref }),
  };
}

/**
 * Simple local text retrieval. It deliberately avoids embeddings/vector DBs:
 * exact phrase and token overlap are transparent and sufficient for the first
 * stage of the project.
 */
export class TimelineRetriever {
  public constructor(private readonly timeline: TimelineReadable | VideoTimeline) {}

  public search(query: string, limit = 20): RetrievedTimelineEvidence[] {
    const safeQuery = query.trim();
    if (!safeQuery) return [];

    const candidates = this.callSearch(safeQuery) ?? this.items();
    return this.rank(candidates, safeQuery, limit);
  }

  public readAround(time: number, radius = 15): TimelineItem[] {
    const safeTime = finiteNonNegative(time, "time");
    const safeRadius = finiteNonNegative(radius, "radius");
    const start = Math.max(0, safeTime - safeRadius);
    const end = safeTime + safeRadius;

    const readable = this.timeline as TimelineReadable;
    if (typeof readable.range === "function") {
      return readable.range(start, end);
    }

    return this.items().filter((item) => overlaps(item, start, end));
  }

  public relevantTo(
    query: string,
    options: RelevantTimelineOptions = {},
  ): RetrievedTimelineEvidence[] {
    const limit = options.limit ?? 12;
    let candidates = this.items();

    if (options.start !== undefined || options.end !== undefined) {
      const start = options.start ?? 0;
      const end = options.end ?? this.durationOrInfinity();
      candidates = candidates.filter((item) => overlaps(item, start, end));
    }

    // Prefer the timeline's own implementation when it can narrow a global
    // query, while retaining the local scorer for deterministic ordering.
    const nativeMatches = this.callSearch(query);
    if (nativeMatches && nativeMatches.length > 0) {
      const allowed = new Set(candidates.map((item) => item.id));
      candidates = nativeMatches.filter((item) => allowed.has(item.id));
    }

    return this.rank(candidates, query, limit);
  }

  private rank(
    candidates: TimelineItem[],
    query: string,
    limit: number,
  ): RetrievedTimelineEvidence[] {
    const normalizedQuery = normalizeText(query);
    const tokens = tokenize(normalizedQuery);
    const phrase = normalizedQuery.replaceAll(" ", "");

    const scored = candidates
      .map((item) => {
        const content = normalizeText(item.content ?? "");
        if (!content) return undefined;

        const compactContent = content.replaceAll(" ", "");
        let score = 0;
        if (phrase.length >= 2 && compactContent.includes(phrase)) score += 12;

        for (const token of tokens) {
          if (token.length < 2 && !isCjk(token)) continue;
          if (content.includes(token) || compactContent.includes(token)) {
            score += isCjk(token) ? 1.2 : 2;
          }
        }

        // A user asking e.g. "3:20 发生了什么" contains mostly generic words.
        // Keep source entries discoverable even when there is no exact lexical
        // hit; the caller may already have restricted the time range.
        if (score === 0 && tokens.length === 0) score = 0.01;
        if (score === 0) return undefined;

        return {
          item,
          score: score * SOURCE_WEIGHT[item.type],
          evidence: timelineItemToEvidence(item),
        } satisfies RetrievedTimelineEvidence;
      })
      .filter((entry): entry is RetrievedTimelineEvidence => entry !== undefined)
      .sort((a, b) => b.score - a.score || a.item.start - b.item.start);

    return dedupeEvidence(scored).slice(0, Math.max(0, limit));
  }

  private callSearch(query: string): TimelineItem[] | undefined {
    const readable = this.timeline as TimelineReadable;
    if (typeof readable.searchText !== "function") return undefined;
    return readable.searchText(query);
  }

  private items(): TimelineItem[] {
    return "items" in this.timeline && Array.isArray(this.timeline.items)
      ? this.timeline.items
      : [];
  }

  private durationOrInfinity(): number {
    return "duration" in this.timeline && typeof this.timeline.duration === "number"
      ? this.timeline.duration
      : Number.POSITIVE_INFINITY;
  }
}

function overlaps(item: TimelineItem, start: number, end: number): boolean {
  const itemEnd = item.end ?? item.start;
  return item.start <= end && itemEnd >= start;
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(normalized: string): string[] {
  const words = normalized.split(" ").filter(Boolean);
  const cjk = [...normalized].filter(isCjk);
  const cjkBigrams = cjk.flatMap((character, index) => {
    const next = cjk[index + 1];
    return next ? [character, `${character}${next}`] : [character];
  });
  return [...new Set([...words, ...cjkBigrams])];
}

function isCjk(value: string): boolean {
  return /^[\u3400-\u9fff]$/u.test(value);
}

function dedupeEvidence(
  entries: RetrievedTimelineEvidence[],
): RetrievedTimelineEvidence[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.evidence.type}:${entry.evidence.ref ?? entry.item.id}:${entry.evidence.start ?? ""}:${entry.evidence.end ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
