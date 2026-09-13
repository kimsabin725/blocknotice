// BlockNotice — record schema (spec 04 §7). All signed structs are EIP-712 typed data.
import type { Hex, Address } from "viem";

export const SCHEMA_VERSION = 1;

export enum Outcome { ALLOW = 0, DENY = 1, DEFER = 2 }
export enum LeafType { REQ = 1, DEC = 2, ACK = 3 }

/** Domain is part of the protocol profile; chainId/verifyingContract bind signatures to one deployment. */
export interface ProtocolProfile {
  name: "BlockNotice";
  version: "1";
  chainId: number;
  verifyingContract: Address;
  serviceId: Hex;              // bytes32
  institutionKeyId: Hex;       // bytes32 — keccak(institution signing address)
  requestRecordDueBlocks: number;   // blocks after acceptance to log REQ leaf
  decisionRecordDueBlocks: number;  // blocks after acceptance to log first DEC leaf
  challengeResponseBlocks: number;  // blocks the institution has to answer a challenge
  maxDeferReviews: number;          // DEFER chain length allowed by policy
}

export interface Request {
  schemaVersion: number;
  serviceId: Hex;
  requestId: Hex;
  nonce: Hex;
  requesterKey: Address;
  responseEncryptionKeyHash: Hex;   // keccak(requester HPKE public key)
  requestCommitment: Hex;           // keccak(abi(RequestEnvelope) ‖ salt)
  expiresAtBlock: bigint;
}

/** Private request body — encrypted to the institution, never on chain. */
export interface RequestEnvelope {
  requestType: "WITHDRAWAL";
  asset: string;
  amount: string;        // decimal string
  destination: string;   // address or IBAN-like id (synthetic)
  salt: Hex;             // 32 bytes
}

export interface AcceptedReceipt {
  requestId: Hex;
  signedRequestDigest: Hex;       // EIP-712 digest of Request that the requester signed
  serviceId: Hex;
  institutionKeyId: Hex;
  protocolProfileHash: Hex;
  acceptedAtClaimed: bigint;      // unix seconds, institution's own claim
  referenceAnchorId: Hex;         // bytes32 id of the on-chain anchor observed at acceptance (0x0 before day 2)
  requestRecordDueBlock: bigint;
  decisionRecordDueBlock: bigint;
}

export interface DecisionRecord {
  requestId: Hex;
  acceptedReceiptDigest: Hex;
  decisionId: Hex;
  decisionSeq: number;
  previousDecisionDigest: Hex;    // 0x0 for first decision; corrections chain here
  outcome: Outcome;
  noticeText: string;             // the text the requester is shown
  noticeCategory: Hex;            // bytes32 code from the institution's committed classification table
  legalBasisReference: Hex;       // bytes32, empty in demo profile
  privateReasonCommitment: Hex;   // keccak(abi(PrivateReason) ‖ salt)
  policyHash: Hex;
  inputSnapshotCommitment: Hex;
  evidenceRefsCommitment: Hex;
  decidedAtClaimed: bigint;
  effectiveAtClaimed: bigint;
  reviewDueBlock: bigint;         // DEFER only
  recordNonce: Hex;
}

export interface PrivateReason {
  detail: string;        // e.g. "rule R-17 sanctions-list match score 0.93"
  ruleIds: string[];
  salt: Hex;
}

export interface Ack {
  requestId: Hex;
  decisionDigest: Hex;
  ackNonce: Hex;
}

export interface InclusionProof {
  treeId: Hex;
  index: number;
  size: number;
  root: Hex;
  siblings: Hex[];   // depth entries, bottom-up
}

/** What the requester downloads. Private reason detail/salt are NOT included. */
export interface ReceiptBundle {
  bundleVersion: 1;
  profile: ProtocolProfile;
  request: Request;
  requestEnvelope: RequestEnvelope;      // requester's own plaintext (they hold it)
  requesterSignature: Hex;
  requesterHpkePublicKey: Hex;
  acceptedReceipt: AcceptedReceipt;
  acceptedReceiptSignature: Hex;
  institutionSigner: Address;
  decisions: Array<{
    record: DecisionRecord;
    signature: Hex;
    proof?: InclusionProof;              // absent while SIGNED_PENDING_ANCHOR
  }>;
  requestLeafProof?: InclusionProof;
  publicPolicy?: { source: string; version: string };
  publicInputs?: Record<string, unknown>;
  ack?: { ack: Ack; signature: Hex };
}

export const EIP712_TYPES = {
  Request: [
    { name: "schemaVersion", type: "uint16" },
    { name: "serviceId", type: "bytes32" },
    { name: "requestId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "requesterKey", type: "address" },
    { name: "responseEncryptionKeyHash", type: "bytes32" },
    { name: "requestCommitment", type: "bytes32" },
    { name: "expiresAtBlock", type: "uint64" },
  ],
  AcceptedReceipt: [
    { name: "requestId", type: "bytes32" },
    { name: "signedRequestDigest", type: "bytes32" },
    { name: "serviceId", type: "bytes32" },
    { name: "institutionKeyId", type: "bytes32" },
    { name: "protocolProfileHash", type: "bytes32" },
    { name: "acceptedAtClaimed", type: "uint64" },
    { name: "referenceAnchorId", type: "bytes32" },
    { name: "requestRecordDueBlock", type: "uint64" },
    { name: "decisionRecordDueBlock", type: "uint64" },
  ],
  DecisionRecord: [
    { name: "requestId", type: "bytes32" },
    { name: "acceptedReceiptDigest", type: "bytes32" },
    { name: "decisionId", type: "bytes32" },
    { name: "decisionSeq", type: "uint32" },
    { name: "previousDecisionDigest", type: "bytes32" },
    { name: "outcome", type: "uint8" },
    { name: "noticeText", type: "string" },
    { name: "noticeCategory", type: "bytes32" },
    { name: "legalBasisReference", type: "bytes32" },
    { name: "privateReasonCommitment", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "inputSnapshotCommitment", type: "bytes32" },
    { name: "evidenceRefsCommitment", type: "bytes32" },
    { name: "decidedAtClaimed", type: "uint64" },
    { name: "effectiveAtClaimed", type: "uint64" },
    { name: "reviewDueBlock", type: "uint64" },
    { name: "recordNonce", type: "bytes32" },
  ],
  Ack: [
    { name: "requestId", type: "bytes32" },
    { name: "decisionDigest", type: "bytes32" },
    { name: "ackNonce", type: "bytes32" },
  ],
} as const;
