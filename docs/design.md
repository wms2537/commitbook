# Commitment design

## Budget invariant

For a fixed cap B, recorded spending S, and outstanding reservations R:

`S + R <= B`

A new amount A can be reserved only when `A <= B - S - R`. The coordinator changes
R before requesting a callback. If the callback request reverts, the entire
transaction, including its reservation, reverts.

A confirmed full spend converts A reserved into A spent, so S + R does not
increase. A verified closed commitment with consumption zero reduces R by A.
A verified closed commitment with full consumption moves A from R to S. Duplicate
business requests, callbacks, payments, receipts, and finalizations cannot apply
these transitions twice.

This is a safety invariant under the stated trust assumptions. It does not
guarantee progress when messages, funding, finality data, or the verifier are
unavailable. Holding capacity is safer than guessing that a remote permit died.

## Responsibilities

The inbox restricts request authors and supplier addresses. It binds an operation
ID to immutable parameters and records who created it. The Reactive coordinator
owns the shared budget and sends authenticated callbacks. Destination vaults
hold token inventory and enforce the actual payment. The finality verifier
authorizes reclaiming unused capacity after a destination is permanently closed.

The coordinator checks both source chain and emitting contract, topic shape, and
event data layout. The destination checks both the service proxy caller and the
Reactive sender injected into callback argument zero. Business idempotency uses
the operation ID, while transport deduplication uses chain, emitter, block hash,
transaction hash, and log index.

## Destination transitions

| Current state | Action | Result |
| --- | --- | --- |
| None | Valid grant | Open permit with fixed recipient, amount, and expiry. |
| None | Close | Closed tombstone, even if a grant has not arrived. |
| Open | Execute before expiry | Transfer the full amount once and mark consumed. |
| Open | Close | Permanently closed with zero consumed. |
| Consumed | Execute again | No second transfer. |
| Consumed | Close | Permanently closed with the actual full consumed amount. |
| Closed | Delayed grant | Reject reopening. |
| Closed | Authorized close retry | Republish the stored closure result. |
| Consumed or closed after payment | Authorized grant retry | Republish the stored payment result after metadata validation. |

There is no transition from Closed to Open. Expiry makes execution unavailable
but does not return budget by itself. A close transaction still establishes the
permanent destination state used for safe release.

## Closure verification

A destination closure event is an observation. The coordinator stores a digest
over the chain ID, vault, block number, block hash, transaction hash, log index,
operation ID, and consumed amount. It leaves the reservation in place.

The verifier checks the successful receipt, exact matching event, canonical
source block, and finalized checkpoint. It reads the permit at that finalized
checkpoint and requires it to be closed with the same consumed amount. It then
rechecks the pending coordinator proof before signing a finalization transaction.
The coordinator independently requires that exact proof and its configured
verifier caller.

An RPC that cannot support the required finalized state query cannot authorize a
release through this verifier. It does not silently replace finality with an
arbitrary number of confirmations. The verifier and its RPC remain trusted.

Repeated consistent closure logs can replace the pending proof digest. A verifier
working on an older digest must retry. Contradictory evidence fails closed.

## Missing messages and races

A grant retry preserves the original operation ID and payment parameters. After
execution, it can republish the payment receipt without paying again. If expiry
prevents another grant retry, request cancellation and reconcile the consumed
amount through closure.

A close retry republishes the stored closed result. The first result may have
been missed even though the destination transaction succeeded. Without this
republication, funds could remain reserved indefinitely after a transport gap.

Cancellation does not promise to beat an execution transaction already reaching
the destination. If execution wins, closure reports the full consumed amount and
the coordinator records the spend. If close wins, the payment cannot proceed.

If source cancellation reaches Reactive before the source request, the
coordinator records a tombstone and refuses that later request. An over-budget
request is rejected rather than queued. A later purchase after capacity returns
must use a fresh operation ID.

## Trust assumptions and prototype limits

The Reactive system and destination callback proxies authenticate transport.
Source requests may be acted on before source finality. This version does not
claim to solve request authorization across source reorganization. A source
reorganization or conflicting spend observation may strand capacity. The code
does not silently replenish it.

The owner configures one immutable vault route per destination chain. The owner
also selects a finality verifier at deployment. The demonstration uses the owner
for both roles, so it is not a decentralized verifier system.

The token is fixed and trusted. The vault checks exact balance changes and
reverts failed or fee-charging transfers. Rebasing and fee-on-transfer tokens are
unsupported. Separate deployments on different chains represent one accounting
denomination by assumption; no market price or exchange-rate logic is present.

The local harness executes actual Solidity with independently stored EVM state
on three chains. It substitutes the network delivery and finality services. It
cannot establish real Reactive delivery latency, network fee behavior, public
chain finality, or production security.

This milestone implements payment authority and recovery. It does not implement
runtime AI, supplier delivery validation, a bridge, partial consumption, credit,
multi-owner governance, or a production deployment.
