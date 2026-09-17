import { parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import type { Check, Status } from "./verify.js";
import { replayServiceLog, validateServiceReplay, type RegisteredEscrowService, type ServiceLogReplay, type EscrowVerifyReport } from "./escrow-verify.js";
import { INBOX_ABI, inboxProfileHash, inboxRejectionLeaf, inboxRequestDigest, type InboxRequest } from "./inbox.js";
import { LOG_ABI } from "./chain.js";

export const INBOX_STATES = ["NONE", "SUBMITTED", "CHALLENGED", "FORWARDED", "REJECTED", "UNANSWERED"] as const;
export type InboxState = typeof INBOX_STATES[number];

export interface InboxProfile {
  log: Address;
  escrow: Address;
  token: Address;
  forwardBlocks: bigint;
  responseBlocks: bigint;
  profileHash: Hex;
}

export interface InboxRequestSnapshot extends InboxRequest {
  exchangeOperator: Address;
  submittedBlock: bigint;
  responseDueBlock: bigint;
  lockId: Hex;
  state: InboxState;
}

export type InboxEventName = "Submitted" | "Forwarded" | "RejectionProven" | "ChallengeOpened" | "ChallengeUnanswered";
export interface InboxLifecycleEvent {
  name: InboxEventName;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  args: Record<string, unknown>;
}

export interface InboxObservation {
  pinnedBlock: bigint;
  chainId: number;
  inboxAddress: Address;
  profile: InboxProfile;
  exchangeService: RegisteredEscrowService & { operator: Address };
  requestId: Hex;
  request: InboxRequestSnapshot;
  events: InboxLifecycleEvent[];
  exchangeLog: ServiceLogReplay;
  observationErrors: string[];
  publicRpcCalls: number;
  institutionNetworkCalls: number;
}

export interface InboxVerifyReport {
  requestId: Hex;
  pinnedBlock: bigint;
  state: InboxState;
  checks: Check[];
  derivedEscrowLockId?: Hex;
  publicRpcCalls: number;
  institutionNetworkCalls: number;
  summary: Record<Status, number>;
  escrowReport?: EscrowVerifyReport;
}

function field(raw: any, name: string, index: number) { return raw?.[name] ?? raw?.[index]; }

function normalizeRequest(raw: any): InboxRequestSnapshot {
  return {
    holder: field(raw, "holder", 0) as Address,
    exchangeOperator: field(raw, "exchangeOperator", 1) as Address,
    exchangeServiceId: field(raw, "exchangeServiceId", 2) as Hex,
    amount: BigInt(field(raw, "amount", 3)),
    requestHash: field(raw, "requestHash", 4) as Hex,
    nonce: BigInt(field(raw, "nonce", 5)),
    expiresAtBlock: BigInt(field(raw, "expiresAtBlock", 6)),
    submittedBlock: BigInt(field(raw, "submittedBlock", 7)),
    responseDueBlock: BigInt(field(raw, "responseDueBlock", 8)),
    lockId: field(raw, "lockId", 9) as Hex,
    state: INBOX_STATES[Number(field(raw, "state", 10))] ?? "NONE",
  };
}

export async function observeInbox(c: InboxReadCtx, requestId: Hex, options: ObserveInboxOptions = {}): Promise<InboxObservation> {
  const originalFetch = globalThis.fetch;
  let totalFetch = 0, publicFetch = 0, rpcDepth = 0, logicalRpc = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    totalFetch++;
    if (rpcDepth > 0) publicFetch++;
    return originalFetch(...args);
  }) as typeof fetch;
  const rpc = async <T>(fn: () => Promise<T>): Promise<T> => {
    logicalRpc++; rpcDepth++;
    try { return await fn(); } finally { rpcDepth--; }
  };
  try {
    const pinnedBlock = options.blockNumber ?? await rpc(() => c.pub.getBlockNumber({ cacheTime: 0 }));
    const at = { blockNumber: pinnedBlock } as const;
    const read = (functionName: string, args: readonly unknown[] = []) => rpc(() => c.pub.readContract({
      address: c.address, abi: INBOX_ABI, functionName, args, ...at,
    }) as Promise<any>);
    const [chainId, log, escrow, token, forwardBlocks, responseBlocks, profileHash, rawRequest] = await Promise.all([
      rpc(() => c.pub.getChainId()), read("log"), read("escrow"), read("token"), read("forwardBlocks"),
      read("responseBlocks"), read("profileHash"), read("getRequest", [requestId]),
    ]);
    const profile: InboxProfile = {
      log: log as Address, escrow: escrow as Address, token: token as Address,
      forwardBlocks: BigInt(forwardBlocks), responseBlocks: BigInt(responseBlocks), profileHash: profileHash as Hex,
    };
    const request = normalizeRequest(rawRequest);
    const [service, inboxLogs, publicLogEvents] = await Promise.all([
      rpc(() => c.pub.readContract({ address: profile.log, abi: LOG_ABI, functionName: "getService", args: [request.exchangeServiceId], ...at }) as Promise<any>),
      rpc(() => c.pub.getLogs({ address: c.address, fromBlock: options.fromBlock ?? 0n, toBlock: pinnedBlock })),
      rpc(() => c.pub.getLogs({ address: profile.log, fromBlock: options.fromBlock ?? 0n, toBlock: pinnedBlock })),
    ]);
    const observationErrors: string[] = [];
    if (!eq(inboxProfileHash(chainId, c.address, profile), profile.profileHash)) observationErrors.push("immutable inbox profile hash mismatch");
    const appended = parseEventLogs({ abi: LOG_ABI, logs: publicLogEvents, eventName: "Appended", strict: true }) as any[];
    const serviceEvents = appended.filter(e => eq(e.args.serviceId, request.exchangeServiceId))
      .sort((a, b) => a.blockNumber === b.blockNumber ? Number(a.logIndex) - Number(b.logIndex) : a.blockNumber < b.blockNumber ? -1 : 1);
    const exchangeLog = replayServiceLog(request.exchangeServiceId, service, serviceEvents, observationErrors);
    const names = new Set<InboxEventName>(["Submitted", "Forwarded", "RejectionProven", "ChallengeOpened", "ChallengeUnanswered"]);
    const events = (parseEventLogs({ abi: INBOX_ABI, logs: inboxLogs, strict: true }) as any[])
      .filter(e => names.has(e.eventName as InboxEventName) && eq(e.args.requestId, requestId))
      .map(e => ({ name: e.eventName as InboxEventName, blockNumber: e.blockNumber, logIndex: Number(e.logIndex),
        transactionHash: e.transactionHash as Hex, args: e.args as Record<string, unknown> }))
      .sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
    return {
      pinnedBlock, chainId, inboxAddress: c.address, profile,
      exchangeService: {
        exists: Boolean(field(service, "exists", 9)), serviceId: request.exchangeServiceId,
        operator: field(service, "operator", 0) as Address, treeId: field(service, "treeId", 3) as Hex,
      },
      requestId, request, events, exchangeLog, observationErrors,
      publicRpcCalls: publicFetch || logicalRpc,
      institutionNetworkCalls: Math.max(0, totalFetch - publicFetch),
    };
  } finally { globalThis.fetch = originalFetch; }
}

