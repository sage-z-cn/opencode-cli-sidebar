// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../shared/vscode-api", () => ({
  postMessage: vi.fn(),
  acquireVsCodeApi: vi.fn(() => ({ postMessage: vi.fn() })),
}));

import { postMessage } from "../shared/vscode-api";
import {
  appendOpenCodeUpdateOutput,
  applyOpenCodeChangelog,
  applyOpenCodeUpdateStatus,
  initOpenCodeUpdateUi,
  isInstallPromptVisible,
  notifyOpenCodeUpdateCheckRequested,
} from "./index";

/**
 * The module keeps singleton state (initialized flag + merged status), so
 * the DOM is built once and each test starts from a cleared status with
 * the dialog dismissed.
 */
function dismissDialog(): void {
  for (let i = 0; i < 3; i++) {
    const overlay = document.getElementById("ocu-dialog");
    if (!overlay || overlay.classList.contains("hidden")) return;
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  }
}

function resetStatus(): void {
  dismissDialog();
  applyOpenCodeUpdateStatus({
    state: "idle",
    step: "",
    installedVersion: "",
    latestVersion: "",
    currentVersion: "",
    targetVersion: "",
    detail: "",
    manualCommands: [],
    remediationCommands: [],
    history: [],
    installPromptPending: false,
    sessionAutoStarted: false,
    openUpdateDialog: undefined,
    checkOutcome: undefined,
  });
}

function pill(): HTMLButtonElement {
  return document.getElementById("btn-oc-version") as HTMLButtonElement;
}

function overlay(): HTMLElement {
  return document.getElementById("ocu-dialog") as HTMLElement;
}

function dialogBody(): HTMLElement {
  return document.getElementById("ocu-dlg-body") as HTMLElement;
}

function dialogFoot(): HTMLElement {
  return document.getElementById("ocu-dlg-foot") as HTMLElement;
}

function dialogTitle(): string {
  return document.getElementById("ocu-dlg-title")?.textContent ?? "";
}

function progressLine(): HTMLElement {
  return document.getElementById("ocu-progress") as HTMLElement;
}

function installDialog(): HTMLElement {
  return document.getElementById("ocu-install-prompt") as HTMLElement;
}

function click(selector: string): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error("missing element: " + selector);
  el.click();
}

function notesPayload(version = "2.0.7", html = '<p class="markdown">Notes</p>') {
  return {
    version,
    ok: true,
    date: "2026-10-01T00:00:00Z",
    html,
    fallbackUrl: "https://opencode.ai/changelog#v2-0-7",
    mode: "upcoming" as const,
  };
}

function latestPosts(): unknown[] {
  return vi.mocked(postMessage).mock.calls.map((call) => call[0]);
}

