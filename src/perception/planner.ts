import type { Transcript, UnresolvedQuestion, VideoTimeline, VideoUnderstanding } from "../core/types.js";
import { normalizePerceptionBudget } from "./policy.js";
import type {
  PerceptionBudget,
  PerceptionPlan,
  PerceptionPurpose,
  PerceptionRequest,
  VisualProfile,
} from "./types.js";

export interface PerceptionPlannerInput {
  duration: number;
  understanding: VideoUnderstanding;
  candidates?: readonly PerceptionRequest[];
  timeline?: VideoTimeline;
  transcript?: Transcript;
  visualProfile?: VisualProfile;
  budget?: Partial<PerceptionBudget>;
  enabled?: boolean;
}

/**
 * A deterministic bounded planner. The LLM may propose candidates in the base
 * understanding, but only this class decides what visual work is executed.
 */
export class PerceptionPlanner {
  public plan(input: PerceptionPlannerInput): PerceptionPlan {
    if (!Number.isFinite(input.duration) || input.duration <= 0) {
      throw new RangeError("duration must be a positive finite number.");
    }
    const budget = normalizePerceptionBudget(input.budget);
    const candidates = [
      ...(input.candidates ?? []),
      ...deterministicVisualReferences(input.timeline, input.duration),
    ];
    const textIsWeak = hasWeakTextEvidence(input.transcript, input.timeline, input.duration);
    if (textIsWeak) {
      candidates.push(...broadFallbackRequests(input.duration, budget, input.visualProfile));
    }

    const normalized = candidates
      .map((candidate, index) => normalizeRequest(candidate, input.duration, index))
      .filter((request): request is PerceptionRequest => request !== undefined);
    const merged = mergeRequests(normalized);
    const deferred: UnresolvedQuestion[] = [];
    if (input.enabled === false) {
      deferred.push(...merged.map((request) => toUnresolved(request)));
      return { requests: [], deferred, generatedCount: normalized.length };
    }

    const selected: PerceptionRequest[] = [];
    let frameCount = 0;
    let visualSeconds = 0;
    for (const request of merged) {
      const estimatedFrames = estimateFrames(request);
      const seconds = request.end - request.start;
      const secondsAllowed = budget.maxVisualSeconds === undefined || visualSeconds + seconds <= budget.maxVisualSeconds;
      if (
        selected.length >= budget.maxRequests ||
        frameCount + estimatedFrames > budget.maxFrames ||
        !secondsAllowed
      ) {
        deferred.push(toUnresolved(request, "Deferred by process perception budget."));
        continue;
      }
      selected.push(request);
      frameCount += estimatedFrames;
      visualSeconds += seconds;
    }
    return { requests: selected, deferred, generatedCount: normalized.length };
  }
}

/** Kept public for tests and for external planners that want the same bounds. */
export function normalizeRequest(
  raw: PerceptionRequest,
  duration: number,
  index = 0,
): PerceptionRequest | undefined {
  if (!raw || typeof raw !== "object" || !Number.isFinite(raw.start) || !Number.isFinite(raw.end)) {
    return undefined;
  }
  if (!isModality(raw.modality) || !isPurpose(raw.purpose) || !raw.question?.trim()) return undefined;
  const start = clamp(raw.start, duration);
  const end = clamp(raw.end, duration);
  if (end <= start) return undefined;
  const priority = Number.isFinite(raw.priority) ? clamp(raw.priority, 1) : 0.5;
  return {
    id: raw.id?.trim() || `perception-${index + 1}-${canonicalTime(start)}-${canonicalTime(end)}`,
    modality: raw.modality,
    start,
    end,
    purpose: raw.purpose,
    question: raw.question.trim(),
    ...(raw.reason?.trim() ? { reason: raw.reason.trim() } : {}),
    priority,
    ...(raw.sectionId?.trim() ? { sectionId: raw.sectionId.trim() } : {}),
  };
}

/** Requests that substantially overlap are one perception operation, not many. */
export function mergeRequests(requests: readonly PerceptionRequest[]): PerceptionRequest[] {
  const ordered = [...requests].sort((left, right) =>
    right.priority - left.priority || left.start - right.start || left.end - right.end || left.id.localeCompare(right.id));
  const merged: PerceptionRequest[] = [];
  for (const request of ordered) {
    const existing = merged.find((candidate) => overlappingEnough(candidate, request));
    if (!existing) {
      merged.push({ ...request });
      continue;
    }
    existing.start = Math.min(existing.start, request.start);
    existing.end = Math.max(existing.end, request.end);
    existing.priority = Math.max(existing.priority, request.priority);
    existing.modality = strongerModality(existing.modality, request.modality);
    existing.question = [existing.question, request.question]
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(" ");
    if (!existing.reason && request.reason) existing.reason = request.reason;
  }
  return merged.sort((left, right) => right.priority - left.priority || left.start - right.start);
}

export function estimateFrames(request: PerceptionRequest): number {
  if (request.modality === "frame") return 1;
  if (request.modality === "clip") return 4;
  // SparseFrameSampler normalizes timestamps to milliseconds; match that
  // precision so a mathematically 10s window is never budgeted as 10.000…s.
  const span = Number((request.end - request.start).toFixed(3));
  return Math.max(2, Math.min(48, Math.ceil(span / 2) + 1));
}

const VISUAL_REFERENCE = /\b(?:look|see|shown|screen|left|right|figure|image|button|chart|diagram)\b|参数|屏幕|画面|左边|右边|如图|看这里|这个按钮/ui;

