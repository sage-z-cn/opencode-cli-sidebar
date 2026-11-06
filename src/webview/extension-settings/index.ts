/**
 * Extension settings dialog (webview side).
 *
 * Browser-only: the host pushes one `ExtensionSettingsSnapshot` and every
 * control change posts a single immediate-apply message for the active layer.
 * Rows are built once so a snapshot reply only rewrites control values; focus
 * and in-progress typing survive.
 */
import type {
  ExtensionSettingsScope,
  ExtensionSettingsSnapshot,
  HostMessage,
} from "../../types";
import { postMessage } from "../shared/vscode-api";
import { openSyncPanel } from "../sync";

const l10nStrings: Record<string, string> =
  (typeof window !== "undefined"
    ? (window as unknown as { __EXT_SETTINGS_L10N__?: Record<string, string> })
        .__EXT_SETTINGS_L10N__
    : undefined) ?? {};

/** Look up a runtime string: injected translation first, English source second. */
function tr(text: string): string {
  return l10nStrings[text] ?? text;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Catalog ──

type ControlKind = "boolean" | "enum" | "number" | "string" | "array" | "severities";

interface EnumOption {
  value: string;
  label: string;
}

interface SettingDef {
  /** Setting suffix without the `opencode-cli-sidebar.` prefix. */
  key: string;
  kind: ControlKind;
  label: string;
  desc?: string;
  min?: number;
  max?: number;
  options?: EnumOption[];
  severities?: EnumOption[];
}

interface GroupDef {
  id: string;
  label: string;
  intro?: string;
  settings: SettingDef[];
  /** Config sync is a pointer to its own panel, not an editable group. */
  sync?: boolean;
}

const SEVERITIES: EnumOption[] = [
  { value: "error", label: "Errors" },
  { value: "warning", label: "Warnings" },
  { value: "information", label: "Information" },
  { value: "hint", label: "Hints" },
];

const GROUPS: GroupDef[] = [
  {
    id: "terminal",
    label: "Terminal appearance",
    intro: "Font and focus cues for the terminal.",
    settings: [
      {
        key: "fontFamily",
        kind: "string",
        label: "Terminal font family",
        desc: "Font used by the terminal. A Nerd Font is recommended for Powerline glyphs.",
      },
      {
        key: "focusIndicatorMode",
        kind: "enum",
        label: "Focus indicator",
        desc: "Highlights the terminal border while the terminal has keyboard focus.",
        options: [
          { value: "off", label: "Off" },
          { value: "bottomBorder", label: "Bottom border" },
          { value: "fullBorder", label: "Full border" },
        ],
      },
      {
        key: "focusIndicatorBorderWidth",
        kind: "number",
        label: "Focus indicator width",
        desc: "Border thickness in pixels. Used when the focus indicator is on.",
        min: 1,
        max: 8,
      },
    ],
  },
  {
    id: "interaction",
    label: "Interaction",
    intro: "How the sidebar sends files and where focus goes afterwards.",
    settings: [
      {
        key: "sendKeybindingsToShell",
        kind: "boolean",
        label: "Send keybindings to the terminal",
        desc: "Give Ctrl or Cmd plus letter shortcuts to the terminal instead of VS Code. Control keys such as Ctrl+C always reach the terminal.",
      },
      {
        key: "autoFocusOnSend",
        kind: "boolean",
        label: "Focus the sidebar after sending",
        desc: "Return keyboard focus to the terminal after files or text are sent.",
      },
      {
        key: "fileSendMode",
        kind: "enum",
        label: "How files are sent",
        desc: "Attach files to the composer, or type their paths into the prompt.",
        options: [
          { value: "attachment", label: "Attachment" },
          { value: "path", label: "Path text" },
        ],
      },
    ],
  },
  {
    id: "launch",
    label: "Startup and command line",
    intro:
      "When OpenCode starts, the command it runs, and the shell behind the terminal.",
    settings: [
      {
        key: "startup.coordinate",
        kind: "boolean",
        label: "Coordinate startup across windows",
        desc: "Keep several VS Code windows from starting the background service at the same time. Takes effect after the window reloads.",
      },
      {
        key: "opencode.continueLastSession",
        kind: "boolean",
        label: "Continue the last session",
        desc: "Resume the most recent session instead of starting a new one. Takes effect the next time a session starts.",
      },
      {
        key: "autoShareContext",
        kind: "boolean",
        label: "Share editor context",
        desc: "Share open files and selections with OpenCode. Takes effect the next time a session starts.",
      },
      {
        key: "opencode.commandPath",
        kind: "string",
        label: "OpenCode command",
        desc: "Command or path used to launch the OpenCode CLI. Takes effect the next time a session starts.",
      },
      {
        key: "opencode.args",
        kind: "array",
        label: "Launch arguments",
        desc: "One argument per line. Arguments reach the launch command in order. Takes effect the next time a session starts.",
      },
      {
        key: "shellPath",
        kind: "string",
        label: "Shell path",
        desc: "Shell used for the terminal. Leave empty to use the shell from VS Code. Takes effect the next time the terminal starts.",
      },
      {
        key: "shellArgs",
        kind: "array",
        label: "Shell arguments",
        desc: "One argument per line. Leave empty to detect the arguments automatically. Takes effect the next time the terminal starts.",
      },
    ],
  },
  {
    id: "context",
    label: "Context and diagnostics",
    intro: "Editor context and diagnostic details shared with OpenCode.",
    settings: [
      {
        key: "contextDebounceMs",
        kind: "number",
        label: "Context update delay",
        desc: "Wait time before an editor change is sent as new context, in milliseconds. Takes effect after the window reloads.",
        min: 100,
        max: 5000,
      },
      {
        key: "maxDiagnosticLength",
        kind: "number",
        label: "Diagnostic message limit",
        desc: "Longest diagnostic message included in code actions, in characters.",
        min: 100,
        max: 2000,
      },
      {
        key: "codeActionSeverities",
        kind: "severities",
        label: "Diagnostic levels",
        desc: "Diagnostic levels that offer OpenCode code actions.",
        severities: SEVERITIES,
      },
    ],
  },
  {
    id: "logging",
    label: "Logging and network",
    intro: "Log detail and network timeouts.",
    settings: [
      {
        key: "logLevel",
        kind: "enum",
        label: "Log level",
        desc: "Amount of detail written to the extension log.",
        options: [
          { value: "debug", label: "Debug" },
          { value: "info", label: "Info" },
          { value: "warn", label: "Warning" },
          { value: "error", label: "Error" },
        ],
      },
      {
        key: "httpTimeout",
        kind: "number",
        label: "Request timeout",
        desc: "Wait time for an OpenCode HTTP response, in milliseconds. Takes effect the next time a session starts.",
        min: 1000,
        max: 30000,
      },
    ],
  },
  {
    id: "update",
    label: "Updates",
    intro: "How often the extension looks for OpenCode updates.",
    settings: [
      {
        key: "update.autoCheck",
        kind: "boolean",
        label: "Check for OpenCode updates",
        desc: "Look for OpenCode updates in the background.",
      },
      {
        key: "update.checkIntervalHours",
        kind: "number",
        label: "Check interval",
        desc: "Hours between automatic update checks. Takes effect after the window reloads.",
        min: 1,
      },
    ],
  },
  {
    id: "sync",
    label: "Config sync",
    sync: true,
    settings: [],
  },
];

const ALL_SETTINGS: SettingDef[] = GROUPS.flatMap((group) => group.settings);
const SETTINGS_BY_KEY = new Map(ALL_SETTINGS.map((def) => [def.key, def]));

/** The only row that offers a reset control, so the rest stays uncluttered. */
const RESETTABLE_SETTING = "fontFamily";

const DEFAULT_GROUP = "terminal";

// ── State ──

interface DialogState {
  initialized: boolean;
  scope: ExtensionSettingsScope;
  snapshot: ExtensionSettingsSnapshot | null;
  activeGroup: string;
  /** Setting whose write is in flight, used when a result carries no key. */
  pendingKey: string | null;
}

const state: DialogState = {
  initialized: false,
  scope: "user",
  snapshot: null,
  activeGroup: DEFAULT_GROUP,
  pendingKey: null,
};

/** Element that opened the dialog; the toolbar settings button wins on close. */
let opener: HTMLElement | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

const STATUS_TTL_MS = 2000;

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function rowFor(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-eset-row="${key.replace(/"/g, '\\"')}"]`,
  );
}

