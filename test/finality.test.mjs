import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, id, keccak256, toQuantity } from 'ethers';
import {
  VerificationError, assertPendingUnchanged, loadInterfaces, requireIdleSigner, safeError,
  validateClosureEvidence, verifyClosure,
} from '../scripts/verify-closure.mjs';

const interfaces = loadInterfaces();
const coordinator = '0x1000000000000000000000000000000000000001';
const vault = '0x2000000000000000000000000000000000000002';
const recipient = '0x3000000000000000000000000000000000000003';
const verifier = '0x4000000000000000000000000000000000000004';

// The event is encoded from the compiled vault ABI, as an EVM log would be.
// logIndex deliberately differs from its index within receipt.logs.
function fixture(consumed = 0n) {
  const operationId = id('finality-fixture-operation');
  const blockHash = id('canonical-source-block-100');
  const transactionHash = id('source-closure-transaction');
  const finalizedHash = id('finalized-source-block-120');
  const evidence = {
    chainId: 84532n, vault, blockNumber: 100n, blockHash: BigInt(blockHash),
    txHash: BigInt(transactionHash), logIndex: 7n, consumed,
  };
  const proof = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes32', 'uint256'],
    [84532n, vault, 100n, BigInt(blockHash), BigInt(transactionHash), 7n, operationId, consumed],
  ));
  const event = interfaces.vault.encodeEventLog(interfaces.vault.getEvent('CommitmentClosed'), [operationId, consumed]);
  const otherEvent = interfaces.vault.encodeEventLog(interfaces.vault.getEvent('CommitmentExecuted'), [operationId, 60n]);
  const logMetadata = { address: vault, blockNumber: '0x64', blockHash, transactionHash, removed: false };
  return {
    operationId, sourceChainId: 84532n, evidence,
    commitment: {
      chainId: 84532n, vault, recipient, amount: 60n, expiresAt: 2000000000n,
      status: 2n, spent: consumed, observedConsumed: consumed,
      observedClosureProof: proof, closureObserved: true, closureFinalized: false,
    },
    receipt: {
      transactionHash, status: '0x1', blockNumber: '0x64', blockHash,
      logs: [
        { ...logMetadata, ...otherEvent, logIndex: '0x3' },
        { ...logMetadata, ...event, logIndex: '0x7' },
      ],
    },
    canonicalBlock: { number: '0x64', hash: blockHash },
    finalizedBlock: { number: '0x78', hash: finalizedHash },
    finalizedBlockAfter: { number: '0x78', hash: finalizedHash },
    permit: { recipient, amount: 60n, expiresAt: 2000000000n, consumed, state: 3n, everGranted: true },
  };
}

function expectRejected(bundle, code) {
  assert.throws(() => validateClosureEvidence(bundle, interfaces.vault), error => {
    assert.equal(error.code, code);
    return true;
  });
}

test('canonical finalized closure validates both zero consumption and full consumption', () => {
  for (const consumed of [0n, 60n]) {
    const bundle = fixture(consumed);
    const result = validateClosureEvidence(bundle, interfaces.vault);
    assert.equal(result.status, 'verified');
    assert.equal(result.proof, bundle.commitment.observedClosureProof);
    assert.equal(result.consumed, consumed.toString());
    assert.equal(result.logIndex, '7');
    assert.equal(result.finalizedBlockNumber, '120');
  }
});

test('closed-before-grant tombstone is valid when finalized consumed amount is zero', () => {
  const bundle = fixture();
  bundle.permit = { state: 3n, consumed: 0n, amount: 0n, everGranted: false };
  assert.equal(validateClosureEvidence(bundle, interfaces.vault).status, 'verified');
});

test('a disappeared receipt cannot release a reservation', () => {
  const bundle = fixture();
  bundle.receipt = null;
  expectRejected(bundle, 'RECEIPT_MISSING');
});

