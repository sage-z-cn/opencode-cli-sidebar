/**
 * Modal shell shared by every step of the OpenCode update flow.
 *
 * Browser-only DOM plumbing: the shell owns the overlay, the head, the
 * focus trap and the close semantics. Step content markup is produced by
 * `update/index.ts`, which routes actions back through the handlers here.
 */
import { ICONS as LUCIDE_ICONS, icon } from "../shared/icons";

/** One dialog state: title, body and footer markup plus close semantics. */
export interface UpdateDialogContent {
  title: string;
  /** Extra head buttons rendered before the close button. */
  headActions?: string;
  body: string;
  foot: string;
  /**
   * Progress step: Escape, backdrop clicks and the close button minimize
   * the dialog instead of dismissing it, so a running upgrade keeps going.
   */
  progress?: boolean;
  /** Selector focused after a step change; ignored when nothing matches. */
  focus?: string;
  /** Accessible label for the close button; progress reuses it for minimize. */
  closeLabel?: string;
}

export interface UpdateDialogHandlers {
  /** A `data-ocu-dlg` button other than close was activated. */
  onAction(action: string, element: HTMLElement): void;
  /** Progress step closed by Escape, backdrop or the close button. */
  onMinimize(): void;
  /** Dialog dismissed by Escape, backdrop or the close button. */
  onDismiss(): void;
  /**
   * Arrow/Home/End/Enter handling for the focused step. Return true when
   * the key was consumed.
   */
  onKeyDown?(event: KeyboardEvent): boolean;
}

