import { l10n } from "../../i18n";
import { ICONS, icon } from "../shared/icons";
import html from "./toolbar.html?raw";

const titleL10nMap: Record<string, string> = {
  toggleEditor: l10n.t("Switch to Editor"),
  restart: l10n.t("Restart Terminal"),
  fontDecrease: l10n.t("Decrease Font Size"),
  fontIncrease: l10n.t("Increase Font Size"),
  fontReset: l10n.t("Reset Font Size"),
  fontSize: l10n.t("Font Size"),
  settings: l10n.t("Settings"),
  extensionSettings: l10n.t("Extension Settings"),
  keybindSettings: l10n.t("Keyboard Shortcut Settings"),
  keymap: l10n.t("OpenCode Keymap"),
  openCodeCliSettings: l10n.t("OpenCode CLI Config"),
  openCodeGlobalAgentsMd: l10n.t("Global AGENTS.md"),
  openCodeGlobalConfig: l10n.t("OpenCode Config"),
  openCodeUpdate: l10n.t('Install OpenCode'),
  checkOpenCodeUpdates: l10n.t('Check for OpenCode Updates'),
  davOpenPanel: l10n.t('OpenCode config sync'),
};

function localizeTitles(input: string): string {
  return input.replace(/\{\{t:(\w+)\}\}/g, (_, key: string) => {
    return titleL10nMap[key] ?? `{{t:${key}}}`;
  });
}

function localizeIcons(input: string): string {
  return input.replace(
    /\{\{icon:(\w+)(?::(\d+))?\}\}/g,
    (_, key: string, size: string | undefined) => {
      const node = ICONS[key as keyof typeof ICONS];
      return node ? icon(node, size ? Number(size) : 14) : `{{icon:${key}}}`;
    },
  );
}

export const toolbarL10nStrings: Record<string, string> = {
  switchToEditor: titleL10nMap.toggleEditor,
  switchToSidebar: l10n.t("Switch to Sidebar"),
  default: l10n.t("default"),
};

export function renderToolbar(): string {
  return localizeIcons(localizeTitles(html));
}
