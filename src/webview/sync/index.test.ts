// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../shared/vscode-api", () => ({
  postMessage: vi.fn(),
  acquireVsCodeApi: vi.fn(() => ({ postMessage: vi.fn() })),
}));

import { postMessage } from "../shared/vscode-api";
import type {
  WebDavSyncSettings,
  WebDavSyncSnapshot,
} from "../../types";
import { renderSyncShell, type SyncShellStrings } from "./shell";
import { applySnapshotToPanel } from "./panel";
import {
  applyWebdavSyncData,
  applyWebdavStatus,
  applyWebdavLog,
  applyWebdavSaveResult,
  closeSyncPanel,
  initSyncUi,
} from "./index";
import {
  mergeDelta,
  mergeSnapshot,
  syncIconInfo,
  initialSyncUiState,
} from "./state";

function syncSettings(overrides: Partial<WebDavSyncSettings> = {}): WebDavSyncSettings {
  return {
    url: "https://dav.example.com",
    username: "sage",
    basePath: "/opencode-config/",
    allowInsecureHttp: false,
    acceptSelfSigned: false,
    autoSync: { enabled: true, onStartup: true, onLocalChange: true, remotePoll: true },
    pollIntervalMinutes: 30,
    showStatusIcon: true,
    passwordSet: true,
    ...overrides,
  };
}

function snapshot(overrides: Partial<WebDavSyncSnapshot> = {}): WebDavSyncSnapshot {
  return {
    state: "idle",
    pendingCount: 0,
    conflictCount: 0,
    autoSyncPaused: false,
    leader: true,
    settings: syncSettings(),
    items: [
      { id: "opencode", path: "opencode.json", kind: "file", enabled: true, builtin: true },
      { id: "agents", path: "AGENTS.md", kind: "file", enabled: true, builtin: true },
      { id: "skills", path: "skills/", kind: "dir", enabled: true, builtin: true },
      { id: "custom", path: "rules/team.md", kind: "file", enabled: false, builtin: false },
      { id: "pat", path: "re:.*\\.tmp", kind: "pattern", enabled: true, builtin: false },
    ],
    excludes: ["logs/", "re:.*\\.bak"],
    conflicts: [],
    history: [
      { time: Date.now(), direction: "up", files: 4, result: "success", message: "uploaded" },
    ],
    ...overrides,
  };
}

const SHELL: SyncShellStrings = {
  tipDismiss: "Hide the status icon for now",
  actSyncNow: "Sync now",
  panelTitle: "OpenCode config sync",
  panelAria: "OpenCode config sync",
  closeTitle: "Close",
  saveBtnHint: "Save server settings",
  navGeneral: "General",
  navServer: "Server",
  unconfiguredBanner: "WebDAV server is not configured yet.",
  unconfiguredGo: "Set up now",
  navItems: "Items",
  navConflict: "Conflicts",
  navHistory: "History",
  navLog: "Log",
  fUrl: "Server URL",
  fUrlHint: "",
  fUser: "Username",
  fPass: "Password",
  passSetBadge: "Stored",
  fBasePath: "basePath",
  fRateLimit: "Rate limit",
  fRateLimitUnlimited: "unlimited",
  fRateLimitRequests: "requests",
  fRateLimitPer: "per",
  fRateLimitMinutes: "min",
  fRateLimitHint: "0 means no limit; e.g. 600 requests per 30 minutes for Jianguoyun.",
  fHttp: "HTTP",
  fHttpHint: "",
  fSelfSigned: "Self-signed",
  fSelfSignedHint: "",
  fShowIcon: "Show icon",
  fShowIconHint: "",
  panelIntro: "",
  autoSync: "Auto sync",
  chevTitle: "Collapse",
  fStartup: "Startup",
  fStartupHint: "",
  fLocal: "Local changes",
  fLocalHint: "",
  fPoll: "Poll",
  fPollHint: "",
  pollInterval: "Interval",
  pollUnit: "min",
  testBtn: "Test",
  saveBtn: "Save",
  itemsTitle: "Sync items",
  addPlaceholder: "path",
  addBtn: "Add",
  itemsHintPrefix: "Paths are relative to the",
  itemsHintLink: "OpenCode config directory",
  itemsHintSuffix: "; use an re: prefix to add a regex item",
  excludeTitle: "Exclusions",
  excludePlaceholder: "path or re:",
  excludeAddBtn: "Add",
  excludeHint: "hint",
  hTime: "Time",
  hTrigger: "Trigger",
  hResult: "Result",
  hSummary: "Summary",
  histClear: "Clear history",
};

function icon(): HTMLElement {
  return document.getElementById("btn-dav-sync-status") as HTMLElement;
}

function overlay(): HTMLElement {
  return document.getElementById("dav-overlay") as HTMLElement;
}

function posted(): unknown[] {
  return vi.mocked(postMessage).mock.calls.map((call) => call[0]);
}

/** jsdom has no layout: fake the pre's scroll geometry with own
 *  properties so tail-follow logic is observable in tests. */
function mockPreScroll(
  pre: HTMLElement,
  scrollHeight: number,
  clientHeight: number,
): { top: () => number; setTop: (v: number) => void } {
  let top = 0;
  Object.defineProperty(pre, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(pre, "clientHeight", {
    value: clientHeight,
    configurable: true,
  });
  Object.defineProperty(pre, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      top = v;
    },
    configurable: true,
  });
  return {
    top: () => top,
    setTop: (v: number) => {
      top = v;
    },
  };
}

