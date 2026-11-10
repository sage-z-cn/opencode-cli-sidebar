import type {
  Bridge,
  EventMessage,
  RequestMessage,
  ResponseMessage,
} from "./types";

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

let cached: Bridge | null = null;

/**
 * Single VS Code bridge instance. `acquireVsCodeApi()` may only be called once
 * per webview document, so every consumer goes through this accessor.
 */
export function getBridge(): Bridge {
  if (cached) {
    return cached;
  }

  const vscode = acquireVsCodeApi();
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const eventHandlers = new Set<(event: string, data: unknown) => void>();

  window.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data as { type?: string } | null;
    if (!msg || typeof msg.type !== "string") {
      return;
    }

    if (msg.type === "response") {
      const resp = msg as ResponseMessage;
      const entry = pending.get(resp.id);
      if (!entry) {
        return;
      }
      pending.delete(resp.id);
      if (resp.success) {
        entry.resolve(resp.data);
      } else {
        entry.reject(new Error(resp.error?.message ?? "Unknown error"));
      }
      return;
    }

    if (msg.type === "event") {
      const evt = msg as EventMessage;
      for (const handler of eventHandlers) {
        handler(evt.event, evt.data);
      }
    }
  });

  cached = {
    request<T>(
      command: string,
      params: Record<string, unknown> = {},
      options?: { timeout?: number },
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const id = crypto.randomUUID();
        // `name` is a locale-independent marker so callers can detect a
        // timeout without matching translated text.
        const timeout = setTimeout(() => {
          pending.delete(id);
          const err = new Error(`Request '${command}' timed out`);
          err.name = "BridgeTimeout";
          reject(err);
        }, options?.timeout ?? 10_000);

        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value as T);
          },
          reject: (e) => {
            clearTimeout(timeout);
            reject(e);
          },
        });

        const message: RequestMessage = { type: "request", id, command, params };
        vscode.postMessage(message);
      });
    },

    onEvent(handler) {
      eventHandlers.add(handler);
      return () => {
        eventHandlers.delete(handler);
      };
    },

    postMessage: (message: unknown) => vscode.postMessage(message),
    getState: () => vscode.getState(),
    setState: (state: unknown) => vscode.setState(state),
  };

  return cached;
}

/** Test seam: drops the cached bridge so a fresh `acquireVsCodeApi` runs. */
export function resetBridge(): void {
  cached = null;
}