test('a reverted source transaction cannot establish closure', () => {
  const bundle = fixture();
  bundle.receipt.status = '0x0';
  expectRejected(bundle, 'RECEIPT_FAILED');
});

test('receipt substitution and a receipt relocated by reorg are rejected', () => {
  const wrongTransaction = fixture();
  wrongTransaction.receipt.transactionHash = id('other-transaction');
  expectRejected(wrongTransaction, 'RECEIPT_TRANSACTION_MISMATCH');
  const relocated = fixture();
  relocated.receipt.blockHash = id('reorganized-block');
  expectRejected(relocated, 'RECEIPT_BLOCK_HASH_MISMATCH');
  const wrongHeight = fixture();
  wrongHeight.receipt.blockNumber = '0x65';
  expectRejected(wrongHeight, 'RECEIPT_BLOCK_NUMBER_MISMATCH');
});

test('a once observed block that is no longer canonical is rejected', () => {
  const bundle = fixture();
  bundle.canonicalBlock.hash = id('replacement-block-at-height-100');
  expectRejected(bundle, 'CANONICAL_BLOCK_HASH_MISMATCH');
});

test('finality must cover the closure block, regardless of other confirmation counts', () => {
  const bundle = fixture();
  bundle.finalizedBlock.number = '0x63';
  bundle.receipt.confirmations = 999999;
  expectRejected(bundle, 'SOURCE_BLOCK_NOT_FINALIZED');
});

test('an absent finalized tag and a changing finalized checkpoint both reject', () => {
  const absent = fixture();
  absent.finalizedBlock = null;
  expectRejected(absent, 'FINALIZED_BLOCK_UNAVAILABLE');
  const changed = fixture();
  changed.finalizedBlockAfter.hash = id('different-finalized-block');
  expectRejected(changed, 'FINALIZED_CHECKPOINT_HASH_CHANGED');
});

test('the exact event at the observed global log index is required', () => {
  const missing = fixture();
  missing.receipt.logs[1].logIndex = '0x8';
  expectRejected(missing, 'CLOSURE_LOG_MISSING_OR_AMBIGUOUS');
  const wrongAddress = fixture();
  wrongAddress.receipt.logs[1].address = recipient;
  expectRejected(wrongAddress, 'CLOSURE_LOG_ADDRESS_MISMATCH');
  const wrongSignature = fixture();
  wrongSignature.receipt.logs[1].topics[0] = interfaces.vault.getEvent('CommitmentExecuted').topicHash;
  expectRejected(wrongSignature, 'CLOSURE_LOG_SIGNATURE_MISMATCH');
  const wrongOperation = fixture();
  wrongOperation.receipt.logs[1].topics[1] = id('another-operation');
  expectRejected(wrongOperation, 'CLOSURE_LOG_OPERATION_MISMATCH');
});

test('an altered consumed outcome, malformed event, or removed log cannot verify', () => {
  const wrongAmount = fixture();
  wrongAmount.receipt.logs[1].data = AbiCoder.defaultAbiCoder().encode(['uint256'], [60n]);
  expectRejected(wrongAmount, 'CLOSURE_LOG_CONSUMED_MISMATCH');
  const trailingData = fixture();
  trailingData.receipt.logs[1].data += '00';
  expectRejected(trailingData, 'CLOSURE_LOG_DATA_INVALID');
  const removed = fixture();
  removed.receipt.logs[1].removed = true;
  expectRejected(removed, 'CLOSURE_LOG_REMOVED');
});

test('the permit must be permanently CLOSED at the finalized checkpoint', () => {
  for (const state of [0n, 1n, 2n]) {
    const bundle = fixture();
    bundle.permit.state = state;
    expectRejected(bundle, 'FINALIZED_PERMIT_NOT_CLOSED');
  }
  const conflicting = fixture();
  conflicting.permit.consumed = 60n;
  expectRejected(conflicting, 'FINALIZED_PERMIT_CONSUMED_MISMATCH');
});

