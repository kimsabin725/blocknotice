import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnAnvil } from "../src/anvil.js";
import {
  assertWritableRecordSlot,
  deriveServiceIds,
  parseDeployArgs,
  type EscrowDeploymentFile,
} from "../src/escrow-deployment.js";
import { DEFAULT_LOCAL_DEPLOYER_KEY, deployEscrow, selectDeployerKey } from "../src/deploy-escrow.js";
import { checkEscrowDeployments } from "../src/check-escrow-deployment.js";

const PORT = 8609;
const RPC = `http://127.0.0.1:${PORT}`;
let anvil: ChildProcess;
let tempDirectory: string;
let recordPath: string;

beforeAll(async () => {
  process.env.PATH = `${resolve("..", ".tools", "foundry")}${delimiter}${process.env.PATH ?? ""}`;
  anvil = spawnAnvil(PORT);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) break;
    } catch {}
    await new Promise(resolveReady => setTimeout(resolveReady, 100));
  }
  tempDirectory = mkdtempSync(join(tmpdir(), "blocknotice-escrow-deployment-"));
  recordPath = join(tempDirectory, "escrow-deployments.json");
}, 30_000);

afterAll(() => {
  anvil?.kill();
  if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
});

describe("escrow deployment safety", () => {
  it("requires an explicit network and parses an explicit record path", () => {
    expect(() => parseDeployArgs([])).toThrow(/explicit network/i);
    expect(parseDeployArgs(["hoodi", "--record", "fresh.json"])).toEqual({
      network: "hoodi",
      recordPath: "fresh.json",
    });
  });

  it("uses the known development key only after observing chain ID 31337", () => {
    expect(selectDeployerKey("local", 31337, {})).toBe(DEFAULT_LOCAL_DEPLOYER_KEY);
    expect(() => selectDeployerKey("local", 31338, {})).toThrow(/refusing.*development key/i);
    expect(() => selectDeployerKey("hoodi", 560048, {})).toThrow(/DEPLOYER_KEY/);
  });

  it("derives stable, role-distinct service IDs from the journal namespace", () => {
    const ids = deriveServiceIds(`0x${"11".repeat(32)}`);
    expect(ids.operator).toBe("0x5bafbd4a144d8d9d07c5434381d2e9be5e7e0d32d6e3881fa081d2425141859e");
    expect(ids.courier).toBe("0x69d34c65cfd1e02f1faef7118b4635afd68591275c5c528a0ce8d159a8a481e0");
    expect(ids.exchange).toBe("0xa8bdb00cd10b5c2538dc75779cd393386f07404d42e9a5c277d5eac6c4e5e76c");
  });

  it("rejects a completed record collision instead of overwriting it", () => {
    expect(() => assertWritableRecordSlot({ local: { status: "complete" } }, "local", "escrow-deployments.json"))
      .toThrow(/already contains a complete local deployment/i);
  });
});

describe("local escrow deployment", () => {
  it("journals a real deployment and the read-only checker verifies it exactly", async () => {
    const record = await deployEscrow({ network: "local", rpcUrl: RPC, recordPath });

    expect(record.status).toBe("complete");
    expect(record.chainId).toBe(31337);
    expect(record.demoMode.permissionlessMinting).toBe(true);
    expect(record.services.operator.serviceId).not.toBe(record.services.courier.serviceId);
    expect(record.services.exchange.serviceId).not.toBe(record.services.operator.serviceId);
    expect(record.services.exchange.serviceId).not.toBe(record.services.courier.serviceId);
    expect(record.services.commonControl).toBe(true);
    expect(record.transactions.escrow.status).toBe("confirmed");
    expect(record.transactions.inbox.status).toBe("confirmed");
    expect(record.inboxProfile.forwardBlocks).toBe(20);
    expect(record.inboxProfile.responseBlocks).toBe(30);
    expect(record.contracts.inbox.runtimeCodeHash).toMatch(/^0x[0-9a-f]{64}$/);

    const checked = await checkEscrowDeployments({ network: "local", rpcUrl: RPC, recordPath });
    expect(checked.failures).toEqual([]);
    expect(checked.checked).toBeGreaterThan(20);

    await expect(deployEscrow({ network: "local", rpcUrl: RPC, recordPath }))
      .rejects.toThrow(/already contains a complete local deployment/i);
  }, 120_000);

  it("reports an exact runtime-code hash mismatch without writing the record", async () => {
    const before = readFileSync(recordPath, "utf8");
    const file = JSON.parse(before) as EscrowDeploymentFile;
    file.local!.contracts.escrow!.runtimeCodeHash = `0x${"00".repeat(32)}`;
    file.local!.contracts.inbox!.runtimeCodeHash = `0x${"00".repeat(32)}`;
    const tamperedPath = join(tempDirectory, "tampered.json");
    writeFileSync(tamperedPath, `${JSON.stringify(file, null, 2)}\n`);

    const checked = await checkEscrowDeployments({ network: "local", rpcUrl: RPC, recordPath: tamperedPath });
    expect(checked.failures.some(failure => failure.label === "escrow runtime code hash")).toBe(true);
    expect(checked.failures.some(failure => failure.label === "inbox runtime code hash")).toBe(true);
    expect(readFileSync(recordPath, "utf8")).toBe(before);
  }, 60_000);
});
