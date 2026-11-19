# Milestone review

The implementation received separate contract, finality-verifier, and deployment
script reviews before the final integration run. This was a code review of a
prototype, not a third-party security audit.

## Findings corrected

| Finding | Correction | Validation |
| --- | --- | --- |
| A destination could close or pay successfully, but a missed receipt left the coordinator unable to recover. | Authenticated retries republish the stored closure or payment outcome. They cannot transfer tokens again or reopen a closed permit. | Two regressions deliberately drop the original receipts and then reconcile once. |
| Whole-workflow funding thresholds could block recovery of an already submitted transaction. | Receipt and pending-transaction recovery precede checks for genuinely new transaction costs. | Confirmed, prepared, and pending journal recovery tests, including zero remaining balance. |
| Concurrent command runs could overwrite the transaction journal. | Deployment, live-loop broadcasts, and finalizer broadcasts share an exclusive workflow lock. | Exclusive lock and repeated-release regression. |
| Separate latest-block reads could mix accounting values across an update. | Live budget reads use one block and recheck its canonical hash. | Coherent snapshot and changed-hash regression. |
| A read-only snapshot could present an old successful run as freshly verified. | Cached loop results are explicitly historical. A current success requires actual verification. | Code review of the read-only branch and its error path. |
| Default ethers transport did not use the available network route. | Bounded native-fetch transport is shared by live provider creation. | Actual read-only RPC calls succeed on the selected public testnets. |

## Finality review conclusions

The verifier uses the same evidence digest and ABI field order as the contract.
It checks the source receipt, event identity, canonical source block, finalized
checkpoint, and permanent closure state at that finalized block hash. Unsupported
finality or state queries refuse release. It rechecks the pending coordinator
proof before signing, and the contract also enforces exact proof equality.

The verifier trusts the configured RPC and the configured verifier identity.
Those checks do not prove source consensus independently. Deployment and
live-loop transaction journals support resume. The finalizer instead refuses
to start while its signer has pending transactions, then relies on the contract's
idempotent finalization if it is invoked again after confirmation.

## Evidence boundary

`evidence/verification.json` and `evidence/test-output.txt` record the final local
integration run. `evidence/local-demo.json` records actual local EVM receipts.
The public preflight and deployment snapshot record network access and the
funding blocker. Public testnet execution and runtime AI remain false until their
respective workflows have actually run.
