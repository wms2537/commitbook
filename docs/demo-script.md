# Record the CommitBook demo

Prepared 19 November 2026. Target duration: **2 minutes 50 seconds**.

This is the submission recording plan. The public deployment segment is pending.
Do not record its completion narration until the linked public evidence exists.
The [official announcement](https://blog.reactive.network/reactive-omni-buildathon-thirty-days-to-find-out-what-one-second-buys/)
requires a video under three minutes.

The 19 November [preflight](../evidence/submission-preflight.json) records zero
Base Sepolia ETH and Lasna lREACT. The immediate funding target is 0.01 Base
Sepolia test ETH for `0x4C4543217e66Ac3124d795785C63fa160B181C25`. The
[deployment estimate](../evidence/deployment-estimate.json) supports an initial
0.006 test ETH conversion into 0.6 lREACT. Complete that funding and the actual
public loop before filming. The repository at
[wms2537/commitbook](https://github.com/wms2537/commitbook) is being prepared and
still needs public-access verification.

## Prepare the recording

1. Complete the public evidence table in [submission.md](submission.md#public-deployment-evidence).
2. Open the model's actual proposal, operator approval, and matching operation ID.
3. Open the public origin, Reactive, callback, and payment explorer records in
   separate tabs. Match their addresses and operation IDs to the manifest.
4. Open the recorded local recovery console at its first checkpoint. Keep the
   label "Recorded local EVM run" visible throughout that segment.
5. Open the final model evaluation and public source repository. Use readable
   browser zoom and remove private material from the recording area.

Run the model and public loop before filming. The recording can show their
recorded results and explorer evidence. If you cut polling time, label the cut.
Do not use the edited video duration as a network latency measurement.

## Follow the timed sequence

| Time | Screen | Narration |
| --- | --- | --- |
| 0:00 to 0:17 | Project title, budget cap 100, and the purchase console. | "CommitBook gives AI purchase proposals one shared spending limit. A supplier can fail while its payment approval is still in transit. If we immediately buy a replacement, both purchases might pay. CommitBook reserves that capacity until the first operation is settled." |
| 0:17 to 0:40 | Actual model input, model identity, interpretation, and proposed approved offer. | "A local Qwen model reads the purchase goal and supplier messages. It interprets the service and preferences. Code selects an approved offer and checks the owner's policy. The model cannot choose a payment address, change the cap, or release a reservation." |
| 0:40 to 0:57 | Operator approval and the exact public operation ID. | "I review the proposal before sending it. This operation ID links the recorded model output to the public request. The payment terms come from the approved catalog. We check available budget again before execution." |
| 0:57 to 1:35 | Public origin transaction, Reactive reservation transaction, destination callback, payment, and reconciled budget. | "Here is that request on Base Sepolia. Reactive Lasna observes the event and reserves capacity. Its callback grants the vault permission to pay this recipient and amount. This transaction transfers the demo tokens once. Reactive then records the spend. These are public explorer records for the same operation. The repeated execution creates no second payment." |
| 1:35 to 2:15 | Recorded local recovery checkpoints, with local mode label visible. | "This separate recovery run uses three local EVMs and simulated Reactive delivery. A 60-unit reservation blocks a competing purchase. After a supplier outage, the model proposes a 55-unit replacement. Cancellation closes the original operation, but its first receipt is lost. The late approval cannot reopen it. Recovering the receipt still holds the budget until explicit finalization. Then the replacement pays once. We finish with 55 spent, zero reserved, and 45 available." |
| 2:15 to 2:37 | Model evaluation showing 7/12 for model and rules baseline. Show the trusted verifier note. | "The model got seven of twelve development cases right, matching our rules baseline. That is why review stays in the workflow. Suppliers are synthetic, and the closure verifier trusts its configured RPC. This prototype enforces payment authority. It does not prove service delivery." |
| 2:37 to 2:50 | Public repository, reproduction commands, and public evidence manifest. | "The public repository includes setup, tests, and transaction evidence. CommitBook holds unresolved purchases inside the budget until the operator can safely approve what comes next." |

The public segment must show the actual proposal and amount. If the model selects
a different approved offer from the rehearsal, explain the observed result. Do
not relabel the local 55-unit recovery payment as the public payment.

## Use these evidence views

| View | Source |
| --- | --- |
| Actual local model calls and recovery checkpoints | `evidence/agent-workflow.json` and the console's recorded playback. |
| Measured model and baseline decisions | `evidence/agent-evaluation.json`. |
| Public deployed addresses | `evidence/testnet-deployment.json`, after successful deployment. |
| Public loop receipts | `evidence/testnet-loop.json`, after successful execution. |
| Model proposal linked to the public operation | `evidence/testnet-ai-plan.json`, plus the matching `publicPlan` and `approval.digest` in the completed public loop. |
| Current source and reproducibility | Public repository link plus [submission-readiness.md](submission-readiness.md#reproduce-the-local-evidence). |

The recorded hosted review does not run a model or submit transactions. Label it
as playback. The local hashes do not resolve in public explorers. Only the
observed public manifest supplies public transaction links.

## Check the exported video

Play the exported file from beginning to end. Confirm that its duration stays
below 180 seconds, the text is readable, and the audio matches the shown evidence.
Confirm that the budget numbers distinguish the public purchase from the local
recovery scenario. Open the shared video while signed out before adding its URL
to the submission.

Save the final local video at `demo/commitbook-walkthrough.mp4`, or record its
actual path in `evidence/submission-input.json`. Add its direct public HTTPS URL
and set its scope to `submission` only after the public execution segment is
complete. Run `node scripts/check-submission.mjs --online` to compare the public
video with the local file and verify its measured duration. A local preview
keeps `scope: local-preview` and cannot pass final readiness.