/** Cycles Tab focus inside `root`; shared with the install prompt overlay. */
export function trapFocus(root: HTMLElement, event: KeyboardEvent): void {
  const focusables = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, [tabindex]',
    ),
  ).filter(
    (el) =>
      !(el as HTMLButtonElement).disabled &&
      el.getAttribute("tabindex") !== "-1" &&
      el.closest(".hidden") === null,
  );
  if (!focusables.length) {
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export class UpdateDialogShell {
  private readonly el: HTMLDivElement;
  private readonly titleEl: HTMLElement;
  private readonly actionsEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly footEl: HTMLElement;
  private content: UpdateDialogContent | undefined;

  public constructor(private readonly handlers: UpdateDialogHandlers) {
    this.el = document.createElement("div");
    this.el.className = "ocu-dlg-overlay hidden";
    this.el.id = "ocu-dialog";
    this.el.innerHTML =
      '<div class="ocu-dlg" role="dialog" aria-modal="true" aria-labelledby="ocu-dlg-title">' +
      '<div class="ocu-dlg-head">' +
      '<span class="ocu-dlg-title" id="ocu-dlg-title"></span>' +
      '<span class="ocu-dlg-head-actions" id="ocu-dlg-head-actions"></span>' +
      '<button type="button" class="ocu-dlg-x" data-ocu-dlg="close">' +
      icon(LUCIDE_ICONS.x, 13) +
      "</button>" +
      "</div>" +
      '<div class="ocu-dlg-body" id="ocu-dlg-body" tabindex="0"></div>' +
      '<div class="ocu-dlg-foot" id="ocu-dlg-foot"></div>' +
      "</div>";
    document.body.appendChild(this.el);

    this.titleEl = this.el.querySelector("#ocu-dlg-title") as HTMLElement;
    this.actionsEl = this.el.querySelector(
      "#ocu-dlg-head-actions",
    ) as HTMLElement;
    this.bodyEl = this.el.querySelector("#ocu-dlg-body") as HTMLElement;
    this.footEl = this.el.querySelector("#ocu-dlg-foot") as HTMLElement;

    this.el.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const action = target.closest<HTMLElement>("[data-ocu-dlg]")?.dataset
        .ocuDlg;
      if (action) {
        if (action === "close") {
          this.requestClose();
        } else {
          this.handlers.onAction(action, target.closest<HTMLElement>("[data-ocu-dlg]") as HTMLElement);
        }
        return;
      }
      // Release-note links point at GitHub: route them through the host's
      // external opener instead of navigating the webview.
      const link = target.closest<HTMLAnchorElement>("a[href]");
      if (link) {
        event.preventDefault();
        const href = link.getAttribute("href") ?? "";
        if (/^https?:/i.test(href)) {
          this.handlers.onAction("open-url:" + href, link);
        }
        return;
      }
      if (event.target === this.el) {
        this.requestClose();
      }
    });
  }

  public get root(): HTMLElement {
    return this.el;
  }

  public get visible(): boolean {
    return !this.el.classList.contains("hidden");
  }

  public get isProgress(): boolean {
    return this.content?.progress === true;
  }

  public show(content: UpdateDialogContent): void {
    this.render(content);
    this.el.classList.remove("hidden");
    this.applyFocus(content.focus);
  }

  /**
   * Re-renders in place. Focus is restored only when it was already
   * inside the dialog, so background status pushes never steal it.
   */
  public update(content: UpdateDialogContent): void {
    if (!this.visible) {
      this.show(content);
      return;
    }
    const hadFocus = this.el.contains(document.activeElement);
    this.render(content);
    if (hadFocus) {
      this.applyFocus(content.focus);
    }
  }

  public hide(): void {
    this.el.classList.add("hidden");
  }

  /** Focuses a selector inside the dialog after a step change. */
  public focus(selector: string): void {
    this.applyFocus(selector);
  }

  /** Full title + body as plain text, used by the copy and send actions. */
  public plainText(): string {
    const body = this.bodyEl as HTMLElement & { innerText?: string };
    const bodyText = body.innerText ?? body.textContent ?? "";
    return (this.titleEl.textContent ?? "") + "\n\n" + bodyText.trim();
  }

  public bodyText(): string {
    const body = this.bodyEl as HTMLElement & { innerText?: string };
    return (body.innerText ?? body.textContent ?? "").trim();
  }

  /**
   * Appends streamed output lines to the progress log pane, capped so a
   * chatty package manager cannot grow the DOM without bound.
   */
  public appendOutput(lines: string[]): void {
    const pane = this.bodyEl.querySelector<HTMLElement>("[data-ocu-log]");
    if (!pane || !lines.length) {
      return;
    }
    const atBottom =
      pane.scrollHeight - pane.scrollTop - pane.clientHeight < 24;
    for (const line of lines) {
      const row = document.createElement("div");
      row.className = "ocu-dlg-log-line";
      row.textContent = line;
      pane.appendChild(row);
    }
    while (pane.childElementCount > 200) {
      pane.removeChild(pane.firstElementChild as Element);
    }
    if (atBottom) {
      pane.scrollTop = pane.scrollHeight;
    }
  }

  public handleKeydown(event: KeyboardEvent): boolean {
    if (!this.visible) {
      return false;
    }
    if (this.handlers.onKeyDown?.(event)) {
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.requestClose();
      return true;
    }
    if (event.key === "Tab") {
      trapFocus(this.el, event);
      return true;
    }
    return false;
  }

  private requestClose(): void {
    if (this.content?.progress) {
      this.handlers.onMinimize();
    } else {
      this.handlers.onDismiss();
    }
  }

  private render(content: UpdateDialogContent): void {
    this.content = content;
    this.titleEl.textContent = content.title;
    this.actionsEl.innerHTML = content.headActions ?? "";
    this.bodyEl.innerHTML = content.body;
    this.bodyEl.classList.toggle(
      "is-progress",
      this.bodyEl.querySelector(".ocu-dlg-progress") !== null,
    );
    this.footEl.innerHTML = content.foot;
    const closeButton = this.el.querySelector<HTMLButtonElement>(
      ".ocu-dlg-x",
    );
    if (closeButton) {
      closeButton.setAttribute("aria-label", content.closeLabel ?? "Close");
    }
  }

  private applyFocus(selector?: string): void {
    if (!selector) {
      return;
    }
    this.el.querySelector<HTMLElement>(selector)?.focus();
  }
}
