// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computePromptBudget, HotwordEditor } from "./HotwordEditor";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("HotwordEditor", () => {
  it("adds on Enter, deduplicates, and saves removals", () => {
    const onSave = vi.fn();
    render(<HotwordEditor background="会议背景" onSave={onSave} />);
    const entry = screen.getByRole("textbox", { name: "添加热词" });

    for (const value of ["十五五规划", " 十五五规划 "]) {
      fireEvent.change(entry, { target: { value } });
      fireEvent.keyDown(entry, { key: "Enter" });
    }

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenLastCalledWith(["十五五规划"], "会议背景");
    fireEvent.click(screen.getByRole("button", { name: "删除热词 十五五规划" }));
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(onSave).toHaveBeenLastCalledWith([], "会议背景");
  });

  it("splits mixed clipboard delimiters and saves one deduplicated list", () => {
    const onSave = vi.fn();
    render(<HotwordEditor hotwords={["甲"]} onSave={onSave} />);
    fireEvent.paste(screen.getByRole("textbox", { name: "添加热词" }), {
      clipboardData: { getData: () => "甲,乙，丙、丁\r\n 戊 ，乙" },
    });

    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(onSave).toHaveBeenCalledExactlyOnceWith(["甲", "乙", "丙", "丁", "戊"], "");
  });

  it("filters the visible list and shows the matching and total counts", () => {
    const onSave = vi.fn();
    render(<HotwordEditor hotwords={["国务院", "新闻办"]} onSave={onSave} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "新闻" } });

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText("国务院")).toBeNull();
    expect(screen.getByText("新闻办")).toBeTruthy();
    expect(screen.getByText("1 / 2 条")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("counts normalized prompt characters and allocates to hotwords first", () => {
    const hotwords = ["甲".repeat(244), "乙"];
    const background = " 丙\n丁  戊 ";
    render(<HotwordEditor hotwords={hotwords} background={background} onSave={vi.fn()} />);

    expect(screen.getByText("254 / 250")).toBeTruthy();
    expect(screen.getByText("背景词将被截断")).toBeTruthy();
    expect(computePromptBudget(hotwords, background)).toEqual({
      totalChars: 254,
      backgroundBudget: 1,
      includedBackground: "丙",
      backgroundTruncated: true,
    });
    expect(computePromptBudget(["甲乙"], "丙", 2).includedBackground).toBe("");
  });

  it("shows which segment will use the changes", () => {
    const { rerender } = render(<HotwordEditor appliesFromSegment={null} onSave={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe("");
    rerender(<HotwordEditor appliesFromSegment={3} onSave={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe("将从第 3 段起生效");
  });

  it("saves background edits after 400ms or on blur without saving twice", () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    render(<HotwordEditor hotwords={["甲"]} onSave={onSave} />);
    const field = screen.getByRole("textbox", { name: "背景词" });

    fireEvent.change(field, { target: { value: "乙" } });
    act(() => vi.advanceTimersByTime(399));
    expect(onSave).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onSave).toHaveBeenLastCalledWith(["甲"], "乙");

    fireEvent.change(field, { target: { value: "丙" } });
    fireEvent.blur(field);
    expect(onSave).toHaveBeenLastCalledWith(["甲"], "丙");
    act(() => vi.advanceTimersByTime(400));
    expect(onSave).toHaveBeenCalledTimes(2);
  });
});
