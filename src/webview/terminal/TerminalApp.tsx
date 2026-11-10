import { useCallback, useEffect, useRef } from "react";
import { useTerminal, type TerminalHandle } from "./useTerminal";
import { createFocusIndicator } from "./focus-indicator";
import { initStartupStatus } from "../startup-status";
import {
  copySelectionToClipboard,
  handlePasteEventWithImageSupport,
} from "../clipboard";
import { readTerminalConfig } from "./config";
import { Toolbar } from "../toolbar/Toolbar";

/**
 * Root component for the sidebar terminal.
 *
 * Only the host div around xterm and the toolbar are React-managed. Everything
 * inside the terminal surface (xterm canvas, link layer, startup overlay,
 * focus ring) is owned imperatively by the modules the previous DOM entry used
 * — they were never React-shaped and rewriting them would risk the fit timing.
 */
export function TerminalApp(): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<TerminalHandle | null>(null);
  const focusIndicatorRef = useRef<ReturnType<typeof createFocusIndicator> | null>(
    null,
  );

  const onReady = useCallback((handle: TerminalHandle | null) => {
    handleRef.current = handle;
  }, []);

  useTerminal(hostRef, { onReady });

  // Focus ring and startup overlay mount once, independent of xterm.
  useEffect(() => {
    const indicator = createFocusIndicator();
    focusIndicatorRef.current = indicator;

    const host = hostRef.current;
    if (host) {
      // Terminal config lives on `#root` (see providers/webviewHtml.ts); the
      // React-rendered container carries no attributes of its own.
      const configSource = document.getElementById("root") ?? host;
      const config = readTerminalConfig(configSource);
      indicator.update(
        config.focusIndicatorMode,
        config.focusIndicatorBorderWidth,
      );
      initStartupStatus(host);
    }

    return () => {
      indicator.dispose();
      focusIndicatorRef.current = null;
    };
  }, []);

  // Clipboard integration must sit on the terminal host in the capture phase,
  // exactly as before: xterm's own handlers would otherwise swallow the event.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const onPaste = (event: ClipboardEvent): void => {
      if (!handlePasteEventWithImageSupport(event)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const onCopy = (event: ClipboardEvent): void => {
      const terminal = handleRef.current?.terminal;
      const selection = terminal?.hasSelection() ? terminal.getSelection() : "";
      if (!selection) {
        return;
      }
      event.preventDefault();
      copySelectionToClipboard(selection);
    };

    host.addEventListener("paste", onPaste, { capture: true });
    host.addEventListener("copy", onCopy, { capture: true });

    return () => {
      host.removeEventListener("paste", onPaste, { capture: true });
      host.removeEventListener("copy", onCopy, { capture: true });
    };
  }, []);

  return (
    <>
      <Toolbar getHandle={() => handleRef.current} />
      <div id="terminal-container" ref={hostRef} />
    </>
  );
}
