import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ContentType,
  EvidenceRef,
  ObservationRange,
  SubtitleCue,
  Transcript,
  VisionImageInput,
  VisualObservation,
} from "../core/types.js";
import type {
  ASRProvider,
  ASRRequest,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  VisionImageAnalysisRequest,
  VisionProvider,
} from "./interfaces.js";

export type FetchLike = typeof fetch;
export type BinaryFileReader = (path: string) => Promise<Uint8Array>;

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  jsonMode?: boolean;
  fetch?: FetchLike;
}

export interface OpenAICompatibleBinaryProviderOptions
  extends OpenAICompatibleProviderOptions {
  readBinaryFile?: BinaryFileReader;
}

export class OpenAICompatibleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OpenAICompatibleError";
  }
}

export class OpenAICompatibleLLMProvider implements LLMProvider {
  private readonly client: OpenAICompatibleClient;

  public constructor(private readonly options: OpenAICompatibleProviderOptions) {
    validateModel(options.model);
    this.client = new OpenAICompatibleClient(options);
  }

  async generate<T = string>(request: LLMRequest): Promise<LLMResponse<T>> {
    if (
      request.responseFormat !== undefined &&
      request.responseFormat !== "text" &&
      request.responseFormat !== "json"
    ) {
      throw new OpenAICompatibleError("responseFormat must be text or json.");
    }
    const messages = normalizeMessages(request);
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages,
      ...(request.maxTokens === undefined
        ? {}
        : { max_tokens: positiveInteger(request.maxTokens, "maxTokens") }),
      ...(request.temperature === undefined
        ? {}
        : { temperature: finiteNumber(request.temperature, "temperature") }),
      ...(request.responseFormat === "json" && this.options.jsonMode
        ? { response_format: { type: "json_object" } }
        : {}),
    };
    const response = await this.client.postJson("chat/completions", body);
    const content = chatContent(response);
    const value = request.responseFormat === "json"
      ? parseJsonText(content, "LLM chat response") as T
      : undefined;
    const usage = parseUsage(response.usage);
    const firstChoice = firstRecord(response.choices);
    const responseModel = optionalString(response.model);

    return {
      text: content,
      ...(value === undefined ? {} : { value }),
      ...(usage ? { usage } : {}),
      metadata: {
        provider: "openai-compatible",
        model: responseModel ?? this.options.model,
        ...(optionalString(firstChoice?.finish_reason)
          ? { finishReason: optionalString(firstChoice?.finish_reason) }
          : {}),
      },
    };
  }
}

/** Sends all representative images in one chat/completions request. */
export class OpenAICompatibleVisionProvider implements VisionProvider {
  private readonly client: OpenAICompatibleClient;
  private readonly readBinaryFile: BinaryFileReader;

  public constructor(private readonly options: OpenAICompatibleBinaryProviderOptions) {
    validateModel(options.model);
    this.client = new OpenAICompatibleClient(options);
    this.readBinaryFile = options.readBinaryFile ?? defaultReadBinaryFile;
  }

