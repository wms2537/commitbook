#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getAddress, id } from 'ethers';
import { compileContracts } from './compile.mjs';
import {
  BASE_ID, LASNA_ID, DEPLOYMENT_PATH, LOOP_PATH, LiveError, safeError,
  identity, connect, disconnect, balances, loadJson, saveJson, manifestIdentity,
  verifyDeployments, transact, waitUntil, publicReceipt, findEvent,
  acquireWorkflowLock,
} from './lib/live.mjs';
import {
  approvePublicPlan, loadCurrentPublicPlan, publicOperationId, validatePublicLoopBinding, validatePublicPlanCapacity,
} from './lib/public-plan.mjs';

export function parseArgs(args) {
  const options = { broadcast: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--broadcast') options.broadcast = true;
    else if (args[i] === '--address' && args[i + 1]) options.address = getAddress(args[++i]);
    else if (args[i] === '--help') options.help = true;
    else throw new LiveError('UNKNOWN_ARGUMENT');
  }
  return options;
}

export async function accounting(coordinator) {
  const block = await coordinator.runner.getBlock('latest');
  const [cap, reserved, spent, available] = await Promise.all([
    coordinator.budgetCap({ blockTag: block.number }), coordinator.totalReserved({ blockTag: block.number }),
    coordinator.totalSpent({ blockTag: block.number }), coordinator.availableBudget({ blockTag: block.number }),
  ]);
  if ((await coordinator.runner.getBlock(block.number))?.hash !== block.hash) throw new LiveError('ACCOUNTING_BLOCK_REORGED');
  if (spent + reserved > cap || available !== cap - spent - reserved) throw new LiveError('BUDGET_INVARIANT_FAILED');
  return { cap: cap.toString(), reserved: reserved.toString(), spent: spent.toString(), available: available.toString(), blockNumber: block.number, blockHash: block.hash };
}

function checkPermit(permit, loop) {
  if (!permit.everGranted || getAddress(permit.recipient) !== getAddress(loop.recipient)
    || permit.amount !== BigInt(loop.amount) || permit.expiresAt !== BigInt(loop.expiresAt)) {
    throw new LiveError('DESTINATION_PERMIT_MISMATCH');
  }
  if (permit.state === 3n) throw new LiveError('DESTINATION_PERMIT_CLOSED');
}

function checkCommitment(commitment, loop) {
  if (commitment.chainId !== BigInt(BASE_ID) || getAddress(commitment.vault) !== getAddress(loop.contracts.vault)
    || getAddress(commitment.recipient) !== getAddress(loop.recipient) || commitment.amount !== BigInt(loop.amount)
    || commitment.expiresAt !== BigInt(loop.expiresAt)) throw new LiveError('COORDINATOR_COMMITMENT_MISMATCH');
}

export function paymentTransfers(receipt, token, vaultAddress, recipient) {
  const transfers = [];
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(token.target)) continue;
    let decoded;
    try { decoded = token.interface.parseLog(log); } catch { continue; }
    if (decoded?.name === 'Transfer' && getAddress(decoded.args.from) === getAddress(vaultAddress)
      && getAddress(decoded.args.to) === getAddress(recipient)) transfers.push(decoded.args.amount.toString());
  }
  return transfers;
}

function save(loop, status) {
  if (status) loop.status = status;
  loop.checkedAt = new Date().toISOString();
  saveJson(LOOP_PATH, loop);
  return loop;
}

