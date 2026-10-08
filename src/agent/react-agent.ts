import type { EvidenceRef, VideoUnderstanding } from "../core/types.js";
import type { LLMProvider } from "../providers/interfaces.js";
import {
  expectFiniteNumber,
  expectObject,
  expectString,
  jsonForPrompt,
  ModelOutputError,
  optionalString,
  requestJson,
} from "../understanding/json.js";
import {
  AGENT_TOOL_NAMES,
  type AgentToolName,
  type ToolObservation,
  type VideoAgentTools,
} from "../tools/video-agent-tools.js";

export const MAX_REACT_STEPS = 5;

export interface KnownEvidence {
  evidence: EvidenceRef;
  content?: string;
}

export interface ReactState {
  question: string;
  knownEvidence: KnownEvidence[];
  missingInformation?: string;
  toolObservations: ToolObservation[];
}

export interface ReactRunInput {
  question: string;
  understanding: VideoUnderstanding;
  knownEvidence?: readonly KnownEvidence[];
  missingInformation?: string;
}

export interface ReactResult {
  answer: string;
  reliable: boolean;
  steps: number;
  evidence: EvidenceRef[];
  observations: ToolObservation[];
  missingInformation?: string;
}

export interface ReactAgentDependencies {
  llm: LLMProvider;
  tools: VideoAgentTools;
  /** Can reduce the cap in tests, but never increase MAX_REACT_STEPS. */
  maxSteps?: number;
}

type AgentAction =
  | { name: "answer"; answer: string; sufficient: boolean; citations: EvidenceRef[]; missingInformation?: string }
  | { name: Exclude<AgentToolName, never>; args: Record<string, unknown>; missingInformation?: string };

/**
 * A single-agent, bounded ReAct loop. The agent may only act through the five
 * video tools and keeps all observations as citeable evidence for its next
 * turn. It does not invent a final answer after the cap is reached.
 */
export class ReactAgent {
  public constructor(private readonly dependencies: ReactAgentDependencies) {}

  public async run(input: ReactRunInput): Promise<ReactResult> {
    const question = requireQuestion(input.question);
    const state: ReactState = {
      question,
      knownEvidence: dedupeKnownEvidence(input.knownEvidence ?? []),
      ...(input.missingInformation?.trim()
        ? { missingInformation: input.missingInformation.trim() }
        : {}),
      toolObservations: [],
    };
    const maxSteps = Math.min(
      MAX_REACT_STEPS,
      Math.max(1, Math.floor(this.dependencies.maxSteps ?? MAX_REACT_STEPS)),
    );

    for (let step = 0; step < maxSteps; step += 1) {
      let action: AgentAction;
      try {
        action = await this.nextAction(input.understanding, state, maxSteps - step);
      } catch (error) {
        if (error instanceof ModelOutputError) {
          return unreliableResult(state, step, "模型未返回可验证的行动计划。");
        }
        throw error;
      }

      if (action.missingInformation) state.missingInformation = action.missingInformation;

      if (action.name === "answer") {
        const evidence = resolveCitations(
          action.citations,
          state.knownEvidence,
          state.toolObservations,
        );
        if (action.sufficient && evidence.length > 0) {
          return {
            answer: action.answer,
            reliable: true,
            steps: step,
            evidence,
            observations: [...state.toolObservations],
            ...(state.missingInformation ? { missingInformation: state.missingInformation } : {}),
          };
        }
        return unreliableResult(
          state,
          step,
          action.missingInformation ?? "现有证据不足以支持可靠回答。",
        );
      }

      const observation = await this.invoke(action);
      state.toolObservations.push(observation);
    }

    return unreliableResult(
      state,
      maxSteps,
      state.missingInformation ?? "已达到局部回看上限，证据仍不足。",
    );
  }

  private async nextAction(
    understanding: VideoUnderstanding,
    state: ReactState,
    remainingSteps: number,
  ): Promise<AgentAction> {
    const raw = await requestJson(this.dependencies.llm, {
      system: REACT_SYSTEM_PROMPT,
      prompt: jsonForPrompt({
        question: state.question,
        understanding: compactUnderstanding(understanding),
        knownEvidence: state.knownEvidence,
        ...(state.missingInformation ? { missingInformation: state.missingInformation } : {}),
        toolObservations: state.toolObservations.map(compactObservation),
        remainingSteps,
        tools: AGENT_TOOL_NAMES,
      }),
      maxTokens: 2_000,
      metadata: { task: "video_react_qa", videoId: understanding.videoId },
    });
    return parseAction(raw);
  }

  private async invoke(action: Exclude<AgentAction, { name: "answer" }>): Promise<ToolObservation> {
    try {
      switch (action.name) {
        case "search":
            return await this.dependencies.tools.search(requireStringArg(action.args, "query"));
        case "readAround":
          return await this.dependencies.tools.readAround(
            requireNumberArg(action.args, "time"),
            optionalNumberArg(action.args, "radius") ?? 15,
          );
        case "getFrame":
          return await this.dependencies.tools.getFrame(requireNumberArg(action.args, "time"));
        case "getFrames":
          return await this.dependencies.tools.getFrames(
            requireNumberArg(action.args, "start"),
            requireNumberArg(action.args, "end"),
            requireIntegerArg(action.args, "count"),
          );
        case "getClip":
          return await this.dependencies.tools.getClip(
            requireNumberArg(action.args, "start"),
            requireNumberArg(action.args, "end"),
          );
      }
    } catch (error) {
      return {
        tool: action.name,
        summary: `Tool ${action.name} could not provide evidence: ${errorMessage(error)}`,
        evidence: [],
      };
    }
  }
}

