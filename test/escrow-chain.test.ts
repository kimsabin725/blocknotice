import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { keccak256, type Hex } from "viem";
import { spawnAnvil } from "../src/anvil.js";
import {
  anvilChain, appendBatch, connect, deployLog, mine, readService, registerService, type ChainCtx,
} from "../src/chain.js";
import { IncrementalTree } from "../src/merkle.js";
import {
  deployEscrow,
  deployMockGold,
  escrowAcknowledge,
  escrowBurn,
  escrowChallenge,
  escrowDecisionDigest,
  escrowDeliveryDigest,
  escrowDeliveryKey,
  escrowDispute,
  escrowFinalize,
  escrowHandoffDigest,
  escrowHandoffKey,
  escrowLeaf,
  escrowLock,
  escrowProveDecision,
  escrowProveDelivery,
  escrowProveHandoff,
  mockGoldApprove,
  mockGoldMint,
  proofForEscrowRecord,
} from "../src/escrow.js";
import { observeEscrow, verifyEscrow, verifyEscrowObservation } from "../src/escrow-verify.js";

const PORT = 8607;
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const HOLDER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const OPERATOR = keccak256("0x0101");
const COURIER = keccak256("0x0202");
const ZEROISH = `0x${"42".repeat(32)}` as Hex;
const execFileAsync = promisify(execFile);

let anvil: ChildProcess;
let logCtx: ChainCtx;
let escrowCtx: ChainCtx;
let holderEscrowCtx: ChainCtx;
let tokenCtx: ChainCtx;
let holderTokenCtx: ChainCtx;
let operatorTree: IncrementalTree;
let courierTree: IncrementalTree;

