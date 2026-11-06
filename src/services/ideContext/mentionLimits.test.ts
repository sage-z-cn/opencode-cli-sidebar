import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import {
  isAttachmentOversize,
  MAX_ATTACHMENT_BYTES,
} from "./mentionLimits";

vi.mock("fs", () => ({
  statSync: vi.fn(),
}));

function mockStat(size: number, isDirectory = false): void {
  vi.mocked(fs.statSync).mockReturnValue({
    size,
    isDirectory: () => isDirectory,
  } as never);
}

describe("mentionLimits", () => {
  afterEach(() => {
    vi.mocked(fs.statSync).mockReset();
  });

  it("mirrors OpenCode's 20 MiB per-attachment ceiling", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024);
  });

  it("rejects files above the attachment limit", () => {
    mockStat(MAX_ATTACHMENT_BYTES + 1);

    expect(isAttachmentOversize("/workspace/huge.log")).toBe(true);
  });

  it("accepts files at exactly the limit", () => {
    mockStat(MAX_ATTACHMENT_BYTES);

    expect(isAttachmentOversize("/workspace/exact.log")).toBe(false);
  });

  it("accepts directories regardless of their reported size", () => {
    mockStat(MAX_ATTACHMENT_BYTES * 2, true);

    expect(isAttachmentOversize("/workspace/components")).toBe(false);
  });

  it("fails open when the path cannot be stat'ed", () => {
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(isAttachmentOversize("/workspace/missing.log")).toBe(false);
  });
});
