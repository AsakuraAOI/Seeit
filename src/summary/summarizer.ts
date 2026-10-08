import type { ContentType, UnderstandingSection, VideoUnderstanding } from "../core/types.js";
import type { SummaryDependencies } from "../understanding/contracts.js";
import {
  expectObject,
  expectString,
  jsonForPrompt,
  requestJson,
} from "../understanding/json.js";

export interface SummaryTemplate {
  headings: readonly [string, string, string];
}

/** Default structures stay intentionally small; wording is delegated to an LLM when supplied. */
export const SUMMARY_TEMPLATES: Readonly<Record<ContentType, SummaryTemplate>> = {
  talk: { headings: ["观点", "论据", "结论"] },
  document: { headings: ["知识点", "解释", "重点"] },
  gameplay: { headings: ["事件", "操作", "结果"] },
  animation: { headings: ["事件发展", "关键变化", "结果"] },
  chart: { headings: ["时间阶段", "关键变化", "趋势"] },
  story: { headings: ["背景", "经过", "结果"] },
  general: { headings: ["主题", "分段", "重点"] },
};

/**
 * Summaries consume the durable VideoUnderstanding only. They do not reopen
 * the source video or timeline, which keeps repeated summaries inexpensive and
 * prevents a lossy summary from becoming the system of record.
 */
export class VideoSummarizer {
  public constructor(private readonly dependencies: SummaryDependencies = {}) {}

  public async summarize(
    understanding: VideoUnderstanding,
    instruction?: string,
  ): Promise<string> {
    validateUnderstanding(understanding);
    const normalizedInstruction = instruction?.trim() || undefined;
    const llm = this.dependencies.llm;
    if (!llm) return deterministicSummary(understanding, normalizedInstruction);

    try {
      const raw = await requestJson(llm, {
        system: SUMMARY_SYSTEM_PROMPT,
        prompt: jsonForPrompt({
          understanding,
          template: SUMMARY_TEMPLATES[understanding.contentType],
          ...(normalizedInstruction ? { userInstruction: normalizedInstruction } : {}),
        }),
        maxTokens: 3_000,
        metadata: {
          task: "video_summary",
          videoId: understanding.videoId,
          contentType: understanding.contentType,
        },
      });
      const object = expectObject(raw, "Summary response");
      return expectString(object.summary, "summary");
    } catch {
      // A deterministic, evidence-preserving summary is safer and more useful
      // than exposing malformed provider output to the user.
      return deterministicSummary(understanding, normalizedInstruction);
    }
  }
}

/** The requested simple function form; a provider is optional for local/tests. */
export async function summarize(
  understanding: VideoUnderstanding,
  instruction?: string,
  dependencies: SummaryDependencies = {},
): Promise<string> {
  return new VideoSummarizer(dependencies).summarize(understanding, instruction);
}

const SUMMARY_SYSTEM_PROMPT = `Write a concise, accurate video summary using ONLY the supplied VideoUnderstanding JSON. Do not claim you watched raw video, searched external sources, or saw details not present in the sections and their visual fields. Return JSON only: {"summary":"..."}.

Follow the supplied content-type template by default. If userInstruction is present, it has higher priority than the default template, while remaining grounded in the supplied understanding.`;

function deterministicSummary(
  understanding: VideoUnderstanding,
  instruction?: string,
): string {
  const template = SUMMARY_TEMPLATES[understanding.contentType];
  const sections = prioritizeSections(understanding.sections, instruction);
  const [first, second, third] = template.headings;
  const overview = understanding.overview.trim();
  const sectionLines = sections.map(formatSection).join("\n");
  const visualLines = sections
    .filter((section) => section.visual?.trim())
    .map((section) => `- ${formatTimeRange(section)}：${section.visual!.trim()}`)
    .join("\n");
  const important = sections
    .filter((section) => section.importance >= 0.65)
    .map((section) => `- ${formatTimeRange(section)}：${section.summary}`)
    .join("\n");

  const intro = instruction ? `\n按用户要求（${instruction}）整理如下：\n` : "\n";
  return [
    `## ${first}`,
    overview,
    intro.trimEnd(),
    `## ${second}`,
    sectionLines || "- 未提供可分段的理解。",
    visualLines ? `\n视觉补充：\n${visualLines}` : "",
    `## ${third}`,
    important || overview,
  ]
    .filter(Boolean)
    .join("\n");
}

function prioritizeSections(
  sections: readonly UnderstandingSection[],
  instruction?: string,
): UnderstandingSection[] {
  if (!instruction) return [...sections];
  const tokens = tokenize(instruction);
  return [...sections].sort((a, b) => {
    const aScore = relevance(a, tokens);
    const bScore = relevance(b, tokens);
    return bScore - aScore || b.importance - a.importance || a.start - b.start;
  });
}

function relevance(section: UnderstandingSection, tokens: string[]): number {
  const text = `${section.summary} ${section.visual ?? ""}`.toLocaleLowerCase();
  return tokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0);
}

function tokenize(value: string): string[] {
  const words = value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const characters = [...value].filter((character) => /[\u3400-\u9fff]/u.test(character));
  return [...new Set([...words, ...characters])];
}

function formatSection(section: UnderstandingSection): string {
  return `- ${formatTimeRange(section)}：${section.summary}`;
}

function formatTimeRange(section: Pick<UnderstandingSection, "start" | "end">): string {
  return `${formatTime(section.start)}–${formatTime(section.end)}`;
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

function validateUnderstanding(understanding: VideoUnderstanding): void {
  if (!understanding.videoId.trim()) throw new TypeError("understanding.videoId is required.");
  if (!understanding.overview.trim()) throw new TypeError("understanding.overview is required.");
  if (!Array.isArray(understanding.sections)) {
    throw new TypeError("understanding.sections must be an array.");
  }
}
