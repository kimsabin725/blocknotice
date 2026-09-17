# Redemption escrow implementation plan

**Goal:** Deliver the exchange inbox and two-hop escrow, real local scenarios, independent verification, deployment tooling and a tested GitHub branch.
**Spec:** `docs/redemption-design.md`, original gold RWA proposal §§9–10.
**Architecture:** Preserve BlockNoticeLog and its public deployments. Add a fixed-profile escrow and demo token; replay public events for each hop.
**Tech:** Solidity 0.8.28, Foundry, TypeScript/viem, existing depth-32 Merkle tree. No new production dependency.

## Implementation decisions (supersede unresolved design choices)

- Full dispute period starts at successful `proveDelivery` block; preserve anchor block separately for lateness.
- Handoff proof must be submitted by `handoffDue` (inclusive). Afterwards reclaim wins deterministically; no late handoff takeover.
- Anchors must be no earlier than lock, and delivery anchor no earlier than handoff anchor. Selected root block is the clock source; earliest inclusion is not claimed.
- Reject identical service IDs, unregistered services, zero addresses/non-contract dependencies, zero windows and handoff shorter than decision.
- Standard burnable token only: exact transfer deltas, exact supply reduction on burn, checks-effects-interactions and shared reentrancy guard.
- No admin, upgrades, rescue, or public outcome codes. STALLED holds funds; DISPUTED permits holder acknowledgement only.
- Events include proof block (transaction block), roots/indices/late and explicit hop. Fixed profile and getLock getter enable public replay cross-checks.
- User expanded scope to include inbox: EIP-712 submit, exchange-funded atomic forwarding via lockFor, rejection proofs, challenges and independent replay.

## Tasks and ownership

- [x] 1. Root: failing Foundry cases → interfaces, MockGold, escrow → boundary/adversarial/fuzz tests and gas report.
- [x] 2. Offchain agent: `src/escrow.ts`, `src/escrow-verify.ts`, new tests, CLI `verify --escrow` route. Consume final ABI and expose helpers/observer.
- [x] 3. Root: 12 real escrow/inbox scenarios, integrate with existing 18 and report; local deployment record and reproducible demo.
- [x] 4. Root: separate escrow deployment/check scripts (preserve existing deployments), update current docs/pitch and counts.
- [x] 5. Independent security/spec review → fixes → test:all, demo, deployment checks and PDF verified. Publication target: new public repository tnwjd023-boop/BlockNotice_GoldRWA, main branch.

## Shared contract interface

Constructor `(log, token, operatorServiceId, courierServiceId, decisionBlocks, handoffBlocks, courierBlocks, responseBlocks, disputeBlocks)`.
`lock(uint128 amount, bytes32 requestHash) returns(bytes32)`; `getLock(bytes32) returns Lock`;
`proveDecision/proveHandoff/proveDelivery(bytes32 lockId, bytes32 digest, uint64 index, bytes32 root, bytes32[] siblings)`;
`challenge/finalize/reclaim/acknowledge/dispute/burn(bytes32 lockId)`; `decisionDue/handoffDue/courierDue/disputeDue(bytes32) returns(uint64)`.
State order: NONE, LOCKED, OP_CHALLENGED, DECIDED, HANDED_OFF, COURIER_CHALLENGED, DELIVERED, BURNED, RETURNED, STALLED, DISPUTED.
Lock fields: holder, amount, requestHash, lockBlock, handoffAnchorBlock, deliveryAnchorBlock, deliveryProvenBlock, responseDueBlock, state.
Hop enum: OPERATOR=0, COURIER=1.
Proof events `(indexed lockId, leaf, root, uint64 index, bool late)`;
Locked `(indexed lockId, indexed holder, uint128 amount, requestHash)`;
ChallengeOpened `(indexed lockId, Hop hop, uint64 responseDueBlock)`; ChallengeUnanswered `(indexed lockId, Hop hop)`;
Returned/Disputed `(indexed lockId)`; Burned `(indexed lockId, bool byAck)`.

## Verification

Foundry: exact due boundaries, late delivery preserves dispute window, wrong lock/tag/service/root/depth/index, unknown lock,
holder authorization, constructor profile, no terminal-state replay, token failure and callbacks, concurrent locks, independent Merkle fuzz.
TypeScript: ABI hash parity, event-replay outcome versus real contract state, missing/reordered evidence refusal, no institution calls.
Demo: existing 18 plus 11 escrow and 1 inbox case = 30; each expectation declared before execution, no fabricated results.
Public deployment scripts: explicit network + deployer key, immutable/read-only check, separate `escrow-deployments.json`; no public deployment without configured wallet.

## Progress / rulings

Initial baseline: Solidity32, TS47, existing scenarios18 pass. Existing changes are prior approved submission work; preserve them.
Interface overlap: Task1 produces ABI consumed by Tasks2–4; Root owns scenarios/report/docs/deployment, agent owns escrow helper/verifier/CLI/tests only.
Ruling: full dispute window and strict handoff submission cutoff prioritize holder rights and remove expiry races; these are documented deviations from original anchor-only/late-handoff wording.
