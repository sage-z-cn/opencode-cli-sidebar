/**
 * OpenCode self-update UI (webview side).
 *
 * Browser-only; all host I/O goes through WebviewMessage. Every step of
 * the flow lives in one modal dialog: release notes, method choice,
 * progress with a live output pane, and the result. The version pill is
 * the only entry; a minimized progress line keeps a running upgrade
 * reachable without blocking the terminal.
 */
import type {
  CliInstallPromptAction,
  OpenCodeChangelogPayload,
  OpenCodeUpdateUiStatus,
} from "../../types";
import { postMessage } from "../shared/vscode-api";
import { ICONS as LUCIDE_ICONS, icon } from "../shared/icons";
import { UpdateDialogShell, trapFocus } from "./dialog";

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
const ABORT_ARM_MS = 5000;
const MAX_OUTPUT_LINES = 200;

const ICONS = {
  check: icon(LUCIDE_ICONS.check, 13),
  x: icon(LUCIDE_ICONS.x, 13),
  sync: icon(LUCIDE_ICONS.refresh, 13),
  info: icon(LUCIDE_ICONS.info, 13),
  error: icon(LUCIDE_ICONS.circleX, 13),
  copy: icon(LUCIDE_ICONS.copy, 13),
  send: icon(LUCIDE_ICONS.send, 13),
  browser: icon(LUCIDE_ICONS.globe, 13),
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
/** Minimized progress line right of the version pill. */
let progressLine: HTMLButtonElement | null = null;
let card: HTMLElement | null = null;
let liveRegion: HTMLElement | null = null;
let dialog: UpdateDialogShell | null = null;

type DialogStep = "notes" | "methods" | "progress";

let dialogStep: DialogStep | null = null;
/** Install flows have no release notes and start at the method step. */
let flowKind: "update" | "install" = "update";
/** Which release the notes step describes. */
let notesMode: "upcoming" | "installed" = "upcoming";
let notesState: "loading" | "ready" | "failed" = "loading";
let notesPayload: OpenCodeChangelogPayload | null = null;
let notesUrl = "";
/** True when the progress dialog is collapsed to the toolbar line. */
let minimized = false;
/** Upgrade/install output tail for the dialog log pane. */
let outputLines: string[] = [];
/** Two-step abort: first click arms, second click abandons. */
let abortArmed = false;
let abortTimer: ReturnType<typeof setTimeout> | null = null;
/** True while a start request is waiting for the host's first push. */
let startingUpdate = false;
/** True while the notes-step check-for-updates round-trip runs. */
let checkPending = false;
let checkUpToDate = false;
let checkFailed = false;
/** Keyboard position inside the method list. */
let methodFocused = 0;

type CardMode = "hint" | "checking";
let cardMode: CardMode | null = null;
let hintTimer: ReturnType<typeof setTimeout> | null = null;

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

  progressLine = document.createElement("button");
  progressLine.type = "button";
  progressLine.className = "ocu-progress hidden";
  progressLine.id = "ocu-progress";
  progressLine.setAttribute("role", "status");
  pill?.insertAdjacentElement("afterend", progressLine);
  progressLine.addEventListener("click", () => {
    if (status?.state !== "updating") return;
    minimized = false;
    dialogStep = "progress";
    renderDialog(true);
    renderProgressLine();
  });

  liveRegion = document.createElement("div");
  liveRegion.className = "ocu-sr-only";
  liveRegion.setAttribute("aria-live", "polite");
  document.body.appendChild(liveRegion);

  dialog = new UpdateDialogShell({
    onAction: handleDialogAction,
    onMinimize: minimizeDialog,
    onDismiss: dismissDialog,
    onKeyDown: handleDialogKeyDown,
  });

  card = document.createElement("section");
  card.className = "ocu-card hidden";
  card.id = "ocu-card";
  card.setAttribute("role", "status");
  document.getElementById("terminal-container")?.appendChild(card);

  bindEvents();
  bindGlobalKeys();

  postMessage({ type: "requestOpenCodeUpdateStatus" });
}

// ── Status entry point ──

function isBusyState(state: string): boolean {
  return state === "updating";
}

