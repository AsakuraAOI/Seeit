import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { ASRProvider, LLMProvider, VisionProvider } from "./interfaces.js";
import { normalizePerceptionBudget, normalizePerceptionPolicy, type PerceptionPolicy } from "../perception/policy.js";
import {
  OpenAICompatibleASRProvider,
  OpenAICompatibleLLMProvider,
  OpenAICompatibleVisionProvider,
  type BinaryFileReader,
  type FetchLike,
} from "./openai-compatible.js";

export interface OpenAICompatibleConnectionConfig {
  type: "openai-compatible";
  baseUrl: string;
  /** Preferred credential source. If configured, it must exist at provider creation time. */
  apiKeyEnv?: string;
  /** Supported for controlled local files; apiKeyEnv is preferred. */
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Send OpenAI's response_format=json_object when JSON output is requested. */
  jsonMode?: boolean;
}

export interface ProviderModelConfig {
  connection: string;
  model: string;
}

export interface ProviderModelsConfig {
  llm: ProviderModelConfig;
  vision?: ProviderModelConfig;
  asr?: ProviderModelConfig;
}

export interface ProviderConfig {
  schemaVersion: 1;
  connections: Record<string, OpenAICompatibleConnectionConfig>;
  models: ProviderModelsConfig;
  /** Optional in schemaVersion 1 so existing configuration files remain valid. */
  perception?: PerceptionConfig;
}

export interface PerceptionConfig {
  enabled?: boolean;
  maxRequests?: number;
  maxFrames?: number;
  maxVisualSeconds?: number;
  maxRefinements?: number;
}

export interface ConfiguredProviders {
  llm: LLMProvider;
  vision?: VisionProvider;
  asr?: ASRProvider;
  /** Normalized policy which applications can pass into VideoUnderstandingSystem. */
  perception: PerceptionPolicy;
}

export interface ConfiguredProviderOptions {
  fetch?: FetchLike;
  readBinaryFile?: BinaryFileReader;
  env?: Readonly<Record<string, string | undefined>>;
}

export class ProviderConfigError extends Error {
  public constructor(
    message: string,
    public readonly configPath?: string,
  ) {
    super(configPath ? `Provider config ${configPath}: ${message}` : `Provider config: ${message}`);
    this.name = "ProviderConfigError";
  }
}

/** SEEIT_CONFIG wins over the conventional cwd/seeit.config.json path. */
export function resolveProviderConfigPath(
  configPath?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const selected = configPath?.trim() || env.SEEIT_CONFIG?.trim() || "seeit.config.json";
  return isAbsolute(selected) ? selected : resolve(process.cwd(), selected);
}

