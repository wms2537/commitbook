# Milestone 2 results

Recorded on 16 November 2026. This milestone adds actual local neural inference,
an agent-to-contract runtime, a browser console, and a private recorded review.
The public Reactive testnet loop remains incomplete because the scoped test
wallet has no native test tokens.

## Acceptance result

The complete deterministic verification passed 72 tests with no compiler
warnings. These tests include the original 41 contract, recovery, live-script,
and finality tests, plus 16 model-boundary tests, 8 runtime EVM tests, and 7 HTTP
boundary tests. The unit tests use controlled planner outputs. They do not count
as neural inference. See `evidence/verification.json` and `evidence/test-output.txt`.

The separate actual-model workflow passed. It made four Qwen inference calls,
executed actual Solidity on three independent local EVMs, and retained 15 full
checkpoints and 15 local transaction receipts. The final token balance changes
were zero on Base and 55 on Unichain. The final budget was 55 spent, zero
reserved, and 45 available out of the fixed 100-unit cap. A repeated execution
created no additional transaction or payment.

| Checkpoint | Reserved | Spent | Available |
| --- | ---: | ---: | ---: |
| Fresh budget and two proposals | 0 | 0 | 100 |
| Reserve extraction and delay its approval | 60 | 0 | 40 |
| Competing 60-unit request blocked | 60 | 0 | 40 |
| Supplier outage, clarification, replacement held | 60 | 0 | 40 |
| Destination closed, first receipt dropped | 60 | 0 | 40 |
| Late approval rejected | 60 | 0 | 40 |
| Closure receipt recovered | 60 | 0 | 40 |
| Explicit local finalization | 0 | 0 | 100 |
| Replacement paid and repeated execution ignored | 0 | 55 | 45 |

The invariant `spent + reserved <= cap` held at every checkpoint. Observation of
closure alone did not free capacity. The destination kept its closed operation
ID when the delayed approval arrived. These are local integration observations,
not a proof of all possible interleavings or public network behavior.

The first attempt stopped safely after the supplier said its queue was offline
"until tomorrow". The model classified a temporary outage, and the deterministic
planner could not extract a reliable duration. It recommended review. That
attempt remains in `evidence/agent-workflow-v3-initial.json`.

The completed scenario includes a visible scripted operator clarification that
the supplier cannot accept the batch for the next 24 hours. A fourth actual
model call then produced the replacement proposal. No canned model answer or
hidden force-execution step was added. The purchase goal and structured policy
still require a supplier ETA of at most 120 seconds. See
`evidence/agent-workflow.json` for the full inputs, interpretations, proposal
eligibility, state transitions, and receipts.

## Model decision boundary

The local Qwen2.5-1.5B-Instruct Q4_K_M model classifies service, privacy preference,
speed versus cost preference, and supplier outcome. Ordinary code parses explicit
durations, filters eligible catalog terms, compares price and ETA, checks current
capacity, and constructs a bounded proposal. The model cannot choose an address,
invent payment terms, sign transactions, increase the cap, or finalize closure.

The runtime checks each proposal independently of any model-supplied eligibility.
It repeats the check against current state immediately before execution. A
replacement needs observed, explicitly finalized closure with zero consumption
of the prior destination permit. A later supplier clarification supersedes
earlier unexecuted recovery proposals.

A temporary outage with a wait recommendation has a separate operator action,
"Supplier ready, retry". The runtime requires explicit readiness confirmation
before retrying the original unpaid commitment. Permanent and uncertain failures
cannot use that flag. Recovery of an already paid receipt never pays again.

## What the model evaluation found

| Experiment | Correct pipeline decisions | Rules baseline | Validated model responses | Median inference |
| --- | ---: | ---: | ---: | ---: |
| Direct model offer selection, V1 | 5/12 | 10/12 | 9/12 | 12.093 s |
| Semantic interpretation with model durations, V2 | 6/12 | 7/12 | 9/12 | 9.645 s |
| Narrow semantic router, initial V3 | 7/12 | 7/12 | 12/12 | 7.890 s |
| Final V3 source verification run | 7/12 | 7/12 | 12/12 | 10.499 s |

V1 used a different dataset. V2 used fresh cases; its failures informed V3, so
V3 is a development regression on reused cases. The final run executed alongside
other local work, making its timing a shared-host observation. It is not an
isolated throughput benchmark. Every response and failure remains in the
corresponding `evidence/agent-evaluation*.json` files.

The remaining errors matter. Three cost-sensitive requests received more
expensive offers. A request for certified translation was mistaken for invoice
extraction. Permanent service withdrawal caused conservative escalation after
the model classified it as temporary. The model also repeated malicious supplier
instructions inside an explanation, even though typed validation and the
closure gate prevented those instructions from gaining authority.

The current model therefore belongs in a reviewed proposal workflow. This
evaluation does not support unattended purchases or a claim that the model
outperforms the rules baseline. Hard requirements should also be entered as
structured policy. The interface labels explanations as unverified text.

Review found and fixed compact-duration parsing errors, including `5s`, and a
word-boundary regression involving ordinary words such as `as` and `am`. Unknown
timing formats such as milliseconds now require review instead of silently
deferring to a looser structured limit. The parser remains limited, as documented
in `docs/model.md`.

## Reproducibility and interface

The CLI workflow and browser-triggered recovery flow both reached the expected
55/0/45 accounting. The interface shows current policy eligibility, reservations,
model metadata, immutable operation IDs, recovery actions, and expandable local
receipts. Local receipt hashes are not presented as public explorer links.

Browser review also exercised recorded playback through its last checkpoint and
downloaded the evidence export. The export retained four inference calls, all
15 checkpoints, and the expected budget. Planning stayed disabled in recorded
mode. At an actual 390 by 844 CSS-pixel child viewport, the layout and expanded
receipt table had no horizontal overflow. This is responsive browser testing,
not a physical phone test. See `evidence/browser-review.json`.

A clean, isolated `npm ci` verified the pinned JavaScript dependencies, followed
by successful imports and a Ganache provider lifecycle. The native uWS binary
does not match Node 24 here; Ganache's JavaScript transport fallback worked.

Source fingerprints bind the model evaluation to its planner and inference
inputs and bind the workflow to its model, runtime, contracts, and fixture.
The recorded-review builder also checks the full verification source digest and
requires a complete actual-model evaluation. It refuses stale records. The
downloadable source includes setup scripts, tests, documentation, and evidence.
It excludes private keys, signed transaction journals, model weights, installed
dependencies, and upstream Reactive SDK source.

The hosted page plays recorded checkpoints. It does not execute inference or
submit transactions. Full execution runs in the local Node application with its
Python child model worker. The hosted page and local application use the same
interface source.

## Remaining external gate

The read-only preflight at 02:25:31 UTC on 16 November 2026 reached Reactive Lasna,
Base Sepolia, and Unichain Sepolia, checked chain IDs and expected service bytecode,
and found zero native balance for the scoped wallet on all three networks.
See `evidence/milestone-2-preflight.json`.

Next, fund the isolated wallet with testnet gas and run the resumable public
request, Reactive callback, destination payment, and receipt reconciliation flow.
Only those observed public transactions can establish that external gate. This
milestone does not demonstrate real supplier invoice processing, public-chain
finality, a production security audit, or hackathon eligibility.
