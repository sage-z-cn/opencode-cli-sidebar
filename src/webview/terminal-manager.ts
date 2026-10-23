
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITerminalAddon, type ITerminalOptions } from "@xterm/xterm";
import type { DroppedBlobFile, TerminalBackendType } from "../types";
import { postMessage } from "./shared/vscode-api";
import { fitFullWidth } from "./terminal/fit";
import { readVsCodeTerminalTheme } from "./terminal/theme";

export interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLElement;
  disposed: boolean;
  rendererType: "webgl" | "canvas";
}

const DEFAULT_TERMINAL_OPTIONS: ITerminalOptions = {
  cursorBlink: true,
  cursorStyle: "block",
  fontSize: 14,
  fontFamily: "monospace",
  scrollback: 10000,
};

class CanvasAddonFallback implements ITerminalAddon {
  activate(): void {}

  dispose(): void {}
}

export class TerminalManager {
  private instance: TerminalInstance | null = null;

  private backend: TerminalBackendType = "native";

  private container: HTMLElement | null = null;

  private hasWebgl = false;

  init(container: HTMLElement): void {
    if (this.container) {
      return;
    }

    this.container = container;
    container.addEventListener("dragover", this.handleDragOver);
    container.addEventListener("drop", this.handleDrop);
  }

  create(
    container: HTMLElement,
    options: ITerminalOptions = {},
    backend: TerminalBackendType = "native",
  ): TerminalInstance {
    this.disposeCurrentInstance();

    const terminal = new Terminal({
      ...DEFAULT_TERMINAL_OPTIONS,
      ...options,
      theme: {
        ...readVsCodeTerminalTheme(),
        ...options.theme,
      },
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);

    const rendererType = this.loadRendererAddon(terminal);

    terminal.open(container);

    const instance: TerminalInstance = {
      terminal,
      fitAddon,
      container,
      disposed: false,
      rendererType,
    };

    this.instance = instance;
    this.backend = backend;

    return instance;
  }

  register(
    terminal: Terminal | null,
    fitAddon: FitAddon | null,
    container: HTMLElement,
    backend: TerminalBackendType = "native",
  ): void {
    if (terminal && fitAddon) {
      this.instance = {
        terminal,
        fitAddon,
        container,
        disposed: false,
        rendererType: "webgl",
      };
      this.backend = backend;
    } else if (terminal) {
      // Terminal exists but no FitAddon — create one
      const addon = new FitAddon();
      terminal.loadAddon(addon);
      this.instance = {
        terminal,
        fitAddon: addon,
        container,
        disposed: false,
        rendererType: "webgl",
      };
      this.backend = backend;
    } else {
      this.create(container, {}, backend);
    }
  }

  dispose(): void {
    this.disposeCurrentInstance();
  }

  async switchBackend(newBackend: TerminalBackendType): Promise<void> {
    if (!this.instance) {
      return;
    }

    if (this.instance.terminal) {
      this.instance.terminal.dispose();
    }

    this.backend = newBackend;
    this.instance.disposed = true;
  }

  write(data: string): void {
    if (!this.instance) {
      return;
    }

    if (this.instance.disposed) {
      this.create(this.instance.container, {}, this.getBackend());
      if (this.instance) {
        this.instance.terminal.write(data);
      }
      return;
    }

    this.instance.terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.instance || this.instance.disposed) {
      return;
    }

    this.instance.terminal.resize(cols, rows);
  }

  focus(): void {
    if (!this.instance || this.instance.disposed) {
      return;
    }

    this.instance.terminal.focus();
  }

  show(): void {
    if (!this.instance || this.instance.disposed) {
      return;
    }

    this.instance.container.style.display = "";
    fitFullWidth(this.instance.terminal, this.instance.fitAddon);
  }

  hide(): void {
    if (!this.instance || this.instance.disposed) {
      return;
    }

    this.instance.container.style.display = "none";
  }

  getInstance(): TerminalInstance | undefined {
    return this.instance ?? undefined;
  }

  getBackend(): TerminalBackendType {
    return this.backend;
  }

  setBackend(backend: TerminalBackendType): void {
    if (this.instance) {
      this.backend = backend;
    }
  }

  async handleDrop(event: DragEvent): Promise<void> {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const files = await this.extractDroppedFiles(dataTransfer);
    if (files.length > 0) {
      postMessage({
        type: "filesDropped",
        files,
        shiftKey: event.shiftKey,
      });
      return;
    }

    const blobFiles = await this.readDroppedBlobFiles(dataTransfer.files);
    if (blobFiles.length > 0) {
      postMessage({
        type: "filesDropped",
        files: [],
        blobFiles,
        shiftKey: event.shiftKey,
      });
    }
  }

  destroy(): void {
    if (this.container) {
      this.container.removeEventListener("dragover", this.handleDragOver);
      this.container.removeEventListener("drop", this.handleDrop);
    }

    this.disposeCurrentInstance();
    this.container = null;
    this.hasWebgl = false;
  }

  private disposeCurrentInstance(): void {
    if (!this.instance) {
      return;
    }

    this.instance.disposed = true;
    this.instance.terminal.dispose();

    if (this.instance.rendererType === "webgl") {
      this.hasWebgl = false;
    }

    this.instance = null;
  }

