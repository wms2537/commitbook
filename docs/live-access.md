# Live testnet access

## Current status

The read-only preflight passed on Reactive Lasna, Base Sepolia, and Unichain Sepolia on **15 November 2026 at 18:37 UTC**. All RPCs returned their expected chain IDs, recent blocks, gas prices, and nonempty bytecode at the documented Reactive service addresses. All fee configuration reads also succeeded.

The disposable deployment address is `0x4C4543217e66Ac3124d795785C63fa160B181C25`. Its native balance was **zero on all three networks**. The preflight returned exit code `2` with `--require-funded`. The environment can reach the networks, but this address cannot yet pay deployment or callback fees. No public testnet deployment or transaction occurred during this access check.

Only the public address is used here. The preflight never opens a wallet file, reads a private key, signs data, or submits a transaction.

## Verified networks

| Network | Chain ID | Official public RPC | Latest block observed | Service bytecode |
| --- | ---: | --- | ---: | ---: |
| Reactive Lasna | 5318007 | `https://lasna-rpc.rnk.dev/` | 8429008 | 239 bytes |
| Base Sepolia | 84532 | `https://sepolia.base.org` | 59229831 | 218 bytes |
| Unichain Sepolia | 1301 | `https://sepolia.unichain.org` | 67915403 | 218 bytes |

| Role | Address |
| --- | --- |
| Lasna system contract | `0x8888888888888888888888888888888888888888` |
| Base Sepolia callback proxy | `0x476F44b11F5C942c58f4c8E3d0300E5710743585` |
| Unichain Sepolia callback proxy | `0x775c9B990ADe401060B78D0e98684eEf8d2466C1` |
| Base Sepolia faucet for Lasna | `0x2afaFD298b23b62760711756088F75B7409f5967` |

The Base faucet also had nonempty bytecode, 1,534 bytes. A bytecode presence check is an access prerequisite, not a contract audit or an implementation identity check. These services use small proxy contracts. The script reports a SHA-256 digest of the returned runtime bytecode for reproducibility.

