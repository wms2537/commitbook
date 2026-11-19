// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Authorized purchase requests emitted on an origin chain.
contract CommitmentInbox {
    address public immutable owner;
    mapping(address => bool) public agents;
    mapping(address => bool) public suppliers;
    mapping(bytes32 => bytes32) public requestHashes;
    mapping(bytes32 => address) public createdBy;
    mapping(bytes32 => bool) public cancelled;

    error Unauthorized();
    error InvalidRequest();
    error ConflictingRequest(bytes32 id);

    event AgentPermission(address indexed agent, bool allowed);
    event SupplierPermission(address indexed supplier, bool allowed);
    event CommitmentRequested(bytes32 indexed id, uint256 destinationChainId, address recipient, uint256 amount, uint64 expiresAt);
    event CancellationRequested(bytes32 indexed id);

    constructor(address owner_) {
        if (owner_ == address(0)) revert InvalidRequest();
        owner = owner_;
        agents[owner_] = true;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    function setAgent(address agent, bool allowed) external onlyOwner {
        if (agent == address(0)) revert InvalidRequest();
        agents[agent] = allowed;
        emit AgentPermission(agent, allowed);
    }

    function setSupplier(address supplier, bool allowed) external onlyOwner {
        if (supplier == address(0)) revert InvalidRequest();
        suppliers[supplier] = allowed;
        emit SupplierPermission(supplier, allowed);
    }

    function request(bytes32 id, uint256 destinationChainId, address recipient, uint256 amount, uint64 expiresAt)
        external returns (bool)
    {
        if (!agents[msg.sender]) revert Unauthorized();
        if (id == bytes32(0) || destinationChainId == 0 || !suppliers[recipient] || amount == 0 || cancelled[id]) {
            revert InvalidRequest();
        }
        bytes32 requestHash = keccak256(abi.encode(msg.sender, destinationChainId, recipient, amount, expiresAt));
        if (requestHashes[id] != bytes32(0)) {
            if (requestHashes[id] != requestHash) revert ConflictingRequest(id);
            return false;
        }
        if (expiresAt <= block.timestamp) revert InvalidRequest();
        requestHashes[id] = requestHash;
        createdBy[id] = msg.sender;
        emit CommitmentRequested(id, destinationChainId, recipient, amount, expiresAt);
        return true;
    }

    function cancel(bytes32 id) external returns (bool) {
        if (msg.sender != owner && msg.sender != createdBy[id]) revert Unauthorized();
        if (id == bytes32(0)) revert InvalidRequest();
        if (cancelled[id]) return false;
        cancelled[id] = true;
        emit CancellationRequested(id);
        return true;
    }
}
