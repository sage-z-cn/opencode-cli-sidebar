/**
 * OpenCode self-update UI (webview side).
 *
 * Browser-only; all host I/O goes through WebviewMessage. The interaction
 * specification is the frozen prototype at docs/opencode-upgrade/index.html:
 * version pill as the sole update entry, anchored method popover, a
 * one-line toolbar progress text next to the pill for installs/updates,
 * in-panel cards (success / blocked / failure / transient hints), log
 * drawer, close semantics, abandon exit.
 */
import type {
  CliInstallPromptAction,
  OpenCodeChangelogPayload,
  OpenCodeUpdateUiStatus,
} from "../../types";
import { postMessage } from "../shared/vscode-api";

// ── Strings (injected host-side; see update/l10n.ts) ──

const l10nStrings: Record<string, string> =
  (typeof window !== "undefined"
    ? (window as unknown as { __OC_UPDATE_L10N__?: Record<string, string> })
        .__OC_UPDATE_L10N__
    : undefined) ?? {};

function t(key: string, fallback: string): string {
  return l10nStrings[key] ?? fallback;
}

function format(template: string, ...values: string[]): string {
  return template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = values[Number(index)];
    return value === undefined ? match : value;
  });
}

const DEFAULT_METHODS = ["curl", "npm", "pnpm", "bun", "yarn", "vp", "brew"];

const STEP_LABELS: Record<string, string> = {
  "prepare-target": t("stepPrepareTarget", "Resolve latest version"),
  "prepare-local": t("stepPrepareLocal", "Read installed version"),
  execute: t("stepExecute", "Downloading and installing"),
  reshim: t("stepReshim", "Sync nvm shim"),
  verify: t("stepVerify", "Verify version"),
  "remediate-trust": t("stepRemediateTrust", "Apply nvm trust setting"),
  "remediate-reshim": t("stepRemediateReshim", "Run nvm reshim"),
  installing: t("stepInstalling", "Install OpenCode CLI"),
};

const METHOD_DESCS: Record<string, string> = {
  curl: t("descCurl", "Download and run the official install script"),
  npm: t("descNpm", "Install via the npm global package"),
  pnpm: t("descPnpm", "Install via the pnpm global package"),
  bun: t("descBun", "Install via the bun global package"),
  yarn: t("descYarn", "Install via the yarn global package"),
  vp: t("descVp", "Install via the vp tool"),
  brew: t("descBrew", "Install via Homebrew"),
  scoop: t("descScoop", "Install via Scoop"),
  choco: t("descChoco", "Install via Chocolatey"),
};

const HINT_TTL_MS = 4500;

const ICONS = {
  check:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  sync:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  info:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  error:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
  copy:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  send:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
};

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Module state ──

let initialized = false;
let status: OpenCodeUpdateUiStatus | null = null;

let pill: HTMLButtonElement | null = null;
let pillText: HTMLElement | null = null;
/** Toolbar progress line right of the version pill (updating state). */
let progressLine: HTMLElement | null = null;
let popover: HTMLDivElement | null = null;
let popList: HTMLElement | null = null;
let card: HTMLElement | null = null;
let drawer: HTMLElement | null = null;
let drawerBody: HTMLElement | null = null;
let liveRegion: HTMLElement | null = null;

type CardMode =
  | "success"
  | "manual"
  | "verify"
  | "generic"
  | "hint"
  | "checking";

let cardMode: CardMode | null = null;
let hintTimer: ReturnType<typeof setTimeout> | null = null;

let popFocused = 0;

// ── Missing-CLI install confirmation (srp-overlay pattern) ──

let installPrompt: HTMLDivElement | null = null;
/** Changelog overlay; lazily built on first use, reused afterwards. */
let changelogDialog: HTMLDivElement | null = null;
/** Version of the rendered changelog; used by the send prompt suffix. */
let changelogVersion = "";
/** True while the post-update restart behind the dialog is in flight. */
let changelogRestartPending = false;
let changelogRestartTimer: ReturnType<typeof setTimeout> | null = null;
/** True while a changelog-dialog check is resolving back into the dialog. */
let changelogCheckFromDialog = false;
/**
 * Last seen pending value: only a rising edge (false → true) may show
 * the dialog, so status re-pushes never re-pop it. The host clears the
 * flag after an answer, which re-arms the edge for a future activation.
 */
let installPromptLastPending = false;
/**
 * True while the dialog's "Re-detect" round-trip is in flight: the
 * buttons stay disabled and the dialog survives on this local flag
 * (not the host's pending flag) until a state push resolves it.
 */
let installPromptRetryActive = false;

// ── A11y ──

function announce(text: string): void {
  const region = liveRegion;
  if (!region) return;
  region.textContent = "";
  window.requestAnimationFrame(() => {
    region.textContent = text;
  });
}

// ── Init ──

