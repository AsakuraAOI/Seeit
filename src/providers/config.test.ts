import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  createConfiguredProviders,
  loadConfiguredProviders,
  loadProviderConfig,
  parseProviderConfig,
  type ProviderConfig,
} from "./config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function writeConfig(config: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "seeit-provider-config-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "providers.json");
  await writeFile(path, JSON.stringify(config), "utf8");
  return path;
}

function validConfig(): ProviderConfig {
  return {
    schemaVersion: 1,
    connections: {
      local: {
        type: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKeyEnv: "LOCAL_API_KEY",
        timeoutMs: 5_000,
        headers: { "X-Tenant": "test" },
        jsonMode: true,
      },
    },
    models: {
      llm: { connection: "local", model: "chat-model" },
      vision: { connection: "local", model: "vision-model" },
      asr: { connection: "local", model: "asr-model" },
    },
  };
}

describe("provider config", () => {
  it("loads a valid schema and supports SEEIT_CONFIG through loadConfiguredProviders", async () => {
    const path = await writeConfig(validConfig());
    await expect(loadProviderConfig(path)).resolves.toMatchObject({
      schemaVersion: 1,
      models: { llm: { model: "chat-model" }, vision: { model: "vision-model" } },
    });

    const providers = await loadConfiguredProviders(undefined, {
      env: { SEEIT_CONFIG: path, LOCAL_API_KEY: "from-env" },
      fetch: async () => new Response("{}", { status: 200 }),
    });
    expect(providers.llm).toBeDefined();
    expect(providers.vision).toBeDefined();
    expect(providers.asr).toBeDefined();
  });

  it.each([
    {
      name: "bad URL",
      mutate(config: Record<string, any>) {
        config.connections.local.baseUrl = "file:///tmp/model";
      },
      expected: /http or https/,
    },
    {
      name: "unknown connection reference",
      mutate(config: Record<string, any>) {
        config.models.llm.connection = "missing";
      },
      expected: /unknown connection "missing"/,
    },
    {
      name: "unknown provider type",
      mutate(config: Record<string, any>) {
        config.connections.local.type = "mystery";
      },
      expected: /unknown provider types/,
    },
    {
      name: "non-string header",
      mutate(config: Record<string, any>) {
        config.connections.local.headers.Authorization = 123;
      },
      expected: /must be a string/,
    },
  ])("rejects $name", ({ mutate, expected }) => {
    const config = structuredClone(validConfig()) as unknown as Record<string, any>;
    mutate(config);
    expect(() => parseProviderConfig(config, "test-config.json")).toThrow(expected);
  });

  it("requires a configured apiKeyEnv only when its model provider is created", () => {
    const config = validConfig();
    expect(() => createConfiguredProviders(config, { env: {} })).toThrow(
      /LOCAL_API_KEY.*not set/,
    );

    const llmOnly: ProviderConfig = {
      ...config,
      connections: {
        publicLocal: {
          type: "openai-compatible",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
        unusedSecret: config.connections.local!,
      },
      models: { llm: { connection: "publicLocal", model: "chat-model" } },
    };
    expect(() => createConfiguredProviders(llmOnly, { env: {} })).not.toThrow();
  });

  it("uses apiKeyEnv ahead of an explicit apiKey", async () => {
    const config = validConfig();
    config.connections.local!.apiKey = "inline-key";
    config.connections.local!.headers = {
      ...config.connections.local!.headers,
      authorization: "Custom header-key",
    };
    let authorization: string | null = null;
    const providers = createConfiguredProviders(config, {
      env: { LOCAL_API_KEY: "environment-key" },
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return new Response(JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }), { status: 200 });
      },
    });

    await providers.llm.generate({ prompt: "hello" });
    expect(authorization).toBe("Bearer environment-key");
  });

  it("includes the resolved path in file errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seeit-provider-missing-"));
    temporaryDirectories.push(directory);
    await expect(loadProviderConfig(join(directory, "missing.json"))).rejects.toThrow(
      /missing\.json/,
    );
  });

  it("accepts a strict optional perception policy while old schemaVersion 1 configs retain defaults", () => {
    const config = validConfig();
    config.perception = { enabled: true, maxRequests: 3, maxFrames: 24, maxVisualSeconds: 90, maxRefinements: 1 };
    expect(parseProviderConfig(config)).toMatchObject({ perception: { maxRequests: 3, maxFrames: 24 } });
    expect(createConfiguredProviders(config, { env: { LOCAL_API_KEY: "test" } }).perception).toMatchObject({
      enabled: true, budget: { maxRequests: 3, maxFrames: 24, maxVisualSeconds: 90 }, maxRefinements: 1,
    });
    expect(createConfiguredProviders(validConfig(), { env: { LOCAL_API_KEY: "test" } }).perception.budget.maxRequests).toBeGreaterThan(0);
  });
});
