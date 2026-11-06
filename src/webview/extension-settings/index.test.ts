// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/vscode-api", () => ({
  postMessage: vi.fn(),
  acquireVsCodeApi: vi.fn(() => ({ postMessage: vi.fn() })),
}));

const openSyncPanelMock = vi.hoisted(() => vi.fn());
vi.mock("../sync", () => ({ openSyncPanel: openSyncPanelMock }));

import { postMessage } from "../shared/vscode-api";
import type {
  ExtensionSettingsScope,
  ExtensionSettingsSnapshot,
} from "../../types";
import {
  applyExtensionSettingsData,
  handleExtensionSettingsSaveResult,
  initExtensionSettingsUi,
  openExtensionSettingsDialog,
} from "./index";

/**
 * Minimal mirror of the shell markup. `markup.ts` pulls the host-side i18n
 * helper, which cannot load under the jsdom environment, so the frame is
 * reproduced here with the same ids the module binds to.
 */
const SHELL = `
  <div class="eset-overlay hidden" id="eset-overlay">
    <div class="eset-modal" id="eset-modal" role="dialog" aria-modal="true">
      <div class="eset-header">
        <h1 id="eset-title">Extension Settings</h1>
        <button type="button" class="eset-scope-btn is-on" data-eset-scope="user" aria-pressed="true">User</button>
        <button type="button" class="eset-scope-btn" data-eset-scope="workspace" aria-pressed="false">Workspace</button>
        <button type="button" id="eset-close" aria-label="Close">x</button>
      </div>
      <div class="eset-note hidden" id="eset-scope-note">No workspace folder is open.</div>
      <nav class="eset-nav" id="eset-nav"></nav>
      <div class="eset-body" id="eset-body">
        <div class="eset-loading" id="eset-loading" role="status"></div>
        <div class="eset-panes" id="eset-panes"></div>
      </div>
      <div class="eset-footer">
        <span class="eset-status" id="eset-status" role="status"></span>
        <button type="button" id="eset-open-settings">Open VS Code settings</button>
      </div>
    </div>
  </div>`;

const DEFAULTS: Record<string, unknown> = {
  fontFamily:
    "'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', 'CascadiaCode NF', Menlo, monospace",
  focusIndicatorMode: "bottomBorder",
  focusIndicatorBorderWidth: 2,
  sendKeybindingsToShell: true,
  autoFocusOnSend: true,
  fileSendMode: "attachment",
  autoShareContext: true,
  "startup.coordinate": true,
  "opencode.continueLastSession": true,
  "opencode.commandPath": "opencode",
  "opencode.args": [],
  shellPath: "",
  shellArgs: [],
  contextDebounceMs: 500,
  maxDiagnosticLength: 500,
  codeActionSeverities: ["error", "warning"],
  logLevel: "info",
  httpTimeout: 5000,
  "update.autoCheck": true,
  "update.checkIntervalHours": 24,
};

const VALUES: Record<string, unknown> = {
  ...DEFAULTS,
  fontFamily: "Fira Code",
  focusIndicatorMode: "fullBorder",
  focusIndicatorBorderWidth: 4,
  sendKeybindingsToShell: false,
  fileSendMode: "path",
  "opencode.commandPath": "opencode-dev",
  "opencode.args": ["--flag", "--second"],
  shellPath: "/bin/zsh",
  contextDebounceMs: 800,
  maxDiagnosticLength: 700,
  codeActionSeverities: ["warning", "hint"],
  logLevel: "debug",
  httpTimeout: 9000,
  "update.autoCheck": false,
  "update.checkIntervalHours": 12,
};

function snapshot(
  overrides: Partial<ExtensionSettingsSnapshot> = {},
): ExtensionSettingsSnapshot {
  return {
    values: VALUES,
    userValues: { fontFamily: "Fira Code", logLevel: "debug" },
    workspaceValues: {},
    defaults: DEFAULTS,
    hasWorkspace: true,
    ...overrides,
  };
}

function overlay(): HTMLElement {
  return document.getElementById("eset-overlay") as HTMLElement;
}

