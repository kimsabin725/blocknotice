// Chain adapter. Two jobs: push leaves to the public log, and rebuild that log from nothing but
// public events so the verifier never has to trust the institution's own copy of the tree.
import { createWalletClient, createPublicClient, http, parseEventLogs, type Address, type Hex, type PublicClient, type WalletClient, type Chain } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { IncrementalTree } from "./merkle.js";
import type { InclusionProof } from "./types.js";
import type { Clock } from "./institution.js";
import type { ChallengeState, VerifyOptions } from "./verify.js";

const here = dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(readFileSync(join(here, "..", "forge-out", "BlockNoticeLog.sol", "BlockNoticeLog.json"), "utf8"));
export const LOG_ABI = artifact.abi as any;
export const LOG_BYTECODE = artifact.bytecode.object as Hex;

export const anvilChain = (id: number, url: string): Chain => ({
  id, name: "local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [url] } },
});

export interface ChainCtx { pub: PublicClient; wallet: WalletClient; account: PrivateKeyAccount; chain: Chain; address: Address; }
/** What a verifier needs: a public RPC and the contract address. No key, no institution. */
export interface ReadCtx { pub: PublicClient; address: Address; }
export const readonlyCtx = (rpcUrl: string, address: Address): ReadCtx =>
  ({ pub: createPublicClient({ transport: http(rpcUrl) }), address });

export async function connect(rpcUrl: string, chain: Chain, privateKey: Hex): Promise<Omit<ChainCtx, "address">> {
  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);
  return { pub: createPublicClient({ chain, transport }), wallet: createWalletClient({ account, chain, transport }), account, chain };
}

export async function deployLog(c: Omit<ChainCtx, "address">): Promise<Address> {
  const hash = await c.wallet.deployContract({ abi: LOG_ABI, bytecode: LOG_BYTECODE, account: c.account, chain: c.chain, args: [] });
  const r = await c.pub.waitForTransactionReceipt({ hash });
  if (!r.contractAddress) throw new Error("deploy failed");
  return r.contractAddress;
}

const write = async (c: ChainCtx, functionName: string, args: unknown[]) => {
  const { request } = await c.pub.simulateContract({ address: c.address, abi: LOG_ABI, functionName, args, account: c.account });
  const hash = await c.wallet.writeContract(request as any);
  return c.pub.waitForTransactionReceipt({ hash });
};

export const registerService = (
  c: ChainCtx, serviceId: Hex, signer: Address, profileHash: Hex,
  challengeResponseBlocks: number, requestRecordBlocks: number, decisionRecordBlocks: number,
) =>
  write(c, "registerService", [
    serviceId, signer, profileHash,
    BigInt(challengeResponseBlocks), BigInt(requestRecordBlocks), BigInt(decisionRecordBlocks),
  ]);

export const appendBatch = (c: ChainCtx, serviceId: Hex, leaves: Hex[]) => write(c, "appendBatch", [serviceId, leaves]);
export const postNotice = (c: ChainCtx, request: unknown, sig: Hex) => write(c, "postNotice", [request, sig]);
export const challengeAccepted = (c: ChainCtx, accepted: unknown, sig: Hex) => write(c, "challengeAccepted", [accepted, sig]);
/** Answer with the decision digest; the contract derives the leaf from the challenge's acceptedDigest. */
export const respond = (c: ChainCtx, id: Hex, decisionDigest: Hex, index: number, root: Hex, siblings: Hex[]) =>
  write(c, "respond", [id, decisionDigest, BigInt(index), root, siblings]);
export const finalize = (c: ChainCtx, id: Hex) => write(c, "finalize", [id]);

export const readService = (c: ReadCtx, serviceId: Hex) =>
  c.pub.readContract({ address: c.address, abi: LOG_ABI, functionName: "getService", args: [serviceId] }) as Promise<any>;
export const readChallenge = (c: ReadCtx, id: Hex) =>
  c.pub.readContract({ address: c.address, abi: LOG_ABI, functionName: "getChallenge", args: [id] }) as Promise<any>;

const CHALLENGE_STATES: ChallengeState[] = ["NONE", "OPEN", "ANSWERED", "UNANSWERED"];
/** The challenge for one acceptance, in the verifier's vocabulary. */
export async function challengeOf(c: ReadCtx, id: Hex): Promise<NonNullable<VerifyOptions["challenge"]>> {
  const ch = await readChallenge(c, id);
  return { state: CHALLENGE_STATES[Number(ch.state)] ?? "NONE", answeredLate: Boolean(ch.answeredLate), responseDueBlock: BigInt(ch.responseDueBlock) };
}