  async analyzeImages(request: VisionImageAnalysisRequest): Promise<VisualObservation> {
    if (!Array.isArray(request.images) || request.images.length === 0) {
      throw new OpenAICompatibleError("Vision analyzeImages requires at least one image.");
    }
    const range = requestRange(request);
    const imageParts = await Promise.all(
      request.images.map(async (image, index) => ({
        type: "image_url",
        image_url: { url: await this.resolveImageUrl(image, index) },
      })),
    );
    const prompt = visionPrompt(request, range);
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: [
        {
          role: "system",
          content: "Return one JSON VisualObservation. Describe salient visual facts and events only; do not describe every frame.",
        },
        {
          role: "user",
          content: [{ type: "text", text: prompt }, ...imageParts],
        },
      ],
      ...(this.options.jsonMode ? { response_format: { type: "json_object" } } : {}),
    };
    const response = await this.client.postJson("chat/completions", body);
    const raw = parseJsonText(chatContent(response), "vision chat response");
    return parseVisualObservation(raw, request, range, this.options.model);
  }

  private async resolveImageUrl(image: VisionImageInput, index: number): Promise<string> {
    finiteNonNegative(image.time, `images[${index}].time`);
    if (image.data && image.data.byteLength > 0) {
      return dataUrl(image.data, validatedImageMime(image.mimeType, `images[${index}].mimeType`));
    }
    const ref = image.ref?.trim();
    if (!ref) {
      throw new OpenAICompatibleError(`Vision images[${index}] requires data or ref.`);
    }
    if (/^https?:\/\//i.test(ref)) {
      const url = safeHttpUrl(ref, `images[${index}].ref`);
      return url.toString();
    }
    if (/^data:image\//i.test(ref)) return ref;

    const localPath = /^file:\/\//i.test(ref) ? fileURLToPath(ref) : ref;
    let bytes: Uint8Array;
    try {
      bytes = await this.readBinaryFile(localPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new OpenAICompatibleError(
        `Cannot read vision image ${index} at ${localPath}: ${limited(reason)}.`,
      );
    }
    if (bytes.byteLength === 0) {
      throw new OpenAICompatibleError(`Vision image ${index} is empty.`);
    }
    return dataUrl(bytes, validatedImageMime(image.mimeType ?? imageMimeType(localPath), `images[${index}].mimeType`));
  }
}

export class OpenAICompatibleASRProvider implements ASRProvider {
  private readonly client: OpenAICompatibleClient;
  private readonly readBinaryFile: BinaryFileReader;

  public constructor(private readonly options: OpenAICompatibleBinaryProviderOptions) {
    validateModel(options.model);
    this.client = new OpenAICompatibleClient(options);
    this.readBinaryFile = options.readBinaryFile ?? defaultReadBinaryFile;
  }

  async transcribe(request: ASRRequest): Promise<Transcript> {
    const audioRef = request.audioRef?.trim();
    if (!audioRef) throw new OpenAICompatibleError("ASR audioRef must be a non-empty local path.");
    if (/^https?:\/\//i.test(audioRef)) {
      throw new OpenAICompatibleError("ASR audioRef must be a local file; remote download is not implicit.");
    }
    const start = request.start === undefined ? 0 : finiteNonNegative(request.start, "ASR start");
    const end = request.end === undefined ? undefined : finiteNonNegative(request.end, "ASR end");
    if (end !== undefined && end < start) {
      throw new OpenAICompatibleError("ASR end must be greater than or equal to start.");
    }
    if (request.duration !== undefined) {
      finiteNonNegative(request.duration, "ASR duration");
    }

    const localPath = /^file:\/\//i.test(audioRef) ? fileURLToPath(audioRef) : audioRef;
    let bytes: Uint8Array;
    try {
      bytes = await this.readBinaryFile(localPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new OpenAICompatibleError(`Cannot read ASR input ${localPath}: ${limited(reason)}.`);
    }
    if (bytes.byteLength === 0) throw new OpenAICompatibleError("ASR input file is empty.");

    const form = new FormData();
    form.append("file", new Blob([Buffer.from(bytes)], { type: audioMimeType(localPath) }), basename(localPath));
    form.append("model", this.options.model);
    // "json" is accepted by both OpenAI (verbose JSON with segments) and
    // whole-text services (e.g. SiliconFlow Qwen3-ASR) that reject verbose_json.
    form.append("response_format", "json");
    form.append("timestamp_granularities[]", "segment");
    if (request.language?.trim()) form.append("language", request.language.trim());

    const response = await this.client.postForm("audio/transcriptions", form);
    const cues = Array.isArray(response.segments)
      ? parseSegments(response.segments, start, end)
      : wholeFileCues(response.text, start, end, request.duration);
    return {
      cues,
      source: "asr",
      ...(asrLanguage(response.language, request.language)
        ? { language: asrLanguage(response.language, request.language) }
        : {}),
      metadata: {
        provider: "openai-compatible",
        model: this.options.model,
        ...(finiteOptional(response.duration) === undefined
          ? {}
          : { duration: finiteOptional(response.duration) }),
      },
    };
  }
}

class OpenAICompatibleClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly secrets: string[];

  public constructor(options: OpenAICompatibleProviderOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new OpenAICompatibleError("A fetch implementation is required.");
    }
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new OpenAICompatibleError("timeoutMs must be a positive integer.");
    }
    this.headers = { ...(options.headers ?? {}) };
    if (options.apiKey) {
      for (const name of Object.keys(this.headers)) {
        if (name.toLowerCase() === "authorization") delete this.headers[name];
      }
      this.headers.Authorization = `Bearer ${options.apiKey}`;
    }
    this.secrets = [
      options.apiKey,
      ...Object.values(this.headers),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
  }

  async postJson(endpoint: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(endpoint, JSON.stringify(body), {
      Accept: "application/json",
      "Content-Type": "application/json",
    }, []);
  }

  async postForm(endpoint: string, body: FormData): Promise<Record<string, unknown>> {
    // fetch must generate multipart/form-data with its boundary.
    return this.request(endpoint, body, { Accept: "application/json" }, ["content-type"]);
  }

  private async request(
    endpoint: string,
    body: string | FormData,
    requestHeaders: Record<string, string>,
    omittedConfiguredHeaders: readonly string[],
  ): Promise<Record<string, unknown>> {
    const url = joinedEndpoint(this.baseUrl, endpoint);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      let responseText: string;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: mergeHeaders(
            omitHeaders(this.headers, omittedConfiguredHeaders),
            requestHeaders,
          ),
          body,
          signal: controller.signal,
        });
        // Keep the same abort deadline active while consuming a streamed body.
        // fetch may resolve as soon as headers arrive, long before response.text().
        responseText = await response.text();
      } catch (error) {
        const reason = controller.signal.aborted
          ? `request timed out after ${this.timeoutMs}ms`
          : sanitize(error instanceof Error ? error.message : String(error), this.secrets);
        throw new OpenAICompatibleError(`OpenAI-compatible request failed: ${limited(reason)}.`);
      }

      if (!response.ok) {
        const safeBody = limited(sanitize(responseText, this.secrets));
        const safeStatusText = limited(sanitize(response.statusText, this.secrets), 128);
        throw new OpenAICompatibleError(
          `OpenAI-compatible HTTP ${response.status}${safeStatusText ? ` ${safeStatusText}` : ""}${safeBody ? `: ${safeBody}` : "."}`,
        );
      }
      try {
        const parsed = JSON.parse(responseText) as unknown;
        if (!isRecord(parsed)) throw new Error("response root is not an object");
        return parsed;
      } catch {
        throw new OpenAICompatibleError("OpenAI-compatible endpoint returned invalid JSON.");
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeMessages(request: LLMRequest): Array<{ role: string; content: string }> {
  const messages = (request.messages ?? []).map((message, index) => {
    if (!["system", "user", "assistant"].includes(message.role)) {
      throw new OpenAICompatibleError(`messages[${index}].role is invalid.`);
    }
    if (typeof message.content !== "string" || !message.content.trim()) {
      throw new OpenAICompatibleError(`messages[${index}].content must be non-empty.`);
    }
    return { role: message.role, content: message.content };
  });
  if (request.prompt?.trim()) messages.push({ role: "user", content: request.prompt });
  if (messages.length === 0) {
    throw new OpenAICompatibleError("LLM request requires prompt or messages.");
  }
  return messages;
}

function chatContent(response: Record<string, unknown>): string {
  const choice = firstRecord(response.choices);
  const message = isRecord(choice?.message) ? choice.message : undefined;
  const content = message?.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const combined = content
      .flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : [])
      .join("");
    if (combined.trim()) return combined;
  }
  throw new OpenAICompatibleError("OpenAI-compatible chat response has no textual choice content.");
}

