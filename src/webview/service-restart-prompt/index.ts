/**
 * "Restart Terminal / Full Restart / Cancel" restart dialog
 * (webview side).
 *
 * The host pushes `showServiceRestartPrompt` while a restart is pending;
 * every exit (the three action buttons, the ✕ close, Esc, backdrop click)
 * hides the dialog and answers with `serviceRestartPromptAnswer` so the
 * waiting restart flow on the host never stalls. Browser-only; host I/O
 * goes through WebviewMessage.
 */
import type { ServiceRestartPromptAction } from "../../types";
import { postMessage } from "../shared/vscode-api";
import { ICONS, icon } from "../shared/icons";

/** 注入方为 terminal/html.ts 的 nonce 脚本 window.__SERVICE_RESTART_L10N__；缺失时回退英文。 */
const l10nStrings: Record<string, string> =
  (typeof window !== "undefined"
    ? (
        window as unknown as {
          __SERVICE_RESTART_L10N__?: Record<string, string>;
        }
      ).__SERVICE_RESTART_L10N__
    : undefined) ?? {};

function t(key: string, fallback: string): string {
  return l10nStrings[key] ?? fallback;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let overlay: HTMLDivElement | null = null;

function answer(action: ServiceRestartPromptAction): void {
  overlay?.classList.add("hidden");
  postMessage({ type: "serviceRestartPromptAnswer", action });
}

function buildOverlay(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "srp-overlay hidden";
  el.id = "srp-overlay";
  el.innerHTML =
    '<div class="srp-dialog" role="alertdialog" aria-modal="true" aria-labelledby="srp-title" aria-describedby="srp-body">' +
    '<button type="button" class="srp-close" id="srp-close" aria-label="' +
    escapeHtml(t("close", "Close")) +
    '">' +
    icon(ICONS.x) +
    "</button>" +
    '<div class="srp-title" id="srp-title">' +
    escapeHtml(t("title", "Restart confirmation")) +
    "</div>" +
    '<div class="srp-body" id="srp-body">' +
    escapeHtml(
      t(
        "body",
        "The terminal is about to restart. Restart Terminal keeps the current session untouched; Full Restart also restarts the OpenCode background service and interrupts the session that is currently running.",
      ),
    ) +
    "</div>" +
    '<div class="srp-actions">' +
    '<button type="button" class="srp-btn srp-btn-primary" id="srp-terminal-only">' +
    escapeHtml(t("terminalOnly", "Restart Terminal")) +
    "</button>" +
    '<button type="button" class="srp-btn srp-btn-warning" id="srp-restart-service">' +
    escapeHtml(t("restartService", "Full Restart")) +
    "</button>" +
    '<button type="button" class="srp-btn" id="srp-cancel">' +
    escapeHtml(t("cancel", "Cancel")) +
    "</button>" +
    "</div></div>";

  el
    .querySelector("#srp-restart-service")
    ?.addEventListener("click", () => answer("restartService"));
  el
    .querySelector("#srp-terminal-only")
    ?.addEventListener("click", () => answer("terminalOnly"));
  el
    .querySelector("#srp-cancel")
    ?.addEventListener("click", () => answer("cancel"));
  // 右上角关闭按钮与取消语义相同：隐藏并回传 cancel
  el
    .querySelector("#srp-close")
    ?.addEventListener("click", () => answer("cancel"));
  // 背景点击等同取消（与 km-confirm 一致），保证宿主端的等待流程总能得到答复
  el.addEventListener("click", (e) => {
    if (e.target === el) answer("cancel");
  });
  document.addEventListener("keydown", (e) => {
    if (!overlay || overlay.classList.contains("hidden")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      answer("cancel");
    }
  });

  document.body.appendChild(el);
  return el;
}

export function showServiceRestartPrompt(): void {
  // 弹窗已可见时忽略重复的 show 消息，不重建、不闪烁
  if (overlay && !overlay.classList.contains("hidden")) return;
  if (!overlay) overlay = buildOverlay();
  overlay.classList.remove("hidden");
  overlay.querySelector<HTMLButtonElement>("#srp-terminal-only")?.focus();
}
