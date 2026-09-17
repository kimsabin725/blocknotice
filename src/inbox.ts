import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, hashTypedData, keccak256, type Address, type Hex } from "viem";
import { escrowLeaf, escrowRecordDigest } from "./escrow.js";
import { IncrementalTree } from "./merkle.js";
import type { InclusionProof } from "./types.js";
import type { ChainCtx } from "./chain.js";

const view = (name: string, outputs: any[], inputs: any[] = []) => ({ type: "function", name, stateMutability: "view", inputs, outputs });
const INBOX_ABI_FALLBACK = [
  view("log", [{ name: "", type: "address" }]),
  view("escrow", [{ name: "", type: "address" }]),
  view("token", [{ name: "", type: "address" }]),
  view("forwardBlocks", [{ name: "", type: "uint64" }]),
  view("responseBlocks", [{ name: "", type: "uint64" }]),
  view("profileHash", [{ name: "", type: "bytes32" }]),
  view("forwardDue", [{ name: "", type: "uint64" }], [{ name: "requestId", type: "bytes32" }]),
  view("getRequest", [{
    name: "", type: "tuple", components: [
      { name: "holder", type: "address" }, { name: "exchangeOperator", type: "address" },
      { name: "exchangeServiceId", type: "bytes32" }, { name: "amount", type: "uint128" },
      { name: "requestHash", type: "bytes32" }, { name: "nonce", type: "uint256" },
      { name: "expiresAtBlock", type: "uint64" }, { name: "submittedBlock", type: "uint64" },
      { name: "responseDueBlock", type: "uint64" }, { name: "lockId", type: "bytes32" },
      { name: "state", type: "uint8" },
    ],
  }], [{ name: "requestId", type: "bytes32" }]),
  { type: "event", name: "Submitted", anonymous: false, inputs: [
    { name: "requestId", type: "bytes32", indexed: true }, { name: "holder", type: "address", indexed: true },
    { name: "exchangeServiceId", type: "bytes32", indexed: true }, { name: "amount", type: "uint128", indexed: false },
    { name: "requestHash", type: "bytes32", indexed: false }, { name: "forwardDueBlock", type: "uint64", indexed: false },
  ] },
  { type: "event", name: "Forwarded", anonymous: false, inputs: [
    { name: "requestId", type: "bytes32", indexed: true }, { name: "lockId", type: "bytes32", indexed: true },
    { name: "late", type: "bool", indexed: false },
  ] },
  { type: "event", name: "RejectionProven", anonymous: false, inputs: [
    { name: "requestId", type: "bytes32", indexed: true }, { name: "leaf", type: "bytes32", indexed: false },
    { name: "root", type: "bytes32", indexed: false }, { name: "index", type: "uint64", indexed: false },
    { name: "late", type: "bool", indexed: false },
  ] },
  { type: "event", name: "ChallengeOpened", anonymous: false, inputs: [
    { name: "requestId", type: "bytes32", indexed: true }, { name: "responseDueBlock", type: "uint64", indexed: false },
  ] },
  { type: "event", name: "ChallengeUnanswered", anonymous: false, inputs: [
    { name: "requestId", type: "bytes32", indexed: true },
  ] },
] as const;

const here = dirname(fileURLToPath(import.meta.url));
const inboxArtifact = JSON.parse(readFileSync(join(here, "..", "forge-out", "RedemptionInbox.sol", "RedemptionInbox.json"), "utf8"));
export const INBOX_ABI = (inboxArtifact.abi ?? INBOX_ABI_FALLBACK) as any;
export const INBOX_BYTECODE = inboxArtifact.bytecode.object as Hex;

export interface InboxRequest {
  holder: Address;
  exchangeServiceId: Hex;
  amount: bigint;
  requestHash: Hex;
  nonce: bigint;
  expiresAtBlock: bigint;
}

export const INBOX_REQUEST_TYPES = {
  Request: [
    { name: "holder", type: "address" },
    { name: "exchangeServiceId", type: "bytes32" },
    { name: "amount", type: "uint128" },
    { name: "requestHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "expiresAtBlock", type: "uint64" },
  ],
} as const;

export function inboxRequestDigest(chainId: bigint | number, inbox: Address, request: InboxRequest): Hex {
  return hashTypedData({
    domain: { name: "RedemptionInbox", version: "1", chainId: Number(chainId), verifyingContract: inbox },
    types: INBOX_REQUEST_TYPES,
    primaryType: "Request",
    message: request,
  });
}

export function inboxRejectionKey(requestId: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [5, requestId]));
}

export const inboxRejectionRecordDigest = (requestId: Hex, digest: Hex) =>
  escrowRecordDigest(inboxRejectionKey(requestId), digest);
export const inboxRejectionLeaf = (requestId: Hex, digest: Hex) =>
  escrowLeaf(inboxRejectionKey(requestId), digest);

export function proofForInboxRejection(tree: IncrementalTree, index: number, requestId: Hex, digest: Hex): InclusionProof {
  const expected = inboxRejectionLeaf(requestId, digest);
  if (tree.leaves[index]?.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`tree index ${index} does not contain the inbox rejection leaf`);
  }
  return tree.proof(index);
}

export interface InboxConstructorProfile {
  log: Address;
  escrow: Address;
  token: Address;
  forwardBlocks: bigint | number;
  responseBlocks: bigint | number;
}

export function inboxProfileHash(chainId: bigint | number, inbox: Address, p: InboxConstructorProfile): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint64" }, { type: "uint64" }],
    [BigInt(chainId), inbox, p.log, p.escrow, BigInt(p.forwardBlocks), BigInt(p.responseBlocks)],
  ));
}

type DeployCtx = Omit<ChainCtx, "address">;
export async function deployInbox(c: DeployCtx, log: Address, escrow: Address, forwardBlocks: bigint, responseBlocks: bigint): Promise<Address> {
  const hash = await c.wallet.deployContract({
    abi: INBOX_ABI, bytecode: INBOX_BYTECODE, account: c.account, chain: c.chain,
    args: [log, escrow, forwardBlocks, responseBlocks],
  });
  const receipt = await c.pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("RedemptionInbox deployment did not return an address");
  return receipt.contractAddress;
}

async function writeInbox(c: ChainCtx, functionName: string, args: readonly unknown[]) {
  const { request } = await c.pub.simulateContract({ address: c.address, abi: INBOX_ABI, functionName, args, account: c.account });
  const hash = await c.wallet.writeContract(request as any);
  return c.pub.waitForTransactionReceipt({ hash });
}

export async function inboxSubmit(c: ChainCtx, request: InboxRequest, signature: Hex) {
  const requestId = inboxRequestDigest(c.chain.id, c.address, request);
  const receipt = await writeInbox(c, "submit", [request, signature]);
  return { requestId, receipt };
}
export const inboxForward = (c: ChainCtx, requestId: Hex) => writeInbox(c, "forward", [requestId]);
export const inboxProveRejection = (c: ChainCtx, requestId: Hex, digest: Hex, proof: Pick<InclusionProof, "index" | "root" | "siblings">) =>
  writeInbox(c, "proveRejection", [requestId, digest, BigInt(proof.index), proof.root, proof.siblings]);
export const inboxChallenge = (c: ChainCtx, requestId: Hex) => writeInbox(c, "challenge", [requestId]);
export const inboxFinalize = (c: ChainCtx, requestId: Hex) => writeInbox(c, "finalize", [requestId]);
