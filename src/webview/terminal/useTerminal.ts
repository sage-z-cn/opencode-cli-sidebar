import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { initTerminal, type TerminalInstance } from "./index";
import { postMessage } from "../shared/vscode-api";

export interface TerminalHandle {
  terminal: Terminal;
  fitAddon: FitAddon;
}

interface UseTerminalOptions {
  /** Receives the live xterm handle once mounted, and null on unmount. */
  onReady?: (handle: TerminalHandle | null) => void;
}

/**
 * Copy the `data-*` terminal config from `#root` onto the xterm host.
 *
 * `readTerminalConfig` reads from the element it is given, and downstream
 * modules (`keyboard.ts`, `resize.ts`) re-read the dataset from the container
 * they receive. Mirroring the attributes keeps that contract intact instead
 * of threading a config object through every call site.
 */
function copyConfigDataset(from: HTMLElement, to: HTMLElement): void {
  for (const [key, value] of Object.entries(from.dataset)) {
    if (value !== undefined) {
      to.dataset[key] = value;
    }
  }
}

/**
 * Live handle to the mounted xterm instance.
 *
 * `TerminalApp` owns the terminal but the host message handler, which is
 * installed outside React, needs to write output into it. A module-level slot
 * keeps them in sync without prop-drilling through the boot sequence or
 * relying on a DOM lookup for state React owns.
 */
let activeHandle: TerminalHandle | null = null;

export function setActiveTerminalHandle(handle: TerminalHandle | null): void {
  activeHandle = handle;
}

export function getActiveTerminalHandle(): TerminalHandle | null {
  return activeHandle;
}

/**
 * Mounts xterm into `hostRef`.
 *
 * xterm is imperative and cannot be reconciled by React: `terminal.open()`
 * binds to a real DOM node and every later `resize`/`fit` depends on that
 * node staying mounted and visible. So the effect runs exactly once, owns the
 * instance, and disposes it on cleanup. React never re-renders the terminal
 * subtree — `TerminalApp` renders an empty div and nothing else.
 *
 * Keep the dependency array empty. Re-running this effect would dispose and
 * recreate the terminal, losing scrollback and the PTY's screen state.
 */
export function useTerminal(
  hostRef: React.RefObject<HTMLDivElement | null>,
  options: UseTerminalOptions = {},
): void {
  const instanceRef = useRef<TerminalInstance | null>(null);
  const onReadyRef = useRef(options.onReady);
  onReadyRef.current = options.onReady;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    // Config attributes live on `#root`, not on the React-rendered container.
    const configSource = document.getElementById("root") ?? host;
    if (configSource !== host) {
      copyConfigDataset(configSource, host);
    }

    const instance = initTerminal(host, {
      onData: (data) => {
        postMessage({ type: "terminalInput", data });
      },
      onResize: (cols, rows) => {
        postMessage({ type: "terminalResize", cols, rows });
      },
    });

    instanceRef.current = instance;
    if (instance) {
      const handle = {
        terminal: instance.terminal,
        fitAddon: instance.fitAddon,
      };
      setActiveTerminalHandle(handle);
      onReadyRef.current?.(handle);
    }

    return () => {
      setActiveTerminalHandle(null);
      onReadyRef.current?.(null);
      instance?.dispose();
      instanceRef.current = null;
    };
  }, [hostRef]);
}
