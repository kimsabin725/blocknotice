// One command, every scene. Each scenario states what a third party should conclude BEFORE it runs,
// then runs against a real chain and compares. A scenario that "passes" because the verifier went
// quiet is a failure here: the expectation names the check id and the status it must carry.
//
// Usage: npm run scenarios [-- --keep] [-- --only <scenario id substring>]
import type { ChildProcess } from "node:child_process";
import { spawnAnvil } from "./anvil.js";
import { keccak256, type Hex, type Address } from "viem";
import {
  connect, deployLog, registerService, anchorPending, reconstructLog, chainClock, mine,
  challengeAccepted, respond, finalize, readChallenge, readService, postNotice, anvilChain, appendBatch, challengeOf, type ChainCtx,
} from "./chain.js";
import { runCase, INPUTS, writeJson } from "./scenario.js";
import { DEMO_PROFILE } from "./profile.js";
import { profileHash, acceptedReceiptDigest, decisionDigest, recordDigest, decisionRecordDigest, leafHash, challengeIdOf } from "./encode.js";
import { LeafType, type ProtocolProfile, type ReceiptBundle } from "./types.js";
import { verifyBundle, type VerifyReport } from "./verify.js";
import { signTyped, newSigner } from "./crypto.js";
import { bigintReplacer, bigintReviver, type Institution } from "./institution.js";
import { createEscrowScenarios } from "./escrow-scenarios.js";

