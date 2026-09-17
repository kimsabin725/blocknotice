// Real local-chain redemption scenes. Each scene fixes its expected verdict before execution.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { BaseError, ContractFunctionRevertedError, keccak256, parseEventLogs, stringToHex, type Address, type Hex } from "viem";
import { appendBatch, mine, registerService, type ChainCtx } from "./chain.js";
import { IncrementalTree } from "./merkle.js";
import { escrowDecisionDigest, escrowHandoffDigest, escrowDeliveryDigest, escrowHandoffKey, escrowDeliveryKey, escrowLeaf } from "./escrow.js";
import { observeEscrow, verifyEscrowObservation } from "./escrow-verify.js";
import { writeJson } from "./scenario.js";
import type { Scenario } from "./scenarios.js";
import type { Status } from "./verify.js";

const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../forge-out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
const ESCROW = artifact("RedemptionEscrow");
const GOLD = artifact("MockGold");
const AMOUNT = 100n * 10n ** 18n;
const INITIAL = 1000n * 10n ** 18n;
const hash = (value: string) => keccak256(stringToHex(value));
const salt = () => `0x${randomBytes(32).toString("hex")}` as Hex;
const write = async (c: ChainCtx, address: Address, abi: any, functionName: string, args: unknown[] = []) => {
  const { request } = await c.pub.simulateContract({ address, abi, functionName, args, account: c.account });
  const tx = await c.wallet.writeContract(request as any);
  const receipt = await c.pub.waitForTransactionReceipt({ hash: tx });
  assert.equal(receipt.status, "success");
  return receipt;
};
const rejected = (fn: () => Promise<unknown>, name: string) => assert.rejects(fn, (error: unknown) => {
  if (!(error instanceof BaseError)) return false;
  const cause = error.walk(e => e instanceof ContractFunctionRevertedError);
  return cause instanceof ContractFunctionRevertedError && cause.data?.errorName === name;
}, `expected ${name}`);

class RedemptionCase {
  opTree: IncrementalTree;
  coTree: IncrementalTree;
  id!: Hex;
  constructor(readonly operator: ChainCtx, readonly holder: ChainCtx, readonly courier: ChainCtx,
    readonly escrow: Address, readonly token: Address, readonly opId: Hex, readonly coId: Hex) {
    this.opTree = new IncrementalTree(keccak256(opId));
    this.coTree = new IncrementalTree(keccak256(coId));
  }
  tx(name: string, args: unknown[] = [this.id], actor = this.operator) {
    return write(actor, this.escrow, ESCROW.abi, name, args);
  }
  async read(name: string, args: unknown[] = [this.id]): Promise<any> {
    return this.operator.pub.readContract({ address: this.escrow, abi: ESCROW.abi, functionName: name, args });
  }
  async balance(address: Address) {
    return this.operator.pub.readContract({ address: this.token, abi: GOLD.abi, functionName: "balanceOf", args: [address] });
  }
  async lock() {
    const receipt = await this.tx("lock", [AMOUNT, hash("synthetic-redemption-request")], this.holder);
    const event: any = parseEventLogs({ abi: ESCROW.abi, logs: receipt.logs, eventName: "Locked" })[0];
    assert(event?.args.lockId, "lock must emit its ID");
    return event.args.lockId as Hex;
  }
  async after(due: bigint) {
    const now = await this.operator.pub.getBlockNumber({ cacheTime: 0 });
    if (now <= due) await mine(this.operator.pub, Number(due - now + 1n));
  }
  async proof(key: Hex, digest: Hex, courier = false) {
    const tree = courier ? this.coTree : this.opTree;
    const leaf = escrowLeaf(key, digest);
    await appendBatch(courier ? this.courier : this.operator, courier ? this.coId : this.opId, [leaf]);
    const index = tree.append(leaf);
    const p = tree.proof(index);
    return [this.id, digest, BigInt(index), p.root, p.siblings] as const;
  }
  async decide(outcome = 0) {
    const digest = escrowDecisionDigest(outcome, hash("synthetic-category"), hash("private-reason"), salt());
    return this.tx("proveDecision", [...await this.proof(this.id, digest)]);
  }
  async handoff() {
    const digest = escrowHandoffDigest(this.coId, hash("private-handoff"), salt());
    return this.tx("proveHandoff", [...await this.proof(escrowHandoffKey(this.id), digest)]);
  }
  async deliver() {
    const digest = escrowDeliveryDigest(hash("private-delivery"), salt());
    return this.tx("proveDelivery", [...await this.proof(escrowDeliveryKey(this.id), digest, true)]);
  }
}

