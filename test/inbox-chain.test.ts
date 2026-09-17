import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { keccak256, type Hex } from "viem";
import { spawnAnvil } from "../src/anvil.js";
import { anvilChain, appendBatch, connect, deployLog, mine, readService, registerService, type ChainCtx } from "../src/chain.js";
import { deployEscrow, deployMockGold, mockGoldApprove, mockGoldMint } from "../src/escrow.js";
import {
  deployInbox, inboxChallenge, inboxFinalize, inboxForward, inboxProveRejection, inboxRejectionLeaf,
  inboxSubmit, INBOX_REQUEST_TYPES, proofForInboxRejection, type InboxRequest,
} from "../src/inbox.js";
import { verifyInbox } from "../src/inbox-verify.js";
import { IncrementalTree } from "../src/merkle.js";

const PORT = 8608, RPC = `http://127.0.0.1:${PORT}`, CHAIN_ID = 31337;
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const HOLDER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const OP = keccak256("0x01"), COURIER = keccak256("0x02"), EXCHANGE = keccak256("0x03"), PROFILE = keccak256("0x04");
let anvil: ChildProcess, logCtx: ChainCtx, inboxCtx: ChainCtx, holderInboxCtx: ChainCtx, exchangeTree: IncrementalTree;
let nonce = 0n;

beforeAll(async () => {
  anvil = spawnAnvil(PORT);
  const chain = anvilChain(CHAIN_ID, RPC);
  let base: Awaited<ReturnType<typeof connect>> | undefined;
  for (let i = 0; i < 100; i++) { try { base = await connect(RPC, chain, DEPLOYER); await base.pub.getBlockNumber(); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  if (!base) throw new Error("anvil did not start");
  const holder = await connect(RPC, chain, HOLDER_KEY);
  const log = await deployLog(base); logCtx = { ...base, address: log };
  for (const service of [OP, COURIER, EXCHANGE]) await registerService(logCtx, service, base.account.address, PROFILE, 30, 20, 20);
  exchangeTree = new IncrementalTree((await readService(logCtx, EXCHANGE)).treeId);
  const token = await deployMockGold(base);
  const escrow = await deployEscrow(base, { log, token, operatorServiceId: OP, courierServiceId: COURIER,
    decisionBlocks: 20n, handoffBlocks: 40n, courierBlocks: 60n, responseBlocks: 30n, disputeBlocks: 30n });
  const inbox = await deployInbox(base, log, escrow, 20n, 30n);
  inboxCtx = { ...base, address: inbox }; holderInboxCtx = { ...holder, address: inbox };
  const tokenCtx = { ...base, address: token };
  await mockGoldMint(tokenCtx, base.account.address, 10_000n);
  await mockGoldApprove(tokenCtx, inbox, 10_000n);
}, 90_000);
afterAll(() => { anvil?.kill(); });

async function submit(label: string) {
  const request: InboxRequest = { holder: holderInboxCtx.account.address, exchangeServiceId: EXCHANGE, amount: 100n,
    requestHash: keccak256(new TextEncoder().encode(label)), nonce: nonce++, expiresAtBlock: await inboxCtx.pub.getBlockNumber() + 1_000n };
  const signature = await holderInboxCtx.account.signTypedData({ domain: { name: "RedemptionInbox", version: "1", chainId: CHAIN_ID, verifyingContract: inboxCtx.address },
    types: INBOX_REQUEST_TYPES, primaryType: "Request", message: request });
  return inboxSubmit(inboxCtx, request, signature);
}

describe("public inbox observer", () => {
  it("replays atomic forwarding and optionally verifies the derived escrow lock", async () => {
    const { requestId } = await submit("forwarded");
    await inboxForward(inboxCtx, requestId);
    const report = await verifyInbox({ pub: inboxCtx.pub, address: inboxCtx.address }, requestId, { includeEscrow: true });
    expect(report.checks.find(c => c.id === "exchange.hop")?.status).toBe("CONFIRMED");
    expect(report.derivedEscrowLockId).toBeTruthy();
    expect(report.escrowReport?.state).toBe("LOCKED");
  }, 90_000);

  it("replays a rejection against the exchange Appended log", async () => {
    const { requestId } = await submit("rejected");
    const digest = keccak256("0xdead");
    const index = exchangeTree.append(inboxRejectionLeaf(requestId, digest));
    await appendBatch(logCtx, EXCHANGE, [exchangeTree.leaves[index]]);
    await inboxProveRejection(inboxCtx, requestId, digest, proofForInboxRejection(exchangeTree, index, requestId, digest));
    const report = await verifyInbox({ pub: inboxCtx.pub, address: inboxCtx.address }, requestId);
    expect(report.checks.find(c => c.id === "exchange.hop")?.status).toBe("CONFIRMED");
    expect(report.checks.find(c => c.id === "rejection.merits")?.status).toBe("OUT_OF_SCOPE");
  }, 90_000);

  it("establishes non-forwarding only after the holder's public challenge is unanswered", async () => {
    const { requestId } = await submit("unanswered");
    await mine(inboxCtx.pub, 21);
    await inboxChallenge(holderInboxCtx, requestId);
    await mine(inboxCtx.pub, 31);
    await inboxFinalize(inboxCtx, requestId);
    const report = await verifyInbox({ pub: inboxCtx.pub, address: inboxCtx.address }, requestId);
    expect(report.checks.find(c => c.id === "exchange.hop")?.status).toBe("OBLIGATION_UNMET");
    expect(report.checks.find(c => c.id === "operator.hop")?.status).toBe("NOT_DUE");
    expect(report.institutionNetworkCalls).toBe(0);
  }, 90_000);
});
