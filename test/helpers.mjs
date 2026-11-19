import assert from 'node:assert/strict';
import ganache from 'ganache';
import { BrowserProvider, Contract, ContractFactory, id } from 'ethers';
import { compileContracts, getArtifact } from '../scripts/compile.mjs';

export const SYSTEM = '0x8888888888888888888888888888888888888888';
export const CHAIN_IDS = { reactive: 5318007n, base: 84532n, unichain: 1301n };
let compiled;

export function compilation() {
  compiled ??= compileContracts();
  return compiled;
}

export function eventLogs(contract, receipt, eventName) {
  return receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== contract.target.toLowerCase()) return [];
    try {
      const parsed = contract.interface.parseLog(log);
      return parsed?.name === eventName ? [{ log, args: parsed.args }] : [];
    } catch { return []; }
  });
}

export function logRecord(log, chainId, overrides = {}) {
  return {
    chainId,
    contractAddress: log.address,
    topic0: BigInt(log.topics[0] ?? 0),
    topic1: BigInt(log.topics[1] ?? 0),
    topic2: BigInt(log.topics[2] ?? 0),
    topic3: BigInt(log.topics[3] ?? 0),
    data: log.data,
    blockNumber: BigInt(log.blockNumber),
    opCode: BigInt(log.topics.length),
    blockHash: BigInt(log.blockHash),
    txHash: BigInt(log.transactionHash),
    logIndex: BigInt(log.index),
    ...overrides,
  };
}

async function makeChain(name) {
  const raw = ganache.provider({
    chain: { chainId: Number(CHAIN_IDS[name]), hardfork: 'shanghai', time: new Date('2026-11-16T00:00:00Z') },
    wallet: { deterministic: true, totalAccounts: 6, defaultBalance: 1000 },
    logging: { quiet: true },
    miner: { instamine: 'eager' },
  });
  const provider = new BrowserProvider(raw, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const signers = await Promise.all([0, 1, 2, 3, 4, 5].map((index) => provider.getSigner(index)));
  return { name, id: CHAIN_IDS[name], raw, provider, signers };
}

export async function deploy(chain, name, args = [], signerIndex = 0) {
  const artifact = getArtifact(compilation(), name);
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, chain.signers[signerIndex]);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

export async function createFixture() {
  const chains = Object.fromEntries(await Promise.all(Object.keys(CHAIN_IDS).map(async (name) => [name, await makeChain(name)])));
  const { reactive, base, unichain } = chains;
  const [owner, agent, finalizer, attacker, recipient] = await Promise.all(base.signers.slice(0, 5).map((signer) => signer.getAddress()));
  const mockSystemArtifact = getArtifact(compilation(), 'MockSystem');
  await reactive.raw.request({ method: 'evm_setAccountCode', params: [SYSTEM, mockSystemArtifact.deployedBytecode] });
  const system = new Contract(SYSTEM, mockSystemArtifact.abi, reactive.signers[0]);
  const inbox = await deploy(base, 'CommitmentInbox', [owner]);
  const coordinator = await deploy(reactive, 'CommitBookReactive', [owner, finalizer, 100, base.id, inbox.target]);
  await (await inbox.setAgent(agent, true)).wait();
  await (await inbox.setSupplier(recipient, true)).wait();
  for (const chain of [base, unichain]) {
    chain.token = await deploy(chain, 'TestToken');
    chain.proxy = await deploy(chain, 'MockCallbackProxy');
    chain.vault = await deploy(chain, 'CommitmentVault', [chain.token.target, chain.proxy.target, coordinator.target]);
    await (await chain.token.mint(chain.vault.target, 1000)).wait();
    await (await coordinator.configureVault(chain.id, chain.vault.target)).wait();
  }
  const expiry = BigInt((await base.provider.getBlock('latest')).timestamp + 3600);
  const fixture = {
    chains, system, inbox, coordinator, owner, agent, finalizer, attacker, recipient, expiry,
    async close() {
      for (const chain of Object.values(chains)) {
        chain.provider.destroy();
        await chain.raw.disconnect();
      }
    },
  };
  return fixture;
}

export async function accounting(fixture) {
  const [cap, reserved, spent, available] = await Promise.all([
    fixture.coordinator.budgetCap(), fixture.coordinator.totalReserved(),
    fixture.coordinator.totalSpent(), fixture.coordinator.availableBudget(),
  ]);
  assert.equal(spent + reserved + available, cap, 'Conservation of approved budget');
  assert.ok(spent + reserved <= cap, 'Budget cap');
  return { cap: cap.toString(), reserved: reserved.toString(), spent: spent.toString(), available: available.toString() };
}

export async function relayEvent(fixture, chain, contract, receipt, eventName, overrides = {}) {
  const events = eventLogs(contract, receipt, eventName);
  assert.equal(events.length, 1, `Exactly one ${eventName} event`);
  const record = logRecord(events[0].log, chain.id, overrides);
  const tx = await fixture.system.deliverLog(fixture.coordinator.target, record, { gasLimit: 3_000_000 });
  const delivered = await tx.wait();
  return { receipt: delivered, record, callbacks: eventLogs(fixture.system, delivered, 'CallbackRequested').map((entry) => entry.args) };
}

export async function request(fixture, label, destination = 'base', amount = 60n, options = {}) {
  const operationId = options.operationId ?? id(label);
  const tx = await fixture.inbox.request(operationId, fixture.chains[destination].id, fixture.recipient, amount, options.expiry ?? fixture.expiry);
  const origin = await tx.wait();
  const reaction = await relayEvent(fixture, fixture.chains.base, fixture.inbox, origin, 'CommitmentRequested');
  return { operationId, origin, ...reaction };
}

export async function cancel(fixture, operationId) {
  const origin = await (await fixture.inbox.cancel(operationId)).wait();
  const reaction = await relayEvent(fixture, fixture.chains.base, fixture.inbox, origin, 'CancellationRequested');
  return { operationId, origin, ...reaction };
}

export async function deliverCallback(fixture, callback, { reactiveSender, expectSuccess = true } = {}) {
  const chain = Object.values(fixture.chains).find((candidate) => candidate.id === callback.chainId);
  assert.ok(chain?.proxy, `Destination chain ${callback.chainId} exists`);
  const tx = await chain.proxy.deliver(reactiveSender ?? callback.reactive, callback.recipient, callback.payload, { gasLimit: 3_000_000 });
  const receipt = await tx.wait();
  const delivered = eventLogs(chain.proxy, receipt, 'CallbackDelivered');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].args.success, expectSuccess, `Destination callback success; result=${delivered[0].args.result}`);
  return { receipt, chain, success: delivered[0].args.success, result: delivered[0].args.result };
}

export async function finalize(fixture, operationId, consumed = 0n, signerIndex = 2) {
  const commitment = await fixture.coordinator.commitments(operationId);
  return (await fixture.coordinator.connect(fixture.chains.reactive.signers[signerIndex]).finalizeClosure(operationId, consumed, commitment.observedClosureProof)).wait();
}

export function receiptEvidence(receipt, chain) {
  return { chain: chain.name, chainId: chain.id.toString(), transactionHash: receipt.hash, blockNumber: receipt.blockNumber, status: receipt.status };
}
