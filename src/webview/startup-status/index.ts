/**
 * In-sidebar startup indicator.
 *
 * The startup gate blocks before the terminal is spawned, so without this the
 * sidebar looks idle while another window starts the shared OpenCode background
 * service or the pre-launch config sync runs. The host pushes `startupPhase`;
 * this module only renders that state over the empty terminal area.
 *
 * Browser-only: no host APIs, no process access.
 */
import type {
  PreStartSyncProgress,
  PreStartSyncResult,
  StartupPhase,
} from "../../types";
import { postMessage } from "../shared/vscode-api";
import { showToast } from "../shared/toast";
import { t as translate } from "../shared/i18n/core";

const L10N_FALLBACK = {
  starting: "Waiting for the OpenCode background service...",
  aria: "OpenCode is starting",
  preStartAria: "Syncing OpenCode configuration",
  preStartText: "Syncing OpenCode configuration...",
  preStartScanning: "Scanning configuration ({0}/{1})",
  preStartFile: "Syncing {0} ({1}/{2})",
  skip: "Skip",
  skipTitle: "Click to skip this sync and start OpenCode",
  skipping: "Skipping...",
  resultSynced: "Config synced",
  resultCooldown: "Config already current",
  resultTimeout: "Sync timed out",
  resultFailed: "Sync failed",
} as const;

/** How long the verdict stays; long enough to read, short enough not to
 *  linger over the terminal OpenCode just opened. */
const PRE_START_RESULT_TTL_MS = 1_500;

let root: HTMLDivElement | null = null;
let textElement: HTMLDivElement | null = null;
let progressElement: HTMLDivElement | null = null;
let skipElement: HTMLButtonElement | null = null;
/** Survives a re-init so the indicator reflects the current gate phase. */
let currentPhase: StartupPhase = "idle";
let currentProgress: PreStartSyncProgress | undefined;
/** Set by the skip action; cleared once the sync phase ends. */
let skipRequested = false;

function message(
  key: keyof typeof L10N_FALLBACK,
  ...values: Array<string | number>
): string {
  // The bundle is keyed by English source text, so the fallback doubles as the
  // lookup key. `t` returns that key when the dictionary has no entry, which
  // keeps the English copy, with placeholders filled, as the runtime default.
  return translate(L10N_FALLBACK[key], ...values);
}

/**
 * Countable progress detail for the progress row.
 *
 * Empty while the host reports no usable total: the headline already carries the
 * generic "Syncing OpenCode configuration..." line for that case.
 */
function progressDetail(progress?: PreStartSyncProgress): string {
  if (!progress || progress.total <= 0) {
    return "";
  }
  if (progress.phase === "scan" || !progress.path) {
    return message("preStartScanning", progress.current, progress.total);
  }
  return message(
    "preStartFile",
    progress.path,
    progress.current,
    progress.total,
  );
}

/** The progress row carries transient copy; an empty string hides it. */
function renderProgress(text: string): void {
  const element = progressElement;
  if (!element) {
    return;
  }
  element.textContent = text;
  element.classList.toggle("hidden", text === "");
}

/** Show/hide the skip action; keeps its "skipping" form once requested. */
function renderSkip(visible: boolean): void {
  const button = skipElement;
  if (!button) {
    return;
  }
  if (!visible) {
    skipRequested = false;
  }
  button.classList.toggle("hidden", !visible);
  button.disabled = skipRequested;
  button.textContent = message(skipRequested ? "skipping" : "skip");
}

/** Skip action: tell the host to abort the running pre-launch sync. */
function onSkipClick(): void {
  const button = skipElement;
  if (!button || button.disabled) {
    return;
  }
  // Local feedback first: the host only answers once the pass unwinds, and a
  // second click would post a duplicate skip request. The flag keeps later
  // progress pushes from clearing this pending state.
  skipRequested = true;
  button.disabled = true;
  button.textContent = message("skipping");
  renderSyncText(currentProgress);
  postMessage({ type: "skipPreStartSync" });
}

/**
 * Sync-phase text.
 *
 * The phase always shows the progress copy from the host's wording rules; a
 * countable line (scan or per-file) moves into the progress row so the overlay
 * keeps a single, non-duplicated line. A pending skip request replaces the copy
 * with its own label immediately.
 */
function renderSyncText(progress?: PreStartSyncProgress): void {
  if (skipRequested) {
    if (textElement) {
      textElement.textContent = message("skipping");
    }
    renderProgress("");
    return;
  }
  const countable = progress !== undefined && progress.total > 0;
  // The scan phase has no honest total, so it keeps the generic headline and
  // shows nothing countable. Only the transfer phase counts files.
  const label = countable ? progressDetail(progress) : message("preStartText");
  if (textElement) {
    textElement.textContent = countable ? "" : label;
  }
  renderProgress(countable ? label : "");
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
    '<div class="startup-status-text"></div>' +
    '<div class="startup-status-progress hidden"></div>' +
    '<button type="button" class="startup-status-skip hidden"></button>';
  container.appendChild(element);

  root = element;
  textElement = element.querySelector<HTMLDivElement>(".startup-status-text");
  progressElement =
    element.querySelector<HTMLDivElement>(".startup-status-progress");
  skipElement =
    element.querySelector<HTMLButtonElement>(".startup-status-skip");
  skipElement?.addEventListener("click", onSkipClick);
  applyStartupPhase(currentPhase, currentProgress);
}

/** Renders one gate phase. `idle` hides the indicator. */
export function applyStartupPhase(
  phase: StartupPhase,
  progress?: PreStartSyncProgress,
): void {
  currentPhase = phase;
  currentProgress = progress;
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
    renderProgress("");
    renderSkip(false);
    return;
  }

  const syncPhase = phase === "preStartSync";
  element.classList.remove("hidden");
  element.dataset.phase = phase;
  element.setAttribute(
    "aria-label",
    message(syncPhase ? "preStartAria" : "aria"),
  );
  if (syncPhase) {
    renderSyncText(progress);
  } else if (textElement) {
    textElement.textContent = message("starting");
    renderProgress("");
  }
  renderSkip(syncPhase);
  if (syncPhase && skipElement) {
    skipElement.title = message("skipTitle");
    skipElement.setAttribute("aria-label", message("skipTitle"));
  }
}

/** Test helper: drops the mounted DOM and the remembered phase. */
export function resetStartupStatus(): void {
  root?.remove();
  root = null;
  textElement = null;
  progressElement = null;
  skipElement = null;
  currentPhase = "idle";
  currentProgress = undefined;
  skipRequested = false;
}
// ── Settled verdict ──

/**
 * Shows the settled verdict through the shared toast.
 *
 * Deliberately not the startup overlay: that one covers the whole terminal
 * and would hide the OpenCode screen the launch just produced. The toast is
 * click-through and auto-dismisses, so it never competes with the terminal.
 */
export function showPreStartSyncResult(result: PreStartSyncResult): void {
  showToast({
    text: message(resultKey(result)),
    tone: result === "failed" ? "error" : result === "timeout" ? "warn" : "info",
    ttlMs: PRE_START_RESULT_TTL_MS,
  });
}

/** i18n key for one verdict; the bundle is keyed by the English text. */
function resultKey(result: PreStartSyncResult): keyof typeof L10N_FALLBACK {
  switch (result) {
    case "synced":
      return "resultSynced";
    case "cooldown":
      return "resultCooldown";
    case "timeout":
      return "resultTimeout";
    case "failed":
      return "resultFailed";
  }
}
