// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Testnet demonstration asset. It has no monetary value or production use.
contract DemoToken {
    string public constant name = "CommitBook Demo Token";
    string public constant symbol = "CBDEMO";
    uint8 public constant decimals = 0;
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 amount);

    /// @dev Intentionally unrestricted for testnets. No production asset is minted.
    function mint(address recipient, uint256 amount) external {
        require(recipient != address(0), "Zero recipient");
        balanceOf[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        require(recipient != address(0) && balanceOf[msg.sender] >= amount, "Invalid transfer");
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        emit Transfer(msg.sender, recipient, amount);
        return true;
    }
}
