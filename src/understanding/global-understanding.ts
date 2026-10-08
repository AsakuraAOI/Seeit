import type {
  ContentType,
  EvidenceRef,
  UnderstandingSection,
  VideoUnderstanding,
} from "../core/types.js";
import type { PerceptionPurpose, PerceptionRequest } from "../perception/types.js";
import {
  expectFiniteNumber,
  expectObject,
  expectString,
  isRecord,
  jsonForPrompt,
  ModelOutputError,
  optionalString,
  requestJson,
} from "./json.js";
import type {
  GlobalUnderstandingDependencies,
  GlobalUnderstandingInput,
  GlobalUnderstandingResult,
  TimedText,
  VisualObservationLike,
  VisualRefinementRequest,
} from "./contracts.js";

export const MAX_VISUAL_REFINEMENTS = 2;

const CONTENT_TYPES: readonly ContentType[] = [
  "general",
  "talk",
  "document",
  "gameplay",
  "animation",
  "chart",
  "story",
];

type SourceType = EvidenceRef["type"];

interface SourceEvidence {
  id: string;
  type: SourceType;
  start: number;
  end: number;
  content?: string;
  ref?: string;
  provenance: "subtitle" | "description" | "danmaku" | "frame" | "clip" | "metadata";
}

interface UnderstandingDraft {
  understanding: VideoUnderstanding;
  refinements: VisualRefinementRequest[];
  perceptionRequests: PerceptionRequest[];
}

/**
 * Builds a persistent, evidence-linked VideoUnderstanding from all inexpensive
 * modalities first.  It deliberately makes at most two targeted visual calls
 * after the global pass; it never turns into per-frame VLM processing.
 */
export class GlobalUnderstandingService {
  public constructor(private readonly dependencies: GlobalUnderstandingDependencies) {}

  public async understand(
    input: GlobalUnderstandingInput,
  ): Promise<GlobalUnderstandingResult> {
    validateInput(input);
    const sources = collectSources(input);
    const initial = await this.generate(input, sources, false);

    const cap = Math.min(
      MAX_VISUAL_REFINEMENTS,
      Math.max(0, Math.floor(this.dependencies.maxVisualRefinements ?? MAX_VISUAL_REFINEMENTS)),
    );
    const requests = initial.refinements.slice(0, cap);

    if (!this.dependencies.refineVisual || requests.length === 0) {
      return {
        understanding: initial.understanding,
        refinementsUsed: 0,
        perceptionRequests: initial.perceptionRequests,
      };
    }

    const refinementSources: SourceEvidence[] = [];
    for (const request of requests) {
      const observation = await this.dependencies.refineVisual({
        ...request,
        videoId: input.videoId,
        ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
      });
      if (!observation) continue;
      const source = sourceFromVisualObservation(
        observation,
        input.duration,
        `refinement:${refinementSources.length}`,
      );
      if (source) refinementSources.push(source);
    }

    if (refinementSources.length === 0) {
      return {
        understanding: initial.understanding,
        refinementsUsed: 0,
        perceptionRequests: initial.perceptionRequests,
      };
    }

    // A second pass is deliberately bounded to one regeneration. If it is not
    // valid JSON, retaining the already validated initial understanding is safer
    // than persisting an ungrounded replacement.
    try {
      const finalDraft = await this.generate(
        input,
        dedupeSources([...sources, ...refinementSources]),
        true,
      );
      return {
        understanding: finalDraft.understanding,
        refinementsUsed: refinementSources.length,
        perceptionRequests: finalDraft.perceptionRequests,
      };
    } catch (error) {
      if (error instanceof ModelOutputError) {
        return {
          understanding: initial.understanding,
          refinementsUsed: refinementSources.length,
          perceptionRequests: initial.perceptionRequests,
        };
      }
      throw error;
    }
  }

  private async generate(
    input: GlobalUnderstandingInput,
    sources: SourceEvidence[],
    isRefined: boolean,
  ): Promise<UnderstandingDraft> {
    const payload = globalPromptPayload(input, sources, isRefined);
    const raw = await requestJson(this.dependencies.llm, {
      system: GLOBAL_SYSTEM_PROMPT,
      prompt: jsonForPrompt(payload),
      maxTokens: 6_000,
      metadata: {
        task: "global_video_understanding",
        videoId: input.videoId,
        refined: isRefined,
      },
    });
    return parseUnderstandingDraft(raw, input, sources, isRefined);
  }
}

