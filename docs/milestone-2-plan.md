# Milestone 2 plan

Build a working agent procurement flow over the verified commitment contracts.
Public testnet execution remains a separate gate while the task wallet has no
test tokens. The model, local EVM, and recorded interface must report their
execution modes accurately.

## Acceptance criteria

1. Run a real neural model on a CPU without requiring a paid API key. Record the
   exact model, inference metadata, and outcome. Do not count fixture responses
   as inference.
2. Convert a purchase goal and supplier failure message into a bounded typed
   proposal. Authoritative server data determines addresses, amounts, chain IDs,
   and permitted services. Recheck the proposal against current state before
   execution.
3. Use authorized agent signers for requests. Demonstrate stale competing plans,
   cancellation before a delayed approval, a missing closure receipt, and a
   replacement that waits for explicit closure finalization.
4. Provide a responsive interface with visible reserved, spent, and available
   budget, model decisions, commitment state, and transaction evidence. A
   recorded review must never imply it is running a new model or chain action.
5. Evaluate the model on fixed held-out cases and compare it with a simple rules
   baseline. Report semantic errors and refusal rates without claiming a small
   synthetic evaluation establishes general model quality.
6. Preserve all previous contract tests, add meaningful runtime and HTTP boundary
   tests, review the diff, and save the verified deliverable.

## Scope

The local application uses prefunded demonstration vaults and simulated Reactive
transport over three actual EVM instances. It uses one immutable 100-unit cap,
approved supplier offers, and all-or-nothing purchases. The initial application
is digital invoice extraction and independent verification. Supplier availability
messages are synthetic demonstration inputs, not real merchant confirmations.

The local server never loads the public testnet wallet. Owner recovery and the
trusted local finalizer are explicit deterministic runtime actions. Model text
cannot supply calldata or replace receipt verification. A paid operation cannot
be refunded or replaced automatically.

The hosted review is private and uses recorded evidence. Full inference and
transaction execution run locally. A live public Reactive loop and a public
competition submission remain future gates until funding and evidence exist.
