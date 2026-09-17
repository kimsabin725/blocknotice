// Starts a local anvil dev chain. Looks on PATH first, then in foundry's default install
// directory, so a shell that never sourced ~/.zshrc (CI runners, editors, bots) still works.
// A missing binary is a one-line install hint instead of a Node ENOENT stack trace.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";

export function findAnvil(): string | undefined {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  dirs.push(join(homedir(), ".foundry", "bin"));
  for (const d of dirs) {
    const p = join(d, process.platform === "win32" ? "anvil.exe" : "anvil");
    if (existsSync(p)) return p;
  }
  return undefined;
}

export function spawnAnvil(port: number): ChildProcess {
  const bin = findAnvil();
  if (!bin) {
    console.error(
      "anvil not found. Install Foundry (https://getfoundry.sh):\n" +
      "  curl -L https://foundry.paradigm.xyz | bash && foundryup\n" +
      "then make sure ~/.foundry/bin is on PATH (or set SCENARIO_RPC to an existing RPC).",
    );
    process.exit(2);
  }
  const child = spawn(bin, ["--port", String(port), "--silent"], { stdio: "ignore" });
  child.on("error", e => { console.error(`anvil failed to start: ${e.message}`); process.exit(2); });
  return child;
}
