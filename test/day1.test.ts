// Day-1 test set: everything that is checkable before the contract exists (spec 04 §13 cases 1–6, 10–12 partly).
// Each test states the expected verdict, not just "throws".
import { describe, it, expect } from "vitest";
import { keccak256, type Hex } from "viem";
import { runCase, INPUTS, SANCTIONED } from "../src/scenario.js";
import { verifyBundle } from "../src/verify.js";
import { IncrementalTree, verifyInclusion, rootOf, DEPTH } from "../src/merkle.js";
import { leafHash, recordDigest, decisionDigest, requestCommitment } from "../src/encode.js";
import { LeafType, Outcome } from "../src/types.js";
import { newSigner, salt32, seal, utf8 } from "../src/crypto.js";
import { Institution, localClock } from "../src/institution.js";
import { Requester } from "../src/requester.js";
import { DEMO_PROFILE } from "../src/profile.js";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x, (_k, v) => typeof v === "bigint" ? `${v}n` : v),
  (_k, v) => typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
const unmet = (r: Awaited<ReturnType<typeof verifyBundle>>) => r.checks.filter(c => c.status === "OBLIGATION_UNMET").map(c => c.id);

describe("policy fixture produces all three outcomes from the same shape", () => {
  it.each([["clean", Outcome.ALLOW], ["screening", Outcome.DENY], ["review", Outcome.DEFER], ["limit", Outcome.DENY]] as const)(
    "%s → %s", async (name, expected) => {
      const { bundle } = await runCase({ inputs: name });
      expect(bundle.decisions.at(-1)!.record.outcome).toBe(expected);
    });
});

describe("case 1 — honest bundle verifies with the institution gone", () => {
  it("no unmet obligations, no institution network calls", async () => {
    const { bundle, inst } = await runCase({ inputs: "screening", ack: true });
    const log = { treeId: inst.tree.treeId, root: inst.tree.root(), size: inst.tree.size };   // observed independently
    const r = await verifyBundle(bundle, { publicLog: log });
    expect(unmet(r)).toEqual([]);
    expect(r.anchorState).toBe("ANCHORED");
    expect(r.institutionNetworkCalls).toBe(0);
    expect(r.outcome).toBe("DENY");
  });
  it("without an observed root, inclusion is UNVERIFIABLE rather than confirmed or failed", async () => {
    const { bundle } = await runCase({ inputs: "screening" });
    const r = await verifyBundle(bundle);
    expect(unmet(r)).toEqual([]);
    expect(r.checks.find(c => c.id === "log.requestLeaf")!.status).toBe("UNVERIFIABLE");
    expect(r.anchorState).toBe("SIGNED_PENDING_ANCHOR");
  });
});

describe("case 2 — one byte changed in the decision", () => {
  it("notice text edit breaks the institution signature", async () => {
    const { bundle } = await runCase({ inputs: "screening" });
    const b = clone(bundle); b.decisions[0].record.noticeText += " ";
    expect(unmet(await verifyBundle(b))).toContain("decision[0].signature");
  });
  it("private reason commitment swap breaks the signature", async () => {
    const { bundle } = await runCase({ inputs: "screening" });
    const b = clone(bundle); b.decisions[0].record.privateReasonCommitment = salt32();
    expect(unmet(await verifyBundle(b))).toContain("decision[0].signature");
  });
  it("request body edit breaks the commitment the requester signed", async () => {
    const { bundle } = await runCase({ inputs: "screening" });
    const b = clone(bundle); b.requestEnvelope.amount = "1";
    expect(unmet(await verifyBundle(b))).toContain("request.commitment");
  });
});