export function applyOpenCodeUpdateStatus(next: OpenCodeUpdateUiStatus): void {
  status = status ? { ...status, ...next } : { ...next };
  const st = status;

  // 重启确认只在成功态有意义；任何把流程推走的状态都顺手收掉它
  if (st.state !== "success") {
    hideRestartPrompt();
  }

  maybeShowInstallPrompt();
  finishInstallPromptRetry();
  renderPill();
  updateMenuGate();

  if (isBusyState(st.state)) {
    if (dialogStep !== "progress") {
      outputLines = [];
      minimized = false;
    }
    if (st.step === "installing") {
      flowKind = "install";
    }
    const stepChanged = dialogStep !== "progress";
    dialogStep = "progress";
    startingUpdate = false;
    renderDialog(stepChanged);
    if (stepChanged) {
      announce(progressStepText());
    }
  } else if (st.state === "success" || st.state === "failed") {
    startingUpdate = false;
    // 成功和失败都在步骤弹窗内收尾：步骤列表与输出保留，页脚换成确认
    const stepChanged = dialogStep !== "progress";
    dialogStep = "progress";
    minimized = false;
    renderDialog(stepChanged);
  } else if (st.state === "available") {
    startingUpdate = false;
    if (dialogStep === "progress") {
      dialogStep = null;
      dialog?.hide();
    }
    if (!checkPending && next.openUpdateDialog === "notes" && dialogStep !== "notes") {
      openUpcomingNotes();
    } else if (dialogStep === "notes" && notesMode === "upcoming") {
      renderDialog(false);
    }
  } else if (st.state === "idle") {
    startingUpdate = false;
    minimized = false;
    if (dialogStep === "progress") {
      dialogStep = null;
      dialog?.hide();
    }
  } else if (st.state === "installable") {
    startingUpdate = false;
    minimized = false;
    if (dialogStep === "progress") {
      dialogStep = null;
      dialog?.hide();
    }
  }

  if (checkPending && st.state !== "updating") {
    checkPending = false;
    if (st.state === "available") {
      openUpcomingNotes();
    } else {
      checkUpToDate = next.checkOutcome === "upToDate";
      checkFailed = !checkUpToDate;
      renderDialog(false);
    }
  }

  renderProgressLine();
  const notice = next.notice;
  if (notice) {
    showHintCard(notice);
  } else if (
    cardMode === "checking" &&
    (st.state === "available" ||
      st.state === "idle" ||
      st.state === "installable")
  ) {
    hideCardFull();
  }

  if (!dialog?.visible && dialogStep) {
    renderDialog(false);
  }
}

/** Settings dropdown item was clicked; show local pending state immediately. */
export function notifyOpenCodeUpdateCheckRequested(): void {
  if (!status || isBusyState(status.state)) return;
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
      : firstNonEmpty(st.installedVersion, st.currentVersion, st.runningVersion);

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

// ── Minimized progress line ──

/** Canonical step order per flow, for the step-count progress readout. */
const UPDATE_STEP_ORDER = [
  "prepare-target",
  "prepare-local",
  "execute",
  "reshim",
  "verify",
];
const INSTALL_STEP_ORDER = ["installing", "reshim", "verify"];

function progressStepCount(): string {
  const stepId = status?.step ?? "";
  if (!stepId) return "";
  const history = status?.history ?? [];
  const fromInstall =
    flowKind === "install" ||
    stepId === "installing" ||
    history[0]?.step === "installing";
  const order = fromInstall ? INSTALL_STEP_ORDER : UPDATE_STEP_ORDER;
  let index = order.indexOf(stepId);
  if (index < 0) {
    index = Math.max(order.indexOf("reshim"), 1);
  }
  return `${index + 1}/${order.length}`;
}

function progressStepText(): string {
  const stepId = status?.step ?? "";
  return STEP_LABELS[stepId] ?? status?.detail ?? stepId;
}

/**
 * The toolbar line is the minimized form of the progress step. It is
 * hidden while the dialog is open and shown once the user minimizes.
 */
function renderProgressLine(): void {
  if (!progressLine) return;
  const st = status;
  if (!st || !isBusyState(st.state) || !minimized) {
    progressLine.classList.add("hidden");
    progressLine.innerHTML = "";
    return;
  }
  const countText = progressStepCount();
  const stepText = progressStepText();
  progressLine.innerHTML =
    '<span class="ocu-progress-spin" aria-hidden="true">' +
    ICONS.sync +
    "</span>" +
    '<span class="ocu-progress-text">' +
    escapeHtml(countText ? stepText + " " + countText : stepText) +
    "</span>";
  progressLine.classList.remove("hidden");
  progressLine.setAttribute(
    "aria-label",
    t("viewProgressLabel", "View install progress"),
  );
}

// ── Hint card ──

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

function cardHead(kind: "prog" | "info", title: string): string {
  const iconHtml =
    kind === "prog"
      ? ""
      : '<span class="ocu-card-ic ocu-ic-info">' + ICONS.info + "</span>";
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
      hideCardFull();
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

// ── Dialog: state helpers ──

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value) return value;
  }
  return "";
}