export function initOpenCodeUpdateUi(): void {
  if (initialized) return;
  initialized = true;

  pill = document.getElementById("btn-oc-version") as HTMLButtonElement | null;
  pillText = document.getElementById("ocu-version-text");

  progressLine = document.createElement("span");
  progressLine.className = "ocu-progress hidden";
  progressLine.id = "ocu-progress";
  progressLine.setAttribute("role", "status");
  pill?.insertAdjacentElement("afterend", progressLine);
  progressLine.addEventListener("click", (e) => {
    if (
      (e.target as HTMLElement).closest<HTMLElement>(
        '[data-ocu-act="abandon"]',
      )
    ) {
      postMessage({ type: "abandonOpenCodeUpdate" });
      showHintCard(t("abandonedHint", "Install abandoned"));
    }
  });

  liveRegion = document.createElement("div");
  liveRegion.className = "ocu-sr-only";
  liveRegion.setAttribute("aria-live", "polite");
  document.body.appendChild(liveRegion);

  popover = document.createElement("div");
  popover.className = "ocu-popover hidden";
  popover.id = "ocu-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-labelledby", "ocu-popover-title");
  popover.innerHTML =
    '<div class="ocu-pop-head">' +
    '<span id="ocu-popover-title"></span>' +
    '<button type="button" class="ocu-pop-close" id="ocu-pop-close" aria-label="' +
    escapeHtml(t("closeLabel", "Close")) +
    '">' +
    ICONS.x +
    "</button></div>" +
    '<div class="ocu-pop-list" id="ocu-pop-list" role="listbox" aria-label="' +
    escapeHtml(t("installPopoverTitle", "Install OpenCode CLI")) +
    '"></div>' +
    '<div class="ocu-pop-foot"><span class="ocu-pop-hints" aria-hidden="true"><span>' +
    escapeHtml(t("hintConfirm", "Enter to confirm")) +
    "</span><span>" +
    escapeHtml(t("hintCancel", "Esc to cancel")) +
    "</span><span>" +
    escapeHtml(t("hintMove", "Up and down to switch")) +
    "</span></span>" +
    '<button type="button" class="ocu-pop-link hidden" id="ocu-pop-changelog">' +
    escapeHtml(t("changelogLabel", "Changelog")) +
    "</button>" +
    '<button type="button" class="ocu-pop-cancel" id="ocu-pop-cancel">' +
    escapeHtml(t("cancelLabel", "Cancel")) +
    "</button></div>";
  document.body.appendChild(popover);
  popList = popover.querySelector("#ocu-pop-list");

  card = document.createElement("section");
  card.className = "ocu-card hidden";
  card.id = "ocu-card";
  card.setAttribute("role", "status");
  document.getElementById("terminal-container")?.appendChild(card);

  drawer = document.createElement("div");
  drawer.className = "ocu-drawer hidden";
  drawer.id = "ocu-drawer";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-label", t("logTitle", "Install log"));
  drawer.innerHTML =
    '<div class="ocu-drawer-head"><span>' +
    escapeHtml(t("logTitle", "Install log")) +
    '</span><button type="button" class="ocu-drawer-close" id="ocu-drawer-close" aria-label="' +
    escapeHtml(t("closeLabel", "Close")) +
    '">' +
    ICONS.x +
    "</button></div>" +
    '<div class="ocu-drawer-body" id="ocu-drawer-body" tabindex="0"></div>';
  document.getElementById("terminal-container")?.appendChild(drawer);
  drawerBody = drawer.querySelector("#ocu-drawer-body");

  bindEvents();

  postMessage({ type: "requestOpenCodeUpdateStatus" });
}

// ── Status entry point ──

function isBusyState(state: string): boolean {
  return state === "updating";
}

/** States whose pill click opens the method popover. */
function isPopoverState(state: string): boolean {
  // "failed" retries the update flow: the pill keeps the entry look and
  // the popover re-offers the methods (changelog included).
  return state === "available" || state === "installable" || state === "failed";
}

export function applyOpenCodeUpdateStatus(next: OpenCodeUpdateUiStatus): void {
  status = status ? { ...status, ...next } : { ...next };
  // One-shot flag from the manual-check push, same pattern as notice.
  const openPicker =
    next.openMethodPicker === true && next.state === "available";
  maybeShowInstallPrompt();
  finishInstallPromptRetry();
  renderPill();
  updateMenuGate();
  renderProgressLine();
  if (changelogCheckFromDialog && !isBusyState(status.state)) {
    // A check started from the changelog dialog resolves back into it: a
    // found update hands over to the method popover, anything else
    // reports in the dialog footer.
    changelogCheckFromDialog = false;
    if (status.state === "available") {
      hideChangelogDialog();
      openPopover();
    } else {
      setChangelogCheckUi(
        next.checkOutcome === "upToDate" ? "upToDate" : "failed",
      );
    }
  }
  if (popover && !popover.classList.contains("hidden") && !isPopoverState(status.state)) {
    closePopover(false);
  }
  const notice = next.notice;
  if (notice) {
    showHintCard(notice);
  } else if (
    cardMode === "checking" &&
    (status.state === "available" ||
      status.state === "idle" ||
      status.state === "installable")
  ) {
    // Host answered the manual check without a notice: drop the pending card.
    hideCardFull();
  }
  renderCard();
  if (popover && !popover.classList.contains("hidden")) {
    // Enrichment re-push while the popover is open: refresh rows in place
    // instead of toggling the popover closed and open again.
    if (isPopoverState(next.state)) refreshOpenPopover();
    return;
  }
  if (openPicker) openPopover();
}

/** Settings dropdown item was clicked; show local pending state immediately. */
export function notifyOpenCodeUpdateCheckRequested(): void {
  if (!status || isBusyState(status.state)) return;
  closePopover(false);
  showCheckingCard();
}

// ── Pill ──

function renderPill(): void {
  if (!pill || !pillText) return;
  const st = status;
  if (!st || (st.state === "idle" && !st.installedVersion)) {
    pill.classList.add("hidden");
    pill.disabled = true;
    return;
  }

  const entryA =
    st.state === "available" ||
    st.state === "failed" ||
    st.state === "installable";
  const busy = isBusyState(st.state);

  pillText.textContent =
    st.state === "installable"
      ? t("installLabel", "Install")
      : st.installedVersion ?? st.currentVersion ?? st.runningVersion ?? "";

  pill.classList.remove("hidden");
  pill.disabled = false;
  pill.classList.toggle("is-entry", entryA);
  pill.classList.toggle("is-updating", busy);

  if (busy) {
    pill.setAttribute("title", t("updatingTooltip", "Installing OpenCode, click to view progress"));
    pill.setAttribute("aria-label", t("viewProgressLabel", "View install progress"));
  } else if (st.state === "failed") {
    const label = t(
      "failedRetryTooltip",
      "Update did not finish. Click to try again",
    );
    pill.setAttribute("title", label);
    pill.setAttribute("aria-label", label);
  } else if (st.state === "installable") {
    const label = t(
      "installTooltip",
      "OpenCode CLI is not installed. Click to choose an install method.",
    );
    pill.setAttribute("title", label);
    pill.setAttribute("aria-label", label);
  } else if (entryA) {
    const latest = st.latestVersion ?? st.targetVersion ?? "";
    pill.setAttribute(
      "title",
      format(t("updateAvailableTooltip", "OpenCode update available: latest {0}"), latest),
    );
    pill.setAttribute("aria-label", t("updateLabel", "Install OpenCode"));
  } else {
    const label = t(
      "pillChangelogTooltip",
      "View the current version's changelog",
    );
    pill.setAttribute("title", label);
    pill.setAttribute("aria-label", label);
  }
}

function updateMenuGate(): void {
  const item = document.getElementById("menu-oc-update-check");
  if (!item) return;
  const featureOn = Boolean(
    status && (status.state !== "idle" || Boolean(status.installedVersion)),
  );
  item.classList.toggle("hidden", !featureOn);
  item.classList.toggle("is-disabled", featureOn && status ? isBusyState(status.state) : false);
}

