import type { StartupGateOutcome } from "./StartupCoordinator";

/**
 * Everything a launch does before the terminal is spawned.
 *
 * `StartupCoordinator` already serializes the shared v2 service start, and
 * the pre-launch config sync has to run after that decision (it needs to know
 * whether this window only attaches to a ready service) but before the
 * process reads the config directory. Bundling both behind one gate keeps
 * `SessionRuntime` from growing another positional constructor argument.
 */
export interface LaunchGate {
  /** Gate the shared v2 service start; absent means no coordination. */
  beforeStart?(): Promise<StartupGateOutcome>;
  /**
   * Bring the key config files up to date before OpenCode starts. Must never
   * throw and never block longer than its own budget; the launch always
   * continues.
   */
  beforeOpenCodeStart(outcome: StartupGateOutcome | "v1"): Promise<void>;
}
