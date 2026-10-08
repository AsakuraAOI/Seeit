import type {
  EvidenceRef,
  TimelineItem,
  VideoTimeline,
  VideoUnderstanding,
} from "../core/types.js";
import type { LLMProvider } from "../providers/interfaces.js";
import {
  TimelineRetriever,
  timelineItemToEvidence,
  type TimelineReadable,
} from "../retrieval/timeline-retriever.js";
import {
  expectFiniteNumber,
  expectObject,
  expectString,
  jsonForPrompt,
  ModelOutputError,
  optionalString,
  requestJson,
} from "../understanding/json.js";
import type { ToolObservation, VideoAgentTools } from "../tools/video-agent-tools.js";
import { boundQaPerceptionPlan, QA_PERCEPTION_LIMITS, type QaPerceptionLimits } from "./perception-plan.js";

interface KnownEvidence { evidence: EvidenceRef; content?: string }

export interface VideoQaRepository {
  readUnderstanding(videoId: string): Promise<VideoUnderstanding | undefined>;
  readTimeline(videoId: string): Promise<VideoTimeline | TimelineReadable | undefined>;
}

export interface VideoQaDependencies {
  repository: VideoQaRepository;
  llm: LLMProvider;
  /**
   * Constructed by the application with the video-local tools. It is only
   * requested after the answer/plan pass says more perception is
   * necessary, never during ordinary QA.
   */
  getPerceptionTools?: (videoId: string) => Pick<VideoAgentTools, "getFrame" | "getFrames"> | undefined
    | Promise<Pick<VideoAgentTools, "getFrame" | "getFrames"> | undefined>;
}

export interface QAResult {
  answer: string;
  reliable: boolean;
  /** @deprecated The default QA path no longer runs ReAct. Always false. */
  usedReact: boolean;
  usedPerception?: boolean;
  evidence: EvidenceRef[];
  observations: ToolObservation[];
  missingInformation?: string;
}

interface DirectJudgement {
  answer: string;
  sufficient: boolean;
  missingInformation?: string;
  citations: EvidenceRef[];
  perceptionRequests?: unknown;
}

/**
 * QA loads persistent understanding and timeline evidence; it intentionally
 * has no ingest/global-understanding dependency, so repeated questions never
 * re-run full preprocessing.
 */
export class VideoQAService {
  public constructor(private readonly dependencies: VideoQaDependencies) {}

