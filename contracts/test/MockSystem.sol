// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";

/// @notice Local test transport. This is never deployed by the public-network script.
contract MockSystem is ISystemContract {
    event Subscribed(address indexed reactive, uint256 chainId, address origin, uint256 topic0);
    event CallbackRequested(address indexed reactive, uint256 chainId, address recipient, uint64 gasLimit, bytes payload);

    receive() external payable {}

    function debt(address) external pure returns (uint256) { return 0; }

    function subscribe(uint256 chainId, address origin, uint256 topic0, uint256, uint256, uint256) external {
        emit Subscribed(msg.sender, chainId, origin, topic0);
    }

    function unsubscribe(uint256, address, uint256, uint256, uint256, uint256) external {}

    function requestCallback(CallbackVersion, bytes memory config) external {
        _request(abi.decode(config, (CallbackConfiguration_V_1_0)));
    }

    function requestCallbackV_1_0(CallbackConfiguration_V_1_0 memory config) external {
        _request(config);
    }

    function _request(CallbackConfiguration_V_1_0 memory config) private {
        emit CallbackRequested(msg.sender, config.chainId, config.recipient, config.gasLimit, config.payload);
    }

    function deliverLog(address reactive, IReactive.LogRecord calldata log) external {
        IReactive(payable(reactive)).react(log);
    }
}