// ── Value helpers ──

function effectiveValue(def: SettingDef): unknown {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return undefined;
  }
  const value = snapshot.values[def.key];
  return value === undefined ? snapshot.defaults[def.key] : value;
}

function asString(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function asNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function layerValues(): Record<string, unknown> {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return {};
  }
  return state.scope === "user" ? snapshot.userValues : snapshot.workspaceValues;
}

function layerHas(
  map: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return Boolean(map) && Object.prototype.hasOwnProperty.call(map, key);
}

function hasExplicitValue(def: SettingDef): boolean {
  return layerHas(layerValues(), def.key);
}

// ── Markup builders ──

function controlId(key: string): string {
  return `eset-c-${key}`;
}

function labelId(key: string): string {
  return `eset-l-${key}`;
}

function controlHtml(def: SettingDef): string {
  const id = controlId(def.key);
  const attrs = `id="${id}" data-eset-control="${escapeHtml(def.key)}" data-eset-kind="${def.kind}"`;
  switch (def.kind) {
    case "boolean":
      return `<span class="eset-switch"><input type="checkbox" ${attrs}><span class="eset-switch-track" aria-hidden="true"></span></span>`;
    case "enum": {
      const options = (def.options ?? [])
        .map(
          (opt) =>
            `<option value="${escapeHtml(opt.value)}">${escapeHtml(tr(opt.label))}</option>`,
        )
        .join("");
      return `<select class="eset-select" ${attrs}>${options}</select>`;
    }
    case "number": {
      const min = def.min === undefined ? "" : ` min="${def.min}"`;
      const max = def.max === undefined ? "" : ` max="${def.max}"`;
      return `<input class="eset-input eset-number" type="number" step="1"${min}${max} spellcheck="false" ${attrs}>`;
    }
    case "string":
      return `<input class="eset-input" type="text" spellcheck="false" autocomplete="off" ${attrs}>`;
    case "array":
      return `<textarea class="eset-textarea" rows="3" spellcheck="false" ${attrs}></textarea>`;
    case "severities": {
      const checks = (def.severities ?? [])
        .map(
          (sev) =>
            `<label class="eset-check"><input type="checkbox" data-eset-severity="${escapeHtml(sev.value)}" data-eset-control="${escapeHtml(def.key)}"><span>${escapeHtml(tr(sev.label))}</span></label>`,
        )
        .join("");
      return `<div class="eset-checks" role="group" aria-labelledby="${labelId(def.key)}">${checks}</div>`;
    }
    default:
      return "";
  }
}