export async function loadProviderConfig(configPath?: string): Promise<ProviderConfig> {
  const resolvedPath = resolveProviderConfigPath(configPath);
  let source: string;
  try {
    source = await readFile(resolvedPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ProviderConfigError(`cannot read file (${reason}).`, resolvedPath);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ProviderConfigError(`invalid JSON (${reason}).`, resolvedPath);
  }
  return parseProviderConfig(raw, resolvedPath);
}

/** Validates even typed objects so callers cannot bypass runtime safety with a cast. */
export function createConfiguredProviders(
  input: ProviderConfig | unknown,
  options: ConfiguredProviderOptions = {},
): ConfiguredProviders {
  const config = parseProviderConfig(input);
  const env = options.env ?? process.env;
  const llm = createLLM(config, "llm", config.models.llm, env, options);
  const vision = config.models.vision
    ? createVision(config, "vision", config.models.vision, env, options)
    : undefined;
  const asr = config.models.asr
    ? createASR(config, "asr", config.models.asr, env, options)
    : undefined;

  return {
    llm,
    ...(vision ? { vision } : {}),
    ...(asr ? { asr } : {}),
    perception: config.perception
      ? normalizePerceptionPolicy({
          ...(config.perception.enabled === undefined ? {} : { enabled: config.perception.enabled }),
          ...(config.perception.maxRefinements === undefined ? {} : { maxRefinements: config.perception.maxRefinements }),
          budget: normalizePerceptionBudget({
            maxRequests: config.perception.maxRequests,
            maxFrames: config.perception.maxFrames,
            maxVisualSeconds: config.perception.maxVisualSeconds,
          }),
        })
      : normalizePerceptionPolicy(undefined),
  };
}

export async function loadConfiguredProviders(
  configPath?: string,
  options: ConfiguredProviderOptions = {},
): Promise<ConfiguredProviders> {
  const path = resolveProviderConfigPath(configPath, options.env ?? process.env);
  const config = await loadProviderConfig(path);
  try {
    return createConfiguredProviders(config, options);
  } catch (error) {
    if (error instanceof ProviderConfigError && !error.configPath) {
      throw new ProviderConfigError(error.message.replace(/^Provider config:\s*/, ""), path);
    }
    throw error;
  }
}

export function parseProviderConfig(input: unknown, configPath?: string): ProviderConfig {
  const root = requireRecord(input, "root", configPath);
  rejectUnknownKeys(root, ["schemaVersion", "connections", "models", "perception"], "root", configPath);
  if (root.schemaVersion !== 1) {
    fail("schemaVersion must be exactly 1.", configPath);
  }

  const rawConnections = requireRecord(root.connections, "connections", configPath);
  const connectionEntries = Object.entries(rawConnections);
  if (connectionEntries.length === 0) fail("connections must contain at least one entry.", configPath);
  const connections = Object.create(null) as Record<string, OpenAICompatibleConnectionConfig>;
  for (const [name, value] of connectionEntries) {
    if (!name.trim()) fail("connection names must be non-empty.", configPath);
    connections[name] = parseConnection(value, `connections.${name}`, configPath);
  }

  const rawModels = requireRecord(root.models, "models", configPath);
  rejectUnknownKeys(rawModels, ["llm", "vision", "asr"], "models", configPath);
  if (rawModels.llm === undefined) fail("models.llm is required.", configPath);
  const models: ProviderModelsConfig = {
    llm: parseModel(rawModels.llm, "models.llm", connections, configPath),
    ...(rawModels.vision === undefined
      ? {}
      : { vision: parseModel(rawModels.vision, "models.vision", connections, configPath) }),
    ...(rawModels.asr === undefined
      ? {}
      : { asr: parseModel(rawModels.asr, "models.asr", connections, configPath) }),
  };

  const perception = root.perception === undefined
    ? undefined
    : parsePerception(root.perception, "perception", configPath);
  return { schemaVersion: 1, connections, models, ...(perception ? { perception } : {}) };
}

function parsePerception(input: unknown, field: string, configPath?: string): PerceptionConfig {
  const value = requireRecord(input, field, configPath);
  rejectUnknownKeys(value, ["enabled", "maxRequests", "maxFrames", "maxVisualSeconds", "maxRefinements"], field, configPath);
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    fail(`${field}.enabled must be a boolean.`, configPath);
  }
  return {
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(value.maxRequests === undefined ? {} : { maxRequests: requirePositiveInteger(value.maxRequests, `${field}.maxRequests`, configPath) }),
    ...(value.maxFrames === undefined ? {} : { maxFrames: requirePositiveInteger(value.maxFrames, `${field}.maxFrames`, configPath) }),
    ...(value.maxVisualSeconds === undefined ? {} : { maxVisualSeconds: requirePositiveNumber(value.maxVisualSeconds, `${field}.maxVisualSeconds`, configPath) }),
    ...(value.maxRefinements === undefined ? {} : { maxRefinements: requirePositiveInteger(value.maxRefinements, `${field}.maxRefinements`, configPath) }),
  };
}

