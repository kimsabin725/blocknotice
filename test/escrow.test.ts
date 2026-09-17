import { describe, expect, it } from "vitest";
import { IncrementalTree, verifyInclusion } from "../src/merkle.js";
import {
  escrowDecisionDigest,
  escrowDeliveryDigest,
  escrowDeliveryKey,
  escrowHandoffDigest,
  escrowHandoffKey,
  escrowLeaf,
  escrowLockId,
  escrowProfileHash,
  escrowRecordDigest,
  proofForEscrowRecord,
} from "../src/escrow.js";
import type { Hex } from "viem";
import {
  verifyEscrowObservation,
  type EscrowLifecycleEvent,
  type EscrowObservation,
  type EscrowState,
  type ServiceLogReplay,
} from "../src/escrow-verify.js";

const ESCROW = "0x1111111111111111111111111111111111111111";
const HOLDER = "0x2222222222222222222222222222222222222222";
const REQUEST_HASH = `0x${"33".repeat(32)}` as Hex;
const SALT = `0x${"44".repeat(32)}` as Hex;
const CATEGORY = `0x${"55".repeat(32)}` as Hex;
const REASON = `0x${"66".repeat(32)}` as Hex;
const COURIER_SERVICE = `0x${"77".repeat(32)}` as Hex;
const HANDOFF_COMMIT = `0x${"88".repeat(32)}` as Hex;
const DELIVERY_COMMIT = `0x${"99".repeat(32)}` as Hex;

describe("escrow ABI encodings", () => {
  it("derives lock IDs with the Solidity abi.encode field order", () => {
    expect(escrowLockId(31337n, ESCROW, HOLDER, REQUEST_HASH, 7n)).toBe(
      "0x5ad6b610146d1a2646114725597769f45f9feb008f67bb3106ed2900828a7116",
    );
  });

  it("domain-separates handoff and delivery keys with tags 3 and 4", () => {
    const lockId = escrowLockId(31337n, ESCROW, HOLDER, REQUEST_HASH, 7n);
    expect(escrowHandoffKey(lockId)).toBe("0xc74d4e8e21a5c1f0cd6524d63971ba72df4cf4d8dea150535b89af5393212cf0");
    expect(escrowDeliveryKey(lockId)).toBe("0xb11936a63b449b64f52fe09fb310e85e26c136bdc0e1bebfa76fcdce71ce667b");
  });

  it("uses explicit Solidity ABI types for private record digests", () => {
    expect(escrowDecisionDigest(1, CATEGORY, REASON, SALT)).toBe(
      "0x225e775334bffd01cb4ba9cc2c556c033f050a015a71b9c427416b17d31c0016",
    );
    expect(escrowHandoffDigest(COURIER_SERVICE, HANDOFF_COMMIT, SALT)).toBe(
      "0x4cb219e2d682e81ac4180d05c456d41a0f7d9ae1a7b41e79f90fa3abd43f35b6",
    );
    expect(escrowDeliveryDigest(DELIVERY_COMMIT, SALT)).toBe(
      "0x3f51ec5cf13b6c31d025b4703c07e2db0b2a6175d308c31977c7b7359ed0d55c",
    );
  });

  it("builds the same tagged DEC leaf used by BlockNoticeLog", () => {
    const lockId = escrowLockId(31337n, ESCROW, HOLDER, REQUEST_HASH, 7n);
    const key = escrowHandoffKey(lockId);
    const digest = escrowHandoffDigest(COURIER_SERVICE, HANDOFF_COMMIT, SALT);
    expect(escrowRecordDigest(key, digest)).toBe("0x0c5bc3cee4326bb43011cb200c72b01c3866c99deb9be9e400025ebe2b0512a7");
    expect(escrowLeaf(key, digest)).toBe("0xa72abdb26e74fe429177e1e15ebf4372dd61c61d3035b7eef9abc2a49bdce9e6");
  });
});

describe("escrow proof helper", () => {
  it("returns a real inclusion proof only when the expected escrow leaf occupies the requested index", () => {
    const lockId = escrowLockId(31337n, ESCROW, HOLDER, REQUEST_HASH, 7n);
    const key = escrowHandoffKey(lockId);
    const digest = escrowHandoffDigest(COURIER_SERVICE, HANDOFF_COMMIT, SALT);
    const tree = new IncrementalTree(`0x${"ab".repeat(32)}` as Hex);
    tree.append(`0x${"cd".repeat(32)}` as Hex);
    tree.append(escrowLeaf(key, digest));

    const proof = proofForEscrowRecord(tree, 1, key, digest);
    expect(proof.index).toBe(1);
    expect(proof.root).toBe(tree.root());
    expect(verifyInclusion(escrowLeaf(key, digest), proof)).toBe(true);
    expect(() => proofForEscrowRecord(tree, 0, key, digest)).toThrow(/does not contain the escrow leaf/);
  });
});

