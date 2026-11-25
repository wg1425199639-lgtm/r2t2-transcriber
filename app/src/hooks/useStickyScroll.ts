import { useCallback, useLayoutEffect, useRef, useState } from "react";

const BOTTOM_THRESHOLD_PX = 24;

export function useStickyScroll(paragraphCount: number, latestText: string) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sticking = useRef(true);
  const smoothScroll = useRef(false);
  const previousContent = useRef({ paragraphCount, latestText });
  const [isSticking, setIsSticking] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);

  const resumeSticking = useCallback(() => {
    sticking.current = true;
    setIsSticking(true);
    setUnreadCount(0);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    resumeSticking();
    smoothScroll.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [resumeSticking]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let previousTop = el.scrollTop;

    const unlock = () => {
      if (smoothScroll.current) {
        smoothScroll.current = false;
        el.scrollTop = el.scrollTop;
      }
      previousTop = el.scrollTop;
      sticking.current = false;
      setIsSticking(false);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) unlock();
    };
    const onScroll = () => {
      const top = el.scrollTop;
      const distance = el.scrollHeight - el.clientHeight - top;
      if (distance <= 0) smoothScroll.current = false;
      if (!sticking.current && top >= previousTop && distance < BOTTOM_THRESHOLD_PX) {
        resumeSticking();
      }
      previousTop = top;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey && event.key === "ArrowDown") {
        event.preventDefault();
        jumpToLatest();
      } else if (["PageUp", "ArrowUp", "Home"].includes(event.key)) {
        unlock();
      }
    };

    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", unlock, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", unlock);
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [jumpToLatest, resumeSticking]);

  useLayoutEffect(() => {
    const previous = previousContent.current;
    previousContent.current = { paragraphCount, latestText };

    const el = scrollRef.current;
    if (sticking.current && el) {
      smoothScroll.current = false;
      el.scrollTop = el.scrollHeight;
    } else if (paragraphCount < previous.paragraphCount) {
      setUnreadCount(0);
    } else {
      const added = paragraphCount - previous.paragraphCount;
      const updates = added || Number(latestText !== previous.latestText);
      if (updates) setUnreadCount((count) => count + updates);
    }
  }, [paragraphCount, latestText]);

  return { scrollRef, isSticking, unreadCount, jumpToLatest };
}