function rowHtml(def: SettingDef): string {
  const title =
    def.kind === "severities"
      ? `<div class="eset-row-title" id="${labelId(def.key)}">${escapeHtml(tr(def.label))}</div>`
      : `<label class="eset-row-title" id="${labelId(def.key)}" for="${controlId(def.key)}">${escapeHtml(tr(def.label))}</label>`;
  const stacked = def.kind === "array" ? " is-stacked" : "";
  // Only the terminal font family keeps a reset control: every other row is
  // easy to restore by hand, and a reset affordance on each row was noise.
  const meta =
    def.key === RESETTABLE_SETTING
      ? `<div class="eset-meta">
        <button type="button" class="eset-reset hidden" data-eset-reset="${escapeHtml(def.key)}" title="${escapeHtml(tr("Reset to the default"))}">${escapeHtml(tr("Reset"))}</button>
      </div>`
      : "";
  return `<div class="eset-row${stacked}" data-eset-row="${escapeHtml(def.key)}" role="group" aria-labelledby="${labelId(def.key)}">
    <div class="eset-row-text">
      <div class="eset-row-head">
        ${title}
      </div>
      ${def.desc ? `<div class="eset-row-desc">${escapeHtml(tr(def.desc))}</div>` : ""}
      <div class="eset-row-layer hidden" data-eset-layer>
        <span data-eset-layer-text></span>
        <button type="button" class="eset-layer-action hidden" data-eset-layer-switch></button>
      </div>
      <div class="eset-row-error hidden" role="alert"></div>
    </div>
    <div class="eset-control">
      ${meta}
      ${controlHtml(def)}
    </div>
  </div>`;
}

