import type { EvidenceRef, VideoUnderstanding, VisualObservation } from "../core/types.js";
import type { LLMProvider } from "../providers/interfaces.js";
import { jsonForPrompt, requestJson } from "./json.js";

export interface UnderstandingEnricherInput {
  base: VideoUnderstanding;
  observations: readonly VisualObservation[];
}

/**
 * Incrementally merges perception evidence. The optional compact model pass
 * receives neither transcript nor full timeline; deterministic merge remains
 * the safe fallback for provider/model failures.
 */
export class UnderstandingEnricher {
  public constructor(private readonly dependencies: { llm?: LLMProvider } = {}) {}

  public async enrich(input: UnderstandingEnricherInput): Promise<VideoUnderstanding> {
    if (input.observations.length === 0) return { ...input.base, status: "base" };
    const deterministic = mergeDeterministically(input.base, input.observations);
    const llm = this.dependencies.llm;
    if (!llm) return deterministic;
    try {
      const raw = await requestJson(llm, {
        system: "Improve only the supplied VideoUnderstanding sections with the supplied visual observations. Return JSON only: {\"overview\":\"optional\",\"updates\":[{\"sectionIndex\":0,\"summary\":\"optional\",\"visual\":\"optional\"}]}. Never invent visual facts and never mention unobserved ranges.",
        prompt: jsonForPrompt({
          base: compactBase(input.base),
          observations: input.observations.map(compactObservation),
        }),
        maxTokens: 2_000,
        metadata: { task: "video_understanding_enrichment", videoId: input.base.videoId },
      });
      return applySafeUpdates(deterministic, raw);
    } catch {
      return deterministic;
    }
  }
}

function mergeDeterministically(base: VideoUnderstanding, observations: readonly VisualObservation[]): VideoUnderstanding {
  const sections = base.sections.map((section) => ({ ...section, evidence: [...section.evidence] }));
  for (const observation of observations) {
    const evidence = observation.evidence ?? [];
    const targets = sections.filter((section) => overlaps(section.start, section.end, observation.start, observation.end));
    const selected = targets.length ? targets : nearestSection(sections, observation.start);
    for (const section of selected) {
      const visual = [section.visual, observation.summary].filter(Boolean).join(" ").trim();
      section.visual = visual || section.visual;
      section.evidence = dedupeEvidence([...section.evidence, ...evidence]);
    }
  }
  return { ...base, sections, status: "enriched" };
}

function applySafeUpdates(base: VideoUnderstanding, raw: unknown): VideoUnderstanding {
  if (!isRecord(raw)) return base;
  const sections = base.sections.map((section) => ({ ...section }));
  if (Array.isArray(raw.updates)) {
    for (const update of raw.updates) {
      if (!isRecord(update) || !Number.isInteger(update.sectionIndex) || typeof update.sectionIndex !== "number") continue;
      const section = sections[update.sectionIndex];
      if (!section) continue;
      if (typeof update.summary === "string" && update.summary.trim()) section.summary = update.summary.trim();
      if (typeof update.visual === "string" && update.visual.trim()) section.visual = update.visual.trim();
    }
  }
  return {
    ...base,
    sections,
    ...(typeof raw.overview === "string" && raw.overview.trim() ? { overview: raw.overview.trim() } : {}),
    status: "enriched",
  };
}

function compactBase(understanding: VideoUnderstanding): Record<string, unknown> {
  return {
    overview: understanding.overview,
    contentType: understanding.contentType,
    sections: understanding.sections.map((section) => ({
      start: section.start,
      end: section.end,
      summary: section.summary,
      visual: section.visual,
      evidence: section.evidence,
    })),
  };
}

function compactObservation(observation: VisualObservation): Record<string, unknown> {
  return {
    start: observation.start,
    end: observation.end,
    summary: observation.summary,
    notableVisuals: observation.notableVisuals,
    visualEvents: observation.visualEvents,
    evidence: observation.evidence,
  };
}

function nearestSection<T extends { start: number; end: number }>(sections: T[], time: number): T[] {
  const section = sections.reduce<T | undefined>((nearest, current) => {
    const distance = Math.min(Math.abs(current.start - time), Math.abs(current.end - time));
    const nearestDistance = nearest === undefined
      ? Number.POSITIVE_INFINITY
      : Math.min(Math.abs(nearest.start - time), Math.abs(nearest.end - time));
    return distance < nearestDistance ? current : nearest;
  }, undefined);
  return section ? [section] : [];
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

function dedupeEvidence(items: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.type}:${item.ref ?? ""}:${item.start ?? ""}:${item.end ?? ""}:${item.perceptionRequestId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
