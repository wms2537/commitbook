# CommitBook submission draft

Updated 19 November 2026. Target track: Reactive Meets AI.

Submission status: **not ready**. The local model and contract demonstrations
have recorded evidence. Public Reactive execution and the final submission video remain pending.
The original source is published in the public repository linked below. This draft describes those boundaries
explicitly. See [the readiness record](submission-readiness.md) before publishing.

## Entry details

| Field | Draft content |
| --- | --- |
| Project name | CommitBook |
| Short description | A shared spending cap for AI purchase proposals, with reservations that survive delayed callbacks and failed suppliers. |
| Track | Reactive Meets AI |
| Public deployment target | Base Sepolia, chain 84532, with Reactive Lasna, chain 5318007. |
| Public repository | [github.com/wms2537/commitbook](https://github.com/wms2537/commitbook). Original source is MIT licensed. The immutable source commit is recorded in `evidence/submission-input.json`. |
| Demo video | [140-second captioned local walkthrough](../demo/commitbook-walkthrough.mp4). Public-proof segment pending. This preview is not the final submission video. |
| Demonstration page | PENDING judge-accessible URL. The existing hosted page replays recorded local execution. |
| License | MIT for original CommitBook source. Dependencies retain their own terms. See [THIRD_PARTY.md](../THIRD_PARTY.md). |

These are suggested entry contents. The exact DoraHacks form fields have not
been verified.

## Project description

An AI agent can choose a supplier in seconds. A payment approval can arrive much
later. If the supplier fails while that approval is in transit, buying a
replacement can spend the same budget twice.

CommitBook gives an operator one fixed budget across prefunded EVM vaults. Each
purchase reserves capacity before the destination receives permission to pay.
If the purchase fails, the destination closes that operation permanently. The
budget becomes available again only after the system observes the closure and
an authorized verifier confirms it against finalized destination state.

Our example is invoice processing. A local Qwen2.5-1.5B model reads the purchase
goal and supplier messages. It interprets the requested service, privacy
preference, speed preference, and failure outcome. Deterministic code selects an
approved offer and checks the owner's policy. An operator reviews the proposal
before execution. The model cannot supply an address, increase the budget,
construct arbitrary calldata, or authorize release of a reservation.

Reactive connects the source request to the destination permission. The
coordinator authenticates events, records the reservation, and requests the
callback. The destination enforces the fixed recipient and amount. Payment
receipts reconcile the shared budget. A lost receipt can be requested again
without paying again.

The recorded local recovery run starts with a budget of 100. A 60-unit purchase
reserves capacity, so a competing 60-unit proposal cannot execute. After a
supplier outage, the model proposes a 55-unit replacement. The operator cancels
the original purchase, but the replacement stays blocked while its closure
receipt is missing. A late approval cannot reopen the closed operation. Receipt
recovery and explicit finalization return the capacity. The replacement then
pays once, leaving 55 spent, zero reserved, and 45 available.

That run uses four actual model calls and three independent local EVMs. Reactive
delivery and finality are simulated there. It does not establish public network
execution. The planned public demonstration uses Base Sepolia and Lasna and
must link an actual model proposal to the observed request and callback.

We keep operator review because the model is still unreliable. It made 7 correct
decisions on 12 development cases, matching the declared rules baseline. Those
cases informed development, so this is a regression result rather than an
independent measure of general accuracy. CommitBook's contribution is the
enforced spending and recovery protocol around those fallible proposals.

Evidence: [actual local workflow](../evidence/agent-workflow.json),
[model evaluation](../evidence/agent-evaluation.json), and
[milestone results](milestone-2-results.md).

## Technical architecture

| Component | Responsibility | Authority boundary |
| --- | --- | --- |
| `agent/planner.mjs` and local Qwen worker | Interpret a goal or supplier message and produce a bounded recommendation. | Model text has no signing authority. |
| `app/runtime.mjs` | Resolve catalog terms, validate policy, and execute an operator-approved local proposal. | Recheck current state before an action. The local console does not load the public testnet wallet. |
| `scripts/live-agent.mjs` | Run actual inference, save a public purchase proposal, and pass an approved proposal to the public loop. | Require the operator's exact reviewed proposal digest. Bind the operation ID to that proposal and coordinator. |
| `CommitmentInbox` | Authenticate the request author and approved supplier, then emit immutable purchase terms. | An operation ID cannot acquire different terms later. |
| `CommitBookReactive` and `BudgetLedger` | Reserve budget before requesting a grant and reconcile destination outcomes. | Validate the source chain, emitter, event shape, and duplicate identity. |
| `CommitmentVault` | Accept authenticated callbacks and transfer the fixed amount to the fixed recipient once. | Check the callback proxy and Reactive sender. A closed operation cannot reopen. |
| `scripts/verify-closure.mjs` | Check closure evidence and finalized destination state before authorized release. | Trust the configured RPC and verifier. This is not a cryptographic consensus proof. |

For cap `B`, recorded spending `S`, and outstanding reservations `R`, the budget
invariant is `S + R <= B`. A request for `A` proceeds only when
`A <= B - S - R`. A payment moves `A` from reserved to spent. Verified unused
closure removes `A` from reserved. Expiry alone does not release capacity.

The public target places the inbox, demonstration token, and vault on Base
Sepolia. Lasna hosts the Reactive coordinator. The local recovery demonstration
also has a separate Unichain EVM. No token bridge is involved.

See [the contract design](design.md) for state transitions and
[the model boundary](model.md) for the inference schema and policy checks.

## Measured evidence and remaining proof

| Claim | Evidence | Boundary |
| --- | --- | --- |
| The 16 November milestone recorded 72 tests passed with zero failures. | [Milestone result](milestone-2-results.md). Current reruns write [verification.json](../evidence/verification.json) and [test-output.txt](../evidence/test-output.txt). | Use the latest report's timestamp and count when describing the current source. Test planner responses are controlled fixtures. |
| The recovery run used actual neural inference and paid the replacement once. | [agent-workflow.json](../evidence/agent-workflow.json) | Four model calls, 15 checkpoints, 15 local receipts, and final accounting of 55 spent, zero reserved, and 45 available. |
| The model matched the rules baseline at 7 correct decisions out of 12. | [agent-evaluation.json](../evidence/agent-evaluation.json) | Development cases reused during iteration. No claim of model superiority. |
| The console and recorded playback completed the recovery flow. | [browser-review.json](../evidence/browser-review.json) | Recorded playback does not execute a model or submit new transactions. |
| The selected public networks are reachable, but the scoped wallet has no gas. | [submission-preflight.json](../evidence/submission-preflight.json), checked 19 November. | Base Sepolia ETH and Lasna lREACT balances were both zero. |
| Deployment and setup passed read-only gas estimation. | [deployment-estimate.json](../evidence/deployment-estimate.json), checked 19 November. | Hypothetical balances and dependency code were used for estimation. No contracts were deployed. |
| A public origin event triggered a Reactive transaction and destination callback. | PENDING public loop evidence. | Local receipts and read-only RPC checks do not establish this claim. |

## Public deployment evidence

Replace each pending value with the corresponding observed value. Keep the
public operation ID identical across the model record, origin event, callback,
and payment evidence.

| Item | Network | Submission value |
| --- | --- | --- |
| Source commit | Public repository | See the immutable commit in `evidence/submission-input.json`. |
| `CommitmentInbox` address | Base Sepolia | PENDING |
| `DemoToken` address | Base Sepolia | PENDING |
| `CommitmentVault` address | Base Sepolia | PENDING |
| `CommitBookReactive` address | Reactive Lasna | PENDING |
| Model inference record and reviewed proposal | Local inference linked to public operation | PENDING |
| Operation ID | Shared across the public workflow | PENDING |
| Source request transaction | Base Sepolia | PENDING |
| Reactive reservation transaction | Reactive Lasna | PENDING |
| Destination grant callback transaction | Base Sepolia | PENDING |
| Payment transaction and exact token transfer | Base Sepolia | PENDING |
| Reactive spend reconciliation transaction | Reactive Lasna | PENDING |
| Repeated execution with no additional payment | Base Sepolia | PENDING |

The deployment command writes `evidence/testnet-deployment.json`. Model
preparation writes `evidence/testnet-ai-plan.json`. Approved execution writes
`evidence/testnet-loop.json`, including the complete proposal and its approved
digest. A completed AI public record needs `aiInference: true`, observed public
receipts, and `publicTestnetExecution: true`. A saved proposal, empty deployment
manifest, or unfunded run is not public execution evidence.

The immediate dependency is **0.01 Base Sepolia test ETH** for the scoped wallet
`0x4C4543217e66Ac3124d795785C63fa160B181C25`. The initial allocation converts
0.006 test ETH into 0.6 Lasna lREACT and retains Base test ETH for deployment and
callbacks. These are valueless test assets. The
[funding plan](submission-readiness.md#fund-the-scoped-test-wallet) records the
estimate and its exclusions. Predicted addresses in that estimate are not
deployed addresses and must not populate the public evidence table.

## Reproduction and limits

Use [the reproduction steps](submission-readiness.md#reproduce-the-local-evidence)
to install the pinned dependencies, run the contracts, run actual model
inference, and open the console. The source includes the tests and evidence.
Setup fetches the pinned model and Reactive dependency separately.

The [complete submission check](submission-readiness.md#check-the-complete-submission)
validates the published source, public receipts, AI binding, and final video. It
does not declare readiness from a local-only preview or submit the DoraHacks form.

The prototype has one owner, one immutable cap, one fixed token denomination,
all-or-nothing payments, and prefunded vaults. Suppliers and their delivery
messages are synthetic. The system does not process invoices, prove that a
merchant delivered work, bridge assets, or recover an already paid amount.

The verifier and its RPC are trusted. Source requests can be acted on before
source finality, so this prototype does not solve authorization across source
reorganizations. Delayed delivery, unavailable finality, or missing funding can
hold capacity indefinitely. The destination checks exact token balance changes.
Fee-charging and rebasing tokens are unsupported.

The demonstrated payment token has no economic value. The test recipient is the
demo owner. The work has received internal code review, not a third-party
security audit. No production security or public latency claim is made.

## Organizer sources

The [official buildathon announcement](https://blog.reactive.network/reactive-omni-buildathon-thirty-days-to-find-out-what-one-second-buys/)
defines the AI track and required submission evidence. The
[supported networks documentation](https://dev.reactive.network/origins-and-destinations)
lists Base Sepolia and Lasna. Submit through the
[DoraHacks buildathon page](https://dorahacks.io/hackathon/reactive-omni-buildathon/build).
