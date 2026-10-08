import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import type { DanmakuEntry } from "../core/types.js";

export async function readDanmakuFile(path: string): Promise<DanmakuEntry[]> {
  return parseDanmaku(await readFile(path, "utf8"), extname(path));
}

/** Supports a compact JSON sidecar and Bilibili's common XML export shape. */
export function parseDanmaku(source: string, extension = ".json"): DanmakuEntry[] {
  return extension.toLowerCase() === ".xml"
    ? parseBilibiliXml(source)
    : parseDanmakuJson(source);
}

function parseDanmakuJson(source: string): DanmakuEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return [];
  }
  const entries = findEntries(raw);
  const result: DanmakuEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const start = value.progress !== undefined
      ? millisecondsToSeconds(value.progress)
      : toSeconds(value.start ?? value.time ?? value.timestamp);
    const content = String(value.content ?? value.text ?? value.msg ?? "").trim();
    if (start === undefined || !content) continue;
    const end = toSeconds(value.end);
    result.push({
      id: stringValue(value.id ?? value.cid),
      start,
      ...(end === undefined ? {} : { end }),
      content,
      metadata: { source: "sidecar" },
    });
  }
  return result.sort((left, right) => left.start - right.start);
}

function findEntries(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const value = raw as Record<string, unknown>;
  for (const key of ["danmaku", "items", "data", "elems", "replies"]) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
    if (value[key] && typeof value[key] === "object") {
      const nested = findEntries(value[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function parseBilibiliXml(source: string): DanmakuEntry[] {
  const entries: DanmakuEntry[] = [];
  const pattern = /<d\s+([^>]*)>([\s\S]*?)<\/d>/gi;
  for (const match of source.matchAll(pattern)) {
    const attributes = match[1];
    const p = attributes.match(/\bp\s*=\s*(["'])(.*?)\1/i)?.[2];
    const start = p ? Number.parseFloat(p.split(",")[0]) : Number.NaN;
    const content = decodeXml(match[2]).replace(/\s+/g, " ").trim();
    if (!Number.isFinite(start) || start < 0 || !content) continue;
    entries.push({
      id: attributes.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1],
      start,
      content,
      metadata: { source: "bilibili-xml" },
    });
  }
  return entries.sort((left, right) => left.start - right.start);
}

function toSeconds(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return numeric;
}

function millisecondsToSeconds(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? numeric / 1_000 : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : typeof value === "number" ? String(value) : undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}
