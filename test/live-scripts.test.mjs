import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet, Transaction, id, keccak256 } from 'ethers';
import { acquireWorkflowLock, BASE_ID, LASNA_ID, transact } from '../scripts/lib/live.mjs';
import { fundingStatus, parseArgs } from '../scripts/deploy-testnet.mjs';
import { accounting } from '../scripts/live-loop.mjs';

// These tests substitute only a provider transport. They never connect to an RPC,
// read the task wallet, or send a public transaction. The signed test keys are new
// random, unfunded keys and the journals live in a temporary directory.
function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'commitbook-live-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const signer = Wallet.createRandom();
  const state = { chainId: BASE_ID, balance: 10n ** 18n, signatures: 0, broadcasts: [], receipt: null, pending: null };
  const receiptFor = hash => ({ hash, status: 1, blockNumber: 8, blockHash: id('test block 8'), gasUsed: 21000n });
  const provider = {
    async send(method) {
      if (method === 'eth_chainId') return `0x${state.chainId.toString(16)}`;
      if (method === 'eth_getTransactionCount') return '0x0';
      throw new Error(`Unexpected mocked RPC ${method}`);
    },
    async getBalance() { return state.balance; },
    async getTransactionReceipt() { return state.receipt; },
    async getTransaction() { return state.pending; },
    async getBlock() { return { hash: id('test block 8') }; },
    async broadcastTransaction(raw) {
      state.broadcasts.push(raw);
      const transaction = Transaction.from(raw);
      state.pending = transaction;
      state.receipt = receiptFor(transaction.hash);
      return transaction;
    },
  };
  const wallet = {
    address: signer.address,
    async populateTransaction(request) { return { ...request, type: 0, gasLimit: 21000n, gasPrice: 1n }; },
    async signTransaction(request) { state.signatures++; return signer.signTransaction(request); },
  };
  return {
    state, provider, signer, receiptFor, directory,
    options: {
      chain: { chainId: BASE_ID, provider, wallet }, manifest: { transactions: {} },
      manifestPath: path.join(directory, 'manifest.json'), privateDirectory: path.join(directory, 'private'),
      label: 'test-transfer', request: { to: signer.address, value: 7n, data: '0x' }, broadcast: true,
    },
  };
}

test('confirmed transaction resumes at zero balance without signing or rebroadcast', async t => {
  const h = harness(t);
  const original = await transact(h.options);
  assert.equal(h.state.signatures, 1);
  assert.equal(h.state.broadcasts.length, 1);
  h.state.balance = 0n;
  const recovered = await transact(h.options);
  assert.equal(recovered.hash, original.hash);
  assert.equal(h.state.signatures, 1);
  assert.equal(h.state.broadcasts.length, 1);
  assert.equal(h.options.manifest.transactions['test-transfer'].state, 'confirmed');
});

test('prepared transaction recovers the same saved signed bytes and hash', async t => {
  const h = harness(t);
  const populated = { ...h.options.request, chainId: BASE_ID, nonce: 0, type: 0, gasLimit: 21000n, gasPrice: 1n };
  const raw = await h.signer.signTransaction(populated);
  const hash = keccak256(raw);
  fs.mkdirSync(h.options.privateDirectory);
  fs.writeFileSync(path.join(h.options.privateDirectory, `${hash}.raw`), raw);
  h.options.manifest.transactions['test-transfer'] = {
    state: 'prepared', transactionHash: hash, chainId: BASE_ID, nonce: 0,
    to: h.signer.address, dataHash: keccak256('0x'), valueWei: '7',
  };
  const receipt = await transact(h.options);
  assert.equal(receipt.hash, hash);
  assert.equal(h.state.signatures, 0);
  assert.deepEqual(h.state.broadcasts, [raw]);
});

test('an already pending transaction is recovered without another broadcast', async t => {
  const h = harness(t);
  const receipt = await transact(h.options);
  h.state.receipt = null;
  h.state.balance = 0n;
  let reads = 0;
  h.provider.getTransactionReceipt = async () => ++reads === 1 ? null : receipt;
  const recovered = await transact(h.options);
  assert.equal(recovered.hash, receipt.hash);
  assert.equal(h.state.signatures, 1);
  assert.equal(h.state.broadcasts.length, 1);
});

test('wrong RPC chain blocks before signing or broadcasting', async t => {
  const h = harness(t);
  h.state.chainId = 1;
  await assert.rejects(transact(h.options), { code: 'CHAIN_ID_MISMATCH' });
  assert.equal(h.state.signatures, 0);
  assert.equal(h.state.broadcasts.length, 0);
  assert.deepEqual(h.options.manifest.transactions, {});
});

test('new transaction rejects zero funds and insufficient maximum gas cost before signing', async t => {
  const h = harness(t);
  h.state.balance = 0n;
  await assert.rejects(transact(h.options), { code: 'INSUFFICIENT_TESTNET_BALANCE' });
  h.state.balance = 21006n;
  await assert.rejects(transact(h.options), { code: 'INSUFFICIENT_TESTNET_BALANCE' });
  assert.equal(h.state.signatures, 0);
  assert.equal(h.state.broadcasts.length, 0);
});

test('changed transaction intent cannot reuse a saved journal entry', async t => {
  const h = harness(t);
  await transact(h.options);
  h.options.request.value = 8n;
  await assert.rejects(transact(h.options), { code: 'TRANSACTION_INTENT_CHANGED' });
  assert.equal(h.state.signatures, 1);
  assert.equal(h.state.broadcasts.length, 1);
});

test('exclusive workflow lock blocks concurrent writers and release is idempotent', t => {
  const h = harness(t);
  const file = path.join(h.directory, 'workflow.lock');
  const release = acquireWorkflowLock({ file });
  assert.throws(() => acquireWorkflowLock({ file }), { code: 'WORKFLOW_LOCK_HELD' });
  release();
  release();
  const secondRelease = acquireWorkflowLock({ file });
  secondRelease();
  assert.equal(fs.existsSync(file), false);
});

test('funding planning remains an honest report and faucet requires explicit bounded broadcast', () => {
  const funding = fundingStatus({ [BASE_ID]: '0', [LASNA_ID]: '0' }, { contracts: {} });
  assert.equal(funding.ready, false);
  assert.ok(funding.networks.every(network => network.balanceWei === '0' && network.funded === false));
  assert.throws(() => parseArgs(['--fund-lasna', '0.001']), { code: 'FAUCET_REQUIRES_EXPLICIT_BROADCAST' });
  assert.throws(() => parseArgs(['--broadcast', '--fund-lasna', '0.020000000000000001']), { code: 'FAUCET_AMOUNT_OUT_OF_RANGE' });
  assert.equal(parseArgs(['--broadcast', '--fund-lasna', '0.02']).fundLasnaWei, 20000000000000000n);
});

test('accounting reads one block and rejects a changed canonical hash', async () => {
  const tags = [];
  let reorg = false;
  const fixed = { number: 123, hash: id('accounting block') };
  const coordinator = { runner: { async getBlock(tag) { return tag === 'latest' || !reorg ? fixed : { ...fixed, hash: id('reorg') }; } } };
  for (const [name, value] of Object.entries({ budgetCap: 100n, totalReserved: 60n, totalSpent: 0n, availableBudget: 40n })) {
    coordinator[name] = async options => { tags.push(options.blockTag); return value; };
  }
  const result = await accounting(coordinator);
  assert.deepEqual(tags, [123, 123, 123, 123]);
  assert.equal(result.reserved, '60');
  reorg = true;
  await assert.rejects(accounting(coordinator), { code: 'ACCOUNTING_BLOCK_REORGED' });
});