/** Convenience entry point for callers that do not need to retain the service. */
export async function buildVideoUnderstanding(
  input: GlobalUnderstandingInput,
  dependencies: GlobalUnderstandingDependencies,
): Promise<GlobalUnderstandingResult> {
  return new GlobalUnderstandingService(dependencies).understand(input);
}

const GLOBAL_SYSTEM_PROMPT = `You create a grounded VideoUnderstanding for one video.
Use only supplied modalities: title, description, subtitle/transcript, representative danmaku, timeline text, and any supplied visual observations. Never treat description or transcript as a visual observation. Do not guess unseen images or claim that you saw a screen when no visual observation was supplied.

Return JSON only with this shape:
{
  "overview": "...",
  "contentType": "general|talk|document|gameplay|animation|chart|story",
  "sections": [{
    "start": 0,
    "end": 1,
    "summary": "...",
    "visual": "optional, only if grounded in visual evidence",
    "importance": 0.0,
    "evidence": [{"type":"subtitle|description|danmaku|frame|clip","start":0,"end":1,"ref":"optional"}]
  }],
  "refinementRequests": [{"start":0,"end":1,"reason":"specific missing visual fact"}],
  "perceptionRequests": [{"start":0,"end":1,"modality":"frame|frames|clip","purpose":"resolve_visual_reference|read_screen|identify_object|identify_action|understand_scene|verify_claim|fill_visual_gap","question":"what must be observed","reason":"optional","priority":0.0}],
  "unresolved": [{"question":"optional unsolved evidence gap","reason":"why current evidence is insufficient","start":0,"end":1,"sectionId":"optional","priority":0.0}]
}

Use seconds from video start. Sections and evidence must be grounded in the provided source records. importance and priority are numbers from 0 to 1. When visual evidence is absent and a visual fact is materially required, emit a perceptionRequest instead of inventing an answer. Requests are candidates only; do not emit more than eight. Keep legacy refinementRequests only for callers that explicitly wire a visual refiner; do not request refinement in a refined pass.`;

function validateInput(input: GlobalUnderstandingInput): void {
  if (!input.videoId.trim()) throw new TypeError("videoId is required.");
  if (!Number.isFinite(input.duration) || input.duration <= 0) {
    throw new RangeError("duration must be a positive number of seconds.");
  }
}

function collectSources(input: GlobalUnderstandingInput): SourceEvidence[] {
  const sources: SourceEvidence[] = [];
  const add = (source: SourceEvidence | undefined) => {
    if (source) sources.push(source);
  };

  if (input.title?.trim()) {
    add({
      id: "metadata:title",
      type: "description",
      start: 0,
      end: input.duration,
      content: input.title.trim(),
      ref: "metadata:title",
      provenance: "metadata",
    });
  }
  if (input.description?.trim()) {
    add({
      id: "description:0",
      type: "description",
      start: 0,
      end: input.duration,
      content: input.description.trim(),
      ref: "metadata:description",
      provenance: "description",
    });
  }

  const transcript = input.transcript;
  if (typeof transcript === "string") {
    if (transcript.trim()) {
      add({
        id: "transcript:0",
        type: "subtitle",
        start: 0,
        end: input.duration,
        content: transcript.trim(),
        ref: "transcript",
        provenance: "subtitle",
      });
    }
  } else if (isTimedTextList(transcript)) {
    transcript.forEach((item, index) => {
      add(sourceFromTimedText(item, "subtitle", input.duration, `subtitle:${index}`));
    });
  } else if (hasTranscriptCues(transcript)) {
    transcript.cues.forEach((item, index) => {
      add(sourceFromTimedText(item, "subtitle", input.duration, `subtitle:${index}`));
    });
  }

  const danmaku = input.representativeDanmaku ?? input.danmaku;
  danmaku?.forEach((item, index) => {
    add(sourceFromTimedText(item, "danmaku", input.duration, `danmaku:${index}`));
  });

  input.visualObservations?.forEach((observation, index) => {
    add(sourceFromVisualObservation(observation, input.duration, `frame:${index}`));
  });

  input.timeline?.items.forEach((item) => {
    if (!item.content?.trim()) return;
    const type: SourceType = item.type === "ocr" ? "frame" : item.type;
    const start = clampTime(item.start, input.duration);
    const end = clampEnd(item.end, start, input.duration);
    add({
      id: `timeline:${item.id}`,
      type,
      start,
      end,
      content: item.content.trim(),
      ...(item.ref === undefined ? {} : { ref: item.ref }),
      provenance: item.type === "ocr" ? "frame" : item.type,
    });
  });

  return dedupeSources(sources);
}