function updateTargetVersion(): string {
  return firstNonEmpty(status?.targetVersion, status?.latestVersion);
}

function installedVersion(): string {
  return firstNonEmpty(
    status?.installedVersion,
    status?.currentVersion,
    status?.runningVersion,
  );
}

function closeDialog(): void {
  dialogStep = null;
  minimized = false;
  abortArmed = false;
  if (abortTimer !== null) {
    clearTimeout(abortTimer);
    abortTimer = null;
  }
  dialog?.hide();
}

function dismissDialog(): void {
  checkPending = false;
  checkUpToDate = false;
  checkFailed = false;
  if (status?.state === "success") {
    postMessage({ type: "dismissOpenCodeUpdate" });
  }
  closeDialog();
  if (pill && !pill.disabled) pill.focus();
}

function minimizeDialog(): void {
  if (dialogStep !== "progress") {
    dismissDialog();
    return;
  }
  minimized = true;
  dialog?.hide();
  renderProgressLine();
  if (pill && !pill.disabled) pill.focus();
}

function openUpcomingNotes(): void {
  flowKind = "update";
  notesMode = "upcoming";
  notesState = "loading";
  notesPayload = null;
  notesUrl = "";
  checkPending = false;
  checkFailed = false;
  checkUpToDate = false;
  dialogStep = "notes";
  minimized = false;
  renderDialog(true);
  requestNotes(updateTargetVersion(), "upcoming");
}

function openInstalledNotes(): void {
  notesMode = "installed";
  notesState = "loading";
  notesPayload = null;
  notesUrl = "";
  checkPending = false;
  checkFailed = false;
  checkUpToDate = false;
  dialogStep = "notes";
  minimized = false;
  renderDialog(true);
  requestNotes(installedVersion(), "installed");
}

function requestNotes(
  version: string | undefined,
  mode: "upcoming" | "installed",
): void {
  postMessage({
    type: "requestOpenCodeChangelog",
    version: version || undefined,
    mode,
  });
}

function openMethodStep(): void {
  dialogStep = "methods";
  startingUpdate = false;
  minimized = false;
  methodFocused = preferredMethodIndex();
  renderDialog(true);
}

function openOutcomeStep(): void {
  dialogStep = "progress";
  minimized = false;
  renderDialog(true);
}

// ── Dialog: content builders ──

function renderDialog(stepChanged: boolean): void {
  if (!dialog) return;
  if (!dialogStep) {
    dialog.hide();
    return;
  }
  if (minimized && dialogStep === "progress") {
    dialog.hide();
    return;
  }
  const content = buildDialogContent();
  const showsNow = !dialog.visible;
  if (showsNow) {
    dialog.show(content);
  } else {
    dialog.update(content);
  }
  if (stepChanged && content.focus) {
    dialog.focus(content.focus);
  }
}

function buildDialogContent(): {
  title: string;
  headActions?: string;
  body: string;
  foot: string;
  progress?: boolean;
  focus?: string;
  closeLabel?: string;
} {
  switch (dialogStep) {
    case "notes":
      return buildNotesContent();
    case "methods":
      return buildMethodsContent();
    case "progress":
      return buildProgressContent();
    default:
      return {
        title: t("changelogLabel", "Changelog"),
        body: "",
        foot: "",
        closeLabel: t("closeLabel", "Close"),
      };
  }
}

function headActionButton(
  action: string,
  label: string,
  glyph: string,
): string {
  const text = escapeHtml(label);
  return (
    '<button type="button" class="ocu-dlg-head-btn" data-ocu-dlg="' +
    action +
    '" aria-label="' +
    text +
    '" title="' +
    text +
    '">' +
    glyph +
    "</button>"
  );
}