describe("case 3 — another requester's receipt", () => {
  it("decision from a different case is not bound to this acceptance", async () => {
    const a = await runCase({ inputs: "screening" });
    const c = await runCase({ inputs: "limit" });
    const b = clone(a.bundle); b.decisions = clone(c.bundle.decisions);
    const ids = unmet(await verifyBundle(b));
    expect(ids).toContain("decision[0].binding");
  });
  it("acceptance lifted from another request fails the binding check", async () => {
    const a = await runCase({ inputs: "screening" });
    const c = await runCase({ inputs: "clean" });
    const b = clone(a.bundle);
    b.acceptedReceipt = clone(c.bundle.acceptedReceipt); b.acceptedReceiptSignature = c.bundle.acceptedReceiptSignature;
    b.institutionSigner = c.bundle.institutionSigner;
    expect(unmet(await verifyBundle(b))).toContain("accepted.binding");
  });
});

describe("case 4 — signature reuse across chain/contract/service", () => {
  it("changing chainId in the presented profile invalidates every signature", async () => {
    const { bundle } = await runCase({ inputs: "screening" });
    const b = clone(bundle); b.profile.chainId = 1;
    const ids = unmet(await verifyBundle(b));
    expect(ids).toEqual(expect.arrayContaining(["request.signature", "accepted.signature", "decision[0].signature"]));
  });
  it("changing verifyingContract invalidates them too", async () => {
    const { bundle } = await runCase({ inputs: "screening" });
    const b = clone(bundle); b.profile.verifyingContract = "0x00000000000000000000000000000000000000ff";
    expect(unmet(await verifyBundle(b))).toContain("request.signature");
  });
  it("deadline fields cannot be restated without breaking the pinned profile hash", async () => {
    const { bundle } = await runCase({ inputs: "screening" });
    const b = clone(bundle); b.profile.decisionRecordDueBlocks = 9999;
    expect(unmet(await verifyBundle(b))).toContain("accepted.profile");
  });
});

describe("case 5 — nonce and requestId reuse are refused at acceptance", () => {
  it("the same signed request cannot be accepted twice", async () => {
    const clock = localClock();
    const inst = await Institution.create(DEMO_PROFILE, newSigner(), clock);
    const req = await Requester.create(newSigner());
    const built = await req.buildRequest(inst.profile, { requestType: "WITHDRAWAL", asset: "USDT", amount: "10", destination: "0xabc" }, inst.hpke.publicKey, clock.block());
    await inst.accept(built.request, built.signature, built.sealedEnvelope, req.hpke.publicKey);
    await expect(inst.accept(built.request, built.signature, built.sealedEnvelope, req.hpke.publicKey)).rejects.toThrow(/duplicate/);
  });
  it("an envelope that does not match the signed commitment is refused", async () => {
    const clock = localClock();
    const inst = await Institution.create(DEMO_PROFILE, newSigner(), clock);
    const req = await Requester.create(newSigner());
    const built = await req.buildRequest(inst.profile, { requestType: "WITHDRAWAL", asset: "USDT", amount: "10", destination: "0xabc" }, inst.hpke.publicKey, clock.block());
    const other = await seal(inst.hpke.publicKey, utf8.enc(JSON.stringify({ ...built.envelope, amount: "999" })), built.request.requestId);
    await expect(inst.accept(built.request, built.signature, other, req.hpke.publicKey)).rejects.toThrow(/commitment/);
  });
  it("an expired request is refused", async () => {
    const clock = localClock();
    const inst = await Institution.create(DEMO_PROFILE, newSigner(), clock);
    const req = await Requester.create(newSigner());
    const built = await req.buildRequest(inst.profile, { requestType: "WITHDRAWAL", asset: "USDT", amount: "10", destination: "0xabc" }, inst.hpke.publicKey, clock.block(), 5n);
    clock.advance(10n);
    await expect(inst.accept(built.request, built.signature, built.sealedEnvelope, req.hpke.publicKey)).rejects.toThrow(/expired/);
  });
});

