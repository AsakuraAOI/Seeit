// 快速烟雾测试：无需 ffmpeg，直接验证三个模型的真实 API 调用。
// 用法: node examples/smoke-providers.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { deflateSync } from "node:zlib";

import { loadConfiguredProviders } from "../dist/index.js";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function makePng(width, height, r, g, b) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (1 + width * 3) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const { llm, vision, asr } = await loadConfiguredProviders();

// 1) LLM（DeepSeek deepseek-v4-flash；思考模型，maxTokens 要留足推理预算）
const llmRes = await llm.generate({
  prompt: '用一句话总结：SeeIt 是一个先全局理解、证据不足再局部回看的视频理解系统。返回 JSON {"summary":"..."}',
  responseFormat: "json",
  maxTokens: 2000,
});
console.log("1) LLM OK:", JSON.stringify(llmRes.value));

// 2) VLM（硅基流动 Qwen3-VL-32B-Thinking）— 64x64 红色 PNG
const visionRes = await vision.analyzeImages({
  images: [{ data: new Uint8Array(makePng(64, 64, 200, 30, 30)), mimeType: "image/png", time: 0 }],
  start: 0,
  end: 5,
});
console.log("2) VLM OK:", visionRes.summary.slice(0, 100), "| contentType:", visionRes.contentTypeHints ?? "-");

// 3) ASR（硅基流动 Qwen3-ASR-1.7B）— Windows 系统语音合成一句英文
const wavPath = "data/_smoke_speech.wav";
mkdirSync("data", { recursive: true });
execFileSync("powershell", ["-NoProfile", "-Command", [
  "Add-Type -AssemblyName System.Speech;",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
  `$s.SetOutputToWaveFile('${wavPath.replaceAll("/", "\\")}');`,
  "$s.Speak('Hello world, this is the see it speech recognition test.');",
  "$s.Dispose()",
].join(" ")], { stdio: "ignore" });
const asrRes = await asr.transcribe({ audioRef: wavPath, duration: 8 });
rmSync(wavPath, { force: true });
console.log("3) ASR OK:", JSON.stringify(asrRes.cues), "| language:", asrRes.language ?? "-");

console.log("\n三个模型全部通过 ✅");
