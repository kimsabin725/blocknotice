// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BlockNoticeLog} from "../src/BlockNoticeLog.sol";
import {RedemptionEscrow} from "../src/RedemptionEscrow.sol";
import {RedemptionInbox} from "../src/RedemptionInbox.sol";
import {IBlockNoticeLog} from "../src/interfaces/IBlockNoticeLog.sol";
import {IBurnableERC20} from "../src/interfaces/IBurnableERC20.sol";
import {MockGold} from "../src/mocks/MockGold.sol";
import {RefTree} from "./BlockNoticeLog.t.sol";

contract InboxAdversarialGold is MockGold {
    address public inboxTarget;
    bytes32 public requestId;
    bool public shortDeposit;
    bool public failEscrow;
    bool public callback;
    bool public callbackRejected;
    function configure(address target, bytes32 id, bool short_, bool fail_, bool callback_) external {
        inboxTarget = target; requestId = id; shortDeposit = short_; failEscrow = fail_; callback = callback_;
    }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (failEscrow && from == inboxTarget) return false;
        bool result = super.transferFrom(from, to, amount);
        if (shortDeposit && to == inboxTarget) super.burn(1);
        if (callback) {
            (bool ok, bytes memory data) = inboxTarget.call(abi.encodeWithSignature("forward(bytes32)", requestId));
            callbackRejected = !ok && bytes4(data) == RedemptionInbox.ReentrantCall.selector;
        }
        return result;
    }
}