describe("case 6 — log structure", () => {
  it("inclusion proofs verify for every leaf and reject a wrong index", () => {
    const t = new IncrementalTree(keccak256("0x01"));
    const leaves = Array.from({ length: 7 }, (_, i) => leafHash(recordDigest(LeafType.REQ, keccak256(`0x0${i + 1}`))));
    leaves.forEach(l => t.append(l));
    leaves.forEach((l, i) => expect(verifyInclusion(l, t.proof(i))).toBe(true));
    const p = t.proof(3);
    expect(verifyInclusion(leaves[4], p)).toBe(false);
    expect(verifyInclusion(leaves[3], { ...p, index: 4 })).toBe(false);
    expect(verifyInclusion(leaves[3], { ...p, size: 3 })).toBe(false);          // index beyond claimed size
    expect(verifyInclusion(leaves[3], { ...p, siblings: p.siblings.slice(0, DEPTH - 1) })).toBe(false);
  });
  it("removing or reordering a past leaf changes the root", () => {
    const leaves = Array.from({ length: 5 }, (_, i) => leafHash(recordDigest(LeafType.DEC, keccak256(`0x0${i + 1}`))));
    const root = rootOf(leaves);
    expect(rootOf(leaves.filter((_, i) => i !== 2))).not.toBe(root);
    const swapped = leaves.slice(); [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    expect(rootOf(swapped)).not.toBe(root);
    expect(rootOf(leaves.concat(leafHash(recordDigest(LeafType.ACK, keccak256("0x99")))))).not.toBe(root);  // append-only changes root
  });
  it("a REQ leaf cannot be presented as a DEC leaf", async () => {
    const { bundle, inst } = await runCase({ inputs: "screening" });
    const log = { treeId: inst.tree.treeId, root: inst.tree.root(), size: inst.tree.size };
    const b = clone(bundle); b.decisions[0].proof = clone(bundle.requestLeafProof!);
    expect(unmet(await verifyBundle(b, { publicLog: log }))).toContain("log.decisionLeaf[0]");
  });
  it("a proof against a foreign tree is rejected", async () => {
    const { bundle, inst } = await runCase({ inputs: "screening" });
    const r = await verifyBundle(bundle, { publicLog: { treeId: keccak256("0xdead"), root: inst.tree.root(), size: inst.tree.size } });
    expect(unmet(r)).toContain("log.requestLeaf");
  });
  it("a proof claiming a size beyond the observed log is rejected", async () => {
    const { bundle, inst } = await runCase({ inputs: "screening" });
    const r = await verifyBundle(bundle, { publicLog: { treeId: inst.tree.treeId, root: inst.tree.root(), size: 1 } });
    expect(unmet(r)).toContain("log.decisionLeaf[0]");
  });
});

describe("case 7 (pre-contract part) — acceptance signed, decision never logged", () => {
  it("missing decision before the deadline is NOT_DUE, after it is OBLIGATION_UNMET", async () => {
    const { bundle, inst } = await runCase({ inputs: "screening", decide: false });
    const due = bundle.acceptedReceipt.decisionRecordDueBlock;
    const early = await verifyBundle(bundle, { currentBlock: due - 1n });
    expect(early.checks.find(c => c.id === "decision.presence")!.status).toBe("NOT_DUE");
    const late = await verifyBundle(bundle, { currentBlock: due + 1n });
    expect(unmet(late)).toContain("decision.presence");
  });
  it("a decision kept out of the log is UNVERIFIABLE, and its absence from an observed log is unmet", async () => {
    const { bundle, inst } = await runCase({ inputs: "screening", knobs: { skipDecisionLeaf: true } });
    expect(bundle.decisions[0].proof).toBeUndefined();
    const r = await verifyBundle(bundle, { publicLog: { treeId: inst.tree.treeId, root: inst.tree.root(), size: inst.tree.size } });
    expect(r.checks.find(c => c.id === "log.decisionLeaf[0]")!.status).toBe("UNVERIFIABLE");
    expect(r.anchorState).toBe("MIXED");
  });
});

describe("case 11 — ACK is receipt, not comprehension; its absence is not a violation", () => {
  it("no ACK → UNVERIFIABLE, not unmet", async () => {
    const { bundle } = await runCase({ inputs: "screening" });
    const r = await verifyBundle(bundle);
    expect(r.checks.find(c => c.id === "ack.presence")!.status).toBe("UNVERIFIABLE");
    expect(unmet(r)).toEqual([]);
  });
  it("an ACK bound to a different decision is rejected", async () => {
    const a = await runCase({ inputs: "screening", ack: true });
    const c = await runCase({ inputs: "clean", ack: true });
    const b = clone(a.bundle); b.ack = clone(c.bundle.ack!);
    expect(unmet(await verifyBundle(b))).toContain("ack.signature");
  });
});

describe("case 12 — encrypted delivery is separate from content verification", () => {
  it("the requester rejects a decision whose signature does not verify", async () => {
    const clock = localClock();
    const inst = await Institution.create(DEMO_PROFILE, newSigner(), clock);
    const req = await Requester.create(newSigner());
    const built = await req.buildRequest(inst.profile, { requestType: "WITHDRAWAL", asset: "USDT", amount: "10", destination: SANCTIONED }, inst.hpke.publicKey, clock.block());
    await inst.accept(built.request, built.signature, built.sealedEnvelope, req.hpke.publicKey);
    const { sealed } = await inst.decide(built.request.requestId, INPUTS.screening);
    await expect(req.receive(inst.profile, sealed, newSigner().address)).rejects.toThrow(/signature invalid/);  // wrong claimed signer
  });
  it("garbage ciphertext fails to open rather than being treated as delivered", async () => {
    const clock = localClock();
    const inst = await Institution.create(DEMO_PROFILE, newSigner(), clock);
    const req = await Requester.create(newSigner());
    const built = await req.buildRequest(inst.profile, { requestType: "WITHDRAWAL", asset: "USDT", amount: "10", destination: SANCTIONED }, inst.hpke.publicKey, clock.block());
    await inst.accept(built.request, built.signature, built.sealedEnvelope, req.hpke.publicKey);
    const { sealed } = await inst.decide(built.request.requestId, INPUTS.screening);
    await expect(req.receive(inst.profile, { ...sealed, ct: sealed.ct.slice(0, -2) + "ff" as Hex }, inst.address)).rejects.toThrow();
  });
});

describe("policy re-execution only speaks about declared inputs", () => {
  it("a decision whose declared inputs contradict the outcome is caught", async () => {
    const { bundle } = await runCase({ inputs: "screening" });
    const b = clone(bundle);
    (b.publicInputs as any).inputs.sanctioned = [];          // claim the destination was never listed
    expect(unmet(await verifyBundle(b))).toContain("policy.inputs");
  });
  it("without public inputs, re-execution is OUT_OF_SCOPE", async () => {
    const { inst, requestId } = await runCase({ inputs: "screening" });
    const r = await verifyBundle(inst.bundle(requestId, false));
    expect(r.checks.find(c => c.id === "policy.rerun")!.status).toBe("OUT_OF_SCOPE");
  });
});

describe("private reason reveal", () => {
  it("the reveal material matches the commitment and is not in the user bundle", async () => {
    const { inst, requestId, bundle } = await runCase({ inputs: "screening" });
    const reason = inst.openReason(requestId, 0);
    const { privateReasonCommitment } = await import("../src/encode.js");
    expect(privateReasonCommitment(reason)).toBe(bundle.decisions[0].record.privateReasonCommitment);
    const { bigintReplacer } = await import("../src/institution.js");
    const serialised = JSON.stringify(bundle, bigintReplacer);
    expect(serialised).not.toContain(reason.salt);
    expect(serialised).not.toContain(reason.detail);
  });
  it("a substituted reason no longer matches the commitment", async () => {
    const { inst, requestId, bundle } = await runCase({ inputs: "screening" });
    const reason = { ...inst.openReason(requestId, 0), detail: "다른 사유" };
    const { privateReasonCommitment } = await import("../src/encode.js");
    expect(privateReasonCommitment(reason)).not.toBe(bundle.decisions[0].record.privateReasonCommitment);
  });
});