function parseUsage(value: unknown): LLMResponse["usage"] | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = nonNegativeInteger(value.prompt_tokens);
  const outputTokens = nonNegativeInteger(value.completion_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function requestRange(request: VisionImageAnalysisRequest): { start: number; end: number } {
  const times = request.images.map((image, index) => finiteNonNegative(image.time, `images[${index}].time`));
  const start = request.start === undefined
    ? Math.min(...times)
    : finiteNonNegative(request.start, "vision start");
  const end = request.end === undefined
    ? Math.max(...times)
    : finiteNonNegative(request.end, "vision end");
  if (end < start) throw new OpenAICompatibleError("Vision end must be greater than or equal to start.");
  for (const [index, time] of times.entries()) {
    if (
      (request.start !== undefined && time < start) ||
      (request.end !== undefined && time > end)
    ) {
      throw new OpenAICompatibleError(
        `images[${index}].time must be within the explicit vision range ${start} to ${end}.`,
      );
    }
  }
  return { start, end };
}

function visionPrompt(
  request: VisionImageAnalysisRequest,
  range: { start: number; end: number },
): string {
  return [
    "Analyze the representative frames as one time-ordered batch.",
    `Allowed observation range: ${range.start} to ${range.end} seconds.`,
    `Frame timestamps: ${JSON.stringify(request.images.map((image) => image.time))}.`,
    "Return JSON: {start,end,summary,notableVisuals?,visualEvents?,contentTypeHints?,suggestedRanges?}.",
    "contentTypeHints values: general, talk, document, gameplay, animation, chart, story.",
    request.instruction?.trim() ? `Additional instruction: ${request.instruction.trim()}` : "",
  ].filter(Boolean).join(" ");
}

function parseVisualObservation(
  input: unknown,
  request: VisionImageAnalysisRequest,
  range: { start: number; end: number },
  model: string,
): VisualObservation {
  if (!isRecord(input)) throw new OpenAICompatibleError("Vision response must be a JSON object.");
  const rawStart = finiteNonNegative(input.start, "vision response start");
  const rawEnd = finiteNonNegative(input.end, "vision response end");
  if (rawEnd < rawStart) {
    throw new OpenAICompatibleError("Vision response end must be greater than or equal to start.");
  }
  const summary = requiredString(input.summary, "vision response summary");
  // Optional hints come from the vision model itself; malformed entries are
  // dropped rather than failing the whole observation.
  const notableVisuals = optionalStringArray(input.notableVisuals);
  const visualEvents = optionalStringArray(input.visualEvents);
  const contentTypeHints = optionalContentTypes(input.contentTypeHints);
  const suggestedRanges = optionalObservationRanges(input.suggestedRanges, range);
  const metadata = input.metadata === undefined
    ? undefined
    : recordCopy(input.metadata, "vision response metadata");
  const evidence = frameEvidence(request.images, range);

  return {
    start: clamp(rawStart, range.start, range.end),
    end: clamp(rawEnd, range.start, range.end),
    summary,
    ...(notableVisuals ? { notableVisuals } : {}),
    ...(visualEvents ? { visualEvents } : {}),
    ...(contentTypeHints ? { contentTypeHints } : {}),
    ...(suggestedRanges ? { suggestedRanges } : {}),
    evidence,
    metadata: {
      ...(metadata ?? {}),
      provider: "openai-compatible",
      model,
    },
  };
}

function frameEvidence(
  images: readonly VisionImageInput[],
  range: { start: number; end: number },
): EvidenceRef[] {
  const seen = new Set<string>();
  return images.flatMap((image) => {
    const start = clamp(image.time, range.start, range.end);
    const key = `${start}:${image.ref ?? "data"}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ type: "frame" as const, start, ...(image.ref ? { ref: image.ref } : {}) }];
  });
}

function optionalObservationRanges(
  value: unknown,
  range: { start: number; end: number },
): ObservationRange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ranges: ObservationRange[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) continue;
    const start = item.start;
    const end = item.end;
    const reason = typeof item.reason === "string" ? item.reason.trim() : "";
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start ||
      !reason
    ) {
      continue;
    }
    ranges.push({
      start: clamp(start, range.start, range.end),
      end: clamp(end, range.start, range.end),
      reason,
    });
  }
  return ranges.length ? ranges : undefined;
}

const CONTENT_TYPES = new Set<ContentType>([
  "general", "talk", "document", "gameplay", "animation", "chart", "story",
]);

function optionalContentTypes(value: unknown): ContentType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const types = value.filter(
    (item): item is ContentType => typeof item === "string" && CONTENT_TYPES.has(item as ContentType),
  );
  return types.length ? types : undefined;
}

function parseSegments(value: unknown, start: number, end?: number): Transcript["cues"] {
  if (!Array.isArray(value)) {
    throw new OpenAICompatibleError("ASR verbose_json response must contain a segments array.");
  }
  const cues: Transcript["cues"] = [];
  for (const [index, segment] of value.entries()) {
    if (!isRecord(segment)) throw new OpenAICompatibleError(`ASR segment ${index} must be an object.`);
    const segmentStart = finiteNonNegative(segment.start, `ASR segment ${index} start`);
    const segmentEnd = finiteNonNegative(segment.end, `ASR segment ${index} end`);
    if (segmentEnd < segmentStart) throw new OpenAICompatibleError(`ASR segment ${index} end precedes start.`);
    const content = requiredString(segment.text, `ASR segment ${index} text`);
    if (segmentEnd < start || (end !== undefined && segmentStart > end)) continue;
    const cueStart = Math.max(start, segmentStart);
    const cueEnd = end === undefined ? segmentEnd : Math.min(end, segmentEnd);
    cues.push({
      id: scalarId(segment.id) ?? `asr-${index}`,
      start: cueStart,
      end: cueEnd,
      content,
    });
  }
  return cues;
}

/** Builds a single whole-file cue when the service returns text without a segments array. */
function wholeFileCues(
  text: unknown,
  start: number,
  end: number | undefined,
  duration: number | undefined,
): SubtitleCue[] {
  const content = optionalString(text);
  if (!content) return [];
  const cueEnd = end ?? (duration === undefined ? start : Math.max(start, duration));
  return [{ start, end: cueEnd, content }];
}

/** "None" is SiliconFlow's stand-in for an undetected language. */
function asrLanguage(detected: unknown, requested: string | undefined): string | undefined {
  const value = optionalString(detected);
  return value === undefined || value === "None" ? requested?.trim() : value;
}

function parseJsonText(text: string, context: string): unknown {
  const fenced = text.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i)?.[1] ?? text;
  try {
    return JSON.parse(fenced) as unknown;
  } catch {
    throw new OpenAICompatibleError(`${context} is not valid JSON.`);
  }
}

function normalizedBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenAICompatibleError("baseUrl must be an absolute URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new OpenAICompatibleError("baseUrl must use http or https.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new OpenAICompatibleError("baseUrl must not contain credentials, query, or fragment.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function joinedEndpoint(baseUrl: URL, endpoint: string): URL {
  return new URL(endpoint.replace(/^\/+/, ""), baseUrl);
}

function safeHttpUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenAICompatibleError(`${field} is not a valid URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new OpenAICompatibleError(`${field} must use http or https.`);
  }
  if (url.username || url.password) {
    throw new OpenAICompatibleError(`${field} must not contain embedded credentials.`);
  }
  return url;
}

function mergeHeaders(
  configured: Record<string, string>,
  required: Record<string, string>,
): Record<string, string> {
  const merged = { ...configured };
  for (const [name, value] of Object.entries(required)) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
    }
    merged[name] = value;
  }
  return merged;
}

