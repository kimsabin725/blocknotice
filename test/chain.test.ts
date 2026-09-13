// Day-2 integration: the public log is a contract, and the verifier rebuilds it from events only.
// Every assertion here is about what a third party can establish with no access to the institution.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { keccak256, type Hex } from "viem";
import { connect, deployLog, registerService, anchorPending, reconstructLog, chainClock, mine,
  challengeAccepted, respond, finalize, readChallenge, readService, postNotice, anvilChain, type ChainCtx } from "../src/chain.js";
import { runCase } from "../src/scenario.js";
import { DEMO_PROFILE } from "../src/profile.js";
import { profileHash, acceptedReceiptDigest, decisionDigest, recordDigest, leafHash } from "../src/encode.js";
import { LeafType, type ProtocolProfile } from "../src/types.js";
import { verifyBundle } from "../src/verify.js";

const PORT = 8599;
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
// anvil's first deterministic account; a throwaway key that only ever touches a local dev chain.
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

let anvil: ChildProcess;
let c: ChainCtx;
let profile: Omit<ProtocolProfile, "institutionKeyId">;

const encodeStruct = (o: Record<string, unknown>) => o; // viem maps named fields onto the ABI tuple

beforeAll(async () => {
  anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  const chain = anvilChain(CHAIN_ID, RPC);
  for (let i = 0; i < 100; i++) {
    try { const t = await connect(RPC, chain, DEPLOYER); await t.pub.getBlockNumber(); break; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  const base = await connect(RPC, chain, DEPLOYER);
  const address = await deployLog(base);
  c = { ...base, address };
  profile = { ...DEMO_PROFILE, chainId: CHAIN_ID, verifyingContract: address };
}, 60_000);

afterAll(() => { anvil?.kill(); });

async function freshCase(opts: Parameters<typeof runCase>[0] = {}) {
  const clock = await chainClock(c.pub);
  // Each case gets its own serviceId so registrations never collide inside one deployment.
  const serviceId = keccak256(`0x${Date.now().toString(16)}${Math.floor(Math.random() * 1e9).toString(16)}` as Hex).slice(0, 66) as Hex;
  const p = { ...profile, serviceId };
  const r = await runCase({ ...opts, profile: p, clock });
  await registerService(c, serviceId, r.inst.address, profileHash(r.inst.profile), p.challengeResponseBlocks);
  return { ...r, serviceId, clock };
}

describe("public log contract", () => {
  it("the root the contract computes equals the tree rebuilt from its events alone", async () => {
    const { inst, serviceId } = await freshCase();
    await anchorPending(c, serviceId, inst.tree.leaves, 0);
    const rec = await reconstructLog(c, serviceId);
    expect(rec.agrees).toBe(true);
    expect(rec.size).toBe(inst.tree.leaves.length);
    // and it equals what the institution computed locally, independently
    expect(rec.root.toLowerCase()).toBe(inst.tree.root().toLowerCase());
  }, 60_000);

  it("a bundle verifies as ANCHORED against the independently rebuilt root", async () => {
    const { inst, bundle, serviceId, clock } = await freshCase();
    await anchorPending(c, serviceId, inst.tree.leaves, 0);
    const rec = await reconstructLog(c, serviceId);
    const svc = await readService(c, serviceId);
    const report = await verifyBundle(bundle, {
      publicLog: { treeId: rec.treeId, root: rec.root, size: rec.size },
      currentBlock: await clock.sync(),
      registry: { serviceId, signer: svc.signer, profileHash: svc.profileHash, treeId: svc.treeId, chainId: CHAIN_ID, verifyingContract: c.address },
    });
    expect(report.anchorState).toBe("ANCHORED");
    expect(report.summary.OBLIGATION_UNMET).toBe(0);
    expect(report.institutionNetworkCalls).toBe(0);
    expect(report.checks.find(k => k.id === "log.decisionLeaf[0]")?.status).toBe("CONFIRMED");
  }, 60_000);

  it("a decision that was never anchored is UNVERIFIABLE, not silently CONFIRMED", async () => {
    const { inst, bundle, serviceId } = await freshCase({ knobs: { skipDecisionLeaf: true } });
    await anchorPending(c, serviceId, inst.tree.leaves, 0);
    const rec = await reconstructLog(c, serviceId);
    const report = await verifyBundle(bundle, { publicLog: { treeId: rec.treeId, root: rec.root, size: rec.size } });
    expect(report.anchorState).not.toBe("ANCHORED");
    expect(report.checks.find(k => k.id === "log.decisionLeaf[0]")?.status).toBe("UNVERIFIABLE");
  }, 60_000);

  it("a proof carrying a foreign root is rejected against the observed log", async () => {
    const { inst, bundle, serviceId } = await freshCase();
    await anchorPending(c, serviceId, inst.tree.leaves, 0);
    const rec = await reconstructLog(c, serviceId);
    const report = await verifyBundle(bundle, {
      publicLog: { treeId: rec.treeId, root: keccak256("0xdeadbeef"), size: rec.size },
    });
    expect(report.summary.OBLIGATION_UNMET).toBeGreaterThan(0);
  }, 60_000);
});

describe("trust anchor", () => {
  it("a bundle forged end to end in the attacker's own domain is OUT_OF_SCOPE, never CONFIRMED", async () => {
    const { serviceId } = await freshCase();                       // the registered, honest service
    const svc = await readService(c, serviceId);
    // An attacker issues a fully self-consistent bundle with their own key and their own domain.
    const forged = await runCase({ profile: { ...profile, chainId: 999999, verifyingContract: "0x000000000000000000000000000000000000dEaD" } });
    const report = await verifyBundle(forged.bundle, {
      registry: { serviceId, signer: svc.signer, profileHash: svc.profileHash, treeId: svc.treeId, chainId: CHAIN_ID, verifyingContract: c.address },
    });
    expect(report.outcome).toBe("OUT_OF_SCOPE");
    expect(report.summary.CONFIRMED).toBe(0);
    expect(report.summary.OBLIGATION_UNMET).toBe(0);   // an unrelated bundle is not an accusation
  }, 60_000);

  it("without a registration the verifier says so instead of claiming confirmation", async () => {
    const { bundle } = await freshCase();
    const report = await verifyBundle(bundle);
    expect(report.checks.find(k => k.id === "registry.binding")?.status).toBe("UNVERIFIABLE");
  }, 60_000);
});

describe("accountability paths", () => {
  it("an accepted request with no decision ends as an on-chain UNANSWERED verdict", async () => {
    const { inst, bundle, serviceId, clock } = await freshCase({ decide: false });
    await anchorPending(c, serviceId, inst.tree.leaves, 0);
    await mine(c.pub, profile.decisionRecordDueBlocks + 1);
    await clock.sync();

    const acceptedDigest = acceptedReceiptDigest(inst.profile, bundle.acceptedReceipt);
    await challengeAccepted(c, encodeStruct(bundle.acceptedReceipt as any), bundle.acceptedReceiptSignature);
    const challengeId = keccak256(`0x${serviceId.slice(2)}${acceptedDigest.slice(2)}` as Hex);
    expect((await readChallenge(c, challengeId)).state).toBe(1); // OPEN

    await mine(c.pub, profile.challengeResponseBlocks + 1);
    await finalize(c, challengeId);
    expect((await readChallenge(c, challengeId)).state).toBe(3); // UNANSWERED
  }, 90_000);

  it("an institution that did record the decision answers the challenge with an inclusion proof", async () => {
    const { inst, bundle, serviceId, clock } = await freshCase();
    await anchorPending(c, serviceId, inst.tree.leaves, 0);
    await mine(c.pub, profile.decisionRecordDueBlocks + 1);
    await clock.sync();

    const acceptedDigest = acceptedReceiptDigest(inst.profile, bundle.acceptedReceipt);
    await challengeAccepted(c, encodeStruct(bundle.acceptedReceipt as any), bundle.acceptedReceiptSignature);
    const challengeId = keccak256(`0x${serviceId.slice(2)}${acceptedDigest.slice(2)}` as Hex);

    const rec = await reconstructLog(c, serviceId);
    const leaf = leafHash(recordDigest(LeafType.DEC, decisionDigest(inst.profile, bundle.decisions[0].record)));
    const index = rec.leaves.findIndex(l => l.toLowerCase() === leaf.toLowerCase());
    expect(index).toBeGreaterThanOrEqual(0);
    const proof = rec.proofFor(index);
    await respond(c, challengeId, leaf, index, rec.root, proof.siblings);

    const ch = await readChallenge(c, challengeId);
    expect(ch.state).toBe(2); // ANSWERED
    expect(ch.answeredLeaf.toLowerCase()).toBe(leaf.toLowerCase());
  }, 90_000);

  it("a requester with no receipt can still leave a neutral public notice", async () => {
    const clock = await chainClock(c.pub);
    const serviceId = keccak256(`0x${Date.now().toString(16)}aa` as Hex).slice(0, 66) as Hex;
    const p = { ...profile, serviceId };
    const r = await runCase({ profile: p, clock, decide: false });
    await registerService(c, serviceId, r.inst.address, profileHash(r.inst.profile), p.challengeResponseBlocks);
    const receipt = await postNotice(c, encodeStruct(r.bundle.request as any), r.bundle.requesterSignature);
    expect(receipt.status).toBe("success");
  }, 90_000);
});