const PORT = Number(process.env.SCENARIO_PORT ?? 8611);
const RPC = process.env.SCENARIO_RPC ?? `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
// anvil's first three deterministic accounts. These are the publicly known dev keys every Foundry
// user has; they only ever touch a throwaway local chain and hold nothing anywhere else.
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const REQUESTER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const STRANGER = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;

let c: ChainCtx, cReq: ChainCtx, cStranger: ChainCtx;
let base: Omit<ProtocolProfile, "institutionKeyId">;

/** What a scenario asserts. `expect` names check ids and the status each must carry. */
interface Expectation { [checkIdPrefix: string]: "CONFIRMED" | "NOT_DUE" | "OBLIGATION_UNMET" | "UNVERIFIABLE" | "OUT_OF_SCOPE"; }

export interface Scenario {
  id: string;
  kind: "attack" | "honest";
  /** Stated before the run: what an independent party should be able to conclude. */
  claim: string;
  run: () => Promise<{ report?: Pick<VerifyReport, "checks">; expect?: Expectation; assert?: () => void | Promise<void> }>;
}

const eqi = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Register a fresh service, let the institution observe its anchor, then run the case. */
async function fresh(opts: Parameters<typeof runCase>[0] = {}) {
  const clock = await chainClock(c.pub);
  const serviceId = keccak256(`0x${Date.now().toString(16)}${Math.floor(Math.random() * 1e9).toString(16)}` as Hex).slice(0, 66) as Hex;
  const p = { ...base, serviceId };
  const r = await runCase({
    ...opts, profile: p, clock, requesterPk: REQUESTER,
    onReady: async (inst: Institution) => {
      const rc = await registerService(
        c, serviceId, inst.address, profileHash(inst.profile),
        p.challengeResponseBlocks, p.requestRecordDueBlocks, p.decisionRecordDueBlocks,
      );
      const s = await readService(c, serviceId);
      inst.observeAnchor(s.root, rc.blockNumber);
    },
  });
  return { ...r, serviceId, clock, p };
}

/** The registration as read from the chain — never from the bundle. */
async function registryOf(serviceId: Hex) {
  const s = await readService(c, serviceId);
  return {
    serviceId, signer: s.signer as Address, profileHash: s.profileHash as Hex,
    treeId: s.treeId as Hex, chainId: CHAIN_ID, verifyingContract: c.address,
  };
}

/** Anchor everything the institution has, then describe the log as an outsider sees it. */
async function anchorAndObserve(serviceId: Hex, inst: Institution, alreadyAnchored = 0) {
  await anchorPending(c, serviceId, inst.tree.leaves, alreadyAnchored);
  const rec = await reconstructLog(c, serviceId);
  return { publicLog: { treeId: keccak256(serviceId), root: rec.root, size: rec.size }, rec };
}

async function verifyAsOutsider(b: ReceiptBundle, serviceId: Hex, inst: Institution, block?: bigint) {
  const { publicLog } = await anchorAndObserve(serviceId, inst);
  return verifyBundle(b, { publicLog, registry: await registryOf(serviceId), currentBlock: block ?? await c.pub.getBlockNumber({ cacheTime: 0 }) });
}

const SCENARIOS: Scenario[] = [
  // ------------------------------------------------------------------ honest
  {
    id: "honest.recorded",
    kind: "honest",
    claim: "a decision that was signed and anchored on time verifies end to end",
    run: async () => {
      const { inst, bundle, serviceId } = await fresh();
      return {
        report: await verifyAsOutsider(bundle, serviceId, inst),
        expect: { "request.signature": "CONFIRMED", "accepted.signature": "CONFIRMED", "log.requestLeaf": "CONFIRMED", "log.decisionLeaf[0]": "CONFIRMED" },
      };
    },
  },
  {
    id: "honest.notYetDue",
    kind: "honest",
    claim: "an accepted request still inside its window is NOT_DUE, never a violation",
    run: async () => {
      const { inst, bundle, serviceId } = await fresh({ decide: false });
      return {
        report: await verifyAsOutsider(bundle, serviceId, inst, await c.pub.getBlockNumber({ cacheTime: 0 })),
        expect: { "decision.presence": "NOT_DUE" },
      };
    },
  },
  {
    id: "honest.noAck",
    kind: "honest",
    claim: "a requester who never sent an ACK does not make the institution look guilty",
    run: async () => {
      const { inst, bundle, serviceId } = await fresh();
      return {
        report: await verifyAsOutsider(bundle, serviceId, inst),
        expect: { "ack.presence": "UNVERIFIABLE", "log.decisionLeaf[0]": "CONFIRMED" },
      };
    },
  },
  {
    id: "honest.ackBound",
    kind: "honest",
    claim: "an ACK the requester did sign is bound to a decision in the same bundle",
    run: async () => {
      const { inst, bundle, serviceId } = await fresh({ ack: true });
      return { report: await verifyAsOutsider(bundle, serviceId, inst), expect: { "ack.signature": "CONFIRMED" } };
    },
  },

  // ------------------------------------------------------------------ attacks on the record
  {
    id: "attack.omitRequestLeaf",
    kind: "attack",
    claim: "an acceptance the institution signed but never logged is caught by the requester's own receipt",
    run: async () => {
      const { inst, bundle, serviceId } = await fresh({ knobs: { skipRequestLeaf: true } });
      return { report: await verifyAsOutsider(bundle, serviceId, inst), expect: { "log.requestLeaf": "UNVERIFIABLE" } };
    },
  },
  {
    id: "attack.omitDecisionLeaf",
    kind: "attack",
    claim: "a decision that was signed but never anchored does not pass as recorded",
    run: async () => {
      const { inst, bundle, serviceId } = await fresh({ knobs: { skipDecisionLeaf: true } });
      return { report: await verifyAsOutsider(bundle, serviceId, inst), expect: { "log.decisionLeaf[0]": "UNVERIFIABLE" } };
    },
  },
  {
    id: "attack.tamperedNotice",
    kind: "attack",
    claim: "changing the notice text after the fact breaks the signature the requester holds",
    run: async () => {
      const { inst, bundle, serviceId } = await fresh();
      const tampered: ReceiptBundle = JSON.parse(JSON.stringify(bundle, bigintReplacer), bigintReviver);
      tampered.decisions[0].record.noticeText = "your request was approved";  // the institution's later story
      return { report: await verifyAsOutsider(tampered, serviceId, inst), expect: { "log.decisionLeaf[0]": "OBLIGATION_UNMET" } };
    },
  },
  {
    id: "attack.foreignRootProof",
    kind: "attack",
    claim: "a proof against a root this chain never published is rejected, not accepted on its own arithmetic",
    run: async () => {
      const { inst, bundle, serviceId } = await fresh();
      const { publicLog } = await anchorAndObserve(serviceId, inst);
      const report = await verifyBundle(bundle, {
        publicLog: { ...publicLog, root: keccak256("0xdeadbeef") },   // an outsider observing a different log
        registry: await registryOf(serviceId), currentBlock: await c.pub.getBlockNumber({ cacheTime: 0 }),
      });
      return { report, expect: { "log.requestLeaf": "OBLIGATION_UNMET" } };
    },
  },
  {
    id: "attack.forgedDomain",
    kind: "attack",
    claim: "a bundle forged end to end in the attacker's own domain is OUT_OF_SCOPE, never an accusation",
    run: async () => {
      const rogue = await runCase({ profile: { ...base, serviceId: keccak256("0xr0gue") }, requesterPk: REQUESTER });
      const { serviceId } = await fresh();   // a real registration that has nothing to do with it
      const report = await verifyBundle(rogue.bundle, { registry: await registryOf(serviceId) });
      return { report, expect: { "registry.binding": "OUT_OF_SCOPE" } };
    },
  },
  {
    id: "attack.noRegistration",
    kind: "attack",
    claim: "with no on-chain registration the verifier says UNVERIFIABLE instead of claiming confirmation",
    run: async () => {
      const { bundle } = await fresh();
      return { report: await verifyBundle(bundle, {}), expect: { "registry.binding": "UNVERIFIABLE" } };
    },
  },

  // ------------------------------------------------------------------ attacks on the chain paths
  {
    id: "attack.silentInstitution",
    kind: "attack",
    claim: "an institution that ignores the challenge ends as an on-chain UNANSWERED verdict",
    run: async () => {
      const { inst, bundle, serviceId, clock } = await fresh({ decide: false });
      await anchorPending(c, serviceId, inst.tree.leaves, 0);
      await mine(c.pub, base.decisionRecordDueBlocks + 1);
      await clock.sync();
      await challengeAccepted(cReq, bundle.acceptedReceipt as any, bundle.acceptedReceiptSignature);
      const id = challengeIdOf(serviceId, acceptedReceiptDigest(inst.profile, bundle.acceptedReceipt));
      await mine(c.pub, base.challengeResponseBlocks + 1);
      await finalize(c, id);
      const st = (await readChallenge(c, id)).state;
      writeJson("out/bundle-silent.json", bundle);   // for `npm run verify -- out/bundle-silent.json --rpc … --contract …` after --keep
      // Only now — with the public verdict in hand — may the verifier call this a violation.
      const rec = await reconstructLog(c, serviceId);   // already anchored above — do not append again
      const report = await verifyBundle(bundle, {
        registry: await registryOf(serviceId), publicLog: { treeId: keccak256(serviceId), root: rec.root, size: rec.size },
        currentBlock: await c.pub.getBlockNumber({ cacheTime: 0 }), challenge: await challengeOf(c, id),
      });
      return {
        report, expect: { "decision.presence": "OBLIGATION_UNMET", "challenge.verdict": "OBLIGATION_UNMET", "log.requestLeaf": "CONFIRMED" },
        assert: () => { if (st !== 3) throw new Error(`expected UNANSWERED(3), got ${st}`); },
      };
    },
  },
  {
    id: "attack.answerWithAnotherRecord",
    kind: "attack",
    claim: "a challenge cannot be closed with another request's record, nor with this request's own REQ leaf",
    run: async () => {
      const { inst, bundle, serviceId, clock } = await fresh({ decide: false });
      // the log also holds a decision that belongs to a different acceptance
      const otherDecision = keccak256("0x01");
      await appendBatch(c, serviceId, [leafHash(decisionRecordDigest(keccak256("0x02"), otherDecision))]);
      await anchorPending(c, serviceId, inst.tree.leaves, 0);
      await mine(c.pub, base.decisionRecordDueBlocks + 1);
      await clock.sync();
      await challengeAccepted(cReq, bundle.acceptedReceipt as any, bundle.acceptedReceiptSignature);
      const id = challengeIdOf(serviceId, acceptedReceiptDigest(inst.profile, bundle.acceptedReceipt));
      const rec = await reconstructLog(c, serviceId);
      const errs: string[] = [];
      errs.push(await expectRevert(() => respond(c, id, otherDecision, 0, rec.root, rec.proofFor(0).siblings)));
      const reqLeaf = leafHash(recordDigest(LeafType.REQ, bundle.acceptedReceipt.signedRequestDigest));
      const reqIdx = rec.leaves.findIndex(l => eqi(l, reqLeaf));
      errs.push(await expectRevert(() => respond(c, id, bundle.acceptedReceipt.signedRequestDigest, reqIdx, rec.root, rec.proofFor(reqIdx).siblings)));
      const st = (await readChallenge(c, id)).state;
      return { assert: () => {
        for (const e of errs) if (!e.includes("BadInclusionProof")) throw new Error(`expected BadInclusionProof, got ${e}`);
        if (st !== 1) throw new Error(`challenge should still be OPEN(1), got ${st}`);
      } };
    },
  },
  {
    id: "honest.strippedBundleIsNotAViolation",
    kind: "honest",
    claim: "a bundle handed over without its decision does not accuse an institution that did record — the chain says ANSWERED",
    run: async () => {
      const { inst, bundle, serviceId, clock, requestId } = await fresh();
      await anchorPending(c, serviceId, inst.tree.leaves, 0);
      await mine(c.pub, base.decisionRecordDueBlocks + 1);
      await clock.sync();
      const stripped: ReceiptBundle = JSON.parse(JSON.stringify(bundle, bigintReplacer), bigintReviver);
      stripped.decisions = [];   // the requester's later story: "they never decided"
      const rec0 = await reconstructLog(c, serviceId);
      const before = await verifyBundle(stripped, {
        registry: await registryOf(serviceId), publicLog: { treeId: keccak256(serviceId), root: rec0.root, size: rec0.size },
        currentBlock: await c.pub.getBlockNumber({ cacheTime: 0 }),
      });
      // the institution answers the public challenge with the record it did make
      await challengeAccepted(cReq, bundle.acceptedReceipt as any, bundle.acceptedReceiptSignature);
      const id = challengeIdOf(serviceId, acceptedReceiptDigest(inst.profile, bundle.acceptedReceipt));
      const rec = await reconstructLog(c, serviceId);
      const dd = decisionDigest(inst.profile, inst.bundle(requestId).decisions[0].record);
      const leaf = leafHash(decisionRecordDigest(acceptedReceiptDigest(inst.profile, bundle.acceptedReceipt), dd));
      const idx = rec.leaves.findIndex(l => eqi(l, leaf));
      await respond(c, id, dd, idx, rec.root, rec.proofFor(idx).siblings);
      const report = await verifyBundle(stripped, {
        registry: await registryOf(serviceId), publicLog: { treeId: keccak256(serviceId), root: rec.root, size: rec.size },
        currentBlock: await c.pub.getBlockNumber({ cacheTime: 0 }), challenge: await challengeOf(c, id),
      });
      return {
        report, expect: { "decision.presence": "UNVERIFIABLE", "challenge.verdict": "CONFIRMED" },
        assert: () => {
          const b = before.checks.find(ch => ch.id === "decision.presence");
          if (b?.status !== "UNVERIFIABLE") throw new Error(`without a chain verdict the stripped bundle must be UNVERIFIABLE, got ${b?.status}: ${b?.detail}`);
        },
      };
    },
  },
  {
    id: "attack.lateRecordingStillFlagged",
    kind: "attack",
    claim: "recording after the challenge answers it but does not erase that the record was late",
    run: async () => {
      const { inst, bundle, serviceId, clock, requestId } = await fresh({ decide: false });
      await anchorPending(c, serviceId, inst.tree.leaves, 0);
      await mine(c.pub, base.decisionRecordDueBlocks + 1);
      await clock.sync();
      await challengeAccepted(cReq, bundle.acceptedReceipt as any, bundle.acceptedReceiptSignature);
      const id = challengeIdOf(serviceId, acceptedReceiptDigest(inst.profile, bundle.acceptedReceipt));

      const before = inst.tree.leaves.length;
      await inst.decide(requestId, INPUTS.screening);
      await anchorPending(c, serviceId, inst.tree.leaves, before);
      const rec = await reconstructLog(c, serviceId);
      const dd = decisionDigest(inst.profile, inst.bundle(requestId).decisions[0].record);
      const leaf = leafHash(decisionRecordDigest(acceptedReceiptDigest(inst.profile, bundle.acceptedReceipt), dd));
      const idx = rec.leaves.findIndex(l => eqi(l, leaf));
      await respond(c, id, dd, idx, rec.root, rec.proofFor(idx).siblings);
      const ch = await readChallenge(c, id);
      return { assert: () => {
        if (ch.state !== 2) throw new Error(`expected ANSWERED(2), got ${ch.state}`);
        if (!ch.answeredLate) throw new Error("late flag was erased by the late answer");
      } };
    },
  },
  {
    id: "attack.strangerChallenges",
    kind: "attack",
    claim: "holding a copy of someone else's receipt is not standing to demand evidence",
    run: async () => {
      const { inst, bundle, serviceId, clock } = await fresh({ decide: false });
      await anchorPending(c, serviceId, inst.tree.leaves, 0);
      await mine(c.pub, base.decisionRecordDueBlocks + 1);
      await clock.sync();
      const err = await expectRevert(() => challengeAccepted(cStranger, bundle.acceptedReceipt as any, bundle.acceptedReceiptSignature));
      return { assert: () => { if (!/NotRequester/.test(err)) throw new Error(`expected NotRequester, got: ${err.slice(0, 120)}`); } };
    },
  },
  {
    id: "attack.stretchedDeadline",
    kind: "attack",
    claim: "an institution cannot sign itself extra time: the deadline must match the anchor it cites",
    run: async () => {
      const { inst, bundle, serviceId, clock } = await fresh({ decide: false });
      await anchorPending(c, serviceId, inst.tree.leaves, 0);
      await mine(c.pub, base.decisionRecordDueBlocks + 1);
      await clock.sync();
      const stretched = { ...bundle.acceptedReceipt, decisionRecordDueBlock: bundle.acceptedReceipt.decisionRecordDueBlock + 5_000n };
      const sig = await signTyped(inst.signer, inst.profile, "AcceptedReceipt", stretched);
      const err = await expectRevert(() => challengeAccepted(cReq, stretched as any, sig));
      return { assert: () => { if (!/DeadlineNotDerived/.test(err)) throw new Error(`expected DeadlineNotDerived, got: ${err.slice(0, 120)}`); } };
    },
  },
  {
    id: "attack.phantomAnchor",
    kind: "attack",
    claim: "citing an anchor this chain never recorded is refused",
    run: async () => {
      const { inst, bundle, serviceId, clock } = await fresh({ decide: false });
      await anchorPending(c, serviceId, inst.tree.leaves, 0);
      await mine(c.pub, base.decisionRecordDueBlocks + 1);
      await clock.sync();
      const phantom = { ...bundle.acceptedReceipt, referenceAnchorId: keccak256("0xnever") };
      const sig = await signTyped(inst.signer, inst.profile, "AcceptedReceipt", phantom);
      const err = await expectRevert(() => challengeAccepted(cReq, phantom as any, sig));
      return { assert: () => { if (!/UnknownAnchor/.test(err)) throw new Error(`expected UnknownAnchor, got: ${err.slice(0, 120)}`); } };
    },
  },
  {
    id: "honest.publicNoticeIsNeutral",
    kind: "honest",
    claim: "a requester with no receipt may post publicly, and that is a neutral record, not an accusation",
    run: async () => {
      const { bundle, serviceId } = await fresh({ decide: false });
      const rc = await postNotice(cReq, bundle.request as any, bundle.requesterSignature);
      return { assert: () => { if (rc.status !== "success") throw new Error("public notice was refused"); } };
    },
  },
];


/** The custom error name lives deep in viem's cause chain, not in `shortMessage`. Flatten it all. */
async function expectRevert(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return "NO REVERT"; } catch (e: any) {
    const parts: string[] = [];
    for (let cur = e, i = 0; cur && i < 8; cur = cur.cause, i++) {
      if (cur.message) parts.push(String(cur.message));
      if (cur.data?.errorName) parts.push(String(cur.data.errorName));
      if (cur.errorName) parts.push(String(cur.errorName));
      if (Array.isArray(cur.metaMessages)) parts.push(cur.metaMessages.join(" "));
    }
    return parts.join(" | ");
  }
}

async function main() {
  const keep = process.argv.includes("--keep");
  let anvil: ChildProcess | undefined;
  if (!process.env.SCENARIO_RPC) {
    anvil = spawnAnvil(PORT);
  }
  const chain = anvilChain(CHAIN_ID, RPC);
  for (let i = 0; i < 150; i++) {
    try { const t = await connect(RPC, chain, DEPLOYER); await t.pub.getBlockNumber(); break; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  const t = await connect(RPC, chain, DEPLOYER);
  const address = await deployLog(t);
  c = { ...t, address };
  cReq = { ...(await connect(RPC, chain, REQUESTER)), address };
  cStranger = { ...(await connect(RPC, chain, STRANGER)), address };
  base = { ...DEMO_PROFILE, chainId: CHAIN_ID, verifyingContract: address };

  const scenarios = [...SCENARIOS, ...createEscrowScenarios(c, cReq, cStranger)];
  console.log(`BlockNotice scenarios — ${scenarios.length} scenes on a local chain at ${RPC}`);
  console.log(`log contract ${address}\n`);

  const rows: Array<{ id: string; kind: string; claim: string; ok: boolean; note: string; report?: Pick<VerifyReport, "checks"> }> = [];
  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : undefined;
  for (const sc of scenarios) {
    if (only && !sc.id.includes(only)) continue;
    let ok = true, note = "";
    let lastReport: Pick<VerifyReport, "checks"> | undefined;
    try {
      const out = await sc.run();
      lastReport = out.report;
      if (out.assert) await out.assert();
      if (out.report && out.expect) {
        for (const [id, want] of Object.entries(out.expect)) {
          const found = out.report.checks.find(ch => ch.id === id);
          if (!found) { ok = false; note = `check ${id} was never produced`; break; }
          if (found.status !== want) { ok = false; note = `${id}: expected ${want}, got ${found.status}`; break; }
        }
        if (ok) note = `${Object.keys(out.expect).length} check(s) as predicted`;
      } else if (ok) note = "as predicted";
    } catch (e: any) {
      ok = false; note = String(e?.message ?? e).slice(0, 140);
    }
    rows.push({ id: sc.id, kind: sc.kind, claim: sc.claim, ok, note, report: lastReport });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${sc.kind.padEnd(6)} ${sc.id.padEnd(34)} ${note}`);
  }

  const failed = rows.filter(r => !r.ok);
  const attacks = rows.filter(r => r.kind === "attack");
  console.log(`\nattacks caught      ${attacks.filter(r => r.ok).length}/${attacks.length}`);
  console.log(`false positives     ${rows.filter(r => r.kind === "honest" && !r.ok).length} (honest scenes wrongly flagged)`);
  console.log(`${failed.length === 0 ? "ALL SCENES BEHAVED AS PREDICTED" : `${failed.length} SCENE(S) DID NOT`}`);

  writeJson("out/scenarios.json", {
    generatedAt: new Date().toISOString(), rpc: RPC, logContract: address,
    scenarios: rows,
    totals: {
      scenes: rows.length,
      attacksCaught: attacks.filter(r => r.ok).length, attacks: attacks.length,
      falsePositives: rows.filter(r => r.kind === "honest" && !r.ok).length,
    },
  });
  console.log("wrote out/scenarios.json");

  if (anvil && !keep) anvil.kill();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(e => { console.error(String(e?.message ?? e)); process.exit(1); });
