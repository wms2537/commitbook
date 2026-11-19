# Core interface

These are accounting and destination execution cores. They deliberately contain
no network impersonation, source-finality claim or standalone authentication.
The Reactive adapters inherit them and own their external trust boundaries.

## BudgetLedger

Constructor: `BudgetLedger(uint256 budgetCap)`.

The cap is immutable and uses one denomination. The core holds no ERC20 funds.
All quantities use the same smallest-unit convention on every destination.

Public reads:

- `budgetCap()`, `totalReserved()`, `totalSpent()`, `availableBudget()`.
- `commitments(bytes32 id)`, returning the fields below in declaration order.

The commitment fields are `chainId`, `vault`, `recipient`, `amount`, `expiresAt`,
`status`, `spent`, `observedConsumed`, `observedClosureProof`, `closureObserved`,
and `closureFinalized`. `expiresAt` is `uint64`. Status values are None 0,
Reserved 1, CancellationRequested 2, Settled 3 and Closed 4.

All internal mutations return `bool changed`. A repeated identical business
transition returns false. Contradictory amounts or immutable parameters revert.

| Internal method | Adapter obligation |
| --- | --- |
| `_reserve(bytes32 id, uint256 chainId, address vault, address recipient, uint256 amount, uint64 expiresAt)` | Authenticate the approved requester and configured destination. Call before issuing a grant. Issue only when true. |
| `_requestCancellation(bytes32 id)` | Authenticate cancellation authority. A timeout may request cancellation but must not release capacity. Issue cancellation only when true, or provide a separately authorized retry path. |
| `_recordSpend(bytes32 id, uint256 amount)` | Verify source chain, vault, event signature and event layout against the immutable commitment. Only full consumption is accepted. |
| `_observeClosure(bytes32 id, uint256 consumed, bytes32 proof)` | Verify the source event and bind the digest to its chain, vault, block, transaction, log index, ID and consumed amount. This does not release capacity. |
| `_finalizeClosure(bytes32 id, uint256 consumed, bytes32 proof)` | Restrict to the configured trusted finality verifier. Check canonical finalized history externally before calling. The digest and consumed amount must match observed evidence. |

The accounting invariant is `totalSpent + totalReserved <= budgetCap`.
An in-flight permit remains fully reserved until a spend is recorded or closure
is finalized. Spend recording converts reservation to spent and cannot increase
available capacity. Final closure releases only unused reservation.

A closure can report zero or the full reserved amount. Partial consumption is
outside this milestone. Source reorganizations can strand conservatively
recorded spend. The prototype does not automatically reverse it or reclaim it.
Contradictory evidence is rejected and requires explicit investigation.

Repeated consistent closure evidence with a new digest replaces the pending
digest. A verifier must reread the current pending digest before finalizing.
After finalization, consistent repeats are ignored and contradictory outcomes
revert. A spend arriving after finalized zero-spend closure reverts.

Cancellation of an already settled or closed commitment is a no-op. Grant IDs
are never reused, even after closure. Identical reserve replay is a no-op after
expiry; a new expired request reverts.

## CommitmentVaultCore

Constructor: `CommitmentVaultCore(address token)`.

The fixed token must already have code. Fund the vault separately before using
permits. There is no bridging, credit or withdrawal method in this core.

Public reads: `token()` and `permits(bytes32 id)`.

Permit fields are `recipient`, `amount`, `expiresAt`, `consumed`, `state`, and
`everGranted`. State values are None 0, Open 1, Consumed 2 and Closed 3.

- `_grant(bytes32 id, address recipient, uint256 amount, uint64 expiresAt)`
  is internal. The adapter authenticates both the callback proxy and injected
  Reactive sender. It returns false for an identical duplicate or closed ID.
- `_close(bytes32 id)` is internal with the same authentication requirement.
  It creates a permanent tombstone even if the original grant has not arrived.
  It returns false for a duplicate close.
- `execute(bytes32 id)` is external and permissionless. The recipient and amount
  are immutable, so callers cannot redirect the payment. It returns false after
  consumption and reverts for unknown, unconsumed closed, or expired permits.

The source events the coordinator should subscribe to are:

```solidity
event CommitmentExecuted(bytes32 indexed id, uint256 amount);
event CommitmentClosed(bytes32 indexed id, uint256 consumed);
```

Only `id` is indexed. Their normalized Reactive log therefore has `opCode = 2`.
Decode the single uint256 from `data`, and use `topic1` for the operation ID.
`CommitmentGranted` and `LateGrantRejected` are additional audit events.

An unknown-ID close followed by a delayed grant remains closed. An existing
grant with conflicting immutable fields reverts. A grant can execute once;
effects precede the token call and reentrant execution reverts. Transfer failure
rolls back the consumption marker. Vault and recipient balance deltas must both
match the exact amount, so fee-on-transfer and rebasing tokens are unsupported.
The fixed test token remains a trusted dependency, not an arbitrary-token claim.

## Minimum adversarial checks

Check the public adapter methods, not calls to these internal cores alone:

1. Reject forged source and callback callers.
2. Reserve 60 of 100 and reject a second 60 before any receipt arrives.
3. Request cancellation and keep all 60 reserved.
4. Close at destination before the original grant; reject that late grant.
5. Observe closure without releasing capacity.
6. Reject non-finalizer and wrong-digest finalization.
7. Finalize zero-consumption closure once, then admit the next commitment.
8. Execute once and repeat grant, execution and spend receipt without double pay.
9. Process spent closure before or after the spend receipt without double count.
10. Reject a spend after finalized zero-consumption closure.
11. Reject expired permits and roll back failed token transfers.
