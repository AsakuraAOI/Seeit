// 完整管线端到端测试（需要 ffmpeg/ffprobe）：
//   ingest(ffprobe + ASR) → cheap/base understanding → selective perception → 总结 → 问答
// 用法: node examples/demo.mjs [视频路径] [videoId]
//   videoId 默认取文件名（去扩展名）；重复运行同一 videoId 会命中 data/ 下的
//   持久化缓存，不会重新预处理（强制重跑可传第四个参数 force）。
import { existsSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import {
  FfmpegFrameExtractor,
  LocalVideoIngestor,
  loadConfiguredProviders,
  MediaIngestService,
  NodeCommandRunner,
  SparseFrameSampler,
  VideoStorage,
  VideoUnderstandingSystem,
} from "../dist/index.js";

const videoPath = resolve(process.argv[2] ?? "media/demo.mp4");
const videoId = process.argv[3] ?? (basename(videoPath, extname(videoPath)) || "video");
const force = process.argv[4] === "force";
if (!existsSync(videoPath)) {
  console.error(`找不到视频: ${videoPath}（可先运行 node examples/make-demo-video.mjs）`);
  process.exit(1);
}
console.log(`视频: ${videoPath} | videoId: ${videoId}${force ? " | 强制重跑" : ""}`);

const { llm, vision, asr, perception } = await loadConfiguredProviders();
console.log("Providers:", llm && vision && asr ? "LLM / VLM / ASR 全部加载" : "部分加载！");
console.log("提示: 想强制重新处理，在命令末尾加 force");

const commandRunner = new NodeCommandRunner();
const frameExtractor = new FfmpegFrameExtractor(commandRunner);
const ingest = new MediaIngestService([
  new LocalVideoIngestor(asr ? { asrProvider: asr } : {}),
]);
const visionStats = { imageCalls: 0, clipCalls: 0 };
const monitoredVision = vision
  ? {
      analyzeImages: async (request) => {
        visionStats.imageCalls += 1;
        return vision.analyzeImages(request);
      },
      ...(vision.analyzeClip
        ? { analyzeClip: async (request) => {
            visionStats.clipCalls += 1;
            return vision.analyzeClip(request);
          } }
        : {}),
    }
  : undefined;
const storage = new VideoStorage("data");
const system = new VideoUnderstandingSystem({
  ingest,
  frameSampler: new SparseFrameSampler(frameExtractor),
  frameExtractor,
  storage,
  llm,
  ...(monitoredVision ? { vision: monitoredVision } : {}),
  perception,
});

const source = { kind: "local", uri: videoPath, videoId };

// 1) Base understanding + bounded selective perception
let t0 = performance.now();
const understanding = await system.process(source, {
  instruction: "关注画面中的文字标题、图表和排名变化",
  force,
});
console.log(`\n[1] process 完成，耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
const [metadata, transcript, perceptionState] = await Promise.all([
  storage.readMetadata(videoId), storage.readTranscript(videoId), storage.readPerceptionState(videoId),
]);
console.log("  videoId:", videoId, "| duration:", metadata?.duration ?? "unknown", "s");
console.log("  transcript:", transcript?.source ?? (transcript?.cues?.length ? "available" : "empty"));
console.log("  base understanding generated:", understanding.status === "base" || understanding.status === "enriched");
console.log("  visual profile:", perceptionState?.visualProfile ?? "unavailable");
console.log("  perception requests generated/executed:", perceptionState?.stats.generatedRequests ?? 0, "/", perceptionState?.stats.executedRequests ?? 0);
console.log("  frames / VLM batches / cache hits:", perceptionState?.stats.framesExtracted ?? 0, "/", perceptionState?.stats.visionBatches ?? 0, "/", perceptionState?.stats.cacheHits ?? 0);
console.log("  VisionProvider calls (images/clips):", visionStats.imageCalls, "/", visionStats.clipCalls);
console.log("  understanding path:", storage.getArtifactPath(videoId, "understanding"));
console.log("  overview:", understanding.overview.slice(0, 300));

// 2) 总结（只基于持久化 VideoUnderstanding）
t0 = performance.now();
const summary = await system.summarize(videoId, "用三条要点概括视频内容");
console.log(`\n[2] summarize 完成，耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
console.log(" ", summary.replace(/\n/g, "\n  "));

// 3) 问答（证据不足时按有限视觉计划局部回看）
t0 = performance.now();
const qa = await system.ask(videoId, "视频讲了什么？排名最后发生了什么变化？");
console.log(`\n[3] ask 完成，耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
console.log("  reliable:", qa.reliable, "| usedPerception:", qa.usedPerception, "| evidence:", qa.evidence.length, "条");
console.log("  answer:", qa.answer.slice(0, 500).replace(/\n/g, "\n  "));

// 4) 第二次 ask 验证缓存复用（不应重新预处理）
t0 = performance.now();
const cached = await system.ask(videoId, "第一部分介绍了什么？");
console.log(`\n[4] 缓存命中后的 ask 耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
console.log("  answer:", cached.answer.slice(0, 200).replace(/\n/g, "\n  "));
