# SeeIt

一个保持简单、可扩展的多模态视频理解系统。它遵循：

> **Understand with the cheapest sufficient modality. Global understanding first, active perception when needed.**

先用低成本文字证据建立并持久化 `VideoUnderstanding`；视觉是按需证据，而不是所有视频的必经预处理。总结和大多数问答只读取该理解。QA 的第一次模型调用同时回答问题或给出有限视觉计划；证据不足时执行局部回看，再综合回答。默认流程不运行 ReAct 行动循环。

它不是逐帧 VLM 调用器，也不是只根据字幕生成总结的系统。

## 架构

```text
MediaSource
  -> ingest (video / audio / subtitle / description / danmaku / duration)
  -> cheap evidence + textual timeline + optional scene-change profile
  -> Base Understanding (no VLM required)
  -> bounded PerceptionPlanner
  -> zero or more selective frame / frames / clip observations
  -> incremental enrichment -> persistent VideoUnderstanding
  -> summarize / ask
                     -> answer or finite perception plan
                     -> local observations -> grounded answer
                     -> one extra perception round only for a remaining evidence gap
```

`PerceptionPlanner` 会 clamp、去重/合并高重叠请求，并以 `maxRequests`、`maxFrames` 和可选 `maxVisualSeconds` 限制处理工作。完整字幕的静态访谈可在处理阶段执行 **0 次 VisionProvider 调用**；无有效字幕/ASR 时才会受预算控制地回退到代表性视觉采样。`SparseFrameSampler` 仍被复用，但只作为选择性感知的实现细节。

> Some videos may require zero vision-model calls during processing.

原始字幕、简介、弹幕、帧、视觉观察和 OCR 均作为可持久化证据保留；`VideoUnderstanding` 是可增量增强的派生知识。QA 的 `getFrame`/`getFrames` 结果会回写 `perception-state.json`、timeline 和理解的视觉字段，因此后续问题和总结可以复用新证据。

普通问答使用 1 次 LLM；一次视觉取证后的问答使用 2 次 LLM；确有新的可定位缺口时最多再补充一轮，合计最多 3 次 LLM。两轮共享 3 个视觉请求、12 帧、30 秒视觉范围的预算，重复请求不会升级重试。`QAResult.usedPerception` 表示是否回看；兼容字段 `usedReact` 始终为 `false`。`ReactAgent` 与 `system.getReactAgent()` 仍供显式调用，默认 QA 不使用它们。

处理阶段默认跳过全视频 scene detection；需要时通过 `process(source, { includeSceneChanges: true })` 显式启用。未扫描的 profile 标记 `sceneDetectionPerformed: false`，不能据此认定画面静态。相邻帧按不超过 12 帧、30 秒的窗口共用一个 ffmpeg 解码进程，离散时间点仍分开 seek。基础理解在视觉阶段前落盘，视觉模型失败时仍可使用文字理解。

## 运行要求

- Node.js `>= 20`
- 本地视频的自动探测、抽帧、scene change 和 clip 提取需要 `ffmpeg`（`>= 6.0`）与 `ffprobe` 可从 `PATH` 调用。
- 真实模型由应用注入 `LLMProvider`、`VisionProvider` 和可选的 `ASRProvider`。仓库提供通用 OpenAI-compatible HTTP 协议适配器，但不包含、也不承诺任何特定供应商的 adapter。

安装依赖后：

```bash
npm install
npm run typecheck
npm test
npm run build
```

## CLI（本地媒体）

构建后可直接通过已发布的 `seeit` 命令（或仓库内的 `node dist/cli/bin.js`）处理本地媒体。CLI 只注册本地媒体 ingest；远程/Bilibili 来源仍需由应用显式注入 resolver，不会在命令行中自动发起网络抓取。

直接运行 `seeit` 会进入轻量交互 shell；它不是全屏 TUI，适合终端、管道与脚本化测试。`/videos`、`/open` 和 `/status` 只读取持久化存储，不会加载 provider。首次 `/process`、`/summary` 或普通问题才懒加载并复用 runtime。

```text
$ seeit interactive --data-dir ./data
SeeIt interactive shell
Data dir: .../data
Current video: none
Type /help for commands. Process a local video with /process.
seeit> /videos
- demo | Demo video | 24.000s | understanding: base, 3 sections | perception: missing
seeit> /open demo
Current video: demo
seeit (demo)> 这段视频的核心观点是什么？
...grounded answer with reliability and evidence...
seeit (demo)> /exit
Goodbye.
```