// ── Toolbar progress line ──

/** Canonical step order per flow, for the step-count progress readout. */
const UPDATE_STEP_ORDER = [
  "prepare-target",
  "prepare-local",
  "execute",
  "reshim",
  "verify",
];
const INSTALL_STEP_ORDER = ["installing", "reshim", "verify"];

/**
 * Step-count progress ("3/5") for the updating flow: the current step's
 * position in the flow's canonical order. Recovery steps occupy the
 * reshim slot, so skipped conditional steps keep the denominator stable.
 */
function progressStepCount(): string {
  const stepId = status?.step ?? "";
  if (!stepId) return "";
  const history = status?.history ?? [];
  const fromInstall =
    stepId === "installing" || history[0]?.step === "installing";
  const order = fromInstall ? INSTALL_STEP_ORDER : UPDATE_STEP_ORDER;
  let index = order.indexOf(stepId);
  if (index < 0) {
    // remediate-trust / remediate-reshim run in place of reshim.
    index = Math.max(order.indexOf("reshim"), 1);
  }
  return `${index + 1}/${order.length}`;
}

function progressStepText(): string {
  const stepId = status?.step ?? "";
  return STEP_LABELS[stepId] ?? status?.detail ?? stepId;
}

/**
 * One-line install/update progress right of the version pill; the
 * in-panel progress card no longer exists. Remediation steps expose
 * the abandon exit inline.
 */
function renderProgressLine(): void {
  if (!progressLine) return;
  const st = status;
  if (!st || !isBusyState(st.state)) {
    progressLine.classList.add("hidden");
    progressLine.innerHTML = "";
    return;
  }
  const inRemediation =
    st.step === "remediate-trust" || st.step === "remediate-reshim";
  const stepText = progressStepText();
  const countText = progressStepCount();
  progressLine.innerHTML =
    '<span class="ocu-progress-spin" aria-hidden="true">' +
    ICONS.sync +
    "</span>" +
    '<span class="ocu-progress-text">' +
    escapeHtml(countText ? stepText + " " + countText : stepText) +
    "</span>" +
    (inRemediation
      ? '<button type="button" class="ocu-progress-x" data-ocu-act="abandon" aria-label="' +
        escapeHtml(t("abandonUpdate", "Abandon install")) +
        '">' +
        ICONS.x +
        "</button>"
      : "");
  progressLine.classList.remove("hidden");
}

// ── Cards ──

function hideCardFull(): void {
  if (!card) return;
  const hadFocus = card.contains(document.activeElement);
  card.classList.add("hidden");
  card.innerHTML = "";
  cardMode = null;
  if (hintTimer !== null) {
    clearTimeout(hintTimer);
    hintTimer = null;
  }
  if (hadFocus && pill && !pill.disabled) pill.focus();
}

/** Progress heads are text-only; info/error heads keep their icon. */
function cardHead(kind: "prog" | "info" | "error", title: string): string {
  const iconHtml =
    kind === "prog"
      ? ""
      : '<span class="ocu-card-ic ocu-ic-' +
        kind +
        '">' +
        (kind === "error" ? ICONS.error : ICONS.info) +
        "</span>";
  return (
    '<div class="ocu-card-head">' +
    iconHtml +
    '<span class="ocu-card-title">' +
    escapeHtml(title) +
    "</span>" +
    '<button type="button" class="ocu-card-x" data-ocu-act="x" aria-label="' +
    escapeHtml(t("closeLabel", "Close")) +
    '">' +
    ICONS.x +
    "</button></div>"
  );
}

function buildCard(mode: CardMode): void {
  if (!card) return;
  const st = status;
  let html = "";

  if (mode === "success") {
    html = cardHead("info", format(t("successTitle", "OpenCode {0} installed."), st?.installedVersion ?? st?.targetVersion ?? ""));
    if (st?.sessionAutoStarted) {
      // The host already booted the session: restart actions would
      // contradict the automatic start.
      html +=
        '<div class="ocu-card-body"><p class="ocu-card-msg">' +
        escapeHtml(t("sessionAutoStarted", "OpenCode session started automatically.")) +
        '</p><div class="ocu-card-actions">' +
        '<button type="button" class="ocu-btn" data-ocu-act="changelog">' +
        escapeHtml(t("changelogLabel", "Changelog")) +
        "</button></div></div>";
    } else {
      html +=
        '<div class="ocu-card-body"><p class="ocu-card-msg">' +
        escapeHtml(t("successMessage", "Restart the terminal now?")) +
        '</p><div class="ocu-card-actions">' +
        '<button type="button" class="ocu-btn ocu-btn-primary" data-ocu-act="restart">' +
        escapeHtml(t("restartNow", "Restart now")) +
        "</button>" +
        '<button type="button" class="ocu-btn" data-ocu-act="restart-changelog">' +
        escapeHtml(t("restartWithChangelog", "Restart and view changelog")) +
        "</button>" +
        '<button type="button" class="ocu-btn" data-ocu-act="later">' +
        escapeHtml(t("later", "Later")) +
        "</button></div></div>";
    }
  } else if (mode === "manual") {
    html = cardHead("error", t("blockedTitle", "npm install blocked by nvm security policy"));
    const cmds = status?.manualCommands ?? status?.remediationCommands ?? [];
    html +=
      '<div class="ocu-card-body"><p class="ocu-card-msg">' +
      escapeHtml(t("remediateFailed", "Automatic fix did not succeed. Run the following commands in the terminal, then start the install again.")) +
      "</p>";
    for (const cmd of cmds) {
      html +=
        '<div class="ocu-cmd-row"><code>' +
        escapeHtml(cmd) +
        '</code><button type="button" class="ocu-copy" data-ocu-copy="' +
        escapeHtml(cmd) +
        '">' +
        ICONS.copy +
        '<span class="ocu-copy-label">' +
        escapeHtml(t("copy", "Copy")) +
        "</span></button></div>";
    }
    html +=
      '<div class="ocu-card-actions"><button type="button" class="ocu-btn ocu-btn-primary" data-ocu-act="gotit">' +
      escapeHtml(t("gotIt", "Got it")) +
      "</button></div></div>";
  } else if (mode === "generic") {
    // Generic failure without a verified version: show the detail line.
    html = cardHead("error", st?.detail ?? t("progressTitle", "Installing OpenCode"));
    html +=
      '<div class="ocu-card-body"><div class="ocu-card-actions">' +
      '<button type="button" class="ocu-btn" data-ocu-act="viewlog">' +
      escapeHtml(t("viewLog", "View log")) +
      "</button></div></div>";
  } else {
    // verify
    html = cardHead(
      "error",
      format(t("verifyFailedTitle", "Install did not take effect, version is still {0}"), st?.currentVersion ?? st?.installedVersion ?? ""),
    );
    html +=
      '<div class="ocu-card-body"><div class="ocu-card-actions">' +
      '<button type="button" class="ocu-btn" data-ocu-act="viewlog">' +
      escapeHtml(t("viewLog", "View log")) +
      "</button></div></div>";
  }

  card.innerHTML = html;
  card.setAttribute("role", mode === "manual" || mode === "verify" || mode === "generic" ? "alert" : "status");
}

