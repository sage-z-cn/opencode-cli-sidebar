// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageHandler } from "./index";

const mockHandlePasteWithImageSupport = vi.hoisted(() => vi.fn());

vi.mock("../clipboard", () => ({
  handlePasteWithImageSupport: mockHandlePasteWithImageSupport,
}));

describe("createMessageHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes requestPaste messages through image-aware paste handling", () => {
    const handler = createMessageHandler({
      onActiveSession: vi.fn(),
      onPlatformInfo: vi.fn(),
    });

    handler.handleEvent(
      new MessageEvent("message", { data: { type: "requestPaste" } }),
    );

    expect(mockHandlePasteWithImageSupport).toHaveBeenCalledTimes(1);
  });

  it("forwards terminalConfig focus indicator fields to onFocusIndicatorConfig", () => {
    const onFocusIndicatorConfig = vi.fn();
    const handler = createMessageHandler({
      onActiveSession: vi.fn(),
      onPlatformInfo: vi.fn(),
      onFocusIndicatorConfig,
    });

    handler.handleEvent(
      new MessageEvent("message", {
        data: {
          type: "terminalConfig",
          fontSize: 14,
          fontFamily: "monospace",
          cursorBlink: true,
          cursorStyle: "block",
          scrollback: 10000,
          focusIndicatorMode: "fullBorder",
          focusIndicatorBorderWidth: 4,
        },
      }),
    );

    expect(onFocusIndicatorConfig).toHaveBeenCalledWith("fullBorder", 4);
  });

  it("falls back to bottomBorder/2 when focus indicator fields are missing", () => {
    const onFocusIndicatorConfig = vi.fn();
    const handler = createMessageHandler({
      onActiveSession: vi.fn(),
      onPlatformInfo: vi.fn(),
      onFocusIndicatorConfig,
    });

    handler.handleEvent(
      new MessageEvent("message", {
        data: {
          type: "terminalConfig",
          fontSize: 14,
          fontFamily: "monospace",
          cursorBlink: true,
          cursorStyle: "block",
          scrollback: 10000,
        },
      }),
    );

    expect(onFocusIndicatorConfig).toHaveBeenCalledWith("bottomBorder", 2);
  });

  it("dispatches keymapError messages to onKeymapError", () => {
    const onKeymapError = vi.fn();
    const handler = createMessageHandler({
      onActiveSession: vi.fn(),
      onKeymapError,
    });

    handler.handleEvent(
      new MessageEvent("message", {
        data: { type: "keymapError", error: "failed to read config" },
      }),
    );

    expect(onKeymapError).toHaveBeenCalledTimes(1);
    expect(onKeymapError).toHaveBeenCalledWith({
      type: "keymapError",
      error: "failed to read config",
    });
  });

  it("dispatches openCodeSessionStarted to the optional callback", () => {
    const onOpenCodeSessionStarted = vi.fn();
    const handler = createMessageHandler({
      onActiveSession: vi.fn(),
      onOpenCodeSessionStarted,
    });

    handler.handleEvent(
      new MessageEvent("message", {
        data: { type: "openCodeSessionStarted" },
      }),
    );

    expect(onOpenCodeSessionStarted).toHaveBeenCalledTimes(1);
    expect(onOpenCodeSessionStarted).toHaveBeenCalledWith({
      type: "openCodeSessionStarted",
    });
  });

  it("dispatches openCodeChangelogTranslation to the optional callback", () => {
    const onOpenCodeChangelogTranslation = vi.fn();
    const handler = createMessageHandler({
      onActiveSession: vi.fn(),
      onOpenCodeChangelogTranslation,
    });

    handler.handleEvent(
      new MessageEvent("message", {
        data: {
          type: "openCodeChangelogTranslation",
          requestId: "clt-1",
          ok: true,
          translations: { b0: "你好" },
        },
      }),
    );

    expect(onOpenCodeChangelogTranslation).toHaveBeenCalledTimes(1);
    expect(onOpenCodeChangelogTranslation).toHaveBeenCalledWith({
      type: "openCodeChangelogTranslation",
      requestId: "clt-1",
      ok: true,
      translations: { b0: "你好" },
    });
  });

  it("dispatches showServiceRestartPrompt to the optional callback", () => {
    const onShowServiceRestartPrompt = vi.fn();
    const handler = createMessageHandler({
      onActiveSession: vi.fn(),
      onShowServiceRestartPrompt,
    });

    handler.handleEvent(
      new MessageEvent("message", {
        data: { type: "showServiceRestartPrompt" },
      }),
    );

    expect(onShowServiceRestartPrompt).toHaveBeenCalledTimes(1);
    expect(onShowServiceRestartPrompt).toHaveBeenCalledWith({
      type: "showServiceRestartPrompt",
    });
  });

  it("skips xterm option updates and refit when terminal fields are unchanged", () => {
    const handler = createMessageHandler({
      onActiveSession: vi.fn(),
    });
    const fit = vi.fn();
    handler.terminal = {
      options: {
        fontSize: 14,
        fontFamily: "monospace",
        cursorBlink: true,
        cursorStyle: "block",
      },
      refresh: vi.fn(),
      rows: 10,
    } as any;
    handler.fitAddon = { fit } as any;

    handler.handleEvent(
      new MessageEvent("message", {
        data: {
          type: "terminalConfig",
          fontSize: 14,
          fontFamily: "monospace",
          cursorBlink: true,
          cursorStyle: "block",
          scrollback: 10000,
          focusIndicatorMode: "bottomBorder",
          focusIndicatorBorderWidth: 3,
        },
      }),
    );

    expect(fit).not.toHaveBeenCalled();
    expect(handler.terminal?.options.fontSize).toBe(14);
  });

  it("updates xterm options and refits when terminal fields change", () => {
    const handler = createMessageHandler({
      onActiveSession: vi.fn(),
    });
    const fit = vi.fn();
    const resize = vi.fn();
    handler.terminal = {
      options: {
        fontSize: 14,
        fontFamily: "monospace",
        cursorBlink: true,
        cursorStyle: "block",
      },
      refresh: vi.fn(),
      cols: 80,
      rows: 10,
      resize,
    } as any;
    handler.fitAddon = {
      fit,
      proposeDimensions: () => ({ cols: 79, rows: 10 }),
    } as any;

    handler.handleEvent(
      new MessageEvent("message", {
        data: {
          type: "terminalConfig",
          fontSize: 16,
          fontFamily: "monospace",
          cursorBlink: true,
          cursorStyle: "block",
          scrollback: 10000,
        },
      }),
    );

    expect(handler.terminal?.options.fontSize).toBe(16);
    expect(fit).not.toHaveBeenCalled();
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(79, 10);
  });
});
