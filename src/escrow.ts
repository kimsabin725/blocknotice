import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, keccak256, parseEventLogs, type Address, type Hex } from "viem";
import { decisionRecordDigest, leafHash } from "./encode.js";
import { IncrementalTree } from "./merkle.js";
import type { InclusionProof } from "./types.js";
import type { ChainCtx } from "./chain.js";

const here = dirname(fileURLToPath(import.meta.url));
const escrowArtifact = JSON.parse(readFileSync(join(here, "..", "forge-out", "RedemptionEscrow.sol", "RedemptionEscrow.json"), "utf8"));
const mockGoldArtifact = JSON.parse(readFileSync(join(here, "..", "forge-out", "MockGold.sol", "MockGold.json"), "utf8"));
export const ESCROW_ABI = escrowArtifact.abi as any;
export const ESCROW_BYTECODE = escrowArtifact.bytecode.object as Hex;
export const MOCK_GOLD_ABI = mockGoldArtifact.abi as any;
export const MOCK_GOLD_BYTECODE = mockGoldArtifact.bytecode.object as Hex;

/** Mirrors `keccak256(abi.encode(block.chainid, address(this), holder, requestHash, nonce))`. */
export function escrowLockId(
  chainId: bigint | number,
  escrow: Address,
  holder: Address,
  requestHash: Hex,
  nonce: bigint | number,
): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }],
    [BigInt(chainId), escrow, holder, requestHash, BigInt(nonce)],
  ));
}

function taggedEscrowKey(tag: 3 | 4, lockId: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [tag, lockId]));
}

export const escrowHandoffKey = (lockId: Hex): Hex => taggedEscrowKey(3, lockId);
export const escrowDeliveryKey = (lockId: Hex): Hex => taggedEscrowKey(4, lockId);

/** outcome:uint8, category:bytes32, reasonCommit:bytes32, salt:bytes32. */
export function escrowDecisionDigest(outcome: number, category: Hex, reasonCommit: Hex, salt: Hex): Hex {
  if (!Number.isInteger(outcome) || outcome < 0 || outcome > 255) throw new Error("outcome must fit uint8");
  return keccak256(encodeAbiParameters(
    [{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [outcome, category, reasonCommit, salt],
  ));
}

/** courierServiceId:bytes32, handoffCommit:bytes32, salt:bytes32. */
export function escrowHandoffDigest(courierServiceId: Hex, handoffCommit: Hex, salt: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [courierServiceId, handoffCommit, salt],
  ));
}

/** deliveryCommit:bytes32, salt:bytes32. */
export function escrowDeliveryDigest(deliveryCommit: Hex, salt: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }],
    [deliveryCommit, salt],
  ));
}

export const escrowRecordDigest = (key: Hex, digest: Hex): Hex => decisionRecordDigest(key, digest);
export const escrowLeaf = (key: Hex, digest: Hex): Hex => leafHash(escrowRecordDigest(key, digest));

/**
 * Return a proof from the existing append-only tree, refusing an index that contains another
 * record. This prevents scenario code from accidentally pairing a valid proof with the wrong
 * lock/tag/digest.
 */
export function proofForEscrowRecord(tree: IncrementalTree, index: number, key: Hex, digest: Hex): InclusionProof {
  const expected = escrowLeaf(key, digest);
  if (tree.leaves[index]?.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`tree index ${index} does not contain the escrow leaf`);
  }
  return tree.proof(index);
}

export interface EscrowConstructorProfile {
  log: Address;
  token: Address;
  operatorServiceId: Hex;
  courierServiceId: Hex;
  decisionBlocks: bigint | number;
  handoffBlocks: bigint | number;
  courierBlocks: bigint | number;
  responseBlocks: bigint | number;
  disputeBlocks: bigint | number;
}

export function escrowProfileHash(chainId: bigint | number, escrow: Address, p: EscrowConstructorProfile): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" },
      { type: "uint64" }, { type: "uint64" }, { type: "uint64" },
    ],
    [
      BigInt(chainId), escrow, p.log, p.token, p.operatorServiceId, p.courierServiceId,
      BigInt(p.decisionBlocks), BigInt(p.handoffBlocks), BigInt(p.courierBlocks),
      BigInt(p.responseBlocks), BigInt(p.disputeBlocks),
    ],
  ));
}

type DeployCtx = Omit<ChainCtx, "address">;

