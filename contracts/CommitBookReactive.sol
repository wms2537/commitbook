// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractReactive} from "@reactive/src/base/AbstractReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";
import {BudgetLedger} from "./core/BudgetLedger.sol";

/// @notice One-owner commitment coordinator for Reactive Omni.
/// @dev The finality verifier is an explicit trusted service. Event observation
/// alone never releases an unused reservation. This is not a finality proof.
contract CommitBookReactive is AbstractReactive, BudgetLedger {
    address public immutable owner;
    address public immutable finalityVerifier;
    uint256 public immutable originChainId;
    address public immutable originInbox;
    uint64 public constant CALLBACK_GAS = 500_000;

    uint256 public constant REQUEST_TOPIC = uint256(keccak256("CommitmentRequested(bytes32,uint256,address,uint256,uint64)"));
    uint256 public constant CANCEL_TOPIC = uint256(keccak256("CancellationRequested(bytes32)"));
    uint256 public constant SPEND_TOPIC = uint256(keccak256("CommitmentExecuted(bytes32,uint256)"));
    uint256 public constant CLOSE_TOPIC = uint256(keccak256("CommitmentClosed(bytes32,uint256)"));

    struct ClosureEvidence {
        uint256 chainId;
        address vault;
        uint256 blockNumber;
        uint256 blockHash;
        uint256 txHash;
        uint256 logIndex;
        uint256 consumed;
    }

    mapping(uint256 => address) public vaults;
    mapping(bytes32 => bool) public seenLogs;
    mapping(bytes32 => bool) public cancelledBeforeReservation;
    mapping(bytes32 => ClosureEvidence) public closureEvidence;

    error UnauthorizedCoordinatorCaller();
    error InvalidConfiguration();
    error RouteAlreadyConfigured();
    error NotRetryable();

    event VaultConfigured(uint256 indexed chainId, address vault);
    event RequestRejected(bytes32 indexed id, string reason);

    constructor(address owner_, address finalityVerifier_, uint256 cap_, uint256 originChainId_, address originInbox_)
        payable BudgetLedger(cap_)
    {
        if (owner_ == address(0) || finalityVerifier_ == address(0) || originChainId_ == 0 || originInbox_ == address(0)) {
            revert InvalidConfiguration();
        }
        owner = owner_;
        finalityVerifier = finalityVerifier_;
        originChainId = originChainId_;
        originInbox = originInbox_;
        _subscribe(originChainId_, originInbox_, REQUEST_TOPIC);
        _subscribe(originChainId_, originInbox_, CANCEL_TOPIC);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert UnauthorizedCoordinatorCaller();
        _;
    }

    /// @notice Routes cannot be replaced while old permits remain outstanding.
    function configureVault(uint256 chainId, address vault) external onlyOwner {
        if (chainId == 0 || vault == address(0)) revert InvalidConfiguration();
        if (vaults[chainId] != address(0)) revert RouteAlreadyConfigured();
        vaults[chainId] = vault;
        _subscribe(chainId, vault, SPEND_TOPIC);
        _subscribe(chainId, vault, CLOSE_TOPIC);
        emit VaultConfigured(chainId, vault);
    }

    function react(LogRecord calldata log_) external onlySystem {
        bool fromInbox = log_.chainId == originChainId && log_.contractAddress == originInbox;
        bool fromVault = vaults[log_.chainId] != address(0) && log_.contractAddress == vaults[log_.chainId];
        if ((!fromInbox && !fromVault) || log_.opCode != 2 || log_.topic2 != 0 || log_.topic3 != 0) return;

        bytes32 eventId = keccak256(abi.encode(log_.chainId, log_.contractAddress, log_.blockHash, log_.txHash, log_.logIndex));
        if (seenLogs[eventId]) return;

        bytes32 id = bytes32(log_.topic1);
        if (fromInbox && log_.topic0 == REQUEST_TOPIC && log_.data.length == 128) {
            seenLogs[eventId] = true;
            _handleRequest(id, log_.data);
        } else if (fromInbox && log_.topic0 == CANCEL_TOPIC && log_.data.length == 0) {
            seenLogs[eventId] = true;
            _cancel(id);
        } else if (fromVault && log_.data.length == 32) {
            Commitment storage c = commitments[id];
            if (c.status == Status.None || c.chainId != log_.chainId || c.vault != log_.contractAddress) return;
            if (log_.topic0 == SPEND_TOPIC) {
                seenLogs[eventId] = true;
                _recordSpend(id, abi.decode(log_.data, (uint256)));
            } else if (log_.topic0 == CLOSE_TOPIC) {
                seenLogs[eventId] = true;
                uint256 consumed = abi.decode(log_.data, (uint256));
                bytes32 proof = keccak256(abi.encode(
                    log_.chainId, log_.contractAddress, log_.blockNumber, log_.blockHash,
                    log_.txHash, log_.logIndex, id, consumed
                ));
                if (_observeClosure(id, consumed, proof)) {
                    closureEvidence[id] = ClosureEvidence(
                        log_.chainId, log_.contractAddress, log_.blockNumber,
                        log_.blockHash, log_.txHash, log_.logIndex, consumed
                    );
                }
            }
        }
    }

    function _handleRequest(bytes32 id, bytes calldata data) private {
        (uint256 chainId, address recipient, uint256 amount, uint64 expiresAt) = abi.decode(data, (uint256,address,uint256,uint64));
        address vault = vaults[chainId];
        if (cancelledBeforeReservation[id]) { emit RequestRejected(id, "cancelled"); return; }
        if (vault == address(0) || id == bytes32(0) || recipient == address(0) || amount == 0) {
            emit RequestRejected(id, "invalid route or request"); return;
        }
        if (commitments[id].status == Status.None) {
            if (expiresAt <= block.timestamp) { emit RequestRejected(id, "expired"); return; }
            if (amount > availableBudget()) { emit RequestRejected(id, "budget unavailable"); return; }
        }
        if (_reserve(id, chainId, vault, recipient, amount, expiresAt)) _sendGrant(id);
    }

    function _cancel(bytes32 id) private {
        if (id == bytes32(0)) return;
        Commitment storage c = commitments[id];
        if (c.status == Status.None) { cancelledBeforeReservation[id] = true; return; }
        if (_requestCancellation(id)) _sendClose(id);
    }

    function requestCancellation(bytes32 id) external onlyOwner { _cancel(id); }

    function retryGrant(bytes32 id) external onlyOwner {
        Commitment storage c = commitments[id];
        if (c.status != Status.Reserved || c.expiresAt <= block.timestamp) revert NotRetryable();
        _sendGrant(id);
    }

    function retryCancellation(bytes32 id) external onlyOwner {
        if (commitments[id].status != Status.CancellationRequested) revert NotRetryable();
        _sendClose(id);
    }

    function finalizeClosure(bytes32 id, uint256 consumed, bytes32 proof) external returns (bool) {
        if (msg.sender != finalityVerifier) revert UnauthorizedCoordinatorCaller();
        return _finalizeClosure(id, consumed, proof);
    }

    function coverDebt() external { _coverDebt(); }

    function _sendGrant(bytes32 id) private {
        Commitment storage c = commitments[id];
        _callback(c.chainId, c.vault, abi.encodeWithSignature(
            "grant(address,bytes32,address,uint256,uint64)", address(0), id, c.recipient, c.amount, c.expiresAt
        ));
    }

    function _sendClose(bytes32 id) private {
        Commitment storage c = commitments[id];
        _callback(c.chainId, c.vault, abi.encodeWithSignature("close(address,bytes32)", address(0), id));
    }

    function _callback(uint256 chainId, address recipient, bytes memory payload) private {
        SYSTEM.requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0({
            chainId: chainId, recipient: recipient, gasLimit: CALLBACK_GAS, payload: payload
        }));
    }

    function _subscribe(uint256 chainId, address source, uint256 topic0) private {
        SYSTEM.subscribe(chainId, source, topic0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }
}
