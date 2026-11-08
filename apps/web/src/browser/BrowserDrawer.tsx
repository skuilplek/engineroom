import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { IconExpand, IconPanelRight } from "../icons.tsx";
import { onAgent, sendCommand } from "../socket.ts";

export function BrowserPaneToggle({
  browserOpen,
  onToggle,
}: {
  browserOpen?: boolean;
  onToggle?: () => void;
}) {
  if (!onToggle || browserOpen) return null;
  return (
    <button className="ghost" type="button" aria-pressed={false} onClick={onToggle}>
      Browser
    </button>
  );
}

export function BrowserDrawer({
  chatId,
  controls,
  expanded,
  narrow,
  onToggleExpanded,
  onClose,
}: {
  chatId: string;
  controls: boolean;
  expanded: boolean;
  narrow: boolean;
  onToggleExpanded?: () => void;
  onClose: () => void;
}) {
  const [address, setAddress] = useState("");
  const [title, setTitle] = useState("");
  const [frame, setFrame] = useState("");
  const [error, setError] = useState("");
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const frameRef = useRef("");
  const opened = useRef(false);
  const controlsRef = useRef(controls);
  frameRef.current = frame;
  controlsRef.current = controls;

  useEffect(() => {
    return onAgent((message) => {
      if (!("chatId" in message) || message.chatId !== chatId) return;
      if (message.type === "browser_frame") setFrame(message.data);
      if (message.type === "browser_status") {
        setTitle(message.title);
        setCanBack(message.canBack);
        setCanForward(message.canForward);
        setError(message.error ?? "");
        if (document.activeElement !== inputRef.current) setAddress(message.url);
      }
    });
  }, [chatId]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return undefined;
    let timer = 0;
    const sendSize = () => {
      const width = Math.round(node.clientWidth);
      const height = Math.round(node.clientHeight);
      if (width < 1 || height < 1) return;
      sizeRef.current = { width, height };
      sendCommand({
        type: opened.current ? "browser_resize" : "browser_open",
        chatId,
        width,
        height,
      });
      opened.current = true;
    };
    sendSize();
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(sendSize, 150);
    });
    observer.observe(node);
    const onWheelNative = (event: WheelEvent) => {
      if (!controlsRef.current || !frameRef.current || !(event.target instanceof HTMLElement)) return;
      event.preventDefault();
      const rect = event.target.getBoundingClientRect();
      const width = sizeRef.current.width || rect.width;
      const height = sizeRef.current.height || rect.height;
      sendCommand({
        type: "browser_scroll",
        chatId,
        x: rect.width ? ((event.clientX - rect.left) / rect.width) * width : 0,
        y: rect.height ? ((event.clientY - rect.top) / rect.height) * height : 0,
        deltaX: clamp(event.deltaX),
        deltaY: clamp(event.deltaY),
      });
    };
    node.addEventListener("wheel", onWheelNative, { passive: false });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      node.removeEventListener("wheel", onWheelNative);
      sendCommand({ type: "browser_close", chatId });
    };
  }, [chatId]);

  function go(event: FormEvent) {
    event.preventDefault();
    const url = address.trim();
    if (!url) return;
    sendCommand({ type: "browser_navigate", chatId, url });
    stageRef.current?.focus();
  }

  function point(event: { clientX: number; clientY: number; currentTarget: HTMLElement }) {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = sizeRef.current.width || rect.width;
    const height = sizeRef.current.height || rect.height;
    return {
      x: rect.width ? ((event.clientX - rect.left) / rect.width) * width : 0,
      y: rect.height ? ((event.clientY - rect.top) / rect.height) * height : 0,
    };
  }

  function onClick(event: MouseEvent<HTMLImageElement>) {
    const next = point(event);
    stageRef.current?.focus();
    sendCommand({ type: "browser_click", chatId, x: next.x, y: next.y });
  }

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab" || event.metaKey || event.ctrlKey || event.altKey) return;
    const named = ["Enter", "Backspace", "Escape", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"];
    if (event.key.length === 1) {
      event.preventDefault();
      sendCommand({ type: "browser_type", chatId, text: event.key });
      return;
    }
    if (named.includes(event.key)) {
      event.preventDefault();
      sendCommand({ type: "browser_key", chatId, key: event.key });
    }
  }

  return (
    <aside className={expanded ? "browser-drawer expanded" : "browser-drawer"} aria-label="Browser">
      <header className="file-drawer-head">
        <div className="file-drawer-title">
          <strong title={title || "Browser"}>Browser</strong>
        </div>
        <div className="file-drawer-actions">
          {onToggleExpanded && !narrow && (
            <button
              className={expanded ? "icon-btn file-expand active" : "icon-btn file-expand"}
              type="button"
              title={expanded ? "Restore split view" : "Expand across chat window"}
              aria-label={expanded ? "Restore split view" : "Expand across chat window"}
              onClick={onToggleExpanded}
            >
              <IconExpand expanded={expanded} />
            </button>
          )}
          <button className="icon-btn" type="button" title="Collapse browser" aria-label="Collapse browser" onClick={onClose}>
            <IconPanelRight />
          </button>
        </div>
      </header>
      {controls && (
        <form className="browser-bar" onSubmit={go}>
          <button className="ghost browser-nav" type="button" aria-label="Back" disabled={!canBack} onClick={() => sendCommand({ type: "browser_back", chatId })}>Back</button>
          <button className="ghost browser-nav" type="button" aria-label="Forward" disabled={!canForward} onClick={() => sendCommand({ type: "browser_forward", chatId })}>Forward</button>
          <button className="ghost browser-nav" type="button" aria-label="Reload" onClick={() => sendCommand({ type: "browser_reload", chatId })}>Reload</button>
          <input
            ref={inputRef}
            aria-label="Address"
            placeholder="https://"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          <button className="primary browser-nav" type="submit">Go</button>
        </form>
      )}
      {error && <p className="alert browser-error" role="alert">{error}</p>}
      <div
        className={controls ? "browser-stage" : "browser-stage passive"}
        ref={stageRef}
        tabIndex={controls ? 0 : -1}
        onKeyDown={controls ? onKey : undefined}
      >
        {frame ? (
          <img
            src={`data:image/jpeg;base64,${frame}`}
            alt={title || "Browser page"}
            onClick={controls ? onClick : undefined}
          />
        ) : (
          <p className="browser-empty">
            {controls
              ? "Enter an address, or ask the agent to browse. This is the page the agent uses."
              : "This is the page the agent uses. It appears here when the agent browses."}
          </p>
        )}
      </div>
      {!controls && <p className="browser-hint muted">The agent drives this page. An administrator can add the address bar and page controls.</p>}
    </aside>
  );
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-10000, Math.min(10000, value));
}
