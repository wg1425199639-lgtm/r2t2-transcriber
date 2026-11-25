// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStickyScroll } from "./useStickyScroll";

afterEach(cleanup);

function setup() {
  const scrollTo = vi.fn();
  let result!: ReturnType<typeof useStickyScroll>;

  function Harness({ count, text }: { count: number; text: string }) {
    result = useStickyScroll(count, text);
    return createElement("div", { ref: result.scrollRef });
  }

  const view = render(createElement(Harness, { count: 0, text: "" }));
  const el = result.scrollRef.current!;
  Object.defineProperties(el, {
    clientHeight: { value: 200 },
    scrollHeight: { value: 500, writable: true },
    scrollTo: { value: scrollTo },
  });

  return {
    el,
    scrollTo,
    get result() { return result; },
    update(count: number, text: string) {
      view.rerender(createElement(Harness, { count, text }));
    },
    unmount: view.unmount,
  };
}

describe("useStickyScroll", () => {
  it("sticks by default and immediately scrolls on text updates", () => {
    const harness = setup();
    expect(harness.result.isSticking).toBe(true);
    harness.update(1, "第一段");
    expect(harness.el.scrollTop).toBe(500);
    harness.el.scrollTop = 0;
    harness.update(1, "第一段续写");
    expect(harness.el.scrollTop).toBe(500);
    expect(harness.scrollTo).not.toHaveBeenCalled();
  });

  it.each([
    ["wheel", (el: HTMLElement) => fireEvent.wheel(el, { deltaY: -1 })],
    ["PageUp", (el: HTMLElement) => fireEvent.keyDown(el, { key: "PageUp" })],
    ["touchmove", (el: HTMLElement) => fireEvent.touchMove(el)],
  ] as const)("unlocks immediately on %s and counts unread content", (_, unlock) => {
    const harness = setup();
    harness.update(1, "第一段");
    harness.el.scrollTop = 270;
    unlock(harness.el);
    expect(harness.result.isSticking).toBe(false);
    harness.update(1, "第一段续写");
    harness.update(3, "第三段");
    expect(harness.result.unreadCount).toBe(3);
    expect(harness.el.scrollTop).toBe(270);
  });

  it("resumes only when scrolling back within 24px of the bottom", () => {
    const harness = setup();
    harness.el.scrollTop = 300;
    fireEvent.wheel(harness.el, { deltaY: -1 });
    harness.el.scrollTop = 290;
    fireEvent.scroll(harness.el);
    expect(harness.result.isSticking).toBe(false);
    harness.update(1, "第一段");
    harness.el.scrollTop = 276;
    fireEvent.scroll(harness.el);
    expect(harness.result.isSticking).toBe(false);
    harness.el.scrollTop = 277;
    fireEvent.scroll(harness.el);
    expect(harness.result.isSticking).toBe(true);
    expect(harness.result.unreadCount).toBe(0);
  });

  it("jumps smoothly via the callback and Meta+ArrowDown", () => {
    const harness = setup();
    for (const [index, jump] of [
      () => act(() => harness.result.jumpToLatest()),
      () => fireEvent.keyDown(window, { key: "ArrowDown", metaKey: true }),
    ].entries()) {
      fireEvent.keyDown(window, { key: "Home" });
      harness.update(index + 1, "新增内容");
      expect(harness.result.unreadCount).toBe(1);
      jump();
      expect(harness.scrollTo).toHaveBeenNthCalledWith(index + 1, { top: 500, behavior: "smooth" });
      expect(harness.result.isSticking).toBe(true);
      expect(harness.result.unreadCount).toBe(0);
    }

    harness.unmount();
    fireEvent.keyDown(window, { key: "ArrowDown", metaKey: true });
    expect(harness.scrollTo).toHaveBeenCalledTimes(2);
  });
});
