import { useEffect, useRef, useState } from "react";

const DRAG_START = 10;
const FLICK = 0.35;
const OPEN_RATIO = 0.33;
const SCROLL_CLOSE = 12;

function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 800px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 800px)");
    const apply = () => setNarrow(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  return narrow;
}

export function useChatMast() {
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  const [pull, setPull] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  const pullRef = useRef<number | null>(null);
  const lastScroll = useRef(0);
  const ignoreScrollUntil = useRef(0);
  openRef.current = open;
  pullRef.current = pull;

  function reveal(next: boolean) {
    ignoreScrollUntil.current = performance.now() + 280;
    setOpen(next);
  }

  useEffect(() => {
    const query = window.matchMedia("(max-width: 800px)");
    let pointerId = -1;
    let startY = 0;
    let startX = 0;
    let origin = 0;
    let tracking = false;
    let from: "bar" | "mast" | "transcript" | null = null;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;
    let shown = 0;
    let suppressClickUntil = 0;

    function contentHeight() {
      const body = bodyRef.current;
      if (!body) return 0;
      return Math.min(body.scrollHeight, window.innerHeight * 0.7);
    }

    function sourceOf(target: EventTarget | null): "bar" | "mast" | "transcript" | null {
      if (!(target instanceof Element)) return null;
      if (target.closest(".mobile-bar, .chat-mast-grabber")) return "bar";
      if (target.closest("#chat-mast")) return "mast";
      if (openRef.current && target.closest(".chat .transcript")) return "transcript";
      return null;
    }

    function shouldTrack(dy: number, dx: number) {
      if (Math.abs(dx) > Math.abs(dy)) return false;
      if (from === "bar") {
        if (!openRef.current) return dy > 0;
        return dy < 0;
      }
      if (from === "mast") {
        const mast = bodyRef.current?.parentElement;
        if (!mast || !openRef.current || mast.scrollTop > 0) return false;
        return dy < 0;
      }
      if (from === "transcript") {
        const node = document.querySelector(".chat .transcript");
        if (!(node instanceof HTMLElement) || !openRef.current) return false;
        if (node.scrollHeight > node.clientHeight + 1) return false;
        return dy < 0;
      }
      return false;
    }

    function onDown(event: PointerEvent) {
      if (!query.matches || event.button !== 0 || pointerId !== -1) return;
      const source = sourceOf(event.target);
      if (!source) return;
      pointerId = event.pointerId;
      startY = lastY = event.clientY;
      startX = event.clientX;
      lastT = event.timeStamp;
      velocity = 0;
      tracking = false;
      from = source;
    }

    function onMove(event: PointerEvent) {
      if (event.pointerId !== pointerId || !from) return;
      if (!query.matches) {
        pointerId = -1;
        tracking = false;
        from = null;
        setPull(null);
        return;
      }
      const dy = event.clientY - startY;
      const dx = event.clientX - startX;
      if (!tracking) {
        if (Math.abs(dy) < DRAG_START && Math.abs(dx) < DRAG_START) return;
        if (!shouldTrack(dy, dx)) {
          pointerId = -1;
          from = null;
          return;
        }
        tracking = true;
        origin = openRef.current ? contentHeight() : 0;
      }
      const dt = event.timeStamp - lastT;
      if (dt > 0) velocity = (event.clientY - lastY) / dt;
      lastY = event.clientY;
      lastT = event.timeStamp;
      const full = Math.max(contentHeight(), origin);
      shown = Math.max(0, Math.min(full, origin + dy));
      setPull(shown);
      event.preventDefault();
    }

    function endGesture(event: PointerEvent, cancel: boolean) {
      if (event.pointerId !== pointerId) return;
      pointerId = -1;
      const wasTracking = tracking;
      tracking = false;
      from = null;
      if (!wasTracking) return;
      suppressClickUntil = performance.now() + 400;
      if (cancel) {
        setPull(null);
        return;
      }
      const full = Math.max(contentHeight(), 1);
      const flickDown = velocity > FLICK;
      const flickUp = velocity < -FLICK;
      reveal(flickDown || (!flickUp && shown > full * OPEN_RATIO));
      setPull(null);
    }

    function onClick(event: MouseEvent) {
      if (performance.now() > suppressClickUntil) return;
      event.preventDefault();
      event.stopPropagation();
    }
    function onUp(event: PointerEvent) {
      endGesture(event, false);
    }
    function onCancel(event: PointerEvent) {
      endGesture(event, true);
    }

    function onMedia() {
      if (!query.matches) setPull(null);
    }

    query.addEventListener("change", onMedia);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("click", onClick, true);
    return () => {
      query.removeEventListener("change", onMedia);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  function noteScroll(scrollTop: number, programmatic: boolean) {
    if (programmatic || performance.now() < ignoreScrollUntil.current || pullRef.current != null) {
      lastScroll.current = scrollTop;
      return;
    }
    if (openRef.current && scrollTop > lastScroll.current + SCROLL_CLOSE) setOpen(false);
    lastScroll.current = scrollTop;
  }

  function noteWheel(deltaY: number, canScroll: boolean) {
    if (!openRef.current || pullRef.current != null || canScroll || deltaY <= 0) return;
    setOpen(false);
  }

  return { narrow, open, pull, reveal, bodyRef, noteScroll, noteWheel };
}
