"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

type TerminalPanelProps = {
  id: string;
  cwd: string | null;
  onClose: () => void;
};

export default function TerminalPanel({
  id,
  cwd,
  onClose,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current || !window.electronAPI) return;

    const term = new Terminal({
      convertEol: true,
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
      fontSize: 13,
      theme: {
        background: "#181818",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
      },
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fitAddon;

    let disposed = false;
    let started = false;

    // xterm's renderer finishes measuring character dimensions asynchronously
    // after open() returns, so calling fit() in the same tick can throw
    // ("Cannot read properties of undefined (reading 'dimensions')"). Fitting
    // is also pointless before the container has been laid out with a real
    // size. Guard both, and only wire up the pty once the first fit succeeds.
    const safeFit = (): boolean => {
      const el = containerRef.current;
      if (disposed || !el || el.clientWidth === 0 || el.clientHeight === 0)
        return false;
      try {
        fitAddon.fit();
        return true;
      } catch {
        return false;
      }
    };

    const start = () => {
      if (disposed || started) return;
      if (!safeFit()) return;
      started = true;
      window.electronAPI!.terminalCreate(id, cwd || undefined).then(() => {
        if (disposed) return;
        window.electronAPI!.terminalResize(id, term.cols, term.rows);
      });
    };

    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      // A single frame is sometimes not enough on first mount (the panel's
      // own layout can still be settling), so retry once more before giving
      // up to the ResizeObserver below.
      if (!safeFit()) {
        raf2 = requestAnimationFrame(start);
      } else {
        start();
      }
    });

    const offData = window.electronAPI.onTerminalData((incomingId, data) => {
      if (incomingId === id) term.write(data);
    });

    const offExit = window.electronAPI.onTerminalExit((incomingId) => {
      if (incomingId === id) {
        term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
      }
    });

    const activeCommandIds = new Set<string>();
    const offOrchestrator = window.electronAPI.onOrchestratorEvent?.((msg: any) => {

      if (msg.type === 'log') {
        term.write(`\r\n\x1b[36m[Agent]\x1b[0m ${msg.message}\r\n`);
      }      
      
      if (msg.type === 'tool_call' && msg.name === 'run_command') {
        activeCommandIds.add(msg.callId);
      }
      
      if (msg.type === 'tool_result' && activeCommandIds.has(msg.callId)) {
        activeCommandIds.delete(msg.callId);
        
        if (typeof msg.result === 'string') {
          const formattedOutput = msg.result.replace(/\n/g, '\r\n');          
          term.write(`${formattedOutput}\r\n`);
        }
      }
    });

    const dataDisposable = term.onData((data) => {
      window.electronAPI!.terminalWrite(id, data);
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!safeFit()) return;
      if (!started) {
        start();
        return;
      }
      window.electronAPI!.terminalResize(id, term.cols, term.rows);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      resizeObserver.disconnect();
      dataDisposable.dispose();
      offData();
      offExit();
      offOrchestrator?.();
      term.dispose();
      if (started) window.electronAPI?.terminalKill(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <div className="terminal-panel">
      <div className="terminal-panel-header">
        <span>TERMINAL</span>
        <button
          className="terminal-close-btn"
          onClick={onClose}
          title="Close terminal"
        >
          ×
        </button>
      </div>
      <div className="terminal-panel-body" ref={containerRef} />
    </div>
  );
}
