import * as assert from "assert";
import * as vscode from "vscode";

interface ViewContainerContribution {
  id?: string;
  title?: string;
  icon?: string;
}

interface ViewContribution {
  id?: string;
  name?: string;
  type?: string;
}

interface MenuContribution {
  command?: string;
  group?: string;
  when?: string;
}

interface KeybindingContribution {
  command?: string;
  key?: string;
  mac?: string;
  when?: string;
}

interface ExtensionPackageJSON {
  contributes?: {
    viewsContainers?: Record<string, ViewContainerContribution[]>;
    views?: Record<string, ViewContribution[]>;
    menus?: Record<string, MenuContribution[]>;
    keybindings?: KeybindingContribution[];
  };
}

async function activateExtension(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.getExtension(
    "sagez.opencode-cli-sidebar",
  );

  assert.ok(extension, "Extension should be available in the test host");
  await extension.activate();
  return extension;
}

async function getPackageJSON(): Promise<ExtensionPackageJSON> {
  const extension = await activateExtension();
  return extension.packageJSON as ExtensionPackageJSON;
}

suite("Package contribution metadata", () => {
  test("contributes the OpenCode CLI Sidebar view container", async () => {
    const packageJSON = await getPackageJSON();
    const secondarySidebar =
      packageJSON.contributes?.viewsContainers?.secondarySidebar ?? [];
    const container = secondarySidebar.find(
      ({ id }) => id === "opencode-cli-sidebarContainer",
    );

    assert.ok(container, "opencode-cli-sidebarContainer should be contributed");
    assert.strictEqual(container.title, "OpenCode CLI Sidebar");
    assert.strictEqual(container.icon, "resources/activity-bar.svg");
  });

  test("contributes terminal view metadata", async () => {
    const packageJSON = await getPackageJSON();
    const views =
      packageJSON.contributes?.views?.["opencode-cli-sidebarContainer"] ?? [];
    const terminalView = views.find(({ id }) => id === "opencode-cli-sidebar-view");

    assert.ok(terminalView, "opencode-cli-sidebar-view webview should be contributed");
    assert.strictEqual(terminalView.type, "webview");
  });

  test("contributes editor and explorer context menus", async () => {
    const packageJSON = await getPackageJSON();
    const menus = packageJSON.contributes?.menus;
    const editorContext = menus?.["editor/context"] ?? [];
    const explorerContext = menus?.["explorer/context"] ?? [];

    assert.ok(
      editorContext.some(
        ({ command, group }) =>
          command === "opencode-cli-sidebar.sendAtMention" && group === "0_opencode_cli_sidebar",
      ),
      "editor/context should include sendAtMention",
    );
    assert.ok(
      explorerContext.some(
        ({ command, group, when }) =>
          command === "opencode-cli-sidebar.sendToOpencode" &&
          group === "0_opencode_cli_sidebar@1" &&
          when === "!explorerResourceIsFolder",
      ),
      "explorer/context should include file send command",
    );
    assert.ok(
      explorerContext.some(
        ({ command, group, when }) =>
          command === "opencode-cli-sidebar.sendToOpencode" &&
          group === "0_opencode_cli_sidebar@1" &&
          when === "explorerResourceIsFolder",
      ),
      "explorer/context should include folder send command",
    );
    assert.ok(
      !explorerContext.some(
        ({ command }) =>
          command === "opencode-cli-sidebar.sendAbsoluteToOpencode",
      ),
      "explorer/context should not include the removed absolute path send command",
    );
  });

  test("contributes required keyboard shortcuts", async () => {
    const packageJSON = await getPackageJSON();
    const keybindings = packageJSON.contributes?.keybindings ?? [];
    const expectedKeybindings = [
      {
        command: "opencode-cli-sidebar.sendAtMention",
        key: "alt+a",
        mac: "alt+a",
      },
      {
        command: "opencode-cli-sidebar.sendAllOpenFiles",
        key: "ctrl+alt+a",
        mac: "cmd+alt+a",
      },
    ];

    for (const expected of expectedKeybindings) {
      assert.ok(
        keybindings.some(
          ({ command, key, mac }) =>
            command === expected.command &&
            key === expected.key &&
            mac === expected.mac,
        ),
        `${expected.command} should have ${expected.mac} keybinding`,
      );
    }
  });
});


