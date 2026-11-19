import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, id, ZeroHash } from 'ethers';
import { accounting, cancel, createFixture, deliverCallback, eventLogs, finalize, relayEvent, request } from './helpers.mjs';

async function withFixture(t) {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  return fixture;
}

test('two chains share one cap; cancellation before grant prevents resurrection and permits safe reallocation', async (t) => {
  const f = await withFixture(t);
  const a = await request(f, 'purchase-A');
  assert.equal(a.callbacks.length, 1);
  assert.deepEqual(await accounting(f), { cap: '100', reserved: '60', spent: '0', available: '40' });

  const b = await request(f, 'purchase-B', 'unichain');
  assert.equal(b.callbacks.length, 0, 'An over-cap request cannot issue an execution permit');
  assert.equal((await f.coordinator.commitments(b.operationId)).status, 0n);

  const cancellation = await cancel(f, a.operationId);
  assert.equal(cancellation.callbacks.length, 1);
  assert.equal((await accounting(f)).reserved, '60', 'Cancellation request does not release capacity');
  const closed = await deliverCallback(f, cancellation.callbacks[0]);
  assert.equal((await f.chains.base.vault.permits(a.operationId)).state, 3n);

  const late = await deliverCallback(f, a.callbacks[0]);
  assert.equal(eventLogs(f.chains.base.vault, late.receipt, 'LateGrantRejected').length, 1);
  await assert.rejects(f.chains.base.vault.execute(a.operationId));
  assert.equal(await f.chains.base.token.balanceOf(f.recipient), 0n);

  const observed = await relayEvent(f, f.chains.base, f.chains.base.vault, closed.receipt, 'CommitmentClosed');
  assert.equal(observed.callbacks.length, 0);
  assert.equal((await accounting(f)).reserved, '60', 'A raw observed receipt is not finality');
  const commitment = await f.coordinator.commitments(a.operationId);
  await assert.rejects(f.coordinator.finalizeClosure(a.operationId, 0, commitment.observedClosureProof));
  await assert.rejects(f.coordinator.connect(f.chains.reactive.signers[2]).finalizeClosure(a.operationId, 0, ZeroHash));
  await finalize(f, a.operationId);
  await finalize(f, a.operationId);
  assert.deepEqual(await accounting(f), { cap: '100', reserved: '0', spent: '0', available: '100' });

  const replacement = await request(f, 'purchase-B-retry', 'unichain');
  await deliverCallback(f, replacement.callbacks[0]);
  const execution = await (await f.chains.unichain.vault.execute(replacement.operationId)).wait();
  await relayEvent(f, f.chains.unichain, f.chains.unichain.vault, execution, 'CommitmentExecuted');
  assert.equal(await f.chains.unichain.token.balanceOf(f.recipient), 60n);
  assert.deepEqual(await accounting(f), { cap: '100', reserved: '0', spent: '60', available: '40' });
});

test('duplicate grants, executions and spend receipts have one business effect', async (t) => {
  const f = await withFixture(t);
  const a = await request(f, 'duplicate-payment');
  await deliverCallback(f, a.callbacks[0]);
  await deliverCallback(f, a.callbacks[0]);
  const execution = await (await f.chains.base.vault.execute(a.operationId)).wait();
  await (await f.chains.base.vault.execute(a.operationId)).wait();
  const reaction = await relayEvent(f, f.chains.base, f.chains.base.vault, execution, 'CommitmentExecuted');
  await (await f.system.deliverLog(f.coordinator.target, reaction.record)).wait();
  // A second transport identity still refers to the same business commitment.
  await (await f.system.deliverLog(f.coordinator.target, {
    ...reaction.record, txHash: BigInt(id('duplicate-business-receipt-new-transaction')),
  })).wait();
  await deliverCallback(f, a.callbacks[0]);
  assert.equal(await f.chains.base.token.balanceOf(f.recipient), 60n);
  assert.equal((await f.chains.base.vault.permits(a.operationId)).consumed, 60n);
  assert.deepEqual(await accounting(f), { cap: '100', reserved: '0', spent: '60', available: '40' });
});

