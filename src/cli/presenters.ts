import type { Transcript } from "../core/types.js";
import type { PerceptionState } from "../perception/types.js";
import type { CliRuntime, CliStorage, ProcessCliCommand } from "./types.js";

export async function buildProcessResult(
  command: ProcessCliCommand,
  runtime: CliRuntime,
): Promise<Record<string, unknown>> {
  const understanding = await runtime.system.process(
    { kind: "local", uri: command.video, ...(command.videoId ? { videoId: command.videoId } : {}) },
    {
      force: command.force,
      ...(command.instruction ? { instruction: command.instruction } : {}),
      perceptionEnabled: command.perceptionEnabled,
      perceptionBudget: {
        ...(command.maxRequests === undefined ? {} : { maxRequests: command.maxRequests }),
        ...(command.maxFrames === undefined ? {} : { maxFrames: command.maxFrames }),
        ...(command.maxVisualSeconds === undefined ? {} : { maxVisualSeconds: command.maxVisualSeconds }),
      },
    },
  );
  const [metadata, transcript, state] = await Promise.all([
    runtime.storage.readMetadata(understanding.videoId),
    runtime.storage.readTranscript<Transcript>(understanding.videoId),
    runtime.storage.readPerceptionState(understanding.videoId),
  ]);
  return {
    command: "process",
    videoId: understanding.videoId,
    duration: metadata?.duration,
    transcript: transcriptInfo(transcript),
    understanding: {
      status: understanding.status ?? "base",
      overview: understanding.overview,
      sectionCount: understanding.sections.length,
      path: runtime.storage.getArtifactPath(understanding.videoId, "understanding"),
    },
    visualProfile: state?.visualProfile
      ? { sceneChangeCount: state.visualProfile.sceneChangeCount, sceneChangeRate: state.visualProfile.sceneChangeRate }
      : undefined,
    perception: perceptionStats(state),
  };
}

export async function buildStatusResult(videoId: string, storage: CliStorage): Promise<Record<string, unknown>> {
  const [metadata, transcript, timeline, understanding, perception] = await Promise.all([
    storage.readMetadata(videoId),
    storage.readTranscript<Transcript>(videoId),
    storage.readTimeline(videoId),
    storage.readUnderstanding(videoId),
    storage.readPerceptionState(videoId),
  ]);
  if (!metadata) throw new Error(`No persisted video artifacts found for videoId: ${videoId}.`);
  return {
    command: "status",
    videoId,
    dataDir: storage.rootDir,
    duration: metadata.duration,
    source: metadata.source?.kind,
    transcript: transcriptInfo(transcript),
    understanding: understanding
      ? { exists: true, status: understanding.status ?? "base", sectionCount: understanding.sections.length }
      : { exists: false },
    timeline: timeline ? { exists: true, itemCount: timeline.items.length } : { exists: false },
    perception: perception
      ? {
          exists: true,
          visualProfile: perception.visualProfile,
          stats: perceptionStats(perception),
          observationCount: perception.observations.length,
          unresolvedCount: perception.unresolved.length,
        }
      : { exists: false },
    paths: {
      video: storage.getVideoDir(videoId),
      metadata: storage.getArtifactPath(videoId, "metadata"),
      transcript: storage.getArtifactPath(videoId, "transcript"),
      timeline: storage.getArtifactPath(videoId, "timeline"),
      understanding: storage.getArtifactPath(videoId, "understanding"),
      perception: storage.getArtifactPath(videoId, "perception"),
      frames: storage.getFramesDir(videoId),
      cache: storage.getCacheDir(videoId),
    },
  };
}

export function presentProcess(result: Record<string, unknown>): string {
  const understanding = result.understanding as { status: string; overview: string; path: string };
  const transcript = result.transcript as { status: string; source: string; cueCount: number };
  const profile = result.visualProfile as { sceneChangeCount: number; sceneChangeRate: number } | undefined;
  const perception = result.perception as Record<string, number>;
  return [
    `videoId: ${result.videoId}`,
    `duration: ${formatDuration(result.duration)}`,
    `transcript: ${transcript.status} (${transcript.source}, ${transcript.cueCount} cues)`,
    `understanding: ${understanding.status}`,
    `overview: ${understanding.overview}`,
    `visual profile: ${profile ? `scene changes=${profile.sceneChangeCount}, rate=${profile.sceneChangeRate}` : "unavailable"}`,
    `perception: generated=${perception.generatedRequests}, planned=${perception.plannedRequests}, executed=${perception.executedRequests}, deferred=${perception.deferredRequests}`,
    `vision: frames=${perception.framesExtracted}, batches=${perception.visionBatches}, cache hits=${perception.cacheHits}`,
    `understanding path: ${understanding.path}`,
  ].join("\n") + "\n";
}

export function presentStatus(result: Record<string, unknown>): string {
  const transcript = result.transcript as { status: string; source: string; cueCount: number };
  const understanding = result.understanding as { exists: boolean; status?: string; sectionCount?: number };
  const perception = result.perception as { exists: boolean; observationCount?: number; unresolvedCount?: number };
  return [
    `videoId: ${result.videoId}`,
    `data dir: ${result.dataDir}`,
    `duration: ${formatDuration(result.duration)}`,
    `transcript: ${transcript.status} (${transcript.source}, ${transcript.cueCount} cues)`,
    `understanding: ${understanding.exists ? `${understanding.status}, ${understanding.sectionCount} sections` : "missing"}`,
    `perception: ${perception.exists ? `${perception.observationCount} observations, ${perception.unresolvedCount} unresolved` : "missing"}`,
    `paths: ${JSON.stringify(result.paths)}`,
  ].join("\n") + "\n";
}

export function presentAsk(answer: Awaited<ReturnType<CliRuntime["system"]["ask"]>>): string {
  const citations = answer.evidence.length
    ? `\nEvidence:\n${answer.evidence.map((item) => `- ${item.type} ${formatRange(item.start, item.end)}${item.ref ? ` (${item.ref})` : ""}`).join("\n")}`
    : "";
  const missing = answer.missingInformation ? `\nMissing information: ${answer.missingInformation}` : "";
  return `${answer.answer}\nReliable: ${answer.reliable ? "yes" : "no"}\nUsed active perception: ${(answer.usedPerception ?? answer.usedReact) ? "yes" : "no"}${citations}${missing}\n`;
}

export function formatDuration(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(3)}s` : "unknown";
}

function perceptionStats(state: PerceptionState | undefined): Record<string, number> {
  return {
    generatedRequests: state?.stats.generatedRequests ?? 0,
    plannedRequests: state?.stats.plannedRequests ?? 0,
    executedRequests: state?.stats.executedRequests ?? 0,
    deferredRequests: state?.stats.deferredRequests ?? 0,
    framesExtracted: state?.stats.framesExtracted ?? 0,
    visionBatches: state?.stats.visionBatches ?? 0,
    cacheHits: state?.stats.cacheHits ?? 0,
  };
}

function transcriptInfo(transcript: Transcript | undefined): Record<string, unknown> {
  return { status: transcript?.cues.length ? "available" : "none", source: transcript?.source ?? "none", cueCount: transcript?.cues.length ?? 0 };
}

function formatRange(start: number | undefined, end: number | undefined): string {
  if (start === undefined) return "";
  return end === undefined ? `@${start}s` : `${start}s–${end}s`;
}
