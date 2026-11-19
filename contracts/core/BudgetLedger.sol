// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Accounting core for one immutable, denomination-specific spending cap.
/// @dev The derived adapter MUST authenticate all callers and source events. In
/// particular, only an explicit trusted finality verifier may expose
/// _finalizeClosure. Observing a remote log is not evidence of source finality.
abstract contract BudgetLedger {
    enum Status {
        None,
        Reserved,
        CancellationRequested,
        Settled,
        Closed
    }

    struct Commitment {
        uint256 chainId;
        address vault;
        address recipient;
        uint256 amount;
        uint64 expiresAt;
        Status status;
        uint256 spent;
        uint256 observedConsumed;
        bytes32 observedClosureProof;
        bool closureObserved;
        bool closureFinalized;
    }

    uint256 public immutable budgetCap;
    uint256 public totalReserved;
    uint256 public totalSpent;
    mapping(bytes32 id => Commitment commitment) public commitments;

    error InvalidCommitment();
    error UnknownCommitment(bytes32 id);
    error CommitmentConflict(bytes32 id);
    error BudgetExceeded(uint256 requested, uint256 available);
    error InvalidConsumedAmount(bytes32 id, uint256 amount);
    error OutcomeConflict(bytes32 id);
    error ClosureNotObserved(bytes32 id);
    error ClosureProofMismatch(bytes32 id);

    event CommitmentReserved(
        bytes32 indexed id,
        uint256 indexed chainId,
        address vault,
        address recipient,
        uint256 amount,
        uint64 expiresAt
    );
    event CancellationRequested(bytes32 indexed id);
    event SpendRecorded(bytes32 indexed id, uint256 amount);
    event ClosureObserved(bytes32 indexed id, uint256 consumed, bytes32 proof);
    event ClosureFinalized(bytes32 indexed id, uint256 consumed, uint256 released, bytes32 proof);

    constructor(uint256 budgetCap_) {
        if (budgetCap_ == 0) revert InvalidCommitment();
        budgetCap = budgetCap_;
    }

    function availableBudget() public view returns (uint256) {
        return budgetCap - totalSpent - totalReserved;
    }

    /// @return changed False for a byte-for-byte identical business request replay.
    /// @dev The caller must reserve before sending a grant. A callback-request
    /// failure should revert the whole transaction, including this reservation.
    function _reserve(
        bytes32 id,
        uint256 chainId,
        address vault,
        address recipient,
        uint256 amount,
        uint64 expiresAt
    ) internal returns (bool changed) {
        if (id == bytes32(0) || chainId == 0 || vault == address(0) || recipient == address(0) || amount == 0) {
            revert InvalidCommitment();
        }

        Commitment storage c = commitments[id];
        if (c.status != Status.None) {
            if (
                c.chainId != chainId || c.vault != vault || c.recipient != recipient || c.amount != amount
                    || c.expiresAt != expiresAt
            ) revert CommitmentConflict(id);
            return false;
        }

        // A delayed duplicate remains an idempotent no-op after expiry. A new
        // operation, however, cannot introduce already-expired spending authority.
        if (expiresAt <= block.timestamp) revert InvalidCommitment();
        uint256 available = availableBudget();
        if (amount > available) revert BudgetExceeded(amount, available);

        c.chainId = chainId;
        c.vault = vault;
        c.recipient = recipient;
        c.amount = amount;
        c.expiresAt = expiresAt;
        c.status = Status.Reserved;
        totalReserved += amount;
        emit CommitmentReserved(id, chainId, vault, recipient, amount, expiresAt);
        return true;
    }

    /// @dev Timeout processing may call this function. It never releases budget.
    function _requestCancellation(bytes32 id) internal returns (bool changed) {
        Commitment storage c = _known(id);
        if (c.status != Status.Reserved) return false;
        c.status = Status.CancellationRequested;
        emit CancellationRequested(id);
        return true;
    }

    /// @dev Full consumption only. A raw spend receipt can conservatively burn
    /// capacity, but cannot create new capacity. Reorgs are therefore allowed to
    /// strand capacity in this prototype; they must never silently replenish it.
    function _recordSpend(bytes32 id, uint256 amount) internal returns (bool changed) {
        Commitment storage c = _known(id);
        if (amount != c.amount) revert InvalidConsumedAmount(id, amount);
        if (c.spent == amount) return false;
        if (c.closureFinalized || (c.closureObserved && c.observedConsumed != amount)) {
            revert OutcomeConflict(id);
        }
        totalReserved -= amount;
        totalSpent += amount;
        c.spent = amount;
        c.status = Status.Settled;
        emit SpendRecorded(id, amount);
        return true;
    }

    /// @dev This records evidence only. A hash binds the source chain, contract,
    /// event identity, outcome and canonical block in the authenticated adapter.
    /// It is NOT a cryptographic source-finality proof by itself.
    function _observeClosure(bytes32 id, uint256 consumed, bytes32 proof) internal returns (bool changed) {
        Commitment storage c = _known(id);
        _checkConsumed(id, c, consumed);
        if (proof == bytes32(0)) revert ClosureProofMismatch(id);
        if (c.closureFinalized) return false;
        if (c.closureObserved) {
            if (c.observedConsumed != consumed) revert OutcomeConflict(id);
            if (c.observedClosureProof == proof) return false;
        }
        c.closureObserved = true;
        c.observedConsumed = consumed;
        c.observedClosureProof = proof;
        emit ClosureObserved(id, consumed, proof);
        return true;
    }

    /// @dev The derived adapter must restrict this to its finality verifier.
    /// Closure requires a permanently closed destination grant, not a timeout.
    function _finalizeClosure(bytes32 id, uint256 consumed, bytes32 proof) internal returns (bool changed) {
        Commitment storage c = _known(id);
        _checkConsumed(id, c, consumed);
        if (!c.closureObserved) revert ClosureNotObserved(id);
        if (proof == bytes32(0) || c.observedClosureProof != proof || c.observedConsumed != consumed) {
            revert ClosureProofMismatch(id);
        }
        if (c.closureFinalized) return false;

        uint256 released;
        if (c.spent == 0) {
            totalReserved -= c.amount;
            totalSpent += consumed;
            c.spent = consumed;
            released = c.amount - consumed;
        }
        c.closureFinalized = true;
        c.status = Status.Closed;
        emit ClosureFinalized(id, consumed, released, proof);
        return true;
    }

    function _known(bytes32 id) private view returns (Commitment storage c) {
        c = commitments[id];
        if (c.status == Status.None) revert UnknownCommitment(id);
    }

    function _checkConsumed(bytes32 id, Commitment storage c, uint256 consumed) private view {
        if (consumed != 0 && consumed != c.amount) revert InvalidConsumedAmount(id, consumed);
        if (c.spent != 0 && consumed != c.spent) revert OutcomeConflict(id);
        if (c.closureFinalized && consumed != c.spent) revert OutcomeConflict(id);
    }
}