function scopeButton(scope: ExtensionSettingsScope): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(
    `[data-eset-scope="${scope}"]`,
  ) as HTMLButtonElement;
}

function row(key: string): HTMLElement {
  return document.querySelector<HTMLElement>(
    `[data-eset-row="${key}"]`,
  ) as HTMLElement;
}

function control<T extends HTMLElement>(key: string): T {
  return document.getElementById(`eset-c-${key}`) as T;
}

function ensureUserScope(): void {
  if (!scopeButton("user").classList.contains("is-on")) {
    scopeButton("user").click();
  }
}

/** Open the dialog and hand it a snapshot, leaving the user layer active. */
function openWith(settings: ExtensionSettingsSnapshot = snapshot()): void {
  openExtensionSettingsDialog();
  applyExtensionSettingsData(settings);
  ensureUserScope();
}

function change(id: string, value: string | boolean): void {
  const node = document.getElementById(id) as
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement;
  if (typeof value === "boolean") {
    (node as HTMLInputElement).checked = value;
  } else {
    node.value = value;
  }
  node.dispatchEvent(new Event("change", { bubbles: true }));
}

function posted(): Array<Record<string, unknown>> {
  return vi
    .mocked(postMessage)
    .mock.calls.map((call) => call[0] as Record<string, unknown>);
}

