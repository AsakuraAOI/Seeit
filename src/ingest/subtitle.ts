import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import type { SubtitleCue } from "../core/types.js";

export async function readSubtitleFile(path: string): Promise<SubtitleCue[]> {
  return parseSubtitleText(await readFile(path, "utf8"), extname(path));
}

/** Parses the common, text-based original subtitle formats without a vendor SDK. */
export function parseSubtitleText(
  source: string,
  extension = ".srt",
): SubtitleCue[] {
  const normalizedExtension = extension.toLowerCase();
  if (normalizedExtension === ".ass" || normalizedExtension === ".ssa") {
    return parseAss(source);
  }
  if (normalizedExtension === ".json") return parseJsonSubtitle(source);
  return parseSrtOrVtt(source);
}

function parseSrtOrVtt(source: string): SubtitleCue[] {
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const blocks = text.split(/\n\s*\n/g);
  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0 || /^WEBVTT(?:\s|$)/i.test(lines[0])) continue;
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/i.test(lines[0])) continue;

    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].split("-->");
    const start = parseTimestamp(timing[0]);
    const end = parseTimestamp(timing[1]?.trim().split(/\s+/)[0] ?? "");
    const content = cleanSubtitleText(lines.slice(timingIndex + 1).join(" "));
    if (start === undefined || end === undefined || end < start || !content) continue;
    cues.push({ id: `subtitle-${cues.length}`, start, end, content });
  }
  return cues;
}

function parseAss(source: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let inEvents = false;
  for (const rawLine of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^\[events\]$/i.test(line)) {
      inEvents = true;
      continue;
    }
    if (/^\[.+\]$/i.test(line)) {
      inEvents = false;
      continue;
    }
    if (!inEvents || !/^dialogue\s*:/i.test(line)) continue;

    // ASS has nine comma-delimited fields before text. Text itself may contain commas.
    const fields = line.replace(/^dialogue\s*:\s*/i, "").split(",");
    if (fields.length < 10) continue;
    const start = parseTimestamp(fields[1]);
    const end = parseTimestamp(fields[2]);
    const content = cleanSubtitleText(fields.slice(9).join(",").replace(/\\N|\\n/g, " "));
    if (start === undefined || end === undefined || end < start || !content) continue;
    cues.push({ id: `subtitle-${cues.length}`, start, end, content });
  }
  return cues;
}

function parseJsonSubtitle(source: string): SubtitleCue[] {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return [];
  }
  const entries = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { cues?: unknown }).cues)
      ? (raw as { cues: unknown[] }).cues
      : [];
  const cues: SubtitleCue[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const start = numeric(value.start ?? value.from ?? value.begin);
    const end = numeric(value.end ?? value.to ?? value.finish);
    const content = cleanSubtitleText(String(value.content ?? value.text ?? value.body ?? ""));
    if (start === undefined || end === undefined || end < start || !content) continue;
    cues.push({ id: stringOrUndefined(value.id) ?? `subtitle-${cues.length}`, start, end, content });
  }
  return cues;
}

export function parseTimestamp(value: string): number | undefined {
  const match = value.trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?$/);
  if (!match) return undefined;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fractionText = match[4] ?? "0";
  const fraction = Number(fractionText.padEnd(3, "0")) / 1000;
  if (minutes >= 60 || seconds >= 60) return undefined;
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

function cleanSubtitleText(value: string): string {
  return decodeEntities(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function numeric(value: unknown): number | undefined {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
