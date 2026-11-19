# Submission readiness

Reviewed 19 November 2026. **Not ready to submit.**

The recovered milestone contains a completed local model and EVM demonstration.
It does not contain an observed public Reactive callback loop or a final
submission video. The public source and 140-second captioned local walkthrough
are available in the repository. Preserve that distinction when
updating the entry or recording the demo.

## Published submission gates

The [organizer's announcement](https://blog.reactive.network/reactive-omni-buildathon-thirty-days-to-find-out-what-one-second-buys/)
requires a public open-source repository, deployed addresses, transaction hashes
covering the origin-to-callback loop, and a video under three minutes. Entries
without on-chain Reactive transactions and callbacks do not proceed through
judging. The AI track requires a neural network within the running system.

| Gate | Current status | Evidence needed to close it |
| --- | --- | --- |
| Runtime neural model | Local execution recorded. Public workflow linkage pending. | Preserve the actual model output, operator approval, and the matching public operation ID. |
| Public Reactive execution | Pending. | Observe the origin event, Reactive transaction, and destination callback on the selected public testnets. |
| Deployed addresses and transaction hashes | Pending. | Complete the public evidence table in [submission.md](submission.md#public-deployment-evidence) with explorer links. |
| Public open-source repository | Published at [wms2537/commitbook](https://github.com/wms2537/commitbook). The strict checker compares the immutable commit with current source. | Open the repository while signed out and confirm that the pinned source and license are readable. |
| Video under three minutes | A 140-second local preview is published. Final public proof is pending. | Record and verify a judge-accessible video using [demo-script.md](demo-script.md). |
| DoraHacks entry | Pending. | Complete the actual submission form and verify the saved entry. |

The organizer lists 5 November through 5 December 2026. The exact closing hour
and timezone remain unverified because the DoraHacks page could not be fetched.
Check the displayed deadline in the actual submission form. Do not infer the
cutoff from a third-party event listing.

Lasna is permitted for the AI track. A second destination, mainnet deployment,
model fine-tuning, a specific model accuracy, and a public live web app are not
stated requirements in the announcement. The local recovery scenario and
regression tests support the quality of this entry. They do not replace the
public execution gate.

## Existing evidence

| File | Recorded result | Scope |
| --- | --- | --- |
| [evidence/verification.json](../evidence/verification.json) | Latest local verification timestamp, source fingerprint, and test counts. The [16 November milestone](milestone-2-results.md) recorded 72 passing tests. | Use the current report after new source changes. |
| [evidence/agent-workflow.json](../evidence/agent-workflow.json) | Four actual inference calls. Final cap 100, spent 55, reserved zero, and available 45. | Actual Solidity on three local EVMs, with simulated Reactive delivery and finality. |
| [evidence/agent-evaluation.json](../evidence/agent-evaluation.json) | Model 7 correct out of 12. Rules baseline 7 out of 12. | Development regression, not an independent accuracy estimate. |
| [evidence/browser-review.json](../evidence/browser-review.json) | Local and recorded recovery playback reviewed. | Recorded mode has no live inference or transaction execution. |
| [evidence/snapshots/testnet-deployment.json](../evidence/snapshots/testnet-deployment.json) | Historical deployment preparation. | No completed public deployment or public execution. |
| [evidence/submission-preflight.json](../evidence/submission-preflight.json) | RPC connectivity, chain IDs, and nonempty service bytecode observed on 19 November. Base Sepolia ETH and Lasna lREACT balances were zero. | A network access check, not a transaction loop. |
| [evidence/deployment-estimate.json](../evidence/deployment-estimate.json) | Eight deployment, setup, and faucet transactions passed read-only estimation on 19 November. | Hypothetical balance and dependency-code overrides. Predicted addresses are not deployed contracts. |

Changes to source can invalidate old verification fingerprints. Refresh the
relevant evidence after implementation changes before building a new recorded
review or claiming that the current source has passed.

## Reproduce the local evidence

Use Node.js 22 or later, npm, Git, and network access. For actual local inference,
also install Python 3.12, uv, and a C++ compiler. Allow memory and disk space for
the 1.1 GB quantized model and its runtime.

Run the following commands at the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run setup
npm run verify
```

`verify` compiles the contracts, runs tests, executes the contract demonstration,
and writes `evidence/verification.json`, `evidence/test-output.txt`, and
`evidence/local-demo.json`. Its model-boundary tests use controlled responses.

Run actual neural inference separately:

```sh
npm run model:setup
npm run demo:agent
npm run evaluate:agent
```

The completed recovery run writes `evidence/agent-workflow.json`. Check
`aiInference: true`, `summary.passed: true`, and the final 55/0/45 budget. Read
each checkpoint for the delayed grant, dropped receipt, closure, and replacement.
The evaluation writes the actual results to `evidence/agent-evaluation.json`.
Do not replace an unsuccessful output with the expected numbers.

Open the interactive local console:

```sh
npm run dev
```

Use the URL printed by the server, normally `http://127.0.0.1:4173/`. The model
loads on the first planning request. This console uses local EVMs and does not
load the public testnet wallet. The model worker stops with the application.

After the workflow, evaluation, and current-source verification succeed, build
the recorded review:

```sh
npm run build:review
```

The output is `dist-review`. The builder checks source fingerprints and includes
recorded evidence and a sanitized source archive. That page replays existing
checkpoints. It does not run a new inference or send a transaction.

## Fund the scoped test wallet

The existing workspace uses this dedicated test address:

```text
0x4C4543217e66Ac3124d795785C63fa160B181C25
```

Fund it with **0.01 Base Sepolia test ETH on chain 84532** through a normal free
faucet or an existing testnet balance. The 19 November preflight recorded zero
Base Sepolia ETH and zero Lasna lREACT. No transaction has been broadcast from
this workflow.

The initial plan converts 0.006 Base Sepolia test ETH into 0.6 Lasna lREACT
through the [official Reactive faucet](https://dev.reactive.network/reactive-mainnet).
That leaves about 0.004 Base test ETH before deployment and other fees.

| Estimated scope | Gas | Values plus execution fee with a 20 percent gas margin |
| --- | ---: | ---: |
| Base deployment, setup, and 0.006 test ETH faucet conversion | 1,827,384 | 0.006113157166 Base Sepolia ETH |
| Lasna coordinator deployment and route setup | 2,024,693 | 0.3429632 lREACT |

These figures come from [deployment-estimate.json](../evidence/deployment-estimate.json).
The RPC estimate used hypothetical sender balances and dependency code. Actual
balances remained zero. It excludes Base L1 data fees, subsequent requests,
callbacks, cancellation, retries, and debt settlement. The 0.01 allocation gives
room above the measured deployment estimate, but it is not a guaranteed total.
The broadcaster checks each real transaction before signing.

After the Base balance arrives, use the deployment command below to perform the
conversion and continue deployment:

```sh
npm run deploy:testnet -- --broadcast --fund-lasna 0.006
```

Resume that same conversion with the same amount. The journal prevents
repeating a confirmed conversion. Do not use mainnet ETH for this testnet flow.
In a fresh checkout, create your own wallet and fund its printed address instead.

## Produce the public evidence

Use Base Sepolia for the inbox and vault, and Lasna for the coordinator. The
[official network list](https://dev.reactive.network/origins-and-destinations)
identifies both as supported test networks. Do not mix mainnet and testnet routes.

In a fresh checkout, create a dedicated test wallet:

```sh
npm run wallet:new
```

The command prints a public address and stores the key locally. Fund that
printed address through a normal Base Sepolia faucet and the documented Lasna
test-token route. See [live-access.md](live-access.md) for the network parameters
and prior funding observations. Do not assume that the historical workspace
address belongs to a fresh checkout.

Run read-only checks, replacing the address below with that wallet's address:

```sh
npm run preflight -- --address 0xYOUR_TEST_ADDRESS --networks lasna,base-sepolia --require-funded
npm run deploy:testnet -- --address 0xYOUR_TEST_ADDRESS
```

Prepare a proposal with actual neural inference. Model setup must have completed:

```sh
node scripts/live-agent.mjs --prepare --goal "Extract invoice fields privately within 120 seconds."
node scripts/live-agent.mjs
```

Preparation writes `evidence/testnet-ai-plan.json` and cannot broadcast. The
second command displays the saved proposal. Review its goal, interpretation,
approved offer, 60-unit amount, recipient, source fingerprint, and `sha256`.
An executable proposal reports `awaiting-operator-review`. A blocked proposal
requires revision. The plan expires after 24 hours and must match the current
code and catalog when starting a new request.

After funding both networks, deploy the contracts. If only Base Sepolia has
funds, use the conversion command in the preceding section instead:

```sh
npm run deploy:testnet -- --broadcast
```

`--broadcast` authorizes actual testnet transactions. Deployment writes
`evidence/testnet-deployment.json`. Require the completed deployment before
starting the public model demonstration. The selected coordinator must still
have an unused 100-unit budget.

After reviewing the proposal, replace `REVIEWED_PLAN_SHA256` below with its exact
64-character `sha256` and start the public AI loop:

```sh
node scripts/live-agent.mjs --broadcast --approve REVIEWED_PLAN_SHA256
```

The command checks deployment and live capacity before the initial request. Its
operation ID binds the coordinator address to the approved proposal digest. It
requests the approved commitment, waits for the grant, pays once, observes spend
reconciliation, and verifies that repeated execution pays nothing.

The loop writes `evidence/testnet-loop.json`. Check `aiInference: true`, the full
`publicPlan`, and `approval.digest` matching the reviewed plan. Success also
requires `status: public-testnet-loop-verified`, `publicTestnetExecution: true`,
and observed request, reservation, callback, payment, reconciliation, and replay
receipts. The expected final accounting for this 60-unit public purchase is
60 spent, zero reserved, and 40 available. The local recovery demonstration
instead ends at 55/0/45.

`npm run demo:testnet -- --broadcast` remains a separate contract-only acceptance
command. It does not run a model. Do not run that command first on the unused
coordinator intended for the AI demonstration. An existing public loop must be
preserved, and the AI workflow will refuse to replace it with a new proposal.

The live commands resume saved transactions and use bounded polling. Rerun the
same approval command to resume the same operation in the same workspace. Keep
its deployment and loop manifests with its private signed-transaction journal.
A completed public record
needs actual public receipts and `publicTestnetExecution: true`. A dry run, cached
historical result, timeout, or deployment-only record does not close the gate.

## Check the complete submission

The readiness checker uses `evidence/submission-input.json` for repository and
video metadata. Fill its values from the published source and final recording:

```json
{
	"schemaVersion": 1,
	"repository": {
		"url": "https://github.com/wms2537/commitbook",
		"commit": "REPLACE_WITH_THE_FULL_40_CHARACTER_COMMIT_SHA"
	},
	"video": {
		"path": "demo/commitbook-walkthrough.mp4",
		"url": "REPLACE_WITH_THE_DIRECT_PUBLIC_HTTPS_VIDEO_URL",
		"scope": "submission"
	}
}
```

Do not set `scope` to `submission` for a local-only preview. Use `local-preview`
until the video shows the required public execution. The final video must be
accessible through a direct public HTTPS URL, so the checker can compare its
bytes with the local recording.

Run the check after completing the public loop and publishing the materials:

```sh
node scripts/check-submission.mjs --online
```

The default report is `evidence/submission-readiness.json`. A custom metadata file
can be selected with `--metadata path`. Offline checks cannot declare the entry
ready. The online check must verify public source, canonical deployment and loop
receipts, AI proposal binding, and the public video. It also measures the local
video with `ffprobe` and requires a duration greater than zero and below 180
seconds. Passing this checker does not submit the DoraHacks form.

## Assemble the entry

1. Refresh the relevant source verification and model evidence after code changes.
2. Complete the model-linked public loop and inspect its explorer records.
3. Fill every pending public field in [submission.md](submission.md).
4. Publish the original source with its MIT license and dependency notices.
   Exclude private keys, signed transaction journals, installed dependencies, and
   model weights. Setup retrieves the pinned upstream Reactive source separately.
5. Record the final video and check its duration and signed-out accessibility.
6. Fill `evidence/submission-input.json` and run the online readiness checker.
7. Fill the DoraHacks form with the description, repository, addresses, hashes,
   and video. Confirm its deadline, required fields, and saved submission state.

Do not change the status at the top of this document until the required public
evidence and accessible submission materials exist. Keep the model's 7/12
development result, trusted verifier, synthetic suppliers, and local recovery
scope visible in the final entry.
