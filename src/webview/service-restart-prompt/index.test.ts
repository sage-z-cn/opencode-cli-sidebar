// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/vscode-api", () => ({
  postMessage: vi.fn(),
  acquireVsCodeApi: vi.fn(() => ({ postMessage: vi.fn() })),
}));

import { postMessage } from "../shared/vscode-api";
import { showServiceRestartPrompt } from "./index";

/**
 * The module keeps a singleton overlay, so the DOM is built once and later
 * tests re-show the same instance (same pattern as update/index.test.ts).
 */
function overlay(): HTMLElement {
  return document.getElementById("srp-overlay") as HTMLElement;
}

function click(id: string): void {
  (document.getElementById(id) as HTMLButtonElement).click();
}

function pressEscape(): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
}

describe("service restart prompt (webview)", () => {
  beforeEach(() => {
    vi.mocked(postMessage).mockClear();
  });

  it("creates a single dialog instance and skips duplicate show pushes", () => {
    showServiceRestartPrompt();
    expect(overlay().classList.contains("hidden")).toBe(false);

    showServiceRestartPrompt();
    expect(document.querySelectorAll("#srp-overlay")).toHaveLength(1);
    expect(overlay().classList.contains("hidden")).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("answers restartService from the primary button and hides", () => {
    showServiceRestartPrompt();
    click("srp-restart-service");

    expect(postMessage).toHaveBeenCalledWith({
      type: "serviceRestartPromptAnswer",
      action: "restartService",
    });
    expect(overlay().classList.contains("hidden")).toBe(true);
  });

  it("answers terminalOnly from the secondary button and hides", () => {
    showServiceRestartPrompt();
    click("srp-terminal-only");

    expect(postMessage).toHaveBeenCalledWith({
      type: "serviceRestartPromptAnswer",
      action: "terminalOnly",
    });
    expect(overlay().classList.contains("hidden")).toBe(true);
  });

  it("answers cancel from the cancel button and hides", () => {
    showServiceRestartPrompt();
    click("srp-cancel");

    expect(postMessage).toHaveBeenCalledWith({
      type: "serviceRestartPromptAnswer",
      action: "cancel",
    });
    expect(overlay().classList.contains("hidden")).toBe(true);
  });

  it("answers cancel from the ✕ close button and hides", () => {
    showServiceRestartPrompt();
    click("srp-close");

    expect(postMessage).toHaveBeenCalledWith({
      type: "serviceRestartPromptAnswer",
      action: "cancel",
    });
    expect(overlay().classList.contains("hidden")).toBe(true);
  });

  it("lays out full restart first, cancel last, with primary styling on restart-service", () => {
    showServiceRestartPrompt();

    const ids = Array.from(
      overlay().querySelectorAll<HTMLButtonElement>(".srp-actions button"),
    ).map((b) => b.id);
    expect(ids).toEqual([
      "srp-restart-service",
      "srp-terminal-only",
      "srp-cancel",
    ]);
    // restart-service 为主按钮样式；terminal-only 与 cancel 为次按钮
    expect(document.getElementById("srp-restart-service")?.className).toBe(
      "srp-btn srp-btn-primary",
    );
    expect(document.getElementById("srp-terminal-only")?.className).toBe(
      "srp-btn",
    );
    expect(document.getElementById("srp-cancel")?.className).toBe("srp-btn");
    // 关闭按钮带 aria-label（无注入时回退英文）
    expect(
      document.getElementById("srp-close")?.getAttribute("aria-label"),
    ).toBe("Close");
  });

  it("answers cancel on Escape and hides", () => {
    showServiceRestartPrompt();
    pressEscape();

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: "serviceRestartPromptAnswer",
      action: "cancel",
    });
    expect(overlay().classList.contains("hidden")).toBe(true);
  });

  it("answers cancel on backdrop click and hides", () => {
    showServiceRestartPrompt();
    overlay().click();

    expect(postMessage).toHaveBeenCalledWith({
      type: "serviceRestartPromptAnswer",
      action: "cancel",
    });
    expect(overlay().classList.contains("hidden")).toBe(true);
  });

  it("ignores Escape while hidden", () => {
    showServiceRestartPrompt();
    click("srp-cancel");
    vi.mocked(postMessage).mockClear();

    pressEscape();

    expect(postMessage).not.toHaveBeenCalled();
  });
});
