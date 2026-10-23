// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../shared/vscode-api", () => ({
  postMessage: vi.fn(),
  acquireVsCodeApi: vi.fn(() => ({ postMessage: vi.fn() })),
}));

import { postMessage } from "../shared/vscode-api";
import {
  applyOpenCodeChangelog,
  applyOpenCodeUpdateStatus,
  initOpenCodeUpdateUi,
  isInstallPromptVisible,
  notifyOpenCodeSessionStarted,
  notifyOpenCodeUpdateCheckRequested,
} from "./index";

/**
 * The module keeps singleton state (initialized flag + merged status), so
 * the DOM is built once and each test starts from a cleared status. Empty
 * strings overwrite stale merged fields the way host hide-pushes do.
 */
function resetStatus(): void {
  applyOpenCodeUpdateStatus({
    state: "idle",
    step: "",
    installedVersion: "",
    latestVersion: "",
    currentVersion: "",
    detail: "",
    manualCommands: [],
    remediationCommands: [],
    history: [],
    installPromptPending: false,
    sessionAutoStarted: false,
  });
}

function pill(): HTMLButtonElement {
  return document.getElementById("btn-oc-version") as HTMLButtonElement;
}

function card(): HTMLElement {
  return document.getElementById("ocu-card") as HTMLElement;
}

function popover(): HTMLElement {
  return document.getElementById("ocu-popover") as HTMLElement;
}

function installDialog(): HTMLElement {
  return document.getElementById("ocu-install-prompt") as HTMLElement;
}