function renderCard(): void {
  if (!card) return;
  const st = status;
  if (
    !st ||
    st.state === "idle" ||
    st.state === "available" ||
    st.state === "installable" ||
    st.state === "updating"
  ) {
    if (cardMode !== "hint" && cardMode !== "checking") hideCardFull();
    return;
  }
  if (cardMode === "hint") {
    // The transient hint owns the card slot until it expires; the
    // expiry callback re-renders whatever the current status maps to.
    return;
  }

  const manualCommands = st.manualCommands ?? st.remediationCommands ?? [];
  const target: CardMode = st.state === "success"
    ? "success"
    : manualCommands.length
      ? "manual"
      : st.installedVersion
        ? "verify"
        : "generic";

  const modeChanged = target !== cardMode;
  cardMode = target;
  buildCard(target);
  card.classList.remove("hidden");
  if (modeChanged && target === "success") {
    card.querySelector<HTMLButtonElement>('[data-ocu-act="restart"]')?.focus();
  }
}

function showHintCard(text: string): void {
  if (!card) return;
  if (hintTimer !== null) {
    clearTimeout(hintTimer);
    hintTimer = null;
  }
  cardMode = "hint";
  card.setAttribute("role", "status");
  card.innerHTML =
    cardHead("info", text) + '<div class="ocu-card-body"></div>';
  card.classList.remove("hidden");
  hintTimer = setTimeout(() => {
    hintTimer = null;
    if (cardMode === "hint") {
      // Re-render from the current status instead of just hiding:
      // idle/available still hides, while failed restores its card.
      cardMode = null;
      renderCard();
    }
  }, HINT_TTL_MS);
}

function showCheckingCard(): void {
  if (!card) return;
  cardMode = "checking";
  card.setAttribute("role", "status");
  card.innerHTML =
    cardHead("prog", t("checkingUpdates", "Checking for updates…")) +
    '<div class="ocu-card-body"></div>';
  card.classList.remove("hidden");
}

// ── Log drawer ──

function openDrawer(): void {
  if (!drawer || !drawerBody) return;
  const history = status?.history ?? [];
  const lines: string[] = [];
  for (const entry of history) {
    const glyph = entry.ok ? "✓" : "✗";
    const cls = entry.ok ? "ocu-lg-ok" : "ocu-lg-err";
    lines.push(
      '<div class="' + cls + '">' + glyph + " " + escapeHtml(entry.label || STEP_LABELS[entry.step] || entry.step) + "</div>",
    );
  }
  if (status?.detail) {
    lines.push('<div class="ocu-lg-cmd">' + escapeHtml(status.detail) + "</div>");
  }
  if (status?.state === "failed") {
    lines.push(
      '<div class="ocu-lg-err">' +
        escapeHtml(
          format(
            t("verifyFailedTitle", "Install did not take effect, version is still {0}"),
            status.currentVersion ?? status.installedVersion ?? "",
          ),
        ) +
        "</div>",
    );
  }
  if (!lines.length) {
    lines.push('<div class="ocu-lg-out">—</div>');
  }
  drawerBody.innerHTML = lines.join("");
  drawer.classList.remove("hidden");
  drawer.querySelector<HTMLButtonElement>("#ocu-drawer-close")?.focus();
}

function closeDrawer(restoreFocus: boolean): void {
  if (!drawer || drawer.classList.contains("hidden")) return;
  drawer.classList.add("hidden");
  if (restoreFocus && pill && !pill.disabled) pill.focus();
}

// ── Method popover ──

function methods(): string[] {
  const list = status?.methods;
  return list && list.length ? list : DEFAULT_METHODS;
}

function popRows(): HTMLElement[] {
  if (!popList) return [];
  return Array.from(popList.querySelectorAll<HTMLElement>(".ocu-pop-row"));
}

function positionPopover(): void {
  if (!popover || !pill) return;
  const vw = document.documentElement.clientWidth || window.innerWidth || 420;
  const vh = window.innerHeight || 700;
  const pr = pill.getBoundingClientRect();
  const w = Math.max(200, Math.min(280, vw - 16));
  let left = pr.left;
  const top = pr.bottom + 6;
  left = Math.max(8, Math.min(left, vw - w - 8));
  popover.style.width = w + "px";
  popover.style.left = left + "px";
  popover.style.top = top + "px";
  popover.style.maxHeight = Math.max(180, vh - top - 10) + "px";
}

function renderPopoverRows(): void {
  if (!popList) return;
  const det = status?.detectedMethod ?? "";
  const last = status?.lastUsedMethod ?? "";
  let html = "";
  methods().forEach((id, i) => {
    const isLast = Boolean(last) && id === last;
    const isDet = Boolean(det) && id === det;
    let tags = "";
    if (isLast) {
      tags += '<span class="ocu-tag ocu-tag-last">' + escapeHtml(t("methodLastUsed", "Last used")) + "</span>";
    } else if (isDet) {
      tags += '<span class="ocu-tag ocu-tag-det">' + escapeHtml(t("methodDetected", "Detected install method")) + "</span>";
    }
    let desc = METHOD_DESCS[id] ?? "";
    if (isLast && isDet) {
      desc += " · " + t("methodDetected", "Detected install method");
    }
    html +=
      '<button type="button" class="ocu-pop-row' +
      (i === 0 ? " is-focused" : "") +
      '" role="option" aria-selected="' +
      (i === 0) +
      '" data-ocu-method="' +
      escapeHtml(id) +
      '" tabindex="' +
      (i === 0 ? 0 : -1) +
      '">' +
      '<span class="ocu-pop-main"><span class="ocu-pop-label">' +
      escapeHtml(id) +
      "</span>" +
      tags +
      '<span class="ocu-pop-ok hidden">' +
      ICONS.check +
      "</span></span>" +
      (desc ? '<span class="ocu-pop-desc" title="' + escapeHtml(desc) + '">' + escapeHtml(desc) + "</span>" : "") +
      "</button>";
  });
  popList.innerHTML = html;
}

