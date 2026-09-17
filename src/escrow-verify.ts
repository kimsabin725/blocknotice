import { parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import type { Check, Status } from "./verify.js";
import {
  ESCROW_ABI,
  escrowDecisionDigest,
  escrowDeliveryDigest,
  escrowDeliveryKey,
  escrowHandoffDigest,
  escrowHandoffKey,
  escrowLeaf,
  escrowProfileHash,
} from "./escrow.js";
import { LOG_ABI } from "./chain.js";
import { IncrementalTree, rootOf } from "./merkle.js";

export const ESCROW_STATES = [
  "NONE", "LOCKED", "OP_CHALLENGED", "DECIDED", "HANDED_OFF", "COURIER_CHALLENGED",
  "DELIVERED", "BURNED", "RETURNED", "STALLED", "DISPUTED",
] as const;
export type EscrowState = typeof ESCROW_STATES[number];

export interface EscrowProfile {
  log: Address;
  token: Address;
  operatorServiceId: Hex;
  courierServiceId: Hex;
  decisionBlocks: bigint;
  handoffBlocks: bigint;
  courierBlocks: bigint;
  responseBlocks: bigint;
  disputeBlocks: bigint;
  profileHash: Hex;
}

export interface EscrowLockSnapshot {
  holder: Address;
  amount: bigint;
  requestHash: Hex;
  lockBlock: bigint;
  handoffAnchorBlock: bigint;
  deliveryAnchorBlock: bigint;
  deliveryProvenBlock: bigint;
  responseDueBlock: bigint;
  state: EscrowState;
}

export interface RegisteredEscrowService { exists: boolean; serviceId: Hex; treeId: Hex; }
export interface ServiceLogReplay {
  serviceId: Hex;
  treeId: Hex;
  leaves: Hex[];
  roots: Array<{ root: Hex; size: number; blockNumber: bigint }>;
  onChainRoot: Hex;
  onChainSize: number;
  agrees: boolean;
}

export type EscrowEventName =
  | "Locked" | "DecisionProven" | "HandoffProven" | "DeliveryProven"
  | "ChallengeOpened" | "ChallengeUnanswered" | "Returned" | "Disputed" | "Burned";
export interface EscrowLifecycleEvent {
  name: EscrowEventName;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  args: Record<string, unknown>;
}

export interface EscrowObservation {
  pinnedBlock: bigint;
  chainId: number;
  escrowAddress: Address;
  profile: EscrowProfile;
  services: { operator: RegisteredEscrowService; courier: RegisteredEscrowService };
  lockId: Hex;
  lock: EscrowLockSnapshot;
  events: EscrowLifecycleEvent[];
  logs: { operator: ServiceLogReplay; courier: ServiceLogReplay };
  observationErrors: string[];
  /** Logical public RPC operations made by the observer. */
  publicRpcCalls: number;
  /** Measured non-public-RPC fetches. The observer never needs an institution endpoint. */
  institutionNetworkCalls: number;
}

export interface EscrowOpenings {
  decision?: { outcome: number; category: Hex; reasonCommit: Hex; salt: Hex };
  handoff?: { courierServiceId: Hex; handoffCommit: Hex; salt: Hex };
  delivery?: { deliveryCommit: Hex; salt: Hex };
}

export interface EscrowVerifyReport {
  lockId: Hex;
  pinnedBlock: bigint;
  state: EscrowState;
  checks: Check[];
  hops: { operator: Check; courier: Check };
  publicRpcCalls: number;
  institutionNetworkCalls: number;
  summary: Record<Status, number>;
}

export interface EscrowReadCtx { pub: PublicClient; address: Address; }
export interface ObserveEscrowOptions { blockNumber?: bigint; fromBlock?: bigint; }

const eq = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const check = (id: string, status: Status, detail: string): Check => ({ id, status, detail });

function replayLifecycle(observation: EscrowObservation): {
  state: EscrowState;
  valid: boolean;
  problems: string[];
  decision?: EscrowLifecycleEvent;
  handoff?: EscrowLifecycleEvent;
  delivery?: EscrowLifecycleEvent;
  unansweredOperator: boolean;
  unansweredCourier: boolean;
  lastChallenge?: EscrowLifecycleEvent;
} {
  let state: EscrowState = "NONE";
  let decision: EscrowLifecycleEvent | undefined;
  let handoff: EscrowLifecycleEvent | undefined;
  let delivery: EscrowLifecycleEvent | undefined;
  let unansweredOperator = false;
  let unansweredCourier = false;
  let lastChallenge: EscrowLifecycleEvent | undefined;
  let pendingReturned: EscrowLifecycleEvent | undefined;
  const problems: string[] = [];
  let previousBlock = -1n;
  let previousLogIndex = -1;

  for (const event of observation.events) {
    if (!eq(event.args.lockId, observation.lockId)) problems.push(`${event.name} names another lock`);
    if (event.blockNumber < previousBlock || (event.blockNumber === previousBlock && event.logIndex <= previousLogIndex)) {
      problems.push(`${event.name} is out of event order`);
    }
    previousBlock = event.blockNumber;
    previousLogIndex = event.logIndex;
    const before: EscrowState = state;
    switch (event.name) {
      case "Locked":
        if (state !== "NONE") problems.push("duplicate or reordered Locked event");
        else state = "LOCKED";
        break;
      case "DecisionProven":
        if (state !== "LOCKED" && state !== "OP_CHALLENGED") problems.push(`DecisionProven cannot follow ${state}`);
        else {
          if (state === "OP_CHALLENGED" && event.blockNumber > BigInt(lastChallenge?.args.responseDueBlock as bigint)) problems.push("DecisionProven is after the challenge response window");
          state = "DECIDED"; decision = event;
        }
        break;
      case "HandoffProven":
        if (state !== "DECIDED") problems.push(`HandoffProven cannot follow ${state}`);
        else { if (event.blockNumber > observation.lock.lockBlock + observation.profile.handoffBlocks) problems.push("HandoffProven is after the strict handoff cutoff"); state = "HANDED_OFF"; handoff = event; }
        break;
      case "DeliveryProven":
        if (state !== "HANDED_OFF" && state !== "COURIER_CHALLENGED") problems.push(`DeliveryProven cannot follow ${state}`);
        else {
          if (state === "COURIER_CHALLENGED" && event.blockNumber > BigInt(lastChallenge?.args.responseDueBlock as bigint)) problems.push("DeliveryProven is after the challenge response window");
          state = "DELIVERED"; delivery = event;
        }
        break;
      case "ChallengeOpened": {
        const hop = Number(event.args.hop);
        if (BigInt(event.args.responseDueBlock as bigint) !== event.blockNumber + observation.profile.responseBlocks) problems.push("ChallengeOpened response due is not derived from its block");
        if (hop === 0 && state === "LOCKED") {
          if (event.blockNumber <= observation.lock.lockBlock + observation.profile.decisionBlocks) problems.push("operator challenge opened before decision due");
          state = "OP_CHALLENGED";
        }
        else if (hop === 1 && state === "HANDED_OFF") {
          if (event.blockNumber <= observation.lock.handoffAnchorBlock + observation.profile.courierBlocks) problems.push("courier challenge opened before delivery due");
          state = "COURIER_CHALLENGED";
        }
        else problems.push(`ChallengeOpened hop ${hop} cannot follow ${state}`);
        lastChallenge = event;
        break;
      }
      case "ChallengeUnanswered": {
        const hop = Number(event.args.hop);
        const responseDue = lastChallenge?.args.responseDueBlock;
        if (responseDue === undefined) problems.push("ChallengeUnanswered has no preceding ChallengeOpened deadline");
        else if (event.blockNumber <= BigInt(responseDue as bigint)) problems.push("ChallengeUnanswered is inside the response window");
        if (hop === 0 && state === "OP_CHALLENGED") { state = "RETURNED"; unansweredOperator = true; pendingReturned = event; }
        else if (hop === 1 && state === "COURIER_CHALLENGED") { state = "STALLED"; unansweredCourier = true; }
        else problems.push(`ChallengeUnanswered hop ${hop} cannot follow ${state}`);
        break;
      }
      case "Returned":
        if (state === "DECIDED") { if (event.blockNumber <= observation.lock.lockBlock + observation.profile.handoffBlocks) problems.push("reclaim Returned is before handoff due"); state = "RETURNED"; }
        else if (state === "RETURNED" && pendingReturned && event.blockNumber === pendingReturned.blockNumber && event.transactionHash === pendingReturned.transactionHash) pendingReturned = undefined;
        else problems.push(`Returned cannot follow ${state}`);
        break;
      case "Disputed":
        if (state !== "DELIVERED") problems.push(`Disputed cannot follow ${state}`);
        else { if (event.blockNumber > (delivery?.blockNumber ?? 0n) + observation.profile.disputeBlocks) problems.push("Disputed is after the dispute window"); state = "DISPUTED"; }
        break;
      case "Burned":
        if (state !== "DELIVERED" && state !== "DISPUTED") problems.push(`Burned cannot follow ${state}`);
        else {
          const byAck = Boolean(event.args.byAck);
          if (state === "DISPUTED" && !byAck) problems.push("a disputed lock can only burn by holder acknowledgement");
          if (!byAck && event.blockNumber <= (delivery?.blockNumber ?? 0n) + observation.profile.disputeBlocks) problems.push("permissionless burn is inside the dispute window");
          state = "BURNED";
        }
        break;
    }
    if (problems.length && state === before && event.name !== "Locked") continue;
  }
  if (pendingReturned) problems.push("operator ChallengeUnanswered is missing its same-transaction Returned event");
  return { state, valid: problems.length === 0, problems, decision, handoff, delivery, unansweredOperator, unansweredCourier, lastChallenge };
}

function proofEventCheck(
  id: string,
  event: EscrowLifecycleEvent | undefined,
  replay: ServiceLogReplay,
  key: Hex,
): Check {
  if (!event) return check(id, "UNVERIFIABLE", "no public proof event was observed");
  const digest = event.args.digest as Hex | undefined;
  const leaf = event.args.leaf as Hex | undefined;
  const root = event.args.root as Hex | undefined;
  const index = Number(event.args.index);
  if (!leaf || !root || !Number.isSafeInteger(index) || index < 0) {
    return check(id, "UNVERIFIABLE", "proof event fields are incomplete or malformed");
  }
  // Current events expose the leaf but keep the digest private. If calldata-derived evidence includes
  // a digest, bind it here; otherwise the emitting escrow's code and the replayed public log establish
  // recording, while plaintext/opening verification remains a separate check below.
  if (digest && !eq(leaf, escrowLeaf(key, digest))) return check(id, "UNVERIFIABLE", "event leaf does not bind its lock/tag and digest");
  const snapshot = replay.roots.find(r => eq(r.root, root));
  if (!snapshot) return check(id, "UNVERIFIABLE", "proof root is absent from the service's replayed Appended history");
  if (snapshot.blockNumber > event.blockNumber) return check(id, "UNVERIFIABLE", "proof event predates the root it cites");
  if (index >= snapshot.size || !eq(replay.leaves[index], leaf)) {
    return check(id, "UNVERIFIABLE", "the replayed public log does not contain this leaf at the claimed index/root");
  }
  return check(id, "CONFIRMED", `public ${event.name} cites index ${index} in a replayed service root`);
}

function consistencyCheck(observation: EscrowObservation, replay: ReturnType<typeof replayLifecycle>): Check {
  const locked = observation.events.find(e => e.name === "Locked");
  const problems = [...observation.observationErrors, ...replay.problems];
  if (!eq(escrowProfileHash(observation.chainId, observation.escrowAddress, observation.profile), observation.profile.profileHash)) problems.push("immutable escrow profile hash mismatch");
  if (observation.events.some(e => e.blockNumber > observation.pinnedBlock)) problems.push("lifecycle contains an event after the pinned block");
  if ([...observation.logs.operator.roots, ...observation.logs.courier.roots].some(r => r.blockNumber > observation.pinnedBlock)) problems.push("service replay contains a root after the pinned block");
  if (!observation.services.operator.exists) problems.push("operator service is not registered");
  if (!observation.services.courier.exists) problems.push("courier service is not registered");
  if (!eq(observation.services.operator.serviceId, observation.profile.operatorServiceId)) problems.push("operator service ID mismatch");
  if (!eq(observation.services.courier.serviceId, observation.profile.courierServiceId)) problems.push("courier service ID mismatch");
  if (!eq(observation.logs.operator.serviceId, observation.profile.operatorServiceId)) problems.push("operator replay service ID mismatch");
  if (!eq(observation.logs.courier.serviceId, observation.profile.courierServiceId)) problems.push("courier replay service ID mismatch");
  if (!eq(observation.services.operator.treeId, observation.logs.operator.treeId)) problems.push("operator tree ID mismatch");
  if (!eq(observation.services.courier.treeId, observation.logs.courier.treeId)) problems.push("courier tree ID mismatch");
  if (!observation.logs.operator.agrees) problems.push("operator Appended replay disagrees with getService");
  if (!observation.logs.courier.agrees) problems.push("courier Appended replay disagrees with getService");
  problems.push(...validateServiceReplay(observation.logs.operator).map(p => `operator ${p}`));
  problems.push(...validateServiceReplay(observation.logs.courier).map(p => `courier ${p}`));
  if (!locked) problems.push("Locked event is missing");
  else {
    if (!eq(locked.args.holder, observation.lock.holder)) problems.push("holder differs from Locked event");
    if (BigInt(locked.args.amount as bigint) !== observation.lock.amount) problems.push("amount differs from Locked event");
    if (!eq(locked.args.requestHash, observation.lock.requestHash)) problems.push("requestHash differs from Locked event");
    if (locked.blockNumber !== observation.lock.lockBlock) problems.push("lockBlock differs from Locked event block");
  }
  if (replay.state !== observation.lock.state) problems.push(`event state ${replay.state} differs from getLock state ${observation.lock.state}`);

  const anchorOf = (event: EscrowLifecycleEvent | undefined, log: ServiceLogReplay) => {
    if (!event) return 0n;
    return log.roots.find(r => eq(r.root, event.args.root))?.blockNumber ?? -1n;
  };
  const decisionAnchor = anchorOf(replay.decision, observation.logs.operator);
  const handoffAnchor = anchorOf(replay.handoff, observation.logs.operator);
  const deliveryAnchor = anchorOf(replay.delivery, observation.logs.courier);
  if (replay.decision && (decisionAnchor < observation.lock.lockBlock || decisionAnchor > replay.decision.blockNumber)) problems.push("decision anchor order is impossible");
  if (replay.decision && Boolean(replay.decision.args.late) !== (decisionAnchor > observation.lock.lockBlock + observation.profile.decisionBlocks)) problems.push("decision late flag mismatch");
  if (replay.handoff && (handoffAnchor < observation.lock.lockBlock || handoffAnchor > replay.handoff.blockNumber)) problems.push("handoff anchor order is impossible");
  if (replay.handoff && Boolean(replay.handoff.args.late) !== (handoffAnchor > observation.lock.lockBlock + observation.profile.handoffBlocks)) problems.push("handoff late flag mismatch");
  if (replay.delivery && (deliveryAnchor < observation.lock.handoffAnchorBlock || deliveryAnchor > replay.delivery.blockNumber)) problems.push("delivery anchor order is impossible");
  if (replay.delivery && Boolean(replay.delivery.args.late) !== (deliveryAnchor > observation.lock.handoffAnchorBlock + observation.profile.courierBlocks)) problems.push("delivery late flag mismatch");
  if (handoffAnchor !== observation.lock.handoffAnchorBlock) problems.push("handoff anchor block mismatch");
  if (deliveryAnchor !== observation.lock.deliveryAnchorBlock) problems.push("delivery anchor block mismatch");
  if ((replay.delivery?.blockNumber ?? 0n) !== observation.lock.deliveryProvenBlock) problems.push("delivery proof block mismatch");
  const expectedResponseDue = replay.state === "OP_CHALLENGED" || replay.state === "COURIER_CHALLENGED" || replay.unansweredOperator || replay.unansweredCourier
    ? BigInt(replay.lastChallenge?.args.responseDueBlock as bigint ?? 0n) : 0n;
  if (expectedResponseDue !== observation.lock.responseDueBlock) problems.push("challenge response due block mismatch");
  return problems.length
    ? check("lifecycle.consistency", "UNVERIFIABLE", problems.join("; "))
    : check("lifecycle.consistency", "CONFIRMED", "ordered public events agree with the pinned getLock snapshot and service logs");
}

function openingCheck(openings: EscrowOpenings | undefined, replay: ReturnType<typeof replayLifecycle>): Check {
  if (!openings) return check("records.opening", "UNVERIFIABLE", "private record openings were not supplied; public recording checks remain independent");
  const mismatches: string[] = [];
  const compare = (event: EscrowLifecycleEvent | undefined, key: Hex, digest: Hex | undefined, label: string) => {
    if (event && (!digest || !eq(event.args.leaf, escrowLeaf(key, digest)))) mismatches.push(label);
  };
  const lockId = replay.decision?.args.lockId as Hex | undefined
    ?? replay.handoff?.args.lockId as Hex | undefined
    ?? replay.delivery?.args.lockId as Hex | undefined;
  if (!lockId) return check("records.opening", "UNVERIFIABLE", "no public proof event is available to compare with private openings");
  compare(replay.decision, lockId, openings.decision && escrowDecisionDigest(openings.decision.outcome, openings.decision.category, openings.decision.reasonCommit, openings.decision.salt), "decision");
  compare(replay.handoff, escrowHandoffKey(lockId), openings.handoff && escrowHandoffDigest(openings.handoff.courierServiceId, openings.handoff.handoffCommit, openings.handoff.salt), "handoff");
  compare(replay.delivery, escrowDeliveryKey(lockId), openings.delivery && escrowDeliveryDigest(openings.delivery.deliveryCommit, openings.delivery.salt), "delivery");
  return mismatches.length
    ? check("records.opening", "UNVERIFIABLE", `missing or mismatched private opening: ${mismatches.join(", ")}`)
    : check("records.opening", "CONFIRMED", "supplied private openings hash to the public proof digests");
}

export function verifyEscrowObservation(observation: EscrowObservation, openings?: EscrowOpenings): EscrowVerifyReport {
  const replay = replayLifecycle(observation);
  const consistency = consistencyCheck(observation, replay);
  const decisionProof = proofEventCheck("operator.decisionRecord", replay.decision, observation.logs.operator, observation.lockId);
  const handoffProof = proofEventCheck("operator.handoffRecord", replay.handoff, observation.logs.operator, escrowHandoffKey(observation.lockId));
  const deliveryProof = proofEventCheck("courier.deliveryRecord", replay.delivery, observation.logs.courier, escrowDeliveryKey(observation.lockId));
  const evidenceCoherent = consistency.status === "CONFIRMED";

  let operator: Check;
  if (!evidenceCoherent) operator = check("operator.hop", "UNVERIFIABLE", "public lifecycle evidence is incomplete or inconsistent");
  else if (replay.unansweredOperator) operator = check("operator.hop", "OBLIGATION_UNMET", "the public operator challenge finalized unanswered");
  else if (decisionProof.status === "CONFIRMED" && (!replay.handoff || handoffProof.status === "CONFIRMED")) {
    operator = check("operator.hop", "CONFIRMED", replay.handoff ? "decision and handoff records are in the operator log" : "decision record is in the operator log");
  } else if (observation.lock.state === "LOCKED" && observation.pinnedBlock <= observation.lock.lockBlock + observation.profile.decisionBlocks) {
    operator = check("operator.hop", "NOT_DUE", `decision is due by block ${observation.lock.lockBlock + observation.profile.decisionBlocks}`);
  } else if (observation.lock.state === "OP_CHALLENGED" && observation.pinnedBlock <= observation.lock.responseDueBlock) {
    operator = check("operator.hop", "NOT_DUE", `operator challenge response is due by block ${observation.lock.responseDueBlock}`);
  } else operator = check("operator.hop", "UNVERIFIABLE", "no finalized public evidence establishes operator non-recording");

  let courier: Check;
  if (!evidenceCoherent) courier = check("courier.hop", "UNVERIFIABLE", "public lifecycle evidence is incomplete or inconsistent");
  else if (replay.unansweredCourier) courier = check("courier.hop", "OBLIGATION_UNMET", "the public courier challenge finalized unanswered");
  else if (deliveryProof.status === "CONFIRMED") courier = check("courier.hop", "CONFIRMED", "delivery record is in the courier log");
  else if (replay.delivery) courier = check("courier.hop", "UNVERIFIABLE", "a delivery proof event exists but does not match the replayed courier log");
  else if (!replay.handoff) courier = check("courier.hop", "NOT_DUE", "courier obligation has not started because no handoff record is proven");
  else if (observation.lock.state === "COURIER_CHALLENGED" && observation.pinnedBlock <= observation.lock.responseDueBlock) {
    courier = check("courier.hop", "NOT_DUE", `courier challenge response is due by block ${observation.lock.responseDueBlock}`);
  } else if (observation.pinnedBlock <= observation.lock.handoffAnchorBlock + observation.profile.courierBlocks) {
    courier = check("courier.hop", "NOT_DUE", `delivery record is due by block ${observation.lock.handoffAnchorBlock + observation.profile.courierBlocks}`);
  } else courier = check("courier.hop", "UNVERIFIABLE", "no finalized public evidence establishes courier non-recording");

  const checks: Check[] = [consistency, decisionProof, handoffProof, deliveryProof, openingCheck(openings, replay), operator, courier];
  if (replay.delivery) checks.push(check("delivery.physical", "OUT_OF_SCOPE", "a public delivery record is not proof that physical delivery occurred"));
  if (observation.lock.state === "DISPUTED" || observation.events.some(e => e.name === "Disputed")) {
    checks.push(check("dispute.merits", "OUT_OF_SCOPE", "the dispute's merits require evidence outside the public escrow events"));
  }
  const summary: Record<Status, number> = { CONFIRMED: 0, NOT_DUE: 0, OBLIGATION_UNMET: 0, UNVERIFIABLE: 0, OUT_OF_SCOPE: 0 };
  for (const item of checks) summary[item.status]++;
  return {
    lockId: observation.lockId,
    pinnedBlock: observation.pinnedBlock,
    state: observation.lock.state,
    checks,
    hops: { operator, courier },
    publicRpcCalls: observation.publicRpcCalls,
    institutionNetworkCalls: observation.institutionNetworkCalls,
    summary,
  };
}

function normalizeLock(raw: any): EscrowLockSnapshot {
  const field = (name: string, index: number) => raw?.[name] ?? raw?.[index];
  const stateNumber = Number(field("state", 8));
  return {
    holder: field("holder", 0) as Address,
    amount: BigInt(field("amount", 1)),
    requestHash: field("requestHash", 2) as Hex,
    lockBlock: BigInt(field("lockBlock", 3)),
    handoffAnchorBlock: BigInt(field("handoffAnchorBlock", 4)),
    deliveryAnchorBlock: BigInt(field("deliveryAnchorBlock", 5)),
    deliveryProvenBlock: BigInt(field("deliveryProvenBlock", 6)),
    responseDueBlock: BigInt(field("responseDueBlock", 7)),
    state: ESCROW_STATES[stateNumber] ?? "NONE",
  };
}

function serviceField(raw: any, name: string, index: number) { return raw?.[name] ?? raw?.[index]; }

export function validateServiceReplay(log: ServiceLogReplay): string[] {
  const problems: string[] = [];
  if (log.onChainSize !== log.leaves.length) problems.push("replayed leaf count differs from on-chain size");
  if (!eq(rootOf(log.leaves), log.onChainRoot)) problems.push("replayed leaves do not reconstruct the on-chain root");
  let priorSize = 0;
  let priorBlock = -1n;
  for (const snapshot of log.roots) {
    if (!Number.isSafeInteger(snapshot.size) || snapshot.size <= priorSize || snapshot.size > log.leaves.length) {
      problems.push("root snapshot sizes are not strictly increasing within the replayed leaves");
      continue;
    }
    if (!eq(rootOf(log.leaves.slice(0, snapshot.size)), snapshot.root)) problems.push(`root snapshot at size ${snapshot.size} does not reconstruct from leaves`);
    if (snapshot.blockNumber < priorBlock) problems.push("root snapshot blocks are out of order");
    priorSize = snapshot.size;
    priorBlock = snapshot.blockNumber;
  }
  if (log.roots.length && log.roots.at(-1)!.size !== log.leaves.length) problems.push("final root snapshot does not cover all replayed leaves");
  return problems;
}

export function replayServiceLog(
  serviceId: Hex,
  service: any,
  appended: any[],
  observationErrors: string[],
): ServiceLogReplay {
  const treeId = serviceField(service, "treeId", 3) as Hex;
  const tree = new IncrementalTree(treeId);
  const roots: ServiceLogReplay["roots"] = [];
  let agrees = true;
  for (const event of appended) {
    const startIndex = Number(event.args.startIndex);
    if (startIndex !== tree.size) {
      agrees = false;
      observationErrors.push(`${serviceId}: Appended gap, expected ${tree.size}, saw ${startIndex}`);
      continue;
    }
    for (const leaf of event.args.leaves as Hex[]) tree.append(leaf);
    const computed = tree.root();
    if (!eq(computed, event.args.newRoot)) {
      agrees = false;
      observationErrors.push(`${serviceId}: Appended root does not replay at index ${startIndex}`);
      continue;
    }
    roots.push({ root: computed, size: tree.size, blockNumber: event.blockNumber });
  }
  const onChainRoot = serviceField(service, "root", 8) as Hex;
  const onChainSize = Number(serviceField(service, "size", 7));
  agrees = agrees && eq(tree.root(), onChainRoot) && tree.size === onChainSize;
  if (!agrees && !observationErrors.some(e => e.startsWith(`${serviceId}:`))) {
    observationErrors.push(`${serviceId}: replayed Appended state disagrees with pinned getService`);
  }
  return { serviceId, treeId, leaves: tree.leaves.slice(), roots, onChainRoot, onChainSize, agrees };
}

/**
 * Observe one lock at a single pinned block. All trust-bearing data comes from the escrow, its
 * configured BlockNoticeLog, and those contracts' public events. No institution endpoint exists in
 * this path.
 */
export async function observeEscrow(
  c: EscrowReadCtx,
  lockId: Hex,
  options: ObserveEscrowOptions = {},
): Promise<EscrowObservation> {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let publicRpcFetchCalls = 0;
  let rpcDepth = 0;
  let logicalRpcCalls = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    fetchCalls++;
    if (rpcDepth > 0) publicRpcFetchCalls++;
    return originalFetch(...args);
  }) as typeof fetch;
  const rpc = async <T>(operation: () => Promise<T>): Promise<T> => {
    logicalRpcCalls++;
    rpcDepth++;
    try { return await operation(); } finally { rpcDepth--; }
  };

  try {
    const pinnedBlock = options.blockNumber ?? await rpc(() => c.pub.getBlockNumber({ cacheTime: 0 }));
    const blockNumber = { blockNumber: pinnedBlock } as const;
    const readEscrow = (functionName: string, args: readonly unknown[] = []) => rpc(() => c.pub.readContract({
      address: c.address, abi: ESCROW_ABI, functionName, args, ...blockNumber,
    }) as Promise<any>);

    const [chainId, log, token, operatorServiceId, courierServiceId, decisionBlocks, handoffBlocks,
      courierBlocks, responseBlocks, disputeBlocks, profileHash, rawLock] = await Promise.all([
      rpc(() => c.pub.getChainId()), readEscrow("log"), readEscrow("token"), readEscrow("operatorServiceId"),
      readEscrow("courierServiceId"), readEscrow("decisionBlocks"), readEscrow("handoffBlocks"),
      readEscrow("courierBlocks"), readEscrow("responseBlocks"), readEscrow("disputeBlocks"),
      readEscrow("profileHash"), readEscrow("getLock", [lockId]),
    ]);
    const profile: EscrowProfile = {
      log: log as Address,
      token: token as Address,
      operatorServiceId: operatorServiceId as Hex,
      courierServiceId: courierServiceId as Hex,
      decisionBlocks: BigInt(decisionBlocks),
      handoffBlocks: BigInt(handoffBlocks),
      courierBlocks: BigInt(courierBlocks),
      responseBlocks: BigInt(responseBlocks),
      disputeBlocks: BigInt(disputeBlocks),
      profileHash: profileHash as Hex,
    };
    const readService = (serviceId: Hex) => rpc(() => c.pub.readContract({
      address: profile.log, abi: LOG_ABI, functionName: "getService", args: [serviceId], ...blockNumber,
    }) as Promise<any>);
    const [operatorService, courierService, escrowRawLogs, logRawLogs] = await Promise.all([
      readService(profile.operatorServiceId), readService(profile.courierServiceId),
      rpc(() => c.pub.getLogs({ address: c.address, fromBlock: options.fromBlock ?? 0n, toBlock: pinnedBlock })),
      rpc(() => c.pub.getLogs({ address: profile.log, fromBlock: options.fromBlock ?? 0n, toBlock: pinnedBlock })),
    ]);

    const observationErrors: string[] = [];
    const expectedProfileHash = escrowProfileHash(chainId, c.address, profile);
    if (!eq(expectedProfileHash, profile.profileHash)) observationErrors.push("immutable profile hash does not match the public profile fields");

    const appended = parseEventLogs({ abi: LOG_ABI, logs: logRawLogs, eventName: "Appended", strict: true }) as any[];
    const forService = (serviceId: Hex) => appended
      .filter(e => eq(e.args.serviceId, serviceId))
      .sort((a, b) => a.blockNumber === b.blockNumber ? Number(a.logIndex) - Number(b.logIndex) : a.blockNumber < b.blockNumber ? -1 : 1);
    const operatorLog = replayServiceLog(profile.operatorServiceId, operatorService, forService(profile.operatorServiceId), observationErrors);
    const courierLog = replayServiceLog(profile.courierServiceId, courierService, forService(profile.courierServiceId), observationErrors);

    const parsedEscrow = parseEventLogs({ abi: ESCROW_ABI, logs: escrowRawLogs, strict: true }) as any[];
    const wantedNames = new Set<EscrowEventName>([
      "Locked", "DecisionProven", "HandoffProven", "DeliveryProven", "ChallengeOpened",
      "ChallengeUnanswered", "Returned", "Disputed", "Burned",
    ]);
    const events = parsedEscrow
      .filter(event => wantedNames.has(event.eventName as EscrowEventName) && eq(event.args.lockId, lockId))
      .map(event => ({
        name: event.eventName as EscrowEventName,
        blockNumber: event.blockNumber,
        logIndex: Number(event.logIndex),
        transactionHash: event.transactionHash as Hex,
        args: event.args as Record<string, unknown>,
      }))
      .sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);

    return {
      pinnedBlock,
      chainId,
      escrowAddress: c.address,
      profile,
      services: {
        operator: {
          exists: Boolean(serviceField(operatorService, "exists", 9)),
          serviceId: profile.operatorServiceId,
          treeId: serviceField(operatorService, "treeId", 3) as Hex,
        },
        courier: {
          exists: Boolean(serviceField(courierService, "exists", 9)),
          serviceId: profile.courierServiceId,
          treeId: serviceField(courierService, "treeId", 3) as Hex,
        },
      },
      lockId,
      lock: normalizeLock(rawLock),
      events,
      logs: { operator: operatorLog, courier: courierLog },
      observationErrors,
      publicRpcCalls: publicRpcFetchCalls || logicalRpcCalls,
      institutionNetworkCalls: Math.max(0, fetchCalls - publicRpcFetchCalls),
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export async function verifyEscrow(
  c: EscrowReadCtx,
  lockId: Hex,
  options: ObserveEscrowOptions & { openings?: EscrowOpenings } = {},
): Promise<EscrowVerifyReport> {
  const observation = await observeEscrow(c, lockId, options);
  return verifyEscrowObservation(observation, options.openings);
}