function deterministicVisualReferences(
  timeline: VideoTimeline | undefined,
  duration: number,
): PerceptionRequest[] {
  const textItems = timeline?.items.filter((item) => item.type === "subtitle" && item.content?.trim()) ?? [];
  return textItems.flatMap((item, index) => {
    if (!VISUAL_REFERENCE.test(item.content ?? "")) return [];
    const center = (item.start + (item.end ?? item.start)) / 2;
    const start = Math.max(0, center - 6);
    const end = Math.min(duration, center + 8);
    if (end <= start) return [];
    return [{
      id: `text-visual-reference-${index}-${canonicalTime(center)}`,
      modality: "frames" as const,
      start,
      end,
      purpose: "resolve_visual_reference" as const,
      question: `What visual information is being referred to near ${center.toFixed(1)} seconds?`,
      reason: `Transcript contains a visual reference: ${item.content?.trim().slice(0, 160)}`,
      priority: 0.8,
      sectionId: item.id,
    }];
  });
}

function broadFallbackRequests(
  duration: number,
  budget: PerceptionBudget,
  profile: VisualProfile | undefined,
): PerceptionRequest[] {
  if (budget.maxFrames === 1) {
    return [{ ...fallbackRequest(0, Math.max(0, duration / 2 - 0.1), Math.min(duration, duration / 2 + 0.1), 0), modality: "frame" }];
  }
  const maximumSeconds = Math.min(duration, budget.maxVisualSeconds ?? duration, 2 * (budget.maxFrames - 1));
  const dynamicBoost = Math.min(0.1, (profile?.sceneChangeRate ?? 0) * 10);
  if (duration <= maximumSeconds) {
    return [fallbackRequest(0, 0, duration, dynamicBoost)];
  }

  // Frame budget is approximately one frame per two seconds plus one frame
  // per range. Keep enough short windows to cover the beginning, middle, and
  // end of a long silent video without silently spending the whole budget on
  // its opening minutes.
  const rangeCount = Math.min(
    budget.maxRequests,
    budget.maxFrames,
    Math.max(2, Math.min(8, Math.floor(budget.maxFrames / 2))),
  );
  const frameLimitedSeconds = Math.max(rangeCount, 2 * Math.max(0, budget.maxFrames - rangeCount));
  const coveredSeconds = Math.min(maximumSeconds, frameLimitedSeconds);
  const windowSeconds = coveredSeconds / rangeCount;
  return Array.from({ length: rangeCount }, (_, index) => {
    const start = index === 0
      ? 0
      : index === rangeCount - 1
        ? duration - windowSeconds
        : ((duration - windowSeconds) * index) / (rangeCount - 1);
    return fallbackRequest(index, start, start + windowSeconds, dynamicBoost);
  });
}

function fallbackRequest(
  index: number,
  start: number,
  end: number,
  dynamicBoost: number,
): PerceptionRequest {
  return {
    id: `fallback-weak-text-${index}`,
    modality: "frames",
    start,
    end,
    purpose: "understand_scene",
    question: "What are the representative scenes and main visual activity in this video?",
    reason: "No meaningful subtitle or ASR text is available.",
    // Known local gaps take precedence over broad coverage under tight budgets.
    priority: Math.min(1, 0.5 + dynamicBoost),
  };
}

function hasWeakTextEvidence(transcript: Transcript | undefined, timeline: VideoTimeline | undefined, duration: number): boolean {
  const transcriptCharacters = transcript?.cues.reduce((total, cue) => total + cue.content.trim().length, 0) ?? 0;
  const timelineCharacters = timeline?.items
    .filter((item) => item.type === "subtitle")
    .reduce((total, item) => total + (item.content?.trim().length ?? 0), 0) ?? 0;
  if (Math.max(transcriptCharacters, timelineCharacters) < 24) return true;
  const ranges = [...(transcript?.cues ?? []), ...(timeline?.items.filter((item) => item.type === "subtitle") ?? [])]
    .filter((item) => item.content?.trim() && Number.isFinite(item.start) && Number.isFinite(item.end))
    .map((item) => ({ start: Math.max(0, item.start), end: Math.min(duration, item.end ?? item.start) }))
    .filter((item) => item.end > item.start).sort((left, right) => left.start - right.start);
  let covered = 0;
  let end = 0;
  for (const range of ranges) {
    covered += Math.max(0, range.end - Math.max(end, range.start));
    end = Math.max(end, range.end);
  }
  return covered / duration < 0.5;
}

function toUnresolved(request: PerceptionRequest, reason = request.reason ?? "Visual evidence is still required."): UnresolvedQuestion {
  return {
    question: request.question,
    reason,
    start: request.start,
    end: request.end,
    priority: request.priority,
    ...(request.sectionId ? { sectionId: request.sectionId } : {}),
  };
}

function overlappingEnough(left: PerceptionRequest, right: PerceptionRequest): boolean {
  const overlap = Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
  if (overlap <= 0) return false;
  const smaller = Math.min(left.end - left.start, right.end - right.start);
  return overlap / smaller >= 0.6;
}

function strongerModality(left: PerceptionRequest["modality"], right: PerceptionRequest["modality"]): PerceptionRequest["modality"] {
  const rank: Record<PerceptionRequest["modality"], number> = { frame: 0, frames: 1, clip: 2 };
  return rank[right] > rank[left] ? right : left;
}

function isModality(value: unknown): value is PerceptionRequest["modality"] {
  return value === "frame" || value === "frames" || value === "clip";
}

function isPurpose(value: unknown): value is PerceptionPurpose {
  return ["resolve_visual_reference", "read_screen", "identify_object", "identify_action", "understand_scene", "verify_claim", "fill_visual_gap"].includes(String(value));
}

function clamp(value: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, value));
}

function canonicalTime(value: number): string {
  return value.toFixed(1).replace(".", "_");
}