function syncPopoverFocus(): void {
  const rows = popRows();
  rows.forEach((row, i) => {
    const on = i === popFocused;
    row.classList.toggle("is-focused", on);
    row.setAttribute("aria-selected", on ? "true" : "false");
    row.tabIndex = on ? 0 : -1;
    row.querySelector(".ocu-pop-ok")?.classList.toggle("hidden", !on);
  });
}

function popoverTitleText(): string {
  // The available flow is an update and names its target version; the
  // installable flow is a first install and keeps the install wording.
  if (status?.state === "available") {
    const latest = status.latestVersion ?? status.targetVersion ?? "";
    return format(t("updatePopoverTitle", "Update OpenCode CLI to {0}"), latest);
  }
  return t("installPopoverTitle", "Install OpenCode CLI");
}

function openPopover(): void {
  if (!popover || !status || !isPopoverState(status.state)) return;
  if (!popover.classList.contains("hidden")) {
    closePopover(true);
    return;
  }
  const titleText = popoverTitleText();
  const titleEl = popover.querySelector("#ocu-popover-title");
  if (titleEl) {
    titleEl.textContent = titleText;
  }
  popList?.setAttribute("aria-label", titleText);
  // Release notes make sense wherever an update flow is pending.
  popover
    .querySelector("#ocu-pop-changelog")
    ?.classList.toggle(
      "hidden",
      status.state !== "available" && status.state !== "failed",
    );
  renderPopoverRows();
  const pref =
    status.lastUsedMethod ?? status.detectedMethod ?? status.defaultMethod ?? "npm";
  const idx = Math.max(0, methods().indexOf(pref));
  popFocused = idx;
  syncPopoverFocus();
  positionPopover();
  popover.classList.remove("hidden");
  popRows()[popFocused]?.focus();
  announce(titleText);
}

function closePopover(restoreFocus: boolean): void {
  if (!popover || popover.classList.contains("hidden")) return;
  popover.classList.add("hidden");
  if (popList) popList.innerHTML = "";
  if (restoreFocus && pill && !pill.disabled) pill.focus();
}

/** Host re-pushed an available snapshot while the popover is open. */
function refreshOpenPopover(): void {
  if (!popover) return;
  const hadFocus = popover.contains(document.activeElement);
  const titleEl = popover.querySelector("#ocu-popover-title");
  if (titleEl) {
    titleEl.textContent = popoverTitleText();
  }
  popList?.setAttribute("aria-label", popoverTitleText());
  popover
    .querySelector("#ocu-pop-changelog")
    ?.classList.toggle(
      "hidden",
      status?.state !== "available" && status?.state !== "failed",
    );
  renderPopoverRows();
  const count = methods().length;
  if (popFocused >= count) popFocused = Math.max(0, count - 1);
  syncPopoverFocus();
  positionPopover();
  if (hadFocus) popRows()[popFocused]?.focus();
}

function setPopoverFocused(idx: number): void {
  const rows = popRows();
  if (!rows.length) return;
  popFocused = (idx + rows.length) % rows.length;
  syncPopoverFocus();
  const row = rows[popFocused];
  row.focus();
  row.scrollIntoView({ block: "nearest" });
}

function chooseMethod(id: string): void {
  closePopover(false);
  postMessage({ type: "startOpenCodeUpdate", method: id });
  pill?.focus();
}

// ── Install confirmation dialog ──

/**
 * Missing-CLI confirmation, structure mirroring the service-restart
 * prompt: fixed overlay, alertdialog semantics, three actions. Esc and
 * backdrop clicks behave like "Not now"; there is no ✕ button to keep
 * the dialog minimal.
 */
function buildInstallPrompt(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "ocu-ip-overlay hidden";
  el.id = "ocu-install-prompt";
  el.innerHTML =
    '<div class="ocu-ip-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ocu-ip-title" aria-describedby="ocu-ip-body">' +
    '<div class="ocu-ip-title" id="ocu-ip-title">' +
    escapeHtml(t("installPromptTitle", "Install OpenCode CLI")) +
    "</div>" +
    '<div class="ocu-ip-body" id="ocu-ip-body">' +
    escapeHtml(
      t(
        "installPromptBody",
        "OpenCode CLI was not found on this machine. Install it now?",
      ),
    ) +
    "</div>" +
    '<div class="ocu-ip-result hidden" id="ocu-ip-result" role="status"></div>' +
    '<div class="ocu-ip-actions">' +
    '<button type="button" class="ocu-ip-btn ocu-ip-btn-primary" data-ocu-ip="install">' +
    escapeHtml(t("installLabel", "Install")) +
    "</button>" +
    '<button type="button" class="ocu-ip-btn" data-ocu-ip="retry">' +
    escapeHtml(t("redetectLabel", "Re-detect")) +
    "</button>" +
    '<button type="button" class="ocu-ip-btn" data-ocu-ip="notNow">' +
    escapeHtml(t("notNowLabel", "Not now")) +
    "</button>" +
    "</div></div>";

  el.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const act = target.closest<HTMLElement>("[data-ocu-ip]");
    if (act) {
      const action = act.dataset.ocuIp;
      if (action === "retry") {
        startInstallPromptRetry();
        return;
      }
      answerInstallPrompt(action === "install" ? action : "notNow");
      return;
    }
    // Backdrop click dismisses like "Not now".
    if (e.target === el) answerInstallPrompt("notNow");
  });

  document.body.appendChild(el);
  return el;
}

