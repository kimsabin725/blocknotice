// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BlockNoticeLog} from "../src/BlockNoticeLog.sol";

/// Independent (naive, full-rebuild) reference tree. If the contract's incremental frontier ever
/// disagrees with a straight rebuild, these tests fail — that is the whole point of having it.
library RefTree {
    uint256 internal constant DEPTH = 32;

    function node(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x01), l, r));
    }

    function zeros() internal pure returns (bytes32[DEPTH + 1] memory z) {
        z[0] = bytes32(0);
        for (uint256 i = 1; i <= DEPTH; i++) {
            z[i] = node(z[i - 1], z[i - 1]);
        }
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[DEPTH + 1] memory z = zeros();
        bytes32[] memory level = leaves;
        for (uint256 d = 0; d < DEPTH; d++) {
            uint256 n = (level.length + 1) / 2;
            bytes32[] memory next = new bytes32[](n);
            for (uint256 i = 0; i < n; i++) {
                bytes32 l = level[2 * i];
                bytes32 r = 2 * i + 1 < level.length ? level[2 * i + 1] : z[d];
                next[i] = node(l, r);
            }
            if (n == 0) {
                next = new bytes32[](1);
                next[0] = z[d + 1];
            }
            level = next;
        }
        return level[0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory sib) {
        bytes32[DEPTH + 1] memory z = zeros();
        sib = new bytes32[](DEPTH);
        bytes32[] memory level = leaves;
        uint256 idx = index;
        for (uint256 d = 0; d < DEPTH; d++) {
            uint256 s = idx ^ 1;
            sib[d] = s < level.length ? level[s] : z[d];
            uint256 n = (level.length + 1) / 2;
            bytes32[] memory next = new bytes32[](n);
            for (uint256 i = 0; i < n; i++) {
                bytes32 l = level[2 * i];
                bytes32 r = 2 * i + 1 < level.length ? level[2 * i + 1] : z[d];
                next[i] = node(l, r);
            }
            level = next;
            idx >>= 1;
        }
    }
}