/** Let a pending requestAnimationFrame callback (log tab scroll) run. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("sync UI (webview)", () => {
  // vitest resets mocks before each test, so init-time posts are captured
  // right after initialization (same pattern as update/index.test.ts).
  let initPosts: unknown[] = [];

  beforeAll(() => {
    document.body.innerHTML = `
      <div class="toolbar">
        <button type="button" id="btn-dav-sync-status" class="dav-sync-dot hidden" aria-haspopup="dialog">
          <span id="dav-sync-glyph"></span><span class="dav-sync-count hidden" id="dav-sync-count"></span>
        </button>
        <button type="button" id="btn-dav-sync-panel" class="toolbar-btn hidden"></button>
      </div>
      ${renderSyncShell(SHELL)}`;
    initSyncUi();
    initPosts = vi.mocked(postMessage).mock.calls.map((call) => call[0]);
  });

  it("reveals the toolbar cloud sync button on init", () => {
    expect(
      document.getElementById("btn-dav-sync-panel")?.classList.contains("hidden"),
    ).toBe(false);
  });

  it("requests the snapshot on init", () => {
    const messages = initPosts.filter(
      (m) => (m as { type: string }).type === "requestWebdavSyncData",
    );
    expect(messages).toHaveLength(1);
  });

  it("asks the host to open the config directory from the items hint", () => {
    document.getElementById("dav-open-config-dir")?.click();
    expect(postMessage).toHaveBeenCalledWith({
      type: "openOpenCodeConfigDir",
    });
  });

  describe("status icon visibility matrix", () => {
    it("hides for unconfigured and idle", () => {
      applyWebdavSyncData(snapshot({ state: "unconfigured", settings: syncSettings({ url: "" }) }));
      expect(icon().classList.contains("hidden")).toBe(true);
      applyWebdavSyncData(snapshot());
      expect(icon().classList.contains("hidden")).toBe(true);
    });

    it("shows with count for pending / conflict, plain for syncing / error / paused", () => {
      applyWebdavSyncData(snapshot({ pendingCount: 2 }));
      expect(icon().classList.contains("hidden")).toBe(false);
      expect(icon().dataset.state).toBe("pending");
      expect(document.getElementById("dav-sync-count")?.textContent).toBe("2");

      applyWebdavSyncData(snapshot({ conflictCount: 1, pendingCount: 0 }));
      expect(icon().dataset.state).toBe("conflict");
      expect(document.getElementById("dav-sync-count")?.textContent).toBe("1");

      applyWebdavSyncData(snapshot({ state: "syncing", conflictCount: 0 }));
      expect(icon().dataset.state).toBe("syncing");
      expect(document.getElementById("dav-sync-count")?.classList.contains("hidden")).toBe(true);

      applyWebdavSyncData(snapshot({ state: "error" }));
      expect(icon().dataset.state).toBe("error");

      applyWebdavSyncData(snapshot({ autoSyncPaused: true }));
      expect(icon().dataset.state).toBe("error");

      applyWebdavSyncData(snapshot({ state: "needsAuth" }));
      expect(icon().dataset.state).toBe("auth");
      expect(
        document.getElementById("dav-sync-count")?.classList.contains("hidden"),
      ).toBe(true);
    });

    it("respects the showStatusIcon master switch", () => {
      applyWebdavSyncData(
        snapshot({ pendingCount: 3, settings: syncSettings({ showStatusIcon: false }) }),
      );
      expect(icon().classList.contains("hidden")).toBe(true);
      applyWebdavSyncData(snapshot({ pendingCount: 3 }));
      expect(icon().classList.contains("hidden")).toBe(false);
    });
  });

  describe("status icon tooltip", () => {
    /** Hover the icon and fast-forward the open delay. */
    function hoverOpen(): void {
      icon().dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(400);
    }

    it("shows the current status text after the hover delay", () => {
      vi.useFakeTimers();
      try {
        applyWebdavSyncData(snapshot({ conflictCount: 2 }));
        const tip = document.getElementById("dav-sync-tip") as HTMLElement;
        icon().dispatchEvent(new MouseEvent("mouseenter"));
        expect(tip.classList.contains("hidden")).toBe(true);
        vi.advanceTimersByTime(400);
        expect(tip.classList.contains("hidden")).toBe(false);
        expect(
          document.getElementById("dav-sync-tip-text")?.textContent,
        ).toBe("2 file(s) need conflict resolution");
        expect(icon().getAttribute("aria-describedby")).toBe("dav-sync-tip");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(tip.classList.contains("hidden")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("bridges the gap to the tooltip and closes after the grace period", () => {
      vi.useFakeTimers();
      try {
        applyWebdavSyncData(snapshot({ pendingCount: 3 }));
        const tip = document.getElementById("dav-sync-tip") as HTMLElement;
        hoverOpen();
        expect(tip.classList.contains("hidden")).toBe(false);
        // Pointer leaves the icon toward the tooltip: grace period starts.
        icon().dispatchEvent(new MouseEvent("mouseleave"));
        // Pointer reaches the tooltip before the grace expires: stays open.
        tip.dispatchEvent(new MouseEvent("mouseenter"));
        vi.advanceTimersByTime(300);
        expect(tip.classList.contains("hidden")).toBe(false);
        // Leaving the tooltip too closes after the grace period.
        tip.dispatchEvent(new MouseEvent("mouseleave"));
        vi.advanceTimersByTime(200);
        expect(tip.classList.contains("hidden")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("closes on icon click and opens the matching panel section", () => {
      vi.useFakeTimers();
      try {
        applyWebdavSyncData(snapshot({ conflictCount: 1 }));
        const tip = document.getElementById("dav-sync-tip") as HTMLElement;
        hoverOpen();
        expect(tip.classList.contains("hidden")).toBe(false);
        icon().click();
        expect(tip.classList.contains("hidden")).toBe(true);
        expect(overlay().classList.contains("hidden")).toBe(false);
        expect(
          document
            .querySelector('.dav-pane[data-pane="conflict"]')
            ?.classList.contains("is-on"),
        ).toBe(true);
        // The click acknowledges the status: the icon hides for now.
        expect(icon().classList.contains("hidden")).toBe(true);
        document.getElementById("dav-modal-close")?.click();
        // A cleared status resets the dismissal.
        applyWebdavSyncData(snapshot());
      } finally {
        vi.useRealTimers();
      }
    });

    it("hides the icon on dismiss and keeps same-kind statuses hidden", () => {
      vi.useFakeTimers();
      try {
        applyWebdavSyncData(snapshot({ conflictCount: 2 }));
        hoverOpen();
        document.getElementById("dav-sync-tip-close")?.click();
        expect(icon().classList.contains("hidden")).toBe(true);
        expect(
          document.getElementById("dav-sync-tip")?.classList.contains("hidden"),
        ).toBe(true);
        // Same kind with a grown count: dismissal still applies.
        applyWebdavSyncData(snapshot({ conflictCount: 5 }));
        expect(icon().classList.contains("hidden")).toBe(true);
      } finally {
        // Normalize: an idle snapshot clears the dismissal.
        applyWebdavSyncData(snapshot());
        vi.useRealTimers();
      }
    });

    it("un-hides for a different kind and after the status clears", () => {
      vi.useFakeTimers();
      try {
        applyWebdavSyncData(snapshot({ conflictCount: 2 }));
        hoverOpen();
        document.getElementById("dav-sync-tip-close")?.click();
        expect(icon().classList.contains("hidden")).toBe(true);
        // Different kind: dismissal clears, the icon returns.
        applyWebdavSyncData(snapshot({ conflictCount: 0, pendingCount: 4 }));
        expect(icon().classList.contains("hidden")).toBe(false);
        expect(icon().dataset.state).toBe("pending");
        // Status fully clears, then a later new conflict shows again.
        applyWebdavSyncData(snapshot());
        expect(icon().classList.contains("hidden")).toBe(true);
        applyWebdavSyncData(snapshot({ conflictCount: 1 }));
        expect(icon().classList.contains("hidden")).toBe(false);
      } finally {
        applyWebdavSyncData(snapshot());
        vi.useRealTimers();
      }
    });
  });

  describe("status icon and tooltip jump to the matching section", () => {
    /** Active pane after the last open action. */
    function activePane(): string | undefined {
      return document
        .querySelector<HTMLElement>(".dav-pane.is-on")
        ?.dataset.pane;
    }

    it("maps conflict, pending, error, paused and syncing to their sections", () => {
      const cases: Array<[Partial<WebDavSyncSnapshot>, string]> = [
        [{ conflictCount: 2 }, "conflict"],
        [{ pendingCount: 3 }, "items"],
        [{ state: "error" }, "log"],
        [{ autoSyncPaused: true }, "general"],
        [{ state: "needsAuth" }, "general"],
        [{ state: "syncing" }, "general"],
      ];
      for (const [patch, pane] of cases) {
        applyWebdavSyncData(snapshot(patch));
        expect(icon().classList.contains("hidden")).toBe(false);
        icon().click();
        expect(overlay().classList.contains("hidden")).toBe(false);
        expect(activePane()).toBe(pane);
        expect(icon().classList.contains("hidden")).toBe(true);
        document.getElementById("dav-modal-close")?.click();
      }
      // Reset the dismissal left by the last kind.
      applyWebdavSyncData(snapshot());
    });

    it("keeps the icon hidden for the same kind after a jump", () => {
      applyWebdavSyncData(snapshot({ conflictCount: 1 }));
      icon().click();
      document.getElementById("dav-modal-close")?.click();
      expect(icon().classList.contains("hidden")).toBe(true);
      // Same kind, grown count: still acknowledged.
      applyWebdavSyncData(snapshot({ conflictCount: 4 }));
      expect(icon().classList.contains("hidden")).toBe(true);
      // A different kind brings the icon back.
      applyWebdavSyncData(snapshot({ pendingCount: 2 }));
      expect(icon().classList.contains("hidden")).toBe(false);
      applyWebdavSyncData(snapshot());
    });

    it("opens the section from the icon itself, with no tooltip jump button", () => {
      vi.useFakeTimers();
      try {
        applyWebdavSyncData(snapshot({ conflictCount: 1 }));
        const tip = document.getElementById("dav-sync-tip") as HTMLElement;
        icon().dispatchEvent(new MouseEvent("mouseenter"));
        vi.advanceTimersByTime(400);
        expect(tip.classList.contains("hidden")).toBe(false);
        expect(document.getElementById("dav-sync-tip-go")).toBeNull();

        icon().click();
        expect(tip.classList.contains("hidden")).toBe(true);
        expect(overlay().classList.contains("hidden")).toBe(false);
        expect(activePane()).toBe("conflict");
        document.getElementById("dav-modal-close")?.click();
      } finally {
        applyWebdavSyncData(snapshot());
        vi.useRealTimers();
      }
    });
  });

  describe("panel (L2)", () => {
    it("opens via the cloud button and switches sections", () => {
      applyWebdavSyncData(snapshot());
      document.getElementById("btn-dav-sync-panel")?.click();
      expect(overlay().classList.contains("hidden")).toBe(false);
      expect(
        document.querySelector('.dav-pane[data-pane="general"]')?.classList.contains("is-on"),
      ).toBe(true);

      document.querySelector<HTMLButtonElement>('[data-pane="items"]')?.click();
      expect(
        document.querySelector('.dav-pane[data-pane="items"]')?.classList.contains("is-on"),
      ).toBe(true);
      document.getElementById("dav-modal-close")?.click();
      expect(overlay().classList.contains("hidden")).toBe(true);
    });

    it("closes on Escape", () => {
      applyWebdavSyncData(snapshot());
      icon().click();
      expect(overlay().classList.contains("hidden")).toBe(false);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(overlay().classList.contains("hidden")).toBe(true);
    });

    it("always lands on the general section, even when unconfigured", () => {
      applyWebdavSyncData(
        snapshot({ state: "unconfigured", settings: syncSettings({ url: "" }) }),
      );
      document.getElementById("btn-dav-sync-panel")?.click();
      expect(
        document.querySelector('.dav-pane[data-pane="general"]')?.classList.contains("is-on"),
      ).toBe(true);
      document.getElementById("dav-modal-close")?.click();
    });

    it("shows the unconfigured banner with a jump-to-server action", () => {
      applyWebdavSyncData(snapshot());
      const banner = document.getElementById("dav-unconfigured-banner") as HTMLElement;
      expect(banner.classList.contains("hidden")).toBe(true);

      applyWebdavSyncData(
        snapshot({ state: "unconfigured", settings: syncSettings({ url: "" }) }),
      );
      expect(banner.classList.contains("hidden")).toBe(false);
      document.querySelector<HTMLButtonElement>('[data-pane="general"]')?.click();
      document.getElementById("dav-unconfigured-go")?.click();
      expect(
        document.querySelector('.dav-pane[data-pane="server"]')?.classList.contains("is-on"),
      ).toBe(true);
    });

    it("shows a credentials banner tailored to missing vs rejected secrets", () => {
      applyWebdavSyncData(
        snapshot({ state: "needsAuth", settings: syncSettings({ passwordSet: false }) }),
      );
      const banner = document.getElementById("dav-auth-banner") as HTMLElement;
      expect(banner.classList.contains("hidden")).toBe(false);
      expect(
        document.getElementById("dav-auth-banner-text")?.textContent,
      ).toContain("not stored on this device");
      expect(document.getElementById("dav-sub-auth")?.hidden).toBe(false);

      document.querySelector<HTMLButtonElement>('[data-pane="general"]')?.click();
      document.getElementById("dav-auth-go")?.click();
      expect(
        document.querySelector('.dav-pane[data-pane="server"]')?.classList.contains("is-on"),
      ).toBe(true);
      expect(document.activeElement?.id).toBe("dav-f-pass");

      applyWebdavSyncData(
        snapshot({ state: "needsAuth", settings: syncSettings({ passwordSet: true }) }),
      );
      expect(
        document.getElementById("dav-auth-banner-text")?.textContent,
      ).toContain("rejected the stored credentials");

      applyWebdavSyncData(snapshot());
      expect(banner.classList.contains("hidden")).toBe(true);
      expect(document.getElementById("dav-sub-auth")?.hidden).toBe(true);
    });

    it("reports required credentials in the footer", () => {
      applyWebdavSyncData(snapshot({ state: "needsAuth" }));
      expect(document.getElementById("dav-foot-st")?.textContent).toBe(
        "Credentials required · enter the password in Server settings",
      );
      applyWebdavSyncData(snapshot());
    });

    it("lazy-loads the log on section entry", () => {
      document.getElementById("btn-dav-sync-panel")?.click();
      document.querySelector<HTMLButtonElement>('[data-pane="log"]')?.click();
      const requests = posted().filter(
        (m) => (m as { type: string }).type === "requestWebdavLog",
      );
      expect(requests).toHaveLength(1);
    });

    it("hides the trigger group when the master switch is off and force-expands on re-enable", () => {
      applyWebdavSyncData(snapshot());
      const group = document.getElementById("dav-auto-group") as HTMLElement;
      const chev = document.getElementById("dav-sub-toggle") as HTMLElement;
      const master = document.getElementById("dav-f-master") as HTMLInputElement;

      // Collapse first, then uncheck: group hides entirely.
      chev.click();
      expect(
        document.getElementById("dav-sub-body")?.classList.contains("is-collapsed"),
      ).toBe(true);
      master.checked = false;
      master.dispatchEvent(new Event("change"));
      expect(group.classList.contains("hidden")).toBe(true);
      expect(chev.classList.contains("hidden")).toBe(true);

      // Re-enable: force expanded regardless of the earlier collapsed state.
      master.checked = true;
      master.dispatchEvent(new Event("change"));
      expect(group.classList.contains("hidden")).toBe(false);
      expect(
        document.getElementById("dav-sub-body")?.classList.contains("is-collapsed"),
      ).toBe(false);
    });

    it("disables the interval input when polling is off", () => {
      applyWebdavSyncData(snapshot());
      const poll = document.getElementById("dav-f-poll") as HTMLInputElement;
      const interval = document.getElementById("dav-f-interval") as HTMLInputElement;
      expect(interval.disabled).toBe(false);
      poll.checked = false;
      poll.dispatchEvent(new Event("change"));
      expect(interval.disabled).toBe(true);
    });

    it("posts the server-only save and the connection draft with form values", () => {
      applyWebdavSyncData(snapshot());
      const basepath = document.getElementById("dav-f-basepath") as HTMLInputElement;
      basepath.value = "/new/";
      basepath.dispatchEvent(new Event("input"));
      const rateReq = document.getElementById("dav-f-ratelimit-req") as HTMLInputElement;
      const rateWindow = document.getElementById("dav-f-ratelimit-window") as HTMLInputElement;
      rateReq.value = "600";
      rateWindow.value = "45";
      (document.getElementById("dav-btn-save") as HTMLElement).click();
      const save = posted().pop() as {
        type: string;
        config: Record<string, unknown>;
      };
      expect(save.type).toBe("saveWebdavServerConfig");
      expect(save.config.basePath).toBe("/new/");
      expect(save.config.rateLimitMaxRequests).toBe(600);
      expect(save.config.rateLimitWindowMinutes).toBe(45);
      expect(save.config).not.toHaveProperty("autoSync");
      expect(save.config).not.toHaveProperty("showStatusIcon");

      // Empty rate inputs fall back to no-limit / the default window.
      rateReq.value = "";
      rateWindow.value = "";
      (document.getElementById("dav-btn-save") as HTMLElement).click();
      const defaults = posted().pop() as {
        config: Record<string, unknown>;
      };
      expect(defaults.config.rateLimitMaxRequests).toBe(0);
      expect(defaults.config.rateLimitWindowMinutes).toBe(30);

      (document.getElementById("dav-btn-test") as HTMLElement).click();
      const test = posted().pop() as { type: string; draft: { basePath: string } };
      expect(test.type).toBe("testWebdavConnection");
      expect(test.draft.basePath).toBe("/new/");

      // Restore the snapshot values so later snapshot applies see a clean form.
      basepath.value = "/opencode-config/";
      rateReq.value = "";
      rateWindow.value = "30";
    });

    it("applies options immediately on toggle and on interval commit", () => {
      applyWebdavSyncData(snapshot());
      const before = posted().length;
      const master = document.getElementById("dav-f-master") as HTMLInputElement;
      master.checked = false;
      master.dispatchEvent(new Event("change"));
      const apply = posted().pop() as {
        type: string;
        options: { autoSync: { enabled: boolean }; showStatusIcon: boolean };
      };
      expect(apply.type).toBe("applyWebdavSyncOptions");
      expect(apply.options.autoSync.enabled).toBe(false);
      expect(apply.options.showStatusIcon).toBe(true);

      const interval = document.getElementById("dav-f-interval") as HTMLInputElement;
      interval.value = "2";
      // 输入中不连发：input 事件不触发提交
      interval.dispatchEvent(new Event("input"));
      expect(posted().length).toBe(before + 1);
      // 失焦/回车提交（change 事件）才应用
      interval.dispatchEvent(new Event("change"));
      const commit = posted().pop() as {
        options: { pollIntervalMinutes: number };
      };
      expect(commit.options.pollIntervalMinutes).toBe(2);

      const icon = document.getElementById("dav-f-showicon") as HTMLInputElement;
      icon.checked = false;
      icon.dispatchEvent(new Event("change"));
      const iconApply = posted().pop() as {
        options: { showStatusIcon: boolean };
      };
      expect(iconApply.options.showStatusIcon).toBe(false);
    });

    it("highlights the save button for unsaved server edits and clears on snapshot", () => {
      applyWebdavSyncData(snapshot());
      const saveBtn = document.getElementById("dav-btn-save") as HTMLElement;
      expect(saveBtn.classList.contains("dav-btn--attention")).toBe(false);

      const url = document.getElementById("dav-f-url") as HTMLInputElement;
      url.value = "https://changed.example.com";
      url.dispatchEvent(new Event("input"));
      expect(saveBtn.classList.contains("dav-btn--attention")).toBe(true);

      // 快照回填与表单一致后高亮消失
      applyWebdavSyncData(
        snapshot({ settings: syncSettings({ url: "https://changed.example.com" }) }),
      );
      expect(saveBtn.classList.contains("dav-btn--attention")).toBe(false);
    });

    it("fills the server form on the first snapshot", () => {
      applySnapshotToPanel(
        snapshot({
          settings: syncSettings({ rateLimitMaxRequests: 600, rateLimitWindowMinutes: 45 }),
        }),
      );
      expect(
        (document.getElementById("dav-f-url") as HTMLInputElement).value,
      ).toBe("https://dav.example.com");
      expect(
        (document.getElementById("dav-f-user") as HTMLInputElement).value,
      ).toBe("sage");
      expect(
        (document.getElementById("dav-f-basepath") as HTMLInputElement).value,
      ).toBe("/opencode-config/");
      expect(
        (document.getElementById("dav-f-ratelimit-req") as HTMLInputElement).value,
      ).toBe("600");
      expect(
        (document.getElementById("dav-f-ratelimit-window") as HTMLInputElement).value,
      ).toBe("45");
      expect(
        (document.getElementById("dav-f-pass") as HTMLInputElement).value,
      ).toBe("");

      // A snapshot without rate-limit values renders the defaults:
      // unlimited renders as an empty input, window as 30.
      applySnapshotToPanel(snapshot());
      expect(
        (document.getElementById("dav-f-ratelimit-req") as HTMLInputElement).value,
      ).toBe("");
      expect(
        (document.getElementById("dav-f-ratelimit-window") as HTMLInputElement).value,
      ).toBe("30");
    });

    it("keeps unsaved server-card edits when a host snapshot arrives", () => {
      applyWebdavSyncData(snapshot());
      const url = document.getElementById("dav-f-url") as HTMLInputElement;
      const pass = document.getElementById("dav-f-pass") as HTMLInputElement;
      const rateReq = document.getElementById("dav-f-ratelimit-req") as HTMLInputElement;
      url.value = "https://edited.example.com";
      pass.value = "typed-secret";
      rateReq.value = "600";
      url.dispatchEvent(new Event("input"));

      applyWebdavSyncData(
        snapshot({
          conflictCount: 2,
          conflicts: [
            { id: "c1", path: "AGENTS.md", kind: "content", localMtime: 1, localSize: 10, remoteMtime: 2, remoteSize: 9 },
            { id: "c2", path: "skills/tool.md", kind: "remoteDeleted" },
          ],
        }),
      );
      // Unsaved edits survive the snapshot…
      expect(url.value).toBe("https://edited.example.com");
      expect(pass.value).toBe("typed-secret");
      expect(rateReq.value).toBe("600");
      // …while non-form snapshot updates still apply.
      expect(document.getElementById("dav-nav-conflict-count")?.textContent).toBe("2");
      expect(document.querySelectorAll(".dav-conflict-card")).toHaveLength(2);

      // Restore snapshot values so later applies see a clean form.
      url.value = "https://dav.example.com";
      pass.value = "";
      rateReq.value = "";
      applyWebdavSyncData(snapshot());
    });
  });

  describe("conflicts", () => {
    it("renders cards per kind and posts resolve / diff decisions", () => {
      applyWebdavSyncData(
        snapshot({
          conflictCount: 2,
          conflicts: [
            { id: "c1", path: "AGENTS.md", kind: "content", localMtime: 1, localSize: 100, remoteMtime: 2, remoteSize: 90 },
            { id: "c2", path: "skills/tool.md", kind: "remoteDeleted" },
          ],
        }),
      );
      const cards = document.querySelectorAll(".dav-conflict-card");
      expect(cards).toHaveLength(2);
      expect(document.querySelector('[data-conflict="c1"][data-resolution="local"]')).toBeTruthy();
      expect(document.getElementById("dav-nav-conflict-count")?.textContent).toBe("2");

      document
        .querySelector<HTMLElement>('[data-conflict="c1"][data-resolution="remote"]')
        ?.click();
      expect(posted().pop()).toEqual({
        type: "resolveWebdavConflict",
        id: "c1",
        resolution: "remote",
      });

      document.querySelector<HTMLElement>('[data-diff="c2"]')?.click();
      expect(posted().pop()).toEqual({ type: "openWebdavDiff", id: "c2" });
    });

    it("keeps the panel closed when a conflict delta arrives", () => {
      closeSyncPanel();
      applyWebdavSyncData(snapshot());
      applyWebdavStatus({ conflictCount: 1 });
      expect(overlay().classList.contains("hidden")).toBe(true);
    });

    it("multi-selects conflicts and posts one batch decision", () => {
      applyWebdavSyncData(
        snapshot({
          conflictCount: 3,
          conflicts: [
            { id: "c1", path: "AGENTS.md", kind: "content", localSize: 1 },
            { id: "c2", path: "skills/tool.md", kind: "remoteDeleted" },
            { id: "c3", path: "opencode.json", kind: "localDeleted" },
          ],
        }),
      );
      const bar = document.getElementById("dav-conflict-bar") as HTMLElement;
      const all = document.getElementById("dav-conflict-all") as HTMLInputElement;
      const keep = document.getElementById("dav-conflict-keep") as HTMLButtonElement;
      const use = document.getElementById("dav-conflict-use") as HTMLButtonElement;
      expect(bar.classList.contains("hidden")).toBe(false);
      expect(document.getElementById("dav-conflict-all-label")?.textContent).toBe("Select all");
      expect(keep.textContent).toBe("Keep local");
      expect(use.textContent).toBe("Use remote");
      expect(all.checked).toBe(false);
      expect(all.indeterminate).toBe(false);
      expect(keep.disabled).toBe(true);
      expect(use.disabled).toBe(true);

      // One card selected: actions unlock, select-all goes indeterminate.
      const first = document.querySelector<HTMLInputElement>('[data-select="c1"]')!;
      first.checked = true;
      first.dispatchEvent(new Event("change", { bubbles: true }));
      expect(keep.disabled).toBe(false);
      expect(use.disabled).toBe(false);
      expect(all.indeterminate).toBe(true);
      expect(document.getElementById("dav-conflict-sel")?.textContent).toBe("1 selected");
      expect(
        document.querySelector('[data-id="c1"]')?.classList.contains("is-selected"),
      ).toBe(true);

      // Select-all covers every card.
      all.checked = true;
      all.dispatchEvent(new Event("change", { bubbles: true }));
      expect(document.querySelectorAll(".dav-conflict-check:checked")).toHaveLength(3);
      expect(all.checked).toBe(true);
      expect(all.indeterminate).toBe(false);
      expect(document.getElementById("dav-conflict-sel")?.textContent).toBe("3 selected");

      // Deselect one and batch-resolve the remaining two.
      const second = document.querySelector<HTMLInputElement>('[data-select="c2"]')!;
      second.checked = false;
      second.dispatchEvent(new Event("change", { bubbles: true }));
      expect(all.indeterminate).toBe(true);
      keep.click();
      expect(posted().pop()).toEqual({
        type: "resolveWebdavConflicts",
        ids: ["c1", "c3"],
        resolution: "local",
      });
      // Sending consumes the selection; the list stays until the snapshot.
      expect(keep.disabled).toBe(true);
      expect(document.querySelector(".dav-conflict-card.is-selected")).toBeNull();

      applyWebdavSyncData(snapshot());
      expect(bar.classList.contains("hidden")).toBe(true);
    });

    it("prunes vanished selections and posts a remote batch", () => {
      applyWebdavSyncData(
        snapshot({
          conflictCount: 2,
          conflicts: [
            { id: "c1", path: "AGENTS.md", kind: "content" },
            { id: "c2", path: "skills/tool.md", kind: "remoteDeleted" },
          ],
        }),
      );
      const all = document.getElementById("dav-conflict-all") as HTMLInputElement;
      all.checked = true;
      all.dispatchEvent(new Event("change", { bubbles: true }));
      expect(document.getElementById("dav-conflict-sel")?.textContent).toBe("2 selected");

      // A fresh snapshot dropped c2: it must leave the selection too.
      applyWebdavSyncData(
        snapshot({
          conflictCount: 1,
          conflicts: [{ id: "c1", path: "AGENTS.md", kind: "content" }],
        }),
      );
      expect(document.getElementById("dav-conflict-sel")?.textContent).toBe("1 selected");
      expect(all.checked).toBe(true);

      document.getElementById("dav-conflict-use")?.click();
      expect(posted().pop()).toEqual({
        type: "resolveWebdavConflicts",
        ids: ["c1"],
        resolution: "remote",
      });
      applyWebdavSyncData(snapshot());
    });

    it("requests a fresh snapshot when conflicts appear or grow", () => {
      applyWebdavSyncData(snapshot());
      const requestCount = (): number =>
        posted().filter(
          (m) => (m as { type: string }).type === "requestWebdavSyncData",
        ).length;
      const before = requestCount();

      applyWebdavStatus({ conflictCount: 1 });
      expect(requestCount()).toBe(before + 1);

      applyWebdavStatus({ conflictCount: 2 });
      expect(requestCount()).toBe(before + 2);

      // Equal or shrinking counts carry no new conflict list.
      applyWebdavStatus({ conflictCount: 2, state: "syncing" });
      expect(requestCount()).toBe(before + 2);
      applyWebdavStatus({ conflictCount: 0 });
      expect(requestCount()).toBe(before + 2);
    });
  });

  describe("items", () => {
    it("renders item rows and posts toggle / remove / add", () => {
      applyWebdavSyncData(snapshot());
      const toggle = document.querySelector<HTMLInputElement>('[data-toggle="custom"]');
      expect(toggle?.checked).toBe(false);
      toggle?.dispatchEvent(new Event("change", { bubbles: true }));
      expect(posted().pop()).toEqual({
        type: "setWebdavItemEnabled",
        id: "custom",
        enabled: false,
      });

      document.querySelector<HTMLElement>('[data-remove="custom"]')?.click();
      expect(posted().pop()).toEqual({ type: "removeWebdavItem", id: "custom" });

      const input = document.getElementById("dav-item-add-input") as HTMLInputElement;
      input.value = "assets/";
      document.getElementById("dav-item-add-btn")?.click();
      expect(posted().pop()).toEqual({ type: "addWebdavItem", path: "assets/" });

      input.value = "../escape";
      const postCount = posted().length;
      document.getElementById("dav-item-add-btn")?.click();
      expect(posted().length).toBe(postCount);
      expect(
        document.getElementById("dav-item-add-error")?.classList.contains("hidden"),
      ).toBe(false);
    });

    it("dims disabled items and hides remove for built-ins", () => {
      applyWebdavSyncData(snapshot());
      expect(
        document
          .querySelector('.dav-item-row[data-id="custom"]')
          ?.classList.contains("is-off"),
      ).toBe(true);
      expect(
        document
          .querySelector('.dav-item-row[data-id="opencode"]')
          ?.classList.contains("is-off"),
      ).toBe(false);
      expect(
        document.querySelector('.dav-item-row[data-id="opencode"] [data-remove]'),
      ).toBeNull();
    });

    it("shows teaching empty states for both lists", () => {
      applyWebdavSyncData(snapshot({ items: [], excludes: [] }));
      expect(document.getElementById("dav-items-list")?.textContent).toContain(
        "No sync items yet",
      );
      expect(document.getElementById("dav-exclude-list")?.textContent).toContain(
        "Nothing excluded yet",
      );
    });

    it("accepts re: regex custom items and tags them", () => {
      applyWebdavSyncData(snapshot());
      const input = document.getElementById("dav-item-add-input") as HTMLInputElement;
      input.value = "re:.*\\.log";
      document.getElementById("dav-item-add-btn")?.click();
      expect(posted().pop()).toEqual({ type: "addWebdavItem", path: "re:.*\\.log" });

      const patternRow = document.querySelector(
        '.dav-item-row[data-id="pat"]',
      ) as HTMLElement;
      expect(patternRow.querySelector(".dav-item-tag")?.textContent).toBe("regex");
      expect(patternRow.querySelector(".dav-item-path")?.textContent).toBe("re:.*\\.tmp");
    });

    it("accepts relative paths starting with _, . or -", () => {
      applyWebdavSyncData(snapshot());
      const input = document.getElementById("dav-item-add-input") as HTMLInputElement;
      const addBtn = document.getElementById("dav-item-add-btn");
      for (const path of ["_templates/", ".env", "-drafts/rules.md", "rules/team.md"]) {
        input.value = path;
        addBtn?.click();
        expect(posted().pop()).toEqual({ type: "addWebdavItem", path });
      }
    });

    it("rejects traversal and absolute-path items", () => {
      applyWebdavSyncData(snapshot());
      const input = document.getElementById("dav-item-add-input") as HTMLInputElement;
      const addBtn = document.getElementById("dav-item-add-btn");
      for (const bad of ["..", "../x", "/abs", "\\abs", "C:\\x", "C:/x"]) {
        input.value = bad;
        const postCount = posted().length;
        addBtn?.click();
        expect(posted().length).toBe(postCount);
      }
      const error = document.getElementById("dav-item-add-error");
      expect(error?.classList.contains("hidden")).toBe(false);
      expect(input.classList.contains("is-error")).toBe(true);

      // Editing the input again clears the inline error and its border.
      input.dispatchEvent(new Event("input"));
      expect(error?.classList.contains("hidden")).toBe(true);
      expect(input.classList.contains("is-error")).toBe(false);
    });
  });

  describe("excludes", () => {
    it("renders excludes with type tags and posts remove / add", () => {
      applyWebdavSyncData(snapshot());
      const rows = document.querySelectorAll("#dav-exclude-list .dav-exclude-row");
      expect(rows).toHaveLength(2);
      const removeButtons = Array.from(
        document.querySelectorAll<HTMLElement>("[data-remove-exclude]"),
      );
      expect(
        removeButtons.some((b) => b.dataset.removeExclude === "re:.*\\.bak"),
      ).toBe(true);

      removeButtons
        .find((b) => b.dataset.removeExclude === "logs/")
        ?.click();
      expect(posted().pop()).toEqual({ type: "removeWebdavExclude", path: "logs/" });

      const input = document.getElementById("dav-exclude-add-input") as HTMLInputElement;
      input.value = "cache/";
      document.getElementById("dav-exclude-add-btn")?.click();
      expect(posted().pop()).toEqual({ type: "addWebdavExclude", path: "cache/" });

      input.value = "re:.*\\.swp";
      document.getElementById("dav-exclude-add-btn")?.click();
      expect(posted().pop()).toEqual({ type: "addWebdavExclude", path: "re:.*\\.swp" });

      input.value = "re:[invalid";
      const postCount = posted().length;
      document.getElementById("dav-exclude-add-btn")?.click();
      expect(posted().length).toBe(postCount);
      expect(
        document.getElementById("dav-exclude-add-error")?.classList.contains("hidden"),
      ).toBe(false);
    });
  });

  describe("history", () => {
    it("merges the per-action counts into the summary column", () => {
      applyWebdavSyncData(
        snapshot({
          history: [
            {
              time: Date.now(),
              direction: "both",
              files: 6,
              uploads: 2,
              downloads: 1,
              deletes: 3,
              result: "success",
              trigger: "poll",
            },
            { time: Date.now(), direction: "up", files: 2, result: "success" },
            {
              time: Date.now(),
              direction: "none",
              files: 0,
              uploads: 0,
              downloads: 0,
              deletes: 0,
              result: "failed",
              message: "boom",
            },
          ],
        }),
      );
      const head = document.querySelector(".dav-hist-head") as HTMLElement;
      expect(head.textContent).toContain("Trigger");
      expect(head.textContent).toContain("Summary");
      expect(head.textContent).not.toContain("Action");

      const rows = document.querySelectorAll("#dav-hist-list .dav-hist-row");
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.children).toHaveLength(4);
        expect(row.children[3].className).toBe("dav-hist-sum");
      }

      const sums = document.querySelectorAll("#dav-hist-list .dav-hist-sum");
      const acts = document.querySelectorAll("#dav-hist-list .dav-hist-act");
      expect(acts[0].querySelector(".dav-hist-up")?.textContent).toBe("↑2");
      expect(acts[0].querySelector(".dav-hist-down")?.textContent).toBe("↓1");
      expect(acts[0].querySelector(".dav-hist-del")?.textContent).toBe("−3");
      expect(acts[0].querySelector(".dav-hist-up")?.getAttribute("title")).toBe(
        "2 uploaded",
      );
      expect(sums[0].querySelector(".dav-hist-msg")).toBeNull();

      // Legacy rows persisted before per-action counts fall back to the
      // direction glyph plus the total transfer count.
      expect(acts[1].textContent).toBe("↑2");

      // Explicit zero counts render a dash, and the message stays visible.
      expect(acts[2].textContent).toBe("—");
      expect(sums[2].querySelector(".dav-hist-msg")?.textContent).toBe("boom");
    });

    it("renders the trigger column with labels and a dash for legacy entries", () => {
      applyWebdavSyncData(
        snapshot({
          history: [
            { time: Date.now(), direction: "up", files: 2, result: "success", trigger: "poll" },
            { time: Date.now(), direction: "none", files: 0, result: "failed", message: "boom" },
          ],
        }),
      );

      const rows = document.querySelectorAll("#dav-hist-list .dav-hist-row");
      expect(rows).toHaveLength(2);
      expect(rows[0].querySelector(".dav-hist-trig")?.textContent).toBe("Poll");
      // Legacy entries persisted before the trigger field render a dash.
      expect(rows[1].querySelector(".dav-hist-trig")?.textContent).toBe("—");
    });

    it("posts clearWebdavHistory from the header-row clear button", () => {
      applyWebdavSyncData(snapshot());
      const clear = document.getElementById("dav-hist-clear") as HTMLButtonElement;
      expect(clear.getAttribute("aria-label")).toBe("Clear history");
      clear.click();
      expect(posted().pop()).toEqual({ type: "clearWebdavHistory" });
    });

    it("renders the empty state once the history is cleared", () => {
      applyWebdavSyncData(snapshot({ history: [] }));
      const host = document.getElementById("dav-hist-list") as HTMLElement;
      expect(host.querySelector(".dav-empty")?.textContent).toBe(
        "No sync history yet",
      );
    });
  });

  describe("incremental merge", () => {
    it("keeps unset fields and applies pushed fields", () => {
      const base = initialSyncUiState();
      const merged = mergeSnapshot(base, snapshot({ lastSyncLabel: "3 min ago", pendingCount: 0 }));
      const delta = mergeDelta(merged, { pendingCount: 4, state: "syncing" });
      expect(delta.pendingCount).toBe(4);
      expect(delta.state).toBe("syncing");
      expect(delta.lastSyncLabel).toBe("3 min ago");
      expect(delta.settings).toBeDefined();
      expect(delta.items).toHaveLength(5);
    });

    it("reflects merged deltas in the footer", () => {
      applyWebdavSyncData(snapshot({ lastSyncLabel: "10:32" }));
      applyWebdavStatus({ pendingCount: 5 });
      expect(document.getElementById("dav-foot-st")?.textContent).toContain("5");
      expect(document.getElementById("dav-foot-st")?.textContent).toContain("10:32");
    });

    it("turns the sync-now button into a busy state while syncing", () => {
      applyWebdavSyncData(snapshot());
      const btn = document.getElementById("dav-foot-sync") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      expect(btn.classList.contains("is-loading")).toBe(false);
      expect(btn.getAttribute("aria-busy")).toBe("false");
      expect(btn.textContent).toBe("Sync now");

      applyWebdavStatus({ state: "syncing" });
      expect(btn.disabled).toBe(true);
      expect(btn.classList.contains("is-loading")).toBe(true);
      expect(btn.getAttribute("aria-busy")).toBe("true");
      expect(btn.textContent).toBe("Syncing…");
      expect(btn.querySelector("svg")).toBeTruthy();

      // Any terminal state restores the action.
      applyWebdavStatus({ state: "idle" });
      expect(btn.disabled).toBe(false);
      expect(btn.classList.contains("is-loading")).toBe(false);
      expect(btn.getAttribute("aria-busy")).toBe("false");
      expect(btn.textContent).toBe("Sync now");
    });

    it("renders pushed log lines", () => {
      applyWebdavLog(["a", "b"]);
      expect(document.getElementById("dav-log-pre")?.textContent).toBe("a\nb");
    });

    it("shows the empty state without lines", () => {
      applyWebdavLog([]);
      expect(
        document.getElementById("dav-log-pre")?.classList.contains("hidden"),
      ).toBe(true);
      const empty = document.getElementById("dav-log-empty");
      expect(empty?.classList.contains("hidden")).toBe(false);
      expect(empty?.textContent).toBe("No sync activity yet");
    });

    it("scrolls to the bottom when switching to the log tab", async () => {
      const pre = document.getElementById("dav-log-pre") as HTMLElement;
      const scroll = mockPreScroll(pre, 600, 300);
      document.querySelector<HTMLButtonElement>('[data-pane="log"]')?.click();
      await nextFrame();
      expect(scroll.top()).toBe(600);
    });

    it("follows the log tail on new lines when already near the bottom", async () => {
      const pre = document.getElementById("dav-log-pre") as HTMLElement;
      const scroll = mockPreScroll(pre, 600, 300);
      document.querySelector<HTMLButtonElement>('[data-pane="log"]')?.click();
      await nextFrame();
      // Reader parked at the tail: 600 - 300 - 300 = 0 → follow.
      scroll.setTop(300);
      applyWebdavLog(["l1", "l2"]);
      expect(scroll.top()).toBe(600);
    });

    it("keeps the log reading position when scrolled up", async () => {
      const pre = document.getElementById("dav-log-pre") as HTMLElement;
      const scroll = mockPreScroll(pre, 600, 300);
      document.querySelector<HTMLButtonElement>('[data-pane="log"]')?.click();
      await nextFrame();
      // Reader scrolled up: 600 - 0 - 300 = 300 → do not yank.
      scroll.setTop(0);
      applyWebdavLog(["l3"]);
      expect(scroll.top()).toBe(0);
      expect(pre.textContent).toBe("l3");
    });

    it("does not show the saved badge for acks with no matching send", () => {
      const slot = document.getElementById("dav-test-result");
      const before = slot?.textContent ?? "";
      applyWebdavSaveResult(true);
      expect(slot?.textContent).toBe(before);
    });

    it("renders the transient notice for immediate-apply acks", () => {
      applyWebdavSyncData(snapshot());
      const master = document.getElementById("dav-f-master") as HTMLInputElement;
      master.checked = !master.checked;
      master.dispatchEvent(new Event("change"));
      applyWebdavSaveResult(true);
      // showNotice must render immediately, not only after the TTL.
      expect(document.getElementById("dav-foot-st")?.textContent).toBe("Saved");

      // Normalize the master switch for later tests.
      applyWebdavSyncData(snapshot());
    });
  });

  describe("syncIconInfo pure rules", () => {
    it("prefers conflict over paused/error/syncing/pending", () => {
      const s = mergeSnapshot(initialSyncUiState(), snapshot());
      const info = syncIconInfo({
        ...s,
        conflictCount: 2,
        pendingCount: 3,
        state: "syncing",
        autoSyncPaused: true,
      });
      expect(info?.kind).toBe("conflict");
      expect(info?.count).toBe(2);
    });

    it("surfaces required credentials above pending counts", () => {
      const s = mergeSnapshot(initialSyncUiState(), snapshot());
      const info = syncIconInfo({
        ...s,
        state: "needsAuth",
        pendingCount: 3,
      });
      expect(info?.kind).toBe("auth");
    });
  });
});