function syncPaneHtml(): string {
  return `<div class="eset-sync">
    <div class="eset-sync-title">${escapeHtml(tr("Config sync"))}</div>
    <div class="eset-sync-text">${escapeHtml(tr("Sync your OpenCode configuration across machines. The sync panel has its own setup."))}</div>
    <button type="button" class="eset-btn eset-btn--secondary" data-eset-open-sync>${escapeHtml(tr("Open config sync"))}</button>
  </div>`;
}

function paneHtml(group: GroupDef): string {
  const on = group.id === state.activeGroup ? " is-on" : "";
  const body = group.sync
    ? syncPaneHtml()
    : `${group.intro ? `<div class="eset-group-intro">${escapeHtml(tr(group.intro))}</div>` : ""}${group.settings.map(rowHtml).join("")}`;
  return `<div class="eset-pane${on}" data-eset-pane="${group.id}">${body}</div>`;
}

function renderShell(): void {
  const nav = el("eset-nav");
  const panes = el("eset-panes");
  if (!nav || !panes) {
    return;
  }
  nav.innerHTML = GROUPS.map((group) => {
    const on = group.id === state.activeGroup;
    return `<button type="button" class="eset-nav-item${on ? " is-on" : ""}" data-eset-group="${group.id}"${on ? ' aria-current="true"' : ""}>${escapeHtml(tr(group.label))}</button>`;
  }).join("");
  panes.innerHTML = GROUPS.map(paneHtml).join("");
}

// ── Rendering ──

function setLoading(visible: boolean, message?: string): void {
  const box = el("eset-loading");
  const text = el("eset-loading-text");
  box?.classList.toggle("hidden", !visible);
  box?.classList.toggle("is-error", visible && Boolean(message));
  if (text) {
    text.textContent = visible && message ? message : tr("Loading…");
  }
  el("eset-panes")?.classList.toggle("is-loading", visible);
}

function refreshRowMeta(def: SettingDef): void {
  const row = rowFor(def.key);
  if (!row) {
    return;
  }
  if (def.key === RESETTABLE_SETTING) {
    row
      .querySelector<HTMLElement>("[data-eset-reset]")
      ?.classList.toggle("hidden", !hasExplicitValue(def));
  }
  refreshRowLayer(def);
}

/**
 * Names the layer the visible value comes from when it is not the layer being
 * edited. A workspace value beats a user value, so an edit on the user layer
 * would land in the file yet stay invisible in the row.
 */