function sourceFromTimedText(
  item: TimedText,
  type: "subtitle" | "danmaku",
  duration: number,
  id: string,
): SourceEvidence | undefined {
  if (!item.content?.trim() || !Number.isFinite(item.start)) return undefined;
  const start = clampTime(item.start, duration);
  return {
    id,
    type,
    start,
    end: clampEnd(item.end, start, duration),
    content: item.content.trim(),
    ...(item.ref === undefined ? {} : { ref: item.ref }),
    provenance: type,
  };
}

function sourceFromVisualObservation(
  observation: VisualObservationLike,
  duration: number,
  id: string,
): SourceEvidence | undefined {
  const content = [
    observation.summary,
    observation.visual,
    observation.description,
    observation.content,
    ...(observation.visualEvents ?? []),
    ...(observation.notableVisuals ?? []),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
  if (!content) return undefined;
  const rawStart = observation.start ?? observation.time ?? 0;
  if (!Number.isFinite(rawStart)) return undefined;
  const start = clampTime(rawStart, duration);
  return {
    id,
    type: "frame",
    start,
    end: clampEnd(observation.end, start, duration),
    content,
    ...(observation.ref === undefined ? {} : { ref: observation.ref }),
    provenance: "frame",
  };
}

function globalPromptPayload(
  input: GlobalUnderstandingInput,
  sources: SourceEvidence[],
  isRefined: boolean,
): Record<string, unknown> {
  return {
    video: {
      videoId: input.videoId,
      duration: input.duration,
      title: input.title ?? "",
      description: input.description ?? "",
    },
    ...(input.instruction?.trim()
      ? { userInstruction: input.instruction.trim() }
      : {}),
    refinedPass: isRefined,
    ...(input.visualProfile ? { visualProfile: input.visualProfile } : {}),
    evidence: sources.map((source) => ({
      id: source.id,
      type: source.type,
      provenance: source.provenance,
      start: source.start,
      end: source.end,
      ...(source.ref === undefined ? {} : { ref: source.ref }),
      ...(source.content === undefined ? {} : { content: truncate(source.content, 1_500) }),
    })),
  };
}

function parseUnderstandingDraft(
  raw: unknown,
  input: GlobalUnderstandingInput,
  sources: SourceEvidence[],
  isRefined: boolean,
): UnderstandingDraft {
  const value = expectObject(raw, "Global understanding response");
  const overview = expectString(value.overview, "overview");
  const contentType = parseContentType(value.contentType);
  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    throw new ModelOutputError("sections must be a non-empty array.");
  }
  if (value.sections.length > 48) {
    throw new ModelOutputError("sections exceeds the maximum supported length.");
  }

  const sections = value.sections
    .map((section, index) => parseSection(section, index, input.duration, sources))
    .filter((section): section is UnderstandingSection => section !== undefined)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (sections.length === 0) {
    throw new ModelOutputError("no valid sections remain after range clamping.");
  }
  const refinements = isRefined
    ? []
    : parseRefinements(value.refinementRequests, input.duration);
  const perceptionRequests = isRefined
    ? []
    : parsePerceptionRequests(value.perceptionRequests, input.duration);
  const unresolved = parseUnresolved(value.unresolved, input.duration);

  return {
    understanding: {
      videoId: input.videoId,
      overview,
      contentType,
      sections,
      ...(unresolved.length
        ? { unresolved }
        : {}),
    },
    refinements,
    perceptionRequests,
  };
}

function parsePerceptionRequests(value: unknown, duration: number): PerceptionRequest[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ModelOutputError("perceptionRequests must be an array when present.");
  const requests: PerceptionRequest[] = [];
  for (const [index, raw] of value.entries()) {
    if (requests.length >= 8) break;
    const item = expectObject(raw, `perceptionRequests[${index}]`);
    const start = expectFiniteNumber(item.start, `perceptionRequests[${index}].start`);
    const end = expectFiniteNumber(item.end, `perceptionRequests[${index}].end`);
    if (start < 0 || end <= start) continue;
    const clampedStart = clampTime(start, duration);
    const clampedEnd = clampEnd(end, clampedStart, duration);
    if (clampedEnd <= clampedStart) continue;
    const modality = item.modality === "frame" || item.modality === "frames" || item.modality === "clip"
      ? item.modality
      : "frames";
    const purpose = parsePerceptionPurpose(item.purpose);
    const priority = item.priority === undefined ? 0.7 : expectFiniteNumber(item.priority, `perceptionRequests[${index}].priority`);
    if (priority < 0 || priority > 1) continue;
    requests.push({
      id: `base-perception-${index + 1}-${clampedStart.toFixed(1)}`,
      modality,
      start: clampedStart,
      end: clampedEnd,
      purpose,
      question: expectString(item.question, `perceptionRequests[${index}].question`),
      ...(optionalString(item.reason, `perceptionRequests[${index}].reason`) ? { reason: optionalString(item.reason, `perceptionRequests[${index}].reason`) } : {}),
      priority,
      ...(optionalString(item.sectionId, `perceptionRequests[${index}].sectionId`) ? { sectionId: optionalString(item.sectionId, `perceptionRequests[${index}].sectionId`) } : {}),
    });
  }
  return requests;
}