async function runLocked(options) {
  const currentPlan = options.publicPlan ? loadCurrentPublicPlan(options.publicPlan) : null;
  const signer = identity({ requireKey: options.broadcast, address: options.address });
  const savedLoop = loadJson(LOOP_PATH);
  const approved = currentPlan ? approvePublicPlan(currentPlan, {
    owner: signer.address, approvedDigest: options.approvedDigest, allowExpired: !!savedLoop?.transactions?.request,
  }) : null;
  if (options.broadcast && (savedLoop?.aiInference || savedLoop?.publicPlan || savedLoop?.approval) && !approved) {
    throw new LiveError('PUBLIC_PLAN_APPROVAL_REQUIRED');
  }
  const deployment = loadJson(DEPLOYMENT_PATH);
  if (!deployment) return { mode: 'public-testnet', readOnly: !options.broadcast, status: 'awaiting-deployment', publicTestnetExecution: false, aiInference: !!approved };
  const compiled = compileContracts();
  manifestIdentity(deployment, signer.address, compiled.compiler);
  let chains;
  let loop;
  try {
    chains = await connect(signer);
    const nativeBalances = await balances(chains, signer.address);
    const contracts = await verifyDeployments(deployment, chains, compiled);
    if (deployment.status !== 'deployed' || !['inbox', 'coordinator', 'token', 'vault'].every(name => contracts[name])) {
      return {
        mode: 'public-testnet', readOnly: !options.broadcast, owner: signer.address,
        status: deployment.status === 'awaiting-testnet-funding' ? 'awaiting-testnet-funding' : 'awaiting-deployment',
        publicTestnetExecution: false, aiInference: !!approved, nativeBalancesWei: nativeBalances,
      };
    }
    const { inbox, coordinator, token, vault } = contracts;
    const addresses = Object.fromEntries(Object.entries(deployment.contracts).map(([name, record]) => [name, record.address]));
    if (getAddress(await coordinator.vaults(BASE_ID)) !== getAddress(addresses.vault) || !await inbox.suppliers(signer.address)) {
      throw new LiveError('DEPLOYMENT_CONFIGURATION_INCOMPLETE');
    }
    loop = loadJson(LOOP_PATH);
    if (loop && (loop.schemaVersion !== 1 || loop.mode !== 'public-testnet' || getAddress(loop.owner) !== signer.address
      || Object.keys(addresses).some(name => getAddress(loop.contracts?.[name]) !== getAddress(addresses[name])))) {
      throw new LiveError('LOOP_MANIFEST_IDENTITY_MISMATCH');
    }
    if (loop && approved) validatePublicLoopBinding(approved, loop);
    if (!options.broadcast) {
      const snapshot = { mode: 'public-testnet', readOnly: true, status: loop ? 'historical-result-not-reverified' : 'ready-to-request', owner: signer.address,
        publicTestnetExecution: false, aiInference: false, operationId: loop?.operationId,
        historicalResult: loop ? { status: loop.status, publicTestnetExecution: loop.publicTestnetExecution === true, completedAt: loop.completedAt } : undefined,
        contracts: addresses, nativeBalancesWei: nativeBalances, accounting: await accounting(coordinator),
        tokenBalance: (await token.balanceOf(signer.address)).toString(),
        note: 'Current state snapshot only. Stored loop evidence is historical and its receipts have not been reverified in this read-only run. --broadcast resumes or rechecks the saved transactions and never repeats a confirmed transaction.' };
      return snapshot;
    }
    if (loop) {
      delete loop.lastError;
      // A resumed run must earn current success again from canonical receipts.
      loop.publicTestnetExecution = false;
    }
    if (!loop) {
      const initialAccounting = await accounting(coordinator);
      if (initialAccounting.reserved !== '0' || initialAccounting.spent !== '0') throw new LiveError('DEMO_REQUIRES_UNUSED_COORDINATOR');
      if (approved) validatePublicPlanCapacity(approved, initialAccounting);
      const [baseBlock, reactiveBlock] = await Promise.all([
        chains[BASE_ID].provider.getBlock('latest'), chains[LASNA_ID].provider.getBlock('latest'),
      ]);
      if (approved && approved.expiresAt <= Math.max(baseBlock.timestamp, reactiveBlock.timestamp)) throw new LiveError('PUBLIC_PLAN_EXPIRED');
      loop = {
        schemaVersion: 1, mode: 'public-testnet', owner: signer.address, contracts: addresses,
        chainIds: { origin: BASE_ID, reactive: LASNA_ID, destination: BASE_ID },
        operationId: approved ? publicOperationId(approved.plan, addresses.coordinator) : id(`commitbook:testnet:${addresses.coordinator}:${randomUUID()}`),
        amount: approved?.amount ?? '60', recipient: approved?.recipient ?? signer.address,
        expiresAt: approved?.expiresAt ?? Math.max(baseBlock.timestamp, reactiveBlock.timestamp) + 3600,
        createdAt: new Date().toISOString(), startBlocks: { [BASE_ID]: baseBlock.number, [LASNA_ID]: reactiveBlock.number },
        initialAccounting, initialRecipientBalance: (await token.balanceOf(signer.address)).toString(),
        initialVaultBalance: (await token.balanceOf(addresses.vault)).toString(),
        publicTestnetExecution: false, aiInference: !!approved, evidence: {}, transactions: {},
        ...(approved ? {publicPlan: approved.plan, approval: {digest: approved.digest, method: 'explicit-cli-digest', reviewedAt: new Date().toISOString()}} : {}),
        trust: 'Configured public RPCs and the official Reactive transport. Receipt inclusion is checked against canonical RPC blocks. This is not a cryptographic source-finality proof.',
      };
      save(loop, 'ready-to-request');
    }
    if (approved) validatePublicLoopBinding(approved, loop);
    const operationId = loop.operationId;
    const amount = BigInt(loop.amount);
    if (approved && !loop.transactions.request) validatePublicPlanCapacity(approved, await accounting(coordinator));
    const sourceReceipt = await transact({ chain: chains[BASE_ID], manifest: loop, manifestPath: LOOP_PATH, label: 'request',
      request: await inbox.request.populateTransaction(operationId, BASE_ID, loop.recipient, amount, loop.expiresAt), broadcast: true });
    loop.evidence.sourceRequest = publicReceipt(sourceReceipt, BASE_ID);
    save(loop, 'awaiting-reactive-grant');
    let permit = await waitUntil(async () => {
      const observed = await vault.permits(operationId);
      return observed.everGranted || observed.state === 3n ? observed : null;
    });
    if (!permit) {
      loop.evidence.requestRejected = await findEvent(coordinator, 'RequestRejected', operationId, chains[LASNA_ID], loop.startBlocks[LASNA_ID]);
      return save(loop, loop.evidence.requestRejected ? 'request-rejected' : 'awaiting-reactive-grant');
    }
    checkPermit(permit, loop);
    checkCommitment(await coordinator.commitments(operationId), loop);
    loop.evidence.reactiveReservation = await findEvent(coordinator, 'CommitmentReserved', operationId, chains[LASNA_ID], loop.startBlocks[LASNA_ID]);
    loop.evidence.destinationGrant = await findEvent(vault, 'CommitmentGranted', operationId, chains[BASE_ID], loop.startBlocks[BASE_ID]);
    if (!loop.evidence.reactiveReservation || !loop.evidence.destinationGrant) return save(loop, 'awaiting-transport-receipts');
    loop.afterGrantAccounting = await accounting(coordinator);
    save(loop, 'grant-verified');

    // A consumed permit may reflect a prior successful run whose RPC response was
    // lost. The saved transaction hash lets transact recover that receipt.
    if (permit.consumed === 0n) {
      const block = await chains[BASE_ID].provider.getBlock('latest');
      if (block.timestamp >= loop.expiresAt) return save(loop, 'permit-expired-needs-cancellation');
    }
    const executionReceipt = await transact({ chain: chains[BASE_ID], manifest: loop, manifestPath: LOOP_PATH, label: 'execute',
      request: await vault.execute.populateTransaction(operationId), broadcast: true });
    const transfers = paymentTransfers(executionReceipt, token, addresses.vault, loop.recipient);
    if (transfers.length !== 1 || transfers[0] !== loop.amount) throw new LiveError('EXPECTED_SINGLE_PAYMENT_NOT_FOUND');
    loop.evidence.payment = { ...publicReceipt(executionReceipt, BASE_ID), paymentTransfers: transfers };
    permit = await vault.permits(operationId);
    checkPermit(permit, loop);
    if (permit.consumed !== amount) throw new LiveError('PAYMENT_NOT_CONSUMED');
    loop.afterPaymentRecipientBalance = (await token.balanceOf(loop.recipient)).toString();
    loop.afterPaymentVaultBalance = (await token.balanceOf(addresses.vault)).toString();
    if (BigInt(loop.afterPaymentRecipientBalance) !== BigInt(loop.initialRecipientBalance) + amount
      || BigInt(loop.afterPaymentVaultBalance) !== BigInt(loop.initialVaultBalance) - amount) throw new LiveError('PAYMENT_BALANCE_MISMATCH');
    save(loop, 'awaiting-reactive-spend-observation');
    const commitment = await waitUntil(async () => {
      const observed = await coordinator.commitments(operationId);
      return observed.spent === amount ? observed : null;
    });
    if (!commitment) return save(loop, 'awaiting-reactive-spend-observation');
    checkCommitment(commitment, loop);
    loop.evidence.reactiveSpend = await findEvent(coordinator, 'SpendRecorded', operationId, chains[LASNA_ID], loop.startBlocks[LASNA_ID]);
    if (!loop.evidence.reactiveSpend) return save(loop, 'awaiting-spend-receipt');

    if (await vault.execute.staticCall(operationId) !== false) throw new LiveError('REPLAY_WOULD_CHANGE_STATE');
    const repeatedReceipt = await transact({ chain: chains[BASE_ID], manifest: loop, manifestPath: LOOP_PATH, label: 'repeat-execute',
      request: await vault.execute.populateTransaction(operationId), broadcast: true });
    const repeatedTransfers = paymentTransfers(repeatedReceipt, token, addresses.vault, loop.recipient);
    loop.evidence.repeatedExecution = { ...publicReceipt(repeatedReceipt, BASE_ID), paymentTransfers: repeatedTransfers };
    if (repeatedTransfers.length || (await token.balanceOf(loop.recipient)).toString() !== loop.afterPaymentRecipientBalance
      || (await token.balanceOf(addresses.vault)).toString() !== loop.afterPaymentVaultBalance
      || (await vault.permits(operationId)).consumed !== amount) throw new LiveError('REPLAY_PAYMENT_INVARIANT_FAILED');
    loop.finalAccounting = await accounting(coordinator);
    if (loop.finalAccounting.cap !== '100' || loop.finalAccounting.reserved !== '0'
      || loop.finalAccounting.spent !== loop.amount || loop.finalAccounting.available !== (100n - amount).toString()) throw new LiveError('FINAL_ACCOUNTING_MISMATCH');
    loop.publicTestnetExecution = true;
    loop.completedAt ||= new Date().toISOString();
    return save(loop, 'public-testnet-loop-verified');
  } catch (error) {
    if (loop && options.broadcast) {
      loop.lastError = safeError(error);
      loop.publicTestnetExecution = false;
      save(loop, error instanceof LiveError && error.code === 'TRANSACTION_PENDING' ? 'transaction-pending'
        : error instanceof LiveError && error.code === 'INSUFFICIENT_TESTNET_BALANCE' ? 'awaiting-testnet-funding' : 'loop-blocked');
      if (loop.status === 'transaction-pending' || loop.status === 'awaiting-testnet-funding') return loop;
    }
    throw error;
  } finally { disconnect(chains); }
}

export async function run(options) {
  const release = options.broadcast ? acquireWorkflowLock() : () => {};
  try { return await runLocked(options); }
  finally { release(); }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/live-loop.mjs [--address 0x...] [--broadcast]\n' +
      'Default: read-only deployment and loop status. --broadcast resumes one stable 60-unit commitment.\n' +
      'Requires a completed testnet-deployment.json, the scoped testnet signer, and Base Sepolia gas.\n' +
      'Each polling stage waits at most 45 seconds plus one bounded RPC call. Re-run to resume.\n' +
      'Success requires actual source, Reactive reservation, callback, payment, and spend receipts; a repeated execute must pay zero.');
    return;
  }
  const report = await run(options);
  console.log(JSON.stringify(report, null, 2));
  if (!['public-testnet-loop-verified', 'ready-to-request'].includes(report.status)) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.log(JSON.stringify({ status: 'blocked', error: safeError(error) }, null, 2)); process.exitCode = 1; });
}
