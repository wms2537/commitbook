# CommitBook: recoverable spending commitments for AI agents

**Track:** Reactive Meets AI  
**Event:** Reactive Omni Buildathon, 5 November to 5 December 2026  
**Repository:** https://github.com/wms2537/commitbook  
**Demo:** `demo/commitbook-public-submission.mp4` (2 minutes 51.6 seconds, silent/captioned, after publication)

## Short description

CommitBook prevents parallel AI agents from overspending one shared budget across independent EVM chains. A neural model interprets a purchase goal, an operator approves exact terms, and a Reactive contract reserves budget before issuing a destination grant. Destination receipts reconcile spending. Late or duplicated execution cannot transfer the same tokens again.

## What we built

An AI procurement worker receives a goal and an approved supplier catalog. A local Qwen2.5-1.5B-Instruct model interprets service, privacy, and priority. Deterministic policy code selects a permitted offer and limits spending. The neural output cannot choose an arbitrary recipient, budget, or calldata. The operator must approve a recorded SHA-256 digest.

On Base Sepolia, `CommitmentInbox` authenticates the request and emits its immutable payment terms. `CommitBookReactive` on Reactive Lasna receives the origin event, reserves the shared spending authority, and requests a callback to a prefunded `CommitmentVault` on Base Sepolia. The vault accepts an authenticated grant and transfers the fixed amount once. Its spend event returns to Lasna, where the reservation is converted into settled spending.

A separate *local* recovery demonstration uses independent EVMs on Base and Unichain with simulated Reactive event delivery and finality. It exercises two competing requests, failed supplier recovery, delayed grants, missing receipts, permanent cancellation, and duplicate execution. A 100-unit cap ends with 55 spent, zero reserved, and 45 available in this separate local scenario.

## Public evidence on 20 November 2026

The *public* AI run used real Base Sepolia and Reactive Lasna transactions with one operator-approved purchase for 60 valueless `CBDEMO` tokens. The model's recorded inference took 12.477 seconds. The agent proposal was bound to operation ID `0xba066f118ebed561cdaf297cb72d2c7c3d402b5166a77c18b46db040e5e6df98` and approval digest `26a344a29468703a530139b5e0e34edaf63022bb5a4c1005233a6cee96c73e91`.

The public result is **100 cap, 60 spent, 0 reserved, 40 available**. An execution replay generated a successful transaction but no additional ERC-20 transfer.

### Deployed contracts

| Contract | Network | Address |
|---|---|---|
| CommitmentInbox | Base Sepolia (84532) | `0xb31C9c6149116D7E56Ca32833d337890fd903c82` |
| CommitBookReactive | Lasna (5318007) | `0x12950907D33C85979C988a200F161CeD56150FEf` |
| DemoToken | Base Sepolia (84532) | `0xEf74Da6aB2f6Fae2601F08bb75565940B1D02688` |
| CommitmentVault | Base Sepolia (84532) | `0xe09f5FF8fce8Cb176AEb0d7fB0aDf493Af78A579` |

### Origin-to-callback-to-payment receipts

1. [Base Sepolia source request](https://base-sepolia.blockscout.com/tx/0xba31877bd975a16f0cfdf2e1997bb9b9e36343800eab312c051014cc347fb51c), block 61204381.
2. [Lasna Reactive reservation](https://lasna.reactscan.net/tx/0x83a9dabcdb3e78aeab8caaa7e46f557f519e020d04fe0d74a3aea397a4178a4c), block 8797188.
3. [Base Sepolia authenticated destination grant](https://base-sepolia.blockscout.com/tx/0x651755048693d2ce2a52b186e57f20487df78323883c911dd449c5f67f62bc75), block 61204385.
4. [Base Sepolia vault execution, 60 CBDEMO transferred](https://base-sepolia.blockscout.com/tx/0xa6f3eac42f9e15ad3404dfbb293448883c47545a93a9eccfd299573fed3d1e17), block 61204436.
5. [Lasna Reactive spend observation](https://lasna.reactscan.net/tx/0x9bddeb2728382edaeb4ef669696d6368b4075fc4bf6c317a50f68f95f09d40d1), block 8797199.
6. [Base Sepolia execution replay, zero new token transfers](https://base-sepolia.blockscout.com/tx/0xa4e80a9cbdd4c557eea196d2cdbcb373c3c77f506a4c1f473e340cb841b3ae92), block 61204471.

Full receipt manifests: `evidence/public/deployment.json` and `evidence/public/ai-loop.json`. The Lasna explorer renders some application-specific events as raw logs. The `CommitmentReserved` and `SpendRecorded` event names were decoded against the contracts' ABI in the recorded execution harness.

## Why Reactive is needed

The hard problem is asynchronous authorization, not simply choosing a provider. Spending authority must remain counted while an event travels between chains. Reactive observes independently executing source and destination contracts, issues the grant after reserving capacity, and reconciles actual destination outcomes from receipt events. A trusted off-chain worker cannot simply report its own success or release reserved funds on a timeout.

The safety invariant is `settled_spend + outstanding_reservations <= budget_cap`.

## Scope and limitations

- The token and suppliers are **synthetic**. No invoice-processing service was delivered, and no customer or actual financial assets were involved.
- The real public demonstration uses Base Sepolia for both request and destination, with Lasna in between. The separate Unichain scenario is a local simulation.
- The model is fallible. In the recorded 12-case *development* evaluation, the model and a rules baseline each selected 7 correctly. Operator approval and deterministic constraints are therefore deliberate requirements.
- The owner-authorized finality verifier and configured RPCs are trusted; the project does not implement cryptographic finality proofs or handle arbitrary chain reorganizations.
- Contracts have local regression tests but no third-party security audit. The project is a demonstration, not a custody product or deployable financial service.
- Original code is MIT licensed. The pinned upstream Reactive SDK has separate source license terms; it is retrieved by setup rather than copied into the repository.

## Reproduce

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run setup
npm run verify
python3 scripts/setup-model.py
npm run agent:testnet           # inspect the historical AI proposal, no new request
npm run demo:testnet            # read-only public contract state snapshot
npm run submission:check -- --online
```

The existing signed transaction journal and deployment records must not be deleted or reused to start a second public operation. The final public evidence is an observed testnet run, not a claim of continuous hosted execution.

## Video content and provenance

The captioned 171.6-second submission video combines two clearly labeled sections: a previously recorded **local recovery demonstration**, followed by **real public testnet receipt evidence** with explorer QR codes. The public section uses the receipts above and represents recorded evidence rather than live screen capture. There is no audio. A private review site exists but is not required for judges; the repository and public video are the intended submission links.
