// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title BlockNoticeLog
/// @notice Public, order-preserving append-only log for institution decision records, plus two
///         accountability paths a requester can drive without the institution's cooperation:
///         (1) `postNotice` — a neutral public record that a signed request exists, and
///         (2) `challengeAccepted` — a demand for evidence against an acceptance the institution
///             itself signed, which `finalize` turns into an on-chain UNANSWERED verdict.
/// @dev    The contract stores only hashes. It never learns the request body, the decision text, or
///         the private reason. It also never asserts that a decision was *correct* — only that a
///         record with a given commitment was anchored in a given order at a given block.
contract BlockNoticeLog {
    // --------------------------------------------------------------------- //
    // Merkle log (depth 32, order preserving, zero-padded)                   //
    // leaf   = keccak256(0x00 ‖ recordDigest)   <- computed off-chain        //
    // node   = keccak256(0x01 ‖ left ‖ right)                                //
    // DEC recordDigest = keccak256(abi.encode(uint8(2), acceptedDigest,      //
    //                    decisionDigest)) — a decision leaf names the        //
    //                    acceptance it answers, so `respond` can check it    //
    // --------------------------------------------------------------------- //
    uint256 internal constant DEPTH = 32;
    uint256 internal constant MAX_BATCH = 256;

    struct RootInfo {
        uint64 size; // number of leaves when this root was current (0 means "unknown root")
        uint64 blockNumber; // block at which this root became current
    }

    struct Service {
        address operator; // may append leaves
        address signer; // key whose EIP-712 signatures bind the institution
        bytes32 profileHash; // pins the deadlines/rules the receipts were issued under
        bytes32 treeId; // keccak256(serviceId); mirrors the off-chain tree id
        uint64 challengeResponseBlocks; // window to answer a challenge (part of profileHash)
        uint64 requestRecordBlocks; // REQ leaf must be recorded within this many blocks of the cited anchor
        uint64 decisionRecordBlocks; // DEC leaf likewise (part of profileHash)
        uint64 size; // current leaf count
        bytes32 root; // current root
        bool exists;
    }

    enum ChallengeState {
        NONE,
        OPEN,
        ANSWERED,
        UNANSWERED
    }

    struct Challenge {
        bytes32 serviceId;
        bytes32 acceptedDigest;
        address challenger;
        uint64 openedAtBlock;
        uint64 responseDueBlock;
        uint64 decisionRecordDueBlock; // copied from the signed receipt
        ChallengeState state;
        bytes32 answeredLeaf;
        bool answeredLate; // the cited anchor landed after the signed recording deadline
    }

    mapping(bytes32 => Service) private _services;
    mapping(bytes32 => mapping(uint256 => bytes32)) private _filledSubtrees; // serviceId => level => node
    mapping(bytes32 => mapping(bytes32 => RootInfo)) private _knownRoots; // serviceId => root => info
    mapping(bytes32 => Challenge) private _challenges; // challengeId => challenge
    mapping(bytes32 => uint64) private _noticeBlock; // requestDigest => block of public notice

    bytes32[DEPTH + 1] private _zeros;

    // --------------------------------------------------------------------- //
    // EIP-712                                                                //
    // --------------------------------------------------------------------- //
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("BlockNotice");
    bytes32 private constant _VERSION_HASH = keccak256("1");

    bytes32 private constant _REQUEST_TYPEHASH = keccak256(
        "Request(uint16 schemaVersion,bytes32 serviceId,bytes32 requestId,bytes32 nonce,address requesterKey,bytes32 responseEncryptionKeyHash,bytes32 requestCommitment,uint64 expiresAtBlock)"
    );
    bytes32 private constant _ACCEPTED_TYPEHASH = keccak256(
        "AcceptedReceipt(bytes32 requestId,bytes32 signedRequestDigest,bytes32 serviceId,bytes32 institutionKeyId,bytes32 protocolProfileHash,uint64 acceptedAtClaimed,bytes32 referenceAnchorId,uint64 requestRecordDueBlock,uint64 decisionRecordDueBlock,address requesterKey)"
    );

    uint256 private immutable _deployChainId;
    bytes32 private immutable _cachedDomainSeparator;

    struct Request {
        uint16 schemaVersion;
        bytes32 serviceId;
        bytes32 requestId;
        bytes32 nonce;
        address requesterKey;
        bytes32 responseEncryptionKeyHash;
        bytes32 requestCommitment;
        uint64 expiresAtBlock;
    }

    struct AcceptedReceipt {
        bytes32 requestId;
        bytes32 signedRequestDigest;
        bytes32 serviceId;
        bytes32 institutionKeyId;
        bytes32 protocolProfileHash;
        uint64 acceptedAtClaimed;
        bytes32 referenceAnchorId;
        uint64 requestRecordDueBlock;
        uint64 decisionRecordDueBlock;
        address requesterKey; // the party this receipt was issued to; only they may challenge it
    }

    // --------------------------------------------------------------------- //
    // Events — the only source an independent verifier needs                 //
    // --------------------------------------------------------------------- //
    event ServiceRegistered(
        bytes32 indexed serviceId,
        address indexed operator,
        address indexed signer,
        bytes32 profileHash,
        bytes32 treeId,
        uint64 challengeResponseBlocks,
        uint64 requestRecordBlocks,
        uint64 decisionRecordBlocks,
        bytes32 emptyRoot
    );
    event Appended(bytes32 indexed serviceId, uint64 startIndex, bytes32[] leaves, bytes32 newRoot, uint64 newSize);
    event PublicNotice(
        bytes32 indexed serviceId, bytes32 indexed requestId, address indexed requester, bytes32 requestDigest
    );
    event ChallengeOpened(
        bytes32 indexed challengeId,
        bytes32 indexed serviceId,
        bytes32 indexed acceptedDigest,
        address challenger,
        uint64 responseDueBlock
    );
    event ChallengeAnswered(bytes32 indexed challengeId, bytes32 leaf, bytes32 root, uint64 index, bool late);
    event ChallengeUnanswered(bytes32 indexed challengeId, uint64 atBlock);

    error AlreadyRegistered();
    error UnknownService();
    error NotOperator();
    error EmptyBatch();
    error BatchTooLarge();
    error TreeFull();
    error ProfileMismatch();
    error BadSignature();
    error RequestExpired();
    error NoticeAlreadyPosted();
    error NotYetDue();
    error NotRequester();
    error UnknownAnchor();
    error DeadlineNotDerived();
    error ChallengeExists();
    error NoSuchChallenge();
    error ChallengeClosed();
    error ResponseWindowOver();
    error ResponseWindowOpen();
    error UnknownRoot();
    error IndexOutOfRange();
    error BadProofLength();
    error BadInclusionProof();

    constructor() {
        bytes32 z = bytes32(0); // an empty leaf slot
        _zeros[0] = z;
        for (uint256 i = 1; i <= DEPTH; i++) {
            z = _node(z, z);
            _zeros[i] = z;
        }
        _deployChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    // --------------------------------------------------------------------- //
    // Registration                                                           //
    // --------------------------------------------------------------------- //

    /// @notice Register an institution log. `profileHash` pins the deadline profile the receipts
    ///         are issued under; a receipt carrying a different profile hash cannot be challenged here.
    function registerService(
        bytes32 serviceId,
        address signer,
        bytes32 profileHash,
        uint64 challengeResponseBlocks,
        uint64 requestRecordBlocks,
        uint64 decisionRecordBlocks
    ) external {
        Service storage s = _services[serviceId];
        if (s.exists) revert AlreadyRegistered();
        s.exists = true;
        s.operator = msg.sender;
        s.signer = signer;
        s.profileHash = profileHash;
        s.challengeResponseBlocks = challengeResponseBlocks;
        s.requestRecordBlocks = requestRecordBlocks;
        s.decisionRecordBlocks = decisionRecordBlocks;
        s.treeId = keccak256(abi.encodePacked(serviceId));
        s.root = _zeros[DEPTH];
        _knownRoots[serviceId][s.root] = RootInfo({size: 0, blockNumber: uint64(block.number)});
        emit ServiceRegistered(
            serviceId, msg.sender, signer, profileHash, s.treeId, challengeResponseBlocks,
            requestRecordBlocks, decisionRecordBlocks, s.root
        );
    }

    // --------------------------------------------------------------------- //
    // Append — the contract computes the root, the institution only supplies leaves //
    // --------------------------------------------------------------------- //

    /// @notice Append leaf hashes in order. Past leaves can never move: the root is derived here,
    ///         not submitted, so an operator cannot publish a root for a tree it did not build.
    function appendBatch(bytes32 serviceId, bytes32[] calldata leaves) external returns (uint64 startIndex) {
        Service storage s = _services[serviceId];
        if (!s.exists) revert UnknownService();
        if (msg.sender != s.operator) revert NotOperator();
        uint256 n = leaves.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH) revert BatchTooLarge();

        startIndex = s.size;
        uint256 idx = startIndex;
        if (idx + n > (1 << DEPTH)) revert TreeFull();

        // Load the frontier into memory once; write back only the levels this batch changed.
        bytes32[DEPTH] memory subtrees;
        bool[DEPTH] memory dirty;
        for (uint256 d = 0; d < DEPTH; d++) {
            subtrees[d] = _filledSubtrees[serviceId][d];
        }

        bytes32 root;
        for (uint256 i = 0; i < n; i++) {
            bytes32 cur = leaves[i];
            uint256 j = idx;
            for (uint256 d = 0; d < DEPTH; d++) {
                if (j & 1 == 0) {
                    subtrees[d] = cur;
                    dirty[d] = true;
                    cur = _node(cur, _zeros[d]);
                } else {
                    cur = _node(subtrees[d], cur);
                }
                j >>= 1;
            }
            root = cur;
            unchecked {
                idx++;
            }
        }

        for (uint256 d = 0; d < DEPTH; d++) {
            if (dirty[d]) _filledSubtrees[serviceId][d] = subtrees[d];
        }

        s.size = uint64(idx);
        s.root = root;
        // A root that recurs (possible only across different services) keeps its first sighting.
        if (_knownRoots[serviceId][root].blockNumber == 0 && _knownRoots[serviceId][root].size == 0) {
            _knownRoots[serviceId][root] = RootInfo({size: uint64(idx), blockNumber: uint64(block.number)});
        }
        emit Appended(serviceId, startIndex, leaves, root, uint64(idx));
    }

    // --------------------------------------------------------------------- //
    // Path 1 — neutral public notice (no institution signature exists)       //
    // --------------------------------------------------------------------- //

    /// @notice Record that a signed request exists. This is NOT an accusation: the contract cannot
    ///         know whether the institution ever received it. Off-chain verifiers must render this
    ///         as PUBLIC_NOTICE, never as a violation.
    function postNotice(Request calldata r, bytes calldata requesterSig) external returns (bytes32 requestDigest) {
        Service storage s = _services[r.serviceId];
        if (!s.exists) revert UnknownService();
        if (block.number > r.expiresAtBlock) revert RequestExpired();
        requestDigest = _hashTypedData(_structHashRequest(r));
        if (_recover(requestDigest, requesterSig) != r.requesterKey) revert BadSignature();
        if (_noticeBlock[requestDigest] != 0) revert NoticeAlreadyPosted();
        _noticeBlock[requestDigest] = uint64(block.number);
        emit PublicNotice(r.serviceId, r.requestId, r.requesterKey, requestDigest);
    }

    // --------------------------------------------------------------------- //
    // Path 2 — challenge an acceptance the institution signed                //
    // --------------------------------------------------------------------- //

    /// @notice Demand evidence for an acceptance whose recording deadline has passed. The
    ///         institution's own signature is required, so this path cannot be used to fabricate an
    ///         obligation that was never undertaken.
    function challengeAccepted(AcceptedReceipt calldata a, bytes calldata institutionSig)
        external
        returns (bytes32 challengeId)
    {
        Service storage s = _services[a.serviceId];
        if (!s.exists) revert UnknownService();
        if (a.protocolProfileHash != s.profileHash) revert ProfileMismatch();
        bytes32 acceptedDigest = _hashTypedData(_structHashAccepted(a));
        if (_recover(acceptedDigest, institutionSig) != s.signer) revert BadSignature();

        // Only the party the receipt names may demand evidence for it. A copy of someone else's
        // receipt is not standing: without this, anyone who ever saw a bundle could open challenges.
        if (msg.sender != a.requesterKey) revert NotRequester();

        // The deadline is not whatever the institution's local clock said at signing time. It is
        // derived from a block this chain actually observed: the anchor the receipt cites. An
        // institution cannot buy itself time by back-dating its own clock, and cannot cite an
        // anchor that does not exist.
        RootInfo memory anchor = _knownRoots[a.serviceId][a.referenceAnchorId];
        if (anchor.blockNumber == 0) revert UnknownAnchor();
        if (
            a.requestRecordDueBlock != anchor.blockNumber + s.requestRecordBlocks
                || a.decisionRecordDueBlock != anchor.blockNumber + s.decisionRecordBlocks
        ) revert DeadlineNotDerived();

        if (block.number <= a.decisionRecordDueBlock) revert NotYetDue();

        challengeId = keccak256(abi.encode(a.serviceId, acceptedDigest));
        Challenge storage c = _challenges[challengeId];
        if (c.state != ChallengeState.NONE) revert ChallengeExists();

        uint64 due = uint64(block.number) + s.challengeResponseBlocks;
        _challenges[challengeId] = Challenge({
            serviceId: a.serviceId,
            acceptedDigest: acceptedDigest,
            challenger: msg.sender,
            openedAtBlock: uint64(block.number),
            responseDueBlock: due,
            decisionRecordDueBlock: a.decisionRecordDueBlock,
            state: ChallengeState.OPEN,
            answeredLeaf: bytes32(0),
            answeredLate: false
        });
        emit ChallengeOpened(challengeId, a.serviceId, acceptedDigest, msg.sender, due);
    }

    /// @notice Answer a challenge by proving that a decision record *for this acceptance* is anchored
    ///         in the public log. The caller supplies the decision digest; the contract derives the
    ///         leaf from the challenge's own acceptedDigest, so a record belonging to any other
    ///         request — or a REQ/ACK leaf — cannot close it. Anyone may call: proving that the
    ///         institution recorded is a fact about the log, not about the caller.
    /// @dev    What this does NOT establish: that the decision content is correct, or that it was
    ///         delivered to the requester. The contract never sees the plaintext; those questions
    ///         belong to the off-chain verifier and to the ACK path.
    function respond(
        bytes32 challengeId,
        bytes32 decisionDigest,
        uint64 index,
        bytes32 root,
        bytes32[] calldata siblings
    ) external {
        Challenge storage c = _challenges[challengeId];
        if (c.state == ChallengeState.NONE) revert NoSuchChallenge();
        if (c.state != ChallengeState.OPEN) revert ChallengeClosed();
        if (block.number > c.responseDueBlock) revert ResponseWindowOver();

        RootInfo memory ri = _knownRoots[c.serviceId][root];
        if (ri.blockNumber == 0) revert UnknownRoot();
        if (index >= ri.size) revert IndexOutOfRange();
        if (siblings.length != DEPTH) revert BadProofLength();
        bytes32 leaf = decisionLeaf(c.acceptedDigest, decisionDigest);
        if (_computeRoot(leaf, index, siblings) != root) revert BadInclusionProof();

        bool late = ri.blockNumber > c.decisionRecordDueBlock;
        c.state = ChallengeState.ANSWERED;
        c.answeredLeaf = leaf;
        c.answeredLate = late;
        emit ChallengeAnswered(challengeId, leaf, root, index, late);
    }

    /// @notice The leaf a decision record occupies in the log. Mirrors the off-chain encoder:
    ///         leaf = H(0x00 ‖ keccak256(abi.encode(uint8(2), acceptedDigest, decisionDigest))).
    function decisionLeaf(bytes32 acceptedDigest, bytes32 decisionDigest) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), keccak256(abi.encode(uint8(2), acceptedDigest, decisionDigest))));
    }

    /// @notice Close an unanswered challenge once the window is over. Anyone may call it; the
    ///         verdict is a fact about the chain, not about the caller.
    function finalize(bytes32 challengeId) external {
        Challenge storage c = _challenges[challengeId];
        if (c.state == ChallengeState.NONE) revert NoSuchChallenge();
        if (c.state != ChallengeState.OPEN) revert ChallengeClosed();
        if (block.number <= c.responseDueBlock) revert ResponseWindowOpen();
        c.state = ChallengeState.UNANSWERED;
        emit ChallengeUnanswered(challengeId, uint64(block.number));
    }

    // --------------------------------------------------------------------- //
    // Views                                                                  //
    // --------------------------------------------------------------------- //
    function getService(bytes32 serviceId) external view returns (Service memory) {
        return _services[serviceId];
    }

    function getChallenge(bytes32 challengeId) external view returns (Challenge memory) {
        return _challenges[challengeId];
    }

    function rootInfo(bytes32 serviceId, bytes32 root) external view returns (RootInfo memory) {
        return _knownRoots[serviceId][root];
    }

    function noticeBlock(bytes32 requestDigest) external view returns (uint64) {
        return _noticeBlock[requestDigest];
    }

    function zeros(uint256 level) external view returns (bytes32) {
        return _zeros[level];
    }

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == _deployChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    function hashRequest(Request calldata r) external view returns (bytes32) {
        return _hashTypedData(_structHashRequest(r));
    }

    function hashAcceptedReceipt(AcceptedReceipt calldata a) external view returns (bytes32) {
        return _hashTypedData(_structHashAccepted(a));
    }

    // --------------------------------------------------------------------- //
    // Internals                                                              //
    // --------------------------------------------------------------------- //
    function _node(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x01), l, r));
    }

    function _computeRoot(bytes32 leaf, uint64 index, bytes32[] calldata siblings)
        internal
        pure
        returns (bytes32 h)
    {
        h = leaf;
        uint256 idx = index;
        for (uint256 d = 0; d < DEPTH; d++) {
            h = (idx & 1 == 0) ? _node(h, siblings[d]) : _node(siblings[d], h);
            idx >>= 1;
        }
    }

    function _buildDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(_EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), domainSeparator(), structHash));
    }

    function _structHashRequest(Request calldata r) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                _REQUEST_TYPEHASH,
                uint256(r.schemaVersion),
                r.serviceId,
                r.requestId,
                r.nonce,
                r.requesterKey,
                r.responseEncryptionKeyHash,
                r.requestCommitment,
                uint256(r.expiresAtBlock)
            )
        );
    }

    function _structHashAccepted(AcceptedReceipt calldata a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                _ACCEPTED_TYPEHASH,
                a.requestId,
                a.signedRequestDigest,
                a.serviceId,
                a.institutionKeyId,
                a.protocolProfileHash,
                uint256(a.acceptedAtClaimed),
                a.referenceAnchorId,
                uint256(a.requestRecordDueBlock),
                uint256(a.decisionRecordDueBlock),
                a.requesterKey
            )
        );
    }

    /// @dev Rejects malleable (high-s) signatures so a second valid encoding of the same signature
    ///      cannot be used to bypass replay guards keyed on the signature bytes.
    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignature();
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address a = ecrecover(digest, v, r, s);
        if (a == address(0)) revert BadSignature();
        return a;
    }
}