export function createEscrowScenarios(operator: ChainCtx, holder: ChainCtx, courier: ChainCtx): Scenario[] {
  let counter = 0;
  async function fresh(startLock = true) {
    const namespace = `gold-redemption-${counter++}`;
    const opId = hash(`${namespace}-operator`), coId = hash(`${namespace}-courier`);
    await registerService(operator, opId, operator.account.address, hash("gold-operator-profile"), 30, 10, 20);
    await registerService(courier, coId, courier.account.address, hash("gold-courier-profile"), 30, 10, 20);
    const tokenTx = await operator.wallet.deployContract({ abi: GOLD.abi, bytecode: GOLD.bytecode.object, account: operator.account, chain: operator.chain });
    const tokenRc = await operator.pub.waitForTransactionReceipt({ hash: tokenTx });
    assert.equal(tokenRc.status, "success"); assert(tokenRc.contractAddress);
    const token = tokenRc.contractAddress;
    const tx = await operator.wallet.deployContract({ abi: ESCROW.abi, bytecode: ESCROW.bytecode.object, account: operator.account, chain: operator.chain,
      args: [operator.address, token, opId, coId, 20n, 40n, 60n, 30n, 30n] });
    const receipt = await operator.pub.waitForTransactionReceipt({ hash: tx });
    assert.equal(receipt.status, "success"); assert(receipt.contractAddress);
    const escrow = receipt.contractAddress;
    await write(operator, token, GOLD.abi, "mint", [holder.account.address, INITIAL]);
    await write(holder, token, GOLD.abi, "approve", [escrow, INITIAL]);
    const demo = new RedemptionCase(operator, holder, courier, escrow, token, opId, coId);
    if (startLock) {
      demo.id = await demo.lock();
      assert.equal(await demo.balance(escrow), AMOUNT);
    }
    return demo;
  }
  const scene = (id: string, kind: "attack" | "honest", claim: string, state: string,
    expect: Record<string, Status>, execute: (d: RedemptionCase) => Promise<void>): Scenario => ({
    id, kind, claim,
    run: async () => {
      const d = await fresh();
      await execute(d);
      const evidence = await observeEscrow({ pub: operator.pub, address: d.escrow }, d.id);
      const verified = verifyEscrowObservation(evidence);
      assert.equal(verified.state, state);
      assert.equal(verified.institutionNetworkCalls, 0);
      assert.equal(verified.checks.find(c => c.id === "lifecycle.consistency")?.status, "CONFIRMED");
      const report = { ...verified, escrow: d.escrow, token: d.token, log: operator.address,
        lateRecords: evidence.events.filter(e => e.args.late === true).map(e => ({ record: e.name, block: e.blockNumber })),
        holderBalance: await d.balance(holder.account.address), escrowBalance: await d.balance(d.escrow) };
      writeJson(`out/${id}.json`, { expected: { state, ...expect }, report, evidence });
      return { report, expect };
    },
  });
  return [
    scene("attack.redeemSilent", "attack", "Operator silence finalizes UNANSWERED and returns the exact locked tokens.", "RETURNED",
      { "operator.hop": "OBLIGATION_UNMET", "courier.hop": "NOT_DUE" }, async d => {
        await d.after(await d.read("decisionDue")); await d.tx("challenge", [d.id], holder);
        await d.after((await d.read("getLock")).responseDueBlock); await d.tx("finalize");
        assert.equal(await d.balance(holder.account.address), INITIAL); assert.equal(await d.balance(d.escrow), 0n);
      }),
    scene("attack.redeemAnswerWithOtherLock", "attack", "A genuine decision leaf belonging to a different lock cannot answer this lock.", "LOCKED",
      { "operator.hop": "NOT_DUE" }, async d => {
        const other = await d.lock(); const p = await d.proof(other, hash("private-other-decision"));
        await rejected(() => d.tx("proveDecision", [...p]), "BadInclusionProof");
      }),
    scene("attack.redeemEarlyChallenge", "attack", "A holder cannot challenge before the operator deadline.", "LOCKED",
      { "operator.hop": "NOT_DUE" }, async d => {
        await rejected(() => d.tx("challenge", [d.id], holder), "NotYetDue");
      }),
    scene("attack.burnWithoutDelivery", "attack", "No delivery record means no permissionless burn.", "LOCKED",
      { "operator.hop": "NOT_DUE" }, async d => {
        await rejected(() => d.tx("burn"), "WrongState"); assert.equal(await d.balance(d.escrow), AMOUNT);
      }),
    scene("attack.deliveryFromOperatorLog", "attack", "An operator-only root is unknown to the courier service and cannot prove delivery.", "HANDED_OFF",
      { "operator.hop": "CONFIRMED", "courier.hop": "NOT_DUE" }, async d => {
        await d.decide(); await d.handoff();
        const p = await d.proof(escrowDeliveryKey(d.id), hash("operator-cannot-claim-delivery"));
        await rejected(() => d.tx("proveDelivery", [...p]), "UnknownRoot");
      }),
    scene("attack.reclaimAfterHandoff", "attack", "A proven handoff prevents holder reclamation.", "HANDED_OFF",
      { "operator.hop": "CONFIRMED", "courier.hop": "NOT_DUE" }, async d => {
        await d.decide(); await d.handoff(); await rejected(() => d.tx("reclaim", [d.id], holder), "WrongState");
      }),
    scene("attack.courierSilent", "attack", "Courier silence is attributed to the courier; operator evidence remains confirmed and tokens stay locked.", "STALLED",
      { "operator.hop": "CONFIRMED", "courier.hop": "OBLIGATION_UNMET" }, async d => {
        await d.decide(); await d.handoff(); await d.after(await d.read("courierDue"));
        await d.tx("challenge", [d.id], holder); await d.after((await d.read("getLock")).responseDueBlock);
        await d.tx("finalize"); assert.equal(await d.balance(d.escrow), AMOUNT);
      }),
    scene("honest.redeemDenied", "honest", "A private decision without a handoff permits reclamation without labeling the recorded decision a violation.", "RETURNED",
      { "operator.hop": "CONFIRMED", "courier.hop": "NOT_DUE", "records.opening": "UNVERIFIABLE" }, async d => {
        await d.decide(1); await d.after(await d.read("handoffDue")); await d.tx("reclaim", [d.id], holder);
        assert.equal(await d.balance(holder.account.address), INITIAL);
      }),
    scene("honest.redeemDelivered", "honest", "The courier's delivery record and a complete dispute period allow burning; physical delivery stays out of scope.", "BURNED",
      { "operator.hop": "CONFIRMED", "courier.hop": "CONFIRMED", "delivery.physical": "OUT_OF_SCOPE" }, async d => {
        await d.decide(); await d.handoff(); await d.deliver(); await d.after(await d.read("disputeDue")); await d.tx("burn");
        assert.equal(await d.balance(d.escrow), 0n); assert.equal(await d.balance(holder.account.address), INITIAL - AMOUNT);
        assert.equal(await operator.pub.readContract({ address: d.token, abi: GOLD.abi, functionName: "totalSupply" }), INITIAL - AMOUNT);
      }),
    scene("honest.lateButRecorded", "honest", "A decision anchored during the response window is accepted with a permanent late flag.", "DECIDED",
      { "operator.hop": "CONFIRMED", "courier.hop": "NOT_DUE" }, async d => {
        await d.after(await d.read("decisionDue")); await d.tx("challenge", [d.id], holder);
        const receipt = await d.decide();
        const event: any = parseEventLogs({ abi: ESCROW.abi, logs: receipt.logs, eventName: "DecisionProven" })[0];
        assert.equal(event.args.late, true);
      }),
    scene("honest.disputeHoldsLock", "honest", "Holder dispute keeps tokens locked and blocks permissionless burn; dispute merits are out of scope.", "DISPUTED",
      { "operator.hop": "CONFIRMED", "courier.hop": "CONFIRMED", "dispute.merits": "OUT_OF_SCOPE" }, async d => {
        await d.decide(); await d.handoff(); await d.deliver(); await d.tx("dispute", [d.id], holder);
        await d.after(await d.read("disputeDue")); await rejected(() => d.tx("burn"), "WrongState");
        assert.equal(await d.balance(d.escrow), AMOUNT);
      }),
    {
      id: "attack.exchangeNotForwarded", kind: "attack",
      claim: "A signed inbox request left unforwarded finalizes exchange UNANSWERED without starting the escrow operator clock.",
      run: async () => {
        const expected = { "exchange.hop": "OBLIGATION_UNMET" as const, "operator.hop": "NOT_DUE" as const };
        const d = await fresh(false);
        const exchangeId = hash("inbox-demo-exchange");
        await registerService(courier, exchangeId, courier.account.address, hash("exchange-forward-profile"), 30, 10, 20);
        const inboxArtifact = artifact("RedemptionInbox");
        const tx = await operator.wallet.deployContract({ abi: inboxArtifact.abi, bytecode: inboxArtifact.bytecode.object,
          account: operator.account, chain: operator.chain, args: [operator.address, d.escrow, 20n, 30n] });
        const receipt = await operator.pub.waitForTransactionReceipt({ hash: tx });
        assert.equal(receipt.status, "success"); assert(receipt.contractAddress);
        const inbox = receipt.contractAddress;
        const block = await operator.pub.getBlockNumber({ cacheTime: 0 });
        const request = { holder: holder.account.address, exchangeServiceId: exchangeId, amount: AMOUNT,
          requestHash: hash("signed-inbox-redemption-request"), nonce: 0n, expiresAtBlock: block + 300n };
        const signature = await holder.wallet.signTypedData({ account: holder.account,
          domain: { name: "RedemptionInbox", version: "1", chainId: 31337, verifyingContract: inbox },
          primaryType: "Request", types: { Request: [
            { name: "holder", type: "address" }, { name: "exchangeServiceId", type: "bytes32" },
            { name: "amount", type: "uint128" }, { name: "requestHash", type: "bytes32" },
            { name: "nonce", type: "uint256" }, { name: "expiresAtBlock", type: "uint64" },
          ] }, message: request });
        const requestId = await operator.pub.readContract({ address: inbox, abi: inboxArtifact.abi, functionName: "hashRequest", args: [request] }) as Hex;
        await write(operator, inbox, inboxArtifact.abi, "submit", [request, signature]);
        const due = await operator.pub.readContract({ address: inbox, abi: inboxArtifact.abi, functionName: "forwardDue", args: [requestId] }) as bigint;
        await d.after(due);
        await write(holder, inbox, inboxArtifact.abi, "challenge", [requestId]);
        const stored: any = await operator.pub.readContract({ address: inbox, abi: inboxArtifact.abi, functionName: "getRequest", args: [requestId] });
        await d.after(stored.responseDueBlock);
        await write(operator, inbox, inboxArtifact.abi, "finalize", [requestId]);
        assert.equal(await d.read("nonces", [holder.account.address]), 0n);
        assert.equal(await d.balance(d.escrow), 0n);
        const { observeInbox, verifyInboxObservation } = await import("./inbox-verify.js");
        const evidence = await observeInbox({ pub: operator.pub, address: inbox }, requestId);
        const verified = verifyInboxObservation(evidence);
        assert.equal(verified.state, "UNANSWERED");
        assert.equal(verified.institutionNetworkCalls, 0);
        const report = { ...verified, inbox, escrowTarget: d.escrow, token: d.token, requestId, operatorClockStarted: false };
        writeJson("out/attack.exchangeNotForwarded.json", { expected, report, evidence });
        return { report, expect: expected };
      },
    },
  ];
}