describe("extension settings dialog (webview)", () => {
  beforeAll(() => {
    document.body.innerHTML = `
      <button type="button" id="btn-settings">Settings</button>
      ${SHELL}`;
    initExtensionSettingsUi();
  });

  beforeEach(() => {
    vi.mocked(openSyncPanelMock).mockClear();
  });

  it("renders every setting row across the groups", () => {
    expect(document.querySelectorAll("[data-eset-row]")).toHaveLength(20);
    expect(document.querySelectorAll("#eset-nav [data-eset-group]")).toHaveLength(
      7,
    );
  });

  it("shows the loading state until a snapshot arrives", () => {
    openExtensionSettingsDialog();
    expect(
      document.getElementById("eset-loading")?.classList.contains("hidden"),
    ).toBe(false);
    expect(
      document.getElementById("eset-panes")?.classList.contains("is-loading"),
    ).toBe(true);
    // The workspace layer stays unavailable while the folder state is unknown.
    expect(scopeButton("workspace").disabled).toBe(true);
    expect(
      document.getElementById("eset-scope-note")?.classList.contains("hidden"),
    ).toBe(true);

    applyExtensionSettingsData(snapshot());
    expect(
      document.getElementById("eset-loading")?.classList.contains("hidden"),
    ).toBe(true);
    expect(
      document.getElementById("eset-panes")?.classList.contains("is-loading"),
    ).toBe(false);
    expect(scopeButton("workspace").disabled).toBe(false);
  });

  it("fills controls from the snapshot", () => {
    openWith();

    expect(control<HTMLInputElement>("fontFamily").value).toBe("Fira Code");
    expect(control<HTMLSelectElement>("focusIndicatorMode").value).toBe(
      "fullBorder",
    );
    expect(control<HTMLInputElement>("focusIndicatorBorderWidth").value).toBe(
      "4",
    );
    expect(control<HTMLInputElement>("sendKeybindingsToShell").checked).toBe(
      false,
    );
    expect(control<HTMLInputElement>("update.autoCheck").checked).toBe(false);
    expect(control<HTMLTextAreaElement>("opencode.args").value).toBe(
      "--flag\n--second",
    );
    expect(control<HTMLTextAreaElement>("shellArgs").value).toBe("");

    const severities = row("codeActionSeverities").querySelectorAll<HTMLInputElement>(
      "[data-eset-severity]",
    );
    const checked = Array.from(severities)
      .filter((box) => box.checked)
      .map((box) => box.dataset.esetSeverity);
    expect(checked).toEqual(["warning", "hint"]);
  });

  it("states when a change takes effect", () => {
    openWith();
    const descOf = (key: string): string =>
      row(key).querySelector(".eset-row-desc")?.textContent ?? "";

    expect(descOf("startup.coordinate")).toContain(
      "Takes effect after the window reloads.",
    );
    expect(descOf("contextDebounceMs")).toContain(
      "Takes effect after the window reloads.",
    );
    expect(descOf("shellArgs")).toContain(
      "Takes effect the next time the terminal starts.",
    );
    expect(descOf("opencode.args")).toContain(
      "Takes effect the next time a session starts.",
    );
    expect(descOf("httpTimeout")).toContain(
      "Takes effect the next time a session starts.",
    );
    // Settings read on every use carry no timing note.
    expect(descOf("logLevel")).not.toContain("Takes effect");
    expect(descOf("fontFamily")).not.toContain("Takes effect");
  });

  it("offers a reset only for the terminal font family", () => {
    openWith();
    expect(
      row("fontFamily")
        .querySelector<HTMLElement>("[data-eset-reset]")
        ?.classList.contains("hidden"),
    ).toBe(false);
    // Every other row has no reset control at all, and no layer dot remains.
    expect(row("shellPath").querySelector("[data-eset-reset]")).toBeNull();
    expect(document.querySelector("[data-eset-state]")).toBeNull();
  });

  it("names the workspace layer that overrides a user edit", () => {
    openWith(
      snapshot({
        values: { ...VALUES, fontFamily: "Workspace Mono" },
        workspaceValues: { fontFamily: "Workspace Mono" },
      }),
    );

    const hint = row("fontFamily").querySelector<HTMLElement>("[data-eset-layer]");
    expect(hint?.classList.contains("hidden")).toBe(false);
    expect(hint?.querySelector("[data-eset-layer-text]")?.textContent).toBe(
      "Workspace settings override this value.",
    );
    const action = hint?.querySelector<HTMLButtonElement>(
      "[data-eset-layer-switch]",
    );
    expect(action?.classList.contains("hidden")).toBe(false);
    expect(action?.textContent).toBe("Switch to workspace");

    vi.mocked(postMessage).mockClear();
    action?.click();
    expect(posted()).toEqual([{ type: "requestExtensionSettingsData" }]);
    expect(scopeButton("workspace").classList.contains("is-on")).toBe(true);
    expect(
      row("fontFamily")
        .querySelector<HTMLElement>("[data-eset-layer]")
        ?.classList.contains("hidden"),
    ).toBe(true);
  });

  it("names the user layer as the source inside the workspace layer", () => {
    openWith();
    scopeButton("workspace").click();
    applyExtensionSettingsData(snapshot({ workspaceValues: {} }));

    const hint = row("fontFamily").querySelector<HTMLElement>("[data-eset-layer]");
    expect(hint?.classList.contains("hidden")).toBe(false);
    expect(hint?.querySelector("[data-eset-layer-text]")?.textContent).toBe(
      "This value comes from your user settings.",
    );
    // Only the shadowed user layer gets the inline jump action.
    expect(
      hint
        ?.querySelector("[data-eset-layer-switch]")
        ?.classList.contains("hidden"),
    ).toBe(true);
  });

  it("posts one immediate update with the active scope", () => {
    openWith();
    vi.mocked(postMessage).mockClear();

    change("eset-c-autoShareContext", false);
    expect(posted()).toEqual([
      {
        type: "updateExtensionSetting",
        key: "autoShareContext",
        value: false,
        scope: "user",
      },
    ]);

    vi.mocked(postMessage).mockClear();
    change("eset-c-logLevel", "warn");
    expect(posted()).toEqual([
      {
        type: "updateExtensionSetting",
        key: "logLevel",
        value: "warn",
        scope: "user",
      },
    ]);
  });

  it("commits line arrays without blank entries", () => {
    openWith();
    vi.mocked(postMessage).mockClear();

    change("eset-c-shellArgs", "  --login \n\n -i  \n");
    expect(posted()).toEqual([
      {
        type: "updateExtensionSetting",
        key: "shellArgs",
        value: ["--login", "-i"],
        scope: "user",
      },
    ]);
  });

  it("switches scope without writing and refreshes the snapshot", () => {
    openWith();
    vi.mocked(postMessage).mockClear();

    scopeButton("workspace").click();
    expect(posted()).toEqual([{ type: "requestExtensionSettingsData" }]);
    expect(scopeButton("workspace").getAttribute("aria-pressed")).toBe("true");

    vi.mocked(postMessage).mockClear();
    change("eset-c-httpTimeout", "12000");
    expect(posted()).toEqual([
      {
        type: "updateExtensionSetting",
        key: "httpTimeout",
        value: 12000,
        scope: "workspace",
      },
    ]);
  });

  it("disables the workspace layer when no folder is open", () => {
    openWith(snapshot({ hasWorkspace: false }));
    const workspace = scopeButton("workspace");
    expect(workspace.disabled).toBe(true);
    expect(
      document.getElementById("eset-scope-note")?.classList.contains("hidden"),
    ).toBe(false);

    vi.mocked(postMessage).mockClear();
    workspace.click();
    expect(posted()).toEqual([]);
    expect(scopeButton("user").classList.contains("is-on")).toBe(true);
  });

  it("keeps the stored value and names the row when a write fails", () => {
    openWith();
    change("eset-c-fontFamily", "Other Font");
    vi.mocked(postMessage).mockClear();

    handleExtensionSettingsSaveResult({
      type: "extensionSettingsSaveResult",
      ok: false,
      key: "fontFamily",
      error: "This setting is managed by your organization.",
    });

    expect(control<HTMLInputElement>("fontFamily").value).toBe("Fira Code");
    const error = row("fontFamily").querySelector<HTMLElement>(".eset-row-error");
    expect(error?.textContent).toBe(
      "This setting is managed by your organization.",
    );
    expect(error?.classList.contains("hidden")).toBe(false);
    const status = document.getElementById("eset-status");
    expect(status?.classList.contains("is-error")).toBe(true);
    expect(status?.textContent).toBe(
      "This setting is managed by your organization.",
    );
    expect(posted()).toEqual([]);
  });

  it("reports a successful save in the footer", () => {
    openWith();
    handleExtensionSettingsSaveResult({
      type: "extensionSettingsSaveResult",
      ok: true,
      key: "fontFamily",
    });
    const status = document.getElementById("eset-status");
    expect(status?.textContent).toBe("Saved");
    expect(status?.classList.contains("is-ok")).toBe(true);
  });

  it("resets an explicit value for the active layer", () => {
    openWith();
    vi.mocked(postMessage).mockClear();

    row("fontFamily")
      .querySelector<HTMLElement>("[data-eset-reset]")
      ?.click();

    expect(posted()).toEqual([
      { type: "resetExtensionSetting", key: "fontFamily", scope: "user" },
    ]);
  });

  it("closes the dialog and opens the sync panel from the sync group", () => {
    openWith();
    document
      .querySelector<HTMLElement>('[data-eset-group="sync"]')
      ?.click();
    expect(
      document.querySelector('[data-eset-pane="sync"]')?.classList.contains("is-on"),
    ).toBe(true);

    document
      .querySelector<HTMLElement>("[data-eset-open-sync]")
      ?.click();

    expect(overlay().classList.contains("hidden")).toBe(true);
    expect(openSyncPanelMock).toHaveBeenCalledWith("general");
  });

  it("requests a snapshot on open", () => {
    vi.mocked(postMessage).mockClear();
    openExtensionSettingsDialog();
    expect(posted()).toEqual([{ type: "requestExtensionSettingsData" }]);
  });

  it("closes on Escape and returns focus to the toolbar button", () => {
    openExtensionSettingsDialog();
    expect(overlay().classList.contains("hidden")).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(overlay().classList.contains("hidden")).toBe(true);
    expect(document.activeElement?.id).toBe("btn-settings");
  });

  it("closes on the close button and on an overlay click", () => {
    openWith();
    document.getElementById("eset-close")?.click();
    expect(overlay().classList.contains("hidden")).toBe(true);

    openWith();
    overlay().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(overlay().classList.contains("hidden")).toBe(true);
  });

  it("asks the host to open the VS Code settings page", () => {
    openWith();
    vi.mocked(postMessage).mockClear();
    document.getElementById("eset-open-settings")?.click();
    expect(posted()).toEqual([{ type: "openSettings" }]);
  });
});