function parsePerceptionPurpose(value: unknown): PerceptionPurpose {
  const purposes: PerceptionPurpose[] = ["resolve_visual_reference", "read_screen", "identify_object", "identify_action", "understand_scene", "verify_claim", "fill_visual_gap"];
  return typeof value === "string" && purposes.includes(value as PerceptionPurpose)
    ? value as PerceptionPurpose
    : "fill_visual_gap";
}

function parseUnresolved(value: unknown, duration: number): NonNullable<VideoUnderstanding["unresolved"]> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((raw, index) => {
    if (!isRecord(raw) || typeof raw.question !== "string" || !raw.question.trim() || typeof raw.reason !== "string" || !raw.reason.trim()) return [];
    const start = typeof raw.start === "number" && Number.isFinite(raw.start) ? clampTime(raw.start, duration) : undefined;
    const end = typeof raw.end === "number" && Number.isFinite(raw.end) ? clampTime(raw.end, duration) : undefined;
    if (start !== undefined && end !== undefined && end <= start) return [];
    const priority = typeof raw.priority === "number" && Number.isFinite(raw.priority) ? Math.min(1, Math.max(0, raw.priority)) : undefined;
    return [{ question: raw.question.trim(), reason: raw.reason.trim(), ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }), ...(priority === undefined ? {} : { priority }), ...(typeof raw.sectionId === "string" && raw.sectionId.trim() ? { sectionId: raw.sectionId.trim() } : {}) }];
  });
}

function parseContentType(value: unknown): ContentType {
  const type = expectString(value, "contentType") as ContentType;
  if (!CONTENT_TYPES.includes(type)) {
    throw new ModelOutputError(`contentType must be one of: ${CONTENT_TYPES.join(", ")}.`);
  }
  return type;
}

function parseSection(
  raw: unknown,
  index: number,
  duration: number,
  sources: SourceEvidence[],
): UnderstandingSection | undefined {
  const value = expectObject(raw, `sections[${index}]`);
  const start = expectFiniteNumber(value.start, `sections[${index}].start`);
  const end = expectFiniteNumber(value.end, `sections[${index}].end`);
  // Section ranges are model estimates; clamp into the video instead of
  // failing the whole draft. A degenerate range drops the section.
  if (start < 0 || end < start) return undefined;
  const clampedStart = clampTime(start, duration);
  const clampedEnd = clampEnd(end, clampedStart, duration);
  if (clampedEnd <= clampedStart) return undefined;
  const importance = expectFiniteNumber(value.importance, `sections[${index}].importance`);
  if (importance < 0 || importance > 1) {
    throw new ModelOutputError(`sections[${index}].importance must be between 0 and 1.`);
  }

  const suppliedEvidence = parseEvidenceArray(value.evidence, `sections[${index}].evidence`);
  const evidence = suppliedEvidence.filter((item) => evidenceExists(item, sources));
  const groundedEvidence = evidence.length > 0 ? evidence : evidenceForRange(clampedStart, clampedEnd, sources);
  if (groundedEvidence.length === 0) {
    throw new ModelOutputError(`sections[${index}] has no grounded evidence.`);
  }
  const visual = optionalString(value.visual, `sections[${index}].visual`);

  return {
    start: clampedStart,
    end: clampedEnd,
    summary: expectString(value.summary, `sections[${index}].summary`),
    // A model may phrase description/subtitle facts as if it saw them.  Keep
    // the dedicated visual field only when retained source evidence actually
    // covers this section with a frame or clip observation.
    ...(visual && hasVisualSourceForRange(clampedStart, clampedEnd, sources) ? { visual } : {}),
    importance,
    evidence: dedupeEvidence(groundedEvidence),
  };
}

function parseEvidenceArray(value: unknown, context: string): EvidenceRef[] {
  if (!Array.isArray(value)) {
    throw new ModelOutputError(`${context} must be an array.`);
  }
  return value.map((raw, index) => parseEvidence(raw, `${context}[${index}]`));
}