function buildNotesContent(): {
  title: string;
  headActions?: string;
  body: string;
  foot: string;
  focus?: string;
  closeLabel?: string;
} {
  const upcoming = notesMode === "upcoming";
  const version = notesPayload?.version || (upcoming ? updateTargetVersion() : installedVersion());
  const title = version ? "OpenCode " + version : t("changelogLabel", "Changelog");

  const openUrl = notesPayload?.fallbackUrl || notesUrl;
  const browserButton = openUrl
    ? headActionButton(
        "open",
        t("changelogOpenInBrowser", "Open in browser"),
        ICONS.browser,
      )
    : "";
  const headActions =
    (notesState === "ready"
      ? headActionButton(
          "send",
          t("changelogSend", "Send to OpenCode"),
          ICONS.send,
        ) + headActionButton("copy", t("copy", "Copy"), ICONS.copy)
      : "") + browserButton;

  let body = "";
  if (notesState === "ready" && notesPayload?.ok) {
    body +=
      (notesPayload.date
        ? '<p class="ocu-cl-date">' + escapeHtml(notesPayload.date) + "</p>"
        : "") + (notesPayload.html ?? "");
  } else if (notesState === "failed") {
    body +=
      '<p class="ocu-cl-msg">' +
      escapeHtml(
        upcoming
          ? t(
              "notesUnavailable",
              "Release notes are unavailable for this version. You can still update.",
            )
          : t("changelogFailed", "Changelog is unavailable for this version."),
      ) +
      "</p>";
  } else {
    body +=
      '<p class="ocu-cl-msg">' +
      escapeHtml(t("changelogLoading", "Fetching changelog…")) +
      "</p>";
  }

  let foot = "";
  if (upcoming) {
    // Primary action sits last so it lands in the dialog's bottom-right
    // corner; the browser fallback lives in the head next to close.
    foot =
      '<div class="ocu-dlg-foot-main">' +
      '<button type="button" class="ocu-btn ocu-btn-primary" data-ocu-dlg="update">' +
      escapeHtml(t("updateAction", "Update")) +
      "</button></div>";
  } else {
    const stateText = checkPending
      ? t("checkingUpdates", "Checking for updates…")
      : checkUpToDate
        ? t("changelogUpToDate", "Already on the latest version.")
        : checkFailed
          ? t("changelogCheckFailed", "Check failed. Try again later.")
          : "";
    foot =
      '<div class="ocu-dlg-foot-main"><span class="ocu-cl-status">' +
      escapeHtml(stateText) +
      '</span><button type="button" class="ocu-btn" data-ocu-dlg="check"' +
      (checkPending ? " disabled" : "") +
      ">" +
      escapeHtml(t("changelogCheck", "Check for new version")) +
      "</button></div>";
  }

  return {
    title,
    headActions: headActions || undefined,
    body: '<div class="ocu-cl-body">' + body + "</div>",
    foot,
    focus: upcoming ? '[data-ocu-dlg="update"]' : '[data-ocu-dlg="check"]',
    closeLabel: t("closeLabel", "Close"),
  };
}

function methods(): string[] {
  const list = status?.methods;
  return list && list.length ? list : DEFAULT_METHODS;
}

/** Preselection: last used method, then detected, then the host default. */
function preferredMethodIndex(): number {
  const preferred =
    status?.lastUsedMethod ??
    status?.detectedMethod ??
    status?.defaultMethod ??
    "npm";
  return Math.max(0, methods().indexOf(preferred));
}

function buildMethodsContent(): {
  title: string;
  body: string;
  foot: string;
  focus?: string;
  closeLabel?: string;
} {
  const title =
    flowKind === "install"
      ? t("installMethodTitle", "Select install method")
      : t("updateMethodTitle", "Select update method");

  const det = status?.detectedMethod ?? "";
  const last = status?.lastUsedMethod ?? "";
  let rows = "";
  methods().forEach((id, i) => {
    const isLast = Boolean(last) && id === last;
    const isDet = Boolean(det) && id === det;
    let tags = "";
    if (isLast) {
      tags +=
        '<span class="ocu-tag ocu-tag-last">' +
        escapeHtml(t("methodLastUsed", "Last used")) +
        "</span>";
    } else if (isDet) {
      tags +=
        '<span class="ocu-tag ocu-tag-det">' +
        escapeHtml(t("methodDetected", "Detected install method")) +
        "</span>";
    }
    let desc = METHOD_DESCS[id] ?? "";
    if (isLast && isDet) {
      desc += " · " + t("methodDetected", "Detected install method");
    }
    rows +=
      '<button type="button" class="ocu-pop-row' +
      (i === methodFocused ? " is-focused" : "") +
      '" role="option" aria-selected="' +
      (i === methodFocused) +
      '" data-ocu-dlg="method" data-ocu-method="' +
      escapeHtml(id) +
      '" tabindex="' +
      (i === methodFocused ? 0 : -1) +
      '"' +
      (startingUpdate ? " disabled" : "") +
      ">" +
      '<span class="ocu-pop-main"><span class="ocu-pop-label">' +
      escapeHtml(id) +
      "</span>" +
      tags +
      '<span class="ocu-pop-ok' +
      (i === methodFocused ? "" : " hidden") +
      '">' +
      ICONS.check +
      "</span></span>" +
      (desc
        ? '<span class="ocu-pop-desc" title="' +
          escapeHtml(desc) +
          '">' +
          escapeHtml(desc) +
          "</span>"
        : "") +
      "</button>";
  });

  return {
    title,
    body: '<div class="ocu-dlg-methods" role="listbox">' + rows + "</div>",
    foot:
      '<div class="ocu-dlg-foot-main"><span class="ocu-pop-hint">' +
      escapeHtml(t("hintConfirm", "Enter to confirm")) +
      '</span><button type="button" class="ocu-btn ocu-btn-primary" data-ocu-dlg="confirm"' +
      (startingUpdate ? " disabled" : "") +
      ">" +
      escapeHtml(t("confirmLabel", "Confirm")) +
      "</button></div>",
    focus: "[data-ocu-method]",
    closeLabel: t("closeLabel", "Close"),
  };
}