const LOCK_ID = "0x5ad6b610146d1a2646114725597769f45f9feb008f67bb3106ed2900828a7116" as Hex;
const TREE_ID = `0x${"aa".repeat(32)}` as Hex;
const DECISION_DIGEST = escrowDecisionDigest(1, CATEGORY, REASON, SALT);
const HANDOFF_DIGEST = escrowHandoffDigest(COURIER_SERVICE, HANDOFF_COMMIT, SALT);
const DELIVERY_DIGEST = escrowDeliveryDigest(DELIVERY_COMMIT, SALT);

function serviceReplay(serviceId: Hex, entries: Array<{ key: Hex; digest: Hex; blockNumber: bigint }>): ServiceLogReplay {
  const tree = new IncrementalTree(TREE_ID);
  const roots: ServiceLogReplay["roots"] = [];
  for (const entry of entries) {
    tree.append(escrowLeaf(entry.key, entry.digest));
    roots.push({ root: tree.root(), size: tree.size, blockNumber: entry.blockNumber });
  }
  return {
    serviceId,
    treeId: TREE_ID,
    leaves: tree.leaves.slice(),
    roots,
    onChainRoot: tree.root(),
    onChainSize: tree.size,
    agrees: true,
  };
}

function proofEvent(
  name: "DecisionProven" | "HandoffProven" | "DeliveryProven",
  blockNumber: bigint,
  log: ServiceLogReplay,
  index: number,
  _digest: Hex,
): EscrowLifecycleEvent {
  return {
    name,
    blockNumber,
    logIndex: index,
    transactionHash: `0x${String(index + 1).padStart(64, "0")}` as Hex,
    // The escrow event intentionally publishes the committed leaf, not the private digest/opening.
    args: { lockId: LOCK_ID, leaf: log.leaves[index], root: log.roots[index].root, index, late: false },
  };
}

function observation(
  state: EscrowState,
  events: EscrowLifecycleEvent[],
  operatorLog: ServiceLogReplay,
  courierLog: ServiceLogReplay,
  pinnedBlock = 160n,
): EscrowObservation {
  const handoff = events.find(e => e.name === "HandoffProven");
  const delivery = events.find(e => e.name === "DeliveryProven");
  const challenge = [...events].reverse().find(e => e.name === "ChallengeOpened");
  return {
    pinnedBlock,
    chainId: 31337,
    escrowAddress: ESCROW,
    profile: {
      log: "0x3333333333333333333333333333333333333333",
      token: "0x4444444444444444444444444444444444444444",
      operatorServiceId: `0x${"10".repeat(32)}` as Hex,
      courierServiceId: COURIER_SERVICE,
      decisionBlocks: 20n,
      handoffBlocks: 40n,
      courierBlocks: 60n,
      responseBlocks: 30n,
      disputeBlocks: 30n,
      profileHash: escrowProfileHash(31337, ESCROW, {
        log: "0x3333333333333333333333333333333333333333", token: "0x4444444444444444444444444444444444444444",
        operatorServiceId: `0x${"10".repeat(32)}` as Hex, courierServiceId: COURIER_SERVICE,
        decisionBlocks: 20n, handoffBlocks: 40n, courierBlocks: 60n, responseBlocks: 30n, disputeBlocks: 30n,
      }),
    },
    services: {
      operator: { exists: true, serviceId: `0x${"10".repeat(32)}` as Hex, treeId: TREE_ID },
      courier: { exists: true, serviceId: COURIER_SERVICE, treeId: TREE_ID },
    },
    lockId: LOCK_ID,
    lock: {
      holder: HOLDER,
      amount: 100n,
      requestHash: REQUEST_HASH,
      lockBlock: 100n,
      handoffAnchorBlock: handoff ? operatorLog.roots[Number((handoff.args as any).index)].blockNumber : 0n,
      deliveryAnchorBlock: delivery ? courierLog.roots[Number((delivery.args as any).index)].blockNumber : 0n,
      deliveryProvenBlock: delivery?.blockNumber ?? 0n,
      responseDueBlock: challenge ? BigInt((challenge.args as any).responseDueBlock) : 0n,
      state,
    },
    events,
    logs: { operator: operatorLog, courier: courierLog },
    observationErrors: [],
    publicRpcCalls: 12,
    institutionNetworkCalls: 0,
  };
}

