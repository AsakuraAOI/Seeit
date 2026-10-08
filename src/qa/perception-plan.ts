/** A finite visual plan produced alongside the first answer, never a tool loop. */
export interface QaPerceptionRequest {
  modality: "frame" | "frames";
  start: number;
  end: number;
  count: number;
}

export interface QaPerceptionLimits { maxRequests: number; maxFrames: number; maxVisualSeconds: number }
export const QA_PERCEPTION_LIMITS = Object.freeze({ maxRequests: 3, maxFrames: 12, maxVisualSeconds: 30, maxRounds: 2 });

/** Optional malformed plans are ignored; oversized requests are reduced to fit. */
export function boundQaPerceptionPlan(value: unknown, duration: number, limits: QaPerceptionLimits = QA_PERCEPTION_LIMITS): QaPerceptionRequest[] {
  if (!Array.isArray(value) || !Number.isFinite(duration) || duration <= 0 || limits.maxRequests < 1 || limits.maxFrames < 1) return [];
  const requests: QaPerceptionRequest[] = [];
  let frames = 0;
  let seconds = 0;
  const seen = new Set<string>();
  for (const raw of value.slice(0, 8)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.modality !== "frame" && item.modality !== "frames") continue;
    if (typeof item.start !== "number" || !Number.isFinite(item.start) || item.start < 0 || item.start > duration) continue;
    const start = Math.min(item.start, Math.max(0, duration - 0.1));
    const proposedEnd = item.end ?? item.start;
    if (typeof proposedEnd !== "number" || !Number.isFinite(proposedEnd) || proposedEnd < item.start) continue;
    const end = item.modality === "frame" ? start : Math.min(duration, proposedEnd);
    if (item.modality === "frames" && end <= start) continue;
    const remainingSeconds = limits.maxVisualSeconds - seconds;
    if (item.modality === "frames" && remainingSeconds <= 0) continue;
    const boundedEnd = Math.min(end, start + remainingSeconds);
    const count = item.modality === "frame" ? 1
      : Math.min(8, limits.maxFrames - frames,
          typeof item.count === "number" && Number.isFinite(item.count) ? Math.max(1, Math.floor(item.count)) : 4);
    if (count < 1 || frames + count > limits.maxFrames) continue;
    const key = `${item.modality}:${start.toFixed(1)}:${boundedEnd.toFixed(1)}:${count}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({ modality: item.modality, start, end: boundedEnd, count });
    frames += count;
    seconds += boundedEnd - start;
    if (requests.length >= Math.min(2, limits.maxRequests)) break;
  }
  return requests;
}