function buildProgressContent(): {
  title: string;
  headActions?: string;
  body: string;
  foot: string;
  progress: boolean;
  focus?: string;
  closeLabel?: string;
} {
  const st = status;
  const busy = isBusyState(st?.state ?? "");
  const target = updateTargetVersion();
  // 收尾标题只认真正装上去了的版本；失败时不能拿目标版本冒充已安装
  const installed = st?.installedVersion ?? "";
  const title = busy
    ? flowKind === "install"
      ? t("installProgressTitle", "Installing OpenCode")
      : target
        ? format(t("updateProgressTitle", "Updating OpenCode to {0}"), target)
        : t("updateProgressPlainTitle", "Updating OpenCode")
    : installed
      ? "OpenCode " + installed
      : t("updateProgressPlainTitle", "Updating OpenCode");

  const history = st?.history ?? [];
  let steps = "";
  for (const entry of history) {
    steps +=
      '<li class="ocu-dlg-step ' +
      (entry.ok ? "is-done" : "is-failed") +
      '"><span class="ocu-dlg-step-ic">' +
      (entry.ok ? ICONS.check : ICONS.x) +
      "</span>" +
      escapeHtml(entry.label || STEP_LABELS[entry.step] || entry.step) +
      "</li>";
  }
  if (busy) {
    steps +=
      '<li class="ocu-dlg-step is-active"><span class="ocu-dlg-step-spin">' +
      ICONS.sync +
      "</span>" +
      escapeHtml(progressStepText()) +
      '<span class="ocu-dlg-step-count">' +
      escapeHtml(progressStepCount()) +
      "</span></li>";
  }

  const logLines = outputLines
    .map((line) => '<div class="ocu-dlg-log-line">' + escapeHtml(line) + "</div>")
    .join("");

  const body =
    '<div class="ocu-dlg-progress"><div class="ocu-dlg-status">' +
    resultBanner(st) +
    '<ul class="ocu-dlg-steps">' +
    steps +
    "</ul>" +
    failureOutcome(st) +
    "</div>" +
    '<div class="ocu-dlg-output" data-ocu-log>' +
    logLines +
    "</div></div>";

  return {
    title,
    headActions: busy
      ? '<button type="button" class="ocu-dlg-head-btn" data-ocu-dlg="minimize">' +
        escapeHtml(t("minimize", "Minimize")) +
        "</button>"
      : "",
    body,
    foot: busy ? abortFoot() : finishFoot(),
    progress: busy,
    focus: ".ocu-dlg-body",
    closeLabel: busy
      ? t("minimize", "Minimize")
      : t("closeLabel", "Close"),
  };
}

/** 进行中：左下角的二次确认中止按钮 */
function abortFoot(): string {
  return (
    '<div class="ocu-dlg-foot-main"><button type="button" class="ocu-dlg-danger" data-ocu-dlg="abort"' +
    (abortArmed ? ' data-armed="true"' : "") +
    ">" +
    escapeHtml(
      abortArmed
        ? t("abortConfirm", "Click again to abort")
        : flowKind === "install"
          ? t("abandonUpdate", "Abandon install")
          : t("abortUpdate", "Abort update"),
    ) +
    "</button></div>"
  );
}

/** 收尾：步骤弹窗右下角只留一个确认按钮 */
function finishFoot(): string {
  return (
    '<div class="ocu-dlg-foot-main"><button type="button" class="ocu-btn ocu-btn-primary" data-ocu-dlg="finish">' +
    escapeHtml(t("confirmLabel", "Confirm")) +
    "</button></div>"
  );
}

/**
 * 结果横幅：成功或失败在步骤列表上方直接给一句结论，不必让用户从步骤
 * 图标或日志里推断。
 */
