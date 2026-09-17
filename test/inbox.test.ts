import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { IncrementalTree, verifyInclusion } from "../src/merkle.js";
import {
  inboxProfileHash, inboxRejectionKey, inboxRejectionLeaf, inboxRequestDigest, proofForInboxRejection, type InboxRequest,
} from "../src/inbox.js";
import {
  verifyInboxObservation, type InboxLifecycleEvent, type InboxObservation, type InboxState,
} from "../src/inbox-verify.js";
import type { ServiceLogReplay } from "../src/escrow-verify.js";

const INBOX = "0x1111111111111111111111111111111111111111" as Address;
const HOLDER = "0x2222222222222222222222222222222222222222" as Address;
const OPERATOR = "0x3333333333333333333333333333333333333333" as Address;
const SERVICE = `0x${"77".repeat(32)}` as Hex;
const REQUEST_HASH = `0x${"33".repeat(32)}` as Hex;
const DIGEST = `0x${"55".repeat(32)}` as Hex;
const TREE_ID = `0x${"aa".repeat(32)}` as Hex;
const REQUEST: InboxRequest = {
  holder: HOLDER, exchangeServiceId: SERVICE, amount: 100n, requestHash: REQUEST_HASH, nonce: 7n, expiresAtBlock: 999n,
};
const REQUEST_ID = "0xe862fc7b605225adec8729c0fb5f2c290ba0d8a341cb7960a0dd293b48833ff9" as Hex;

describe("inbox encodings", () => {
  it("matches the RedemptionInbox EIP-712 request digest", () => {
    expect(inboxRequestDigest(31337, INBOX, REQUEST)).toBe(REQUEST_ID);
  });

  it("domain-separates rejection keys with tag 5", () => {
    expect(inboxRejectionKey(REQUEST_ID)).toBe("0xd96cb306d02a8a1032f6dba2fa8ef88a1542b0d5bf834a062de1410dfcfa0227");
  });

  it("builds rejection proofs from the existing public tree", () => {
    const tree = new IncrementalTree(TREE_ID);
    tree.append(inboxRejectionLeaf(REQUEST_ID, DIGEST));
    const proof = proofForInboxRejection(tree, 0, REQUEST_ID, DIGEST);
    expect(verifyInclusion(tree.leaves[0], proof)).toBe(true);
  });
});

function exchangeLog(withRejection = false): ServiceLogReplay {
  const tree = new IncrementalTree(TREE_ID);
  const roots: ServiceLogReplay["roots"] = [];
  if (withRejection) {
    tree.append(inboxRejectionLeaf(REQUEST_ID, DIGEST));
    roots.push({ root: tree.root(), size: 1, blockNumber: 112n });
  }
  return { serviceId: SERVICE, treeId: TREE_ID, leaves: tree.leaves.slice(), roots, onChainRoot: tree.root(), onChainSize: tree.size, agrees: true };
}

function event(name: InboxLifecycleEvent["name"], blockNumber: bigint, args: Record<string, unknown>, logIndex = 0): InboxLifecycleEvent {
  return { name, blockNumber, logIndex, transactionHash: `0x${String(blockNumber).padStart(64, "0")}` as Hex, args: { requestId: REQUEST_ID, ...args } };
}

function observation(state: InboxState, events: InboxLifecycleEvent[], log = exchangeLog(), pinnedBlock = 110n): InboxObservation {
  const challenge = events.find(e => e.name === "ChallengeOpened");
  const forwarded = events.find(e => e.name === "Forwarded");
  return {
    pinnedBlock, chainId: 31337, inboxAddress: INBOX,
    profile: {
      log: "0x4444444444444444444444444444444444444444", escrow: "0x5555555555555555555555555555555555555555",
      token: "0x6666666666666666666666666666666666666666", forwardBlocks: 20n, responseBlocks: 30n,
      profileHash: inboxProfileHash(31337, INBOX, {
        log: "0x4444444444444444444444444444444444444444", escrow: "0x5555555555555555555555555555555555555555",
        token: "0x6666666666666666666666666666666666666666", forwardBlocks: 20n, responseBlocks: 30n,
      }),
    },
    exchangeService: { exists: true, serviceId: SERVICE, treeId: TREE_ID, operator: OPERATOR },
    requestId: REQUEST_ID,
    request: {
      ...REQUEST, exchangeOperator: OPERATOR, submittedBlock: 100n,
      responseDueBlock: challenge ? BigInt(challenge.args.responseDueBlock as bigint) : 0n,
      lockId: (forwarded?.args.lockId as Hex | undefined) ?? `0x${"00".repeat(32)}` as Hex,
      state,
    },
    events, exchangeLog: log, observationErrors: [], publicRpcCalls: 9, institutionNetworkCalls: 0,
  };
}