const lockedEvent: EscrowLifecycleEvent = {
  name: "Locked", blockNumber: 100n, logIndex: 0,
  transactionHash: `0x${"01".repeat(32)}` as Hex,
  args: { lockId: LOCK_ID, holder: HOLDER, amount: 100n, requestHash: REQUEST_HASH },
};

function successfulEvidence(finalState: EscrowState = "DELIVERED") {
  const operator = serviceReplay(`0x${"10".repeat(32)}` as Hex, [
    { key: LOCK_ID, digest: DECISION_DIGEST, blockNumber: 105n },
    { key: escrowHandoffKey(LOCK_ID), digest: HANDOFF_DIGEST, blockNumber: 115n },
  ]);
  const courier = serviceReplay(COURIER_SERVICE, [
    { key: escrowDeliveryKey(LOCK_ID), digest: DELIVERY_DIGEST, blockNumber: 145n },
  ]);
  const events: EscrowLifecycleEvent[] = [
    lockedEvent,
    proofEvent("DecisionProven", 110n, operator, 0, DECISION_DIGEST),
    proofEvent("HandoffProven", 120n, operator, 1, HANDOFF_DIGEST),
    proofEvent("DeliveryProven", 150n, courier, 0, DELIVERY_DIGEST),
  ];
  if (finalState === "DISPUTED") {
    events.push({ name: "Disputed", blockNumber: 151n, logIndex: 0, transactionHash: `0x${"09".repeat(32)}` as Hex, args: { lockId: LOCK_ID } });
  } else if (finalState === "BURNED") {
    events.push({ name: "Burned", blockNumber: 181n, logIndex: 0, transactionHash: `0x${"08".repeat(32)}` as Hex, args: { lockId: LOCK_ID, byAck: false } });
  }
  return observation(finalState, events, operator, courier, finalState === "BURNED" ? 181n : 160n);
}

