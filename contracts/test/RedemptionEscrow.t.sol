// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BlockNoticeLog} from "../src/BlockNoticeLog.sol";
import {RedemptionEscrow} from "../src/RedemptionEscrow.sol";
import {IBlockNoticeLog} from "../src/interfaces/IBlockNoticeLog.sol";
import {IBurnableERC20} from "../src/interfaces/IBurnableERC20.sol";
import {MockGold} from "../src/mocks/MockGold.sol";
import {RefTree} from "./BlockNoticeLog.t.sol";

contract AdversarialGold is MockGold {
    bool public shortDeposit;
    bool public failTransfer;
    bool public skipBurn;
    bool public callback;
    bool public callbackRejected;
    bool public shortRefund;
    bool public wrongSupply;
    function configureDeltas(bool short_, bool supply_) external { shortRefund = short_; wrongSupply = supply_; }
    function configure(bool short_, bool fail_, bool skip_, bool callback_) external {
        shortDeposit = short_; failTransfer = fail_; skipBurn = skip_; callback = callback_;
    }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool result = super.transferFrom(from, to, amount);
        if (shortDeposit) super.burn(1);
        _attemptCallback();
        return result;
    }
    function transfer(address to, uint256 amount) public override returns (bool) {
        if (failTransfer) return false;
        bool result = super.transfer(to, amount);
        if (shortRefund) { balanceOf[to] -= 1; totalSupply -= 1; }
        _attemptCallback();
        return result;
    }
    function burn(uint256 amount) public override {
        if (wrongSupply) balanceOf[msg.sender] -= amount;
        else if (!skipBurn) super.burn(amount);
        _attemptCallback();
    }
    function _attemptCallback() internal {
        if (callback) {
            (bool ok, bytes memory data) = msg.sender.call(abi.encodeWithSignature("lock(uint128,bytes32)", uint128(1), bytes32(0)));
            callbackRejected = !ok && bytes4(data) == RedemptionEscrow.ReentrantCall.selector;
        }
    }
}