function refreshRowLayer(def: SettingDef): void {
  const row = rowFor(def.key);
  if (!row) {
    return;
  }
  const box = row.querySelector<HTMLElement>("[data-eset-layer]");
  const text = row.querySelector<HTMLElement>("[data-eset-layer-text]");
  const action = row.querySelector<HTMLButtonElement>("[data-eset-layer-switch]");
  if (!box) {
    return;
  }

  const snapshot = state.snapshot;
  const fromUser = layerHas(snapshot?.userValues, def.key);
  const fromWorkspace = layerHas(snapshot?.workspaceValues, def.key);

  let message = "";
  let actionLabel = "";
  if (snapshot?.hasWorkspace && state.scope === "user" && fromWorkspace) {
    message = tr("Workspace settings override this value.");
    actionLabel = tr("Switch to workspace");
  } else if (
    snapshot &&
    state.scope === "workspace" &&
    fromUser &&
    !fromWorkspace
  ) {
    message = tr("This value comes from your user settings.");
  }

  box.classList.toggle("hidden", !message);
  if (text) {
    text.textContent = message;
  }
  if (action) {
    action.textContent = actionLabel;
    action.classList.toggle("hidden", !actionLabel);
  }
}

function applyRowValue(def: SettingDef): void {
  const value = effectiveValue(def);
  const control = el<HTMLElement>(controlId(def.key));
  const row = rowFor(def.key);

  if (def.kind === "severities") {
    const selected = asStringArray(value);
    row
      ?.querySelectorAll<HTMLInputElement>("[data-eset-severity]")
      .forEach((box) => {
        box.checked = selected.includes(box.dataset.esetSeverity ?? "");
      });
  } else if (control instanceof HTMLInputElement) {
    if (def.kind === "boolean") {
      control.checked = Boolean(value);
    } else if (def.kind === "number") {
      control.value = String(asNumber(value));
    } else {
      control.value = asString(value);
    }
  } else if (control instanceof HTMLSelectElement) {
    const next = asString(value);
    if (Array.from(control.options).some((opt) => opt.value === next)) {
      control.value = next;
    }
  } else if (control instanceof HTMLTextAreaElement) {
    control.value = asStringArray(value).join("\n");
  }

  refreshRowMeta(def);
}

function applyAllValues(): void {
  ALL_SETTINGS.forEach(applyRowValue);
}

function renderScope(): void {
  const snapshot = state.snapshot;
  const known = snapshot !== null;
  // Until the first snapshot the workspace state is unknown, so the workspace
  // layer stays unavailable instead of failing on the host side.
  const hasWorkspace = known && Boolean(snapshot?.hasWorkspace);
  document
    .querySelectorAll<HTMLButtonElement>("[data-eset-scope]")
    .forEach((btn) => {
      const scope = btn.dataset.esetScope as ExtensionSettingsScope;
      const on = scope === state.scope;
      const disabled = scope === "workspace" && !hasWorkspace;
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-pressed", String(on));
      btn.disabled = disabled;
    });
  el("eset-scope-note")?.classList.toggle("hidden", !known || hasWorkspace);
}

function setStatus(kind: "ok" | "error" | "idle", text: string): void {
  const node = el("eset-status");
  if (!node) {
    return;
  }
  node.textContent = text;
  node.classList.toggle("is-ok", kind === "ok");
  node.classList.toggle("is-error", kind === "error");
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  if (kind === "ok") {
    statusTimer = setTimeout(() => {
      statusTimer = null;
      if (node.textContent === text) {
        node.textContent = "";
        node.classList.remove("is-ok");
      }
    }, STATUS_TTL_MS);
  }
}

function showRowError(def: SettingDef, message: string): void {
  const row = rowFor(def.key);
  if (!row) {
    return;
  }
  const error = row.querySelector<HTMLElement>(".eset-row-error");
  if (error) {
    error.textContent = message;
    error.classList.remove("hidden");
  }
  row.classList.add("is-invalid");
}

function clearRowError(def: SettingDef): void {
  const row = rowFor(def.key);
  if (!row) {
    return;
  }
  const error = row.querySelector<HTMLElement>(".eset-row-error");
  if (error) {
    error.textContent = "";
    error.classList.add("hidden");
  }
  row.classList.remove("is-invalid");
}