test('receipt and closed permit cannot substitute for the coordinator-bound evidence digest', () => {
  const bundle = fixture();
  bundle.commitment.observedClosureProof = id('unrelated-proof');
  expectRejected(bundle, 'CLOSURE_PROOF_MISMATCH');
});

test('source chain identity and configured route are part of the check', () => {
  const wrongRpc = fixture();
  wrongRpc.sourceChainId = 1301n;
  expectRejected(wrongRpc, 'SOURCE_CHAIN_ID_MISMATCH');
  const mainnet = fixture();
  mainnet.evidence.chainId = 1n;
  expectRejected(mainnet, 'SOURCE_CHAIN_NOT_ALLOWLISTED');
  const wrongVault = fixture();
  wrongVault.commitment.vault = recipient;
  expectRejected(wrongVault, 'COMMITMENT_VAULT_MISMATCH');
});

test('a changed pending proof is rejected before signing; an already finalized closure is a no-op', () => {
  const bundle = fixture();
  const verified = validateClosureEvidence(bundle, interfaces.vault);
  assert.equal(assertPendingUnchanged(verified, bundle.commitment).status, 'unchanged');
  const changed = { ...bundle.commitment, observedClosureProof: id('new-observed-closure') };
  assert.throws(() => assertPendingUnchanged(verified, changed), { code: 'PENDING_PROOF_CHANGED' });
  const finalized = { ...bundle.commitment, closureFinalized: true };
  assert.equal(assertPendingUnchanged(verified, finalized).status, 'already-finalized');
});

function mockedRpc(bundle, { unsupportedFinalized = false, unavailableSource = false, unsupportedHashState = false } = {}) {
  const calls = [];
  const makeRpc = network => ({
    origin: `https://${network.id}.example.test`,
    async send(method, params = []) {
      calls.push({ chainId: network.chainId, method, params });
      if (network.chainId === 84532 && unavailableSource) throw new VerificationError('RPC_UNAVAILABLE');
      if (method === 'eth_chainId') return toQuantity(network.chainId);
      if (method === 'eth_getCode') return '0x6000';
      if (network.chainId === 5318007 && method === 'eth_call') {
        const parsed = interfaces.coordinator.parseTransaction({ data: params[0].data });
        if (parsed.name === 'finalityVerifier') return interfaces.coordinator.encodeFunctionResult(parsed.name, [verifier]);
        const record = parsed.name === 'commitments' ? bundle.commitment : bundle.evidence;
        const values = interfaces.coordinator.getFunction(parsed.name).outputs.map(output => record[output.name]);
        return interfaces.coordinator.encodeFunctionResult(parsed.name, values);
      }
      if (network.chainId === 84532) {
        if (method === 'eth_getTransactionReceipt') return bundle.receipt;
        if (method === 'eth_getBlockByNumber') {
          if (params[0] === 'finalized') {
            if (unsupportedFinalized) throw new VerificationError('RPC_RESPONSE_ERROR', { rpcCode: -32602 });
            return bundle.finalizedBlock;
          }
          if (params[0] === bundle.canonicalBlock.number) return bundle.canonicalBlock;
          return bundle.finalizedBlockAfter;
        }
        if (method === 'eth_call') {
          if (unsupportedHashState) throw new VerificationError('RPC_RESPONSE_ERROR', { rpcCode: -32602 });
          const values = interfaces.vault.getFunction('permits').outputs.map(output => bundle.permit[output.name]);
          return interfaces.vault.encodeFunctionResult('permits', values);
        }
      }
      throw new Error(`Unexpected mock read: ${method}`);
    },
  });
  return { calls, makeRpc };
}

