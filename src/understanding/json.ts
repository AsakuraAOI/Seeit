import type { LLMProvider } from "../providers/interfaces.js";

export type JsonObject = Record<string, unknown>;

export class ModelOutputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

export interface JsonPrompt {
  system: string;
  prompt: string;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Calls the provider in JSON mode and accepts only a real JSON value. Provider
 * adapters may return either `value` or textual JSON; both paths are parsed
 * before business logic sees the result.
 */
export async function requestJson(
  provider: LLMProvider,
  request: JsonPrompt,
): Promise<unknown> {
  const response = await provider.generate<unknown>({
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.prompt },
    ],
    responseFormat: "json",
    temperature: 0,
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
  });

  if (response.value !== undefined) {
    return parsePossibleJson(response.value);
  }
  return parsePossibleJson(response.text);
}

export function parsePossibleJson(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const candidate = stripCodeFence(value).trim();
  if (!candidate) throw new ModelOutputError("The model returned an empty JSON response.");

  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    throw new ModelOutputError("The model response is not valid JSON.");
  }
}

export function expectObject(value: unknown, context: string): JsonObject {
  if (!isRecord(value)) {
    throw new ModelOutputError(`${context} must be a JSON object.`);
  }
  return value;
}

export function expectString(
  value: unknown,
  context: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string" || (!options.allowEmpty && !value.trim())) {
    throw new ModelOutputError(`${context} must be a non-empty string.`);
  }
  return value.trim();
}

export function optionalString(value: unknown, context: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return expectString(value, context);
}

export function expectFiniteNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ModelOutputError(`${context} must be a finite number.`);
  }
  return value;
}

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keeps prompts bounded and serializable while retaining the raw evidence. */
export function jsonForPrompt(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function stripCodeFence(value: string): string {
  const fenced = value.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  return fenced ? fenced[1] : value;
}