export async function verifyInbox(c: InboxReadCtx, requestId: Hex, options: ObserveInboxOptions = {}): Promise<InboxVerifyReport> {
  const observed = await observeInbox(c, requestId, options);
  const report = verifyInboxObservation(observed, options.rejectionDigest);
  if (options.includeEscrow && report.derivedEscrowLockId) {
    const { observeEscrow, verifyEscrowObservation } = await import("./escrow-verify.js");
    const escrowObservation = await observeEscrow({ pub: c.pub, address: observed.profile.escrow }, report.derivedEscrowLockId, { blockNumber: observed.pinnedBlock });
    const forwarded = observed.events.find(e => e.name === "Forwarded");
    const locked = escrowObservation.events.find(e => e.name === "Locked");
    const bound = Boolean(forwarded && locked
      && forwarded.transactionHash === locked.transactionHash
      && forwarded.blockNumber === locked.blockNumber
      && locked.logIndex < forwarded.logIndex
      && eq(escrowObservation.lock.holder, observed.request.holder)
      && escrowObservation.lock.amount === observed.request.amount
      && eq(escrowObservation.lock.requestHash, observed.request.requestHash));
    const binding = bound
      ? item("forward.escrowBinding", "CONFIRMED", "Forwarded and Locked are in the same transaction and holder, amount, and request hash agree")
      : item("forward.escrowBinding", "UNVERIFIABLE", "derived escrow lock is not atomically bound to this inbox request");
    report.checks.push(binding);
    report.summary[binding.status]++;
    if (bound) report.escrowReport = verifyEscrowObservation(escrowObservation);
  }
  return report;
}