function resultBanner(st: OpenCodeUpdateUiStatus | null): string {
  if (!st || isBusyState(st.state)) return "";
  const installing = flowKind === "install";
  if (st.state === "success") {
    const version = firstNonEmpty(st.installedVersion, st.targetVersion);
    const text = installing
      ? format(t("installSucceeded", "OpenCode {0} installed"), version)
      : format(t("updateSucceeded", "OpenCode {0} updated"), version);
    return (
      '<p class="ocu-dlg-result is-ok">' +
      ICONS.check +
      "<span>" +
      escapeHtml(text.replace(/\s+/g, " ").trim()) +
      "</span></p>"
    );
  }
  if (st.state === "failed") {
    return (
      '<p class="ocu-dlg-result is-bad">' +
      ICONS.error +
      "<span>" +
      escapeHtml(
        installing
          ? t("installFailedResult", "Installation failed")
          : t("updateFailedResult", "Update failed"),
      ) +
      "</span></p>"
    );
  }
  return "";
}

/**
 * 失败时在步骤与输出之间补一行说明，并保留需要手动执行的修复命令。
 */
function failureOutcome(st: OpenCodeUpdateUiStatus | null): string {
  if (st?.state !== "failed") return "";
  const commands = st.manualCommands?.length
    ? st.manualCommands
    : st.remediationCommands ?? [];
  let inner = "";
  if (commands.length) {
    inner +=
      '<p class="ocu-dlg-outcome-msg">' +
      escapeHtml(
        t(
          "remediateFailed",
          "Automatic fix did not succeed. Run the following commands in the terminal, then start the install again.",
        ),
      ) +
      "</p>";
    for (const cmd of commands) {
      inner +=
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
  } else if (st.detail) {
    inner +=
      '<p class="ocu-dlg-outcome-msg">' + escapeHtml(st.detail) + "</p>";
  }
  // 失败态页脚只有确认，重试放在这里，避免用户关掉弹窗后无处重新开始
  inner +=
    '<button type="button" class="ocu-dlg-retry" data-ocu-dlg="retry">' +
    escapeHtml(t("retryAction", "Retry")) +
    "</button>";
  return '<div class="ocu-dlg-outcome">' + inner + "</div>";
}

// ── Dialog: actions ──

function handleDialogAction(action: string, element: HTMLElement): void {
  if (action.startsWith("open-url:")) {
    postMessage({ type: "openUrl", url: action.slice("open-url:".length) });
    return;
  }
  switch (action) {
    case "update":
      openMethodStep();
      return;
    case "open": {
      const url = notesPayload?.fallbackUrl ?? notesUrl;
      if (url) postMessage({ type: "openUrl", url });
      return;
    }
    case "copy":
      copyText(dialog?.plainText() ?? "", element);
      return;
    case "send": {
      const text = dialog?.plainText() ?? "";
      if (!text) return;
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
            notesPayload?.version ?? "",
          ),
      });
      closeDialog();
      return;
    }
    case "check":
      if (checkPending) return;
      checkPending = true;
      checkFailed = false;
      checkUpToDate = false;
      renderDialog(false);
      postMessage({ type: "checkOpenCodeUpdates" });
      return;
    case "method": {
      if (startingUpdate) return;
      const rows = Array.from(
        dialog?.root.querySelectorAll<HTMLElement>("[data-ocu-method]") ?? [],
      );
      const index = rows.findIndex(
        (row) => row.dataset.ocuMethod === element.dataset.ocuMethod,
      );
      if (index < 0) return;
      setMethodFocused(index, rows);
      return;
    }
    case "confirm":
      startUpdateWithFocusedMethod();
      return;
    case "minimize":
      minimizeDialog();
      return;
    case "abort":
      if (!abortArmed) {
        abortArmed = true;
        renderDialog(false);
        if (abortTimer !== null) clearTimeout(abortTimer);
        abortTimer = setTimeout(() => {
          abortTimer = null;
          abortArmed = false;
          if (dialogStep === "progress") renderDialog(false);
        }, ABORT_ARM_MS);
        return;
      }
      abortArmed = false;
      if (abortTimer !== null) {
        clearTimeout(abortTimer);
        abortTimer = null;
      }
      postMessage({ type: "abandonOpenCodeUpdate" });
      showHintCard(t("abandonedHint", "Install abandoned"));
      closeDialog();
      return;
    case "finish": {
      // 成功后另开确认弹窗问是否重启；自动启动过则无需重启
      if (status?.state === "success" && !status.sessionAutoStarted) {
        showRestartPrompt();
        return;
      }
      dismissDialog();
      return;
    }
    case "retry":
      openMethodStep();
      return;
    default:
      return;
  }
}

