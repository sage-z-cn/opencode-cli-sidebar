import * as assert from "assert";
import * as vscode from "vscode";

async function activateExtension(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.getExtension(
    "sagez.opencode-cli-sidebar",
  );

  assert.ok(extension, "Extension should be available in the test host");
  await extension.activate();
  return extension;
}

suite("Command registration", () => {
  test("registers core extension commands", async () => {
    await activateExtension();

    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes("opencode-cli-sidebar.start"));
    assert.ok(commands.includes("opencode-cli-sidebar.focus"));
  });

  test("registers focus command without relying on internal workbench commands", async () => {
    await activateExtension();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("opencode-cli-sidebar.focus"),
      "opencode-cli-sidebar.focus should be registered",
    );
  });

  test("uses opencode command defaults", async () => {
    const extension = await activateExtension();

    const properties = extension.packageJSON.contributes.configuration
      .properties as Record<string, { default: unknown }>;

    assert.strictEqual(
      properties["opencode-cli-sidebar.opencode.commandPath"].default,
      "opencode",
    );
  });
});


