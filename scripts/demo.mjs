import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { projectRoot } from './compile.mjs';
import { accounting, cancel, createFixture, deliverCallback, eventLogs, finalize, receiptEvidence, relayEvent, request } from '../test/helpers.mjs';

const fixture = await createFixture();
const evidence = {
  mode: 'local-evm',
  publicTestnetExecution: false,
  aiInference: false,
  generatedAt: new Date().toISOString(),
  scenario: 'Two 60-unit commitments share a 100-unit cap; a cancellation beats a delayed grant, then released capacity funds a new commitment on another chain.',
  transport: 'Three independent Ganache EVMs. MockSystem and MockCallbackProxy explicitly substitute for Reactive transport.',
  finality: 'A trusted test signer authorizes closure finalization. This demo does not verify public-chain finality.',
  assumptions: ['Prefunded test tokens', 'Canonical local EVM histories', 'All-or-nothing purchase consumption', 'One budget denomination'],
  deployments: {},
  steps: [],
};

async function step(label, receipts = []) {
  evidence.steps.push({
    label,
    accounting: await accounting(fixture),
    payments: {
      base: (await fixture.chains.base.token.balanceOf(fixture.recipient)).toString(),
      unichain: (await fixture.chains.unichain.token.balanceOf(fixture.recipient)).toString(),
    },
    transactions: receipts.map(([receipt, chain]) => receiptEvidence(receipt, chain)),
  });
}

try {
  evidence.deployments = {
    coordinator: fixture.coordinator.target,
    inbox: fixture.inbox.target,
    baseVault: fixture.chains.base.vault.target,
    unichainVault: fixture.chains.unichain.vault.target,
  };
  await step('Owner approves a 100-unit spending cap over prefunded local vaults');

  const a = await request(fixture, 'demo-A');
  assert.equal(a.callbacks.length, 1);
  await step('A reserves 60; its execution grant is deliberately delayed', [[a.origin, fixture.chains.base], [a.receipt, fixture.chains.reactive]]);

  const b = await request(fixture, 'demo-B', 'unichain');
  assert.equal(b.callbacks.length, 0);
  await step('B requests 60 on another chain and is rejected while only 40 remains', [[b.origin, fixture.chains.base], [b.receipt, fixture.chains.reactive]]);

  const cancellation = await cancel(fixture, a.operationId);
  const closure = await deliverCallback(fixture, cancellation.callbacks[0]);
  await step('A closes at the destination before its grant arrives; capacity stays reserved', [[cancellation.origin, fixture.chains.base], [cancellation.receipt, fixture.chains.reactive], [closure.receipt, closure.chain]]);

  const lateGrant = await deliverCallback(fixture, a.callbacks[0]);
  assert.equal(eventLogs(fixture.chains.base.vault, lateGrant.receipt, 'LateGrantRejected').length, 1);
  assert.equal((await fixture.chains.base.vault.permits(a.operationId)).state, 3n);
  await step('The delayed grant cannot reopen A', [[lateGrant.receipt, lateGrant.chain]]);

  const observed = await relayEvent(fixture, fixture.chains.base, fixture.chains.base.vault, closure.receipt, 'CommitmentClosed');
  assert.equal((await accounting(fixture)).reserved, '60');
  await step('Reactive observes the closure; observation alone does not release the reservation', [[observed.receipt, fixture.chains.reactive]]);

  const finalized = await finalize(fixture, a.operationId);
  assert.equal((await accounting(fixture)).available, '100');
  await step('The trusted test finalizer confirms closure and releases unused capacity', [[finalized, fixture.chains.reactive]]);

  const replacement = await request(fixture, 'demo-B-new-attempt', 'unichain');
  const grant = await deliverCallback(fixture, replacement.callbacks[0]);
  const execution = await (await fixture.chains.unichain.vault.execute(replacement.operationId)).wait();
  const spent = await relayEvent(fixture, fixture.chains.unichain, fixture.chains.unichain.vault, execution, 'CommitmentExecuted');
  await step('A new 60-unit purchase completes on Unichain and is reconciled', [[replacement.origin, fixture.chains.base], [replacement.receipt, fixture.chains.reactive], [grant.receipt, grant.chain], [execution, fixture.chains.unichain], [spent.receipt, fixture.chains.reactive]]);

  const replay = await (await fixture.system.deliverLog(fixture.coordinator.target, spent.record)).wait();
  const repeatedExecution = await (await fixture.chains.unichain.vault.execute(replacement.operationId)).wait();
  assert.equal(await fixture.chains.unichain.token.balanceOf(fixture.recipient), 60n);
  assert.equal(await fixture.chains.base.token.balanceOf(fixture.recipient), 0n);
  assert.deepEqual(await accounting(fixture), { cap: '100', reserved: '0', spent: '60', available: '40' });
  await step('Receipt replay and repeated execution do not pay again', [[replay, fixture.chains.reactive], [repeatedExecution, fixture.chains.unichain]]);

  evidence.result = { passed: true, finalAccounting: await accounting(fixture), totalPaid: '60', doublePayments: 0, cancelledGrantReopened: false };
  const destination = path.join(projectRoot, 'evidence', 'local-demo.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ mode: evidence.mode, publicTestnetExecution: false, steps: evidence.steps.length, result: evidence.result, evidence: path.relative(projectRoot, destination) }, null, 2));
} finally {
  await fixture.close();
}