function switchGroup(groupId: string): void {
  state.activeGroup = groupId;
  document
    .querySelectorAll<HTMLElement>("#eset-nav [data-eset-group]")
    .forEach((btn) => {
      const on = btn.dataset.esetGroup === groupId;
      btn.classList.toggle("is-on", on);
      if (on) {
        btn.setAttribute("aria-current", "true");
      } else {
        btn.removeAttribute("aria-current");
      }
    });
  document
    .querySelectorAll<HTMLElement>("#eset-panes [data-eset-pane]")
    .forEach((pane) => {
      pane.classList.toggle("is-on", pane.dataset.esetPane === groupId);
    });
  const body = el("eset-body");
  if (body) {
    body.scrollTop = 0;
  }
}

// ── Writes ──

function commit(def: SettingDef, value: unknown): void {
  clearRowError(def);
  state.pendingKey = def.key;
  postMessage({
    type: "updateExtensionSetting",
    key: def.key,
    value,
    scope: state.scope,
  });
}

function onControlChange(target: HTMLElement): void {
  const key = target.dataset.esetControl;
  if (!key) {
    return;
  }
  const def = SETTINGS_BY_KEY.get(key);
  if (!def) {
    return;
  }

  if (target.dataset.esetSeverity) {
    const row = rowFor(def.key);
    const selected = Array.from(
      row?.querySelectorAll<HTMLInputElement>("[data-eset-severity]") ?? [],
    )
      .filter((box) => box.checked)
      .map((box) => box.dataset.esetSeverity ?? "")
      .filter(Boolean);
    const order = (def.severities ?? []).map((sev) => sev.value);
    commit(
      def,
      order.filter((value) => selected.includes(value)),
    );
    return;
  }

  if (def.kind === "boolean") {
    commit(def, (target as HTMLInputElement).checked);
    return;
  }
  if (def.kind === "enum") {
    commit(def, (target as HTMLSelectElement).value);
    return;
  }
  if (def.kind === "number") {
    const raw = (target as HTMLInputElement).value.trim();
    const num = Number(raw);
    if (!raw || !Number.isFinite(num)) {
      // An empty or malformed number keeps the stored value.
      applyRowValue(def);
      return;
    }
    commit(def, num);
    return;
  }
  if (def.kind === "array") {
    const lines = (target as HTMLTextAreaElement).value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    commit(def, lines);
    return;
  }
  commit(def, (target as HTMLInputElement).value.trim());
}

function resetSetting(key: string): void {
  const def = SETTINGS_BY_KEY.get(key);
  if (!def) {
    return;
  }
  clearRowError(def);
  state.pendingKey = key;
  postMessage({ type: "resetExtensionSetting", key, scope: state.scope });
}

function selectScope(scope: ExtensionSettingsScope): void {
  if (scope === state.scope) {
    return;
  }
  if (scope === "workspace" && !state.snapshot?.hasWorkspace) {
    return;
  }
  state.scope = scope;
  renderScope();
  // Reset buttons and the layer dot follow the active layer.
  ALL_SETTINGS.forEach(refreshRowMeta);
  postMessage({ type: "requestExtensionSettingsData" });
}

// ── Open / close ──

function closeDialog(): void {
  const overlay = el("eset-overlay");
  if (!overlay || overlay.classList.contains("hidden")) {
    return;
  }
  overlay.classList.add("hidden");
  const target = el<HTMLElement>("btn-settings") ?? opener;
  opener = null;
  target?.focus();
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function trapTab(event: KeyboardEvent): void {
  const modal = el("eset-modal");
  if (!modal) {
    return;
  }
  const items = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (node) => node.getClientRects().length > 0,
  );
  if (!items.length) {
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !modal.contains(active)) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function onKeydown(event: KeyboardEvent): void {
  const overlay = el("eset-overlay");
  if (!overlay || overlay.classList.contains("hidden")) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeDialog();
    return;
  }
  if (event.key === "Tab") {
    trapTab(event);
  }
}