交互命令包括 `/videos`、`/open <videoId>`（`/switch` 同义）、`/process`、`/summary [instruction]`、`/status`、`/help`、`/clear` 和 `/exit`。`/process` 会依次询问本地路径、可选 ID、可选 instruction 以及是否禁用本次 process perception；成功后自动选中该视频。也可显式运行 `seeit interactive --config ./seeit.config.json --data-dir ./data`。

```bash
npm run build
node dist/cli/bin.js help

# 构建可增量增强的理解；--video-id 让后续命令能稳定命中同一持久化目录
node dist/cli/bin.js process ./media/demo.mp4 --video-id demo --data-dir ./data

# 这两个命令只读取 data/{videoId} 下的持久化产物，不会重新打开原始视频。
node dist/cli/bin.js status demo --data-dir ./data
node dist/cli/bin.js status demo --data-dir ./data --json
node dist/cli/bin.js summarize demo --data-dir ./data

# 问答先读取已持久化理解与证据；不足时按有限计划执行局部 Active Perception。
node dist/cli/bin.js ask demo "作者最后买的是什么？" --data-dir ./data
```

`process` 支持 `--force`、`--instruction <text>`、`--no-perception`、`--max-requests <n>`、`--max-frames <n>` 与 `--max-visual-seconds <n>`。其中 `--no-perception` 只禁用本次处理阶段的视觉请求，不会关闭未来 QA 所需的局部回看。`--config <path>` 可覆盖 provider 配置，`--data-dir <path>` 默认为 `data`，`--json` 会在 stdout 输出一个稳定 JSON 文档；诊断和 JSON 错误都输出到 stderr。`status` 是纯存储命令，只接受 `--data-dir` 与 `--json`，不会加载 provider 配置或运行时。稳定退出码：成功/帮助为 `0`，运行时错误为 `1`，用法错误为 `2`。

处理并不保证会调用视觉模型：例如完整字幕、静态访谈在 Planner 判断文字证据足够时可为 **0 VLM calls**。没有有效文本证据时，系统才在预算内回退到代表性视觉采样。

## Provider 配置

根目录的 `seeit.config.json` 是可直接修改的无密钥示例。默认从当前工作目录读取它，也可以用环境变量选择其他文件：

```bash
set SEEIT_CONFIG=C:\path\to\seeit.config.local.json
```

在 macOS/Linux 中使用 `export SEEIT_CONFIG=/path/to/seeit.config.local.json`。

配置格式为：

```json
{
  "schemaVersion": 1,
  "connections": {
    "local": {
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "apiKeyEnv": "MY_MODEL_API_KEY",
      "timeoutMs": 120000,
      "jsonMode": true
    }
  },
  "models": {
    "llm": { "connection": "local", "model": "chat-model" },
    "vision": { "connection": "local", "model": "vision-model" },
    "asr": { "connection": "local", "model": "asr-model" }
  },
  "perception": {
    "enabled": true,
    "maxRequests": 8,
    "maxFrames": 48,
    "maxVisualSeconds": 120,
    "maxRefinements": 2
  }
}
```

`models.llm` 必需，`vision` 和 `asr` 可删除；三个能力也可以引用不同的 connection 和 model。`perception` 完全可选，旧的 schemaVersion 1 配置会使用安全默认值。建议只配置 `apiKeyEnv` 并把密钥放在环境变量中。显式 `apiKey` 也受支持，但不建议提交到版本库；错误信息不会回显配置的密钥。`headers` 只接受字符串值。

OpenAI-compatible 实现使用 Node 20 原生 `fetch`：LLM 和批量图片视觉分析调用 `{baseUrl}/chat/completions`，ASR 调用 `{baseUrl}/audio/transcriptions`。`jsonMode: true` 会在需要 JSON 时发送 `response_format: {"type":"json_object"}`；不兼容该字段的服务（如硅基流动的 Qwen3-VL-Thinking）可设为 `false`。ASR 优先解析带 `segments` 的分段响应；若服务只返回整段文本（如硅基流动的 Qwen3-ASR），会用请求的 `duration`/`end` 合成单条 cue。当前没有伪造的 clip 分析实现，`VisionProvider.analyzeClip` 保持未提供状态。

## 持久化数据

将 `VideoStorage` 的根目录设为 `data` 时，单个视频的默认布局为：

```text
data/
  {videoId}/
    metadata.json
    timeline.json
    understanding.json
    transcript.json
    danmaku.json
    perception-state.json
    frames/
    cache/
```

昂贵操作会优先复用缓存：ASR 使用可注入的缓存（未注入时本地 ingest 使用文件缓存）；已抽取帧、选择性采样 manifest、PerceptionRequest 视觉结果与 QA 工具结果都会复用。时间会量化到 100ms 以合并 `getFrame(100.0)` 与 `getFrame(100.02)` 一类等价请求。`force: true` 重建派生理解，但保留原始证据和已有有效视觉证据。

