# Core Agent Notes

## Scope

- `src/core` is the activation/deactivation seam. `ExtensionLifecycle.activate()` wires services, providers, code actions, and commands; `src/extension.ts` only delegates to it.
- Commands are registered only through `src/core/commands/index.ts`, which delegates to `terminalCommands.ts` and `syncCommands.ts`.
- The command files are `terminalCommands.ts` for terminal/instance commands and `syncCommands.ts` for WebDAV config-sync commands. If you encounter references to other command files or backend-specific command groups, they are stale — those files do not exist.

## Where To Look

- Activation/service wiring: `ExtensionLifecycle.ts`.
- Command dependency shape: `commands/index.ts` and `TerminalCommandDependencies` in `commands/terminalCommands.ts`.
- Sync commands: `commands/syncCommands.ts` registers the config-sync commands and resolves `ConfigSyncService` through the sync service registry.
- User-facing commands: `commands/terminalCommands.ts` registers start, focus, paste, file-reference sends, send selected text, open terminal in editor, and restore to sidebar.
- Prompt routing: `ExtensionLifecycle.sendPromptToOpenCode()` tries the provider/terminal path and can fall back to a discovered OpenCode instance.
- Active terminal resolution: `ExtensionLifecycle.getActiveTerminalId()` reads `InstanceStore.getActive().runtime.terminalKey` before falling back.

## Constraints

- Do not add command registrations directly in providers or lifecycle bodies; add them to the matching command file (`terminalCommands.ts` or `syncCommands.ts`) and pass dependencies through `getCommandDependencies()` / the sync service registry.
- `getCommandDependencies()` intentionally exposes getters so commands see current provider/service references after activation changes.
- File-reference commands send to `deps.sendPrompt()`, so they follow the active instance/session selected by `SessionRuntime` rather than manually choosing a terminal.
- `terminalCommands.ts` registers the legacy `ai-sidebar-terminal.*` aliases only when the pre-rebrand extension is absent. If both extensions run, the second registration throws `command 'ai-sidebar-terminal.start' already exists` and activation fails.

## Verification

- Focused command tests live in `src/core/commands/terminalCommands.test.ts` and `src/core/commands/syncCommands.test.ts`.
- Core lifecycle tests live beside the file as `ExtensionLifecycle.test.ts`.
