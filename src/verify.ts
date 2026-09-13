// Independent verifier. Takes a receipt bundle (+ optionally public log leaves) and decides what can be
// established without contacting the institution. Never collapses everything into pass/fail:
// CONFIRMED / NOT_DUE / OBLIGATION_UNMET / UNVERIFIABLE / OUT_OF_SCOPE.
import { keccak256, type Address, type Hex } from "viem";
import { LeafType, Outcome, type ReceiptBundle, type InclusionProof } from "./types.js";
import { profileHash, requestDigest, acceptedReceiptDigest, decisionDigest, ackDigest, recordDigest, requestCommitment, inputSnapshotCommitment, policyHash, leafHash, ZERO32 } from "./encode.js";
import { verifyInclusion } from "./merkle.js";
import { verifyTyped } from "./crypto.js";
import { runPolicy, POLICY_SOURCE, POLICY_VERSION } from "./policy.js";

export type Status = "CONFIRMED" | "NOT_DUE" | "OBLIGATION_UNMET" | "UNVERIFIABLE" | "OUT_OF_SCOPE";

export interface Check { id: string; status: Status; detail: string; }
export interface VerifyReport {
  bundleVersion: number;
  requestId: Hex;
  institution: Hex;
  requester: Hex;
  checks: Check[];
  anchorState: "SIGNED_PENDING_ANCHOR" | "ANCHORED" | "MIXED";
  outcome: string;
  institutionNetworkCalls: 0;
  summary: { CONFIRMED: number; NOT_DUE: number; OBLIGATION_UNMET: number; UNVERIFIABLE: number; OUT_OF_SCOPE: number };
}

export interface VerifyOptions {
  /** Public log state observed independently (day 2: read from chain). Absent => inclusion is UNVERIFIABLE, not failed. */
  publicLog?: { treeId: Hex; root: Hex; size: number };
  currentBlock?: bigint;
  /**
   * The registration read from the chain, NOT from the bundle. Without it every signature check below
   * only establishes "some key signed consistently inside a domain it chose for itself" — a bundle
   * forged end to end by an attacker satisfies that. With it, the domain, the signer and the deadline
   * profile are pinned by a public record the institution cannot rewrite.
   */
  registry?: { serviceId: Hex; signer: Address; profileHash: Hex; treeId: Hex; chainId: number; verifyingContract: Address };
}

const eq = (a?: string, b?: string) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const ok = (id: string, detail: string): Check => ({ id, status: "CONFIRMED", detail });
const bad = (id: string, detail: string): Check => ({ id, status: "OBLIGATION_UNMET", detail });
const unk = (id: string, detail: string): Check => ({ id, status: "UNVERIFIABLE", detail });

