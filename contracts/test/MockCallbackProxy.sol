// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Local test substitute for transport, including injected callback identity.
contract MockCallbackProxy {
    event CallbackDelivered(address indexed reactive, address indexed target, bool success, bytes result);

    receive() external payable {}

    function debt(address) external pure returns (uint256) { return 0; }

    function deliver(address reactive, address target, bytes calldata payload) external returns (bool success, bytes memory result) {
        require(payload.length >= 36, "Missing callback identity argument");
        bytes memory injected = payload;
        assembly { mstore(add(injected, 36), reactive) }
        (success, result) = target.call(injected);
        emit CallbackDelivered(reactive, target, success, result);
    }
}
