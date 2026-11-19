# Runtime model and decision boundary

CommitBook uses an actual local language model to interpret a purchase goal and
supplier messages. Deterministic code turns that interpretation into a typed
offer recommendation, resolves authoritative terms, and checks policy again
before any contract action. This milestone produces proposals for operator
review. Its measured decision quality does not support unattended purchasing.

## Reproduce inference

The runtime uses Qwen2.5-1.5B-Instruct, quantized as Q4_K_M, through
llama-cpp-python. The publisher's model repository identifies the model as 1.54
billion parameters and Apache 2.0 licensed. No training or fine-tuning is performed.
Sources: [official model card](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF)
and [official runtime documentation](https://github.com/abetlen/llama-cpp-python).

Requires Python 3.12, uv, a C++ compiler, and enough memory for the 1.1 GB model
plus its runtime and context. Setup builds the runtime against the host C library
and uses four compilation threads. The generic Linux CPU wheels checked in this
environment required musl, so they could not load on this glibc host.

```sh
python3 scripts/setup-model.py
node scripts/evaluate-agent.mjs
```

The planner automatically starts a persistent Python child process for local
inference. Requests and responses use process-owned stdin and stdout. This avoids
separate network listeners and works when executor calls have isolated loopback
networks. The application closes the worker on shutdown.

An optional compatible HTTP server remains available for ordinary environments:

```sh
python3 scripts/serve-model.py
# In a second terminal in the same network environment:
COMMITBOOK_LLM_URL=http://127.0.0.1:8081/v1/chat/completions node scripts/evaluate-agent.mjs
```

The server uses four CPU threads, a 4,096-token context and the ChatML template.
The planner requests at most 256 output tokens, deterministic decoding, and a
schema-constrained JSON object. Each request has a 60-second deadline. It does
not silently fall back to a scripted plan when inference fails.

The model is fetched from official repository revision
`91cad51170dc346986eccefdc2dd33a9da36ead9`.

| Property | Pinned value |
| --- | --- |
| File | `qwen2.5-1.5b-instruct-q4_k_m.gguf` |
| File size | 1,117,320,736 bytes |
| SHA-256 | `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e` |
| Runtime | `llama-cpp-python 0.3.19` |
| Runtime model alias | `commitbook-qwen2.5-1.5b` |

Setup verifies the publisher's SHA-256 before accepting the model file. The model
weights and Python environment stay in ignored local directories and are not
bundled in the source deliverable. Python dependencies are pinned in
`agent/model-requirements.txt`.

## Provider adapter

`planPurchase` defaults to the local child worker. An explicitly configured compatible
provider can use `COMMITBOOK_LLM_URL`, `COMMITBOOK_LLM_MODEL`, and
`COMMITBOOK_LLM_API_KEY`. Nonlocal endpoints must use HTTPS. Credentials go only
in the authorization header and never into prompts or evidence. Scripts do not
search for unrelated credentials.

The planner's public recommendation has only these fields:

```json
{"action":"purchase","offerId":"an-authorized-offer-id","reason":"A short explanation."}
```

Actions are `purchase`, `replace`, `wait`, or `escalate`. The current planner,
`semantic-router-v3`, asks the neural model for an intermediate interpretation:

| Field | Allowed values |
| --- | --- |
| `service` | A service ID in the supplied catalog, or `unknown` |
| `privacy` | `private` or `any` |
| `priority` | `lowest-cost` or `fastest` |
| `failureType` | `none`, `temporary`, `permanent`, `uncertain`, or `already-completed` |
| `reason` | A nonempty string of at most 200 characters |

The model classifies the requested capability and supplier outcome. Code parses
explicit duration phrases, converts units, filters approved offers, and applies
all price, deadline, capacity, and ranking calculations. Structured price and
balance fields are not forwarded to the model. Catalog descriptions and supplier
messages remain untrusted prose and may themselves mention numbers.

The model cannot specify addresses, amounts, arbitrary calldata, a new budget,
an offer ID, or a finalization action. Its prompt contains the user's goal,
supported service labels, workflow phase, and supplier message. It excludes
recipient addresses and signing material.

The server validates both the intermediate interpretation and the resulting
proposal. Unknown fields and unsupported interpretations fail closed. The
deterministic selector intersects semantic preferences with owner policy; the
model cannot loosen that policy. The final proposal validator rejects unknown
offers, unauthorized chains, unavailable offers, per-purchase violations, and
structured service, privacy or deadline violations. Model reasons are untrusted
display text. A valid schema and an affordable offer do not establish that the
model understood the user's request.

Duration parsing supports numeric quantities, common English number words,
halves and quarters, with seconds, minutes, or hours, up to 24 hours. Compact
forms such as `5s`, `1min`, and `0.5h` are accepted. The goal
supplies the requested deadline; the supplier message supplies the interruption
duration. If several durations occur in one input, the parser takes the smallest.
It does not understand calendar dates, relative dates such as "tomorrow", or the
role of every number in a sentence. Recognizable timing requirements without a
supported explicit duration require review even when a structured owner ceiling
exists. Unsupported units such as milliseconds also require review, including
when the goal contains another supported duration. A structured ceiling cannot
silently replace a tighter, unparsed prose deadline. A temporary failure with
an explicit deadline but no usable delay also requires review. Hard deadlines
belong in `policy.maxEtaSeconds`.

A replacement recommendation is blocked until the executor observes finalized
closure of the previous operation. Only server-owned state may set
`context.priorClosureFinalized`. Supplier prose and model output cannot set it.
After closure, the executor must revalidate the recommendation against current
capacity. A proposal that fit a previous snapshot can become unaffordable.

`planPurchase` returns the proposal, its current authorization result, the
intermediate interpretation, and inference metadata. Metadata includes the
provider, model alias, planner version, duration, token counts, and a prompt
digest. `authorization.executable` describes policy eligibility in that snapshot;
it is not an instruction to bypass the operator review step. `validateProposal`
is also callable independently so the executor can check stored proposals again.

## Evaluation and redesign

All four reported runs used actual local CPU inference. The reports preserve
unsuccessful decisions as well as successful ones.

| Version and evaluation role | Correct decisions | Simple baseline | Validated responses | Median request |
| --- | --- | --- | --- | --- |
| V1, direct offer selection, original development set | 5/12 | 10/12 | 9/12 | 12,093 ms |
| V2, semantic interpretation, fresh holdout at that revision | 6/12 | 7/12 | 9/12 | 9,645 ms |
| V3 initial, the same V2 cases reused as development regression | 7/12 | 7/12 | 12/12 | 7,890 ms |
| V3 final, repeated after deterministic parser review with source fingerprints | 7/12 | 7/12 | 12/12 | 10,499 ms |

Version 1 asked the model to choose the offer directly. It made avoidable price
and budget mistakes; deterministic validation rejected three outputs. Those
results and the original prompt are retained in
`evidence/agent-evaluation-v1.json`.

Version 2 moved catalog selection and arithmetic into code, while asking the
model to extract semantic preferences and duration values with units. Three
responses had invalid duration interpretations, and other responses confused
supplier delays with user deadlines. Its full results are retained in
`evidence/agent-evaluation-v2.json`.

Version 3 removes duration extraction from the neural schema and uses the
explicit parser described above. It also shortens the classification output.
The initial V3 report is preserved in
`evidence/agent-evaluation-v3-initial.json`. All 12 responses passed validation.
Seven decisions matched the expected action and offer, equal to the unchanged
baseline's seven. The median request took 7,890 milliseconds.

A subsequent deterministic parser review added compact units and rejected
unresolved timing requirements even when a structured owner ceiling exists.
The model prompt and schema did not change. All 12 interpretations from the
preserved initial V3 report were replayed through the revised resolver and
validator, with the same final actions and offer IDs.
`evidence/agent-duration-review.json` records that replay, its initial source
report, and the revised resolver's source digest. This replay did not run new
inference.

The final evaluation then performed 12 new model inferences on the same cases.
It again produced 12 valid responses and seven correct decisions against seven
for the baseline. Both V3 runs used 3,359 input tokens and 543 output tokens. The
final median request took 10,499 milliseconds. That run shared the host with the
application workflow and tests, so its timing is a shared-host measurement,
not isolated model latency. The timing difference is not evidence of a parser
performance effect or a cross-chain latency guarantee.

The twelve synthetic scenarios in `agent/evaluation-cases.mjs` were fixed before
version 2 inference. They cover cost, dedicated workers, a deadline in minutes,
verification versus extraction, explicit permission for shared workers,
unsupported translation, unavailable offers, held capacity, permanent supplier
failure, maintenance, prompt injection, and ambiguous completion. V2's observed
errors informed V3, so both V3 runs use a development regression suite, not an
untouched holdout. V1 used a different case set, so its score is not directly
comparable to the later scores. No customer data is included.

Five V3 decisions were wrong:

- Two cost-sensitive goals and a goal explicitly accepting shared processing
  received the faster, more expensive offer. The model incorrectly preferred
  speed and, in two cases, added a private-processing preference.
- A request for certified translation was interpreted as invoice extraction.
  The resulting purchase was within budget and still wrong for the task.
- Permanent service withdrawal was classified as temporary. The router
  escalated because it had no reliable interruption duration.

The prompt-injection case retained an approved replacement and the finalized
closure requirement. However, the model repeated the malicious instructions in
its reason string. This test demonstrates that those instructions did not change
the tested spending boundary. It does not establish general prompt-injection
resistance or trustworthy model explanations.

The comparator is an explicit keyword and price baseline. It recognizes direct
privacy and urgency words, structured owner constraints, and common transient or
ambiguous failure markers. It can be improved. The comparison does not establish
that language models generally outperform a carefully engineered rules engine.

The final report, `evidence/agent-evaluation.json`, records every input, expected decision, actual
model interpretation and resulting recommendation, baseline recommendation,
rejection, duration, and token count. The `modelCorrect` field measures the whole
neural-interpretation and deterministic-selection pipeline. It also records a
digest of the fixed case set and per-inference prompt digests. Its `source`
metadata binds the final run to the SHA-256 fingerprint of the listed agent,
evaluation, model-worker, setup, and fingerprint implementation paths. The final
source fingerprint is
`6adf10b70ead714127bbe388065b9aa1efd9ac20c59e5c58e813549c68acdef0`.
Failed or rejected model responses count as
incorrect; they are not omitted. Separate negative checks
try unknown offers, extra payment fields, and a privileged finalization action.
All three of those negative checks rejected the request. Sixteen unit tests
cover the adapter, parsing, semantic validation, and proposal boundary. Their
mocked provider responses test integration behavior; the evaluation reports
provide the separate evidence of actual inference.

Twelve developer-authored cases cannot estimate production reliability. The
observed results do not show an advantage over this simple baseline. Supplier ETA
is an offer term, not a guarantee of end-to-end completion across chain finality
and network delivery. Natural-language preferences are interpreted by the model;
hard requirements should also appear in structured owner policy. The
deterministic policy and contracts remain the spending boundary even if the
model misunderstands a sentence. Operator review remains necessary because that
boundary cannot prove that an approved service is the service the user wanted.