describe("independent escrow verification", () => {
  it("confirms each recorded hop while keeping physical delivery and disputes out of scope", () => {
    const report = verifyEscrowObservation(successfulEvidence("DISPUTED"));
    expect(report.hops.operator.status).toBe("CONFIRMED");
    expect(report.hops.courier.status).toBe("CONFIRMED");
    expect(report.checks.find(c => c.id === "operator.hop")?.status).toBe("CONFIRMED");
    expect(report.checks.find(c => c.id === "courier.hop")?.status).toBe("CONFIRMED");
    expect(report.checks.find(c => c.id === "delivery.physical")?.status).toBe("OUT_OF_SCOPE");
    expect(report.checks.find(c => c.id === "dispute.merits")?.status).toBe("OUT_OF_SCOPE");
    expect(report.institutionNetworkCalls).toBe(0);
    expect(report.publicRpcCalls).toBe(12);
  });

  it("missing private openings affects only the opening check", () => {
    const report = verifyEscrowObservation(successfulEvidence(), undefined);
    expect(report.checks.find(c => c.id === "records.opening")?.status).toBe("UNVERIFIABLE");
    expect(report.hops.operator.status).toBe("CONFIRMED");
    expect(report.hops.courier.status).toBe("CONFIRMED");
    expect(report.summary.OBLIGATION_UNMET).toBe(0);
  });

  it("establishes operator non-recording only from a finalized public challenge", () => {
    const emptyOperator = serviceReplay(`0x${"10".repeat(32)}` as Hex, []);
    const emptyCourier = serviceReplay(COURIER_SERVICE, []);
    const events: EscrowLifecycleEvent[] = [
      lockedEvent,
      { name: "ChallengeOpened", blockNumber: 121n, logIndex: 0, transactionHash: `0x${"03".repeat(32)}` as Hex,
        args: { lockId: LOCK_ID, hop: 0, responseDueBlock: 151n } },
      { name: "ChallengeUnanswered", blockNumber: 152n, logIndex: 0, transactionHash: `0x${"04".repeat(32)}` as Hex,
        args: { lockId: LOCK_ID, hop: 0 } },
      { name: "Returned", blockNumber: 152n, logIndex: 1, transactionHash: `0x${"04".repeat(32)}` as Hex,
        args: { lockId: LOCK_ID } },
    ];
    const report = verifyEscrowObservation(observation("RETURNED", events, emptyOperator, emptyCourier, 152n));
    expect(report.hops.operator.status).toBe("OBLIGATION_UNMET");
    expect(report.hops.courier.status).toBe("NOT_DUE");
  });

  it("does not invent a violation merely because a deadline passed without a finalized challenge", () => {
    const emptyOperator = serviceReplay(`0x${"10".repeat(32)}` as Hex, []);
    const emptyCourier = serviceReplay(COURIER_SERVICE, []);
    const report = verifyEscrowObservation(observation("LOCKED", [lockedEvent], emptyOperator, emptyCourier, 200n));
    expect(report.hops.operator.status).toBe("UNVERIFIABLE");
    expect(report.summary.OBLIGATION_UNMET).toBe(0);
  });

  it("reports courier non-recording independently after its finalized challenge", () => {
    const base = successfulEvidence();
    const events = base.events.filter(e => e.name !== "DeliveryProven");
    events.push(
      { name: "ChallengeOpened", blockNumber: 176n, logIndex: 0, transactionHash: `0x${"05".repeat(32)}` as Hex,
        args: { lockId: LOCK_ID, hop: 1, responseDueBlock: 206n } },
      { name: "ChallengeUnanswered", blockNumber: 207n, logIndex: 0, transactionHash: `0x${"06".repeat(32)}` as Hex,
        args: { lockId: LOCK_ID, hop: 1 } },
    );
    const seen = observation("STALLED", events, base.logs.operator, base.logs.courier, 207n);
    seen.lock.deliveryAnchorBlock = 0n;
    seen.lock.deliveryProvenBlock = 0n;
    const report = verifyEscrowObservation(seen);
    expect(report.hops.operator.status).toBe("CONFIRMED");
    expect(report.hops.courier.status).toBe("OBLIGATION_UNMET");
  });

  it("refuses confirmation when lifecycle evidence is reordered or disagrees with getLock", () => {
    const seen = successfulEvidence();
    [seen.events[1], seen.events[2]] = [seen.events[2], seen.events[1]];
    seen.lock.state = "HANDED_OFF";
    const report = verifyEscrowObservation(seen);
    expect(report.hops.operator.status).toBe("UNVERIFIABLE");
    expect(report.checks.find(c => c.id === "lifecycle.consistency")?.status).toBe("UNVERIFIABLE");
    expect(report.summary.OBLIGATION_UNMET).toBe(0);
  });

  it("does not downgrade a malformed delivery proof event to NOT_DUE", () => {
    const seen = successfulEvidence();
    const delivery = seen.events.find(e => e.name === "DeliveryProven")!;
    delivery.args.leaf = `0x${"fe".repeat(32)}` as Hex;
    const report = verifyEscrowObservation(seen);
    expect(report.checks.find(c => c.id === "courier.deliveryRecord")?.status).toBe("UNVERIFIABLE");
    expect(report.hops.courier.status).toBe("UNVERIFIABLE");
    expect(report.summary.OBLIGATION_UNMET).toBe(0);
  });

  it("refuses future lifecycle evidence and a forged immutable profile", () => {
    const seen = successfulEvidence();
    seen.pinnedBlock = 149n;
    seen.profile.profileHash = `0x${"fe".repeat(32)}` as Hex;
    const report = verifyEscrowObservation(seen);
    expect(report.checks.find(c => c.id === "lifecycle.consistency")?.status).toBe("UNVERIFIABLE");
    expect(report.hops.operator.status).toBe("UNVERIFIABLE");
    expect(report.hops.courier.status).toBe("UNVERIFIABLE");
  });

  it("returns UNVERIFIABLE instead of throwing when ChallengeOpened evidence is missing", () => {
    const emptyOperator = serviceReplay(`0x${"10".repeat(32)}` as Hex, []);
    const emptyCourier = serviceReplay(COURIER_SERVICE, []);
    const events = [lockedEvent,
      { name: "ChallengeUnanswered", blockNumber: 152n, logIndex: 0, transactionHash: `0x${"07".repeat(32)}` as Hex,
        args: { lockId: LOCK_ID, hop: 0 } },
      { name: "Returned", blockNumber: 152n, logIndex: 1, transactionHash: `0x${"07".repeat(32)}` as Hex, args: { lockId: LOCK_ID } },
    ] as EscrowLifecycleEvent[];
    const report = verifyEscrowObservation(observation("RETURNED", events, emptyOperator, emptyCourier, 152n));
    expect(report.checks.find(c => c.id === "lifecycle.consistency")?.status).toBe("UNVERIFIABLE");
    expect(report.summary.OBLIGATION_UNMET).toBe(0);
  });
});
