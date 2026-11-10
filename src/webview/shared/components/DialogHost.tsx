import { useMemo } from "react";
import { renderKeymapModals } from "../../keymap/markup";
import { renderOpenCodeCliSettingsModal } from "../../opencode-cli-settings/markup";
import { renderExtensionSettingsModal } from "../../extension-settings/markup";
import { renderSyncUi } from "../../sync/markup";

/**
 * Hosts the static dialog shells the imperative feature controllers own.
 *
 * Each shell used to be concatenated into the host-rendered HTML body. Their
 * controllers look elements up by id and manage visibility by toggling
 * classes, so React must not reconcile their internals — the markup is mounted
 * once via `dangerouslySetInnerHTML` and then owned by those controllers.
 *
 * Rendering happens in the React tree rather than by appending to `document.body`
 * so React owns the node's lifetime and unmounts it with the rest of the app.
 * The wrapper carries `display: contents`, so it adds no box to the layout.
 * Localized text is resolved inside the render functions, which run after the
 * i18n bundle has loaded because `main.tsx` awaits it before rendering.
 */
export function DialogHost(): React.ReactElement {
  const markup = useMemo(
    () =>
      [
        renderKeymapModals(),
        renderOpenCodeCliSettingsModal(),
        renderSyncUi(),
        renderExtensionSettingsModal(),
      ].join(""),
    [],
  );

  return <div id="oc-dialog-host" dangerouslySetInnerHTML={{ __html: markup }} />;
}