export async function verifyBundle(b: ReceiptBundle, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const p = b.profile;
  const checks: Check[] = [];

  // 0. Anchor of trust. Everything after this is only as good as the registration it is pinned to.
  const reg = opts.registry;
  if (!reg) {
    checks.push({ id: "registry.binding", status: "UNVERIFIABLE",
      detail: "no on-chain registration supplied — the domain, signer and deadline profile below are the bundle's own claims" });
  } else {
    const mismatches = [
      !eq(reg.serviceId, p.serviceId) && "serviceId",
      !eq(reg.signer, b.institutionSigner) && "institutionSigner",
      !eq(reg.profileHash, profileHash(p)) && "profileHash",
      reg.chainId !== p.chainId && "chainId",
      !eq(reg.verifyingContract, p.verifyingContract) && "verifyingContract",
    ].filter(Boolean) as string[];
    if (mismatches.length) {
      // Not an accusation against the institution — this bundle simply is not about the registered
      // service at all, so nothing here may be reported as a violation by it.
      checks.push({ id: "registry.binding", status: "OUT_OF_SCOPE",
        detail: `bundle does not belong to the registered service (${mismatches.join(", ")} differ) — no claim is made about the registered institution` });
      const summary0 = { CONFIRMED: 0, NOT_DUE: 0, OBLIGATION_UNMET: 0, UNVERIFIABLE: 0, OUT_OF_SCOPE: 1 };
      return { bundleVersion: b.bundleVersion, requestId: b.request.requestId, institution: b.institutionSigner,
        requester: b.request.requesterKey, checks, anchorState: "SIGNED_PENDING_ANCHOR", outcome: "OUT_OF_SCOPE",
        institutionNetworkCalls: 0, summary: summary0 };
    }
    checks.push(ok("registry.binding", `bundle is pinned to the registered service, signer ${reg.signer} and deadline profile`));
  }

  // 1. requester signature over the request
  checks.push(await verifyTyped(p, "Request", b.request, b.requesterSignature, b.request.requesterKey)
    ? ok("request.signature", `requester ${b.request.requesterKey} signed the request`)
    : bad("request.signature", "requester signature does not verify"));

  // 2. the requester's own plaintext matches the commitment they signed
  checks.push(requestCommitment(b.requestEnvelope) === b.request.requestCommitment
    ? ok("request.commitment", "request body matches the signed commitment")
    : bad("request.commitment", "request body does not match the signed commitment"));
  checks.push(keccak256(b.requesterHpkePublicKey) === b.request.responseEncryptionKeyHash
    ? ok("request.responseKey", "response encryption key is bound to the signed request")
    : bad("request.responseKey", "response key hash mismatch"));

  // 3. institution signature over the acceptance, and that it accepted *this* request
  checks.push(await verifyTyped(p, "AcceptedReceipt", b.acceptedReceipt, b.acceptedReceiptSignature, b.institutionSigner)
    ? ok("accepted.signature", `institution ${b.institutionSigner} signed the acceptance`)
    : bad("accepted.signature", "acceptance signature does not verify"));
  checks.push(b.acceptedReceipt.signedRequestDigest === requestDigest(p, b.request)
    ? ok("accepted.binding", "acceptance is bound to this exact request")
    : bad("accepted.binding", "acceptance refers to a different request digest"));
  checks.push(b.acceptedReceipt.protocolProfileHash === profileHash(p)
    ? ok("accepted.profile", "acceptance pins the protocol profile in the bundle")
    : bad("accepted.profile", "profile hash mismatch — deadlines/rules were not the ones shown"));

  // 4. decisions: signature, chaining, and the acceptance they belong to
  const ar = acceptedReceiptDigest(p, b.acceptedReceipt);
  let prev: Hex = ZERO32;
  for (const [i, d] of b.decisions.entries()) {
    const tag = `decision[${i}]`;
    checks.push(await verifyTyped(p, "DecisionRecord", d.record, d.signature, b.institutionSigner)
      ? ok(`${tag}.signature`, `outcome=${Outcome[d.record.outcome]} seq=${d.record.decisionSeq}`)
      : bad(`${tag}.signature`, "decision signature does not verify"));
    checks.push(d.record.acceptedReceiptDigest === ar && d.record.requestId === b.request.requestId
      ? ok(`${tag}.binding`, "decision is bound to this acceptance")
      : bad(`${tag}.binding`, "decision belongs to a different acceptance/request"));
    checks.push(d.record.decisionSeq === i && d.record.previousDecisionDigest === prev
      ? ok(`${tag}.chain`, i === 0 ? "first decision" : "correctly chained to the previous decision")
      : bad(`${tag}.chain`, "decision sequence/chain is inconsistent — a record may have been replaced"));
    prev = decisionDigest(p, d.record);
  }
  if (b.decisions.length === 0) {
    const cur = opts.currentBlock;
    checks.push(cur === undefined
      ? unk("decision.presence", "no decision in bundle and no block height given")
      : cur <= b.acceptedReceipt.decisionRecordDueBlock
        ? { id: "decision.presence", status: "NOT_DUE", detail: `no decision yet; due at block ${b.acceptedReceipt.decisionRecordDueBlock}, now ${cur}` }
        : bad("decision.presence", `no decision and the signed deadline (block ${b.acceptedReceipt.decisionRecordDueBlock}) has passed`));
  }

  // 5. inclusion in the public log — only meaningful against an independently observed root
  const anchors: Array<"SIGNED_PENDING_ANCHOR" | "ANCHORED"> = [];
  const checkProof = (id: string, type: LeafType, digest: Hex, proof?: InclusionProof) => {
    if (!proof) { anchors.push("SIGNED_PENDING_ANCHOR"); checks.push(unk(id, "signed but not yet in the public log (SIGNED_PENDING_ANCHOR)")); return; }
    const leaf = leafHash(recordDigest(type, digest));
    if (!verifyInclusion(leaf, proof)) { checks.push(bad(id, "inclusion proof does not reconstruct the claimed root")); return; }
    const pl = opts.publicLog;
    if (!pl) { anchors.push("SIGNED_PENDING_ANCHOR"); checks.push(unk(id, `proof is internally consistent (root ${proof.root.slice(0, 10)}…) but no independent log root was supplied`)); return; }
    if (pl.treeId.toLowerCase() !== proof.treeId.toLowerCase()) { checks.push(bad(id, "proof is for a different treeId than the registered log")); return; }
    if (proof.size > pl.size) { checks.push(bad(id, `proof claims size ${proof.size} beyond observed log size ${pl.size}`)); return; }
    if (pl.root.toLowerCase() !== proof.root.toLowerCase()) { checks.push(bad(id, "proof root does not match the independently observed log root")); return; }
    anchors.push("ANCHORED"); checks.push(ok(id, `included at index ${proof.index} of the observed log`));
  };
  checkProof("log.requestLeaf", LeafType.REQ, b.acceptedReceipt.signedRequestDigest, b.requestLeafProof);
  for (const [i, d] of b.decisions.entries()) checkProof(`log.decisionLeaf[${i}]`, LeafType.DEC, decisionDigest(p, d.record), d.proof);

  // 6. policy re-execution — only for the public example inputs; real inputs stay out of scope
  if (b.publicPolicy && b.publicInputs && b.decisions.length) {
    const last = b.decisions.at(-1)!.record;
    const { inputs, inputSalt } = b.publicInputs as any;
    const declared = policyHash(b.publicPolicy.source, b.publicPolicy.version) === last.policyHash;
    const inputsMatch = inputSnapshotCommitment(inputs, inputSalt) === last.inputSnapshotCommitment;
    checks.push(declared ? ok("policy.declared", `decision names policy ${b.publicPolicy.version}`)
      : bad("policy.declared", "declared policy does not hash to the policyHash in the decision"));
    checks.push(inputsMatch ? ok("policy.inputs", "supplied inputs match the committed input snapshot")
      : bad("policy.inputs", "supplied inputs do not match the committed snapshot"));
    if (declared && inputsMatch && b.publicPolicy.version === POLICY_VERSION && b.publicPolicy.source === POLICY_SOURCE) {
      const re = runPolicy({ amount: b.requestEnvelope.amount, destination: b.requestEnvelope.destination }, inputs);
      checks.push(re.outcome === last.outcome
        ? ok("policy.rerun", `re-executing the declared policy on the declared inputs reproduces ${Outcome[last.outcome]}`)
        : bad("policy.rerun", `re-execution gives ${Outcome[re.outcome]} but the record says ${Outcome[last.outcome]}`));
    } else {
      checks.push({ id: "policy.rerun", status: "OUT_OF_SCOPE", detail: "policy source not available locally; only declaration is checked" });
    }
  } else {
    checks.push({ id: "policy.rerun", status: "OUT_OF_SCOPE", detail: "no public policy/inputs in bundle — truthfulness of private inputs is out of scope" });
  }
  checks.push({ id: "reason.privacy", status: "OUT_OF_SCOPE", detail: "private reason is a commitment only; its truthfulness cannot be checked without authorised reveal" });

  // 7. ACK — receipt of notice, never proof of comprehension
  if (b.ack) {
    const bound = b.decisions.some(d => decisionDigest(p, d.record) === b.ack!.ack.decisionDigest);
    checks.push(await verifyTyped(p, "Ack", b.ack.ack, b.ack.signature, b.request.requesterKey) && bound
      ? ok("ack.signature", "requester signed receipt of the decision")
      : bad("ack.signature", "ACK does not verify or is not bound to a decision in this bundle"));
  } else {
    checks.push(unk("ack.presence", "no ACK — delivery unconfirmed (this is not an institution violation)"));
  }

  const summary = { CONFIRMED: 0, NOT_DUE: 0, OBLIGATION_UNMET: 0, UNVERIFIABLE: 0, OUT_OF_SCOPE: 0 };
  for (const c of checks) summary[c.status]++;
  const anchorState = anchors.length === 0 ? "SIGNED_PENDING_ANCHOR"
    : anchors.every(a => a === "ANCHORED") ? "ANCHORED"
    : anchors.every(a => a === "SIGNED_PENDING_ANCHOR") ? "SIGNED_PENDING_ANCHOR" : "MIXED";
  const last = b.decisions.at(-1);
  return {
    bundleVersion: b.bundleVersion, requestId: b.request.requestId, institution: b.institutionSigner, requester: b.request.requesterKey,
    checks, anchorState, outcome: last ? Outcome[last.record.outcome] : "NO_DECISION", institutionNetworkCalls: 0, summary,
  };
}
