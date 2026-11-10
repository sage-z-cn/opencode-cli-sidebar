import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { OutputChannelService } from "../services/OutputChannelService";
import type {
  RequestMessage,
  ResponseMessage,
} from "../webview/shared/bridge/types";

/** Returns the payload for a command, or throws to reject the request. */
export type RequestHandler = (
  params: Record<string, unknown>,
) => unknown | Promise<unknown>;

/**
 * Host side of the request/response bridge.
 *
 * The terminal hot path (`terminalInput`, `terminalResize`, `terminalOutput`)
 * deliberately bypasses this class and stays on the flat `WebviewMessage`
 * union. Everything else — settings, keymap, sync, update dialogs — is a
 * command here, which gives the webview a typed promise instead of a global
 * event soup.
 */
export class WebviewRequestRouter {
  private readonly handlers = new Map<string, RequestHandler>();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: OutputChannelService,
    private readonly post: (message: unknown) => void,
  ) {
    this.registerBuiltins();
  }

  /** Register a command handler. Later registrations overwrite earlier ones. */
  public register(command: string, handler: RequestHandler): void {
    this.handlers.set(command, handler);
  }

  public has(command: string): boolean {
    return this.handlers.has(command);
  }

  /** True when `raw` is a bridge request envelope, not a flat message. */
  public static isRequest(raw: unknown): raw is RequestMessage {
    if (!raw || typeof raw !== "object") {
      return false;
    }
    const candidate = raw as Partial<RequestMessage>;
    return (
      candidate.type === "request" &&
      typeof candidate.id === "string" &&
      typeof candidate.command === "string"
    );
  }

  public async dispatch(message: RequestMessage): Promise<void> {
    const handler = this.handlers.get(message.command);
    if (!handler) {
      this.logger.warn(
        `[WebviewRequestRouter] Unknown command: ${message.command}`,
      );
      this.respond(message.id, false, undefined, {
        code: "unknown_command",
        message: `Unknown command: ${message.command}`,
      });
      return;
    }

    try {
      const data = await handler(message.params ?? {});
      this.respond(message.id, true, data);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[WebviewRequestRouter] Command ${message.command} failed: ${reason}`,
      );
      this.respond(message.id, false, undefined, {
        code: "handler_error",
        message: reason,
      });
    }
  }

  /** Push an unsolicited event to the webview. */
  public broadcast(event: string, data: unknown): void {
    this.post({ type: "event", event, data });
  }

  private respond(
    id: string,
    success: boolean,
    data?: unknown,
    error?: { code?: string; message: string },
  ): void {
    const response: ResponseMessage = success
      ? { type: "response", id, success: true, data }
      : { type: "response", id, success: false, error };
    this.post(response);
  }

  private registerBuiltins(): void {
    this.register("getL10nBundle", () => ({ strings: this.loadL10nBundle() }));
    this.register("getPlatformInfo", () => ({
      platform: process.platform,
      language: vscode.env.language,
    }));
  }

  /**
   * Read `l10n/bundle.l10n.<locale>.json` from the packaged extension.
   *
   * The bundle is a flat `source string -> translation` map. English is the
   * source string itself, so a missing bundle simply yields an empty map and
   * the webview renders keys unchanged.
   */
  private loadL10nBundle(): Record<string, string> {
    const locale = vscode.env.language;
    const l10nDir = vscode.Uri.joinPath(this.context.extensionUri, "l10n");

    const candidates = [
      `bundle.l10n.${locale}.json`,
      // VS Code may report `zh-hans` for Simplified Chinese while the bundle
      // ships as `zh-cn`.
      locale === "zh-hans" ? "bundle.l10n.zh-cn.json" : undefined,
    ].filter((name): name is string => Boolean(name));

    for (const name of candidates) {
      const filePath = path.join(l10nDir.fsPath, name);
      if (!fs.existsSync(filePath)) {
        continue;
      }
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, string>;
        return parsed;
      } catch (error) {
        this.logger.warn(
          `[WebviewRequestRouter] Failed to read ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {};
  }
}