function omitHeaders(
  headers: Record<string, string>,
  omitted: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !omitted.some((item) => item.toLowerCase() === name.toLowerCase()),
    ),
  );
}

function sanitize(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.replaceAll(secret, "[REDACTED]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) result = result.replaceAll(encoded, "[REDACTED]");
  }
  return result;
}

function limited(value: string, maximum = 1_024): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum)}…`;
}

async function defaultReadBinaryFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

function dataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function validatedImageMime(value: string | undefined, field: string): string {
  const selected = value?.trim() || "image/jpeg";
  if (!/^image\/[A-Za-z0-9.+-]+$/.test(selected)) {
    throw new OpenAICompatibleError(`${field} must be an image MIME type.`);
  }
  return selected;
}

function imageMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".bmp": return "image/bmp";
    case ".jpeg":
    case ".jpg":
    default: return "image/jpeg";
  }
}

function audioMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".wav": return "audio/wav";
    case ".mp3": return "audio/mpeg";
    case ".m4a": return "audio/mp4";
    case ".ogg": return "audio/ogg";
    case ".webm": return "audio/webm";
    case ".mp4": return "video/mp4";
    default: return "application/octet-stream";
  }
}

function validateModel(value: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new OpenAICompatibleError("model must be a non-empty string.");
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new OpenAICompatibleError(`${field} must be a positive integer.`);
  }
  return value;
}

function finiteNumber(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new OpenAICompatibleError(`${field} must be finite.`);
  return value;
}

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new OpenAICompatibleError(`${field} must be a finite non-negative number.`);
  }
  return value;
}

function finiteOptional(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new OpenAICompatibleError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim());
  return strings.length ? strings : undefined;
}

function recordCopy(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new OpenAICompatibleError(`${field} must be an object.`);
  return { ...value };
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) && isRecord(value[0]) ? value[0] : undefined;
}

function scalarId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
