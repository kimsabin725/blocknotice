// Institution simulator. Holds the signing key, the HPKE key for inbound requests, and the local append log.
// "Dishonest" knobs exist only to produce the attack demos; the honest path is the default.
import { keccak256, type Hex, type Address } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { LeafType, Outcome, type ProtocolProfile, type Request, type RequestEnvelope, type AcceptedReceipt, type DecisionRecord, type PrivateReason, type ReceiptBundle, type InclusionProof } from "./types.js";
import { profileHash, requestDigest, acceptedReceiptDigest, decisionDigest, recordDigest, requestCommitment, privateReasonCommitment, inputSnapshotCommitment, policyHash, stringsCommitment, bytes32FromString, ZERO32, institutionKeyId } from "./encode.js";
import { IncrementalTree } from "./merkle.js";
import { signTyped, verifyTyped, newHpkeKeyPair, seal, open, salt32, utf8, type HpkeKeyPair, type Sealed } from "./crypto.js";
import { runPolicy, POLICY_SOURCE, POLICY_VERSION, type PolicyInputs } from "./policy.js";

export interface Clock { block: () => bigint; now: () => bigint; }
export const localClock = (start = 100n): Clock & { advance: (n: bigint) => void } => {
  let b = start; return { block: () => b, now: () => BigInt(Math.floor(Date.now() / 1000)), advance: n => { b += n; } };
};

export interface Knobs { skipRequestLeaf?: boolean; skipDecisionLeaf?: boolean; }

interface Case {
  request: Request; requesterSignature: Hex; envelope: RequestEnvelope; requesterHpkePub: Hex;
  accepted: AcceptedReceipt; acceptedSignature: Hex; requestLeafIndex?: number;
  decisions: Array<{ record: DecisionRecord; signature: Hex; leafIndex?: number; reason: PrivateReason; inputs: PolicyInputs; inputSalt: Hex; sealed: Sealed }>;
  ack?: ReceiptBundle["ack"];
}

export class Institution {
  readonly tree: IncrementalTree;
  readonly cases = new Map<Hex, Case>();
  private nonces = new Set<string>();
  private constructor(readonly profile: ProtocolProfile, readonly signer: PrivateKeyAccount, readonly hpke: HpkeKeyPair, readonly clock: Clock) {
    this.tree = new IncrementalTree(keccak256(profile.serviceId));
  }
  static async create(profileBase: Omit<ProtocolProfile, "institutionKeyId">, signer: PrivateKeyAccount, clock: Clock) {
    const profile: ProtocolProfile = { ...profileBase, institutionKeyId: institutionKeyId(signer.address) };
    return new Institution(profile, signer, await newHpkeKeyPair(), clock);
  }
  get address(): Address { return this.signer.address; }

  /** Step 2 of the normal flow: validate, sign AcceptedReceipt, log REQ leaf. */
  async accept(request: Request, requesterSignature: Hex, sealedEnvelope: Sealed, requesterHpkePub: Hex, knobs: Knobs = {}) {
    const p = this.profile;
    if (request.schemaVersion !== 1) throw new Error("schemaVersion");
    if (request.serviceId !== p.serviceId) throw new Error("serviceId mismatch");
    if (!(await verifyTyped(p, "Request", request, requesterSignature, request.requesterKey))) throw new Error("bad requester signature");
    if (request.expiresAtBlock <= this.clock.block()) throw new Error("request expired");
    const nonceKey = `${request.requesterKey}:${request.nonce}`;
    if (this.nonces.has(nonceKey) || this.cases.has(request.requestId)) throw new Error("duplicate nonce/requestId");
    const envelope = JSON.parse(utf8.dec(await open(this.hpke.privateKey, sealedEnvelope))) as RequestEnvelope;
    if (requestCommitment(envelope) !== request.requestCommitment) throw new Error("envelope does not match commitment");
    if (keccak256(requesterHpkePub) !== request.responseEncryptionKeyHash) throw new Error("response key mismatch");
    this.nonces.add(nonceKey);

    const blk = this.clock.block();
    const accepted: AcceptedReceipt = {
      requestId: request.requestId, signedRequestDigest: requestDigest(p, request), serviceId: p.serviceId,
      institutionKeyId: p.institutionKeyId, protocolProfileHash: profileHash(p), acceptedAtClaimed: this.clock.now(),
      referenceAnchorId: ZERO32, requestRecordDueBlock: blk + BigInt(p.requestRecordDueBlocks), decisionRecordDueBlock: blk + BigInt(p.decisionRecordDueBlocks),
    };
    const acceptedSignature = await signTyped(this.signer, p, "AcceptedReceipt", accepted);
    const c: Case = { request, requesterSignature, envelope, requesterHpkePub, accepted, acceptedSignature, decisions: [] };
    if (!knobs.skipRequestLeaf) c.requestLeafIndex = this.tree.appendRecord(recordDigest(LeafType.REQ, accepted.signedRequestDigest));
    this.cases.set(request.requestId, c);
    return { accepted, acceptedSignature };
  }