contract BlockNoticeLogTest is Test {
    BlockNoticeLog bnl;

    bytes32 constant SERVICE = keccak256("demo-exchange");
    bytes32 constant PROFILE = keccak256("demo-sla-v1");
    uint64 constant RESPONSE_BLOCKS = 30;

    uint256 instKey = 0xA11CE;
    uint256 reqKey = 0xB0B;
    address inst;
    address requester;
    address operator = address(0xF00);

    bytes32[] all; // mirror of every leaf appended, in order
    bytes32 genesisRoot; // the empty root, anchored at registration — a deadline source far in the past

    uint64 constant REQ_BLOCKS = 10;
    uint64 constant DEC_BLOCKS = 20;

    function setUp() public {
        bnl = new BlockNoticeLog();
        inst = vm.addr(instKey);
        requester = vm.addr(reqKey);
        vm.prank(operator);
        bnl.registerService(SERVICE, inst, PROFILE, RESPONSE_BLOCKS, REQ_BLOCKS, DEC_BLOCKS);
        genesisRoot = bnl.getService(SERVICE).root;
        vm.roll(1000);
    }

    // ---------------- helpers ----------------
    function _append(bytes32[] memory leaves) internal returns (uint64 start) {
        vm.prank(operator);
        start = bnl.appendBatch(SERVICE, leaves);
        for (uint256 i = 0; i < leaves.length; i++) {
            all.push(leaves[i]);
        }
    }

    function _one(bytes32 x) internal pure returns (bytes32[] memory a) {
        a = new bytes32[](1);
        a[0] = x;
    }

    function _leaf(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), keccak256(abi.encode("record", i))));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _request(uint64 expires) internal view returns (BlockNoticeLog.Request memory) {
        return BlockNoticeLog.Request({
            schemaVersion: 1,
            serviceId: SERVICE,
            requestId: keccak256("req-1"),
            nonce: keccak256("nonce-1"),
            requesterKey: requester,
            responseEncryptionKeyHash: keccak256("hpke"),
            requestCommitment: keccak256("commit"),
            expiresAtBlock: expires
        });
    }

    /// Deadlines are derived from the block the cited anchor landed in, never from a number the
    /// institution picked. `anchorRoot` must be a root this contract actually recorded.
    function _accepted(bytes32 anchorRoot) internal view returns (BlockNoticeLog.AcceptedReceipt memory) {
        uint64 anchorBlock = bnl.rootInfo(SERVICE, anchorRoot).blockNumber;
        return BlockNoticeLog.AcceptedReceipt({
            requestId: keccak256("req-1"),
            signedRequestDigest: keccak256("reqdigest"),
            serviceId: SERVICE,
            institutionKeyId: keccak256(abi.encode(inst)),
            protocolProfileHash: PROFILE,
            acceptedAtClaimed: 1_700_000_000,
            referenceAnchorId: anchorRoot,
            requestRecordDueBlock: anchorBlock + REQ_BLOCKS,
            decisionRecordDueBlock: anchorBlock + DEC_BLOCKS,
            requesterKey: requester
        });
    }

    function _openChallenge(bytes32 anchorRoot) internal returns (bytes32 id) {
        BlockNoticeLog.AcceptedReceipt memory a = _accepted(anchorRoot);
        bytes memory sig = _sign(instKey, bnl.hashAcceptedReceipt(a));
        vm.prank(requester);
        id = bnl.challengeAccepted(a, sig);
    }

    // ---------------- log ----------------

    function test_emptyRootMatchesReference() public view {
        bytes32[] memory none = new bytes32[](0);
        assertEq(bnl.getService(SERVICE).root, RefTree.root(none), "empty root");
    }

    function test_appendMatchesFullRebuild() public {
        for (uint256 n = 1; n <= 9; n++) {
            _append(_one(_leaf(n)));
            assertEq(bnl.getService(SERVICE).root, RefTree.root(all), "root after leaf");
            assertEq(bnl.getService(SERVICE).size, uint64(all.length), "size");
        }
    }

    function test_batchEqualsSequential() public {
        bytes32[] memory b = new bytes32[](5);
        for (uint256 i = 0; i < 5; i++) {
            b[i] = _leaf(i);
        }
        _append(b);
        assertEq(bnl.getService(SERVICE).root, RefTree.root(all));
    }

    function testFuzz_appendMatchesRebuild(uint8 count) public {
        uint256 n = uint256(count) % 20 + 1;
        for (uint256 i = 0; i < n; i++) {
            _append(_one(_leaf(i)));
        }
        assertEq(bnl.getService(SERVICE).root, RefTree.root(all));
    }

    /// Past leaves cannot move: a proof made against an old root still verifies after more appends.
    function test_historicalRootStaysValid() public {
        _append(_one(_leaf(1)));
        bytes32 oldRoot = bnl.getService(SERVICE).root;
        bytes32[] memory sib = RefTree.proof(all, 0);
        _append(_one(_leaf(2)));
        _append(_one(_leaf(3)));
        assertTrue(bnl.getService(SERVICE).root != oldRoot, "root moved on");
        assertEq(bnl.rootInfo(SERVICE, oldRoot).size, 1, "old root still known");

        bytes32 id = _openChallenge(genesisRoot);
        bnl.respond(id, all[0], 0, oldRoot, sib);
        assertEq(uint8(bnl.getChallenge(id).state), uint8(BlockNoticeLog.ChallengeState.ANSWERED));
    }

    function test_onlyOperatorAppends() public {
        vm.expectRevert(BlockNoticeLog.NotOperator.selector);
        bnl.appendBatch(SERVICE, _one(_leaf(1)));
    }

    function test_rejectsEmptyAndOversizedBatch() public {
        vm.startPrank(operator);
        vm.expectRevert(BlockNoticeLog.EmptyBatch.selector);
        bnl.appendBatch(SERVICE, new bytes32[](0));
        vm.expectRevert(BlockNoticeLog.BatchTooLarge.selector);
        bnl.appendBatch(SERVICE, new bytes32[](257));
        vm.stopPrank();
    }

    function test_cannotRegisterTwice() public {
        vm.expectRevert(BlockNoticeLog.AlreadyRegistered.selector);
        bnl.registerService(SERVICE, inst, PROFILE, RESPONSE_BLOCKS, REQ_BLOCKS, DEC_BLOCKS);
    }

    // ---------------- public notice ----------------

    function test_postNotice() public {
        BlockNoticeLog.Request memory r = _request(uint64(block.number) + 100);
        bytes memory sig = _sign(reqKey, bnl.hashRequest(r));
        bytes32 d = bnl.postNotice(r, sig);
        assertEq(bnl.noticeBlock(d), uint64(block.number));

        vm.expectRevert(BlockNoticeLog.NoticeAlreadyPosted.selector);
        bnl.postNotice(r, sig);
    }

    function test_postNoticeRejectsForeignSignature() public {
        BlockNoticeLog.Request memory r = _request(uint64(block.number) + 100);
        bytes memory sig = _sign(instKey, bnl.hashRequest(r)); // not the requester
        vm.expectRevert(BlockNoticeLog.BadSignature.selector);
        bnl.postNotice(r, sig);
    }

    function test_postNoticeRejectsExpired() public {
        BlockNoticeLog.Request memory r = _request(uint64(block.number) - 1);
        bytes memory sig = _sign(reqKey, bnl.hashRequest(r));
        vm.expectRevert(BlockNoticeLog.RequestExpired.selector);
        bnl.postNotice(r, sig);
    }

    function test_signatureMalleabilityRejected() public {
        BlockNoticeLog.Request memory r = _request(uint64(block.number) + 100);
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(reqKey, bnl.hashRequest(r));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory flipped = abi.encodePacked(rr, bytes32(n - uint256(s)), uint8(v == 27 ? 28 : 27));
        vm.expectRevert(BlockNoticeLog.BadSignature.selector);
        bnl.postNotice(r, flipped);
    }

    // ---------------- challenge ----------------

    function test_challengeRequiresPassedDeadline() public {
        _append(_one(_leaf(1))); // a fresh anchor: its deadline is still in the future
        BlockNoticeLog.AcceptedReceipt memory a = _accepted(bnl.getService(SERVICE).root);
        bytes memory sig = _sign(instKey, bnl.hashAcceptedReceipt(a));
        vm.prank(requester);
        vm.expectRevert(BlockNoticeLog.NotYetDue.selector);
        bnl.challengeAccepted(a, sig);
    }

    /// Standing: holding a copy of someone else's receipt is not a right to demand evidence for it.
    function test_challengeRejectsStranger() public {
        BlockNoticeLog.AcceptedReceipt memory a = _accepted(genesisRoot);
        bytes memory sig = _sign(instKey, bnl.hashAcceptedReceipt(a));
        vm.prank(address(0xDEAD));
        vm.expectRevert(BlockNoticeLog.NotRequester.selector);
        bnl.challengeAccepted(a, sig);
    }

    /// The institution cannot buy time by signing a later deadline than the anchor implies.
    function test_challengeRejectsSelfDatedDeadline() public {
        BlockNoticeLog.AcceptedReceipt memory a = _accepted(genesisRoot);
        a.decisionRecordDueBlock += 5_000; // "our clock said we had longer"
        bytes memory sig = _sign(instKey, bnl.hashAcceptedReceipt(a));
        vm.prank(requester);
        vm.expectRevert(BlockNoticeLog.DeadlineNotDerived.selector);
        bnl.challengeAccepted(a, sig);
    }

    /// Nor by citing an anchor this chain never saw.
    function test_challengeRejectsUnknownAnchor() public {
        BlockNoticeLog.AcceptedReceipt memory a = _accepted(genesisRoot);
        a.referenceAnchorId = keccak256("an anchor that was never posted");
        bytes memory sig = _sign(instKey, bnl.hashAcceptedReceipt(a));
        vm.prank(requester);
        vm.expectRevert(BlockNoticeLog.UnknownAnchor.selector);
        bnl.challengeAccepted(a, sig);
    }

    function test_challengeRequiresInstitutionSignature() public {
        BlockNoticeLog.AcceptedReceipt memory a = _accepted(genesisRoot);
        bytes memory sig = _sign(reqKey, bnl.hashAcceptedReceipt(a)); // requester cannot fabricate one
        vm.expectRevert(BlockNoticeLog.BadSignature.selector);
        bnl.challengeAccepted(a, sig);
    }

    function test_challengeRequiresRegisteredProfile() public {
        BlockNoticeLog.AcceptedReceipt memory a = _accepted(genesisRoot);
        a.protocolProfileHash = keccak256("other-profile");
        bytes memory sig = _sign(instKey, bnl.hashAcceptedReceipt(a));
        vm.expectRevert(BlockNoticeLog.ProfileMismatch.selector);
        bnl.challengeAccepted(a, sig);
    }

    function test_challengeCannotBeOpenedTwice() public {
        _openChallenge(genesisRoot);
        BlockNoticeLog.AcceptedReceipt memory a = _accepted(genesisRoot);
        bytes memory sig = _sign(instKey, bnl.hashAcceptedReceipt(a));
        vm.prank(requester);
        vm.expectRevert(BlockNoticeLog.ChallengeExists.selector);
        bnl.challengeAccepted(a, sig);
    }

    // ---------------- respond ----------------

    function _setupAnswerable() internal returns (bytes32 id, bytes32[] memory sib, bytes32 root) {
        _append(_one(_leaf(1)));
        _append(_one(_leaf(2)));
        sib = RefTree.proof(all, 1);
        root = bnl.getService(SERVICE).root;
        id = _openChallenge(genesisRoot);
    }

    function test_respondHappyPath() public {
        (bytes32 id, bytes32[] memory sib, bytes32 root) = _setupAnswerable();
        bnl.respond(id, all[1], 1, root, sib);
        BlockNoticeLog.Challenge memory c = bnl.getChallenge(id);
        assertEq(uint8(c.state), uint8(BlockNoticeLog.ChallengeState.ANSWERED));
        assertEq(c.answeredLeaf, all[1]);
    }

    /// Answering late closes the challenge but must NOT erase the fact that recording was late.
    function test_lateAnchorIsFlagged() public {
        // deadline derived from the genesis anchor, long passed before anything was recorded
        bytes32 id = _openChallenge(genesisRoot);
        _append(_one(_leaf(7)));
        bytes32[] memory sib = RefTree.proof(all, 0);
        bytes32 root = bnl.getService(SERVICE).root;
        bnl.respond(id, all[0], 0, root, sib);
        assertTrue(bnl.getChallenge(id).answeredLate, "late flag");
    }

    function test_respondRejectsWrongProof() public {
        (bytes32 id, bytes32[] memory sib, bytes32 root) = _setupAnswerable();
        vm.expectRevert(BlockNoticeLog.BadInclusionProof.selector);
        bnl.respond(id, all[0], 1, root, sib); // right proof, wrong leaf
    }

    function test_respondRejectsUnknownRoot() public {
        (bytes32 id, bytes32[] memory sib,) = _setupAnswerable();
        vm.expectRevert(BlockNoticeLog.UnknownRoot.selector);
        bnl.respond(id, all[1], 1, keccak256("made up"), sib);
    }

    function test_respondRejectsIndexBeyondSize() public {
        (bytes32 id, bytes32[] memory sib, bytes32 root) = _setupAnswerable();
        vm.expectRevert(BlockNoticeLog.IndexOutOfRange.selector);
        bnl.respond(id, all[1], 9, root, sib);
    }

    function test_respondRejectsShortProof() public {
        (bytes32 id,, bytes32 root) = _setupAnswerable();
        vm.expectRevert(BlockNoticeLog.BadProofLength.selector);
        bnl.respond(id, all[1], 1, root, new bytes32[](8));
    }

    /// The response window boundary is specified as inclusive: exactly at the due block still works.
    function test_respondAtExactDeadlineSucceeds() public {
        (bytes32 id, bytes32[] memory sib, bytes32 root) = _setupAnswerable();
        vm.roll(bnl.getChallenge(id).responseDueBlock);
        bnl.respond(id, all[1], 1, root, sib);
        assertEq(uint8(bnl.getChallenge(id).state), uint8(BlockNoticeLog.ChallengeState.ANSWERED));
    }

    function test_respondOneBlockLateFails() public {
        (bytes32 id, bytes32[] memory sib, bytes32 root) = _setupAnswerable();
        vm.roll(bnl.getChallenge(id).responseDueBlock + 1);
        vm.expectRevert(BlockNoticeLog.ResponseWindowOver.selector);
        bnl.respond(id, all[1], 1, root, sib);
    }

    // ---------------- finalize ----------------

    function test_finalizeOnlyAfterWindow() public {
        (bytes32 id,,) = _setupAnswerable();
        vm.expectRevert(BlockNoticeLog.ResponseWindowOpen.selector);
        bnl.finalize(id);
        vm.roll(bnl.getChallenge(id).responseDueBlock + 1);
        bnl.finalize(id);
        assertEq(uint8(bnl.getChallenge(id).state), uint8(BlockNoticeLog.ChallengeState.UNANSWERED));
    }

    /// A late response cannot overwrite a finalised verdict.
    function test_cannotRespondAfterFinalize() public {
        (bytes32 id, bytes32[] memory sib, bytes32 root) = _setupAnswerable();
        vm.roll(bnl.getChallenge(id).responseDueBlock + 1);
        bnl.finalize(id);
        vm.expectRevert(BlockNoticeLog.ChallengeClosed.selector);
        bnl.respond(id, all[1], 1, root, sib);
    }

    function test_finalizeUnknownChallenge() public {
        vm.expectRevert(BlockNoticeLog.NoSuchChallenge.selector);
        bnl.finalize(keccak256("nope"));
    }

    // ---------------- gas, reported not asserted ----------------
    function test_gasAppendBatchSizes() public {
        uint256[4] memory sizes = [uint256(1), 4, 16, 64];
        for (uint256 k = 0; k < sizes.length; k++) {
            bytes32[] memory b = new bytes32[](sizes[k]);
            for (uint256 i = 0; i < sizes[k]; i++) {
                b[i] = _leaf(1000 * k + i);
            }
            vm.prank(operator);
            uint256 g = gasleft();
            bnl.appendBatch(SERVICE, b);
            emit log_named_uint(string.concat("appendBatch gas, batch=", vm.toString(sizes[k])), g - gasleft());
        }
    }
}