/** Startup auto-prompt only: installable + pending, once per arming. */
function maybeShowInstallPrompt(): void {
  const inInstallable = status?.state === "installable";
  const pending =
    inInstallable && status?.installPromptPending === true;
  if (pending && !installPromptLastPending) {
    if (!installPrompt) installPrompt = buildInstallPrompt();
    installPrompt.classList.remove("hidden");
    hideInstallPromptResult();
    installPrompt.querySelector<HTMLButtonElement>(
      '[data-ocu-ip="install"]',
    )?.focus();
  } else if (
    !inInstallable &&
    installPrompt &&
    !installPrompt.classList.contains("hidden")
  ) {
    // The state left installable (flow started, failed, or resolved):
    // the confirmation must not linger over whatever comes next. While
    // still installable the dialog lives on local state alone, so a
    // cleared pending flag or a failed re-detect never closes it.
    hideInstallPrompt();
    resetInstallPromptRetry();
  }
  installPromptLastPending = pending;
}

/** Resolves an in-flight re-detect once the probe's outcome is pushed. */
function finishInstallPromptRetry(): void {
  if (!installPromptRetryActive) return;
  resetInstallPromptRetry();
  if (status?.state === "installable") {
    // The probe found no CLI: keep the dialog open with the inline
    // result so the user can retry or pick an install method.
    showInstallPromptResult();
  }
}

/** Starts the re-detect round-trip: lock the dialog and ask the host. */
function startInstallPromptRetry(): void {
  if (installPromptRetryActive) return;
  installPromptRetryActive = true;
  hideInstallPromptResult();
  setInstallPromptBusy(true);
  postMessage({ type: "retryCliProbe" });
}

/** Unlocks the dialog after a re-detect round-trip finished. */
function resetInstallPromptRetry(): void {
  installPromptRetryActive = false;
  setInstallPromptBusy(false);
}

function setInstallPromptBusy(busy: boolean): void {
  installPrompt
    ?.querySelectorAll<HTMLButtonElement>(".ocu-ip-btn")
    .forEach((button) => {
      button.disabled = busy;
    });
}

function showInstallPromptResult(): void {
  const line = installPrompt?.querySelector<HTMLElement>("#ocu-ip-result");
  if (!line) return;
  line.textContent = t(
    "redetectFailed",
    "OpenCode CLI still not detected. Re-detect or choose an install method.",
  );
  line.classList.remove("hidden");
}

function hideInstallPromptResult(): void {
  installPrompt
    ?.querySelector<HTMLElement>("#ocu-ip-result")
    ?.classList.add("hidden");
}

function hideInstallPrompt(): void {
  installPrompt?.classList.add("hidden");
}

/** True while the missing-CLI install confirmation overlay is visible. */
export function isInstallPromptVisible(): boolean {
  return Boolean(installPrompt && !installPrompt.classList.contains("hidden"));
}

function answerInstallPrompt(action: CliInstallPromptAction): void {
  resetInstallPromptRetry();
  hideInstallPrompt();
  postMessage({ type: "answerCliInstallPrompt", action });
  if (action === "install") {
    // The method popover is driven entirely in the webview.
    openPopover();
  }
}

// ── Changelog dialog ──

/** Renders the host's changelog answer into the open dialog. */
export function applyOpenCodeChangelog(
  payload: OpenCodeChangelogPayload,
): void {
  const dialog = changelogDialog;
  if (!dialog || dialog.classList.contains("hidden")) {
    return;
  }
  dialog.dataset.ocuClUrl = payload.fallbackUrl;
  const title = dialog.querySelector<HTMLElement>("#ocu-cl-title");
  const body = dialog.querySelector<HTMLElement>("#ocu-cl-body");
  const actionBtns = dialog.querySelectorAll<HTMLElement>(
    ".ocu-cl-copy, .ocu-cl-send",
  );
  if (!body) {
    return;
  }
  if (payload.ok) {
    changelogVersion = payload.version;
    actionBtns.forEach((btn) => btn.classList.remove("hidden"));
    // During the post-update restart the session cannot accept sends.
    setChangelogSendEnabled(!changelogRestartPending);
    if (title) {
      title.textContent = payload.version
        ? "OpenCode " + payload.version
        : t("changelogLabel", "Changelog");
    }
    body.innerHTML =
      (payload.date
        ? '<p class="ocu-cl-date">' + escapeHtml(payload.date) + "</p>"
        : "") +
      (payload.html ?? "");
    return;
  }
  actionBtns.forEach((btn) => btn.classList.add("hidden"));
  if (title) {
    title.textContent = t("changelogLabel", "Changelog");
  }
  body.innerHTML =
    '<p class="ocu-cl-msg">' +
    escapeHtml(
      t("changelogFailed", "Changelog is unavailable for this version."),
    ) +
    "</p>" +
    '<div class="ocu-cl-actions"><button type="button" class="ocu-btn" data-ocu-cl="open">' +
    escapeHtml(t("changelogOpenInBrowser", "Open in browser")) +
    "</button></div>";
}

