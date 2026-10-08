// Real-media quality review. No synthetic video or model-authored quality score.
// Usage: node examples/review-video.mjs [videoPath] [outputDirectory] [force]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import {
  FfmpegFrameExtractor, LocalVideoIngestor, loadConfiguredProviders,
  MediaIngestService, NodeCommandRunner, SparseFrameSampler,
  VideoStorage, VideoUnderstandingSystem,
} from "../dist/index.js";

const videoPath = resolve(process.argv[2] ?? "1.mp4");
const outputDir = resolve(process.argv[3] ?? "benchmarks/1-mp4-review");
const videoId = basename(videoPath, extname(videoPath));
await mkdir(outputDir, { recursive: true });
const previous = await readFile(join(outputDir, "metrics.json"), "utf8").then(JSON.parse).catch(() => undefined);
const metrics = {
  source: videoPath, startedAt: new Date().toISOString(), qualityAssessment: "pending user review",
  requests: [], stages: {}, decoderProcesses: 0,
  inferencePolicy: { deepseekReasoningEffort: "low", tokenLimit: "provider default; max_tokens omitted", scope: "this review only; provider config unchanged" },
  previousAttempts: previous ? [...(previous.previousAttempts ?? []), {
    startedAt: previous.startedAt, requests: previous.requests, stages: previous.stages, failed: previous.failed,
  }] : [],
};
async function saveMetrics() {
  await writeFile(join(outputDir, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
}
const measuredFetch = async (url, options) => {
  const start = performance.now();
  const entry = { kind: String(url).includes("audio/transcriptions") ? "asr" : "chat", durationMs: 0 };
  if (typeof options?.body === "string") {
    const body = JSON.parse(options.body);
    delete body.max_tokens;
    // Use lower thinking effort for this measured review. No max_tokens is
    // sent; the server's default applies. Record this independently of usage.
    if (body.model?.startsWith("deepseek")) {
      body.reasoning_effort = "low";
      entry.reasoningEffort = "low";
    }
    options = { ...options, body: JSON.stringify(body) };
    entry.model = body.model;
    entry.kind = body.messages?.some((message) => Array.isArray(message.content)) ? "vision" : "llm";
  }
  metrics.requests.push(entry);
  console.log(`[model] ${entry.kind} ${entry.model ?? ""} started`);
  try {
    const response = await fetch(url, options);
    entry.status = response.status;
    const payload = await response.clone().json().catch(() => undefined);
    if (payload?.usage) entry.usage = payload.usage;
    entry.durationMs = Math.round(performance.now() - start);
    console.log(`[model] ${entry.kind} completed in ${(entry.durationMs / 1000).toFixed(1)}s (HTTP ${entry.status})`);
    await saveMetrics();
    return response;
  } catch (error) {
    entry.durationMs = Math.round(performance.now() - start);
    entry.failed = true;
    await saveMetrics();
    throw error;
  }
};
const providers = await loadConfiguredProviders(undefined, { fetch: measuredFetch });
const nativeRunner = new NodeCommandRunner();
const runner = { run: async (command, args, options) => {
  if (command === "ffmpeg") metrics.decoderProcesses += 1;
  return nativeRunner.run(command, args, options);
} };
const storage = new VideoStorage(join(outputDir, "data"));
const frameExtractor = new FfmpegFrameExtractor(runner);
const system = new VideoUnderstandingSystem({
  storage, frameExtractor, frameSampler: new SparseFrameSampler(frameExtractor),
  ingest: new MediaIngestService([new LocalVideoIngestor({
    commandRunner: runner, ...(providers.asr ? { asrProvider: providers.asr } : {}),
    cacheDirForVideo: (id) => storage.getCacheDir(id),
  })]),
  llm: providers.llm, ...(providers.vision ? { vision: providers.vision } : {}),
  perception: providers.perception,
});
try {
  console.log(`Reading ${videoPath}`);
  let start = performance.now();
  const understanding = await system.process({ kind: "local", uri: videoPath, videoId }, {
    force: process.argv[4] === "force",
    instruction: "完整理解视频的真实主题，保留具体实体、关键数字、事件或论证顺序和结论。按需核实影响理解的画面信息，未观察到的细节不要猜测。",
  });
  metrics.stages.processMs = Math.round(performance.now() - start);
  await writeFile(join(outputDir, "understanding.json"), JSON.stringify(understanding, null, 2) + "\n");
  console.log(`[review] process complete in ${(metrics.stages.processMs / 1000).toFixed(1)}s`);
  start = performance.now();
  const summary = await system.summarize(videoId,
    "用中文详细总结这段视频，覆盖主要内容、论证或事件顺序、具体实体、关键数字和结论。按时间阶段组织并注明时间范围，区分可确认事实与未解决问题，避免空泛评价。只总结证据实际支持的内容。");
  metrics.stages.summaryMs = Math.round(performance.now() - start);
  await writeFile(join(outputDir, "summary.md"), summary + "\n");
  const state = await storage.readPerceptionState(videoId);
  const metadata = await storage.readMetadata(videoId);
  metrics.videoDurationSeconds = metadata?.duration;
  metrics.perception = state?.stats;
  metrics.completedAt = new Date().toISOString();
  await saveMetrics();
  console.log(`\n${summary}\n`);
  console.log(`Summary: ${join(outputDir, "summary.md")}`);
  console.log(`Metrics: ${join(outputDir, "metrics.json")}`);
} catch (error) {
  metrics.failed = true;
  await saveMetrics();
  throw error;
}