## 最小 TypeScript 组装示例

下面通过本地 JSON 创建 provider；业务代码仍只依赖接口。若本地视频有可用原字幕，`asr` 可以从配置删除，系统会优先使用原字幕而不调用 ASR。

```ts
import {
  FfmpegFrameExtractor,
  LocalVideoIngestor,
  loadConfiguredProviders,
  MediaIngestService,
  NodeCommandRunner,
  SparseFrameSampler,
  VideoStorage,
  VideoUnderstandingSystem,
} from "seeit";

const { llm, vision, asr, perception } = await loadConfiguredProviders();

const commandRunner = new NodeCommandRunner();
const frameExtractor = new FfmpegFrameExtractor(commandRunner);
const ingest = new MediaIngestService([
  new LocalVideoIngestor(asr ? { asrProvider: asr } : {}),
]);

const system = new VideoUnderstandingSystem({
  ingest,
  frameSampler: new SparseFrameSampler(frameExtractor),
  frameExtractor,
  storage: new VideoStorage("data"),
  llm,
  ...(vision ? { vision } : {}),
  perception,
});

const source = {
  kind: "local" as const,
  uri: "./media/demo.mp4",
  videoId: "demo-001", // 推荐提供稳定 ID，便于直接命中持久化理解
};

// `process` 与 `understand` 等价。它先构建 cheap/base understanding；仅在
// Planner 判断需要时才局部抽帧并调用 VLM，某些视频会是 0 次 VLM。
const understanding = await system.process(source, {
  instruction: "重点关注曲线和排名变化",
});

// 默认只基于持久化 VideoUnderstanding；instruction 覆盖默认总结格式。
const summary = await system.summarize(
  understanding.videoId,
  "用三条要点说明排名变化",
);

// 默认从 VideoUnderstanding + 相关 Timeline 文本回答。
// 第一次 LLM 同时判断证据并规划 getFrame/getFrames；必要时补充一轮取证。
const answer = await system.ask(understanding.videoId, "3:20 发生了什么？");

// 明确要求重新生成派生理解（原始证据仍保留）。
await system.process(source, {
  force: true,
  instruction: "重点关注视觉上的关键变化",
});
```

`SparseFrameSampler` 本身只提取和去重帧，不调用 VLM；每个选择性请求的图片仍严格按每批最多 24 帧发送。Base prompt 被要求不能猜测未提供的画面，并将必要的视觉缺口表述为候选 `PerceptionRequest`。Planner 结合这一候选、文本中的局部视觉引用和可选 scene-change profile 作出有限计划；弱文本判断同时考虑字符量与时间覆盖率，局部明确缺口优先于广泛回退采样。

## 本地媒体输入

`LocalVideoSource` / `LocalVideoIngestor` 支持：

- 视频时长、流和基础 metadata（通过 `ffprobe`）
- 标题和简介：显式选项、`MediaSource.metadata`、`{name}.metadata.json`、媒体 tags、`{name}.description.txt`
- 原字幕：显式路径或同名 `.srt`、`.vtt`、`.ass`、`.ssa`、`.subtitle.json`
- 无字幕时的 ASR 回退
- 同名 `.danmaku.json` / `.danmaku.xml` 弹幕 sidecar

所有时间均以视频起点起算的秒数表示。

## Bilibili 边界

`BilibiliVideoSource` 和 `BilibiliVideoIngestor` 只是接口预留。要使用它，应用必须注入 `BilibiliResolver` 来取得视频、音频、字幕、标题、简介、弹幕和时长。项目不会自动发起网络请求，也没有内置 Bilibili 凭证或抓取实现。

## 开发验证

```bash
npm run typecheck
npm test
npm run build
node -e "import('./dist/index.js').then(() => console.log('ESM import OK'))"
```

`examples/` 提供三个可直接运行的验证脚本（需要先 `npm run build`）：

```bash
node examples/smoke-providers.mjs  # 无需 ffmpeg：真实调用 LLM/VLM/ASR 三个模型
node examples/make-demo-video.mjs  # 生成 24 秒合成测试视频（需要 ffmpeg + Windows TTS）
node examples/demo.mjs             # 完整管线：ingest → base → selective perception → 总结 → 问答
node examples/review-video.mjs 1.mp4 # 用当前配置读取真实视频并保存原始总结和用量，不生成测试视频
```

`review-video.mjs` 使用独立的 `benchmarks/1-mp4-review/data`，保留之前失败尝试的用量。本次评审不发送 `max_tokens`，DeepSeek 使用 `reasoning_effort: low`；这些覆盖仅作用于评审脚本，不修改 provider 配置。质量由用户判断，脚本不自行打分。
