// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {CommitmentVaultCore} from "./core/CommitmentVaultCore.sol";

/// @notice Receives authenticated Omni callbacks and enforces immutable permits.
contract CommitmentVault is AbstractCallback, CommitmentVaultCore {
    constructor(address token_, address callbackProxy_, address reactiveSender_)
        payable AbstractCallback(IPayable(payable(callbackProxy_)), reactiveSender_) CommitmentVaultCore(token_)
    {
        if (callbackProxy_ == address(0) || reactiveSender_ == address(0)) revert InvalidPermit();
    }

    function grant(address reactiveSender, bytes32 id, address recipient, uint256 amount, uint64 expiresAt)
        external onlyServiceProvider onlyCallbackSender(reactiveSender) returns (bool)
    {
        bool changed = _grant(id, recipient, amount, expiresAt);
        // An authorized transport retry can recover a missed spend receipt.
        // Re-emitting the stored result never transfers tokens a second time.
        if (!changed && permits[id].consumed != 0) {
            emit CommitmentExecuted(id, permits[id].consumed);
        }
        return changed;
    }

    function close(address reactiveSender, bytes32 id)
        external onlyServiceProvider onlyCallbackSender(reactiveSender) returns (bool)
    {
        bool changed = _close(id);
        // The original closure log might not have reached the coordinator.
        // Retain the tombstone and republish its immutable consumed amount.
        if (!changed) emit CommitmentClosed(id, permits[id].consumed);
        return changed;
    }

    /// @notice Any caller may settle this contract's existing callback debt.
    function coverDebt() external {
        _coverDebt();
    }
}
