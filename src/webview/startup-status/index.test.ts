// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyStartupPhase,
  initStartupStatus,
  resetStartupStatus,
} from "./index";

function mount(): HTMLElement {
  const container = document.createElement("div");
  container.id = "terminal-container";
  document.body.appendChild(container);
  return container;
}

beforeEach(() => {
  resetStartupStatus();
  document.body.innerHTML = "";
  delete (window as unknown as { __OC_STARTUP_L10N__?: unknown })
    .__OC_STARTUP_L10N__;
});

afterEach(() => {
  resetStartupStatus();
  document.body.innerHTML = "";
});

describe("startup status indicator", () => {
  it("mounts hidden until a phase arrives", () => {
    initStartupStatus(mount());

    const root = document.querySelector(".startup-status");
    expect(root).not.toBeNull();
    expect(root?.classList.contains("hidden")).toBe(true);
  });

  it("shows the waiting copy while the service starts", () => {
    initStartupStatus(mount());

    applyStartupPhase("starting");

    const root = document.querySelector(".startup-status") as HTMLElement;
    expect(root.classList.contains("hidden")).toBe(false);
    expect(root.dataset.phase).toBe("starting");
    expect(root.getAttribute("role")).toBe("status");
    expect(
      root.querySelector(".startup-status-text")?.textContent,
    ).toContain("Waiting");
  });

  it("hides and clears on idle", () => {
    initStartupStatus(mount());

    applyStartupPhase("starting");
    applyStartupPhase("idle");

    const root = document.querySelector(".startup-status") as HTMLElement;
    expect(root.classList.contains("hidden")).toBe(true);
    expect(root.dataset.phase).toBeUndefined();
    expect(root.querySelector(".startup-status-text")?.textContent).toBe("");
  });

  it("uses the injected translations", () => {
    (window as unknown as { __OC_STARTUP_L10N__?: Record<string, string> })
      .__OC_STARTUP_L10N__ = {
      starting: "wait-copy",
      aria: "aria-copy",
    };
    initStartupStatus(mount());

    applyStartupPhase("starting");

    const root = document.querySelector(".startup-status") as HTMLElement;
    expect(root.querySelector(".startup-status-text")?.textContent).toBe(
      "wait-copy",
    );
    expect(root.getAttribute("aria-label")).toBe("aria-copy");
  });

  it("remembers the phase across a re-init and does not duplicate nodes", () => {
    const container = mount();
    initStartupStatus(container);
    applyStartupPhase("starting");

    initStartupStatus(container);
    initStartupStatus(container);

    expect(document.querySelectorAll(".startup-status")).toHaveLength(1);
    const root = document.querySelector(".startup-status") as HTMLElement;
    expect(root.classList.contains("hidden")).toBe(false);
    expect(root.dataset.phase).toBe("starting");
  });
});
