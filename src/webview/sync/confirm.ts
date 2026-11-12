/**
 * In-webview confirmation for the two one-way sync operations.
 *
 * The host posts `showWebdavConfirm` with localized copy and a request id.
 * Every exit (confirm, cancel, Esc, backdrop click) hides the dialog and
 * answers `webdavConfirmAnswer`, so the host-side promise never stalls.
 * Browser-only; host I/O goes through WebviewMessage.
 */
import type { HostMessage } from "../../types";
import { postMessage } from "../shared/vscode-api";

type ConfirmRequest = Extract<HostMessage, { type: "showWebdavConfirm" }>;

let overlay: HTMLDivElement | null = null;
let activeRequestId: string | null = null;

function node<T extends HTMLElement>(root: ParentNode, id: string): T {
  return root.querySelector(`#${id}`) as T;
}

function answer(confirmed: boolean): void {
  const requestId = activeRequestId;
  activeRequestId = null;
  overlay?.classList.add("hidden");
  if (requestId) {
    postMessage({ type: "webdavConfirmAnswer", requestId, confirmed });
  }
}

function buildOverlay(): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "dav-confirm-overlay hidden";
  root.id = "dav-confirm-overlay";
  root.innerHTML = `
  <div class="dav-confirm" role="alertdialog" aria-modal="true" aria-labelledby="dav-confirm-title" aria-describedby="dav-confirm-desc">
    <div class="dav-confirm-title" id="dav-confirm-title"></div>
    <div class="dav-confirm-desc" id="dav-confirm-desc"></div>
    <div class="dav-confirm-actions">
      <button type="button" class="dav-btn dav-btn--secondary" id="dav-confirm-cancel"></button>
      <button type="button" class="dav-btn dav-btn--danger" id="dav-confirm-ok"></button>
    </div>
  </div>`;
  node<HTMLButtonElement>(root, "dav-confirm-cancel").addEventListener("click", () =>
    answer(false),
  );
  node<HTMLButtonElement>(root, "dav-confirm-ok").addEventListener("click", () =>
    answer(true),
  );
  root.addEventListener("click", (event) => {
    if (event.target === root) {
      answer(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || activeRequestId === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    answer(false);
  });
  document.body.appendChild(root);
  return root;
}

/** Show the dialog for one request; ignores nothing, replaces an older one. */
export function showWebdavConfirm(request: ConfirmRequest): void {
  if (!overlay) {
    overlay = buildOverlay();
  }
  activeRequestId = request.requestId;
  node<HTMLElement>(overlay, "dav-confirm-title").textContent = request.title;
  node<HTMLElement>(overlay, "dav-confirm-desc").textContent = request.body;
  node<HTMLButtonElement>(overlay, "dav-confirm-cancel").textContent =
    request.cancelLabel;
  node<HTMLButtonElement>(overlay, "dav-confirm-ok").textContent =
    request.confirmLabel;
  overlay.classList.remove("hidden");
  node<HTMLButtonElement>(overlay, "dav-confirm-ok").focus();
}

/** True while a confirmation is waiting for an answer. */
export function isWebdavConfirmVisible(): boolean {
  return activeRequestId !== null;
}
