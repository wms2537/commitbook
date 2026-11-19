# CommitBook

Public source: [wms2537/commitbook](https://github.com/wms2537/commitbook).
Submission draft: [Reactive Meets AI](docs/submission.md).
Current gates and reproduction steps: [submission readiness](docs/submission-readiness.md).

CommitBook coordinates a fixed spending budget across prefunded EVM vaults. A
request reserves capacity on Reactive before any destination receives permission
to pay. A cancellation permanently disables its operation ID at the destination.
Unused capacity returns only after the closure is observed and explicitly
verified against finalized destination state.

Milestone 2 adds a local language model, a policy-constrained procurement runtime,
and a browser console. The model interprets the goal and supplier message. Code
selects an approved offer, resolves its immutable terms, and rechecks spending
authority before execution. The console presents proposals for review.

Both demonstrations execute real Solidity bytecode on three independent Ganache
EVMs. Reactive transport and finality in these demonstrations are test substitutes.
The project has not completed a public testnet loop. The hosted review replays
recorded local execution; it does not run a model or submit transactions.

The submission build adds a separate public AI runner. It performs actual local
inference, freezes the proposal and approved catalog terms, and requires approval
of that exact SHA-256 digest before the public request. The operation ID binds
that plan to the deployed Reactive coordinator. Changed terms, code, approval or
operation binding refuse execution. A valid plan alone is not public chain proof.

## Run the verified local flow

Requires Node.js 22 or later, npm, Git, and network access for dependencies.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run setup
npm run verify
```

`setup` checks out the official Reactive Omni dependency at the pinned revision
and refuses to use a modified checkout. `verify` compiles the contracts, runs all
tests, runs the demonstration, and writes reproducible evidence under `evidence`.
Its unit and integration tests use controlled planner responses. Actual neural
inference is evaluated and demonstrated by the separate commands below.

## Run the agent console

Model setup additionally requires Python 3.12, uv, and a C++ compiler. It downloads
the pinned official Qwen2.5-1.5B-Instruct Q4_K_M model, verifies its SHA-256, and
builds llama-cpp-python 0.3.19. Allow disk and memory for the 1.1 GB model, runtime,
and inference context. Model weights are not included in this source archive.

```sh
npm run model:setup
npm run demo:agent
npm run evaluate:agent
npm run dev
```

Open the local URL printed by `dev`, normally `http://127.0.0.1:4173/`. The model
loads on the first planning request. A persistent Python child worker handles
inference and closes when the application stops. No cloud model account or key
is needed. A failed model call reports an error; it never substitutes a scripted
answer. Optional compatible HTTP provider configuration is documented in
`docs/model.md`.

The console can plan a purchase, execute an approved proposal, delay its grant,
drop a receipt, report supplier failure, close the original commitment, recover
the receipt, finalize closure, and execute the replacement. Only actions valid
for the current server-owned state are enabled. Reset creates new local EVMs and
invalidates old session IDs. No action in this console uses the public testnet
wallet.

The recovery demo makes actual model calls for both purchase goals and supplier
recovery. If the initial outage description requires review, the scripted
operator clarifies its duration and the model replans. It reserves 60 for private
extraction, blocks a competing 60-unit verification request, proposes a 55-unit
replacement after supplier failure, and holds that replacement until closure is
observed and explicitly finalized. A late approval cannot reopen the cancelled
operation. Final spending is 55, reserved capacity is zero, and 45 remains
available. Repeating execution creates no new payment. The scenario checks real
token balances and writes `evidence/agent-workflow.json` with full state snapshots.

After the actual workflow, model evaluation, and source verification pass, build
a static recorded review with `npm run build:review`. The default output is
`dist-review`. Pass a separate output directory after `--` when needed. The
builder checks that the verified source digest still matches, copies the actual
evidence, and adds a sanitized source ZIP. It does not bundle the model or expose
the local mutation API.

Language interpretation remains experimental. Review the proposed service and
offer before execution, and enter hard requirements in the structured policy
fields. The evidence retains unsuccessful model experiments and compares the
final development cases with an explicit rules baseline. It does not establish
production reliability or general superiority over rules.

For a shorter rerun:

```sh
npm test
npm run demo
```

Ganache can print a native uWS compatibility warning on Node 24 and fall back to
its JavaScript transport. The EVM assertions still execute. The evidence reports
local execution, never public network performance.

## What the original contract demo proves

The cap is 100 token units. A request reserves 60 on Base. Another request for 60
on Unichain cannot proceed while the first reservation is outstanding. The first
request is cancelled before its delayed grant arrives. Its destination stays
closed when that grant finally arrives. Observing the closure keeps the 60
reserved. Explicit finalization releases it. A new 60-unit request on Unichain
then executes, and repeated execution or receipt delivery cannot pay again.

The final result is 60 spent, zero reserved, and 40 available. The demo writes
transaction evidence to `evidence/local-demo.json`. These hashes belong to local
EVMs and cannot be looked up in public explorers.

Recovery tests also drop the first closure or payment receipt. An authenticated
retry republishes the recorded outcome without changing the destination payment.

## Project map

| Path | Responsibility |
| --- | --- |
| `contracts/CommitmentInbox.sol` | Owner and agent authorization, approved suppliers, immutable requests and cancellation events. |
| `contracts/CommitBookReactive.sol` | Authenticated source events, reservations, callback requests, receipt observation, and finalizer authorization. |
| `contracts/core/BudgetLedger.sol` | Budget accounting and commitment transitions. |
| `contracts/CommitmentVault.sol` | Callback proxy and Reactive sender authentication, including receipt republication. |
| `contracts/core/CommitmentVaultCore.sol` | Immutable permits, permanent closure, and exact token transfers. |
| `contracts/DemoToken.sol` | Public testnet demonstration token with unrestricted minting. It has no economic value. |
| `contracts/test` | Local transport and token failure substitutes. |
| `test` | Actual EVM behavior tests and mocked RPC finality checks. |
| `agent` | Actual model adapter, constrained interpretation, offer selection, and proposal validation. |
| `app/runtime.mjs` | Server-owned session, policy, operations, contract calls, and receipt recovery. |
| `app/public` | Browser console and recorded review interface. |
| `app/scenario.mjs` | Actual inference plus deterministic local recovery acceptance flow. |
| `scripts/setup-model.py` | Pinned model download, hash verification, and CPU runtime installation. |
| `scripts/evaluate-agent.mjs` | Recorded model and baseline evaluation with no silent fallback. |
| `scripts/demo-agent.mjs` | Actual inference and EVM workflow evidence. |
| `scripts/deploy-testnet.mjs` | Resumable deployment on Base Sepolia and Reactive Lasna. |
| `scripts/live-loop.mjs` | Observe a real request, grant, payment, and receipt reconciliation after deployment. |
| `scripts/live-agent.mjs` | Bind an actual model proposal and its explicit approval to that public operation. |
| `scripts/check-submission.mjs` | Check the public source, AI plan, transaction trace and video before declaring readiness. |
| `scripts/verify-closure.mjs` | Check canonical finalized destination closure before authorized release. |
| `docs/design.md` | Invariant, transitions, recovery, and trust assumptions. |
| `docs/live-access.md` | Verified network parameters and observed funding blockers. |
| `evidence/verification.json` | Last compilation, tests, source digest, and demo result. |
| `evidence/agent-workflow.json` | Actual model calls, local receipts, and full recovery checkpoints. |
| `evidence/agent-evaluation.json` | Latest development evaluation, inputs, model interpretations, and failures. |
| `evidence/milestone-1` | Preserved original milestone verification and contract demonstration. |

## Public testnet continuation

The smallest live deployment uses Base Sepolia for both the request inbox and
payment vault, with Reactive Lasna between them. Unichain is exercised locally;
a second public destination is a later step.

The disposable address prepared in the development workspace is
`0x4C4543217e66Ac3124d795785C63fa160B181C25`. Its private key is excluded from this
archive. The recorded access check found no native test tokens on the selected
networks. It did verify RPC connectivity, chain IDs, and service bytecode.
Saved deployment observations are under `evidence/snapshots`. They do not become
an active deployment manifest in a fresh checkout.

For a fresh checkout, create an isolated wallet, or provide an existing isolated
test key through `COMMITBOOK_TESTNET_PRIVATE_KEY`:

```sh
npm run wallet:new
```

The command prints only the new public address. It stores its key in
`.secrets/testnet-wallet.json` with owner-only permissions and never replaces an
existing wallet. This generated address differs from the address above. Fund
the address printed by your own command if running a fresh checkout.

Read-only checks need only a public address:

```sh
npm run preflight -- --address 0xYOUR_TEST_ADDRESS --networks lasna,base-sepolia --require-funded
npm run deploy:testnet -- --address 0xYOUR_TEST_ADDRESS
```

Obtain free Base Sepolia test ETH through a normal supported faucet. The official
Reactive faucet can convert part of that test ETH to Lasna lREACT. The deployment
CLI has an explicit `--fund-lasna` option for this testnet conversion. Its amount
is in Base Sepolia ETH and is limited to 0.02 per invocation. See
`docs/live-access.md` for the documented conversion and provider constraints.
For example, `--broadcast --fund-lasna 0.006` converts 0.006 Base test ETH into
0.6 lREACT before attempting deployment. Keep additional Base test ETH for Base
deployment and callback fees. This is a planning allocation, not a measured
deployment quote. Resume a recorded conversion with the same amount. If more
lREACT is needed, make an additional top-up through the official faucet.

The deployment defaults to read-only checks. After funding the selected wallet,
the following commands authorize real **testnet** transactions:

```sh
npm run deploy:testnet -- --broadcast
npm run agent:testnet -- --prepare --goal "Extract invoice fields privately within 120 seconds."
npm run agent:testnet
# Review the saved proposal, then use its exact digest:
npm run agent:testnet -- --broadcast --approve REVIEWED_PLAN_SHA256
```

Prepare the model with `npm run model:setup` first. Proposal preparation is also
possible before funding. Plans expire after 24 hours. If an unsigned plan expires,
prepare and review a new one. Resuming a previously signed request keeps its
original operation and terms. Never copy another operator's active plan into your
workspace. Published plans are historical snapshots under `evidence/snapshots`.

`npm run demo:testnet -- --broadcast` remains the fixed contract-only test. It does
not run a model, and cannot count as evidence of AI integration. Use a fresh
coordinator for the public AI demo. Both commands preserve confirmed transactions
on retries.

The script checks the chain IDs before any signing. Its manifest records pending
transaction hashes and completed deployments so a rerun can resume. It deploys
the inbox, coordinator, demonstration token and vault, funds the contracts,
mints demonstration inventory, configures the route, and authorizes the demo
supplier. The demo supplier is the owner address. It demonstrates contract
payment behavior, not an external merchant sale.

Deployment, live-loop broadcasts, and finalization share an exclusive workflow
lock. Keep the active public manifests and private signed-transaction journal
together when resuming in the same workspace. If a process crashes, confirm it
has stopped before removing its stale `.secrets/live-workflow.lock`. An
insufficient balance does not block recovery of an already confirmed receipt.
Incomplete deployment or loop runs return exit code 2; invalid or failed checks
return exit code 1.

The live runner polls in bounded stages and can be rerun with the same operation
ID. A completed public loop must contain actual observed public transaction
hashes. A dry run or unfunded run does not count as completion.

To verify a pending cancellation after deployment:

```sh
npm run verify:closure -- --coordinator 0xCOORDINATOR --operation 0xOPERATION_ID
npm run verify:closure -- --coordinator 0xCOORDINATOR --operation 0xOPERATION_ID --broadcast
```

The first command reads only. The second also requires the configured finality
verifier's key. Unsupported finality queries, mismatched evidence, or an open
destination permit refuse release. This script trusts the selected RPC and the
configured verifier. It is not a cryptographic finality proof.

RPC overrides are `LASNA_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, and
`UNICHAIN_SEPOLIA_RPC_URL`. Scripts do not load `.env` automatically.

## Scope and remaining milestones

This version has one owner, one immutable cap, one fixed token denomination,
all-or-nothing payments, and prefunded vaults. It does not bridge assets or prove
that a supplier delivered a service. A valid permit can be executed by anyone,
but only to its fixed recipient for its fixed amount.

The remaining external acceptance gate is an observed public request-to-callback
loop. The scoped wallet still needs testnet gas. Local model inference and local
contract execution do not establish public Reactive delivery, public finality,
or hackathon track eligibility. Supplier execution is also a demonstration:
the catalog describes synthetic services and the vault pays a local test
recipient. It does not extract invoices or verify a merchant's work.

The root MIT license covers original CommitBook source. The pinned upstream
Reactive dependency has separate licensing constraints and is retrieved by setup
instead of bundled. See `THIRD_PARTY.md`.
