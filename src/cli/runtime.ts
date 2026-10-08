import { isAbsolute, resolve } from "node:path";

import { MediaIngestService } from "../ingest/types.js";
import { LocalVideoIngestor } from "../ingest/local-video-source.js";
import { NodeCommandRunner } from "../ingest/command-runner.js";
import { loadConfiguredProviders } from "../providers/config.js";
import { VideoStorage } from "../storage/video-storage.js";
import { VideoUnderstandingSystem } from "../system/video-understanding-system.js";
import { FfmpegFrameExtractor } from "../vision/frame-extractor.js";
import { SparseFrameSampler } from "../vision/sparse-frame-sampler.js";
import type { CliRuntime, CliRuntimeOptions, CliStorageFactory } from "./types.js";

/** Creates storage without reading provider configuration; used by `status`. */
export const createCliStorage: CliStorageFactory = (dataDir, cwd) =>
  new VideoStorage(resolvePath(cwd, dataDir));

/**
 * Compose the project's existing local-media pipeline for the command line.
 * No network source adapter is registered deliberately: this CLI accepts local
 * paths only and keeps Bilibili/other remote resolution an explicit injection.
 */
export async function createCliRuntime(options: CliRuntimeOptions): Promise<CliRuntime> {
  // Keep the concrete type locally because VideoUnderstandingSystem needs its
  // write/cache APIs; the public CLI runtime exposes only read/status APIs.
  const storage = new VideoStorage(resolvePath(options.cwd, options.dataDir));
  const configPath = resolveConfigPath(options.configPath, options.cwd, options.env);
  const providers = await loadConfiguredProviders(configPath, { env: options.env });
  const commandRunner = new NodeCommandRunner();
  const frameExtractor = new FfmpegFrameExtractor(commandRunner);
  const ingest = new MediaIngestService([
    new LocalVideoIngestor({
      ...(providers.asr ? { asrProvider: providers.asr } : {}),
      commandRunner,
      cacheDirForVideo: (videoId) => storage.getCacheDir(videoId),
    }),
  ]);
  return {
    storage,
    system: new VideoUnderstandingSystem({
      ingest,
      frameSampler: new SparseFrameSampler(frameExtractor),
      frameExtractor,
      storage,
      llm: providers.llm,
      ...(providers.vision ? { vision: providers.vision } : {}),
      perception: providers.perception,
      logger: options.logger,
    }),
  };
}

function resolveConfigPath(
  explicitPath: string | undefined,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const selected = explicitPath?.trim() || env.SEEIT_CONFIG?.trim() || "seeit.config.json";
  return resolvePath(cwd, selected);
}

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}