function buildChangelogDialog(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "ocu-cl-overlay hidden";
  el.id = "ocu-changelog";
  el.dataset.ocuClUrl = "";
  el.innerHTML =
    '<div class="ocu-cl-dialog" role="dialog" aria-modal="true" aria-labelledby="ocu-cl-title">' +
    '<div class="ocu-cl-head"><span id="ocu-cl-title"></span>' +
    '<button type="button" class="ocu-cl-copy hidden" data-ocu-cl="copy" aria-label="' +
    escapeHtml(t("changelogCopy", "Copy changelog")) +
    '">' +
    ICONS.copy +
    '<span class="ocu-copy-label">' +
    escapeHtml(t("copy", "Copy")) +
    "</span></button>" +
    '<button type="button" class="ocu-cl-send hidden" data-ocu-cl="send" aria-label="' +
    escapeHtml(t("changelogSend", "Send to OpenCode")) +
    '">' +
    ICONS.send +
    '<span class="ocu-copy-label">' +
    escapeHtml(t("changelogSend", "Send to OpenCode")) +
    "</span></button>" +
    '<button type="button" class="ocu-cl-x" data-ocu-cl="close" aria-label="' +
    escapeHtml(t("closeLabel", "Close")) +
    '">' +
    ICONS.x +
    "</button></div>" +
    '<div class="ocu-cl-body" id="ocu-cl-body" tabindex="0"></div>' +
    '<div class="ocu-cl-foot"><span class="ocu-cl-status" id="ocu-cl-status" role="status"></span>' +
    '<button type="button" class="ocu-btn" data-ocu-cl="check">' +
    escapeHtml(t("changelogCheck", "Check for new version")) +
    "</button></div>" +
    "</div>";

  el.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const act = target.closest<HTMLElement>("[data-ocu-cl]");
    if (act) {
      const action = act.dataset.ocuCl;
      if (action === "close") {
        hideChangelogDialog();
      } else if (action === "check") {
        if (!changelogCheckFromDialog) {
          changelogCheckFromDialog = true;
          setChangelogCheckUi("checking");
          postMessage({ type: "checkOpenCodeUpdates" });
        }
      } else if (action === "copy") {
        const text = changelogPlainText(el);
        if (text) {
          copyText(text, act);
        }
      } else if (action === "send") {
        const text = changelogPlainText(el);
        if (text) {
          postMessage({
            type: "sendChangelogToOpenCode",
            text:
              text +
              "\n---\n" +
              format(
                t(
                  "changelogSendPrompt",
                  "The above is the OpenCode {0} changelog. Please summarize it.",
                ),
                changelogVersion,
              ),
          });
          flashSendLabel(act);
          hideChangelogDialog();
        }
      } else if (action === "open") {
        const url = el.dataset.ocuClUrl ?? "";
        if (url) {
          postMessage({ type: "openUrl", url });
        }
      }
      return;
    }
    // Release-note links point at GitHub: route them through the host's
    // external opener instead of navigating the webview.
    const link = target.closest<HTMLAnchorElement>("a[href]");
    if (link) {
      e.preventDefault();
      const href = link.getAttribute("href") ?? "";
      if (/^https?:/i.test(href)) {
        postMessage({ type: "openUrl", url: href });
      }
      return;
    }
    if (e.target === el) {
      hideChangelogDialog();
    }
  });

  document.body.appendChild(el);
  return el;
}

function openChangelogDialog(options?: { hideCheck?: boolean }): void {
  if (!changelogDialog) {
    changelogDialog = buildChangelogDialog();
  }
  changelogDialog.dataset.ocuClUrl = "";
  changelogVersion = "";
  const title = changelogDialog.querySelector<HTMLElement>("#ocu-cl-title");
  const body = changelogDialog.querySelector<HTMLElement>("#ocu-cl-body");
  // Nothing copyable/sendable until the payload lands; reset the footer check.
  changelogDialog
    .querySelectorAll(".ocu-cl-copy, .ocu-cl-send")
    .forEach((btn) => btn.classList.add("hidden"));
  setChangelogSendEnabled(!changelogRestartPending);
  // Inside the update flow (method-popover entry) a pending update is
  // already known, so the footer's check action stays hidden.
  changelogDialog
    .querySelector(".ocu-cl-foot")
    ?.classList.toggle("hidden", options?.hideCheck === true);
  setChangelogCheckUi("idle");
  if (title) {
    title.textContent = t("changelogLabel", "Changelog");
  }
  if (body) {
    body.innerHTML =
      '<p class="ocu-cl-msg">' +
      escapeHtml(t("changelogLoading", "Fetching changelog…")) +
      "</p>";
  }
  changelogDialog.classList.remove("hidden");
  changelogDialog
    .querySelector<HTMLButtonElement>('[data-ocu-cl="close"]')
    ?.focus();
}

function hideChangelogDialog(): void {
  changelogDialog?.classList.add("hidden");
}

/** Title + body as plain text, shared by the copy and send actions. */
function changelogPlainText(dialog: HTMLElement): string {
  const title = dialog.querySelector<HTMLElement>("#ocu-cl-title");
  const body = dialog.querySelector<
    HTMLElement & { innerText?: string }
  >("#ocu-cl-body");
  // innerText keeps the rendered line breaks; textContent would mash
  // block elements into one run-on line.
  const bodyText = body?.innerText ?? body?.textContent ?? "";
  return (
    (title?.textContent ?? "") +
    "\n\n" +
    bodyText
  ).trim();
}

/** Brief "Sent" feedback on the send button label. */
function flashSendLabel(button: HTMLElement): void {
  const label = button.querySelector<HTMLElement>(".ocu-copy-label");
  if (!label) {
    return;
  }
  label.textContent = t("changelogSentLabel", "Sent");
  setTimeout(() => {
    label.textContent = t("changelogSend", "Send to OpenCode");
  }, 1600);
}

/** Footer state for the dialog's own check-for-updates action. */
function setChangelogCheckUi(
  kind: "idle" | "checking" | "upToDate" | "failed",
): void {  const dialog = changelogDialog;
  if (!dialog) {
    return;
  }
  const statusEl = dialog.querySelector<HTMLElement>("#ocu-cl-status");
  const checkBtn = dialog.querySelector<HTMLButtonElement>(
    '[data-ocu-cl="check"]',
  );
  if (statusEl) {
    statusEl.textContent =
      kind === "checking"
        ? t("checkingUpdates", "Checking for updates…")
        : kind === "upToDate"
          ? t("changelogUpToDate", "Already on the latest version.")
          : kind === "failed"
            ? t("changelogCheckFailed", "Check failed. Try again later.")
            : "";
  }
  if (checkBtn) {
    checkBtn.disabled = kind === "checking";
  }
}

/** Reflects session readiness on the dialog's send action. */
function setChangelogSendEnabled(enabled: boolean): void {
  const sendBtn = changelogDialog?.querySelector<HTMLButtonElement>(
    '[data-ocu-cl="send"]',
  );
  if (!sendBtn) {
    return;
  }
  sendBtn.disabled = !enabled;
  sendBtn.title = enabled
    ? ""
    : t("changelogRestarting", "Session is restarting…");
}

/**
 * Sending needs a live session, so the dialog's send action waits out
 * the post-update restart and re-arms once the new session is up.
 */
function markChangelogRestartPending(): void {
  changelogRestartPending = true;
  setChangelogSendEnabled(false);
  // Safety valve: a restart that never completes must not leave the
  // send action disabled forever.
  if (changelogRestartTimer !== null) {
    clearTimeout(changelogRestartTimer);
  }
  changelogRestartTimer = setTimeout(() => {
    changelogRestartTimer = null;
    changelogRestartPending = false;
    setChangelogSendEnabled(true);
  }, 60_000);
}

/** Session lifecycle hook: the restarted session accepts sends again. */
export function notifyOpenCodeSessionStarted(): void {
  if (changelogRestartTimer !== null) {
    clearTimeout(changelogRestartTimer);
    changelogRestartTimer = null;
  }
  if (!changelogRestartPending) {
    return;
  }
  changelogRestartPending = false;
  setChangelogSendEnabled(true);
}

