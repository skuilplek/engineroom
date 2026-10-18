import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { onAgent, sendCommand, sendPty, sendPtyResize } from "../socket.ts";

export function TerminalPanel({ chatId }: { chatId: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = host.current;
    if (!node) return undefined;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      theme: { background: "#101010", foreground: "#f3f3f3", cursor: "#f3f3f3" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node);
    fit.fit();
    sendCommand({ type: "pty_open", chatId, cols: term.cols, rows: term.rows });
    const stop = onAgent((message) => {
      if (message.type === "pty" && message.chatId === chatId) term.write(message.data);
      if (message.type === "pty_open" && message.chatId === chatId && message.scrollback) {
        const bytes = Uint8Array.from(atob(message.scrollback), (char) => char.charCodeAt(0));
        term.write(bytes);
      }
    });
    const input = term.onData((data) => sendPty(chatId, data));
    const resize = () => {
      fit.fit();
      sendPtyResize(chatId, term.cols, term.rows);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => {
      stop();
      input.dispose();
      observer.disconnect();
      sendCommand({ type: "pty_close", chatId });
      term.dispose();
    };
  }, [chatId]);

  return <div className="terminal-host" ref={host} />;
}