test('missing closure acknowledgement keeps the reservation locked despite remote cancellation', async (t) => {
  const f = await withFixture(t);
  const a = await request(f, 'missing-ack');
  const cancellation = await cancel(f, a.operationId);
  await deliverCallback(f, cancellation.callbacks[0]);
  const b = await request(f, 'still-blocked', 'unichain');
  assert.equal(b.callbacks.length, 0);
  assert.equal((await f.chains.base.vault.permits(a.operationId)).state, 3n);
  assert.deepEqual(await accounting(f), { cap: '100', reserved: '60', spent: '0', available: '40' });
  await assert.rejects(f.coordinator.connect(f.chains.reactive.signers[2]).finalizeClosure(a.operationId, 0, id('invented-proof')));
});

test('source and destination authenticate their callers; a forged reactive identity cannot activate a permit', async (t) => {
  const f = await withFixture(t);
  const a = await request(f, 'auth-boundaries');
  await assert.rejects(f.coordinator.react(a.record));
  await assert.rejects(f.chains.base.vault.grant(f.coordinator.target, a.operationId, f.recipient, 60, f.expiry));
  await deliverCallback(f, a.callbacks[0], { reactiveSender: f.attacker, expectSuccess: false });
  assert.equal((await f.chains.base.vault.permits(a.operationId)).state, 0n);
  await deliverCallback(f, a.callbacks[0]);
  assert.equal((await f.chains.base.vault.permits(a.operationId)).state, 1n);
  await assert.rejects(f.inbox.connect(f.chains.base.signers[3]).request(id('attacker-order'), f.chains.base.id, f.recipient, 1, f.expiry));
});

test('wrong source chain, emitter and malformed event layout cannot settle a commitment', async (t) => {
  const f = await withFixture(t);
  const a = await request(f, 'wrong-origin');
  await deliverCallback(f, a.callbacks[0]);
  const execution = await (await f.chains.base.vault.execute(a.operationId)).wait();
  const emitted = eventLogs(f.chains.base.vault, execution, 'CommitmentExecuted')[0];
  assert.ok(emitted);
  const { logRecord } = await import('./helpers.mjs');
  const record = logRecord(emitted.log, f.chains.base.id);
  const mutations = [{ chainId: 999999n }, { contractAddress: f.attacker }, { opCode: 1n }, { data: '0x01' }, { topic0: BigInt(id('OtherEvent(bytes32,uint256)')) }];
  for (const mutation of mutations) {
    try {
      await (await f.system.deliverLog(f.coordinator.target, { ...record, ...mutation }, { gasLimit: 3_000_000 })).wait();
    } catch { /* Rejection and ignoring are both acceptable for an invalid source. */ }
    assert.deepEqual(await accounting(f), { cap: '100', reserved: '60', spent: '0', available: '40' });
  }
  await relayEvent(f, f.chains.base, f.chains.base.vault, execution, 'CommitmentExecuted');
  assert.equal((await accounting(f)).spent, '60');
});

test('a spent closure may precede the spend receipt without a refund or double count', async (t) => {
  const f = await withFixture(t);
  const a = await request(f, 'spent-before-close');
  await deliverCallback(f, a.callbacks[0]);
  const execution = await (await f.chains.base.vault.execute(a.operationId)).wait();
  const cancellation = await cancel(f, a.operationId);
  const closed = await deliverCallback(f, cancellation.callbacks[0]);
  await relayEvent(f, f.chains.base, f.chains.base.vault, closed.receipt, 'CommitmentClosed');
  assert.equal((await accounting(f)).reserved, '60');
  await finalize(f, a.operationId, 60n);
  await relayEvent(f, f.chains.base, f.chains.base.vault, execution, 'CommitmentExecuted');
  await finalize(f, a.operationId, 60n);
  assert.deepEqual(await accounting(f), { cap: '100', reserved: '0', spent: '60', available: '40' });
  assert.equal(await f.chains.base.token.balanceOf(f.recipient), 60n);
});