const submitted = event("Submitted", 100n, {
  holder: HOLDER, exchangeServiceId: SERVICE, amount: 100n, requestHash: REQUEST_HASH, forwardDueBlock: 120n,
});

describe("independent inbox verification", () => {
  it("reports an unforwarded request as not due before the public deadline", () => {
    const report = verifyInboxObservation(observation("SUBMITTED", [submitted], exchangeLog(), 119n));
    expect(report.checks.find(c => c.id === "exchange.hop")?.status).toBe("NOT_DUE");
    expect(report.checks.find(c => c.id === "operator.hop")?.status).toBe("NOT_DUE");
  });

  it("establishes exchange non-forwarding only from ChallengeUnanswered", () => {
    const events = [submitted,
      event("ChallengeOpened", 121n, { responseDueBlock: 151n }),
      event("ChallengeUnanswered", 152n, {}),
    ];
    const report = verifyInboxObservation(observation("UNANSWERED", events, exchangeLog(), 152n));
    expect(report.checks.find(c => c.id === "exchange.hop")?.status).toBe("OBLIGATION_UNMET");
    expect(report.checks.find(c => c.id === "operator.hop")?.status).toBe("NOT_DUE");
  });

  it("does not invent a violation after a bare deadline passes", () => {
    const report = verifyInboxObservation(observation("SUBMITTED", [submitted], exchangeLog(), 150n));
    expect(report.checks.find(c => c.id === "exchange.hop")?.status).toBe("UNVERIFIABLE");
    expect(report.summary.OBLIGATION_UNMET).toBe(0);
  });

  it("confirms forwarding while leaving the downstream escrow as a separate report", () => {
    const lockId = `0x${"99".repeat(32)}` as Hex;
    const report = verifyInboxObservation(observation("FORWARDED", [submitted, event("Forwarded", 105n, { lockId, late: false })]));
    expect(report.checks.find(c => c.id === "exchange.hop")?.status).toBe("CONFIRMED");
    expect(report.derivedEscrowLockId).toBe(lockId);
    expect(report.checks.find(c => c.id === "operator.hop")?.status).toBe("UNVERIFIABLE");
  });

  it("confirms a rejection only when its event leaf is in the replayed exchange log", () => {
    const log = exchangeLog(true);
    const proof = event("RejectionProven", 113n, { leaf: log.leaves[0], root: log.roots[0].root, index: 0, late: false });
    const report = verifyInboxObservation(observation("REJECTED", [submitted, proof], log, 113n));
    expect(report.checks.find(c => c.id === "exchange.hop")?.status).toBe("CONFIRMED");
    expect(report.checks.find(c => c.id === "rejection.merits")?.status).toBe("OUT_OF_SCOPE");
  });

  it("refuses reordered evidence and never converts it into a violation", () => {
    const lockId = `0x${"99".repeat(32)}` as Hex;
    const report = verifyInboxObservation(observation("FORWARDED", [event("Forwarded", 105n, { lockId, late: false }), submitted]));
    expect(report.checks.find(c => c.id === "lifecycle.consistency")?.status).toBe("UNVERIFIABLE");
    expect(report.checks.find(c => c.id === "exchange.hop")?.status).toBe("UNVERIFIABLE");
    expect(report.summary.OBLIGATION_UNMET).toBe(0);
  });

  it("refuses future challenge verdicts and never follows their derived lock", () => {
    const events = [submitted, event("ChallengeOpened", 121n, { responseDueBlock: 151n }), event("ChallengeUnanswered", 152n, {})];
    const report = verifyInboxObservation(observation("UNANSWERED", events, exchangeLog(), 125n));
    expect(report.checks.find(c => c.id === "lifecycle.consistency")?.status).toBe("UNVERIFIABLE");
    expect(report.checks.find(c => c.id === "exchange.hop")?.status).toBe("UNVERIFIABLE");
    expect(report.derivedEscrowLockId).toBeUndefined();
    expect(report.summary.OBLIGATION_UNMET).toBe(0);
  });
});