function handleDialogKeyDown(event: KeyboardEvent): boolean {
  if (dialogStep !== "methods") return false;
  const rows = Array.from(
    dialog?.root.querySelectorAll<HTMLElement>("[data-ocu-method]") ?? [],
  );
  if (!rows.length) return false;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setMethodFocused(methodFocused + 1, rows);
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    setMethodFocused(methodFocused - 1, rows);
    return true;
  }
  if (event.key === "Home") {
    event.preventDefault();
    setMethodFocused(0, rows);
    return true;
  }
  if (event.key === "End") {
    event.preventDefault();
    setMethodFocused(rows.length - 1, rows);
    return true;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    startUpdateWithFocusedMethod();
    return true;
  }
  return false;
}

/** Starts the update with the method currently marked as selected. */
function startUpdateWithFocusedMethod(): void {
  if (startingUpdate || dialogStep !== "methods") return;
  const method = methods()[methodFocused];
  if (!method) return;
  startingUpdate = true;
  renderDialog(false);
  postMessage({ type: "startOpenCodeUpdate", method });
}

function setMethodFocused(index: number, rows: HTMLElement[]): void {
  if (!rows.length) return;
  methodFocused = (index + rows.length) % rows.length;
  rows.forEach((row, i) => {
    const on = i === methodFocused;
    row.classList.toggle("is-focused", on);
    row.setAttribute("aria-selected", on ? "true" : "false");
    row.tabIndex = on ? 0 : -1;
    row.querySelector(".ocu-pop-ok")?.classList.toggle("hidden", !on);
  });
  rows[methodFocused].focus();
  rows[methodFocused].scrollIntoView?.({ block: "nearest" });
}

// ── Changelog payload ──

/** Fills the notes step when the host answers the release-notes request. */
export function applyOpenCodeChangelog(payload: OpenCodeChangelogPayload): void {
  if (dialogStep !== "notes") {
    return;
  }
  notesPayload = payload;
  notesState = payload.ok ? "ready" : "failed";
  notesUrl = payload.fallbackUrl;
  if (payload.mode) {
    notesMode = payload.mode;
  }
  renderDialog(false);
  if (payload.ok) {
    announce("OpenCode " + payload.version);
  }
}

/** Streamed upgrade/install output for the progress log pane. */
export function appendOpenCodeUpdateOutput(lines: string[]): void {
  if (!lines.length) return;
  outputLines.push(...lines);
  if (outputLines.length > MAX_OUTPUT_LINES) {
    outputLines = outputLines.slice(outputLines.length - MAX_OUTPUT_LINES);
  }
  dialog?.appendOutput(lines);
}

// ── Missing-CLI install confirmation (srp-overlay pattern) ──

let installPrompt: HTMLDivElement | null = null;
/** 更新成功后的重启确认 overlay */
let restartPrompt: HTMLDivElement | null = null;
/** True while the install prompt's re-detect round-trip is in flight. */
let installPromptRetryActive = false;
let installPromptLastPending = false;

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
  const pending = inInstallable && status?.installPromptPending === true;
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
    showInstallPromptResult();
  }
}

function startInstallPromptRetry(): void {
  if (installPromptRetryActive) return;
  installPromptRetryActive = true;
  hideInstallPromptResult();
  setInstallPromptBusy(true);
  postMessage({ type: "retryCliProbe" });
}

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
    flowKind = "install";
    openMethodStep();
  }
}

// ── Restart confirmation after a successful update ──

function buildRestartPrompt(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "ocu-rp-overlay hidden";
  el.id = "ocu-restart-prompt";
  el.innerHTML =
    '<div class="ocu-rp-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ocu-rp-title" aria-describedby="ocu-rp-body">' +
    '<div class="ocu-rp-title" id="ocu-rp-title">' +
    escapeHtml(t("restartPromptTitle", "Restart the terminal?")) +
    "</div>" +
    '<div class="ocu-rp-body" id="ocu-rp-body">' +
    escapeHtml(
      t(
        "restartPromptBody",
        "Restart the terminal to start using the new version.",
      ),
    ) +
    "</div>" +
    '<div class="ocu-rp-actions">' +
    '<button type="button" class="ocu-rp-btn" data-ocu-rp="later">' +
    escapeHtml(t("later", "Later")) +
    "</button>" +
    '<button type="button" class="ocu-rp-btn ocu-rp-btn-primary" data-ocu-rp="restart">' +
    escapeHtml(t("restartNow", "Restart now")) +
    "</button>" +
    "</div></div>";

  el.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const action = target.closest<HTMLElement>("[data-ocu-rp]")?.dataset
      .ocuRp;
    if (action === "restart") {
      answerRestartPrompt(true);
      return;
    }
    // "Later" and a backdrop click both leave the running session alone.
    if (action === "later" || e.target === el) {
      answerRestartPrompt(false);
    }
  });

  document.body.appendChild(el);
  return el;
}