function parseConnection(
  input: unknown,
  field: string,
  configPath?: string,
): OpenAICompatibleConnectionConfig {
  const value = requireRecord(input, field, configPath);
  rejectUnknownKeys(
    value,
    ["type", "baseUrl", "apiKeyEnv", "apiKey", "headers", "timeoutMs", "jsonMode"],
    field,
    configPath,
  );
  if (value.type !== "openai-compatible") {
    fail(`${field}.type must be "openai-compatible"; unknown provider types are not allowed.`, configPath);
  }
  const baseUrl = requireNonEmptyString(value.baseUrl, `${field}.baseUrl`, configPath);
  validateBaseUrl(baseUrl, `${field}.baseUrl`, configPath);
  const apiKeyEnv = optionalNonEmptyString(value.apiKeyEnv, `${field}.apiKeyEnv`, configPath);
  const apiKey = optionalNonEmptyString(value.apiKey, `${field}.apiKey`, configPath);
  const headers = value.headers === undefined
    ? undefined
    : parseHeaders(value.headers, `${field}.headers`, configPath);
  const timeoutMs = value.timeoutMs === undefined
    ? undefined
    : requirePositiveInteger(value.timeoutMs, `${field}.timeoutMs`, configPath);
  if (value.jsonMode !== undefined && typeof value.jsonMode !== "boolean") {
    fail(`${field}.jsonMode must be a boolean.`, configPath);
  }

  return {
    type: "openai-compatible",
    baseUrl,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(headers ? { headers } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(typeof value.jsonMode === "boolean" ? { jsonMode: value.jsonMode } : {}),
  };
}

function parseModel(
  input: unknown,
  field: string,
  connections: Record<string, OpenAICompatibleConnectionConfig>,
  configPath?: string,
): ProviderModelConfig {
  const value = requireRecord(input, field, configPath);
  rejectUnknownKeys(value, ["connection", "model"], field, configPath);
  const connection = requireNonEmptyString(value.connection, `${field}.connection`, configPath);
  const model = requireNonEmptyString(value.model, `${field}.model`, configPath);
  if (!Object.hasOwn(connections, connection)) {
    fail(`${field}.connection references unknown connection "${connection}".`, configPath);
  }
  return { connection, model };
}

function createLLM(
  config: ProviderConfig,
  capability: "llm",
  model: ProviderModelConfig,
  env: Readonly<Record<string, string | undefined>>,
  options: ConfiguredProviderOptions,
): LLMProvider {
  const connection = resolvedConnection(config, capability, model, env);
  return new OpenAICompatibleLLMProvider({
    ...connection,
    model: model.model,
    fetch: options.fetch,
  });
}

function createVision(
  config: ProviderConfig,
  capability: "vision",
  model: ProviderModelConfig,
  env: Readonly<Record<string, string | undefined>>,
  options: ConfiguredProviderOptions,
): VisionProvider {
  const connection = resolvedConnection(config, capability, model, env);
  return new OpenAICompatibleVisionProvider({
    ...connection,
    model: model.model,
    fetch: options.fetch,
    readBinaryFile: options.readBinaryFile,
  });
}

function createASR(
  config: ProviderConfig,
  capability: "asr",
  model: ProviderModelConfig,
  env: Readonly<Record<string, string | undefined>>,
  options: ConfiguredProviderOptions,
): ASRProvider {
  const connection = resolvedConnection(config, capability, model, env);
  return new OpenAICompatibleASRProvider({
    ...connection,
    model: model.model,
    fetch: options.fetch,
    readBinaryFile: options.readBinaryFile,
  });
}

function resolvedConnection(
  config: ProviderConfig,
  capability: keyof ProviderModelsConfig,
  model: ProviderModelConfig,
  env: Readonly<Record<string, string | undefined>>,
): Omit<OpenAICompatibleConnectionConfig, "type" | "apiKeyEnv"> & { apiKey?: string } {
  const connection = config.connections[model.connection];
  if (!connection) throw new ProviderConfigError(`${String(capability)} references a missing connection.`);
  let apiKey: string | undefined;
  if (connection.apiKeyEnv) {
    const fromEnvironment = env[connection.apiKeyEnv];
    if (!fromEnvironment?.trim()) {
      throw new ProviderConfigError(
        `models.${String(capability)} connection "${model.connection}" requires environment variable "${connection.apiKeyEnv}", but it is not set.`,
      );
    }
    apiKey = fromEnvironment.trim();
  } else if (connection.apiKey) {
    apiKey = connection.apiKey;
  }
  return {
    baseUrl: connection.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(connection.headers ? { headers: { ...connection.headers } } : {}),
    ...(connection.timeoutMs ? { timeoutMs: connection.timeoutMs } : {}),
    ...(connection.jsonMode === undefined ? {} : { jsonMode: connection.jsonMode }),
  };
}

function parseHeaders(
  input: unknown,
  field: string,
  configPath?: string,
): Record<string, string> {
  const value = requireRecord(input, field, configPath);
  const headers = Object.create(null) as Record<string, string>;
  for (const [name, headerValue] of Object.entries(value)) {
    if (!name.trim() || /[\r\n:]/.test(name)) fail(`${field} contains an invalid header name.`, configPath);
    if (typeof headerValue !== "string") fail(`${field}.${name} must be a string.`, configPath);
    if (/[\r\n]/.test(headerValue)) fail(`${field}.${name} must not contain newlines.`, configPath);
    headers[name] = headerValue;
  }
  return headers;
}

function validateBaseUrl(value: string, field: string, configPath?: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${field} must be a valid absolute http/https URL.`, configPath);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`${field} must use http or https.`, configPath);
  }
  if (url.username || url.password) fail(`${field} must not contain embedded credentials.`, configPath);
  if (url.search || url.hash) fail(`${field} must not contain a query string or fragment.`, configPath);
}

function requireRecord(
  value: unknown,
  field: string,
  configPath?: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${field} must be an object.`, configPath);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, field: string, configPath?: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string.`, configPath);
  return value.trim();
}

function optionalNonEmptyString(
  value: unknown,
  field: string,
  configPath?: string,
): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, field, configPath);
}

function requirePositiveInteger(value: unknown, field: string, configPath?: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`${field} must be a positive integer.`, configPath);
  }
  return value;
}

function requirePositiveNumber(value: unknown, field: string, configPath?: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${field} must be a positive finite number.`, configPath);
  }
  return value;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  configPath?: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(`${field} contains unknown field "${unknown[0]}".`, configPath);
}

function fail(message: string, configPath?: string): never {
  throw new ProviderConfigError(message, configPath);
}