  /** Step 3–5: run policy, sign DecisionRecord, log DEC leaf, seal to requester. */
  async decide(requestId: Hex, inputs: PolicyInputs, knobs: Knobs = {}) {
    const c = this.cases.get(requestId); if (!c) throw new Error("unknown request");
    const p = this.profile;
    const res = runPolicy({ amount: c.envelope.amount, destination: c.envelope.destination }, inputs);
    const reason: PrivateReason = { detail: res.detail, ruleIds: res.ruleIds, salt: salt32() };
    const inputSalt = salt32();
    const prev = c.decisions.at(-1);
    const blk = this.clock.block();
    const record: DecisionRecord = {
      requestId, acceptedReceiptDigest: acceptedReceiptDigest(p, c.accepted), decisionId: salt32(),
      decisionSeq: c.decisions.length, previousDecisionDigest: prev ? decisionDigest(p, prev.record) : ZERO32,
      outcome: res.outcome, noticeText: res.noticeText, noticeCategory: bytes32FromString(res.category), legalBasisReference: ZERO32,
      privateReasonCommitment: privateReasonCommitment(reason), policyHash: policyHash(POLICY_SOURCE, POLICY_VERSION),
      inputSnapshotCommitment: inputSnapshotCommitment(inputs as any, inputSalt), evidenceRefsCommitment: stringsCommitment([`sanctions:${inputs.sanctionsListVersion}`], inputSalt),
      decidedAtClaimed: this.clock.now(), effectiveAtClaimed: this.clock.now(),
      reviewDueBlock: res.outcome === Outcome.DEFER ? blk + BigInt(inputs.reviewBlocks) : 0n, recordNonce: salt32(),
    };
    const signature = await signTyped(this.signer, p, "DecisionRecord", record);
    const leafIndex = knobs.skipDecisionLeaf ? undefined : this.tree.appendRecord(recordDigest(LeafType.DEC, decisionDigest(p, record)));
    const sealed = await seal(c.requesterHpkePub, utf8.enc(JSON.stringify({ record, signature }, bigintReplacer)), requestId);
    c.decisions.push({ record, signature, leafIndex, reason, inputs, inputSalt, sealed });
    return { record, signature, sealed };
  }

  recordAck(ack: NonNullable<ReceiptBundle["ack"]>) {
    const c = this.cases.get(ack.ack.requestId); if (!c) throw new Error("unknown request");
    c.ack = ack;
    this.tree.appendRecord(recordDigest(LeafType.ACK, keccak256(ack.signature)));
  }

  /** Step 6: what the requester downloads. Private reason and its salt stay with the institution. */
  bundle(requestId: Hex, includePublicPolicy = true): ReceiptBundle {
    const c = this.cases.get(requestId); if (!c) throw new Error("unknown request");
    const proofAt = (i?: number): InclusionProof | undefined => i === undefined ? undefined : this.tree.proof(i);
    const last = c.decisions.at(-1);
    return {
      bundleVersion: 1, profile: this.profile, request: c.request, requestEnvelope: c.envelope, requesterSignature: c.requesterSignature,
      requesterHpkePublicKey: c.requesterHpkePub, acceptedReceipt: c.accepted, acceptedReceiptSignature: c.acceptedSignature, institutionSigner: this.address,
      decisions: c.decisions.map(d => ({ record: d.record, signature: d.signature, proof: proofAt(d.leafIndex) })),
      requestLeafProof: proofAt(c.requestLeafIndex),
      publicPolicy: includePublicPolicy ? { source: POLICY_SOURCE, version: POLICY_VERSION } : undefined,
      publicInputs: includePublicPolicy && last ? { inputs: last.inputs, inputSalt: last.inputSalt } : undefined,
      ack: c.ack,
    };
  }

  /** Reveal material for an authorised reviewer: only this case's detail + salt, never a global key. */
  openReason(requestId: Hex, seq: number): PrivateReason {
    const c = this.cases.get(requestId); if (!c) throw new Error("unknown request");
    return c.decisions[seq].reason;
  }
}

export const bigintReplacer = (_k: string, v: unknown) => typeof v === "bigint" ? `${v.toString()}n` : v;
export const bigintReviver = (_k: string, v: unknown) => typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
