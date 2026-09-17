import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { findAnvil } from "../src/anvil.js";

it("finds the platform's Anvil executable on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "blocknotice-anvil-"));
  const executable = join(dir, process.platform === "win32" ? "anvil.exe" : "anvil");
  writeFileSync(executable, "");
  vi.stubEnv("PATH", dir);
  try {
    expect(findAnvil()).toBe(executable);
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
