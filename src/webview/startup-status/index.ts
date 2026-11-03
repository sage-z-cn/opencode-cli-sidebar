/**
 * In-sidebar startup indicator.
 *
 * The startup gate blocks before the terminal is spawned, so without this the
 * sidebar looks idle while another window starts the shared OpenCode background
 * service. The host pushes `startupPhase`; this module only renders that state
 * over the empty terminal area.
 *
 * Browser-only: no host APIs, no process access.
 */

type StartupPhase = "starting" | "idle";

const L10N_FALLBACK: Record<string, string> = {
  starting: "Waiting for the OpenCode background service...",
  aria: "OpenCode is starting",
};

let root: HTMLDivElement | null = null;
let textElement: HTMLDivElement | null = null;
/** Survives a re-init so the indicator reflects the current gate phase. */
let currentPhase: StartupPhase = "idle";

function l10nStrings(): Record<string, string> {
  const injected =
    typeof window === "undefined"
      ? undefined
      : (
          window as unknown as {
            __OC_STARTUP_L10N__?: Record<string, string>;
          }
        ).__OC_STARTUP_L10N__;
  return injected ?? L10N_FALLBACK;
}

function message(key: keyof typeof L10N_FALLBACK): string {
  return l10nStrings()[key] ?? L10N_FALLBACK[key];
}

/**
 * Mounts the indicator inside the terminal container. Idempotent so a webview
 * re-initialization cannot stack duplicates.
 */
export function initStartupStatus(container: HTMLElement): void {
  if (root && root.isConnected) {
    return;
  }
  const element = document.createElement("div");
  element.className = "startup-status hidden";
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");
  element.innerHTML =
    '<div class="startup-status-spinner" aria-hidden="true"></div>' +
    '<div class="startup-status-text"></div>';
  container.appendChild(element);

  root = element;
  textElement = element.querySelector(".startup-status-text");
  applyStartupPhase(currentPhase);
}

/** Renders one gate phase. `idle` hides the indicator. */
export function applyStartupPhase(phase: StartupPhase): void {
  currentPhase = phase;
  const element = root;
  if (!element) {
    return;
  }
  if (phase === "idle") {
    element.classList.add("hidden");
    delete element.dataset.phase;
    if (textElement) {
      textElement.textContent = "";
    }
    return;
  }

  element.classList.remove("hidden");
  element.dataset.phase = phase;
  element.setAttribute("aria-label", message("aria"));
  if (textElement) {
    textElement.textContent = message("starting");
  }
}

/** Test helper: drops the mounted DOM and the remembered phase. */
export function resetStartupStatus(): void {
  root?.remove();
  root = null;
  textElement = null;
  currentPhase = "idle";
}
