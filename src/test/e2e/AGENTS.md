# E2E Test Agent Notes

## Scope

- `src/test/e2e/` runs against a **real** VS Code instance via `@vscode/test-cli` + Mocha. This is a separate runtime from the Vitest unit suite documented in `src/test/AGENTS.md`.
- No mocks: tests `import * as vscode from "vscode"` and exercise the real extension host API.

## Runtime Differences From Unit Tests

| Aspect | Unit (`src/test/AGENTS.md`) | E2E (here) |
|---|---|---|
| Runner | Vitest | `@vscode/test-cli` → Mocha |
| UI | `describe`/`it` | `suite`/`test` (TDD) |
| Assertions | `expect` / `vi` | Node `assert` module |
| `vscode` | mocked via alias | real API |
| Compile | ts-loader via Vitest | `tsc -p tsconfig.e2e.json` (CommonJS, to `out/test/e2e/`) |

## Compile Chain

`npm run test:e2e` → `pretest:e2e` runs `compile` then `compile:e2e` (`tsc -p tsconfig.e2e.json`) → `vscode-test` runs compiled `out/test/e2e/**/*.e2e.js`. The e2e tsconfig uses `module: "commonjs"`, `types: ["node", "mocha", "vscode"]`, `rootDir: src/test/e2e`.

## Config

- `.vscode-test.js`: `workspaceFolder: src/test/e2e/fixtures/workspace`, `mocha.ui: "tdd"`, `timeout: 20000` (20s).
- Fixture workspace (`fixtures/workspace/.vscode/settings.json`) is empty: the extension now auto-starts OpenCode whenever the view becomes visible, so activation tests must not resolve the view.

## File Layout

```
src/test/e2e/
├── fixtures/workspace/.vscode/settings.json   # disabled auto-start
└── suite/
    ├── activation.e2e.ts          # extension activates
    ├── contributions.e2e.ts       # package.json contributes match code
    ├── commands.e2e.ts            # command registration
    ├── commands-comprehensive.e2e.ts
    ├── config-comprehensive.e2e.ts
    ├── settings.e2e.ts            # settings read from config
    ├── webview.e2e.ts             # webview lifecycle
    ├── session-flows.e2e.ts       # session management
    └── command-behavior.e2e.ts    # command execution
```

- Naming: `*.e2e.ts` (compiled to `*.e2e.js`). The glob in `.vscode-test.js` requires this suffix.
- All e2e tests live under `suite/`; do not scatter them.

## Constraints

- Tests depend on extension activation order; reset state between tests via VS Code commands, not via the unit-test singleton reset helpers (`OutputChannelService.resetInstance()` etc. are unit-test-only patterns).
- E2E is not part of coverage thresholds; coverage gating only applies to the Vitest suite.
- 20s timeout is per-test; long-running flows must chunk or be split.

## Verification

- Full run: `npm run test:e2e`.
- Requires a successful `npm run compile` + `npm run compile:e2e` first.