describe("OpenCode update UI (webview)", () => {
  // vitest resets mocks before each test, so init-time posts are captured
  // right after initialization.
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
    expect(initPosts).toContainEqual([
      { type: "requestOpenCodeUpdateStatus" },
    ]);
  });

  it("shows the entry pill when available and hides it on a cleared idle push", () => {
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      currentVersion: "2.0.6",
      latestVersion: "2.0.7",
    });

    expect(pill().classList.contains("hidden")).toBe(false);
    expect(pill().classList.contains("is-entry")).toBe(true);

    resetStatus();

    // Empty-string version fields must clear the merged pill state.
    expect(pill().classList.contains("hidden")).toBe(true);
    expect(pill().disabled).toBe(true);
  });

  it("re-enters the update flow from the failed pill", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "failed",
      step: "",
      detail: "upgrade command failed",
      targetVersion: "2.0.7",
    });

    expect(pill().getAttribute("title")).toBe(
      "Update did not finish. Click to try again",
    );

    pill().click();

    // The pill keeps the entry look after a failed update, so clicking
    // re-opens the method popover instead of the changelog.
    expect(popover().classList.contains("hidden")).toBe(false);
    // The changelog stays reachable inside the retry popover.
    expect(
      popover().querySelector("#ocu-pop-changelog")?.classList.contains("hidden"),
    ).toBe(false);

    resetStatus();
  });

  it("opens the current version's changelog from the pill in the idle state", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "idle",
      step: "",
      installedVersion: "2.0.7",
    });

    expect(pill().classList.contains("hidden")).toBe(false);
    expect(pill().disabled).toBe(false);
    expect(pill().getAttribute("title")).toBe(
      "View the current version's changelog",
    );
    expect(pill().getAttribute("aria-label")).toBe(
      "View the current version's changelog",
    );

    pill().click();

    expect(postMessage).toHaveBeenCalledWith({
      type: "requestOpenCodeChangelog",
    });
    expect(
      document.getElementById("ocu-changelog")?.classList.contains("hidden"),
    ).toBe(false);
    // Standalone entry: the footer check action is available.
    expect(
      document
        .getElementById("ocu-changelog")
        ?.querySelector(".ocu-cl-foot")
        ?.classList.contains("hidden"),
    ).toBe(false);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    resetStatus();
  });

  it("ignores pill clicks while the checking card is showing", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "idle",
      step: "",
      installedVersion: "2.0.7",
    });
    notifyOpenCodeUpdateCheckRequested();

    pill().click();

    expect(postMessage).not.toHaveBeenCalled();
    expect(
      document.getElementById("ocu-changelog")?.classList.contains("hidden"),
    ).toBe(true);

    resetStatus();
  });

  it("dismisses the success card and opens the changelog from the pill", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "success",
      step: "",
      installedVersion: "2.0.8",
    });

    expect(card().classList.contains("hidden")).toBe(false);

    pill().click();

    const types = vi.mocked(postMessage).mock.calls.map(
      (call) => call[0].type,
    );
    expect(types).toEqual([
      "dismissOpenCodeUpdate",
      "requestOpenCodeChangelog",
    ]);
    expect(card().classList.contains("hidden")).toBe(true);
    expect(
      document.getElementById("ocu-changelog")?.classList.contains("hidden"),
    ).toBe(false);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    resetStatus();
  });

  it("renders a generic failure title when no version was verified", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "failed",
      step: "",
      detail: "upgrade command failed: timeout",
    });

    expect(card().textContent).toContain("upgrade command failed: timeout");
    expect(card().getAttribute("role")).toBe("alert");
    expect(card().textContent).not.toContain("version is still");
  });

  it("renders manual commands without a remediate action", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "failed",
      step: "",
      detail: "nvm trust failed",
      manualCommands: [
        "nvm firewall trust module opencode",
        "nvm reshim",
      ],
    });

    expect(card().textContent).toContain(
      "nvm firewall trust module opencode",
    );
    expect(card().querySelector('[data-ocu-act="remediate"]')).toBeNull();
  });

  it("shows update progress as a toolbar line instead of a card", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "updating",
      step: "execute",
      history: [
        { step: "prepare-target", ok: true, label: "Resolve latest version" },
        { step: "prepare-local", ok: true, label: "Read installed version" },
      ],
    });

    const line = document.getElementById("ocu-progress");
    expect(line?.classList.contains("hidden")).toBe(false);
    expect(line?.textContent).toContain("Downloading and installing 3/5");
    // The spinner sits between the version pill and the step text.
    expect(line?.querySelector(".ocu-progress-spin")).not.toBeNull();
    expect(line?.querySelector('[data-ocu-act="abandon"]')).toBeNull();
    // No progress card anymore: updating renders no card.
    expect(card().classList.contains("hidden")).toBe(true);

    resetStatus();

    expect(
      document.getElementById("ocu-progress")?.classList.contains("hidden"),
    ).toBe(true);
  });

  it("exposes the abandon exit on the progress line during remediation", () => {
    vi.mocked(postMessage).mockClear();
    vi.useFakeTimers();
    try {
      resetStatus();
      applyOpenCodeUpdateStatus({
        state: "updating",
        step: "remediate-trust",
      });

      const line = document.getElementById("ocu-progress");
      expect(line?.textContent).toContain("Apply nvm trust setting");
      const abandon = line?.querySelector<HTMLButtonElement>(
        '[data-ocu-act="abandon"]',
      );
      expect(abandon).not.toBeNull();

      abandon?.click();

      expect(postMessage).toHaveBeenCalledWith({
        type: "abandonOpenCodeUpdate",
      });
      expect(card().textContent).toContain("Install abandoned");

      vi.advanceTimersByTime(4500);
      expect(card().classList.contains("hidden")).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    resetStatus();
  });

  it("toggles the log drawer from the pill while updating", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "updating",
      step: "execute",
      history: [
        { step: "prepare-target", ok: true, label: "Resolve latest version" },
      ],
    });

    const drawerEl = document.getElementById("ocu-drawer");
    expect(drawerEl?.classList.contains("hidden")).toBe(true);

    pill().click();

    expect(drawerEl?.classList.contains("hidden")).toBe(false);
    expect(drawerEl?.textContent).toContain("Resolve latest version");
    expect(postMessage).not.toHaveBeenCalled();

    pill().click();

    expect(drawerEl?.classList.contains("hidden")).toBe(true);

    resetStatus();
  });

  it("restores the failure card after a transient hint expires", () => {
    vi.useFakeTimers();
    try {
      resetStatus();
      applyOpenCodeUpdateStatus({
        state: "failed",
        step: "",
        detail: "upgrade command failed",
        notice:
          "Could not check for updates. Check your network connection and try again.",
      });

      expect(card().classList.contains("hidden")).toBe(false);
      expect(card().textContent).toContain("Could not check for updates");

      vi.advanceTimersByTime(4500);

      expect(card().classList.contains("hidden")).toBe(false);
      expect(card().textContent).toContain("upgrade command failed");
      expect(card().getAttribute("role")).toBe("alert");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides the hint card after expiry when back to idle", () => {
    vi.useFakeTimers();
    try {
      resetStatus();
      applyOpenCodeUpdateStatus({
        state: "idle",
        step: "",
        notice: "Install abandoned",
      });

      expect(card().classList.contains("hidden")).toBe(false);
      expect(card().textContent).toContain("Install abandoned");

      vi.advanceTimersByTime(4500);

      expect(card().classList.contains("hidden")).toBe(true);
      expect(card().textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("dismisses via X on the success card like Esc", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "success",
      step: "",
      installedVersion: "2.0.7",
    });

    card().querySelector<HTMLButtonElement>('[data-ocu-act="x"]')?.click();

    expect(postMessage).toHaveBeenCalledWith({ type: "dismissOpenCodeUpdate" });
    expect(card().classList.contains("hidden")).toBe(true);
  });

  it("opens the popover on a manual-check available push and refreshes rows on the enrichment re-push", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      installedVersion: "2.0.9",
      latestVersion: "2.1.0",
      targetVersion: "2.1.0",
      openMethodPicker: true,
    });

    expect(popover().classList.contains("hidden")).toBe(false);
    expect(popover().querySelector("#ocu-popover-title")?.textContent).toBe(
      "Update OpenCode CLI to 2.1.0",
    );

    // Enrichment re-push without the flag: refresh in place, no toggle-close.
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      methods: ["npm", "bun"],
    });

    expect(popover().classList.contains("hidden")).toBe(false);
    const rows = Array.from(
      popover().querySelectorAll<HTMLElement>(".ocu-pop-row"),
    );
    expect(rows.map((row) => row.dataset.ocuMethod)).toEqual(["npm", "bun"]);

    resetStatus();
  });

  it("keeps the popover hidden for an automatic available push", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      currentVersion: "2.0.6",
      latestVersion: "2.0.7",
    });

    expect(popover().classList.contains("hidden")).toBe(true);

    resetStatus();
  });

  it("shows the install pill and opens the install popover when installable", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "installable",
      step: "",
      methods: ["npm", "pnpm", "brew", "scoop", "choco", "curl"],
      defaultMethod: "npm",
    });

    const pillEl = pill();
    expect(pillEl.classList.contains("hidden")).toBe(false);
    expect(pillEl.classList.contains("is-entry")).toBe(true);
    expect(document.getElementById("ocu-version-text")?.textContent).toBe(
      "Install",
    );
    expect(pillEl.getAttribute("title")).toBe(
      "OpenCode CLI is not installed. Click to choose an install method.",
    );
    expect(pillEl.getAttribute("aria-label")).toBe(
      "OpenCode CLI is not installed. Click to choose an install method.",
    );
    // No card in the installable state: the pill is the entry.
    expect(card().classList.contains("hidden")).toBe(true);

    pillEl.click();

    expect(popover().classList.contains("hidden")).toBe(false);
    expect(popover().querySelector("#ocu-popover-title")?.textContent).toBe(
      "Install OpenCode CLI",
    );
    const rows = Array.from(
      popover().querySelectorAll<HTMLElement>(".ocu-pop-row"),
    );
    expect(rows.map((row) => row.dataset.ocuMethod)).toEqual([
      "npm",
      "pnpm",
      "brew",
      "scoop",
      "choco",
      "curl",
    ]);

    rows[0].click();

    expect(postMessage).toHaveBeenCalledWith({
      type: "startOpenCodeUpdate",
      method: "npm",
    });
    expect(popover().classList.contains("hidden")).toBe(true);

    resetStatus();
  });

  it("drops the detected mark when entering the installable state", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      latestVersion: "2.1.0",
      detectedMethod: "npm",
      openMethodPicker: true,
    });
    expect(
      popover().querySelector(".ocu-tag-det"),
    ).not.toBeNull();

    applyOpenCodeUpdateStatus({
      state: "installable",
      step: "",
      methods: ["npm", "curl"],
      defaultMethod: "npm",
      // The host clears the detected mark explicitly; the webview merge
      // keeps stale values for absent keys.
      detectedMethod: undefined,
    });

    expect(popover().classList.contains("hidden")).toBe(false);
    expect(popover().querySelector(".ocu-tag-det")).toBeNull();
    expect(popover().querySelector("#ocu-popover-title")?.textContent).toBe(
      "Install OpenCode CLI",
    );

    resetStatus();
  });

  // ── Changelog dialog ──

  it("shows the changelog entry only in the update popover", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "installable",
      step: "",
      methods: ["npm"],
      defaultMethod: "npm",
    });
    pill().click();
    expect(
      popover().querySelector("#ocu-pop-changelog")?.classList.contains("hidden"),
    ).toBe(true);
    resetStatus();

    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      latestVersion: "2.1.0",
      openMethodPicker: true,
    });
    expect(
      popover().querySelector("#ocu-pop-changelog")?.classList.contains("hidden"),
    ).toBe(false);

    resetStatus();
  });

  it("opens the changelog dialog from the popover and renders the payload", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      latestVersion: "2.1.0",
      openMethodPicker: true,
    });

    popover().querySelector<HTMLButtonElement>("#ocu-pop-changelog")?.click();

    expect(postMessage).toHaveBeenCalledWith({
      type: "requestOpenCodeChangelog",
    });
    const dialog = document.getElementById("ocu-changelog");
    expect(dialog?.classList.contains("hidden")).toBe(false);
    expect(dialog?.textContent).toContain("Fetching changelog");
    // Update-flow entry: the footer check action stays hidden.
    expect(
      dialog?.querySelector(".ocu-cl-foot")?.classList.contains("hidden"),
    ).toBe(true);

    applyOpenCodeChangelog({
      version: "2.1.0",
      ok: true,
      date: "2026-10-13",
      html:
        '<section class="highlights"><ul><li><p class="title">Something new</p>' +
        '<p>Details with <a href="https://github.com/anomalyco/opencode/pull/1">#1</a></p></li></ul></section>',
      fallbackUrl: "https://opencode.ai/changelog#v2-1-0",
    });

    expect(dialog?.querySelector("#ocu-cl-title")?.textContent).toBe(
      "OpenCode 2.1.0",
    );
    expect(dialog?.textContent).toContain("Something new");
    expect(dialog?.textContent).toContain("2026-10-13");

    dialog.querySelector<HTMLAnchorElement>("a[href]")?.click();
    expect(postMessage).toHaveBeenCalledWith({
      type: "openUrl",
      url: "https://github.com/anomalyco/opencode/pull/1",
    });

    resetStatus();
  });

  it("falls back to the browser link when the changelog is unavailable", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      latestVersion: "2.1.0",
      openMethodPicker: true,
    });

    popover().querySelector<HTMLButtonElement>("#ocu-pop-changelog")?.click();
    applyOpenCodeChangelog({
      version: "2.1.0",
      ok: false,
      fallbackUrl: "https://opencode.ai/changelog#v2-1-0",
    });

    const dialog = document.getElementById("ocu-changelog");
    expect(dialog?.textContent).toContain("unavailable for this version");

    dialog.querySelector<HTMLButtonElement>('[data-ocu-cl="open"]')?.click();
    expect(postMessage).toHaveBeenCalledWith({
      type: "openUrl",
      url: "https://opencode.ai/changelog#v2-1-0",
    });

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(dialog?.classList.contains("hidden")).toBe(true);

    resetStatus();
  });

  it("restarts and shows the changelog from the success card in one click", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "success",
      step: "",
      installedVersion: "2.1.0",
      targetVersion: "2.1.0",
    });

    expect(
      card().querySelector('[data-ocu-act="restart-changelog"]'),
    ).not.toBeNull();

    card()
      .querySelector<HTMLButtonElement>('[data-ocu-act="restart-changelog"]')
      ?.click();

    // The changelog request leaves before the restart so the version
    // fields are still set when the host resolves the notes.
    const types = vi.mocked(postMessage).mock.calls.map(
      (call) => call[0].type,
    );
    expect(types).toEqual(["requestOpenCodeChangelog", "restartAfterUpdate"]);
    expect(card().classList.contains("hidden")).toBe(true);
    expect(
      document.getElementById("ocu-changelog")?.classList.contains("hidden"),
    ).toBe(false);
    // The fresh version just landed: no check action in the footer.
    expect(
      document
        .getElementById("ocu-changelog")
        ?.querySelector(".ocu-cl-foot")
        ?.classList.contains("hidden"),
    ).toBe(true);

    applyOpenCodeChangelog({
      version: "2.1.0",
      ok: true,
      date: "2026-10-13",
      html:
        '<section class="highlights"><ul><li><p class="title">New</p></li></ul></section>',
      fallbackUrl: "https://opencode.ai/changelog#v2-1-0",
    });

    // Sending waits out the restart running behind the dialog.
    const sendBtn = document
      .getElementById("ocu-changelog")
      ?.querySelector<HTMLButtonElement>('[data-ocu-cl="send"]');
    expect(sendBtn?.disabled).toBe(true);

    notifyOpenCodeSessionStarted();

    expect(sendBtn?.disabled).toBe(false);

    resetStatus();
  });

  it("offers a changelog entry on the auto-started success card", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "success",
      step: "",
      installedVersion: "2.1.0",
      sessionAutoStarted: true,
    });

    card()
      .querySelector<HTMLButtonElement>('[data-ocu-act="changelog"]')
      ?.click();

    expect(postMessage).toHaveBeenCalledWith({
      type: "requestOpenCodeChangelog",
    });
    const types = vi.mocked(postMessage).mock.calls.map(
      (call) => call[0].type,
    );
    expect(types).not.toContain("restartAfterUpdate");
    expect(
      document.getElementById("ocu-changelog")?.classList.contains("hidden"),
    ).toBe(false);
    // Same as the restart variant: the fresh version just landed.
    expect(
      document
        .getElementById("ocu-changelog")
        ?.querySelector(".ocu-cl-foot")
        ?.classList.contains("hidden"),
    ).toBe(true);

    resetStatus();
  });

  it("copies the changelog text from the dialog header", async () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    try {
      applyOpenCodeUpdateStatus({
        state: "available",
        step: "",
        latestVersion: "2.1.0",
        openMethodPicker: true,
      });
      popover().querySelector<HTMLButtonElement>("#ocu-pop-changelog")?.click();
      applyOpenCodeChangelog({
        version: "2.1.0",
        ok: true,
        date: "2026-10-13",
        html:
          '<section class="highlights"><ul><li><p class="title">Something new</p></li></ul></section>',
        fallbackUrl: "https://opencode.ai/changelog",
      });

      const dialog = document.getElementById("ocu-changelog");
      const copyBtn = dialog?.querySelector<HTMLButtonElement>(
        '[data-ocu-cl="copy"]',
      );
      expect(copyBtn?.classList.contains("hidden")).toBe(false);

      copyBtn?.click();

      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("OpenCode 2.1.0"),
      );
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("Something new"),
      );
      // The label flips inside the clipboard promise's microtask.
      await vi.waitFor(() => {
        expect(copyBtn?.querySelector(".ocu-copy-label")?.textContent).toBe(
          "Copied",
        );
      });
    } finally {
      delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    }

    resetStatus();
  });

  it("checks for new versions from inside the changelog dialog", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "idle",
      step: "",
      installedVersion: "2.0.7",
    });
    pill().click();
    vi.mocked(postMessage).mockClear();

    const dialog = document.getElementById("ocu-changelog");
    dialog
      .querySelector<HTMLButtonElement>('[data-ocu-cl="check"]')
      ?.click();

    expect(postMessage).toHaveBeenCalledWith({
      type: "checkOpenCodeUpdates",
    });
    expect(dialog?.querySelector("#ocu-cl-status")?.textContent).toContain(
      "Checking for updates",
    );

    // A found update hands the flow over to the method popover.
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      latestVersion: "2.1.0",
      openMethodPicker: true,
    });

    expect(dialog?.classList.contains("hidden")).toBe(true);
    expect(popover().classList.contains("hidden")).toBe(false);

    resetStatus();
  });

  it("reports the up-to-date result inside the changelog dialog", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "idle",
      step: "",
      installedVersion: "2.0.7",
    });
    pill().click();

    document
      .getElementById("ocu-changelog")
      ?.querySelector<HTMLButtonElement>('[data-ocu-cl="check"]')
      ?.click();

    applyOpenCodeUpdateStatus({
      state: "idle",
      step: "",
      installedVersion: "2.0.7",
      latestVersion: "2.0.7",
      checkOutcome: "upToDate",
    });

    const dialog = document.getElementById("ocu-changelog");
    expect(dialog?.classList.contains("hidden")).toBe(false);
    expect(dialog?.querySelector("#ocu-cl-status")?.textContent).toContain(
      "Already on the latest version.",
    );
    expect(
      dialog?.querySelector<HTMLButtonElement>('[data-ocu-cl="check"]')
        ?.disabled,
    ).toBe(false);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    resetStatus();
  });

  it("sends the changelog to the OpenCode session from the dialog", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      latestVersion: "2.1.0",
      openMethodPicker: true,
    });
    popover().querySelector<HTMLButtonElement>("#ocu-pop-changelog")?.click();
    applyOpenCodeChangelog({
      version: "2.1.0",
      ok: true,
      date: "2026-10-13",
      html:
        '<section class="highlights"><ul><li><p class="title">Something new</p></li></ul></section>',
      fallbackUrl: "https://opencode.ai/changelog#v2-1-0",
    });

    const dialog = document.getElementById("ocu-changelog");
    const sendBtn = dialog?.querySelector<HTMLButtonElement>(
      '[data-ocu-cl="send"]',
    );
    expect(sendBtn?.classList.contains("hidden")).toBe(false);

    sendBtn?.click();

    expect(postMessage).toHaveBeenCalledWith({
      type: "sendChangelogToOpenCode",
      text: expect.stringContaining("OpenCode 2.1.0"),
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: "sendChangelogToOpenCode",
      text: expect.stringContaining("Something new"),
    });
    // The send payload carries the summarization prompt with the version.
    expect(postMessage).toHaveBeenCalledWith({
      type: "sendChangelogToOpenCode",
      text: expect.stringContaining("\n---\nThe above is the OpenCode 2.1.0"),
    });
    // The dialog closes so the user can watch the session.
    expect(dialog?.classList.contains("hidden")).toBe(true);
    expect(sendBtn?.querySelector(".ocu-copy-label")?.textContent).toBe(
      "Sent",
    );

    resetStatus();
  });

  // ── Missing-CLI install confirmation dialog ──

  /** Arms the pending edge, then pushes installable + pending. */
  function pushPendingInstallable(): void {
    applyOpenCodeUpdateStatus({
      state: "installable",
      step: "",
      methods: ["npm"],
      defaultMethod: "npm",
      installPromptPending: false,
    });
    applyOpenCodeUpdateStatus({
      state: "installable",
      step: "",
      installPromptPending: true,
    });
  }

  it("shows the install confirmation once for a pending installable push", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();

    pushPendingInstallable();

    const dialog = installDialog();
    expect(dialog.classList.contains("hidden")).toBe(false);
    expect(
      dialog.querySelector(".ocu-ip-dialog")?.getAttribute("role"),
    ).toBe("alertdialog");
    expect(dialog.textContent).toContain("Install OpenCode CLI");
    expect(dialog.textContent).toContain(
      "OpenCode CLI was not found on this machine. Install it now?",
    );
    expect(document.activeElement).toBe(
      dialog.querySelector('[data-ocu-ip="install"]'),
    );

    // A status re-push with the flag still set never re-pops or rebuilds.
    applyOpenCodeUpdateStatus({
      state: "installable",
      step: "",
      installPromptPending: true,
    });
    expect(installDialog()).toBe(dialog);
    expect(dialog.classList.contains("hidden")).toBe(false);

    dialog
      .querySelector<HTMLButtonElement>('[data-ocu-ip="notNow"]')
      ?.click();

    expect(dialog.classList.contains("hidden")).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({
      type: "answerCliInstallPrompt",
      action: "notNow",
    });

    resetStatus();
  });

  it("does not show the confirmation without the pending flag or from the pill", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();

    applyOpenCodeUpdateStatus({
      state: "installable",
      step: "",
      methods: ["npm"],
      defaultMethod: "npm",
      installPromptPending: false,
    });

    expect(installDialog().classList.contains("hidden")).toBe(true);

    // A direct pill click opens the popover, never the confirmation.
    pill().click();

    expect(popover().classList.contains("hidden")).toBe(false);
    expect(installDialog().classList.contains("hidden")).toBe(true);

    resetStatus();
  });

  it("opens the method popover and answers install on the primary button", () => {
    vi.mocked(postMessage).mockClear();
    resetStatus();

    pushPendingInstallable();

    installDialog()
      .querySelector<HTMLButtonElement>('[data-ocu-ip="install"]')
      ?.click();

    expect(installDialog().classList.contains("hidden")).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({
      type: "answerCliInstallPrompt",
      action: "install",
    });
    expect(popover().classList.contains("hidden")).toBe(false);
    expect(popover().querySelector("#ocu-popover-title")?.textContent).toBe(
      "Install OpenCode CLI",
    );

    resetStatus();
  });

  it("treats Esc and backdrop clicks like Not now", () => {
    resetStatus();

    pushPendingInstallable();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(installDialog().classList.contains("hidden")).toBe(true);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "answerCliInstallPrompt",
      action: "notNow",
    });

    // Re-arm via the host's clearing round-trip, then click the backdrop.
    applyOpenCodeUpdateStatus({
      state: "installable",
      step: "",
      installPromptPending: false,
    });
    pushPendingInstallable();
    installDialog().dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );

    expect(installDialog().classList.contains("hidden")).toBe(true);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "answerCliInstallPrompt",
      action: "notNow",
    });

    resetStatus();
  });

  it("hides the install confirmation when the state leaves installable", () => {
    resetStatus();

    pushPendingInstallable();
    expect(installDialog().classList.contains("hidden")).toBe(false);
    expect(isInstallPromptVisible()).toBe(true);

    // The flow starts: the confirmation must not linger.
    applyOpenCodeUpdateStatus({ state: "updating", step: "installing" });

    expect(installDialog().classList.contains("hidden")).toBe(true);
    expect(isInstallPromptVisible()).toBe(false);

    resetStatus();
  });

  it("renders three actions including re-detect in the install confirmation", () => {
    resetStatus();

    pushPendingInstallable();
    const dialog = installDialog();
    expect(dialog.textContent).toContain("Re-detect");

    const ids = Array.from(dialog.querySelectorAll("[data-ocu-ip]")).map(
      (button) => (button as HTMLElement).dataset.ocuIp,
    );
    expect(ids).toEqual(["install", "retry", "notNow"]);

    resetStatus();
  });

  it("disables every dialog action while a re-detect is in flight", () => {
    resetStatus();

    pushPendingInstallable();
    const dialog = installDialog();
    const buttons = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>(".ocu-ip-btn"),
    );
    expect(buttons.every((button) => !button.disabled)).toBe(true);

    dialog
      .querySelector<HTMLButtonElement>('[data-ocu-ip="retry"]')
      ?.click();

    expect(postMessage).toHaveBeenCalledWith({ type: "retryCliProbe" });
    expect(buttons.every((button) => button.disabled)).toBe(true);

    resetStatus();
  });

  it("keeps the dialog open with the still-missing result when the re-detect fails", () => {
    resetStatus();

    pushPendingInstallable();
    const dialog = installDialog();
    dialog
      .querySelector<HTMLButtonElement>('[data-ocu-ip="retry"]')
      ?.click();

    // Host answer: still installable, confirmation flag cleared.
    applyOpenCodeUpdateStatus({
      state: "installable",
      step: "",
      installPromptPending: false,
    });

    const buttons = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>(".ocu-ip-btn"),
    );
    expect(dialog.classList.contains("hidden")).toBe(false);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    expect(
      dialog.querySelector("#ocu-ip-result")?.classList.contains("hidden"),
    ).toBe(false);
    expect(dialog.textContent).toContain("OpenCode CLI still not detected");

    resetStatus();
  });

  it("closes the confirmation after a successful re-detect", () => {
    resetStatus();

    pushPendingInstallable();
    const dialog = installDialog();
    dialog
      .querySelector<HTMLButtonElement>('[data-ocu-ip="retry"]')
      ?.click();

    applyOpenCodeUpdateStatus({
      state: "idle",
      step: "",
      installedVersion: "2.1.0",
      currentVersion: "2.1.0",
    });

    expect(dialog.classList.contains("hidden")).toBe(true);
    const buttons = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>(".ocu-ip-btn"),
    );
    expect(buttons.every((button) => !button.disabled)).toBe(true);

    resetStatus();
  });

  it("shows the auto-started line instead of restart actions after an install", () => {
    resetStatus();

    applyOpenCodeUpdateStatus({
      state: "success",
      step: "",
      installedVersion: "2.1.0",
      sessionAutoStarted: true,
    });

    expect(card().classList.contains("hidden")).toBe(false);
    expect(card().querySelector('[data-ocu-act="restart"]')).toBeNull();
    expect(card().querySelector('[data-ocu-act="later"]')).toBeNull();
    expect(card().textContent).toContain(
      "OpenCode session started automatically.",
    );

    resetStatus();
  });

  it("keeps the restart actions for a regular update success", () => {
    resetStatus();

    applyOpenCodeUpdateStatus({
      state: "success",
      step: "",
      installedVersion: "2.0.7",
    });

    expect(card().querySelector('[data-ocu-act="restart"]')).not.toBeNull();
    expect(card().querySelector('[data-ocu-act="later"]')).not.toBeNull();

    resetStatus();
  });

  it("closes the popover via the cancel button and restores pill focus", () => {
    resetStatus();
    applyOpenCodeUpdateStatus({
      state: "available",
      step: "",
      latestVersion: "2.1.0",
      openMethodPicker: true,
    });

    expect(popover().classList.contains("hidden")).toBe(false);

    popover().querySelector<HTMLButtonElement>("#ocu-pop-cancel")?.click();

    expect(popover().classList.contains("hidden")).toBe(true);
    expect(document.activeElement).toBe(pill());

    resetStatus();
  });

  it("keeps the keyboard hints as an aria-hidden group inside the footer", () => {
    const foot = popover().querySelector<HTMLElement>(".ocu-pop-foot");
    const hints = popover().querySelector<HTMLElement>(".ocu-pop-hints");

    expect(foot?.getAttribute("aria-hidden")).toBeNull();
    expect(hints?.getAttribute("aria-hidden")).toBe("true");
    expect(hints?.textContent).toContain("Enter to confirm");
    expect(hints?.textContent).toContain("Esc to cancel");
    expect(hints?.textContent).toContain("Up and down to switch");
  });
});