  private readonly handleDragOver = (event: DragEvent): void => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) {
      return;
    }

    const hasFiles = Array.from(dataTransfer.types ?? []).some(
      (type) =>
        type === "Files" ||
        type === "text/uri-list" ||
        type.startsWith("application/vnd.code."),
    );

    if (!hasFiles) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };

  private loadRendererAddon(terminal: Terminal): "webgl" | "canvas" {
    if (!this.hasWebgl) {
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
        });
        terminal.loadAddon(webglAddon);
        this.hasWebgl = true;
        return "webgl";
      } catch (error) {
        console.warn(
          "WebGL renderer not available, falling back to canvas:",
          error,
        );
      }
    }

    terminal.loadAddon(new CanvasAddonFallback());
    return "canvas";
  }

  private async extractDroppedFiles(dataTransfer: DataTransfer): Promise<string[]> {
    const transferTypes = Array.from(dataTransfer.types ?? []);
    const transferItems = Array.from(dataTransfer.items ?? []);

    const files: string[] = [];
    const seen = new Set<string>();

    const addFile = (filePath: string | null | undefined): void => {
      const trimmed = filePath?.trim();
      if (!trimmed) {
        return;
      }

      const canonical = this.canonicalizeForDedup(trimmed);
      if (!canonical || seen.has(canonical)) {
        return;
      }

      seen.add(canonical);
      files.push(canonical);
    };

    const consumePayload = (payload: string): void => {
      if (!payload) {
        return;
      }

      for (const extracted of this.parseDroppedText(payload)) {
        addFile(extracted);
      }
    };

    for (const type of transferTypes) {
      try {
        consumePayload(dataTransfer.getData(type));
      } catch (error) {
        console.warn("[TerminalManager] Failed to get data for type:", type, error);
      }
    }

    const stringPayloads = await Promise.all(
      transferItems
        .filter((item) => item.kind === "string")
        .map(
          (item) =>
            new Promise<string>((resolve) => {
              item.getAsString((value) => resolve(value ?? ""));
            }),
        ),
    );

    for (const payload of stringPayloads) {
      consumePayload(payload);
    }

    return files;
  }

  private async readDroppedBlobFiles(files: FileList): Promise<DroppedBlobFile[]> {
    if (files.length === 0) {
      return [];
    }

    return Promise.all(
      Array.from(files).map(async (file) => ({
        name: file.name,
        data: await this.readFileAsDataUrl(file),
      })),
    );
  }

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
          return;
        }
        reject(new Error("FileReader produced a non-string result"));
      };
      reader.onerror = () => reject(new Error("FileReader failed"));
      reader.onabort = () => reject(new Error("FileReader aborted"));
      reader.readAsDataURL(file);
    });
  }

  private canonicalizeForDedup(p: string): string {
    let s = p.trim();
    s = s.replace(/\\/g, "/");
    if (/^[A-Za-z]:\//.test(s)) {
      s = s[0].toLowerCase() + s.slice(1);
    }
    if (s.length > 1) {
      s = s.replace(/\/$/, "");
    }
    return s;
  }

  private parseDroppedText(payload: string): string[] {
    const paths: string[] = [];
    const lines = payload
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const line of lines) {
      const filePath = this.extractFilePathFromValue(line);
      if (filePath) {
        paths.push(filePath);
      }
    }

    if (paths.length > 0) {
      return paths;
    }

    try {
      const parsed = JSON.parse(payload) as unknown;
      const stack: unknown[] = [parsed];

      while (stack.length > 0) {
        const current = stack.pop();

        if (typeof current === "string") {
          const filePath = this.extractFilePathFromValue(current);
          if (filePath) {
            paths.push(filePath);
          }
          continue;
        }

        if (Array.isArray(current)) {
          stack.push(...current);
          continue;
        }

        if (current && typeof current === "object") {
          stack.push(...Object.values(current as Record<string, unknown>));
        }
      }
    } catch (error) {
      console.warn("[TerminalManager] Failed to parse dropped text payload:", error);
    }

    return paths;
  }

  private extractFilePathFromValue(value: string): string | null {
    const candidate = value.trim();

    if (!candidate || candidate.startsWith("#")) {
      return null;
    }

    try {
      const url = new URL(candidate);

      if (url.protocol === "file:" || url.protocol === "vscode-file:") {
        const decodedPath = decodeURIComponent(url.pathname);
        const hasWindowsDrivePrefix =
          decodedPath.length >= 3 &&
          decodedPath[0] === "/" &&
          /[A-Za-z]/.test(decodedPath[1] ?? "") &&
          decodedPath[2] === ":";

        return hasWindowsDrivePrefix ? decodedPath.slice(1) : decodedPath;
      }
    } catch (error) {
      console.warn('[TerminalManager] URI decode failed for drag/drop path:', error);
      const hasWindowsDrivePath =
        candidate.length >= 3 &&
        /[A-Za-z]/.test(candidate[0] ?? "") &&
        candidate[1] === ":" &&
        (candidate[2] === "\\" || candidate[2] === "/");

      if (candidate.startsWith("/") || hasWindowsDrivePath) {
        return candidate;
      }
    }

    return null;
  }
}