export interface InboxReadCtx { pub: PublicClient; address: Address; }
export interface ObserveInboxOptions { blockNumber?: bigint; fromBlock?: bigint; rejectionDigest?: Hex; includeEscrow?: boolean; }

const eq = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const item = (id: string, status: Status, detail: string): Check => ({ id, status, detail });

function replayLifecycle(o: InboxObservation) {
  let state: InboxState = "NONE";
  let forwarded: InboxLifecycleEvent | undefined;
  let rejection: InboxLifecycleEvent | undefined;
  let challenge: InboxLifecycleEvent | undefined;
  let unanswered = false;
  const problems: string[] = [];
  let priorBlock = -1n, priorIndex = -1;
  for (const event of o.events) {
    if (!eq(event.args.requestId, o.requestId)) problems.push(`${event.name} names another request`);
    if (event.blockNumber < priorBlock || (event.blockNumber === priorBlock && event.logIndex <= priorIndex)) problems.push(`${event.name} is out of event order`);
    priorBlock = event.blockNumber; priorIndex = event.logIndex;
    switch (event.name) {
      case "Submitted":
        if (state !== "NONE") problems.push("duplicate or reordered Submitted event");
        else state = "SUBMITTED";
        break;
      case "ChallengeOpened":
        if (state !== "SUBMITTED") problems.push(`ChallengeOpened cannot follow ${state}`);
        else {
          if (event.blockNumber <= o.request.submittedBlock + o.profile.forwardBlocks) problems.push("challenge opened before forwarding due");
          if (BigInt(event.args.responseDueBlock as bigint) !== event.blockNumber + o.profile.responseBlocks) problems.push("challenge response due is not derived from its block");
          state = "CHALLENGED"; challenge = event;
        }
        break;
      case "Forwarded":
        if (state !== "SUBMITTED" && state !== "CHALLENGED") problems.push(`Forwarded cannot follow ${state}`);
        else { if (state === "CHALLENGED" && event.blockNumber > BigInt(challenge?.args.responseDueBlock as bigint)) problems.push("forwarding is after the challenge response window"); state = "FORWARDED"; forwarded = event; }
        break;
      case "RejectionProven":
        if (state !== "SUBMITTED" && state !== "CHALLENGED") problems.push(`RejectionProven cannot follow ${state}`);
        else { if (state === "CHALLENGED" && event.blockNumber > BigInt(challenge?.args.responseDueBlock as bigint)) problems.push("rejection proof is after the challenge response window"); state = "REJECTED"; rejection = event; }
        break;
      case "ChallengeUnanswered":
        if (state !== "CHALLENGED") problems.push(`ChallengeUnanswered cannot follow ${state}`);
        else { if (event.blockNumber <= BigInt(challenge?.args.responseDueBlock as bigint)) problems.push("ChallengeUnanswered is inside the response window"); state = "UNANSWERED"; unanswered = true; }
        break;
    }
  }
  return { state, forwarded, rejection, challenge, unanswered, problems, valid: problems.length === 0 };
}

