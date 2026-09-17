// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Read-only ABI of the existing, unchanged BlockNoticeLog.
interface IBlockNoticeLog {
    struct RootInfo { uint64 size; uint64 blockNumber; }
    struct Service {
        address operator;
        address signer;
        bytes32 profileHash;
        bytes32 treeId;
        uint64 challengeResponseBlocks;
        uint64 requestRecordBlocks;
        uint64 decisionRecordBlocks;
        uint64 size;
        bytes32 root;
        bool exists;
    }
    function getService(bytes32 serviceId) external view returns (Service memory);
    function rootInfo(bytes32 serviceId, bytes32 root) external view returns (RootInfo memory);
    function decisionLeaf(bytes32 key, bytes32 digest) external pure returns (bytes32);
}
