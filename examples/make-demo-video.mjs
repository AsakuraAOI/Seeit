// 生成 24 秒合成测试视频（需要 ffmpeg/ffprobe）：
// 三段带文字标题的画面（PART 1 介绍 / PART 2 图表对比 / PART 3 排名变化）
// + 一段内容对应的英文 TTS 解说，供 ASR 转写。
// 用法: node examples/make-demo-video.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

const mediaDir = "media";
const out = `${mediaDir}/demo.mp4`;
const speech = `${mediaDir}/demo_speech.wav`;
mkdirSync(mediaDir, { recursive: true });

// 1) TTS 解说（Windows System.Speech；语音内容与三段画面文字对应）
if (!existsSync(speech)) {
  execFileSync("powershell", ["-NoProfile", "-Command", [
    "Add-Type -AssemblyName System.Speech;",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
    `$s.SetOutputToWaveFile('${speech.replaceAll("/", "\\")}');`,
    "$s.Speak('Welcome to the see it demo. Part one introduces the dataset. Part two shows the chart comparison: the blue line climbs steadily while the red bar leads. Part three, the green line takes over and the ranking changes completely. That is the end of the demo.');",
    "$s.Dispose()",
  ].join(" ")], { stdio: "ignore" });
  console.log("已生成:", speech);
}

// 2) ffmpeg 合成：testsrc2 测试画面（自带时钟读数）+ 三段 drawtext 文字 + 语音
const font = "C\\:/Windows/Fonts/arial.ttf";
const drawtext = (text, from, to) =>
  `drawtext=fontfile='${font}':text='${text}':x=(w-text_w)/2:y=40:fontsize=34:fontcolor=white:borderw=2:bordercolor=black:enable='between(t,${from},${to})'`;
const textOverlays = [
  drawtext("PART 1 - INTRODUCTION", 0, 8),
  drawtext("PART 2 - CHART COMPARISON", 8, 16),
  drawtext("PART 3 - RANKING CHANGES", 16, 24),
].join(",");

execFileSync("ffmpeg", [
  "-y",
  "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=24",
  "-i", speech,
  "-filter_complex", `[0:v]${textOverlays}[v]`,
  "-map", "[v]", "-map", "1:a",
  "-c:v", "libx264", "-pix_fmt", "yuv420p",
  "-c:a", "aac",
  "-shortest",
  out,
], { stdio: "inherit" });
console.log("已生成:", out);