// ── Clipboard ──

function copyText(text: string, button: HTMLElement): void {
  const label = button.querySelector(".ocu-copy-label");
  const done = (ok: boolean): void => {
    if (label) {
      label.textContent = ok
        ? t("copied", "Copied")
        : t("copyFailed", "Copy failed");
      setTimeout(() => {
        label.textContent = t("copy", "Copy");
      }, 1600);
    }
  };
  const fallback = (): void => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      done(ok);
    } catch {
      done(false);
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => done(true),
      () => fallback(),
    );
  } else {
    fallback();
  }
}

// ── Focus trap ──

function trapCycle(root: HTMLElement, e: KeyboardEvent): void {
  const focusables = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, [tabindex]',
    ),
  ).filter(
    (el) =>
      !(el as HTMLButtonElement).disabled &&
      el.getAttribute("tabindex") !== "-1" &&
      el.closest(".hidden") === null,
  );
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// ── Events ──

function bindEvents(): void {
  pill?.addEventListener("click", () => {
    if (cardMode === "checking") return;
    if (!status) return;
    if (isBusyState(status.state)) {
      // State B: the toolbar progress line carries the live status; the
      // pill toggles the log drawer for the step history.
      if (drawer && !drawer.classList.contains("hidden")) {
        closeDrawer(false);
      } else {
        openDrawer();
      }
      return;
    }
    if (isPopoverState(status.state)) {
      openPopover();
      return;
    }
    if (status.state === "success") {
      // Leave the restart prompt cleanly (same as "Later") before the
      // re-check replaces the card, so the update flow is not dropped
      // silently on the host side.
      hideCardFull();
      postMessage({ type: "dismissOpenCodeUpdate" });
    }
    // failed/idle/success: the pill opens the current version's notes;
    // the check-for-updates action lives inside the changelog dialog.
    closePopover(false);
    openChangelogDialog();
    postMessage({ type: "requestOpenCodeChangelog" });
  });

  card?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const act = target.closest<HTMLElement>("[data-ocu-act]");
    if (act) {
      const action = act.dataset.ocuAct;
      if (action === "x") {
        if (cardMode === "success") {
          // Same as Esc on the success card: dismiss the flow entirely.
          hideCardFull();
          postMessage({ type: "dismissOpenCodeUpdate" });
        } else {
          hideCardFull();
        }
      } else if (action === "restart") {
        hideCardFull();
        postMessage({ type: "restartAfterUpdate" });
      } else if (action === "restart-changelog") {
        // One click, both jobs: ask for the notes first (the version
        // fields are still set), then restart behind the open dialog.
        hideCardFull();
        openChangelogDialog({ hideCheck: true });
        markChangelogRestartPending();
        postMessage({ type: "requestOpenCodeChangelog" });
        postMessage({ type: "restartAfterUpdate" });
      } else if (action === "changelog") {
        hideCardFull();
        openChangelogDialog({ hideCheck: true });
        postMessage({ type: "requestOpenCodeChangelog" });
      } else if (action === "later") {
        hideCardFull();
        postMessage({ type: "dismissOpenCodeUpdate" });
      } else if (action === "abandon") {
        postMessage({ type: "abandonOpenCodeUpdate" });
        showHintCard(t("abandonedHint", "Install abandoned"));
      } else if (action === "viewlog") {
        openDrawer();
      } else if (action === "gotit") {
        hideCardFull();
      }
      return;
    }
    const copyBtn = target.closest<HTMLElement>("[data-ocu-copy]");
    if (copyBtn) {
      copyText(copyBtn.dataset.ocuCopy ?? "", copyBtn);
    }
  });

  popover?.addEventListener("keydown", (e) => {
    const rows = popRows();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setPopoverFocused(popFocused + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setPopoverFocused(popFocused - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      setPopoverFocused(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setPopoverFocused(rows.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[popFocused];
      if (row) chooseMethod(row.dataset.ocuMethod ?? "");
    }
  });

  popList?.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-ocu-method]");
    if (row) chooseMethod(row.dataset.ocuMethod ?? "");
  });

  popover?.querySelector("#ocu-pop-close")?.addEventListener("click", () => {
    closePopover(true);
  });

  popover?.querySelector("#ocu-pop-cancel")?.addEventListener("click", () => {
    closePopover(true);
  });

  popover?.querySelector("#ocu-pop-changelog")?.addEventListener("click", () => {
    closePopover(false);
    openChangelogDialog({ hideCheck: true });
    postMessage({ type: "requestOpenCodeChangelog" });
  });

  drawer?.querySelector("#ocu-drawer-close")?.addEventListener("click", () => {
    closeDrawer(true);
  });

  document.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (
      popover &&
      !popover.classList.contains("hidden") &&
      !popover.contains(target) &&
      !(pill && pill.contains(target))
    ) {
      closePopover(true);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (installPrompt && !installPrompt.classList.contains("hidden")) {
      if (e.key === "Escape") {
        e.preventDefault();
        answerInstallPrompt("notNow");
      } else if (e.key === "Tab") {
        trapCycle(installPrompt, e);
      }
      return;
    }
    if (changelogDialog && !changelogDialog.classList.contains("hidden")) {
      if (e.key === "Escape") {
        e.preventDefault();
        hideChangelogDialog();
      } else if (e.key === "Tab") {
        trapCycle(changelogDialog, e);
      }
      return;
    }
    if (popover && !popover.classList.contains("hidden")) {
      if (e.key === "Escape") {
        e.preventDefault();
        closePopover(true);
      } else if (e.key === "Tab") {
        trapCycle(popover, e);
      }
      return;
    }
    if (drawer && !drawer.classList.contains("hidden")) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeDrawer(true);
      } else if (e.key === "Tab") {
        trapCycle(drawer, e);
      }
      return;
    }
    if (card && !card.classList.contains("hidden") && e.key === "Escape") {
      e.preventDefault();
      if (cardMode === "success") {
        hideCardFull();
        postMessage({ type: "dismissOpenCodeUpdate" });
      } else {
        hideCardFull();
      }
    }
  });

  window.addEventListener("resize", () => {
    if (popover && !popover.classList.contains("hidden")) positionPopover();
  });
}