export async function deployMockGold(c: DeployCtx): Promise<Address> {
  const hash = await c.wallet.deployContract({ abi: MOCK_GOLD_ABI, bytecode: MOCK_GOLD_BYTECODE, account: c.account, chain: c.chain });
  const receipt = await c.pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("MockGold deployment did not return an address");
  return receipt.contractAddress;
}

export async function deployEscrow(c: DeployCtx, p: EscrowConstructorProfile): Promise<Address> {
  const hash = await c.wallet.deployContract({
    abi: ESCROW_ABI,
    bytecode: ESCROW_BYTECODE,
    account: c.account,
    chain: c.chain,
    args: [p.log, p.token, p.operatorServiceId, p.courierServiceId, BigInt(p.decisionBlocks), BigInt(p.handoffBlocks),
      BigInt(p.courierBlocks), BigInt(p.responseBlocks), BigInt(p.disputeBlocks)],
  });
  const receipt = await c.pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("RedemptionEscrow deployment did not return an address");
  return receipt.contractAddress;
}

async function writeContract(c: ChainCtx, abi: any, functionName: string, args: readonly unknown[]) {
  const { request } = await c.pub.simulateContract({ address: c.address, abi, functionName, args, account: c.account });
  const hash = await c.wallet.writeContract(request as any);
  return c.pub.waitForTransactionReceipt({ hash });
}

export const mockGoldMint = (c: ChainCtx, to: Address, amount: bigint) =>
  writeContract(c, MOCK_GOLD_ABI, "mint", [to, amount]);
export const mockGoldApprove = (c: ChainCtx, spender: Address, amount: bigint) =>
  writeContract(c, MOCK_GOLD_ABI, "approve", [spender, amount]);

export async function escrowLock(c: ChainCtx, amount: bigint, requestHash: Hex) {
  const receipt = await writeContract(c, ESCROW_ABI, "lock", [amount, requestHash]);
  const locked = (parseEventLogs({ abi: ESCROW_ABI, logs: receipt.logs, eventName: "Locked", strict: true }) as any[])
    .filter(event => event.address.toLowerCase() === c.address.toLowerCase()
      && event.args.holder.toLowerCase() === c.account.address.toLowerCase()
      && BigInt(event.args.amount) === amount
      && event.args.requestHash.toLowerCase() === requestHash.toLowerCase());
  if (locked.length !== 1) throw new Error(`expected one matching Locked event, saw ${locked.length}`);
  const lockId = locked[0].args.lockId as Hex;
  return { lockId, receipt };
}

type EscrowProof = Pick<InclusionProof, "index" | "root" | "siblings">;
const proofArgs = (lockId: Hex, digest: Hex, proof: EscrowProof) =>
  [lockId, digest, BigInt(proof.index), proof.root, proof.siblings] as const;

export const escrowProveDecision = (c: ChainCtx, lockId: Hex, digest: Hex, proof: EscrowProof) =>
  writeContract(c, ESCROW_ABI, "proveDecision", proofArgs(lockId, digest, proof));
export const escrowProveHandoff = (c: ChainCtx, lockId: Hex, digest: Hex, proof: EscrowProof) =>
  writeContract(c, ESCROW_ABI, "proveHandoff", proofArgs(lockId, digest, proof));
export const escrowProveDelivery = (c: ChainCtx, lockId: Hex, digest: Hex, proof: EscrowProof) =>
  writeContract(c, ESCROW_ABI, "proveDelivery", proofArgs(lockId, digest, proof));
export const escrowChallenge = (c: ChainCtx, lockId: Hex) => writeContract(c, ESCROW_ABI, "challenge", [lockId]);
export const escrowFinalize = (c: ChainCtx, lockId: Hex) => writeContract(c, ESCROW_ABI, "finalize", [lockId]);
export const escrowReclaim = (c: ChainCtx, lockId: Hex) => writeContract(c, ESCROW_ABI, "reclaim", [lockId]);
export const escrowAcknowledge = (c: ChainCtx, lockId: Hex) => writeContract(c, ESCROW_ABI, "acknowledge", [lockId]);
export const escrowDispute = (c: ChainCtx, lockId: Hex) => writeContract(c, ESCROW_ABI, "dispute", [lockId]);
export const escrowBurn = (c: ChainCtx, lockId: Hex) => writeContract(c, ESCROW_ABI, "burn", [lockId]);

export const readEscrowLock = (pub: ChainCtx["pub"], address: Address, lockId: Hex, blockNumber?: bigint) =>
  pub.readContract({ address, abi: ESCROW_ABI, functionName: "getLock", args: [lockId], blockNumber }) as Promise<any>;
