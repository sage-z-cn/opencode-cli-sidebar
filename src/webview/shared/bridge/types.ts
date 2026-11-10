/**
 * Webview <-> extension bridge protocol.
 *
 * Two channels coexist by design:
 *
 * 1. Hot path (terminal I/O) keeps the flat `WebviewMessage` / `HostMessage`
 *    unions from `src/types.ts`. Terminal input and output fire dozens of
 *    times per second; wrapping them in a promise map would add per-keystroke
 *    overhead for no benefit.
 * 2. Command path uses a request/response envelope. UI code asks for data or
 *    triggers an action with `request<T>(command, params)` and gets a typed
 *    result back. Extension-side events are delivered through `onEvent`.
 *
 * Both envelopes extend `HostMessage` so `MessageRouter` keeps a single entry
 * point for webview -> host traffic.
 */

/** Webview -> extension: ask the host to run `command`. */
export interface RequestMessage {
  type: "request";
  /** Correlates with the host's `ResponseMessage`. */
  id: string;
  command: string;
  params: Record<string, unknown>;
}

/** Extension -> webview: result of a `RequestMessage`. */
export interface ResponseMessage {
  type: "response";
  id: string;
  success: boolean;
  data?: unknown;
  error?: { code?: string; message: string };
}

/** Extension -> webview: unsolicited state change broadcast. */
export interface EventMessage {
  type: "event";
  event: string;
  data: unknown;
}

export interface Bridge {
  /**
   * Send a command and await the host's response. Rejects with a `BridgeTimeout`
   * error when the host does not answer inside `options.timeout`.
   */
  request<T>(
    command: string,
    params?: Record<string, unknown>,
    options?: { timeout?: number },
  ): Promise<T>;
  /** Subscribe to host events. Returns an unsubscribe function. */
  onEvent(handler: (event: string, data: unknown) => void): () => void;
  /** Raw postMessage for the terminal hot path. */
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
}