contract RedemptionInboxTest is Test {
    BlockNoticeLog bnl;
    MockGold gold;
    RedemptionEscrow escrow;
    RedemptionInbox inbox;
    uint256 constant HOLDER_KEY = 0xB0B;
    address holder;
    address exchange = address(0xE001);
    address operator = address(0xA11CE);
    address courier = address(0xCAFE);
    bytes32 constant EX = keccak256("exchange");
    bytes32 constant OP = keccak256("operator");
    bytes32 constant CO = keccak256("courier");
    bytes32 constant DIGEST = keccak256("private-rejection-and-salt");
    uint128 constant AMOUNT = 100 ether;
    struct Proof { uint64 index; bytes32 root; bytes32[] siblings; }

    function setUp() public {
        vm.roll(1000); holder = vm.addr(HOLDER_KEY); bnl = new BlockNoticeLog();
        vm.prank(exchange); bnl.registerService(EX, exchange, keccak256("ex-profile"), 30, 10, 20);
        vm.prank(operator); bnl.registerService(OP, operator, keccak256("op-profile"), 30, 10, 20);
        vm.prank(courier); bnl.registerService(CO, courier, keccak256("co-profile"), 30, 10, 20);
        _deploy(new MockGold());
    }
    function _deploy(MockGold token) internal {
        gold = token;
        escrow = new RedemptionEscrow(IBlockNoticeLog(address(bnl)), IBurnableERC20(address(token)), OP, CO, 20, 40, 60, 30, 30);
        inbox = new RedemptionInbox(IBlockNoticeLog(address(bnl)), escrow, 20, 30);
        gold.mint(exchange, 1000 ether);
        vm.prank(exchange); gold.approve(address(inbox), type(uint256).max);
    }
    function _request(uint256 nonce) internal view returns (RedemptionInbox.Request memory) {
        return RedemptionInbox.Request(holder, EX, AMOUNT, keccak256("request"), nonce, 1100);
    }
    function _sig(bytes32 hash, uint256 key) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }
    function _submit(uint256 nonce) internal returns (bytes32) {
        RedemptionInbox.Request memory r = _request(nonce);
        return inbox.submit(r, _sig(inbox.hashRequest(r), HOLDER_KEY));
    }
    function _state(bytes32 id, RedemptionInbox.State want) internal view {
        assertEq(uint256(inbox.getRequest(id).state), uint256(want));
    }
    function _proof(bytes32 service, bytes32 key) internal returns (Proof memory p) {
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = bnl.decisionLeaf(key, DIGEST);
        vm.prank(service == EX ? exchange : operator);
        p.index = bnl.appendBatch(service, leaves);
        p.root = RefTree.root(leaves); p.siblings = RefTree.proof(leaves, 0);
    }
    function _rejection(bytes32 id) internal returns (Proof memory) {
        return _proof(EX, keccak256(abi.encode(uint8(5), id)));
    }
    function _prove(bytes32 id, Proof memory p) internal {
        inbox.proveRejection(id, DIGEST, p.index, p.root, p.siblings);
    }

    function test_hashMatchesIndependentEip712Encoding() public view {
        RedemptionInbox.Request memory r = _request(7);
        bytes32 domain = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("RedemptionInbox"), keccak256("1"), block.chainid, address(inbox)));
        bytes32 body = keccak256(abi.encode(keccak256("Request(address holder,bytes32 exchangeServiceId,uint128 amount,bytes32 requestHash,uint256 nonce,uint64 expiresAtBlock)"),
            r.holder, r.exchangeServiceId, r.amount, r.requestHash, r.nonce, r.expiresAtBlock));
        assertEq(inbox.domainSeparator(), domain);
        assertEq(inbox.hashRequest(r), keccak256(abi.encodePacked(hex"1901", domain, body)));
    }
    function test_submitRelayedStoresHolderAndPinnedOperator() public {
        RedemptionInbox.Request memory r = _request(7); bytes32 expected = inbox.hashRequest(r);
        vm.expectEmit(true, true, true, true, address(inbox));
        emit RedemptionInbox.Submitted(expected, holder, EX, AMOUNT, r.requestHash, 1020);
        bytes32 id = _submit(7);
        assertEq(id, expected); assertEq(inbox.submittedBlock(id), 1000); assertEq(inbox.forwardDue(id), 1020);
        assertTrue(inbox.usedNonces(holder, 7));
        RedemptionInbox.StoredRequest memory stored = inbox.getRequest(id);
        assertEq(stored.holder, holder); assertEq(stored.exchangeOperator, exchange);
        assertEq(stored.exchangeServiceId, EX); assertEq(stored.amount, AMOUNT);
        assertEq(stored.requestHash, r.requestHash); assertEq(stored.nonce, 7); assertEq(stored.expiresAtBlock, 1100);
        assertEq(stored.lockId, bytes32(0)); _state(id, RedemptionInbox.State.SUBMITTED);
        assertEq(escrow.nonces(holder), 0); assertEq(gold.balanceOf(address(escrow)), 0);
    }
    function test_profilePinsDependenciesChainAddressAndWindows() public view {
        assertEq(inbox.profileHash(), keccak256(abi.encode(block.chainid, address(inbox), address(bnl), address(escrow), uint64(20), uint64(30))));
        assertEq(address(inbox.token()), address(gold));
    }
    function test_submitRejectsReplayAndChangedRequestSameNonce() public {
        _submit(7);
        RedemptionInbox.Request memory r = _request(7); r.requestHash = keccak256("another-request");
        bytes memory signature = _sig(inbox.hashRequest(r), HOLDER_KEY);
        vm.expectRevert(RedemptionInbox.NonceUsed.selector); inbox.submit(r, signature);
    }
    function test_submitRejectsWrongSignerAndTampering() public {
        RedemptionInbox.Request memory r = _request(0);
        bytes memory signature = _sig(inbox.hashRequest(r), HOLDER_KEY + 1);
        vm.expectRevert(RedemptionInbox.BadSignature.selector); inbox.submit(r, signature);
        signature = _sig(inbox.hashRequest(r), HOLDER_KEY); r.amount++;
        vm.expectRevert(RedemptionInbox.BadSignature.selector); inbox.submit(r, signature);
        assertFalse(inbox.usedNonces(holder, 0));
    }
    function test_domainSeparatesInboxAndChain() public {
        RedemptionInbox.Request memory r = _request(0);
        RedemptionInbox other = new RedemptionInbox(IBlockNoticeLog(address(bnl)), escrow, 20, 30);
        bytes memory signature = _sig(other.hashRequest(r), HOLDER_KEY);
        vm.expectRevert(RedemptionInbox.BadSignature.selector); inbox.submit(r, signature);
        signature = _sig(inbox.hashRequest(r), HOLDER_KEY); vm.chainId(block.chainid + 1);
        vm.expectRevert(RedemptionInbox.BadSignature.selector); inbox.submit(r, signature);
    }
    function test_highSMalformedAndZeroSignerRejected() public {
        RedemptionInbox.Request memory r = _request(0);
        (uint8 v, bytes32 rs, bytes32 ss) = vm.sign(HOLDER_KEY, inbox.hashRequest(r));
        uint256 order = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory signature = abi.encodePacked(rs, bytes32(order - uint256(ss)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(RedemptionInbox.BadSignature.selector); inbox.submit(r, signature);
        vm.expectRevert(RedemptionInbox.BadSignature.selector); inbox.submit(r, hex"00");
        vm.expectRevert(RedemptionInbox.BadSignature.selector); inbox.submit(r, abi.encodePacked(bytes32(0), bytes32(0), uint8(27)));
    }
    function test_submitExpiryInclusiveAndExpiredRollback() public {
        vm.roll(1100); _submit(0);
        RedemptionInbox.Request memory r = _request(1); bytes memory signature = _sig(inbox.hashRequest(r), HOLDER_KEY);
        vm.roll(1101); vm.expectRevert(RedemptionInbox.RequestExpired.selector); inbox.submit(r, signature);
        assertFalse(inbox.usedNonces(holder, 1));
    }
    function test_submitRejectsZeroHolderAmountAndUnknownService() public {
        RedemptionInbox.Request memory r = _request(0); r.holder = address(0);
        vm.expectRevert(RedemptionInbox.BadRequest.selector); inbox.submit(r, hex"");
        r = _request(0); r.amount = 0;
        vm.expectRevert(RedemptionInbox.BadRequest.selector); inbox.submit(r, hex"");
        r = _request(0); r.exchangeServiceId = bytes32(0);
        bytes memory signature = _sig(inbox.hashRequest(r), HOLDER_KEY);
        vm.expectRevert(RedemptionInbox.UnknownService.selector); inbox.submit(r, signature);
    }
    function test_constructorRejectsMismatchedLogAndWindows() public {
        BlockNoticeLog other = new BlockNoticeLog();
        vm.expectRevert(RedemptionInbox.BadProfile.selector); new RedemptionInbox(IBlockNoticeLog(address(other)), escrow, 20, 30);
        vm.expectRevert(RedemptionInbox.BadProfile.selector); new RedemptionInbox(IBlockNoticeLog(address(bnl)), escrow, 0, 30);
        vm.expectRevert(RedemptionInbox.BadProfile.selector); new RedemptionInbox(IBlockNoticeLog(address(bnl)), escrow, 20, 0);
        vm.expectRevert(RedemptionInbox.BadProfile.selector); new RedemptionInbox(IBlockNoticeLog(address(bnl)), escrow, type(uint64).max, 30);
        vm.expectRevert(RedemptionInbox.BadProfile.selector); new RedemptionInbox(IBlockNoticeLog(address(0)), escrow, 20, 30);
    }
    function test_forwardUsesExchangeFundsAndPreservesDonations() public {
        bytes32 id = _submit(0); gold.mint(address(inbox), 7 ether); vm.roll(1005);
        bytes32 expected = keccak256(abi.encode(block.chainid, address(escrow), holder, keccak256("request"), uint256(0)));
        vm.expectEmit(true, true, false, true, address(inbox)); emit RedemptionInbox.Forwarded(id, expected, false);
        vm.prank(exchange); bytes32 lockId = inbox.forward(id);
        assertEq(lockId, expected); assertEq(inbox.getRequest(id).lockId, lockId); _state(id, RedemptionInbox.State.FORWARDED);
        assertEq(gold.balanceOf(exchange), 900 ether); assertEq(gold.balanceOf(holder), 0);
        assertEq(gold.balanceOf(address(inbox)), 7 ether); assertEq(gold.balanceOf(address(escrow)), AMOUNT);
        assertEq(gold.allowance(address(inbox), address(escrow)), 0);
        RedemptionEscrow.Lock memory l = escrow.getLock(lockId);
        assertEq(l.holder, holder); assertEq(l.amount, AMOUNT); assertEq(l.lockBlock, 1005); assertEq(escrow.decisionDue(lockId), 1025);
        vm.roll(1026); vm.prank(exchange); vm.expectRevert(RedemptionEscrow.NotHolder.selector); escrow.challenge(lockId);
        vm.prank(holder); escrow.challenge(lockId); vm.roll(1057); escrow.finalize(lockId);
        assertEq(gold.balanceOf(holder), AMOUNT);
    }
    function test_onlyExchangeOperatorCanForwardEvenIfHolderApproved() public {
        bytes32 id = _submit(0); gold.mint(holder, AMOUNT); vm.prank(holder); gold.approve(address(inbox), AMOUNT);
        vm.prank(holder); vm.expectRevert(RedemptionInbox.NotExchange.selector); inbox.forward(id);
        vm.prank(operator); vm.expectRevert(RedemptionInbox.NotExchange.selector); inbox.forward(id);
        assertEq(gold.balanceOf(holder), AMOUNT); assertEq(gold.balanceOf(exchange), 1000 ether);
    }
    function test_unrelatedGiftCannotSatisfyInboxObligation() public {
        bytes32 id = _submit(0); vm.prank(exchange); gold.approve(address(escrow), AMOUNT);
        vm.prank(exchange); escrow.lockFor(holder, AMOUNT, keccak256("request"));
        _state(id, RedemptionInbox.State.SUBMITTED); assertEq(inbox.getRequest(id).lockId, bytes32(0));
        vm.roll(1021); vm.prank(holder); inbox.challenge(id); vm.roll(1052); inbox.finalize(id);
        _state(id, RedemptionInbox.State.UNANSWERED); assertEq(escrow.nonces(holder), 1);
    }
    function test_silentExchangeNeverStartsEscrowClock() public {
        bytes32 id = _submit(0); vm.roll(1021); vm.prank(holder); inbox.challenge(id); vm.roll(1052);
        vm.expectEmit(true, false, false, true, address(inbox)); emit RedemptionInbox.ChallengeUnanswered(id);
        inbox.finalize(id); _state(id, RedemptionInbox.State.UNANSWERED);
        assertEq(escrow.nonces(holder), 0); assertEq(gold.balanceOf(address(escrow)), 0);
    }
    function test_challengeHolderAndDueBoundaries() public {
        bytes32 id = _submit(0); vm.roll(1020);
        vm.prank(holder); vm.expectRevert(RedemptionInbox.NotYetDue.selector); inbox.challenge(id);
        vm.roll(1021); vm.expectRevert(RedemptionInbox.NotHolder.selector); inbox.challenge(id);
        vm.expectEmit(true, false, false, true, address(inbox)); emit RedemptionInbox.ChallengeOpened(id, 1051);
        vm.prank(holder); inbox.challenge(id);
        assertEq(inbox.getRequest(id).responseDueBlock, 1051);
        vm.roll(1051); vm.expectRevert(RedemptionInbox.ResponseWindowOpen.selector); inbox.finalize(id);
        vm.roll(1052); inbox.finalize(id);
    }
    function test_lateForwardWithoutChallengeIsRecorded() public {
        bytes32 id = _submit(0); vm.roll(1200);
        bytes32 expected = keccak256(abi.encode(block.chainid, address(escrow), holder, keccak256("request"), uint256(0)));
        vm.expectEmit(true, true, false, true, address(inbox)); emit RedemptionInbox.Forwarded(id, expected, true);
        vm.prank(exchange); inbox.forward(id);
    }
    function test_forwardAtResponseDueClearsChallenge() public {
        bytes32 id = _submit(0); vm.roll(1021); vm.prank(holder); inbox.challenge(id); vm.roll(1051);
        vm.prank(exchange); inbox.forward(id); _state(id, RedemptionInbox.State.FORWARDED);
        assertEq(inbox.getRequest(id).responseDueBlock, 0);
        vm.roll(1052); vm.expectRevert(RedemptionInbox.WrongState.selector); inbox.finalize(id);
    }
    function test_forwardAfterResponseDueRejectedBeforeAndAfterFinalize() public {
        bytes32 id = _submit(0); vm.roll(1021); vm.prank(holder); inbox.challenge(id); vm.roll(1052);
        vm.prank(exchange); vm.expectRevert(RedemptionInbox.ResponseWindowOver.selector); inbox.forward(id);
        inbox.finalize(id);
        vm.prank(exchange); vm.expectRevert(RedemptionInbox.WrongState.selector); inbox.forward(id);
        assertEq(gold.balanceOf(exchange), 1000 ether);
    }
    function test_rejectionUsesTaggedExchangeLeafAndEmits() public {
        bytes32 id = _submit(0); Proof memory p = _rejection(id);
        vm.expectEmit(true, false, false, true, address(inbox));
        emit RedemptionInbox.RejectionProven(id, bnl.decisionLeaf(keccak256(abi.encode(uint8(5), id)), DIGEST), p.root, p.index, false);
        _prove(id, p); _state(id, RedemptionInbox.State.REJECTED);
        assertEq(escrow.nonces(holder), 0); assertEq(gold.balanceOf(exchange), 1000 ether);
    }
    function test_rejectionWrongServiceRejected() public {
        bytes32 id = _submit(0); Proof memory p = _proof(OP, keccak256(abi.encode(uint8(5), id)));
        vm.expectRevert(RedemptionInbox.UnknownRoot.selector); _prove(id, p);
    }
    function test_rejectionWrongTagAndOtherRequestRejected() public {
        bytes32 id = _submit(0); Proof memory p = _proof(EX, id);
        vm.expectRevert(RedemptionInbox.BadInclusionProof.selector); _prove(id, p);
        bytes32 other = _submit(1);
        vm.expectRevert(RedemptionInbox.BadInclusionProof.selector); _prove(other, p);
    }
    function test_rejectionBadIndexLengthAndSiblingRejected() public {
        bytes32 id = _submit(0); Proof memory p = _rejection(id);
        vm.expectRevert(RedemptionInbox.IndexOutOfRange.selector); inbox.proveRejection(id, DIGEST, 1, p.root, p.siblings);
        vm.expectRevert(RedemptionInbox.BadProofLength.selector); inbox.proveRejection(id, DIGEST, 0, p.root, new bytes32[](31));
        p.siblings[0] = keccak256("wrong");
        vm.expectRevert(RedemptionInbox.BadInclusionProof.selector); _prove(id, p);
    }
    function test_rejectionAnchorCannotPrecedeSubmission() public {
        RedemptionInbox.Request memory r = _request(0); bytes32 id = inbox.hashRequest(r); Proof memory p = _rejection(id);
        vm.roll(1001); _submit(0);
        vm.expectRevert(RedemptionInbox.BadAnchorOrder.selector); _prove(id, p);
    }
    function test_lateRejectionMeasuresSelectedRootAnchor() public {
        bytes32 id = _submit(0); vm.roll(1021); Proof memory p = _rejection(id);
        vm.expectEmit(true, false, false, true, address(inbox));
        emit RedemptionInbox.RejectionProven(id, bnl.decisionLeaf(keccak256(abi.encode(uint8(5), id)), DIGEST), p.root, p.index, true);
        _prove(id, p);
    }
    function test_rejectionAtResponseDueClearsChallenge() public {
        bytes32 id = _submit(0); vm.roll(1021); vm.prank(holder); inbox.challenge(id); vm.roll(1051);
        _prove(id, _rejection(id)); _state(id, RedemptionInbox.State.REJECTED);
        assertEq(inbox.getRequest(id).responseDueBlock, 0);
    }
    function test_rejectionAfterResponseDueRejected() public {
        bytes32 id = _submit(0); Proof memory p = _rejection(id); vm.roll(1021); vm.prank(holder); inbox.challenge(id);
        vm.roll(1052); vm.expectRevert(RedemptionInbox.ResponseWindowOver.selector); _prove(id, p);
        inbox.finalize(id); vm.expectRevert(RedemptionInbox.WrongState.selector); _prove(id, p);
    }
    function test_terminalStatesCannotReplayOrChangeOutcome() public {
        bytes32 id = _submit(0); Proof memory p = _rejection(id); _prove(id, p);
        vm.expectRevert(RedemptionInbox.WrongState.selector); _prove(id, p);
        vm.prank(exchange); vm.expectRevert(RedemptionInbox.WrongState.selector); inbox.forward(id);
        vm.prank(holder); vm.expectRevert(RedemptionInbox.WrongState.selector); inbox.challenge(id);
        bytes32 forwarded = _submit(1); vm.prank(exchange); inbox.forward(forwarded);
        vm.prank(exchange); vm.expectRevert(RedemptionInbox.WrongState.selector); inbox.forward(forwarded);
        vm.expectRevert(RedemptionInbox.WrongState.selector); _prove(forwarded, p);
    }
    function test_unknownRequestsRejected() public {
        vm.expectRevert(RedemptionInbox.UnknownRequest.selector); inbox.getRequest(bytes32(0));
        vm.expectRevert(RedemptionInbox.UnknownRequest.selector); inbox.forward(bytes32(0));
        vm.expectRevert(RedemptionInbox.UnknownRequest.selector); inbox.challenge(bytes32(0));
        vm.expectRevert(RedemptionInbox.UnknownRequest.selector); inbox.finalize(bytes32(0));
    }
    function test_failedFundingRollsBackStateAndEscrowNonce() public {
        bytes32 id = _submit(0); vm.prank(exchange); gold.approve(address(inbox), 0);
        vm.prank(exchange); vm.expectRevert(MockGold.InsufficientAllowance.selector); inbox.forward(id);
        _state(id, RedemptionInbox.State.SUBMITTED); assertEq(escrow.nonces(holder), 0);
        assertEq(gold.balanceOf(exchange), 1000 ether); assertEq(gold.balanceOf(address(inbox)), 0);
        assertEq(inbox.getRequest(id).lockId, bytes32(0));
    }
    function test_shortIncomingTransferRollsBackEverything() public {
        InboxAdversarialGold bad = new InboxAdversarialGold(); _deploy(bad); bytes32 id = _submit(0);
        bad.configure(address(inbox), id, true, false, false);
        vm.prank(exchange); vm.expectRevert(RedemptionInbox.UnsupportedToken.selector); inbox.forward(id);
        _state(id, RedemptionInbox.State.SUBMITTED); assertEq(gold.balanceOf(exchange), 1000 ether);
        assertEq(escrow.nonces(holder), 0); assertEq(gold.totalSupply(), 1000 ether);
    }
    function test_failedEscrowPullRollsBackFundingApprovalAndState() public {
        InboxAdversarialGold bad = new InboxAdversarialGold(); _deploy(bad); bytes32 id = _submit(0);
        bad.configure(address(inbox), id, false, true, false);
        vm.prank(exchange); vm.expectRevert(RedemptionEscrow.TokenTransferFailed.selector); inbox.forward(id);
        _state(id, RedemptionInbox.State.SUBMITTED); assertEq(gold.balanceOf(exchange), 1000 ether);
        assertEq(gold.balanceOf(address(inbox)), 0); assertEq(gold.allowance(address(inbox), address(escrow)), 0);
        assertEq(escrow.nonces(holder), 0);
    }
    function test_incomingAndOutgoingTokenCallbacksCannotReenter() public {
        InboxAdversarialGold bad = new InboxAdversarialGold(); _deploy(bad); bytes32 id = _submit(0);
        bad.configure(address(inbox), id, false, false, true); vm.prank(exchange); inbox.forward(id);
        assertTrue(bad.callbackRejected()); _state(id, RedemptionInbox.State.FORWARDED);
        assertEq(escrow.nonces(holder), 1); assertEq(gold.balanceOf(address(escrow)), AMOUNT);
    }
    function test_failedApprovalCleanupRollsBackEvenCreatedEscrowLock() public {
        bytes32 id = _submit(0);
        vm.mockCall(address(gold), abi.encodeWithSelector(gold.approve.selector, address(escrow), uint256(0)), abi.encode(false));
        vm.prank(exchange); vm.expectRevert(RedemptionInbox.TokenTransferFailed.selector); inbox.forward(id);
        _state(id, RedemptionInbox.State.SUBMITTED);
        assertEq(escrow.nonces(holder), 0); assertEq(gold.balanceOf(address(escrow)), 0);
        assertEq(gold.balanceOf(exchange), 1000 ether); assertEq(gold.balanceOf(address(inbox)), 0);
        assertEq(gold.allowance(address(inbox), address(escrow)), 0);
        assertEq(inbox.getRequest(id).lockId, bytes32(0));
    }
    function test_approvalReturningTrueWithoutAllowanceCannotForward() public {
        bytes32 id = _submit(0);
        vm.mockCall(address(gold), abi.encodeWithSelector(gold.approve.selector, address(escrow), uint256(AMOUNT)), abi.encode(true));
        vm.prank(exchange); vm.expectRevert(RedemptionInbox.UnsupportedToken.selector); inbox.forward(id);
        _state(id, RedemptionInbox.State.SUBMITTED); assertEq(gold.balanceOf(exchange), 1000 ether);
        assertEq(escrow.nonces(holder), 0);
    }
    function test_forwardExactlyAtDueIsNotLate() public {
        bytes32 id = _submit(0); vm.roll(1020);
        bytes32 expected = keccak256(abi.encode(block.chainid, address(escrow), holder, keccak256("request"), uint256(0)));
        vm.expectEmit(true, true, false, true, address(inbox)); emit RedemptionInbox.Forwarded(id, expected, false);
        vm.prank(exchange); inbox.forward(id);
    }
    function testFuzz_rejectionAgainstIndependentTree(uint8 count_, uint8 index_) public {
        uint256 count = bound(count_, 1, 24); uint256 target = bound(index_, 0, count - 1);
        bytes32 id = _submit(0); bytes32[] memory leaves = new bytes32[](count);
        bytes32 leaf = bnl.decisionLeaf(keccak256(abi.encode(uint8(5), id)), DIGEST);
        for (uint256 i; i < count; ++i) leaves[i] = i == target ? leaf : keccak256(abi.encode(i));
        vm.prank(exchange); bnl.appendBatch(EX, leaves);
        inbox.proveRejection(id, DIGEST, uint64(target), RefTree.root(leaves), RefTree.proof(leaves, target));
        _state(id, RedemptionInbox.State.REJECTED);
    }
}