/**
 * Everything the verifier takes from the chain for one acceptance, read with nothing but a public
 * RPC: the registration, the log rebuilt from events, the current height, and the challenge state.
 * The institution is not consulted and need not exist any more.
 */
export async function observe(c: ReadCtx, serviceId: Hex, challengeId: Hex): Promise<{
  opts: Required<Pick<VerifyOptions, "publicLog" | "registry" | "currentBlock" | "challenge">>;
  log: Awaited<ReturnType<typeof reconstructLog>>;
}> {
  const [svc, log, chainId, currentBlock, challenge] = await Promise.all([
    readService(c, serviceId), reconstructLog(c, serviceId), c.pub.getChainId(), c.pub.getBlockNumber({ cacheTime: 0 }), challengeOf(c, challengeId),
  ]);
  return {
    opts: {
      registry: { serviceId, signer: svc.signer as Address, profileHash: svc.profileHash as Hex, treeId: svc.treeId as Hex, chainId, verifyingContract: c.address },
      publicLog: { treeId: log.treeId, root: log.root, size: log.size },
      currentBlock, challenge,
    },
    log,
  };
}

/**
 * Rebuild the whole log from `Appended` events alone — no institution endpoint, no trust in the
 * bundle's own proofs. Returns the reconstructed root next to the root the contract reports, so a
 * mismatch (an event the contract never accepted, or a leaf order that does not replay) is visible.
 */
export async function reconstructLog(c: ReadCtx, serviceId: Hex, fromBlock: bigint = 0n): Promise<{
  treeId: Hex; leaves: Hex[]; root: Hex; size: number; onChainRoot: Hex; onChainSize: number; agrees: boolean;
  proofFor: (index: number) => InclusionProof;
}> {
  const logs = await c.pub.getLogs({ address: c.address, fromBlock, toBlock: "latest" });
  const events = parseEventLogs({ abi: LOG_ABI, logs, eventName: "Appended" })
    .filter((e: any) => (e.args.serviceId as string).toLowerCase() === serviceId.toLowerCase())
    .sort((a: any, b: any) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber));

  const svc = await readService(c, serviceId);
  const tree = new IncrementalTree(svc.treeId as Hex);
  let expected = 0;
  for (const e of events as any[]) {
    if (Number(e.args.startIndex) !== expected) throw new Error(`gap in log: expected startIndex ${expected}, saw ${e.args.startIndex}`);
    for (const leaf of e.args.leaves as Hex[]) tree.append(leaf);
    expected = tree.size;
    if (tree.root().toLowerCase() !== (e.args.newRoot as string).toLowerCase()) throw new Error(`replayed root differs from the root the contract emitted at index ${e.args.startIndex}`);
  }
  const root = tree.root();
  return {
    treeId: svc.treeId as Hex, leaves: tree.leaves.slice(), root, size: tree.size,
    onChainRoot: svc.root as Hex, onChainSize: Number(svc.size),
    agrees: root.toLowerCase() === (svc.root as string).toLowerCase() && tree.size === Number(svc.size),
    proofFor: (i: number) => tree.proof(i),
  };
}

/** Push every leaf the institution has produced but not yet anchored. Batches of `batchSize`. */
export async function anchorPending(c: ChainCtx, serviceId: Hex, localLeaves: Hex[], alreadyAnchored: number, batchSize = 16) {
  const pending = localLeaves.slice(alreadyAnchored);
  const receipts = [];
  for (let i = 0; i < pending.length; i += batchSize) {
    receipts.push(await appendBatch(c, serviceId, pending.slice(i, i + batchSize)));
  }
  return receipts;
}

/**
 * A clock backed by the real chain. The institution's deadlines are block numbers the contract will
 * later compare against `block.number`, so they must come from the same chain — a local counter
 * produces receipts whose deadlines are already in the past (or unreachably far) on chain.
 */
export interface SyncedClock extends Clock { sync: () => Promise<bigint>; }
export async function chainClock(pub: PublicClient): Promise<SyncedClock> {
  let b = await pub.getBlockNumber();
  return {
    block: () => b,
    now: () => BigInt(Math.floor(Date.now() / 1000)),
    sync: async () => { b = await pub.getBlockNumber({ cacheTime: 0 }); return b; },
  };
}

/** Mine `n` empty blocks on a local dev chain (test/demo only). */
export async function mine(pub: PublicClient, n: number) {
  await (pub as any).request({ method: "anvil_mine", params: [`0x${n.toString(16)}`] });
}
