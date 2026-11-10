import type { WebviewMessage } from "../../types";
import { getBridge } from "./bridge";

/**
 * Raw `postMessage` for the terminal hot path.
 *
 * `acquireVsCodeApi()` may only be called once per webview document, and the
 * bridge owns that single instance. Routing through it here keeps both
 * channels on one API handle — a second `acquireVsCodeApi()` call throws.
 */
export function postMessage(message: WebviewMessage): void {
  getBridge().postMessage(message);
}