function parseEvidence(raw: unknown, context: string): EvidenceRef {
  const value = expectObject(raw, context);
  const type = expectString(value.type, `${context}.type`);
  if (!isEvidenceType(type)) {
    throw new ModelOutputError(`${context}.type is not supported.`);
  }
  const start = value.start === undefined ? undefined : expectFiniteNumber(value.start, `${context}.start`);
  const end = value.end === undefined ? undefined : expectFiniteNumber(value.end, `${context}.end`);
  if (start !== undefined && start < 0) {
    throw new ModelOutputError(`${context}.start cannot be negative.`);
  }
  if (end !== undefined && end < 0) {
    throw new ModelOutputError(`${context}.end cannot be negative.`);
  }
  if (start !== undefined && end !== undefined && end < start) {
    throw new ModelOutputError(`${context}.end cannot precede start.`);
  }
  const ref = optionalString(value.ref, `${context}.ref`);
  return {
    type,
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
    ...(ref === undefined ? {} : { ref }),
  };
}

function parseRefinements(value: unknown, duration: number): VisualRefinementRequest[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ModelOutputError("refinementRequests must be an array when present.");
  }

  const requests: VisualRefinementRequest[] = [];
  for (const [index, raw] of value.entries()) {
    if (requests.length >= MAX_VISUAL_REFINEMENTS) break;
    const item = expectObject(raw, `refinementRequests[${index}]`);
    const start = expectFiniteNumber(item.start, `refinementRequests[${index}].start`);
    const end = expectFiniteNumber(item.end, `refinementRequests[${index}].end`);
    // Refinements are optional hints; out-of-range requests are skipped.
    if (start < 0 || end < start) continue;
    const clampedStart = clampTime(start, duration);
    const clampedEnd = clampEnd(end, clampedStart, duration);
    if (clampedEnd <= clampedStart) continue;
    requests.push({
      // Filled from input only at the call boundary, never trusted from model.
      videoId: "",
      start: clampedStart,
      end: clampedEnd,
      reason: expectString(item.reason, `refinementRequests[${index}].reason`),
    });
  }
  return uniqueRefinements(requests);
}

function evidenceExists(candidate: EvidenceRef, sources: SourceEvidence[]): boolean {
  return sources.some((source) => {
    if (source.type !== candidate.type) return false;
    if (candidate.ref && source.ref && candidate.ref === source.ref) return true;
    if (candidate.ref && candidate.ref !== source.ref) return false;
    const candidateStart = candidate.start ?? source.start;
    const candidateEnd = candidate.end ?? candidateStart;
    return source.start <= candidateEnd && source.end >= candidateStart;
  });
}

function evidenceForRange(start: number, end: number, sources: SourceEvidence[]): EvidenceRef[] {
  return sources
    .filter((source) => source.start <= end && source.end >= start)
    .slice(0, 8)
    .map(sourceToEvidence);
}

function hasVisualSourceForRange(
  start: number,
  end: number,
  sources: SourceEvidence[],
): boolean {
  return sources.some(
    (source) =>
      (source.type === "frame" || source.type === "clip") &&
      source.start <= end &&
      source.end >= start,
  );
}

function sourceToEvidence(source: SourceEvidence): EvidenceRef {
  return {
    type: source.type,
    start: source.start,
    end: source.end,
    ...(source.ref === undefined ? {} : { ref: source.ref }),
  };
}

function dedupeEvidence(evidence: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.type}:${item.ref ?? ""}:${item.start ?? ""}:${item.end ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeSources(sources: SourceEvidence[]): SourceEvidence[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.type}:${source.ref ?? ""}:${source.start}:${source.end}:${source.content ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueRefinements(requests: VisualRefinementRequest[]): VisualRefinementRequest[] {
  const seen = new Set<string>();
  return requests.filter((request) => {
    const key = `${request.start}:${request.end}:${request.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isEvidenceType(value: string): value is EvidenceRef["type"] {
  return ["subtitle", "description", "danmaku", "frame", "clip"].includes(value);
}

function clampTime(value: number, duration: number): number {
  return Math.min(duration, Math.max(0, value));
}

function hasTranscriptCues(value: unknown): value is { cues: readonly TimedText[] } {
  return typeof value === "object" && value !== null && "cues" in value && Array.isArray(value.cues);
}

function isTimedTextList(value: unknown): value is readonly TimedText[] {
  return Array.isArray(value);
}

function clampEnd(value: number | undefined, start: number, duration: number): number {
  if (value === undefined || !Number.isFinite(value)) return start;
  return Math.min(duration, Math.max(start, value));
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