  public async ask(videoId: string, question: string): Promise<QAResult> {
    const safeVideoId = requireNonEmpty(videoId, "videoId");
    const safeQuestion = requireNonEmpty(question, "question");
    const [understanding, timeline] = await Promise.all([
      this.dependencies.repository.readUnderstanding(safeVideoId),
      this.dependencies.repository.readTimeline(safeVideoId),
    ]);
    if (!understanding) {
      return unavailable("该视频尚未生成持久化理解，无法可靠回答。", false);
    }
    if (understanding.videoId !== safeVideoId) {
      throw new Error("Loaded understanding belongs to a different videoId.");
    }

    const relevantTimeline = timeline
      ? relevantTimelineEvidence(timeline, safeQuestion, understanding)
      : [];
    const knownEvidence = collectKnownEvidence(understanding, relevantTimeline);
    const direct = await this.judgeDirectAnswer(
      understanding,
      safeQuestion,
      relevantTimeline,
      knownEvidence,
    );

    if (direct?.sufficient) {
      const citations = resolveCitations(direct.citations, knownEvidence);
      if (citations.length > 0) {
        return {
          answer: direct.answer,
          reliable: true,
          usedReact: false,
          usedPerception: false,
          evidence: citations,
          observations: [],
          ...(direct.missingInformation ? { missingInformation: direct.missingInformation } : {}),
        };
      }
    }

    const missingInformation = direct?.missingInformation ?? "现有理解和时间线证据不足。";
    const duration = timeline ? durationOf(timeline, understanding)
      : Math.max(...understanding.sections.map((section) => section.end), 0);
    let requests = boundQaPerceptionPlan(direct?.perceptionRequests, duration);
    // A temporal question can be localized without another model turn.
    const range = questionTimeRange(safeQuestion, duration);
    if (!requests.length && range.start !== undefined && range.end !== undefined) {
      const center = (range.start + range.end) / 2;
      requests = boundQaPerceptionPlan([{ modality: "frames", start: Math.max(0, center - 4), end: Math.min(duration, center + 4), count: 4 }], duration);
    }
    if (!requests.length) return unavailable(`${missingInformation} 未提供可定位的视觉范围。`, false);
    const tools = this.dependencies.getPerceptionTools
      ? await this.dependencies.getPerceptionTools(safeVideoId)
      : undefined;
    if (!tools) {
      return unavailable(
        `${missingInformation} 当前未配置局部视频回看工具。`,
        false,
        knownEvidence.map((item) => item.evidence),
      );
    }

    const observations: ToolObservation[] = [];
    const remaining: QaPerceptionLimits = { ...QA_PERCEPTION_LIMITS };
    const attempted = new Set<string>();
    let gap = missingInformation;
    for (let round = 0; round < QA_PERCEPTION_LIMITS.maxRounds; round += 1) {
      const fresh = requests.filter((request) => !attempted.has(`${request.modality}:${request.start.toFixed(1)}:${request.end.toFixed(1)}`));
      if (!fresh.length || remaining.maxRequests <= 0 || remaining.maxFrames <= 0) break;
      for (const request of fresh) {
        attempted.add(`${request.modality}:${request.start.toFixed(1)}:${request.end.toFixed(1)}`);
        remaining.maxRequests -= 1;
        remaining.maxFrames -= request.count;
        remaining.maxVisualSeconds -= request.end - request.start;
        try {
          observations.push(await (request.modality === "frame"
            ? tools.getFrame(request.start)
            : tools.getFrames(request.start, request.end, request.count)));
        } catch (error) {
          observations.push({ tool: request.modality === "frame" ? "getFrame" : "getFrames", evidence: [],
            summary: `Visual observation failed: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      if (!observations.some((observation) => observation.evidence.length > 0)) {
        return { ...unavailable(`${gap} 局部回看未获得有效证据。`, true), observations };
      }
      const finalEvidence = dedupeKnownEvidence([
        ...observations.flatMap((observation) => observation.evidence.map((evidence) => ({ evidence, content: observation.summary }))),
        ...knownEvidence,
      ]);
      const mayRefine = round + 1 < QA_PERCEPTION_LIMITS.maxRounds;
      const final = await this.judgeDirectAnswer(understanding, safeQuestion, relevantTimeline, finalEvidence, observations,
        mayRefine ? remaining : undefined);
      const citations = final ? resolveCitations(final.citations, finalEvidence) : [];
      if (final?.sufficient && citations.length) {
        return { answer: final.answer, reliable: true, usedReact: false, usedPerception: true,
          evidence: citations, observations };
      }
      gap = final?.missingInformation ?? gap;
      requests = mayRefine ? boundQaPerceptionPlan(final?.perceptionRequests, duration, remaining) : [];
    }
    return { ...unavailable(gap, true), observations };
  }

  private async judgeDirectAnswer(
    understanding: VideoUnderstanding,
    question: string,
    timeline: RelevantTimelineRecord[],
    knownEvidence: KnownEvidence[],
    observations?: ToolObservation[],
    remainingLimits?: QaPerceptionLimits,
  ): Promise<DirectJudgement | undefined> {
    try {
      const raw = await requestJson(this.dependencies.llm, {
        system: observations ? FINAL_QA_SYSTEM_PROMPT : DIRECT_QA_SYSTEM_PROMPT,
        prompt: jsonForPrompt({
          question,
          understanding: compactUnderstanding(understanding),
          relevantTimeline: timeline,
          knownEvidence,
          ...(observations ? { observations: observations.map(({ tool, summary, evidence }) => ({ tool, summary, evidence })) }
            : { perceptionLimits: QA_PERCEPTION_LIMITS }),
          ...(remainingLimits ? { remainingPerceptionLimits: remainingLimits } : {}),
        }),
        maxTokens: 2_000,
        metadata: { task: observations ? "video_qa_final" : "video_qa_direct", videoId: understanding.videoId },
      });
      return parseDirectJudgement(raw);
    } catch (error) {
      if (error instanceof ModelOutputError) return undefined;
      throw error;
    }
  }
}

/** Function form matching ask(videoId, question), with dependencies injected once. */
export async function ask(
  videoId: string,
  question: string,
  dependencies: VideoQaDependencies,
): Promise<QAResult> {
  return new VideoQAService(dependencies).ask(videoId, question);
}

/** Adapter for the filesystem VideoStorage without coupling QA to its class. */
export function createStorageQaRepository(storage: {
  readUnderstanding(videoId: string): Promise<VideoUnderstanding | undefined>;
  readTimeline(videoId: string): Promise<VideoTimeline | undefined>;
}): VideoQaRepository {
  return {
    readUnderstanding: (videoId) => storage.readUnderstanding(videoId),
    readTimeline: (videoId) => storage.readTimeline(videoId),
  };
}

const DIRECT_QA_SYSTEM_PROMPT = `Answer a question about a video using ONLY the persistent VideoUnderstanding and relevant timeline records supplied by the user. Return JSON only:
{"answer":"...","sufficient":true|false,"citations":[{"type":"subtitle|description|danmaku|frame|clip","start":0,"end":1,"ref":"optional"}],"missingInformation":"optional","perceptionRequests":[{"modality":"frame|frames","start":0,"end":1,"count":4}]}.

Set sufficient true only when the supplied evidence directly supports the answer. Cite supplied evidence only; citations are mandatory for a sufficient answer. If visual/local information is missing, set sufficient false and specify all necessary local visual ranges NOW in perceptionRequests, respecting perceptionLimits. This is a single finite plan, not an interactive tool loop. Prefer one frame for a label or object; use a short frame sequence for changes/actions. Localize from supplied times and sections; never invent a location if it cannot be established. Do not assume description is a visual observation.`;

const FINAL_QA_SYSTEM_PROMPT = `Answer the video question using ONLY the supplied understanding, timeline and observations. Return JSON: {"answer":"...","sufficient":true|false,"citations":[{"type":"subtitle|description|danmaku|frame|clip","start":0,"end":1,"ref":"optional"}],"missingInformation":"optional","perceptionRequests":[]}. Cite supplied evidence supporting the answer. New observations supersede older uncertain summaries. If evidence is insufficient, set sufficient false and explain the remaining gap; never guess. ONLY when remainingPerceptionLimits is provided, you may request one additional finite visual plan (frame|frames, start, end, count) to close a specific gap. Respect the remaining total budget. Do not repeat an already observed range. Otherwise no further perception is available.`;

interface RelevantTimelineRecord {
  id: string;
  type: TimelineItem["type"];
  start: number;
  end?: number;
  content?: string;
  ref?: string;
  score: number;
}

function relevantTimelineEvidence(
  timeline: VideoTimeline | TimelineReadable,
  question: string,
  understanding: VideoUnderstanding,
): RelevantTimelineRecord[] {
  const retriever = new TimelineRetriever(timeline);
  const range = questionTimeRange(question, durationOf(timeline, understanding));
  const ranked = retriever
    .relevantTo(question, { limit: 12, ...range })
    .map((entry) => ({
      id: entry.item.id,
      type: entry.item.type,
      start: entry.item.start,
      ...(entry.item.end === undefined ? {} : { end: entry.item.end }),
      ...(entry.item.content === undefined ? {} : { content: entry.item.content }),
      ...(entry.item.ref === undefined ? {} : { ref: entry.item.ref }),
      score: entry.score,
    }));
  if (ranked.length > 0 || range.start === undefined || range.end === undefined) {
    return ranked;
  }

  // Timestamp questions such as “3:20 发生了什么？” are primarily temporal,
  // not lexical. Preserve nearby raw records even when their text has no word
  // overlap with the question, so QA can decide whether local perception is
  // still needed.
  const center = (range.start + range.end) / 2;
  return retriever.readAround(center, (range.end - range.start) / 2).slice(0, 12).map((item) => ({
    id: item.id,
    type: item.type,
    start: item.start,
    ...(item.end === undefined ? {} : { end: item.end }),
    ...(item.content === undefined ? {} : { content: item.content }),
    ...(item.ref === undefined ? {} : { ref: item.ref }),
    score: 0.01,
  }));
}

function collectKnownEvidence(
  understanding: VideoUnderstanding,
  timeline: RelevantTimelineRecord[],
): KnownEvidence[] {
  const sections = understanding.sections.map((section) =>
    section.evidence.map((evidence) => ({
      evidence,
      content: [section.summary, section.visual].filter(Boolean).join(" "),
    })),
  );
  const timelineEvidence = timeline.map((item) => ({
    evidence: timelineItemToEvidence(item),
    ...(item.content ? { content: item.content } : {}),
  }));
  return dedupeKnownEvidence([...timelineEvidence, ...sections.flat()]).slice(0, 60);
}

function parseDirectJudgement(raw: unknown): DirectJudgement {
  const value = expectObject(raw, "Direct QA response");
  const citations = parseCitations(value.citations);
  return {
    answer: expectString(value.answer, "answer"),
    sufficient: value.sufficient === true,
    citations,
    perceptionRequests: value.perceptionRequests,
    ...(optionalString(value.missingInformation, "missingInformation")
      ? { missingInformation: optionalString(value.missingInformation, "missingInformation") }
      : {}),
  };
}

function parseCitations(value: unknown): EvidenceRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ModelOutputError("citations must be an array.");
  return value.map((citation, index) => {
    const record = expectObject(citation, `citations[${index}]`);
    const type = expectString(record.type, `citations[${index}].type`);
    if (!isEvidenceType(type)) throw new ModelOutputError(`citations[${index}] has an invalid type.`);
    const start = record.start === undefined
      ? undefined
      : expectFiniteNumber(record.start, `citations[${index}].start`);
    const end = record.end === undefined
      ? undefined
      : expectFiniteNumber(record.end, `citations[${index}].end`);
    if (start !== undefined && start < 0) {
      throw new ModelOutputError(`citations[${index}].start cannot be negative.`);
    }
    if (end !== undefined && end < 0) {
      throw new ModelOutputError(`citations[${index}].end cannot be negative.`);
    }
    if (start !== undefined && end !== undefined && end < start) {
      throw new ModelOutputError(`citations[${index}].end cannot precede start.`);
    }
    const ref = optionalString(record.ref, `citations[${index}].ref`);
    return {
      type,
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
      ...(ref === undefined ? {} : { ref }),
    };
  });
}

function compactUnderstanding(understanding: VideoUnderstanding): Record<string, unknown> {
  return {
    overview: understanding.overview,
    contentType: understanding.contentType,
    unresolved: understanding.unresolved,
    sections: understanding.sections.map((section) => ({
      start: section.start,
      end: section.end,
      summary: section.summary,
      ...(section.visual ? { visual: section.visual } : {}),
      importance: section.importance,
      evidence: section.evidence,
    })),
  };
}

function questionTimeRange(
  question: string,
  duration: number): { start?: number; end?: number } {
  const match = question.match(/(?<!\d)(\d{1,3})\s*[:：]\s*(\d{1,2})(?!\d)/u);
  if (!match) return {};
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  if (!Number.isFinite(seconds) || seconds > duration) return {};
  return { start: Math.max(0, seconds - 20), end: Math.min(duration, seconds + 20) };
}

function durationOf(
  timeline: VideoTimeline | TimelineReadable,
  understanding: VideoUnderstanding,
): number {
  const duration = "duration" in timeline ? timeline.duration : undefined;
  if (typeof duration === "number" && Number.isFinite(duration)) return duration;
  return Math.max(...understanding.sections.map((section) => section.end), 0);
}

function resolveCitations(requested: EvidenceRef[], known: KnownEvidence[]): EvidenceRef[] {
  const available = known.map((item) => item.evidence);
  if (available.length === 0) return [];
  if (requested.length === 0) return [];
  return dedupeEvidence(
    requested.filter((citation) => available.some((evidence) => evidenceMatches(citation, evidence))),
  );
}

function unavailable(
  reason: string,
  usedPerception: boolean,
  evidence: EvidenceRef[] = [],
): QAResult {
  return {
    answer: `无法从当前视频证据可靠确认：${reason}`,
    reliable: false,
    usedReact: false,
    usedPerception,
    evidence: dedupeEvidence(evidence),
    observations: [],
    missingInformation: reason,
  };
}

function requireNonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function isEvidenceType(value: string): value is EvidenceRef["type"] {
  return ["subtitle", "description", "danmaku", "frame", "clip"].includes(value);
}

function evidenceMatches(left: EvidenceRef, right: EvidenceRef): boolean {
  if (left.type !== right.type) return false;
  if (left.ref && right.ref) return left.ref === right.ref;
  if (left.ref || right.ref) return false;
  return left.start === right.start && left.end === right.end;
}

function dedupeKnownEvidence(items: KnownEvidence[]): KnownEvidence[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = evidenceKey(item.evidence);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeEvidence(items: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = evidenceKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evidenceKey(item: EvidenceRef): string {
  return `${item.type}:${item.ref ?? ""}:${item.start ?? ""}:${item.end ?? ""}`;
}
