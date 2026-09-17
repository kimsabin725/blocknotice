// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {IBlockNoticeLog} from "./interfaces/IBlockNoticeLog.sol";
import {IBurnableERC20} from "./interfaces/IBurnableERC20.sol";
import {RedemptionEscrow} from "./RedemptionEscrow.sol";

/// @notice Holder-signed exchange forwarding accountability before the escrow operator clock starts.
/// @dev Only this contract's atomic, exchange-funded forward fulfills a request. A direct escrow
///      gift is unrelated. Rejection contents remain private; inclusion proves a record, not its merits.
contract RedemptionInbox {
    enum State { NONE, SUBMITTED, CHALLENGED, FORWARDED, REJECTED, UNANSWERED }
    struct Request {
        address holder; bytes32 exchangeServiceId; uint128 amount; bytes32 requestHash;
        uint256 nonce; uint64 expiresAtBlock;
    }
    struct StoredRequest {
        address holder; address exchangeOperator; bytes32 exchangeServiceId; uint128 amount;
        bytes32 requestHash; uint256 nonce; uint64 expiresAtBlock; uint64 submittedBlock;
        uint64 responseDueBlock; bytes32 lockId; State state;
    }
    IBlockNoticeLog public immutable log;
    RedemptionEscrow public immutable escrow;
    IBurnableERC20 public immutable token;
    uint64 public immutable forwardBlocks;
    uint64 public immutable responseBlocks;
    bytes32 public immutable profileHash;
    mapping(address => mapping(uint256 => bool)) public usedNonces;
    mapping(bytes32 => StoredRequest) private _requests;
    uint256 private _entered;
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant REQUEST_TYPEHASH = keccak256("Request(address holder,bytes32 exchangeServiceId,uint128 amount,bytes32 requestHash,uint256 nonce,uint64 expiresAtBlock)");
    event Submitted(bytes32 indexed requestId, address indexed holder, bytes32 indexed exchangeServiceId,
        uint128 amount, bytes32 requestHash, uint64 forwardDueBlock);
    event Forwarded(bytes32 indexed requestId, bytes32 indexed lockId, bool late);
    event RejectionProven(bytes32 indexed requestId, bytes32 leaf, bytes32 root, uint64 index, bool late);
    event ChallengeOpened(bytes32 indexed requestId, uint64 responseDueBlock);
    event ChallengeUnanswered(bytes32 indexed requestId);
    error BadProfile(); error BadRequest(); error UnknownService(); error NonceUsed(); error RequestExpired();
    error BadSignature(); error UnknownRequest(); error WrongState(); error NotExchange(); error NotHolder();
    error NotYetDue(); error ResponseWindowOpen(); error ResponseWindowOver(); error UnknownRoot();
    error IndexOutOfRange(); error BadProofLength(); error BadInclusionProof(); error BadAnchorOrder();
    error TokenTransferFailed(); error UnsupportedToken(); error ReentrantCall();
    modifier nonReentrant() {
        if (_entered != 0) revert ReentrantCall();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(IBlockNoticeLog log_, RedemptionEscrow escrow_, uint64 forwardBlocks_, uint64 responseBlocks_) {
        if (address(log_).code.length == 0 || address(escrow_).code.length == 0
            || forwardBlocks_ == 0 || responseBlocks_ == 0) revert BadProfile();
        if (address(escrow_.log()) != address(log_)
            || block.number + uint256(forwardBlocks_) + responseBlocks_ > type(uint64).max) revert BadProfile();
        log = log_; escrow = escrow_; token = escrow_.token();
        forwardBlocks = forwardBlocks_; responseBlocks = responseBlocks_;
        profileHash = keccak256(abi.encode(block.chainid, address(this), log_, escrow_, forwardBlocks_, responseBlocks_));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("RedemptionInbox"), keccak256("1"), block.chainid, address(this)));
    }
    function hashRequest(Request calldata r) public view returns (bytes32) {
        bytes32 body = keccak256(abi.encode(REQUEST_TYPEHASH, r.holder, r.exchangeServiceId, r.amount,
            r.requestHash, r.nonce, r.expiresAtBlock));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), body));
    }

    /// @notice Anyone may relay a holder's signature. Expiry limits submission, not subsequent response.
    function submit(Request calldata r, bytes calldata signature) external nonReentrant returns (bytes32 requestId) {
        if (r.holder == address(0) || r.amount == 0) revert BadRequest();
        if (block.number > r.expiresAtBlock) revert RequestExpired();
        if (usedNonces[r.holder][r.nonce]) revert NonceUsed();
        IBlockNoticeLog.Service memory service = log.getService(r.exchangeServiceId);
        if (!service.exists) revert UnknownService();
        requestId = hashRequest(r);
        if (_recover(requestId, signature) != r.holder) revert BadSignature();
        uint64 due = _deadline(block.number, forwardBlocks);
        usedNonces[r.holder][r.nonce] = true;
        _requests[requestId] = StoredRequest({
            holder: r.holder, exchangeOperator: service.operator, exchangeServiceId: r.exchangeServiceId,
            amount: r.amount, requestHash: r.requestHash, nonce: r.nonce, expiresAtBlock: r.expiresAtBlock,
            submittedBlock: uint64(block.number), responseDueBlock: 0, lockId: bytes32(0), state: State.SUBMITTED
        });
        emit Submitted(requestId, r.holder, r.exchangeServiceId, r.amount, r.requestHash, due);
    }

    /// @notice The registered exchange funds the exact request, with the signed holder as beneficiary.
    function forward(bytes32 requestId) external nonReentrant returns (bytes32 lockId) {
        StoredRequest storage r = _get(requestId);
        if (msg.sender != r.exchangeOperator) revert NotExchange();
        _response(r);
        r.state = State.FORWARDED;
        r.responseDueBlock = 0;
        uint256 beforeBalance = token.balanceOf(address(this));
        uint256 exchangeBefore = token.balanceOf(msg.sender);
        if (!token.transferFrom(msg.sender, address(this), r.amount)) revert TokenTransferFailed();
        if (token.balanceOf(address(this)) != beforeBalance + r.amount
            || token.balanceOf(msg.sender) != exchangeBefore - r.amount) revert UnsupportedToken();
        if (!token.approve(address(escrow), r.amount)) revert TokenTransferFailed();
        if (token.allowance(address(this), address(escrow)) != r.amount) revert UnsupportedToken();
        lockId = escrow.lockFor(r.holder, r.amount, r.requestHash);
        if (!token.approve(address(escrow), 0)) revert TokenTransferFailed();
        if (token.balanceOf(address(this)) != beforeBalance
            || token.allowance(address(this), address(escrow)) != 0) revert UnsupportedToken();
        r.lockId = lockId;
        emit Forwarded(requestId, lockId, block.number > _deadline(r.submittedBlock, forwardBlocks));
    }

    function proveRejection(bytes32 requestId, bytes32 digest, uint64 index, bytes32 root, bytes32[] calldata siblings)
        external nonReentrant
    {
        StoredRequest storage r = _get(requestId);
        _response(r);
        bytes32 leaf = log.decisionLeaf(keccak256(abi.encode(uint8(5), requestId)), digest);
        IBlockNoticeLog.RootInfo memory info = log.rootInfo(r.exchangeServiceId, root);
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
        if (info.blockNumber < r.submittedBlock) revert BadAnchorOrder();
        r.state = State.REJECTED;
        r.responseDueBlock = 0;
        emit RejectionProven(requestId, leaf, root, index, info.blockNumber > _deadline(r.submittedBlock, forwardBlocks));
    }

    function challenge(bytes32 requestId) external nonReentrant {
        StoredRequest storage r = _get(requestId);
        if (msg.sender != r.holder) revert NotHolder();
        if (r.state != State.SUBMITTED) revert WrongState();
        if (block.number <= _deadline(r.submittedBlock, forwardBlocks)) revert NotYetDue();
        r.state = State.CHALLENGED;
        r.responseDueBlock = _deadline(block.number, responseBlocks);
        emit ChallengeOpened(requestId, r.responseDueBlock);
    }
    function finalize(bytes32 requestId) external nonReentrant {
        StoredRequest storage r = _get(requestId);
        if (r.state != State.CHALLENGED) revert WrongState();
        if (block.number <= r.responseDueBlock) revert ResponseWindowOpen();
        r.state = State.UNANSWERED;
        emit ChallengeUnanswered(requestId);
    }
    function getRequest(bytes32 requestId) external view returns (StoredRequest memory) { return _get(requestId); }
    function submittedBlock(bytes32 requestId) external view returns (uint64) { return _requests[requestId].submittedBlock; }
    function forwardDue(bytes32 requestId) external view returns (uint64) {
        return _deadline(_get(requestId).submittedBlock, forwardBlocks);
    }
    function _get(bytes32 requestId) internal view returns (StoredRequest storage r) {
        r = _requests[requestId];
        if (r.state == State.NONE) revert UnknownRequest();
    }
    function _response(StoredRequest storage r) internal view {
        if (r.state != State.SUBMITTED && r.state != State.CHALLENGED) revert WrongState();
        if (r.state == State.CHALLENGED && block.number > r.responseDueBlock) revert ResponseWindowOver();
    }
    function _deadline(uint256 start, uint64 window) internal pure returns (uint64) {
        uint256 due = start + window;
        if (due > type(uint64).max) revert BadProfile();
        return uint64(due);
    }
    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address signer) {
        if (signature.length != 65) revert BadSignature();
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignature();
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }
}
