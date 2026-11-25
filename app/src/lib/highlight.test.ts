import { describe, expect, it } from "vitest";
import { splitByHotwords } from "./highlight";

describe("splitByHotwords", () => {
  it("prefers the longest matching hotword and accepts duplicates", () => {
    expect(splitByHotwords("十五五规划和十五五", ["十五五", "十五五规划", "十五五"])).toEqual([
      { text: "十五五规划", hit: true },
      { text: "和", hit: false },
      { text: "十五五", hit: true },
    ]);
  });

  it("matches regex metacharacters literally", () => {
    const literal = ".*+?^${}()|[]\\";
    expect(splitByHotwords(`C C++ ${literal} a.b axb`, ["C++", literal, "a.b"])).toEqual([
      { text: "C ", hit: false },
      { text: "C++", hit: true },
      { text: " ", hit: false },
      { text: literal, hit: true },
      { text: " ", hit: false },
      { text: "a.b", hit: true },
      { text: " axb", hit: false },
    ]);
  });

  it("preserves alternating and adjacent matches in text order", () => {
    expect(splitByHotwords("先甲、乙，再甲乙。", ["乙", "甲"])).toEqual([
      { text: "先", hit: false },
      { text: "甲", hit: true },
      { text: "、", hit: false },
      { text: "乙", hit: true },
      { text: "，再", hit: false },
      { text: "甲", hit: true },
      { text: "乙", hit: true },
      { text: "。", hit: false },
    ]);
  });

  it("matches a hotword across merged deltas", () => {
    const firstDelta = "推进新质";
    const hotwords = ["新质生产力"];
    expect(splitByHotwords(firstDelta, hotwords)).toEqual([{ text: firstDelta, hit: false }]);
    expect(splitByHotwords(firstDelta + "生产力", hotwords)).toEqual([
      { text: "推进", hit: false },
      { text: "新质生产力", hit: true },
    ]);
  });

  it("returns a single non-hit for empty text, empty hotwords or no match", () => {
    expect(splitByHotwords("", ["热词"])).toEqual([{ text: "", hit: false }]);
    expect(splitByHotwords(" 全文 ", [])).toEqual([{ text: " 全文 ", hit: false }]);
    expect(splitByHotwords(" 全文 ", ["", " ", "热词"])).toEqual([{ text: " 全文 ", hit: false }]);
  });
});