const REACT_SYSTEM_PROMPT = `You are the single ReAct agent for a local video QA system. Return JSON only. You may use exactly one of these actions per turn: search, readAround, getFrame, getFrames, getClip, answer.

Use the persistent understanding and known evidence first. Invoke a local video tool only if it is needed to close a concrete evidence gap. Never use external search. Tool observations are evidence; inspect them on the next turn. Do not expose private chain-of-thought.

For a tool action return: {"action":"search|readAround|getFrame|getFrames|getClip","args":{...},"missingInformation":"optional"}.
For a final response return: {"action":"answer","answer":"...","sufficient":true|false,"citations":[{"type":"...","start":0,"end":1,"ref":"optional"}],"missingInformation":"optional"}.

Only set sufficient to true if available evidence supports the answer. If evidence remains insufficient, use answer with sufficient:false; do not guess.`;

function parseAction(raw: unknown): AgentAction {
  const value = expectObject(raw, "ReAct response");
  const name = expectString(value.action, "action");
  const missingInformation = optionalString(value.missingInformation, "missingInformation");

  if (name === "answer") {
    return {
      name,
      answer: expectString(value.answer, "answer"),
      sufficient: value.sufficient === true,
      citations: parseCitations(value.citations),
      ...(missingInformation ? { missingInformation } : {}),
    };
  }
  if (!isToolName(name)) {
    throw new ModelOutputError(`Unsupported ReAct action: ${name}.`);
  }
  const args = value.args === undefined ? {} : expectObject(value.args, "action args");
  return {
    name,
    args,
    ...(missingInformation ? { missingInformation } : {}),
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

function resolveCitations(
  requested: EvidenceRef[],
  known: KnownEvidence[],
  observations: ToolObservation[],
): EvidenceRef[] {
  const available = [
    ...known.map((item) => item.evidence),
    ...observations.flatMap((observation) => observation.evidence),
  ];
  if (available.length === 0) return [];
  if (requested.length === 0) return dedupeEvidence(available).slice(0, 8);
  const accepted = requested.filter((citation) =>
    available.some((evidence) => evidenceMatches(citation, evidence)),
  );
  return dedupeEvidence(accepted);
}

function compactUnderstanding(understanding: VideoUnderstanding): Record<string, unknown> {
  return {
    overview: understanding.overview,
    contentType: understanding.contentType,
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

function compactObservation(observation: ToolObservation): Record<string, unknown> {
  return {
    tool: observation.tool,
    summary: observation.summary,
    evidence: observation.evidence,
    ...(observation.timelineItems
      ? {
          timelineItems: observation.timelineItems.map((item) => ({
            type: item.type,
            start: item.start,
            end: item.end,
            content: item.content,
            ref: item.ref,
          })),
        }
      : {}),
    ...(observation.visual
      ? {
          visual: {
            start: observation.visual.start,
            end: observation.visual.end,
            summary: observation.visual.summary,
            notableVisuals: observation.visual.notableVisuals,
            visualEvents: observation.visual.visualEvents,
          },
        }
      : {}),
  };
}

function unreliableResult(
  state: ReactState,
  steps: number,
  missingInformation: string,
): ReactResult {
  return {
    answer: `无法从当前视频证据可靠确认：${missingInformation}`,
    reliable: false,
    steps,
    evidence: dedupeEvidence([
      ...state.knownEvidence.map((item) => item.evidence),
      ...state.toolObservations.flatMap((observation) => observation.evidence),
    ]),
    observations: [...state.toolObservations],
    missingInformation,
  };
}

function requireQuestion(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("question must be a non-empty string.");
  }
  return value.trim();
}

function isToolName(value: string): value is AgentToolName {
  return (AGENT_TOOL_NAMES as readonly string[]).includes(value);
}

function isEvidenceType(value: string): value is EvidenceRef["type"] {
  return ["subtitle", "description", "danmaku", "frame", "clip"].includes(value);
}

function requireStringArg(args: Record<string, unknown>, key: string): string {
  return expectString(args[key], `args.${key}`);
}

function requireNumberArg(args: Record<string, unknown>, key: string): number {
  const value = expectFiniteNumber(args[key], `args.${key}`);
  if (value < 0) throw new ModelOutputError(`args.${key} cannot be negative.`);
  return value;
}

function optionalNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  if (args[key] === undefined) return undefined;
  return requireNumberArg(args, key);
}

function requireIntegerArg(args: Record<string, unknown>, key: string): number {
  const value = requireNumberArg(args, key);
  if (!Number.isInteger(value)) throw new ModelOutputError(`args.${key} must be an integer.`);
  return value;
}

function evidenceMatches(left: EvidenceRef, right: EvidenceRef): boolean {
  if (left.type !== right.type) return false;
  if (left.ref && right.ref) return left.ref === right.ref;
  if (left.ref || right.ref) return false;
  const leftStart = left.start ?? right.start;
  const leftEnd = left.end ?? leftStart;
  const rightStart = right.start ?? left.start;
  const rightEnd = right.end ?? rightStart;
  return leftStart === rightStart && leftEnd === rightEnd;
}

function dedupeKnownEvidence(items: readonly KnownEvidence[]): KnownEvidence[] {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
