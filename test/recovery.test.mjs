import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, request, cancel, deliverCallback, relayEvent, eventLogs, finalize, accounting } from './helpers.mjs';

test('authorized cancellation retry republishes a missed closure without reopening or releasing twice', async () => {
  const f = await createFixture();
  try {
    const first = await request(f, 'missed-close');
    const cancellation = await cancel(f, first.operationId);
    await deliverCallback(f, cancellation.callbacks[0]);
    assert.equal((await accounting(f)).reserved, '60');
    const retry = await (await f.coordinator.retryCancellation(first.operationId)).wait();
    const callback = eventLogs(f.system, retry, 'CallbackRequested')[0].args;
    const repeatedClose = await deliverCallback(f, callback);
    await relayEvent(f, f.chains.base, f.chains.base.vault, repeatedClose.receipt, 'CommitmentClosed');
    assert.equal((await accounting(f)).reserved, '60');
    await finalize(f, first.operationId);
    await finalize(f, first.operationId);
    assert.equal((await accounting(f)).available, '100');
    const late = await deliverCallback(f, first.callbacks[0]);
    assert.equal(eventLogs(f.chains.base.vault, late.receipt, 'LateGrantRejected').length, 1);
    assert.equal(await f.chains.base.token.balanceOf(f.recipient), 0n);
  } finally { await f.close(); }
});

test('authorized grant retry republishes a missed payment receipt and never pays twice', async () => {
  const f = await createFixture();
  try {
    const first = await request(f, 'missed-spend');
    await deliverCallback(f, first.callbacks[0]);
    await (await f.chains.base.vault.execute(first.operationId)).wait();
    assert.deepEqual(await accounting(f), {cap:'100', reserved:'60', spent:'0', available:'40'});
    assert.equal(await f.chains.base.token.balanceOf(f.recipient), 60n);
    const retry = await (await f.coordinator.retryGrant(first.operationId)).wait();
    const callback = eventLogs(f.system, retry, 'CallbackRequested')[0].args;
    const repeatedGrant = await deliverCallback(f, callback);
    await relayEvent(f, f.chains.base, f.chains.base.vault, repeatedGrant.receipt, 'CommitmentExecuted');
    assert.deepEqual(await accounting(f), {cap:'100', reserved:'0', spent:'60', available:'40'});
    assert.equal(await f.chains.base.token.balanceOf(f.recipient), 60n);
  } finally { await f.close(); }
});