function rejectionProof(o: InboxObservation, event?: InboxLifecycleEvent): Check {
  if (!event) return item("exchange.rejectionRecord", "UNVERIFIABLE", "no public rejection proof event was observed");
  const leaf = event.args.leaf as Hex | undefined, root = event.args.root as Hex | undefined, index = Number(event.args.index);
  if (!leaf || !root || !Number.isSafeInteger(index) || index < 0) return item("exchange.rejectionRecord", "UNVERIFIABLE", "rejection proof event is malformed");
  const snapshot = o.exchangeLog.roots.find(r => eq(r.root, root));
  if (!snapshot || index >= snapshot.size || !eq(o.exchangeLog.leaves[index], leaf)) {
    return item("exchange.rejectionRecord", "UNVERIFIABLE", "rejection leaf is absent from the replayed exchange log at the cited root/index");
  }
  if (snapshot.blockNumber < o.request.submittedBlock || snapshot.blockNumber > event.blockNumber) {
    return item("exchange.rejectionRecord", "UNVERIFIABLE", "rejection root has an impossible anchor order");
  }
  if (Boolean(event.args.late) !== (snapshot.blockNumber > o.request.submittedBlock + o.profile.forwardBlocks)) {
    return item("exchange.rejectionRecord", "UNVERIFIABLE", "rejection late flag disagrees with the root anchor block");
  }
  return item("exchange.rejectionRecord", "CONFIRMED", `rejection leaf is recorded at exchange log index ${index}`);
}

