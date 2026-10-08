import { describe, expect, it } from "vitest";

import { Timeline } from "./timeline.js";

describe("Timeline", () => {
  it("keeps items ordered and returns items that overlap a range", () => {
    const timeline = new Timeline("video-1", 60);
    timeline
      .add({
        id: "subtitle-late",
        type: "subtitle",
        start: 20,
        end: 25,
        content: "The conclusion is introduced.",
      })
      .add({
        id: "description",
        type: "description",
        start: 0,
        content: "An overview supplied by the uploader.",
      })
      .add({
        id: "subtitle-early",
        type: "subtitle",
        start: 8,
        end: 12,
        content: "The speaker introduces the argument.",
      });

    expect(timeline.items.map((item) => item.id)).toEqual([
      "description",
      "subtitle-early",
      "subtitle-late",
    ]);
    expect(timeline.range(10, 20).map((item) => item.id)).toEqual([
      "subtitle-early",
      "subtitle-late",
    ]);
  });

  it("searches text deterministically, including punctuation-separated Chinese text", () => {
    const timeline = new Timeline("video-1", 60, [
      {
        id: "subtitle-1",
        type: "subtitle",
        start: 4,
        end: 6,
        content: "The ranking changes after a close finish.",
      },
      {
        id: "ocr-1",
        type: "ocr",
        start: 18,
        content: "曲线 / 排名发生关键变化",
      },
      {
        id: "danmaku-1",
        type: "danmaku",
        start: 20,
        content: "排名变化太快了",
      },
    ]);

    expect(timeline.searchText("ranking changes").map((item) => item.id)).toEqual(["subtitle-1"]);
    expect(timeline.searchText("曲线排名").map((item) => item.id)).toEqual(["ocr-1"]);
    expect(timeline.searchText("排名", { types: ["ocr"] }).map((item) => item.id)).toEqual(["ocr-1"]);
  });

  it("does not expose mutable internal item state", () => {
    const item = {
      id: "subtitle-1",
      type: "subtitle" as const,
      start: 1,
      end: 2,
      content: "Original text",
      metadata: { speaker: "A" },
    };
    const timeline = new Timeline("video-1", 10).add(item);

    item.content = "Changed outside";
    item.metadata.speaker = "B";
    const returned = timeline.items;
    returned[0]!.content = "Changed through result";
    (returned[0]!.metadata as Record<string, unknown>).speaker = "C";

    expect(timeline.items[0]).toMatchObject({
      content: "Original text",
      metadata: { speaker: "A" },
    });
  });

  it("rejects malformed intervals and duplicate ids", () => {
    const timeline = new Timeline("video-1", 10);
    timeline.add({ id: "one", type: "frame", start: 1 });

    expect(() => timeline.add({ id: "one", type: "frame", start: 2 })).toThrow(/already exists/);
    expect(() => timeline.add({ id: "bad", type: "frame", start: 3, end: 2 })).toThrow(
      /greater than or equal/,
    );
    expect(() => timeline.range(5, 4)).toThrow(/range end/);
    expect(timeline.searchText("   ")).toEqual([]);
  });
});