Sources: [Reactive networks and callback proxies](https://dev.reactive.network/origins-and-destinations), [Reactive Lasna parameters](https://dev.reactive.network/reactive-mainnet), [Base network parameters](https://docs.base.org/get-started/connect-to-base), and [Unichain network parameters](https://developers.uniswap.org/docs/unichain/technical-information/network-information).

## Reproduce the check

Requires Node.js 22 or later and no installed packages.

```sh
node scripts/check-testnets.mjs

node scripts/check-testnets.mjs \
  --address 0x4C4543217e66Ac3124d795785C63fa160B181C25 \
  --networks lasna,base-sepolia \
  --require-funded
```

The default checks all three networks. `--networks` accepts any comma-separated subset of `lasna`, `base-sepolia`, and `unichain-sepolia`. Output is JSON on stdout.

| Exit code | Meaning |
| ---: | --- |
| 0 | Required network checks passed. Without `--require-funded`, zero balances do not change this code. |
| 1 | A required check or configuration failed. |
| 2 | Network checks passed, but at least one selected network has no balance at the supplied public address. |

A positive balance does not establish that the deployment is affordable. Estimate the actual deployment and funding transactions before sending them.

Optional RPC overrides are `LASNA_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, and `UNICHAIN_SEPOLIA_RPC_URL`. The script checks the expected testnet chain ID before further reads. A mainnet or wrong-network override fails. It loads no environment file automatically. It emits only the RPC origin, never URL credentials, paths, queries, raw provider errors, or headers.

Required checks are chain ID, service bytecode, latest block, gas price, and the optional public-address balance. Finalized block, fee configuration, and Base faucet bytecode are reported as warnings if unavailable. Every request has a 12-second timeout. The only permitted RPC methods are `eth_chainId`, `eth_getCode`, `eth_getBlockByNumber`, `eth_gasPrice`, `eth_getBalance`, and `eth_call`.

## Observed gas costs

These values are point-in-time arithmetic from the public RPCs, not deployment quotes. Native units are lREACT on Lasna and test ETH on Base and Unichain. The L2 values exclude L1 data fees. Read prices again immediately before deployment.

| Network | Gas price, wei | Gas cost for 1,000,000 units | Service fee reference for 100,000 execution gas |
| --- | ---: | ---: | ---: |
| Lasna | 100000000000 | 0.1 lREACT | 0.02 lREACT |
| Base Sepolia | 6013778 | 0.000006013778 ETH | 0.000001190728044 ETH |
| Unichain Sepolia | 1500000 | 0.0000015 ETH | 0.000000297 ETH |

The service fee reference uses `max(eth_gasPrice, block.baseFee) × coefficient / 1000 × (100000 + extraGas)`. Actual delivery may use a different gas price and execution gas amount.

| Network | `_gasPriceCoeffPer1000()` | `_extraGas()` | `_maxChargeGas()` |
| --- | ---: | ---: | ---: |
| Lasna | 1000 | 100000 | 50000 |
| Base Sepolia | 1100 | 80000 | 50000 |
| Unichain Sepolia | 1100 | 80000 | 50000 |

These were queried from the deployed services. The callback gas limit must leave room for proxy overhead and payment handling. Fund both the Lasna reactive contract and the destination callback contract. `depositTo(address)` creates service reserves and clears existing debt. A transfer directly to a contract does not clear debt by itself. Source: [Reactive fee and funding model](https://dev.reactive.network/economy).

## Funding routes checked

The free-faucet investigation used official network documentation and the linked providers. No account, wallet extension, or external funding source was available for the new address. No mainnet assets were spent. No access control, CAPTCHA, rate limit, or provider restriction was bypassed.

| Route | Current requirement or observed result |
| --- | --- |
| [Thirdweb Base Sepolia](https://thirdweb.com/base-sepolia-testnet) | The live page advertises 0.01 ETH per day and requires **Connect Wallet**. No wallet was connected. No documented public programmatic claim route was found in the bounded check. |
| [Superchain faucet](https://console.optimism.io/faucet) | The live page displayed **Faucet is undergoing maintenance** and said it was fixing issues. No claim was possible. |
| [QuickNode Base Sepolia](https://faucet.quicknode.com/base/sepolia) | The provider requires a small mainnet balance. This does not suit the empty disposable address. |
| [Coinbase Developer Platform](https://docs.cdp.coinbase.com/faucets/introduction/quickstart) | Requires a CDP account or API credentials. No scoped credentials were provided. |
| [ethfaucet Base](https://ethfaucet.com/networks/base) | Requires BringID identity verification. |
| [PK910 Ethereum Sepolia PoW faucet](https://sepolia-faucet.pk910.de/) | Public form advertises 0.05 to 2.5 SepETH per session. The normal Start Mining action returned `[IPINFO_RESTRICTION] IP Blocked: You're connecting from a hosting IP range.` No mining session or claim began. No alternate route or network workaround was attempted. |

The PK910 route is listed by [ethereum.org](https://ethereum.org/developers/tools/powfaucet/). Its [provider overview](https://www.faucets.pk910.de/) describes browser proof of work without signup. The specific hosting-IP refusal above is a live observation from this environment, not a claim that the faucet is unavailable to everyone. See also [Cloud Browser website restrictions](https://help.openai.com/articles/20001280-using-cloud-browser-in-chatgpt#when-a-website-blocks-the-task).

Network-maintained faucet lists are available from [Base](https://docs.base.org/get-started/get-funds) and [Unichain](https://developers.uniswap.org/docs/unichain/tools/faucets). Those lists establish supported funding options, not a guarantee that an individual provider accepts this browser or address.

### Convert test ETH to Lasna lREACT

Reactive's documented faucet exchanges test ETH at **1 ETH to 100 lREACT**. It accepts a transfer or payable `request(address)` call on either faucet:

- Base Sepolia: `0x2afaFD298b23b62760711756088F75B7409f5967`
- Ethereum Sepolia: `0x9b9BB25f1A81078C544C829c5EB7822d747Cf434`

The documented maximum is 5 test ETH per transaction. An excess does not increase the payout. This is a conversion funded by test ETH, not a zero-balance lREACT claim. Source: [Reactive faucet instructions](https://dev.reactive.network/reactive-mainnet).

For planning, 0.005 Base test ETH converts to 0.5 lREACT. At the observed Lasna gas price, 0.5 lREACT covers five million gas units before allocating reserves for reactive execution. This is arithmetic, not a conclusion that 0.5 lREACT covers the finished contract deployment. The deployment script must estimate its actual bytecode and reserve needs.

## Next live step

Obtain a normal free Base Sepolia faucet allocation for the disposable address, then rerun the two-network funding check. A single Base origin and destination linked through Lasna is the smallest live loop. Estimate deployment gas, allocate some Base test ETH to the official Lasna faucet, wait for the lREACT balance, and fund both Reactive service accounts before triggering the first commitment. Add Unichain after its test ETH is available.

Ethereum Sepolia is a supported alternative origin and destination if its funding becomes available. Its documented callback proxy is `0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4` and chain ID is 11155111. This preflight deliberately covers the selected Lasna, Base, and Unichain configuration; it does not imply that Ethereum Sepolia RPC access or deployment was tested.

The remaining blocker is free test token access for the new address. Network connectivity, chain identity, and Reactive service presence are already verified.