describe("OpenCode update UI (webview)", () => {
  let initPosts: unknown[][] = [];

  beforeAll(() => {
    document.body.innerHTML = `
      <button type="button" id="btn-oc-version" class="pill-version hidden">
        <span id="ocu-version-text"></span>
      </button>
      <div id="menu-oc-update-check" class="hidden"></div>
      <div id="terminal-container"></div>`;
    initOpenCodeUpdateUi();
    initPosts = vi.mocked(postMessage).mock.calls.slice();
  });

  it("requests the status snapshot on init", () => {
    expect(initPosts).toContainEqual([{ type: "requestOpenCodeUpdateStatus" }]);
  });

  it("shows the entry pill when available and hides it on a cleared idle push", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      currentVersion: "2.0.6",
      latestVersion: "2.0.7",
    });

    expect(pill().classList.contains("hidden")).toBe(false);
    expect(pill().classList.contains("is-entry")).toBe(true);

    resetStatus();
    expect(pill().classList.contains("hidden")).toBe(true);
    expect(pill().disabled).toBe(true);
  });

  it("opens the new version's release notes before the method step", () => {
    resetStatus();
    vi.mocked(postMessage).mockClear();
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      currentVersion: "2.0.6",
      latestVersion: "2.0.7",
    });

    pill().click();

    expect(overlay().classList.contains("hidden")).toBe(false);
    expect(dialogTitle()).toBe("OpenCode 2.0.7");
    expect(dialogBody().querySelector(".ocu-dlg-delta")).toBeNull();
    expect(latestPosts()).toContainEqual({
      type: "requestOpenCodeChangelog",
      version: "2.0.7",
      mode: "upcoming",
    });
    // The method list must not be the first screen anymore.
    expect(dialogBody().querySelector("[data-ocu-method]")).toBeNull();
  });

  it("renders release notes and leads to the method step", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      currentVersion: "2.0.6",
      latestVersion: "2.0.7",
    });
    pill().click();
    applyOpenCodeChangelog(notesPayload());

    expect(dialogBody().textContent).toContain("Notes");
    expect(
      dialogFoot().querySelector('[data-ocu-dlg="update"]')?.textContent,
    ).toBe("Update");
    // No secondary "Later" in the notes footer: the primary CTA owns the
    // bottom-right corner and the close button handles dismissal.
    expect(dialogFoot().querySelector('[data-ocu-dlg="later"]')).toBeNull();
    const notesButtons = Array.from(dialogFoot().querySelectorAll("button"));
    expect(notesButtons.at(-1)?.getAttribute("data-ocu-dlg")).toBe("update");
    // Head actions are icon-only buttons ordered send, copy, browser.
    const headButtons = Array.from(
      document
        .getElementById("ocu-dlg-head-actions")
        ?.querySelectorAll("button") ?? [],
    );
    expect(headButtons.map((b) => b.getAttribute("data-ocu-dlg"))).toEqual([
      "send",
      "copy",
      "open",
    ]);
    for (const button of headButtons) {
      expect(button.textContent?.trim()).toBe("");
      expect(button.querySelector("svg")).not.toBeNull();
      expect(button.getAttribute("title")).toBe(
        button.getAttribute("aria-label"),
      );
      expect(button.getAttribute("title")).toBeTruthy();
    }
    expect(dialogFoot().querySelector('[data-ocu-dlg="open"]')).toBeNull();

    click('[data-ocu-dlg="update"]');

    expect(dialogTitle()).toBe("Select update method");
    expect(dialogBody().querySelectorAll("[data-ocu-method]").length).toBeGreaterThan(0);
    // The method step confirms from the footer; it has no cancel or
    // release-notes escape hatch, only the head close button.
    expect(dialogFoot().querySelector('[data-ocu-dlg="confirm"]')).not.toBeNull();
    expect(dialogFoot().querySelector('[data-ocu-dlg="back-notes"]')).toBeNull();
    expect(dialogFoot().querySelector('[data-ocu-dlg="cancel"]')).toBeNull();
  });

  it("offers the update action even when release notes fail", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      latestVersion: "2.0.7",
    });
    pill().click();
    applyOpenCodeChangelog({
      version: "2.0.7",
      ok: false,
      fallbackUrl: "https://opencode.ai/changelog",
      mode: "upcoming",
    });

    expect(dialogBody().textContent).toContain("Release notes are unavailable");
    expect(dialogFoot().querySelector('[data-ocu-dlg="update"]')).not.toBeNull();
    expect(
      document
        .getElementById("ocu-dlg-head-actions")
        ?.querySelector('[data-ocu-dlg="open"]'),
    ).not.toBeNull();
  });

  it("preselects the last used method in the method step", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      latestVersion: "2.0.7",
      methods: ["curl", "npm"],
      defaultMethod: "npm",
      lastUsedMethod: "curl",
    });
    pill().click();
    applyOpenCodeChangelog(notesPayload());
    click('[data-ocu-dlg="update"]');

    const focused = dialogBody().querySelector(".ocu-pop-row.is-focused");
    expect(focused?.getAttribute("data-ocu-method")).toBe("curl");
  });

  it("starts the update from the chosen method and shows dialog progress", () => {
    resetStatus();
    vi.mocked(postMessage).mockClear();
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      latestVersion: "2.0.7",
    });
    pill().click();
    applyOpenCodeChangelog(notesPayload());
    click('[data-ocu-dlg="update"]');

    // Picking a row only moves the selection; the footer confirm starts it.
    click('[data-ocu-method="npm"]');
    expect(
      latestPosts().find(
        (message: any) => message?.type === "startOpenCodeUpdate",
      ),
    ).toBeUndefined();
    click('[data-ocu-dlg="confirm"]');

    expect(latestPosts()).toContainEqual({
      type: "startOpenCodeUpdate",
      method: "npm",
    });

    applyOpenCodeUpdateStatus({
      state: "updating",
      step: "prepare-target",
      targetVersion: "2.0.7",
    });

    expect(overlay().classList.contains("hidden")).toBe(false);
    expect(dialogTitle()).toBe("Updating OpenCode to 2.0.7");
    expect(dialogBody().querySelector(".ocu-dlg-steps")).not.toBeNull();
    expect(dialogBody().textContent).toContain("Resolve latest version");
    expect(dialogBody().textContent).toContain("1/5");
    expect(progressLine().classList.contains("hidden")).toBe(true);
  });

  it("minimizes running progress to the toolbar line and reopens it", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "updating",
      step: "execute",
      targetVersion: "2.0.7",
    });

    click('[data-ocu-dlg="minimize"]');

    expect(overlay().classList.contains("hidden")).toBe(true);
    expect(progressLine().classList.contains("hidden")).toBe(false);
    expect(progressLine().textContent).toContain("Downloading and installing");

    progressLine().click();

    expect(overlay().classList.contains("hidden")).toBe(false);
    expect(progressLine().classList.contains("hidden")).toBe(true);
  });

  it("treats Escape during progress as minimize instead of dismissing", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "updating",
      step: "execute",
    });

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(overlay().classList.contains("hidden")).toBe(true);
    expect(progressLine().classList.contains("hidden")).toBe(false);
  });

  it("streams upgrade output into the progress log pane", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "updating",
      step: "execute",
    });

    appendOpenCodeUpdateOutput(["added 12 packages"]);
    appendOpenCodeUpdateOutput(["done"]);

    const pane = dialogBody().querySelector("[data-ocu-log]");
    expect(pane?.textContent).toContain("added 12 packages");
    expect(pane?.textContent).toContain("done");
  });

  it("arms and confirms abort in two clicks", () => {
    resetStatus();
    vi.mocked(postMessage).mockClear();
    applyOpenCodeUpdateStatus({
      state: "updating",
      step: "execute",
    });

    click('[data-ocu-dlg="abort"]');
    expect(
      dialogFoot().querySelector('[data-ocu-dlg="abort"]')?.textContent,
    ).toBe("Click again to abort");
    expect(latestPosts()).not.toContainEqual({ type: "abandonOpenCodeUpdate" });

    click('[data-ocu-dlg="abort"]');
    expect(latestPosts()).toContainEqual({ type: "abandonOpenCodeUpdate" });
    expect(overlay().classList.contains("hidden")).toBe(true);
  });

  it("asks about restarting inside the dialog after success", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "updating",
      step: "verify",
    });
    vi.mocked(postMessage).mockClear();

    applyOpenCodeUpdateStatus({
      state: "success",
      step: "",
      installedVersion: "2.0.7",
      targetVersion: "2.0.7",
    });

    // 成功在原步骤弹窗收尾：标题换成版本号，步骤与输出保留，页脚只剩确认
    expect(dialogTitle()).toBe("OpenCode 2.0.7");
    expect(dialogBody().querySelector(".ocu-dlg-steps")).not.toBeNull();
    expect(dialogBody().querySelector(".ocu-dlg-result.is-ok")?.textContent).toBe(
      "OpenCode 2.0.7 updated",
    );
    expect(dialogFoot().querySelector('[data-ocu-dlg="abort"]')).toBeNull();
    expect(
      dialogFoot().querySelector('[data-ocu-dlg="finish"]')?.textContent,
    ).toBe("Confirm");

    click('[data-ocu-dlg="finish"]');

    // 确认不直接重启：另开确认弹窗，用户点重启才发消息
    const prompt = document.getElementById("ocu-restart-prompt");
    expect(prompt?.classList.contains("hidden")).toBe(false);
    expect(prompt?.textContent).toContain("Restart the terminal?");
    expect(overlay().classList.contains("hidden")).toBe(false);
    expect(latestPosts()).not.toContainEqual({ type: "restartAfterUpdate" });

    click('[data-ocu-rp="restart"]');

    expect(latestPosts()).toContainEqual({ type: "restartAfterUpdate" });
    expect(prompt?.classList.contains("hidden")).toBe(true);
    expect(overlay().classList.contains("hidden")).toBe(true);
  });

  it("defers the restart without touching the running session", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "success",
      step: "",
      installedVersion: "2.0.7",
      targetVersion: "2.0.7",
    });
    vi.mocked(postMessage).mockClear();

    click('[data-ocu-dlg="finish"]');
    click('[data-ocu-rp="later"]');

    expect(latestPosts()).toContainEqual({ type: "dismissOpenCodeUpdate" });
    expect(latestPosts()).not.toContainEqual({ type: "restartAfterUpdate" });
    expect(
      document
        .getElementById("ocu-restart-prompt")
        ?.classList.contains("hidden"),
    ).toBe(true);
    expect(overlay().classList.contains("hidden")).toBe(true);
  });

  it("drops the restart prompt when the flow moves on", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "success",
      step: "",
      installedVersion: "2.0.7",
      targetVersion: "2.0.7",
    });
    click('[data-ocu-dlg="finish"]');
    const prompt = document.getElementById("ocu-restart-prompt");
    expect(prompt?.classList.contains("hidden")).toBe(false);

    applyOpenCodeUpdateStatus({ state: "idle", step: "" });

    expect(prompt?.classList.contains("hidden")).toBe(true);
  });

  it("dismisses the success dialog through the close button", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "success",
      step: "",
      installedVersion: "2.0.7",
    });
    vi.mocked(postMessage).mockClear();
    expect(dialogFoot().querySelector('[data-ocu-dlg="later"]')).toBeNull();

    click(".ocu-dlg-x");

    expect(latestPosts()).toContainEqual({ type: "dismissOpenCodeUpdate" });
    expect(overlay().classList.contains("hidden")).toBe(true);
  });

  it("shows failure detail and command fallbacks in the step dialog", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "failed",
      step: "",
      detail: "upgrade command failed",
      targetVersion: "2.0.7",
      remediationCommands: ["nvm firewall trust module opencode", "nvm reshim"],
    });

    expect(dialogTitle()).toBe("Updating OpenCode");
    expect(
      dialogBody().querySelector(".ocu-dlg-result.is-bad")?.textContent,
    ).toBe("Update failed");
    expect(dialogBody().textContent).toContain("nvm reshim");
    expect(
      dialogFoot().querySelector('[data-ocu-dlg="finish"]'),
    ).not.toBeNull();
  });

  it("restarts the update from the failure outcome block", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "failed",
      step: "",
      detail: "upgrade command failed",
      targetVersion: "2.0.7",
      remediationCommands: ["nvm reshim"],
    });

    click('[data-ocu-dlg="retry"]');

    expect(dialogTitle()).toBe("Select update method");
    expect(dialogBody().querySelector("[data-ocu-method]")).not.toBeNull();
  });

  it("retries from the failed pill into the method step", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "failed",
      step: "",
      detail: "upgrade command failed",
      targetVersion: "2.0.7",
    });

    pill().click();

    expect(dialogTitle()).toBe("Select update method");
    expect(dialogBody().querySelector("[data-ocu-method]")).not.toBeNull();
  });

  it("opens the manual-check dialog at the notes step", () => {
    resetStatus();
    vi.mocked(postMessage).mockClear();
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      currentVersion: "2.0.6",
      latestVersion: "2.0.7",
      openUpdateDialog: "notes",
    });

    expect(overlay().classList.contains("hidden")).toBe(false);
    expect(dialogTitle()).toBe("OpenCode 2.0.7");
    expect(latestPosts()).toContainEqual({
      type: "requestOpenCodeChangelog",
      version: "2.0.7",
      mode: "upcoming",
    });
  });

  it("opens the install method step for a missing CLI", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "installable",
      step: "",
      methods: ["npm", "curl"],
      defaultMethod: "npm",
      installPromptPending: false,
    });

    pill().click();

    expect(dialogTitle()).toBe("Select install method");
    expect(dialogBody().querySelector('[data-ocu-method="npm"]')).not.toBeNull();
    expect(dialogFoot().querySelector('[data-ocu-dlg="confirm"]')).not.toBeNull();
    expect(dialogFoot().querySelector('[data-ocu-dlg="back-notes"]')).toBeNull();
  });

  it("shows the install progress title for CLI installs", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "installable",
      step: "",
      methods: ["npm"],
    });
    pill().click();
    click('[data-ocu-method="npm"]');
    click('[data-ocu-dlg="confirm"]');

    applyOpenCodeUpdateStatus({
      state: "updating",
      step: "installing",
    });

    expect(dialogTitle()).toBe("Installing OpenCode");
    expect(dialogBody().textContent).toContain("1/3");
  });

  it("opens the installed version's notes from the idle pill", () => {
    resetStatus();
    vi.mocked(postMessage).mockClear();
    applyOpenCodeUpdateStatus({
      state: "idle",
      step: "",
      installedVersion: "2.0.7",
    });

    pill().click();

    expect(dialogTitle()).toBe("OpenCode 2.0.7");
    expect(latestPosts()).toContainEqual({
      type: "requestOpenCodeChangelog",
      version: "2.0.7",
      mode: "installed",
    });
    expect(dialogFoot().querySelector('[data-ocu-dlg="check"]')).not.toBeNull();
  });

  it("reports an up-to-date check in the installed notes footer", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "idle",
      step: "",
      installedVersion: "2.0.7",
    });
    pill().click();
    vi.mocked(postMessage).mockClear();

    click('[data-ocu-dlg="check"]');
    expect(latestPosts()).toContainEqual({ type: "checkOpenCodeUpdates" });

    applyOpenCodeUpdateStatus({
      state: "idle",
      step: "",
      installedVersion: "2.0.7",
      checkOutcome: "upToDate",
    });

    expect(dialogFoot().textContent).toContain("Already on the latest version.");
  });

  it("switches from an installed-notes check to the new release notes", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "idle",
      step: "",
      installedVersion: "2.0.6",
    });
    pill().click();
    vi.mocked(postMessage).mockClear();

    click('[data-ocu-dlg="check"]');
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      currentVersion: "2.0.6",
      latestVersion: "2.0.7",
    });

    expect(dialogTitle()).toBe("OpenCode 2.0.7");
    expect(latestPosts()).toContainEqual({
      type: "requestOpenCodeChangelog",
      version: "2.0.7",
      mode: "upcoming",
    });
  });

  it("sends release notes to OpenCode from the notes head actions", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      latestVersion: "2.0.7",
    });
    pill().click();
    applyOpenCodeChangelog(notesPayload());
    vi.mocked(postMessage).mockClear();

    click('[data-ocu-dlg="send"]');

    const sent = latestPosts().find(
      (message: any) => message?.type === "sendChangelogToOpenCode",
    ) as { text?: string } | undefined;
    expect(sent?.text).toContain("Notes");
    expect(sent?.text).toContain("Please summarize it.");
    expect(overlay().classList.contains("hidden")).toBe(true);
  });

  it("shows a checking card for a manual check and clears it afterwards", () => {
    resetStatus();
    notifyOpenCodeUpdateCheckRequested();

    const card = document.getElementById("ocu-card") as HTMLElement;
    expect(card.classList.contains("hidden")).toBe(false);
    expect(card.textContent).toContain("Checking for updates");

    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      latestVersion: "2.0.7",
    });

    expect(card.classList.contains("hidden")).toBe(true);
  });

  it("shows the missing-CLI confirmation only while pending", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "installable",
      step: "",
      methods: ["npm"],
      installPromptPending: true,
    });

    expect(isInstallPromptVisible()).toBe(true);
    expect(installDialog().textContent).toContain("Install OpenCode CLI");

    installDialog().querySelector<HTMLElement>('[data-ocu-ip="notNow"]')?.click();

    expect(isInstallPromptVisible()).toBe(false);
  });

  it("keeps a single confirm action once the flow finishes", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "success",
      step: "",
      installedVersion: "2.0.7",
    });

    const actions = Array.from(dialogFoot().querySelectorAll("button"));
    expect(actions).toHaveLength(1);
    expect(actions[0].getAttribute("data-ocu-dlg")).toBe("finish");
    expect(actions[0].textContent).toBe("Confirm");
  });
});