test('the read-only workflow pins permit state to an exact finalized canonical block hash', async () => {
  const bundle = fixture();
  const mock = mockedRpc(bundle);
  const result = await verifyClosure({ coordinator, operationId: bundle.operationId, makeRpc: mock.makeRpc, interfaces });
  assert.equal(result.report.status, 'verified-read-only');
  assert.equal(result.report.broadcast, false);
  assert.equal(result.report.finalityVerifier, verifier);
  const permitCalls = mock.calls.filter(call => call.chainId === 84532 && call.method === 'eth_call');
  assert.equal(permitCalls.length, 1);
  assert.deepEqual(permitCalls[0].params[1], { blockHash: bundle.finalizedBlock.hash, requireCanonical: true });
  assert.equal(mock.calls.some(call => /send|sign|estimate/i.test(call.method)), false);
});

test('unavailable source RPC and unsupported finalized tags fail without fallback', async () => {
  for (const settings of [{ unavailableSource: true }, { unsupportedFinalized: true }]) {
    const bundle = fixture();
    const mock = mockedRpc(bundle, settings);
    await assert.rejects(verifyClosure({ coordinator, operationId: bundle.operationId, makeRpc: mock.makeRpc, interfaces }),
      error => ['RPC_UNAVAILABLE', 'RPC_RESPONSE_ERROR'].includes(error.code));
    assert.equal(mock.calls.some(call => call.chainId === 84532 && call.method === 'eth_call'), false);
    assert.equal(mock.calls.some(call => call.method === 'eth_blockNumber'), false);
  }
});

test('a node without block-hash state reads is rejected without numeric or latest fallback', async () => {
  const bundle = fixture();
  const mock = mockedRpc(bundle, { unsupportedHashState: true });
  await assert.rejects(verifyClosure({ coordinator, operationId: bundle.operationId, makeRpc: mock.makeRpc, interfaces }),
    { code: 'RPC_RESPONSE_ERROR' });
  const stateCalls = mock.calls.filter(call => call.chainId === 84532 && call.method === 'eth_call');
  assert.equal(stateCalls.length, 1);
  assert.equal(typeof stateCalls[0].params[1], 'object');
});

test('an already finalized commitment returns before source reads or signer access', async () => {
  const bundle = fixture();
  bundle.commitment.closureFinalized = true;
  const mock = mockedRpc(bundle);
  const result = await verifyClosure({ coordinator, operationId: bundle.operationId, makeRpc: mock.makeRpc, interfaces });
  assert.equal(result.report.status, 'already-finalized');
  assert.equal(result.report.broadcast, false);
  assert.equal(mock.calls.every(call => call.chainId === 5318007), true);
  assert.equal(mock.calls.length, 3);
});

test('provider failures cannot expose RPC credentials or signed payloads through errors', () => {
  const providerError = {
    code: 'NETWORK_ERROR', message: 'https://rpc.example.test/private-api-key?secret=token',
    payload: { signedTransaction: 'sensitive-payload' },
  };
  assert.deepEqual(safeError(providerError), { code: 'NETWORK_ERROR' });
  assert.deepEqual(safeError(new Error('private-api-key')), { code: 'VERIFICATION_UNAVAILABLE' });
});

test('finalizer refuses an outstanding signer transaction instead of spending gas on a duplicate', async () => {
  let pending = '0x3';
  const reads = [];
  const provider = {
    async send(method, params) {
      reads.push({ method, params });
      assert.equal(method, 'eth_getTransactionCount');
      assert.equal(params[0], verifier);
      return params[1] === 'latest' ? '0x2' : pending;
    },
  };
  await assert.rejects(requireIdleSigner(provider, verifier), { code: 'SIGNER_HAS_PENDING_TRANSACTIONS' });
  pending = '0x2';
  assert.equal(await requireIdleSigner(provider, verifier), 2);
  pending = '0x1';
  await assert.rejects(requireIdleSigner(provider, verifier), { code: 'SIGNER_NONCE_STATE_INCONSISTENT' });
  assert.deepEqual(reads.slice(0, 2).map(read => read.params[1]), ['latest', 'pending']);
});
