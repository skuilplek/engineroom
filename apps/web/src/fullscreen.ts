import { useCallback, useEffect, useState } from "react";

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type WebkitElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

function fullscreenRoot(): Element | null {
  const doc = document as WebkitDocument;
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function fullscreenEnabled(): boolean {
  const doc = document as WebkitDocument;
  return document.fullscreenEnabled || doc.webkitFullscreenEnabled === true;
}

export function useFullscreen() {
  const [active, setActive] = useState(() => fullscreenRoot() != null);
  const [enabled, setEnabled] = useState(fullscreenEnabled);

  useEffect(() => {
    setEnabled(fullscreenEnabled());
    const sync = () => setActive(fullscreenRoot() != null);
    sync();
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  const toggle = useCallback(() => {
    const root = document.documentElement as WebkitElement;
    const doc = document as WebkitDocument;
    const leave = fullscreenRoot() != null;
    const action = leave
      ? document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(document)
      : root.requestFullscreen?.bind(root) ?? root.webkitRequestFullscreen?.bind(root);
    if (!action) return;
    Promise.resolve(action()).catch(() => undefined);
  }, []);

  return { active, enabled, toggle };
}
