// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

interface IERC20Commitment {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Destination-side all-or-nothing purchases using one prefunded token.
/// @dev The derived adapter must authenticate both the callback proxy and the
/// injected Reactive sender before exposing _grant or _close. This contract does
/// not bridge funds. Fee-on-transfer and rebasing tokens are not supported.
abstract contract CommitmentVaultCore {
    enum PermitState {
        None,
        Open,
        Consumed,
        Closed
    }

    struct Permit {
        address recipient;
        uint256 amount;
        uint64 expiresAt;
        uint256 consumed;
        PermitState state;
        bool everGranted;
    }

    IERC20Commitment public immutable token;
    mapping(bytes32 id => Permit permit) public permits;
    bool private _executing;

    error InvalidPermit();
    error PermitConflict(bytes32 id);
    error PermitNotOpen(bytes32 id);
    error PermitExpired(bytes32 id);
    error ReentrantExecution();
    error TokenTransferFailed();
    error UnsupportedTokenBehavior();

    event CommitmentGranted(bytes32 indexed id, address recipient, uint256 amount, uint64 expiresAt);
    event LateGrantRejected(bytes32 indexed id);
    event CommitmentExecuted(bytes32 indexed id, uint256 amount);
    event CommitmentClosed(bytes32 indexed id, uint256 consumed);

    constructor(address token_) {
        if (token_.code.length == 0) revert InvalidPermit();
        token = IERC20Commitment(token_);
    }

    function _grant(bytes32 id, address recipient, uint256 amount, uint64 expiresAt)
        internal
        returns (bool changed)
    {
        if (id == bytes32(0) || recipient == address(0) || recipient == address(this) || amount == 0) {
            revert InvalidPermit();
        }
        Permit storage p = permits[id];
        if (p.everGranted) {
            if (p.recipient != recipient || p.amount != amount || p.expiresAt != expiresAt) {
                revert PermitConflict(id);
            }
        }
        // Closing an unknown ID intentionally leaves a tombstone. Do not assign
        // new metadata here and do not reactivate it, even for an original grant.
        if (p.state == PermitState.Closed) {
            emit LateGrantRejected(id);
            return false;
        }
        if (p.everGranted) return false;
        if (expiresAt <= block.timestamp) revert PermitExpired(id);

        p.recipient = recipient;
        p.amount = amount;
        p.expiresAt = expiresAt;
        p.state = PermitState.Open;
        p.everGranted = true;
        emit CommitmentGranted(id, recipient, amount, expiresAt);
        return true;
    }

    /// @notice Anyone can trigger a valid permit, but cannot alter its payment.
    /// @return changed False if the permit has already been consumed.
    function execute(bytes32 id) external returns (bool changed) {
        if (_executing) revert ReentrantExecution();
        Permit storage p = permits[id];
        if (p.consumed != 0) return false;
        if (p.state != PermitState.Open) revert PermitNotOpen(id);
        if (block.timestamp >= p.expiresAt) revert PermitExpired(id);

        _executing = true;
        p.consumed = p.amount;
        p.state = PermitState.Consumed;

        uint256 vaultBefore = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(p.recipient);
        (bool ok, bytes memory result) = address(token).call(
            abi.encodeCall(IERC20Commitment.transfer, (p.recipient, p.amount))
        );
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
            revert TokenTransferFailed();
        }
        // Accounting is deliberately strict. A transfer that delivers less than
        // the agreed amount, or debits a different amount, reverts atomically.
        if (
            token.balanceOf(address(this)) + p.amount != vaultBefore
                || token.balanceOf(p.recipient) != recipientBefore + p.amount
        ) revert UnsupportedTokenBehavior();

        _executing = false;
        emit CommitmentExecuted(id, p.amount);
        return true;
    }

    /// @dev Closing before grant delivery is valid and permanently disables ID.
    /// The event reports actual consumed amount, including a prior payment.
    function _close(bytes32 id) internal returns (bool changed) {
        if (id == bytes32(0)) revert InvalidPermit();
        Permit storage p = permits[id];
        if (p.state == PermitState.Closed) return false;
        p.state = PermitState.Closed;
        emit CommitmentClosed(id, p.consumed);
        return true;
    }
}
