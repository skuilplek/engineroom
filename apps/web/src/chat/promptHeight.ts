import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

const MIN_HEIGHT = 64;
const MAX_HEIGHT = 480;

function storageKey(username: string) {
  return `engineroom.promptHeight.${username}`;
}

function ceiling() {
  const viewport = typeof window === "undefined" ? MAX_HEIGHT : window.innerHeight * 0.5;
  return Math.max(MIN_HEIGHT, Math.min(viewport, MAX_HEIGHT));
}

export function clampPromptHeight(height: number) {
  return Math.round(Math.min(ceiling(), Math.max(MIN_HEIGHT, height)));
}

export function readPromptHeight(username: string): number | null {
  try {
    const raw = localStorage.getItem(storageKey(username));
    if (raw == null || raw === "") return null;
    const height = Number(raw);
    if (!Number.isFinite(height)) return null;
    return clampPromptHeight(height);
  } catch {
    return null;
  }
}

export function writePromptHeight(username: string, height: number) {
  if (!username || !Number.isFinite(height)) return;
  try {
    localStorage.setItem(storageKey(username), String(clampPromptHeight(height)));
  } catch {
    /* storage can be blocked */
  }
}

export function usePromptHeight(username: string): {
  style?: CSSProperties;
  onPointerDown: (event: ReactPointerEvent<HTMLTextAreaElement>) => void;
} {
  const [height, setHeight] = useState<number | null>(() => readPromptHeight(username));
  const detachRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setHeight(readPromptHeight(username));
  }, [username]);

  useEffect(() => () => {
    detachRef.current?.();
    detachRef.current = null;
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLTextAreaElement>) => {
    detachRef.current?.();
    const node = event.currentTarget;
    const start = node.offsetHeight;
    function detach() {
      detachRef.current = null;
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", detach);
    }
    function onUp() {
      if (detachRef.current !== detach) return;
      detach();
      if (!node.isConnected) return;
      const next = node.offsetHeight;
      if (Math.abs(next - start) < 2) return;
      const saved = clampPromptHeight(next);
      writePromptHeight(username, saved);
      setHeight(saved);
    }
    detachRef.current = detach;
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", detach);
  }, [username]);

  return {
    style: height == null ? undefined : { height },
    onPointerDown,
  };
}