test('closed unused authorization cannot become spent from a contradictory later receipt', async (t) => {
  const f = await withFixture(t);
  const a = await request(f, 'contradictory-outcome');
  const cancellation = await cancel(f, a.operationId);
  const closed = await deliverCallback(f, cancellation.callbacks[0]);
  const observed = await relayEvent(f, f.chains.base, f.chains.base.vault, closed.receipt, 'CommitmentClosed');
  await finalize(f, a.operationId);
  const fakeSpend = {
    ...observed.record,
    topic0: BigInt(id('CommitmentExecuted(bytes32,uint256)')),
    data: AbiCoder.defaultAbiCoder().encode(['uint256'], [60]),
    txHash: BigInt(id('different-transport-identity')),
  };
  try { await (await f.system.deliverLog(f.coordinator.target, fakeSpend, { gasLimit: 3_000_000 })).wait(); } catch { /* Expected rejection. */ }
  assert.deepEqual(await accounting(f), { cap: '100', reserved: '0', spent: '0', available: '100' });
  assert.equal((await f.coordinator.commitments(a.operationId)).closureFinalized, true);
});

test('failed token transfer rolls back consumption and immutable grant fields cannot be changed', async (t) => {
  const f = await withFixture(t);
  const a = await request(f, 'token-failure');
  await deliverCallback(f, a.callbacks[0]);
  await (await f.chains.base.token.setTransfersFail(true)).wait();
  await assert.rejects(f.chains.base.vault.execute(a.operationId));
  assert.equal((await f.chains.base.vault.permits(a.operationId)).state, 1n);
  assert.equal((await f.chains.base.vault.permits(a.operationId)).consumed, 0n);
  assert.equal(await f.chains.base.token.balanceOf(f.recipient), 0n);
  const conflictPayload = f.chains.base.vault.interface.encodeFunctionData('grant', [f.coordinator.target, a.operationId, f.attacker, 60, f.expiry]);
  await deliverCallback(f, { ...a.callbacks[0], reactive: a.callbacks[0].reactive, chainId: a.callbacks[0].chainId, recipient: a.callbacks[0].recipient, payload: conflictPayload }, { expectSuccess: false });
  await (await f.chains.base.token.setTransfersFail(false)).wait();
  await (await f.chains.base.vault.execute(a.operationId)).wait();
  assert.equal(await f.chains.base.token.balanceOf(f.recipient), 60n);
});

test('expired authorization cannot pay and time passing does not replenish the shared budget', async (t) => {
  const f = await withFixture(t);
  const now = BigInt((await f.chains.base.provider.getBlock('latest')).timestamp);
  const a = await request(f, 'expired-permit', 'base', 60n, { expiry: now + 20n });
  await deliverCallback(f, a.callbacks[0]);
  await f.chains.base.raw.request({ method: 'evm_increaseTime', params: [21] });
  await f.chains.base.raw.request({ method: 'evm_mine', params: [] });
  await assert.rejects(f.chains.base.vault.execute(a.operationId));
  assert.equal(await f.chains.base.token.balanceOf(f.recipient), 0n);
  assert.deepEqual(await accounting(f), { cap: '100', reserved: '60', spent: '0', available: '40' });
});

test('cancellation observed before its original request cannot later create spending authority', async (t) => {
  const f = await withFixture(t);
  const operationId = id('cancel-before-source-request');
  const origin = await (await f.inbox.request(operationId, f.chains.base.id, f.recipient, 60, f.expiry)).wait();
  const cancelled = await (await f.inbox.cancel(operationId)).wait();
  const cancellation = await relayEvent(f, f.chains.base, f.inbox, cancelled, 'CancellationRequested');
  assert.equal(cancellation.callbacks.length, 0);
  assert.equal(await f.coordinator.cancelledBeforeReservation(operationId), true);
  const delayed = await relayEvent(f, f.chains.base, f.inbox, origin, 'CommitmentRequested');
  assert.equal(delayed.callbacks.length, 0);
  assert.equal((await f.coordinator.commitments(operationId)).status, 0n);
  assert.deepEqual(await accounting(f), { cap: '100', reserved: '0', spent: '0', available: '100' });
});
