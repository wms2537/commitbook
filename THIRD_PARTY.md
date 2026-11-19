# Third-party dependencies

The root MIT license applies to original CommitBook code. Dependencies retain
their own licenses and notices.

Reactive Omni integration imports the official Reactive-Network/reactive-lib-omni
repository at commit `3ade0dcf1d27e67e5783ef807e73a1b9e0c0cce8`.

- Source: https://github.com/Reactive-Network/reactive-lib-omni
- API documentation: https://dev.reactive.network/reactive-contracts
- Callback documentation: https://dev.reactive.network/callback-contracts
- Its Solidity files currently declare `SPDX-License-Identifier: UNLICENSED`.
  CommitBook does not relicense that dependency or include its source in the
  deliverable archive. The setup script retrieves the pinned source separately.
  Clarify upstream redistribution terms before any bundled public release.

JavaScript dependency versions and integrity hashes are pinned in package-lock.json.
The installed packages supply their own notices. Node modules are excluded from
the deliverable archive. Ganache can use its JavaScript transport fallback on Node
versions without a matching native uWS binary; this changes transport performance,
not the EVM assertions. No measured latency in the local demo represents a public
Reactive network benchmark.

The optional local model is the official Qwen/Qwen2.5-1.5B-Instruct-GGUF Q4_K_M
file at revision `91cad51170dc346986eccefdc2dd33a9da36ead9`. Its publisher lists
Apache 2.0. Setup retrieves it separately and verifies its pinned SHA-256.
Model weights are not bundled or relicensed by CommitBook.

- Model card: https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF
- Inference runtime: https://github.com/abetlen/llama-cpp-python
- The runtime repository lists the MIT license. CommitBook pins version 0.3.19
  and excludes its Python environment and native binaries from this archive.
- Python dependency versions are recorded in `agent/model-requirements.txt`.

The browser interface uses original HTML, CSS, and JavaScript with system fonts.
It has no third-party images, remote scripts, or remote font dependencies.