export function verifyInboxObservation(o: InboxObservation, rejectionDigest?: Hex): InboxVerifyReport {
  const replay = replayLifecycle(o);
  const problems = [...o.observationErrors, ...replay.problems];
  if (!eq(inboxProfileHash(o.chainId, o.inboxAddress, o.profile), o.profile.profileHash)) problems.push("immutable inbox profile hash mismatch");
  if (o.events.some(e => e.blockNumber > o.pinnedBlock)) problems.push("lifecycle contains an event after the pinned block");
  if (o.exchangeLog.roots.some(r => r.blockNumber > o.pinnedBlock)) problems.push("exchange replay contains a root after the pinned block");
  const submitted = o.events.find(e => e.name === "Submitted");
  if (!submitted) problems.push("Submitted event is missing");
  else {
    if (!eq(submitted.args.holder, o.request.holder)) problems.push("holder differs from Submitted event");
    if (!eq(submitted.args.exchangeServiceId, o.request.exchangeServiceId)) problems.push("exchange service differs from Submitted event");
    if (BigInt(submitted.args.amount as bigint) !== o.request.amount) problems.push("amount differs from Submitted event");
    if (!eq(submitted.args.requestHash, o.request.requestHash)) problems.push("request hash differs from Submitted event");
    if (submitted.blockNumber !== o.request.submittedBlock) problems.push("submitted block mismatch");
    if (BigInt(submitted.args.forwardDueBlock as bigint) !== o.request.submittedBlock + o.profile.forwardBlocks) problems.push("forward due block mismatch");
  }
  if (!eq(inboxRequestDigest(o.chainId, o.inboxAddress, o.request), o.requestId)) problems.push("requestId differs from EIP-712 request digest");
  if (!o.exchangeService.exists) problems.push("exchange service is not registered");
  if (!eq(o.exchangeService.serviceId, o.request.exchangeServiceId)) problems.push("registered exchange service ID mismatch");
  if (!eq(o.exchangeLog.serviceId, o.request.exchangeServiceId)) problems.push("exchange replay service ID mismatch");
  if (!eq(o.exchangeService.operator, o.request.exchangeOperator)) problems.push("stored exchange operator differs from the registered service operator");
  if (!eq(o.exchangeService.treeId, o.exchangeLog.treeId) || !o.exchangeLog.agrees) problems.push("exchange Appended replay disagrees with the registered service");
  problems.push(...validateServiceReplay(o.exchangeLog).map(p => `exchange ${p}`));
  if (replay.state !== o.request.state) problems.push(`event state ${replay.state} differs from getRequest state ${o.request.state}`);
  const expectedDue = replay.state === "CHALLENGED" || replay.state === "UNANSWERED"
    ? BigInt(replay.challenge?.args.responseDueBlock as bigint ?? 0n) : 0n;
  if (expectedDue !== o.request.responseDueBlock) problems.push("response due block mismatch");
  const eventLockId = replay.forwarded?.args.lockId as Hex | undefined;
  if (replay.forwarded && Boolean(replay.forwarded.args.late) !== (replay.forwarded.blockNumber > o.request.submittedBlock + o.profile.forwardBlocks)) problems.push("forwarded late flag mismatch");
  if ((eventLockId && !eq(eventLockId, o.request.lockId)) || (!eventLockId && !eq(o.request.lockId, `0x${"00".repeat(32)}`))) problems.push("forwarded lock ID mismatch");

  const consistency = problems.length
    ? item("lifecycle.consistency", "UNVERIFIABLE", problems.join("; "))
    : item("lifecycle.consistency", "CONFIRMED", "ordered public events agree with the pinned request and exchange log");
  const proof = rejectionProof(o, replay.rejection);
  let opening: Check;
  if (!replay.rejection) opening = item("rejection.opening", "OUT_OF_SCOPE", "no rejection record exists");
  else if (!rejectionDigest) opening = item("rejection.opening", "UNVERIFIABLE", "private rejection digest/opening was not supplied");
  else opening = eq(replay.rejection.args.leaf, inboxRejectionLeaf(o.requestId, rejectionDigest))
    ? item("rejection.opening", "CONFIRMED", "supplied rejection digest hashes to the public leaf")
    : item("rejection.opening", "UNVERIFIABLE", "supplied rejection digest does not hash to the public leaf");

  let exchange: Check;
  if (consistency.status !== "CONFIRMED") exchange = item("exchange.hop", "UNVERIFIABLE", "public inbox evidence is incomplete or inconsistent");
  else if (replay.unanswered) exchange = item("exchange.hop", "OBLIGATION_UNMET", "the public forwarding challenge finalized unanswered");
  else if (replay.forwarded) exchange = item("exchange.hop", "CONFIRMED", "the exchange atomically forwarded the request into escrow");
  else if (replay.rejection && proof.status === "CONFIRMED") exchange = item("exchange.hop", "CONFIRMED", "the exchange recorded a rejection in its public log");
  else if (replay.rejection) exchange = item("exchange.hop", "UNVERIFIABLE", "a rejection event exists but does not match the replayed exchange log");
  else if (o.request.state === "CHALLENGED" && o.pinnedBlock <= o.request.responseDueBlock) exchange = item("exchange.hop", "NOT_DUE", `challenge response is due by block ${o.request.responseDueBlock}`);
  else if (o.request.state === "SUBMITTED" && o.pinnedBlock <= o.request.submittedBlock + o.profile.forwardBlocks) exchange = item("exchange.hop", "NOT_DUE", `forwarding is due by block ${o.request.submittedBlock + o.profile.forwardBlocks}`);
  else exchange = item("exchange.hop", "UNVERIFIABLE", "no finalized public evidence establishes exchange non-forwarding");

  const operator = consistency.status !== "CONFIRMED"
    ? item("operator.hop", "UNVERIFIABLE", "public inbox evidence is incomplete or inconsistent")
    : replay.forwarded
      ? item("operator.hop", "UNVERIFIABLE", "request entered escrow; inspect the derived escrow lock report for the operator hop")
      : item("operator.hop", "NOT_DUE", "operator escrow obligation has not started because the request was not forwarded");
  const checks = [consistency, proof, opening, exchange, operator];
  if (replay.rejection) checks.push(item("rejection.merits", "OUT_OF_SCOPE", "the public record proves a rejection was recorded, not that its merits were correct"));
  const summary: Record<Status, number> = { CONFIRMED: 0, NOT_DUE: 0, OBLIGATION_UNMET: 0, UNVERIFIABLE: 0, OUT_OF_SCOPE: 0 };
  for (const check of checks) summary[check.status]++;
  return {
    requestId: o.requestId, pinnedBlock: o.pinnedBlock, state: o.request.state, checks,
    derivedEscrowLockId: consistency.status === "CONFIRMED" ? eventLockId : undefined, publicRpcCalls: o.publicRpcCalls,
    institutionNetworkCalls: o.institutionNetworkCalls, summary,
  };
}