beforeAll(async () => {
  anvil = spawnAnvil(PORT);
  const chain = anvilChain(CHAIN_ID, RPC);
  let base: Awaited<ReturnType<typeof connect>> | undefined;
  for (let i = 0; i < 100; i++) {
    try { base = await connect(RPC, chain, DEPLOYER); await base.pub.getBlockNumber(); break; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  if (!base) throw new Error("anvil did not start");
  const holder = await connect(RPC, chain, HOLDER);
  const logAddress = await deployLog(base);
  logCtx = { ...base, address: logAddress };
  await registerService(logCtx, OPERATOR, base.account.address, ZEROISH, 2, 2, 4);
  await registerService(logCtx, COURIER, base.account.address, ZEROISH, 2, 2, 4);
  operatorTree = new IncrementalTree((await readService(logCtx, OPERATOR)).treeId);
  courierTree = new IncrementalTree((await readService(logCtx, COURIER)).treeId);

  const token = await deployMockGold(base);
  const escrow = await deployEscrow(base, {
    log: logAddress, token, operatorServiceId: OPERATOR, courierServiceId: COURIER,
    decisionBlocks: 4n, handoffBlocks: 20n, courierBlocks: 4n, responseBlocks: 2n, disputeBlocks: 2n,
  });
  escrowCtx = { ...base, address: escrow };
  holderEscrowCtx = { ...holder, address: escrow };
  tokenCtx = { ...base, address: token };
  holderTokenCtx = { ...holder, address: token };
  await mockGoldMint(tokenCtx, holder.account.address, 10_000n);
  await mockGoldApprove(holderTokenCtx, escrow, 10_000n);
}, 90_000);

afterAll(() => { anvil?.kill(); });

async function appendRecord(tree: IncrementalTree, serviceId: Hex, key: Hex, digest: Hex) {
  const index = tree.append(escrowLeaf(key, digest));
  await appendBatch(logCtx, serviceId, [tree.leaves[index]]);
  return proofForEscrowRecord(tree, index, key, digest);
}

async function newLock(label: string) {
  return escrowLock(holderEscrowCtx, 100n, keccak256(new TextEncoder().encode(label)));
}

async function proveOperatorPath(lockId: Hex) {
  const decisionDigest = escrowDecisionDigest(0, ZEROISH, keccak256("0x9999"), keccak256("0xaaaa"));
  const decisionProof = await appendRecord(operatorTree, OPERATOR, lockId, decisionDigest);
  await escrowProveDecision(escrowCtx, lockId, decisionDigest, decisionProof);
  const handoffDigest = escrowHandoffDigest(COURIER, keccak256("0xbbbb"), keccak256("0xcccc"));
  const handoffProof = await appendRecord(operatorTree, OPERATOR, escrowHandoffKey(lockId), handoffDigest);
  await escrowProveHandoff(escrowCtx, lockId, handoffDigest, handoffProof);
}

async function proveDelivery(lockId: Hex) {
  const digest = escrowDeliveryDigest(keccak256("0xdddd"), keccak256("0xeeee"));
  const proof = await appendRecord(courierTree, COURIER, escrowDeliveryKey(lockId), digest);
  await escrowProveDelivery(escrowCtx, lockId, digest, proof);
}

describe("public escrow observer", () => {
  it("pins and replays delivery plus dispute without treating physical delivery or merits as public facts", async () => {
    const { lockId } = await newLock("delivered-disputed");
    await proveOperatorPath(lockId);
    await proveDelivery(lockId);
    await escrowDispute(holderEscrowCtx, lockId);

    const evidence = await observeEscrow({ pub: escrowCtx.pub, address: escrowCtx.address }, lockId);
    const report = verifyEscrowObservation(evidence);
    expect(report.state).toBe("DISPUTED");
    expect(report.checks.find(c => c.id === "operator.hop")?.status).toBe("CONFIRMED");
    expect(report.checks.find(c => c.id === "courier.hop")?.status).toBe("CONFIRMED");
    expect(report.checks.find(c => c.id === "delivery.physical")?.status).toBe("OUT_OF_SCOPE");
    expect(report.checks.find(c => c.id === "dispute.merits")?.status).toBe("OUT_OF_SCOPE");
    expect(report.publicRpcCalls).toBeGreaterThan(0);
    expect(report.institutionNetworkCalls).toBe(0);

    const { stdout } = await execFileAsync(process.execPath, [
      "node_modules/tsx/dist/cli.mjs", "src/cli.ts", "verify",
      "--escrow", escrowCtx.address, "--lock", lockId, "--rpc", RPC, "--json",
    ], { cwd: process.cwd() });
    const cliReport = JSON.parse(stdout, (_key, value) => typeof value === "string" && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value);
    expect(cliReport.lockId).toBe(lockId);
    expect(cliReport.checks.find((c: any) => c.id === "operator.hop")?.status).toBe("CONFIRMED");
  }, 90_000);

  it("establishes operator timeout only after ChallengeUnanswered", async () => {
    const { lockId } = await newLock("operator-timeout");
    await mine(escrowCtx.pub, 5);
    await escrowChallenge(holderEscrowCtx, lockId);
    await mine(escrowCtx.pub, 3);
    await escrowFinalize(escrowCtx, lockId);
    const report = await verifyEscrow({ pub: escrowCtx.pub, address: escrowCtx.address }, lockId);
    expect(report.checks.find(c => c.id === "operator.hop")?.status).toBe("OBLIGATION_UNMET");
    expect(report.checks.find(c => c.id === "courier.hop")?.status).toBe("NOT_DUE");
  }, 90_000);

  it("establishes courier timeout independently after a recorded operator handoff", async () => {
    const { lockId } = await newLock("courier-timeout");
    await proveOperatorPath(lockId);
    await mine(escrowCtx.pub, 5);
    await escrowChallenge(holderEscrowCtx, lockId);
    await mine(escrowCtx.pub, 3);
    await escrowFinalize(escrowCtx, lockId);
    const report = await verifyEscrow({ pub: escrowCtx.pub, address: escrowCtx.address }, lockId);
    expect(report.checks.find(c => c.id === "operator.hop")?.status).toBe("CONFIRMED");
    expect(report.checks.find(c => c.id === "courier.hop")?.status).toBe("OBLIGATION_UNMET");
  }, 90_000);

  it("replays both holder acknowledgement and permissionless post-window burn", async () => {
    const ack = await newLock("ack");
    await proveOperatorPath(ack.lockId);
    await proveDelivery(ack.lockId);
    await escrowAcknowledge(holderEscrowCtx, ack.lockId);
    expect((await verifyEscrow({ pub: escrowCtx.pub, address: escrowCtx.address }, ack.lockId)).state).toBe("BURNED");

    const timed = await newLock("timed-burn");
    await proveOperatorPath(timed.lockId);
    await proveDelivery(timed.lockId);
    await mine(escrowCtx.pub, 3);
    await escrowBurn(escrowCtx, timed.lockId);
    expect((await verifyEscrow({ pub: escrowCtx.pub, address: escrowCtx.address }, timed.lockId)).state).toBe("BURNED");
  }, 120_000);
});
