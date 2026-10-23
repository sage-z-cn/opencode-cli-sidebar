// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupFontSizeMenu } from "./index";

const mockPostMessage = vi.hoisted(() => vi.fn());
const mockScheduleRefresh = vi.hoisted(() => vi.fn((fn: () => void) => fn()));

vi.mock("../shared/vscode-api", () => ({
  postMessage: mockPostMessage,
}));

vi.mock("../shared/utils", () => ({
  scheduleRefresh: mockScheduleRefresh,
}));

describe("setupFontSizeMenu", () => {
  let options: { fontSize: number };
  let fit: ReturnType<typeof vi.fn>;
  let resize: ReturnType<typeof vi.fn>;
  let terminal: {
    options: { fontSize: number };
    cols: number;
    rows: number;
    refresh: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
  };
  let fitAddon: {
    fit: ReturnType<typeof vi.fn>;
    proposeDimensions: () => { cols: number; rows: number };
  };

  const menu = (): HTMLElement =>
    document.getElementById("dropdown-font-size") as HTMLElement;
  const trigger = (): HTMLElement =>
    document.getElementById("btn-font-size") as HTMLElement;
  const action = (name: string): HTMLElement =>
    document.querySelector<HTMLElement>(`[data-action="${name}"]`) as HTMLElement;
  const openMenu = (): void => {
    trigger().click();
  };

  beforeEach(() => {
    document.body.innerHTML = `
      <div class="font-size-host">
        <button id="btn-font-size" aria-expanded="false"></button>
        <div class="settings-dropdown font-size-dropdown hidden" id="dropdown-font-size">
          <div class="font-size-current" id="font-size-current"></div>
          <div class="settings-option" data-action="increaseFontSize"></div>
          <div class="settings-option" data-action="decreaseFontSize"></div>
          <div class="settings-option" data-action="resetFontSize"></div>
        </div>
      </div>
    `;
    (window as unknown as { __TOOLBAR_L10N__: Record<string, string> })
      .__TOOLBAR_L10N__ = { default: "default" };
    options = { fontSize: 12 };
    fit = vi.fn();
    resize = vi.fn();
    terminal = {
      options,
      cols: 80,
      rows: 20,
      refresh: vi.fn(),
      resize,
    };
    fitAddon = { fit, proposeDimensions: () => ({ cols: 79, rows: 20 }) };
    setupFontSizeMenu(
      () => terminal as never,
      () => fitAddon as never,
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("opens from the toolbar trigger and shows the current size", () => {
    expect(menu().classList.contains("hidden")).toBe(true);
    openMenu();

    expect(menu().classList.contains("hidden")).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("font-size-current")?.textContent).toBe(
      "12px (default)",
    );
  });

  it("keeps the menu open across repeated increase / decrease clicks", () => {
    openMenu();

    action("increaseFontSize").click();
    expect(options.fontSize).toBe(13);
    expect(menu().classList.contains("hidden")).toBe(false);

    action("increaseFontSize").click();
    expect(options.fontSize).toBe(14);
    expect(menu().classList.contains("hidden")).toBe(false);
    expect(document.getElementById("font-size-current")?.textContent).toBe(
      "14px",
    );

    action("decreaseFontSize").click();
    expect(options.fontSize).toBe(13);
    expect(menu().classList.contains("hidden")).toBe(false);
  });

  it("applies a size change with refit, refresh, and updateFontSize", () => {
    openMenu();
    action("increaseFontSize").click();

    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(79, 20);
    expect(terminal.refresh).toHaveBeenCalled();
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: "updateFontSize",
      fontSize: 13,
    });
  });

  it("resets to the package default without closing the menu", () => {
    options.fontSize = 18;
    openMenu();
    action("resetFontSize").click();

    expect(options.fontSize).toBe(12);
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: "updateFontSize",
      fontSize: 12,
    });
    expect(menu().classList.contains("hidden")).toBe(false);
    expect(document.getElementById("font-size-current")?.textContent).toBe(
      "12px (default)",
    );
  });

  it("clamps at the minimum and maximum without posting", () => {
    options.fontSize = 6;
    openMenu();
    action("decreaseFontSize").click();
    expect(options.fontSize).toBe(6);
    expect(mockPostMessage).not.toHaveBeenCalled();

    options.fontSize = 25;
    action("increaseFontSize").click();
    expect(options.fontSize).toBe(25);
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(menu().classList.contains("hidden")).toBe(false);
  });

  it("closes on an outside click and on Escape", () => {
    openMenu();
    document.body.click();
    expect(menu().classList.contains("hidden")).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    openMenu();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(menu().classList.contains("hidden")).toBe(true);
  });

  it("toggles closed when the trigger is clicked again", () => {
    openMenu();
    openMenu();

    expect(menu().classList.contains("hidden")).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });
});
