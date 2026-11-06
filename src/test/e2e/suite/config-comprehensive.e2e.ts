import * as assert from "assert";
import * as vscode from "vscode";

interface ConfigurationProperty {
  type?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  items?: ConfigurationProperty;
  required?: string[];
  properties?: Record<string, ConfigurationProperty>;
}

interface ConfigurationSpec {
  type: string;
  defaultValue: unknown;
  minimum?: number;
  maximum?: number;
  enumValues?: string[];
  itemType?: string;
}

async function activateExtension(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.getExtension(
    "sagez.opencode-cli-sidebar",
  );

  assert.ok(extension, "Extension should be available in the test host");
  await extension.activate();
  return extension;
}

function getConfigurationProperties(
  extension: vscode.Extension<unknown>,
): Record<string, ConfigurationProperty> {
  const packageJSON = extension.packageJSON as {
    contributes?: {
      configuration?: {
        properties?: Record<string, ConfigurationProperty>;
      };
    };
  };

  const properties = packageJSON.contributes?.configuration?.properties;
  assert.ok(properties, "Extension should contribute configuration properties");
  return properties;
}

const nerdFontStack =
  "'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', 'CascadiaCode NF', Menlo, monospace";

const configurationSpecs: Record<string, ConfigurationSpec> = {
  "opencode-cli-sidebar.fontSize": {
    type: "number",
    defaultValue: 12,
    minimum: 6,
    maximum: 25,
  },
  "opencode-cli-sidebar.fontFamily": {
    type: "string",
    defaultValue: nerdFontStack,
  },
  "opencode-cli-sidebar.focusIndicatorMode": {
    type: "string",
    defaultValue: "bottomBorder",
    enumValues: ["off", "bottomBorder", "fullBorder"],
  },
  "opencode-cli-sidebar.focusIndicatorBorderWidth": {
    type: "number",
    defaultValue: 2,
    minimum: 1,
    maximum: 8,
  },
  "opencode-cli-sidebar.autoFocusOnSend": { type: "boolean", defaultValue: true },
  "opencode-cli-sidebar.shellPath": { type: "string", defaultValue: "" },
  "opencode-cli-sidebar.shellArgs": {
    type: "array",
    defaultValue: [],
    itemType: "string",
  },
  "opencode-cli-sidebar.sendKeybindingsToShell": {
    type: "boolean",
    defaultValue: true,
  },
  "opencode-cli-sidebar.autoShareContext": { type: "boolean", defaultValue: true },
  "opencode-cli-sidebar.httpTimeout": {
    type: "number",
    defaultValue: 5000,
    minimum: 1000,
    maximum: 30000,
  },
  "opencode-cli-sidebar.logLevel": {
    type: "string",
    defaultValue: "info",
    enumValues: ["debug", "info", "warn", "error"],
  },
  "opencode-cli-sidebar.contextDebounceMs": {
    type: "number",
    defaultValue: 500,
    minimum: 100,
    maximum: 5000,
  },
  "opencode-cli-sidebar.maxDiagnosticLength": {
    type: "number",
    defaultValue: 500,
    minimum: 100,
    maximum: 2000,
  },
  "opencode-cli-sidebar.codeActionSeverities": {
    type: "array",
    defaultValue: ["error", "warning"],
    itemType: "string",
  },
  "opencode-cli-sidebar.opencode.commandPath": {
    type: "string",
    defaultValue: "opencode",
  },
  "opencode-cli-sidebar.opencode.args": {
    type: "array",
    defaultValue: [],
    itemType: "string",
  },
  "opencode-cli-sidebar.opencode.continueLastSession": {
    type: "boolean",
    defaultValue: true,
  },
  "opencode-cli-sidebar.update.autoCheck": {
    type: "boolean",
    defaultValue: true,
  },
  "opencode-cli-sidebar.update.checkIntervalHours": {
    type: "number",
    defaultValue: 24,
    minimum: 1,
  },
};

function assertConfigurationProperty(
  id: string,
  property: ConfigurationProperty | undefined,
  spec: ConfigurationSpec,
): void {
  assert.ok(property, `${id} should be contributed`);
  assert.strictEqual(property.type, spec.type, `${id} should have expected type`);
  assert.deepStrictEqual(
    property.default,
    spec.defaultValue,
    `${id} should have expected default`,
  );

  if (spec.minimum !== undefined) {
    assert.strictEqual(property.minimum, spec.minimum);
  }

  if (spec.maximum !== undefined) {
    assert.strictEqual(property.maximum, spec.maximum);
  }

  if (spec.enumValues) {
    assert.deepStrictEqual(property.enum, spec.enumValues);
  }

  if (spec.itemType) {
    assert.strictEqual(property.items?.type, spec.itemType);
  }
}

suite("Comprehensive configuration contributions", () => {
  test("contributes exactly the expected 25 configuration properties", async () => {
    const extension = await activateExtension();
    const properties = getConfigurationProperties(extension);
    const expectedPropertyIds = Object.keys(configurationSpecs).sort();

    assert.strictEqual(expectedPropertyIds.length, 25);
    assert.deepStrictEqual(Object.keys(properties).sort(), expectedPropertyIds);
  });

  for (const [id, spec] of Object.entries(configurationSpecs)) {
    test(`defines ${id} metadata`, async () => {
      const extension = await activateExtension();
      const properties = getConfigurationProperties(extension);

      assertConfigurationProperty(id, properties[id], spec);
    });
  }
});

suite("Runtime configuration defaults", () => {
  test("reads key defaults from vscode.workspace.getConfiguration", async () => {
    await activateExtension();

    const config = vscode.workspace.getConfiguration("opencode-cli-sidebar");
    const defaultValue = (key: string): unknown =>
      config.inspect(key)?.defaultValue;

    assert.strictEqual(defaultValue("opencode.commandPath"), "opencode");
    assert.deepStrictEqual(defaultValue("opencode.args"), []);
    assert.strictEqual(defaultValue("opencode.continueLastSession"), true);
    assert.strictEqual(defaultValue("fontSize"), 12);
  });
});


