import { describe, expect, it } from "vitest";

import {
  OpenAICompatibleASRProvider,
  OpenAICompatibleLLMProvider,
  OpenAICompatibleVisionProvider,
  type FetchLike,
} from "./openai-compatible.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenAICompatibleLLMProvider", () => {
  it("selects the configured model and parses JSON value and token usage", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({
        model: "chat-model",
        choices: [{ message: { content: "{\"answer\":42}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      });
    };
    const provider = new OpenAICompatibleLLMProvider({
      baseUrl: "https://models.example/v1/",
      model: "chat-model",
      jsonMode: true,
      fetch: fetchMock,
    });

    const response = await provider.generate<{ answer: number }>({
      prompt: "Return JSON",
      responseFormat: "json",
      maxTokens: 100,
    });
    const body = JSON.parse(String(calls[0]?.init?.body));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://models.example/v1/chat/completions");
    expect(body).toMatchObject({
      model: "chat-model",
      max_tokens: 100,
      response_format: { type: "json_object" },
    });
    expect(response.value).toEqual({ answer: 42 });
    expect(response.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it("redacts credentials and limits a non-2xx response body", async () => {
    const secret = "top-secret-key";
    const customHeaderSecret = "custom-x-auth-value";
    const provider = new OpenAICompatibleLLMProvider({
      baseUrl: "https://models.example/v1",
      model: "chat-model",
      apiKey: secret,
      headers: { "X-Auth": customHeaderSecret },
      fetch: async () => new Response(
        `${secret} ${customHeaderSecret} ${"x".repeat(5_000)}`,
        { status: 401 },
      ),
    });

    let message = "";
    try {
      await provider.generate({ prompt: "hello" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("HTTP 401");
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(secret);
    expect(message).not.toContain(customHeaderSecret);
    expect(message.length).toBeLessThan(1_200);
  });

  it("keeps the timeout active while reading a streamed response body", async () => {
    const provider = new OpenAICompatibleLLMProvider({
      baseUrl: "https://models.example/v1",
      model: "chat-model",
      timeoutMs: 20,
      fetch: async (_input, init) => {
        const signal = init?.signal;
        const stream = new ReadableStream({
          start(controller) {
            signal?.addEventListener("abort", () => {
              controller.error(new DOMException("aborted", "AbortError"));
            }, { once: true });
          },
        });
        return new Response(stream, { status: 200 });
      },
    });

    let guard: ReturnType<typeof setTimeout> | undefined;
    const guarded = Promise.race([
      provider.generate({ prompt: "hello" }),
      new Promise<never>((_resolve, reject) => {
        guard = setTimeout(() => reject(new Error("test guard timeout")), 500);
      }),
    ]);
    await expect(guarded).rejects.toThrow(/timed out after 20ms/);
    if (guard) clearTimeout(guard);
  });

  it("wraps and redacts response body read failures", async () => {
    const customHeaderSecret = "reader-secret";
    const provider = new OpenAICompatibleLLMProvider({
      baseUrl: "https://models.example/v1",
      model: "chat-model",
      headers: { "X-Custom": customHeaderSecret },
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.error(new Error(`reader failed with ${customHeaderSecret}`));
        },
      })),
    });

    let message = "";
    try {
      await provider.generate({ prompt: "hello" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("OpenAI-compatible request failed");
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(customHeaderSecret);
  });

  it("retains a custom Authorization header when no apiKey is configured", async () => {
    let authorization: string | null = null;
    const provider = new OpenAICompatibleLLMProvider({
      baseUrl: "https://models.example/v1",
      model: "chat-model",
      headers: { authorization: "Custom local-token" },
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
    });

    await provider.generate({ prompt: "hello" });
    expect(authorization).toBe("Custom local-token");
  });
});

describe("OpenAICompatibleVisionProvider", () => {
  it("sends local/data/HTTP images in one request and validates a bounded observation", async () => {
    const calls: Array<{ body: Record<string, any> }> = [];
    let fileReads = 0;
    const provider = new OpenAICompatibleVisionProvider({
      baseUrl: "https://models.example/v1",
      model: "vision-model",
      jsonMode: true,
      readBinaryFile: async () => {
        fileReads += 1;
        return new Uint8Array([1, 2, 3]);
      },
      fetch: async (_input, init) => {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return jsonResponse({
          choices: [{
            message: {
              content: JSON.stringify({
                start: 0,
                end: 99,
                summary: "The ranking changes.",
                notableVisuals: ["A line moves upward."],
                contentTypeHints: ["chart"],
                suggestedRanges: [{ start: 0, end: 99, reason: "large change" }],
              }),
            },
          }],
        });
      },
    });

    const observation = await provider.analyzeImages({
      start: 2,
      end: 4,
      images: [
        { time: 2, ref: "frame-a.png" },
        { time: 3, data: new Uint8Array([4, 5]), mimeType: "image/webp" },
        { time: 4, ref: "https://cdn.example/frame-c.jpg" },
      ],
      instruction: "focus on ranking",
    });

    const content = calls[0]?.body.messages[1].content as Array<Record<string, any>>;
    expect(calls).toHaveLength(1);
    expect(fileReads).toBe(1);
    expect(calls[0]?.body.model).toBe("vision-model");
    expect(content.filter((part) => part.type === "image_url")).toHaveLength(3);
    expect(content[1]?.image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(observation).toMatchObject({
      start: 2,
      end: 4,
      summary: "The ranking changes.",
      contentTypeHints: ["chart"],
      suggestedRanges: [{ start: 2, end: 4, reason: "large change" }],
    });
    expect(observation.evidence).toHaveLength(3);
    expect(observation.evidence?.every((item) => item.type === "frame")).toBe(true);
  });

  it("drops malformed optional model hints instead of failing the observation", async () => {
    const provider = new OpenAICompatibleVisionProvider({
      baseUrl: "https://models.example/v1",
      model: "vision-model",
      readBinaryFile: async () => new Uint8Array([1, 2, 3]),
      fetch: async () => jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              start: 0,
              end: 10,
              summary: "ok",
              notableVisuals: ["keep me", 7],
              visualEvents: "not-an-array",
              contentTypeHints: ["chart", "not-a-type"],
              suggestedRanges: [
                { start: 1, end: 3, reason: "valid" },
                "junk",
                { start: 5, end: 2, reason: "reversed" },
                { start: 0, end: 1, reason: "" },
              ],
            }),
          },
        }],
      }),
    });

    const observation = await provider.analyzeImages({
      start: 0,
      end: 10,
      images: [{ time: 0, ref: "frame-a.png" }],
    });

    expect(observation.notableVisuals).toEqual(["keep me"]);
    expect(observation.visualEvents).toBeUndefined();
    expect(observation.contentTypeHints).toEqual(["chart"]);
    expect(observation.suggestedRanges).toEqual([{ start: 1, end: 3, reason: "valid" }]);
  });

  it("rejects frames outside an explicitly supplied time range before fetch", async () => {
    let fetchCalls = 0;
    const provider = new OpenAICompatibleVisionProvider({
      baseUrl: "https://models.example/v1",
      model: "vision-model",
      fetch: async () => {
        fetchCalls += 1;
        return jsonResponse({});
      },
    });

    await expect(provider.analyzeImages({
      start: 10,
      end: 20,
      images: [{ time: 100, data: new Uint8Array([1]), mimeType: "image/jpeg" }],
    })).rejects.toThrow(/images\[0\]\.time.*10 to 20/);
    expect(fetchCalls).toBe(0);
  });
});

describe("OpenAICompatibleASRProvider", () => {
  it("posts json multipart with its own model and maps segments to seconds", async () => {
    let capturedForm: FormData | undefined;
    let contentTypeHeader: string | null = "not-inspected";
    const provider = new OpenAICompatibleASRProvider({
      baseUrl: "https://models.example/v1",
      model: "asr-model",
      headers: { "Content-Type": "application/json" },
      readBinaryFile: async () => new Uint8Array([10, 20, 30]),
      fetch: async (_input, init) => {
        capturedForm = init?.body as FormData;
        contentTypeHeader = new Headers(init?.headers).get("content-type");
        return jsonResponse({
          language: "zh",
          duration: 4.2,
          segments: [
            { id: 7, start: 0.25, end: 1.5, text: "第一句" },
            { id: 8, start: 1.5, end: 4.2, text: "第二句" },
          ],
        });
      },
    });

    const transcript = await provider.transcribe({ audioRef: "audio.wav", language: "zh" });

    expect(capturedForm?.get("model")).toBe("asr-model");
    expect(capturedForm?.get("response_format")).toBe("json");
    expect(capturedForm?.get("timestamp_granularities[]")).toBe("segment");
    expect(capturedForm?.get("file")).toBeInstanceOf(Blob);
    expect(contentTypeHeader).toBeNull();
    expect(transcript).toMatchObject({
      source: "asr",
      language: "zh",
      cues: [
        { id: "7", start: 0.25, end: 1.5, content: "第一句" },
        { id: "8", start: 1.5, end: 4.2, content: "第二句" },
      ],
    });
  });

  it("falls back to a whole-file cue when the service returns text without segments", async () => {
    const provider = new OpenAICompatibleASRProvider({
      baseUrl: "https://models.example/v1",
      model: "asr-model",
      readBinaryFile: async () => new Uint8Array([10, 20, 30]),
      fetch: async () => jsonResponse({
        text: "整段转写文本",
        language: "None",
      }),
    });

    const transcript = await provider.transcribe({
      audioRef: "audio.wav",
      start: 2,
      end: 30,
      duration: 32,
      language: "zh",
    });

    expect(transcript).toMatchObject({
      source: "asr",
      language: "zh",
      cues: [{ start: 2, end: 30, content: "整段转写文本" }],
    });
  });

  it("prefers the request duration when the response has no end or duration", async () => {
    const provider = new OpenAICompatibleASRProvider({
      baseUrl: "https://models.example/v1",
      model: "asr-model",
      readBinaryFile: async () => new Uint8Array([10, 20, 30]),
      fetch: async () => jsonResponse({ text: "只有文本" }),
    });

    const transcript = await provider.transcribe({ audioRef: "audio.wav", duration: 12 });

    expect(transcript.cues).toEqual([{ start: 0, end: 12, content: "只有文本" }]);
  });

  it("returns empty cues for silent whole-text input", async () => {
    const provider = new OpenAICompatibleASRProvider({
      baseUrl: "https://models.example/v1",
      model: "asr-model",
      readBinaryFile: async () => new Uint8Array([10, 20, 30]),
      fetch: async () => jsonResponse({ text: "", language: "None" }),
    });

    const transcript = await provider.transcribe({ audioRef: "audio.wav", duration: 12 });

    expect(transcript.cues).toEqual([]);
  });
});
