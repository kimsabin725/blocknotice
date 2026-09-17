// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IBlockNoticeLog} from "./interfaces/IBlockNoticeLog.sol";
import {IBurnableERC20} from "./interfaces/IBurnableERC20.sol";

/// @notice Fixed-profile two-hop redemption accountability. Does not prove physical delivery.
/// @dev No owner, upgrades, rescue or public decision outcomes. Use only a trusted exact-transfer,
///      non-rebasing burnable token. STALLED needs an off-chain solution; no admin can unlock it.
contract RedemptionEscrow {
    enum State { NONE, LOCKED, OP_CHALLENGED, DECIDED, HANDED_OFF,
        COURIER_CHALLENGED, DELIVERED, BURNED, RETURNED, STALLED, DISPUTED }
    enum Hop { OPERATOR, COURIER }
    struct Lock {
        address holder;
        uint128 amount;
        bytes32 requestHash;
        uint64 lockBlock;
        uint64 handoffAnchorBlock;
        uint64 deliveryAnchorBlock;
        uint64 deliveryProvenBlock;
        uint64 responseDueBlock;
        State state;
    }
    IBlockNoticeLog public immutable log;
    IBurnableERC20 public immutable token;
    bytes32 public immutable operatorServiceId;
    bytes32 public immutable courierServiceId;
    uint64 public immutable decisionBlocks;
    uint64 public immutable handoffBlocks;
    uint64 public immutable courierBlocks;
    uint64 public immutable responseBlocks;
    uint64 public immutable disputeBlocks;
    bytes32 public immutable profileHash;
    mapping(bytes32 => Lock) public locks;
    mapping(address => uint256) public nonces;
    uint256 private _entered;

    event Locked(bytes32 indexed lockId, address indexed holder, uint128 amount, bytes32 requestHash);
    event DecisionProven(bytes32 indexed lockId, bytes32 leaf, bytes32 root, uint64 index, bool late);
    event HandoffProven(bytes32 indexed lockId, bytes32 leaf, bytes32 root, uint64 index, bool late);
    event DeliveryProven(bytes32 indexed lockId, bytes32 leaf, bytes32 root, uint64 index, bool late);
    event ChallengeOpened(bytes32 indexed lockId, Hop hop, uint64 responseDueBlock);
    event ChallengeUnanswered(bytes32 indexed lockId, Hop hop);
    event Returned(bytes32 indexed lockId);
    event Disputed(bytes32 indexed lockId);
    event Burned(bytes32 indexed lockId, bool byAck);

    error ZeroAmount();
    error ZeroHolder();
    error UnknownLock();
    error WrongState();
    error NotHolder();
    error NotYetDue();
    error ResponseWindowOver();
    error ResponseWindowOpen();
    error DisputeWindowOver();
    error HandoffWindowOver();
    error UnknownRoot();
    error IndexOutOfRange();
    error BadProofLength();
    error BadInclusionProof();
    error UnknownService();
    error BadProfile();
    error BadAnchorOrder();
    error TokenTransferFailed();
    error UnsupportedToken();
    error ReentrantCall();

    modifier nonReentrant() {
        if (_entered != 0) revert ReentrantCall();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(
        IBlockNoticeLog log_, IBurnableERC20 token_, bytes32 operatorServiceId_, bytes32 courierServiceId_,
        uint64 decisionBlocks_, uint64 handoffBlocks_, uint64 courierBlocks_, uint64 responseBlocks_, uint64 disputeBlocks_
    ) {
        if (address(log_).code.length == 0 || address(token_).code.length == 0
            || operatorServiceId_ == courierServiceId_ || decisionBlocks_ == 0 || courierBlocks_ == 0
            || responseBlocks_ == 0 || disputeBlocks_ == 0 || handoffBlocks_ < decisionBlocks_) revert BadProfile();
        if (block.number + uint256(handoffBlocks_) + courierBlocks_ + responseBlocks_ + disputeBlocks_
            > type(uint64).max) revert BadProfile();
        if (!log_.getService(operatorServiceId_).exists || !log_.getService(courierServiceId_).exists) revert UnknownService();
        log = log_;
        token = token_;
        operatorServiceId = operatorServiceId_;
        courierServiceId = courierServiceId_;
        decisionBlocks = decisionBlocks_;
        handoffBlocks = handoffBlocks_;
        courierBlocks = courierBlocks_;
        responseBlocks = responseBlocks_;
        disputeBlocks = disputeBlocks_;
        profileHash = keccak256(abi.encode(block.chainid, address(this), log_, token_, operatorServiceId_, courierServiceId_,
            decisionBlocks_, handoffBlocks_, courierBlocks_, responseBlocks_, disputeBlocks_));
    }

    function lock(uint128 amount, bytes32 requestHash) external nonReentrant returns (bytes32 lockId) {
        return _lock(msg.sender, msg.sender, amount, requestHash);
    }

    /// @notice Fund a lock for a beneficiary using only the caller's tokens.
    /// @dev A gift creates no inbox acknowledgement; an inbox records only its own atomic forward.
    function lockFor(address holder, uint128 amount, bytes32 requestHash)
        external nonReentrant returns (bytes32 lockId)
    {
        return _lock(holder, msg.sender, amount, requestHash);
    }

    function _lock(address holder, address payer, uint128 amount, bytes32 requestHash)
        internal returns (bytes32 lockId)
    {
        if (holder == address(0)) revert ZeroHolder();
        if (amount == 0) revert ZeroAmount();
        lockId = keccak256(abi.encode(block.chainid, address(this), holder, requestHash, nonces[holder]++));
        Lock storage l = locks[lockId];
        l.holder = holder;
        l.amount = amount;
        l.requestHash = requestHash;
        l.lockBlock = uint64(block.number);
        l.state = State.LOCKED;
        uint256 beforeBalance = token.balanceOf(address(this));
        if (!token.transferFrom(payer, address(this), amount)) revert TokenTransferFailed();
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert UnsupportedToken();
        emit Locked(lockId, holder, amount, requestHash);
    }

    function proveDecision(bytes32 lockId, bytes32 digest, uint64 index, bytes32 root, bytes32[] calldata siblings)
        external nonReentrant
    {
        Lock storage l = _get(lockId);
        if (l.state != State.LOCKED && l.state != State.OP_CHALLENGED) revert WrongState();
        _response(l);
        bytes32 leaf = log.decisionLeaf(lockId, digest);
        uint64 anchor = _verify(operatorServiceId, leaf, index, root, siblings);
        if (anchor < l.lockBlock) revert BadAnchorOrder();
        l.state = State.DECIDED;
        l.responseDueBlock = 0;
        emit DecisionProven(lockId, leaf, root, index, anchor > l.lockBlock + decisionBlocks);
    }

    /// @dev Submission cutoff, not merely anchor cutoff: after expiry a holder can reclaim without a race.
    function proveHandoff(bytes32 lockId, bytes32 digest, uint64 index, bytes32 root, bytes32[] calldata siblings)
        external nonReentrant
    {
        Lock storage l = _get(lockId);
        if (l.state != State.DECIDED) revert WrongState();
        uint64 due = l.lockBlock + handoffBlocks;
        if (block.number > due) revert HandoffWindowOver();
        bytes32 leaf = log.decisionLeaf(keccak256(abi.encode(uint8(3), lockId)), digest);
        uint64 anchor = _verify(operatorServiceId, leaf, index, root, siblings);
        if (anchor < l.lockBlock) revert BadAnchorOrder();
        l.handoffAnchorBlock = anchor;
        l.state = State.HANDED_OFF;
        emit HandoffProven(lockId, leaf, root, index, anchor > due);
    }

    function proveDelivery(bytes32 lockId, bytes32 digest, uint64 index, bytes32 root, bytes32[] calldata siblings)
        external nonReentrant
    {
        Lock storage l = _get(lockId);
        if (l.state != State.HANDED_OFF && l.state != State.COURIER_CHALLENGED) revert WrongState();
        _response(l);
        bytes32 leaf = log.decisionLeaf(keccak256(abi.encode(uint8(4), lockId)), digest);
        uint64 anchor = _verify(courierServiceId, leaf, index, root, siblings);
        if (anchor < l.handoffAnchorBlock) revert BadAnchorOrder();
        l.deliveryAnchorBlock = anchor;
        // The entire period remains available even if an old anchored proof is submitted very late.
        l.deliveryProvenBlock = uint64(block.number);
        l.responseDueBlock = 0;
        l.state = State.DELIVERED;
        emit DeliveryProven(lockId, leaf, root, index, anchor > l.handoffAnchorBlock + courierBlocks);
    }

    function challenge(bytes32 lockId) external nonReentrant {
        Lock storage l = _get(lockId);
        _holder(l);
        Hop hop;
        if (l.state == State.LOCKED) {
            if (block.number <= l.lockBlock + decisionBlocks) revert NotYetDue();
            hop = Hop.OPERATOR;
            l.state = State.OP_CHALLENGED;
        } else if (l.state == State.HANDED_OFF) {
            if (block.number <= l.handoffAnchorBlock + courierBlocks) revert NotYetDue();
            hop = Hop.COURIER;
            l.state = State.COURIER_CHALLENGED;
        } else revert WrongState();
        l.responseDueBlock = uint64(block.number) + responseBlocks;
        emit ChallengeOpened(lockId, hop, l.responseDueBlock);
    }

    function finalize(bytes32 lockId) external nonReentrant {
        Lock storage l = _get(lockId);
        bool operatorHop = l.state == State.OP_CHALLENGED;
        if (!operatorHop && l.state != State.COURIER_CHALLENGED) revert WrongState();
        if (block.number <= l.responseDueBlock) revert ResponseWindowOpen();
        emit ChallengeUnanswered(lockId, operatorHop ? Hop.OPERATOR : Hop.COURIER);
        if (operatorHop) _return(lockId, l);
        else l.state = State.STALLED;
    }

    function reclaim(bytes32 lockId) external nonReentrant {
        Lock storage l = _get(lockId);
        _holder(l);
        if (l.state != State.DECIDED) revert WrongState();
        if (block.number <= l.lockBlock + handoffBlocks) revert NotYetDue();
        _return(lockId, l);
    }

    function acknowledge(bytes32 lockId) external nonReentrant {
        Lock storage l = _get(lockId);
        _holder(l);
        if (l.state != State.DELIVERED && l.state != State.DISPUTED) revert WrongState();
        _burn(lockId, l, true);
    }

    function dispute(bytes32 lockId) external nonReentrant {
        Lock storage l = _get(lockId);
        _holder(l);
        if (l.state != State.DELIVERED) revert WrongState();
        if (block.number > l.deliveryProvenBlock + disputeBlocks) revert DisputeWindowOver();
        l.state = State.DISPUTED;
        emit Disputed(lockId);
    }

    function burn(bytes32 lockId) external nonReentrant {
        Lock storage l = _get(lockId);
        if (l.state != State.DELIVERED) revert WrongState();
        if (block.number <= l.deliveryProvenBlock + disputeBlocks) revert NotYetDue();
        _burn(lockId, l, false);
    }

    function getLock(bytes32 lockId) external view returns (Lock memory) { return _get(lockId); }
    function decisionDue(bytes32 lockId) external view returns (uint64) { return _get(lockId).lockBlock + decisionBlocks; }
    function handoffDue(bytes32 lockId) external view returns (uint64) { return _get(lockId).lockBlock + handoffBlocks; }
    function courierDue(bytes32 lockId) external view returns (uint64) {
        Lock storage l = _get(lockId);
        if (l.handoffAnchorBlock == 0) revert WrongState();
        return l.handoffAnchorBlock + courierBlocks;
    }
    function disputeDue(bytes32 lockId) external view returns (uint64) {
        Lock storage l = _get(lockId);
        if (l.deliveryProvenBlock == 0) revert WrongState();
        return l.deliveryProvenBlock + disputeBlocks;
    }

    function _get(bytes32 id) internal view returns (Lock storage l) {
        l = locks[id];
        if (l.state == State.NONE) revert UnknownLock();
    }
    function _holder(Lock storage l) internal view { if (msg.sender != l.holder) revert NotHolder(); }
    function _response(Lock storage l) internal view {
        if ((l.state == State.OP_CHALLENGED || l.state == State.COURIER_CHALLENGED)
            && block.number > l.responseDueBlock) revert ResponseWindowOver();
    }
    function _verify(bytes32 service, bytes32 leaf, uint64 index, bytes32 root, bytes32[] calldata siblings)
        internal view returns (uint64)
    {
        IBlockNoticeLog.RootInfo memory info = log.rootInfo(service, root);
        if (info.blockNumber == 0) revert UnknownRoot();
        if (index >= info.size) revert IndexOutOfRange();
        if (siblings.length != 32) revert BadProofLength();
        bytes32 h = leaf;
        uint256 idx = index;
        for (uint256 d; d < 32; ++d) {
            h = (idx & 1) == 0
                ? keccak256(abi.encodePacked(bytes1(0x01), h, siblings[d]))
                : keccak256(abi.encodePacked(bytes1(0x01), siblings[d], h));
            idx >>= 1;
        }
        if (h != root) revert BadInclusionProof();
        return info.blockNumber;
    }
    function _return(bytes32 id, Lock storage l) internal {
        l.state = State.RETURNED;
        uint256 escrowBefore = token.balanceOf(address(this));
        uint256 holderBefore = token.balanceOf(l.holder);
        if (!token.transfer(l.holder, l.amount)) revert TokenTransferFailed();
        if (token.balanceOf(address(this)) != escrowBefore - l.amount
            || token.balanceOf(l.holder) != holderBefore + l.amount) revert UnsupportedToken();
        emit Returned(id);
    }
    function _burn(bytes32 id, Lock storage l, bool byAck) internal {
        l.state = State.BURNED;
        uint256 balanceBefore = token.balanceOf(address(this));
        uint256 supplyBefore = token.totalSupply();
        token.burn(l.amount);
        if (token.balanceOf(address(this)) != balanceBefore - l.amount
            || token.totalSupply() != supplyBefore - l.amount) revert UnsupportedToken();
        emit Burned(id, byAck);
    }
}
