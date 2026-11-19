// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Unrestricted minting is intentional for local and testnet demo tokens only.
contract TestToken {
    string public constant name = "CommitBook Test Token";
    string public constant symbol = "CBTEST";
    uint8 public constant decimals = 0;
    mapping(address => uint256) public balanceOf;
    bool public transfersFail;
    event Transfer(address indexed from, address indexed to, uint256 amount);

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
    }

    function setTransfersFail(bool fail) external { transfersFail = fail; }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        if (transfersFail) return false;
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        emit Transfer(msg.sender, recipient, amount);
        return true;
    }
}