// ── Init ──

function wireEvents(): void {
  el("eset-close")?.addEventListener("click", closeDialog);
  el("eset-open-settings")?.addEventListener("click", () =>
    postMessage({ type: "openSettings" }),
  );

  const overlay = el("eset-overlay");
  overlay?.addEventListener("mousedown", (event) => {
    if (event.target === overlay) {
      closeDialog();
    }
  });

  document
    .querySelectorAll<HTMLButtonElement>("[data-eset-scope]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        selectScope(btn.dataset.esetScope as ExtensionSettingsScope);
      });
    });

  el("eset-nav")?.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-eset-group]",
    );
    if (btn?.dataset.esetGroup) {
      switchGroup(btn.dataset.esetGroup);
    }
  });

  const panes = el("eset-panes");
  panes?.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement) {
      onControlChange(target);
    }
  });
  panes?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const reset = target.closest<HTMLElement>("[data-eset-reset]");
    if (reset?.dataset.esetReset) {
      resetSetting(reset.dataset.esetReset);
      return;
    }
    if (target.closest("[data-eset-layer-switch]")) {
      selectScope("workspace");
      return;
    }
    if (target.closest("[data-eset-open-sync]")) {
      closeDialog();
      openSyncPanel("general");
    }
  });

  document.addEventListener("keydown", onKeydown);
}

function ensureInit(): boolean {
  if (state.initialized) {
    return true;
  }
  if (!el("eset-overlay")) {
    return false;
  }
  state.initialized = true;
  renderShell();
  renderScope();
  setLoading(state.snapshot === null);
  wireEvents();
  return true;
}

/** Wire the static shell once; the host injects the markup before the bundle runs. */
export function initExtensionSettingsUi(): void {
  ensureInit();
}

/**
 * Open the dialog and ask the host for a fresh snapshot. The overlay is
 * revealed first so the loading state is visible instead of an empty form.
 */
export function openExtensionSettingsDialog(): void {
  if (!ensureInit()) {
    return;
  }
  const overlay = el("eset-overlay");
  if (!overlay) {
    return;
  }
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.pendingKey = null;
  setStatus("idle", "");
  overlay.classList.remove("hidden");
  setLoading(state.snapshot === null);
  switchGroup(state.activeGroup);
  el("eset-close")?.focus();
  postMessage({ type: "requestExtensionSettingsData" });
}

// ── Host messages ──

/** Full snapshot reply: correct every control and the layer state. */
export function applyExtensionSettingsData(
  settings: ExtensionSettingsSnapshot,
): void {
  if (!ensureInit()) {
    return;
  }
  state.snapshot = settings;
  if (state.scope === "workspace" && !settings.hasWorkspace) {
    state.scope = "user";
  }
  state.pendingKey = null;
  renderScope();
  setLoading(false);
  applyAllValues();
}

/** Per-write feedback: a failure keeps the stored value and names the row. */
export function handleExtensionSettingsSaveResult(
  message: Extract<HostMessage, { type: "extensionSettingsSaveResult" }>,
): void {
  if (!ensureInit()) {
    return;
  }
  const key = message.key ?? state.pendingKey;
  const def = key ? SETTINGS_BY_KEY.get(key) : undefined;
  state.pendingKey = null;

  if (message.ok) {
    if (def) {
      clearRowError(def);
    }
    setStatus("ok", tr("Saved"));
    return;
  }

  const text =
    message.error?.trim() ||
    tr("Could not save this setting. The stored value was kept.");
  setStatus("error", text);
  if (!def) {
    // A snapshot that never arrives leaves the dialog in its loading state;
    // surface the reason there instead of an endless spinner.
    if (!state.snapshot) {
      setLoading(true, text);
    }
    return;
  }
  showRowError(def, text);
  // Roll the control back to the last known stored value.
  applyRowValue(def);
}
