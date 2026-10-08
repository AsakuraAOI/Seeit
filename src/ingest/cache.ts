import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { IngestCache } from "./types.js";

/** In-memory cache for tests and short-lived processes. Durable storage can implement IngestCache. */
export class MemoryIngestCache implements IngestCache {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  clear(): void {
    this.values.clear();
  }
}

/**
 * Minimal durable cache for source-local expensive work such as ASR. It uses
 * an opaque digest for the filename so arbitrary source/cache keys cannot
 * escape the configured cache directory.
 */
export class FileIngestCache implements IngestCache {
  public constructor(private readonly directory: string) {}

  async get<T>(key: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.pathFor(key), "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await mkdir(resolve(this.directory), { recursive: true });
    await writeFile(this.pathFor(key), JSON.stringify(value), "utf8");
  }

  pathFor(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return resolve(this.directory, `${digest}.json`);
  }
}