contract RedemptionEscrowTest is Test {
    BlockNoticeLog bnl;
    MockGold gold;
    RedemptionEscrow escrow;
    address holder = address(0xB0B);
    address operator = address(0xA11CE);
    address courier = address(0xCAFE);
    bytes32 constant OP = keccak256("gold-operator");
    bytes32 constant CO = keccak256("gold-courier");
    bytes32 constant DIGEST = keccak256("private-record-with-salt");
    uint128 constant AMOUNT = 100 ether;
    bytes32[] opLeaves;
    bytes32[] coLeaves;
    struct Proof { uint64 index; bytes32 root; bytes32[] siblings; }

    function setUp() public {
        vm.roll(1000);
        bnl = new BlockNoticeLog();
        vm.prank(operator);
        bnl.registerService(OP, operator, keccak256("op-profile"), 30, 10, 20);
        vm.prank(courier);
        bnl.registerService(CO, courier, keccak256("co-profile"), 30, 10, 20);
        gold = new MockGold();
        escrow = _deploy(gold);
        gold.mint(holder, 1000 ether);
        vm.prank(holder);
        gold.approve(address(escrow), type(uint256).max);
    }
    function _deploy(MockGold token) internal returns (RedemptionEscrow) {
        return new RedemptionEscrow(IBlockNoticeLog(address(bnl)), IBurnableERC20(address(token)), OP, CO, 20, 40, 60, 30, 30);
    }
    function _lock() internal returns (bytes32) {
        vm.prank(holder);
        return escrow.lock(AMOUNT, keccak256("request"));
    }
    function _proof(bool delivery, bytes32 key, bytes32 digest) internal returns (Proof memory p) {
        bytes32 leaf = bnl.decisionLeaf(key, digest);
        bytes32[] memory batch = new bytes32[](1);
        batch[0] = leaf;
        vm.prank(delivery ? courier : operator);
        p.index = bnl.appendBatch(delivery ? CO : OP, batch);
        if (delivery) {
            coLeaves.push(leaf);
            p.root = RefTree.root(coLeaves);
            p.siblings = RefTree.proof(coLeaves, p.index);
        } else {
            opLeaves.push(leaf);
            p.root = RefTree.root(opLeaves);
            p.siblings = RefTree.proof(opLeaves, p.index);
        }
    }
    function _decision(bytes32 id) internal {
        Proof memory p = _proof(false, id, DIGEST);
        escrow.proveDecision(id, DIGEST, p.index, p.root, p.siblings);
    }
    function _handoff(bytes32 id) internal {
        Proof memory p = _proof(false, keccak256(abi.encode(uint8(3), id)), DIGEST);
        escrow.proveHandoff(id, DIGEST, p.index, p.root, p.siblings);
    }
    function _delivery(bytes32 id) internal {
        Proof memory p = _proof(true, keccak256(abi.encode(uint8(4), id)), DIGEST);
        escrow.proveDelivery(id, DIGEST, p.index, p.root, p.siblings);
    }
    function _delivered() internal returns (bytes32 id) {
        id = _lock(); _decision(id); _handoff(id); _delivery(id);
    }
    function _state(bytes32 id, RedemptionEscrow.State want) internal view {
        assertEq(uint256(escrow.getLock(id).state), uint256(want));
    }

    function test_lockTransfersAndEmits() public {
        bytes32 request = keccak256("request");
        bytes32 expected = keccak256(abi.encode(block.chainid, address(escrow), holder, request, uint256(0)));
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RedemptionEscrow.Locked(expected, holder, AMOUNT, request);
        bytes32 id = _lock();
        assertEq(id, expected);
        assertEq(gold.balanceOf(holder), 900 ether);
        assertEq(gold.balanceOf(address(escrow)), AMOUNT);
        assertEq(escrow.nonces(holder), 1);
        assertEq(escrow.decisionDue(id), 1020);
        _state(id, RedemptionEscrow.State.LOCKED);
    }
    function test_lockRejectsZeroAndUnknownLock() public {
        vm.expectRevert(RedemptionEscrow.ZeroAmount.selector);
        escrow.lock(0, bytes32(0));
        vm.expectRevert(RedemptionEscrow.UnknownLock.selector);
        escrow.challenge(bytes32(0));
    }
    function test_profileHashBindsChainAndAddress() public {
        bytes32 expected = keccak256(abi.encode(block.chainid, address(escrow), address(bnl), address(gold), OP, CO,
            uint64(20), uint64(40), uint64(60), uint64(30), uint64(30)));
        assertEq(escrow.profileHash(), expected);
        RedemptionEscrow other = _deploy(gold);
        assertNotEq(other.profileHash(), expected);
        vm.chainId(block.chainid + 1);
        assertNotEq(_deploy(gold).profileHash(), expected);
    }
    function test_constructorRejectsInvalidProfiles() public {
        vm.expectRevert(RedemptionEscrow.BadProfile.selector);
        new RedemptionEscrow(IBlockNoticeLog(address(bnl)), IBurnableERC20(address(gold)), OP, OP, 20, 40, 60, 30, 30);
        vm.expectRevert(RedemptionEscrow.BadProfile.selector);
        new RedemptionEscrow(IBlockNoticeLog(address(bnl)), IBurnableERC20(address(gold)), OP, CO, 20, 19, 60, 30, 30);
        vm.expectRevert(RedemptionEscrow.BadProfile.selector);
        new RedemptionEscrow(IBlockNoticeLog(address(bnl)), IBurnableERC20(address(gold)), OP, CO, 0, 40, 60, 30, 30);
        vm.expectRevert(RedemptionEscrow.UnknownService.selector);
        new RedemptionEscrow(IBlockNoticeLog(address(bnl)), IBurnableERC20(address(gold)), OP, bytes32(0), 20, 40, 60, 30, 30);
        vm.expectRevert(RedemptionEscrow.BadProfile.selector);
        new RedemptionEscrow(IBlockNoticeLog(address(0)), IBurnableERC20(address(gold)), OP, CO, 20, 40, 60, 30, 30);
    }
    function test_constructorRejectsOverflowingWindows() public {
        vm.expectRevert(RedemptionEscrow.BadProfile.selector);
        new RedemptionEscrow(IBlockNoticeLog(address(bnl)), IBurnableERC20(address(gold)), OP, CO,
            20, type(uint64).max, 60, 30, 30);
    }
    function test_proveDecisionBeforeDue_notLate() public {
        bytes32 id = _lock();
        Proof memory p = _proof(false, id, DIGEST);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit RedemptionEscrow.DecisionProven(id, bnl.decisionLeaf(id, DIGEST), p.root, p.index, false);
        escrow.proveDecision(id, DIGEST, p.index, p.root, p.siblings);
        _state(id, RedemptionEscrow.State.DECIDED);
    }
    function test_proveDecisionAfterDue_late() public {
        bytes32 id = _lock(); vm.roll(1021);
        Proof memory p = _proof(false, id, DIGEST);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit RedemptionEscrow.DecisionProven(id, bnl.decisionLeaf(id, DIGEST), p.root, p.index, true);
        escrow.proveDecision(id, DIGEST, p.index, p.root, p.siblings);
    }
    function test_decisionLeafFromOtherLockRejected() public {
        bytes32 id = _lock(); bytes32 other = _lock();
        Proof memory p = _proof(false, other, DIGEST);
        vm.expectRevert(RedemptionEscrow.BadInclusionProof.selector);
        escrow.proveDecision(id, DIGEST, p.index, p.root, p.siblings);
    }
    function test_handoffLeafCannotProveDecision() public {
        bytes32 id = _lock();
        Proof memory p = _proof(false, keccak256(abi.encode(uint8(3), id)), DIGEST);
        vm.expectRevert(RedemptionEscrow.BadInclusionProof.selector);
        escrow.proveDecision(id, DIGEST, p.index, p.root, p.siblings);
    }
    function test_badRootIndexLengthAndSiblingRejected() public {
        bytes32 id = _lock(); Proof memory p = _proof(false, id, DIGEST);
        vm.expectRevert(RedemptionEscrow.UnknownRoot.selector);
        escrow.proveDecision(id, DIGEST, p.index, bytes32(0), p.siblings);
        vm.expectRevert(RedemptionEscrow.IndexOutOfRange.selector);
        escrow.proveDecision(id, DIGEST, p.index + 1, p.root, p.siblings);
        vm.expectRevert(RedemptionEscrow.BadProofLength.selector);
        escrow.proveDecision(id, DIGEST, p.index, p.root, new bytes32[](31));
        p.siblings[0] = keccak256("wrong");
        vm.expectRevert(RedemptionEscrow.BadInclusionProof.selector);
        escrow.proveDecision(id, DIGEST, p.index, p.root, p.siblings);
    }
    function test_deliveryFromOperatorLogRejected() public {
        bytes32 id = _lock(); _decision(id); _handoff(id);
        Proof memory p = _proof(false, keccak256(abi.encode(uint8(4), id)), DIGEST);
        vm.expectRevert(RedemptionEscrow.UnknownRoot.selector);
        escrow.proveDelivery(id, DIGEST, p.index, p.root, p.siblings);
    }
    function test_challengeAtDueAndByStrangerReverts() public {
        bytes32 id = _lock(); vm.roll(1020);
        vm.prank(holder); vm.expectRevert(RedemptionEscrow.NotYetDue.selector); escrow.challenge(id);
        vm.roll(1021);
        vm.expectRevert(RedemptionEscrow.NotHolder.selector); escrow.challenge(id);
    }
    function test_finalizeOperatorHopReturnsTokens() public {
        bytes32 id = _lock(); vm.roll(1021); vm.prank(holder); escrow.challenge(id);
        vm.roll(1051);
        vm.expectRevert(RedemptionEscrow.ResponseWindowOpen.selector); escrow.finalize(id);
        vm.roll(1052); escrow.finalize(id);
        _state(id, RedemptionEscrow.State.RETURNED);
        assertEq(gold.balanceOf(holder), 1000 ether);
        assertEq(gold.balanceOf(address(escrow)), 0);
        vm.expectRevert(RedemptionEscrow.WrongState.selector); escrow.finalize(id);
    }
    function test_challengeAnsweredAtBoundaryButNotAfter() public {
        bytes32 id = _lock(); vm.roll(1021); vm.prank(holder); escrow.challenge(id);
        vm.roll(1051); _decision(id); _state(id, RedemptionEscrow.State.DECIDED);
        bytes32 second = _lock(); vm.roll(1072); vm.prank(holder); escrow.challenge(second);
        vm.roll(1103); Proof memory p = _proof(false, second, DIGEST);
        vm.expectRevert(RedemptionEscrow.ResponseWindowOver.selector);
        escrow.proveDecision(second, DIGEST, p.index, p.root, p.siblings);
        escrow.finalize(second);
    }
    function test_finalizeCourierHopStalls() public {
        bytes32 id = _lock(); _decision(id); _handoff(id);
        vm.roll(1061); vm.prank(holder); escrow.challenge(id);
        vm.roll(1092); escrow.finalize(id);
        _state(id, RedemptionEscrow.State.STALLED);
        assertEq(gold.balanceOf(address(escrow)), AMOUNT);
        vm.prank(holder); vm.expectRevert(RedemptionEscrow.WrongState.selector); escrow.reclaim(id);
    }
    function test_courierAnswerAtResponseBoundary() public {
        bytes32 id = _lock(); _decision(id); _handoff(id);
        vm.roll(1061); vm.prank(holder); escrow.challenge(id);
        vm.roll(1091); _delivery(id);
        assertEq(escrow.disputeDue(id), 1121);
        _state(id, RedemptionEscrow.State.DELIVERED);
    }
    function test_courierProofAfterResponseWindowRejected() public {
        bytes32 id = _lock(); _decision(id); _handoff(id);
        vm.roll(1061); vm.prank(holder); escrow.challenge(id);
        vm.roll(1092); Proof memory p = _proof(true, keccak256(abi.encode(uint8(4), id)), DIGEST);
        vm.expectRevert(RedemptionEscrow.ResponseWindowOver.selector);
        escrow.proveDelivery(id, DIGEST, p.index, p.root, p.siblings);
        escrow.finalize(id); _state(id, RedemptionEscrow.State.STALLED);
    }
    function test_deliveryAnchorCannotPrecedeHandoff() public {
        bytes32 id = _lock(); _decision(id);
        Proof memory p = _proof(true, keccak256(abi.encode(uint8(4), id)), DIGEST);
        vm.roll(1001); _handoff(id);
        vm.expectRevert(RedemptionEscrow.BadAnchorOrder.selector);
        escrow.proveDelivery(id, DIGEST, p.index, p.root, p.siblings);
    }
    function test_reclaimAfterHandoffDue() public {
        bytes32 id = _lock(); _decision(id); vm.roll(1040);
        vm.prank(holder); vm.expectRevert(RedemptionEscrow.NotYetDue.selector); escrow.reclaim(id);
        vm.roll(1041); vm.prank(holder); escrow.reclaim(id);
        assertEq(gold.balanceOf(holder), 1000 ether);
        _state(id, RedemptionEscrow.State.RETURNED);
    }
    function test_handoffDeadlineCannotRaceReclaim() public {
        bytes32 id = _lock(); _decision(id);
        Proof memory p = _proof(false, keccak256(abi.encode(uint8(3), id)), DIGEST);
        vm.roll(1041);
        vm.expectRevert(RedemptionEscrow.HandoffWindowOver.selector);
        escrow.proveHandoff(id, DIGEST, p.index, p.root, p.siblings);
        vm.prank(holder); escrow.reclaim(id);
    }
    function test_handoffAtDeadlineAndReclaimAfterHandoffReverts() public {
        bytes32 id = _lock(); _decision(id); vm.roll(1040); _handoff(id);
        vm.roll(1041); vm.prank(holder);
        vm.expectRevert(RedemptionEscrow.WrongState.selector); escrow.reclaim(id);
    }
    function test_burnWithoutDeliveryOrBeforeDisputeDueReverts() public {
        bytes32 id = _lock(); vm.expectRevert(RedemptionEscrow.WrongState.selector); escrow.burn(id);
        _decision(id); _handoff(id); _delivery(id); vm.roll(1030);
        vm.expectRevert(RedemptionEscrow.NotYetDue.selector); escrow.burn(id);
        vm.roll(1031); escrow.burn(id);
        _state(id, RedemptionEscrow.State.BURNED);
        assertEq(gold.balanceOf(address(escrow)), 0);
        assertEq(gold.totalSupply(), 900 ether);
    }
    function test_delayedDeliveryProofPreservesFullDisputeWindow() public {
        bytes32 id = _lock(); _decision(id); _handoff(id);
        Proof memory p = _proof(true, keccak256(abi.encode(uint8(4), id)), DIGEST);
        vm.roll(1200);
        escrow.proveDelivery(id, DIGEST, p.index, p.root, p.siblings);
        assertEq(escrow.getLock(id).deliveryAnchorBlock, 1000);
        assertEq(escrow.disputeDue(id), 1230);
        vm.expectRevert(RedemptionEscrow.NotYetDue.selector); escrow.burn(id);
        vm.prank(holder); escrow.dispute(id);
        _state(id, RedemptionEscrow.State.DISPUTED);
    }
    function test_disputeBlocksBurn_ackStillBurns() public {
        bytes32 id = _delivered(); vm.roll(1030); vm.prank(holder); escrow.dispute(id);
        vm.roll(1031); vm.expectRevert(RedemptionEscrow.WrongState.selector); escrow.burn(id);
        vm.prank(holder); escrow.acknowledge(id);
        _state(id, RedemptionEscrow.State.BURNED);
        assertEq(gold.totalSupply(), 900 ether);
    }
    function test_disputeAfterWindowAndStrangerActionsRejected() public {
        bytes32 id = _delivered();
        vm.expectRevert(RedemptionEscrow.NotHolder.selector); escrow.acknowledge(id);
        vm.expectRevert(RedemptionEscrow.NotHolder.selector); escrow.dispute(id);
        vm.roll(1031); vm.prank(holder);
        vm.expectRevert(RedemptionEscrow.DisputeWindowOver.selector); escrow.dispute(id);
    }
    function test_acknowledgeImmediatelyAndTerminalReplayRejected() public {
        bytes32 id = _delivered(); vm.prank(holder); escrow.acknowledge(id);
        assertEq(gold.totalSupply(), 900 ether);
        vm.prank(holder); vm.expectRevert(RedemptionEscrow.WrongState.selector); escrow.acknowledge(id);
        vm.expectRevert(RedemptionEscrow.WrongState.selector); escrow.burn(id);
    }
    function test_anchorCannotPrecedeLock() public {
        bytes32 id = _lock(); vm.roll(999); Proof memory p = _proof(false, id, DIGEST); vm.roll(1000);
        vm.expectRevert(RedemptionEscrow.BadAnchorOrder.selector);
        escrow.proveDecision(id, DIGEST, p.index, p.root, p.siblings);
    }
    function test_multipleLocksRemainSolvent() public {
        bytes32 first = _delivered(); bytes32 second = _lock(); _decision(second);
        vm.prank(holder); escrow.acknowledge(first);
        assertEq(gold.balanceOf(address(escrow)), AMOUNT);
        vm.roll(1041); vm.prank(holder); escrow.reclaim(second);
        assertEq(gold.balanceOf(address(escrow)), 0);
        assertEq(gold.balanceOf(holder), 900 ether);
    }
    function _adversarial() internal returns (AdversarialGold bad) {
        bad = new AdversarialGold(); gold = bad; escrow = _deploy(bad);
        bad.mint(holder, 1000 ether); vm.prank(holder); bad.approve(address(escrow), type(uint256).max);
    }
    function test_lockForUsesCallerFundsAndHolderRights() public {
        address payer = address(0xF00D);
        gold.mint(payer, AMOUNT);
        vm.prank(payer); gold.approve(address(escrow), AMOUNT);
        vm.prank(payer);
        bytes32 id = escrow.lockFor(holder, AMOUNT, keccak256("gift"));
        assertEq(escrow.getLock(id).holder, holder);
        assertEq(escrow.nonces(holder), 1);
        assertEq(escrow.nonces(payer), 0);
        assertEq(gold.balanceOf(payer), 0);
        assertEq(gold.balanceOf(holder), 1000 ether);
        vm.roll(1021);
        vm.prank(payer); vm.expectRevert(RedemptionEscrow.NotHolder.selector); escrow.challenge(id);
        vm.prank(holder); escrow.challenge(id);
        vm.roll(1052); escrow.finalize(id);
        assertEq(gold.balanceOf(holder), 1100 ether);
    }
    function test_lockForRejectsZeroHolderAndCannotSpendHolderAllowance() public {
        vm.prank(holder); vm.expectRevert(RedemptionEscrow.ZeroHolder.selector);
        escrow.lockFor(address(0), AMOUNT, keccak256("gift"));
        vm.prank(address(0xF00D)); vm.expectRevert(MockGold.InsufficientAllowance.selector);
        escrow.lockFor(holder, AMOUNT, keccak256("gift"));
        assertEq(gold.balanceOf(holder), 1000 ether);
        assertEq(escrow.nonces(holder), 0);
        assertEq(gold.balanceOf(address(escrow)), 0);
    }
    function test_shortDepositRollsBackNonceAndBalance() public {
        AdversarialGold bad = _adversarial(); bad.configure(true, false, false, false);
        vm.prank(holder); vm.expectRevert(RedemptionEscrow.UnsupportedToken.selector);
        escrow.lock(AMOUNT, keccak256("request"));
        assertEq(escrow.nonces(holder), 0);
        assertEq(bad.balanceOf(holder), 1000 ether);
    }
    function test_failedRefundRollsBackState() public {
        AdversarialGold bad = _adversarial(); bytes32 id = _lock(); _decision(id);
        bad.configure(false, true, false, false); vm.roll(1041); vm.prank(holder);
        vm.expectRevert(RedemptionEscrow.TokenTransferFailed.selector); escrow.reclaim(id);
        _state(id, RedemptionEscrow.State.DECIDED);
        assertEq(bad.balanceOf(address(escrow)), AMOUNT);
    }
    function test_noOpBurnCannotMarkBurned() public {
        AdversarialGold bad = _adversarial(); bytes32 id = _delivered();
        bad.configure(false, false, true, false); vm.prank(holder);
        vm.expectRevert(RedemptionEscrow.UnsupportedToken.selector); escrow.acknowledge(id);
        _state(id, RedemptionEscrow.State.DELIVERED);
    }
    function test_shortRefundRollsBackBothBalances() public {
        AdversarialGold bad = _adversarial(); bytes32 id = _lock(); _decision(id);
        bad.configureDeltas(true, false); vm.roll(1041); vm.prank(holder);
        vm.expectRevert(RedemptionEscrow.UnsupportedToken.selector); escrow.reclaim(id);
        _state(id, RedemptionEscrow.State.DECIDED);
        assertEq(bad.balanceOf(holder), 900 ether);
        assertEq(bad.balanceOf(address(escrow)), AMOUNT);
        assertEq(bad.totalSupply(), 1000 ether);
    }
    function test_burnMustReduceSupplyAsWellAsBalance() public {
        AdversarialGold bad = _adversarial(); bytes32 id = _delivered();
        bad.configureDeltas(false, true); vm.prank(holder);
        vm.expectRevert(RedemptionEscrow.UnsupportedToken.selector); escrow.acknowledge(id);
        _state(id, RedemptionEscrow.State.DELIVERED);
        assertEq(bad.balanceOf(address(escrow)), AMOUNT);
        assertEq(bad.totalSupply(), 1000 ether);
    }
    function test_tokenCallbackCannotReenter() public {
        AdversarialGold bad = _adversarial(); bad.configure(false, false, false, true);
        _lock(); assertTrue(bad.callbackRejected());
    }
    function test_refundCallbackCannotReenter() public {
        AdversarialGold bad = _adversarial(); bytes32 id = _lock(); _decision(id);
        bad.configure(false, false, false, true); vm.roll(1041); vm.prank(holder); escrow.reclaim(id);
        assertTrue(bad.callbackRejected()); _state(id, RedemptionEscrow.State.RETURNED);
    }
    function test_burnCallbackCannotReenter() public {
        AdversarialGold bad = _adversarial(); bytes32 id = _delivered();
        bad.configure(false, false, false, true); vm.prank(holder); escrow.acknowledge(id);
        assertTrue(bad.callbackRejected()); _state(id, RedemptionEscrow.State.BURNED);
    }
    function testFuzz_proofAgainstReferenceTree(uint8 count_, uint8 index_) public {
        uint256 count = bound(count_, 1, 24);
        uint256 target = bound(index_, 0, count - 1);
        bytes32 id = _lock(); bytes32[] memory leaves = new bytes32[](count);
        for (uint256 i; i < count; ++i) leaves[i] = i == target ? bnl.decisionLeaf(id, DIGEST) : keccak256(abi.encode(i));
        vm.prank(operator); bnl.appendBatch(OP, leaves);
        escrow.proveDecision(id, DIGEST, uint64(target), RefTree.root(leaves), RefTree.proof(leaves, target));
        _state(id, RedemptionEscrow.State.DECIDED);
    }
}
