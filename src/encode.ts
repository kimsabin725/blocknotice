// Digests and commitments. Every commitment is keccak over a fixed ABI encoding, never over ad-hoc JSON.
import { keccak256, encodeAbiParameters, hashTypedData, stringToHex, concatHex, toHex, type Hex, type Address } from "viem";
import { EIP712_TYPES, type ProtocolProfile, type Request, type AcceptedReceipt, type DecisionRecord, type Ack, type RequestEnvelope, type PrivateReason, LeafType } from "./types.js";

export const ZERO32: Hex = `0x${"00".repeat(32)}`;

export function domainOf(p: ProtocolProfile) {
  return { name: p.name, version: p.version, chainId: p.chainId, verifyingContract: p.verifyingContract } as const;
}

export function profileHash(p: ProtocolProfile): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" },
     { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint32" }],
    [p.name, p.version, BigInt(p.chainId), p.verifyingContract, p.serviceId, p.institutionKeyId,
     BigInt(p.requestRecordDueBlocks), BigInt(p.decisionRecordDueBlocks), BigInt(p.challengeResponseBlocks), p.maxDeferReviews]));
}

export function institutionKeyId(addr: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }], [addr]));
}

export function requestCommitment(e: RequestEnvelope): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }, { type: "bytes32" }],
    [e.requestType, e.asset, e.amount, e.destination, e.salt]));
}

export function privateReasonCommitment(r: PrivateReason): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "string[]" }, { type: "bytes32" }], [r.detail, r.ruleIds, r.salt]));
}

/** Public inputs are committed with a salt too, so a verifier given the inputs can re-check; without them nothing leaks. */
export function inputSnapshotCommitment(inputs: Record<string, unknown>, salt: Hex): Hex {
  const canonical = JSON.stringify(inputs, Object.keys(inputs).sort());
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], [canonical, salt]));
}

export function policyHash(source: string, version: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }], [source, version]));
}

export function stringsCommitment(items: string[], salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "string[]" }, { type: "bytes32" }], [items, salt]));
}

export function bytes32FromString(s: string): Hex {
  const h = stringToHex(s);
  if (h.length > 66) throw new Error("bytes32FromString: too long");
  return (h + "0".repeat(66 - h.length)) as Hex;
}

// ---- EIP-712 digests (what is actually signed) ----
export const requestDigest = (p: ProtocolProfile, m: Request) =>
  hashTypedData({ domain: domainOf(p), types: EIP712_TYPES, primaryType: "Request", message: m });
export const acceptedReceiptDigest = (p: ProtocolProfile, m: AcceptedReceipt) =>
  hashTypedData({ domain: domainOf(p), types: EIP712_TYPES, primaryType: "AcceptedReceipt", message: m });
export const decisionDigest = (p: ProtocolProfile, m: DecisionRecord) =>
  hashTypedData({ domain: domainOf(p), types: EIP712_TYPES, primaryType: "DecisionRecord", message: m });
export const ackDigest = (p: ProtocolProfile, m: Ack) =>
  hashTypedData({ domain: domainOf(p), types: EIP712_TYPES, primaryType: "Ack", message: m });

// ---- Log leaves. recordDigest binds the leaf type so a REQ leaf can never be passed off as a DEC leaf. ----
export function recordDigest(type: LeafType, digest: Hex): Hex {
  if (type === LeafType.DEC) throw new Error("a DEC leaf is bound to its acceptance — use decisionRecordDigest");
  return keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [type, digest]));
}
/** A decision leaf names the acceptance it answers, so `respond` on-chain can only be satisfied by a
 *  record for THAT acceptance — never by another request's record or a REQ/ACK leaf. Mirrors
 *  BlockNoticeLog.decisionLeaf. */
export function decisionRecordDigest(acceptedDigest: Hex, decisionDigest: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }], [LeafType.DEC, acceptedDigest, decisionDigest]));
}
/** challengeId = keccak256(abi.encode(serviceId, acceptedDigest)) — mirrors the contract. */
export function challengeIdOf(serviceId: Hex, acceptedDigest: Hex): Hex {
  return keccak256(`0x${serviceId.slice(2)}${acceptedDigest.slice(2)}` as Hex);
}
/** leaf = H(0x00 ‖ recordDigest) — domain-separated from inner nodes (0x01). Mirrors the contract. */
export function leafHash(rd: Hex): Hex {
  return keccak256(concatHex(["0x00", rd]));
}
export function nodeHash(left: Hex, right: Hex): Hex {
  return keccak256(concatHex(["0x01", left, right]));
}
