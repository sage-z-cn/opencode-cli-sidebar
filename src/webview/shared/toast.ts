/**
 * Shared transient notification for the webview.
 *
 * Several features used to grow their own "a line of text that disappears
 * after a while": the sync panel footer, the update hint card, and the
 * pre-launch sync verdict badge. Each had its own element, timer and styling,
 * so the same idea looked different depending on where it appeared. This
 * module owns that idea once.
 *
 * Browser-only: no host APIs, no process access.
 */

/** How a toast reads: colour and icon come from this, not from the caller. */
export type ToastTone = "info" | "success" | "warn" | "error";

export interface ToastOptions {
  /** Message text; callers pass already-localized copy. */
  text: string;
  /** Visual register; defaults to `info`. */
  tone?: ToastTone;
  /** How long it stays; defaults to `TOAST_DEFAULT_TTL_MS`. */
  ttlMs?: number;
}

/** Long enough to read a short sentence, short enough not to linger. */
export const TOAST_DEFAULT_TTL_MS = 2_000;

let host: HTMLDivElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * The toast is anchored to the terminal surface rather than the viewport so
 * it never covers the toolbar or the panel it was triggered from. A host that
 * is not mounted yet (early boot) is created on first use.
 */
function ensureHost(): HTMLDivElement | null {
  if (host?.isConnected) {
    return host;
  }
  const anchor =
    document.getElementById("terminal-container") ??
    document.getElementById("root") ??
    document.body;
  if (!anchor) {
    return null;
  }
  host = document.createElement("div");
  host.className = "oc-toast hidden";
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");
  anchor.appendChild(host);
  return host;
}

/**
 * Show one toast, replacing whatever was on screen.
 *
 * Single-slot on purpose: these are transient confirmations, and stacking
 * them would cover the terminal without adding information. A new message
 * resets the timer so the latest one always gets its full reading time.
 */
export function showToast(options: ToastOptions): void {
  const element = ensureHost();
  if (!element) {
    return;
  }
  element.dataset.tone = options.tone ?? "info";
  element.textContent = options.text;
  element.classList.remove("hidden");
  if (timer) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => {
    timer = null;
    element.classList.add("hidden");
  }, options.ttlMs ?? TOAST_DEFAULT_TTL_MS);
}

/** Hide immediately; used when the surface that triggered it goes away. */
export function hideToast(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  host?.classList.add("hidden");
}

/** Test helper: drop the mounted element and any pending timer. */
export function resetToast(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  host?.remove();
  host = null;
}