function showRestartPrompt(): void {
  if (!restartPrompt) restartPrompt = buildRestartPrompt();
  restartPrompt.classList.remove("hidden");
  restartPrompt
    .querySelector<HTMLButtonElement>('[data-ocu-rp="restart"]')
    ?.focus();
}

function hideRestartPrompt(): void {
  restartPrompt?.classList.add("hidden");
}

/** True while the restart confirmation overlay is visible. */
function isRestartPromptVisible(): boolean {
  return Boolean(restartPrompt && !restartPrompt.classList.contains("hidden"));
}

function answerRestartPrompt(restart: boolean): void {
  hideRestartPrompt();
  if (restart) {
    closeDialog();
    postMessage({ type: "restartAfterUpdate" });
    // 触发重启动作的按钮随弹窗一起隐藏，焦点交回工具栏
    if (pill && !pill.disabled) pill.focus();
    return;
  }
  dismissDialog();
}

// ── Clipboard ──

function copyText(text: string, button: HTMLElement): void {
  const label = button.querySelector(".ocu-copy-label");
  const done = (ok: boolean): void => {
    const message = ok ? t("copied", "Copied") : t("copyFailed", "Copy failed");
    if (!label) {
      flashHeadButton(button, message, ok);
      return;
    }
    label.textContent = message;
    setTimeout(() => {
      label.textContent = t("copy", "Copy");
    }, 1600);
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

/**
 * Icon-only head buttons have no room for a text swap, so a copy result
 * flashes a check or error glyph and temporarily repoints the tooltip.
 */
function flashHeadButton(
  button: HTMLElement,
  message: string,
  ok: boolean,
): void {
  if (button.dataset.ocuFlash === "1") return;
  const restoreGlyph = button.innerHTML;
  const restoreLabel = button.getAttribute("aria-label") ?? "";
  const restoreTitle = button.getAttribute("title") ?? "";
  button.dataset.ocuFlash = "1";
  button.innerHTML = ok ? ICONS.check : ICONS.error;
  button.setAttribute("aria-label", message);
  button.setAttribute("title", message);
  setTimeout(() => {
    delete button.dataset.ocuFlash;
    button.innerHTML = restoreGlyph;
    button.setAttribute("aria-label", restoreLabel);
    button.setAttribute("title", restoreTitle);
  }, 1600);
}

// ── Events ──

function bindEvents(): void {
  pill?.addEventListener("click", () => {
    if (!status) return;
    if (isBusyState(status.state)) {
      minimized = false;
      dialogStep = "progress";
      renderDialog(true);
      renderProgressLine();
      return;
    }
    if (status.state === "available") {
      openUpcomingNotes();
      return;
    }
    if (status.state === "failed") {
      // 有需要手动执行的命令时先展示失败现场；否则直接回到方式选择重试
      const hasRecovery = Boolean(
        status.manualCommands?.length || status.remediationCommands?.length,
      );
      if (hasRecovery) {
        openOutcomeStep();
      } else {
        openMethodStep();
      }
      return;
    }
    if (status.state === "success") {
      openOutcomeStep();
      return;
    }
    if (status.state === "installable") {
      flowKind = "install";
      openMethodStep();
      return;
    }
    openInstalledNotes();
  });

  card?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const act = target.closest<HTMLElement>("[data-ocu-act]");
    if (act && act.dataset.ocuAct === "x") {
      hideCardFull();
      return;
    }
    const copyBtn = target.closest<HTMLElement>("[data-ocu-copy]");
    if (copyBtn) {
      copyText(copyBtn.dataset.ocuCopy ?? "", copyBtn);
    }
  });
}

function bindGlobalKeys(): void {
  document.addEventListener("keydown", (e) => {
    if (installPrompt && !installPrompt.classList.contains("hidden")) {
      if (e.key === "Escape") {
        e.preventDefault();
        answerInstallPrompt("notNow");
      } else if (e.key === "Tab") {
        trapFocus(installPrompt, e);
      }
      return;
    }
    if (isRestartPromptVisible() && restartPrompt) {
      if (e.key === "Escape") {
        e.preventDefault();
        answerRestartPrompt(false);
      } else if (e.key === "Tab") {
        trapFocus(restartPrompt, e);
      }
      return;
    }
    if (dialog?.handleKeydown(e)) {
      return;
    }
    if (card && !card.classList.contains("hidden") && e.key === "Escape") {
      e.preventDefault();
      hideCardFull();
    }
  });
}
