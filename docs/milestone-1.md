# Milestone 1 status

Verified at 2026-11-15T18:52:44.214Z.

The contract prototype is implemented and verified locally. Public deployment is
blocked by free testnet token access. No public contract address or transaction
hash exists for this project yet. Runtime AI has not been implemented.

## Final verification

| Check | Result |
| --- | --- |
| Solidity compiler | 0.8.29+commit.ab55807c.Emscripten.clang |
| Compiler warnings | 0 |
| Tests passed | 41 |
| Tests failed | 0 |
| Actual EVM scenarios | 12 |
| Finality verifier scenarios | 20 |
| Deployment and recovery script scenarios | 9 |
| Local demo | Passed |
| Public testnet execution | False |
| Runtime AI inference | False |

The source digest is `c46f9b223ac1fc98ac35a517e19299aa1329899cb94359148eb968c025784c98`. The verifier hashes original contract,
script, and test files plus package.json and package-lock.json. It also checks the
pinned clean SDK revision, `3ade0dcf1d27e67e5783ef807e73a1b9e0c0cce8`.

## Demonstrated outcome

The nine-step local demo ends with cap 100, spent 60, reserved 0, and available
40. It records zero duplicate payments and no reopening of the cancelled
commitment. An observation alone never releases reserved capacity.

The local transport uses three independently stored EVMs. Tests substitute the
Reactive system, callback proxies, and finality signer. Public RPC preflights are
real read-only calls. These two evidence categories are labelled separately.

## Live access

The prepared public address is `0x4C4543217e66Ac3124d795785C63fa160B181C25`.
Latest checks found zero test tokens. Base Sepolia, Unichain Sepolia, and Reactive
Lasna RPC access and expected service bytecode passed. The deployment preflight
reports `awaiting-testnet-funding` and contains no invented deployment records.

The free faucet checks found maintenance, a hosting-IP restriction, or a need for
wallet/account interaction. Details and source links are in `live-access.md`.

After ordinary free testnet funding, run the deployment and live-loop commands
in the README. The smallest public loop uses Base Sepolia for origin and
payment destination, with Reactive Lasna as coordinator. It must record the real
request, reservation, callback, payment, and spend transactions before it reports
success. Add the second public destination and the AI runtime after that gate.

## Deliverable

The source archive contains original contracts, locked JavaScript dependencies,
setup and deployment scripts, tests, documentation, and public evidence. It
excludes private keys, signed transaction bytes, node_modules, generated contract
artifacts, and the separately licensed upstream Reactive SDK source. Setup fetches
the pinned SDK. Historical public manifests live under `evidence/snapshots`, so a
fresh checkout can create its own wallet and active deployment state.
