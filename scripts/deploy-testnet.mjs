#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Contract, ContractFactory, ZeroAddress, getAddress, keccak256, parseEther } from 'ethers';
import { compileContracts, getArtifact } from './compile.mjs';
import { formatNative } from './check-testnets.mjs';
import {
  BASE_ID, LASNA_ID, SDK_COMMIT, DEPLOYMENT_PATH, LiveError, safeError,
  identity, connect, disconnect, balances, loadJson, saveJson, manifestIdentity,
  verifyDeployments, verifyContractRecord, transact, waitUntil,
  acquireWorkflowLock,
} from './lib/live.mjs';

export function parseArgs(args) {
  const options = { broadcast: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--broadcast') options.broadcast = true;
    else if (args[i] === '--address' && args[i + 1]) options.address = getAddress(args[++i]);
    else if (args[i] === '--fund-lasna' && args[i + 1]) {
      const value = args[++i];
      if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value)) throw new LiveError('INVALID_FAUCET_AMOUNT');
      options.fundLasnaWei = parseEther(value);
      if (options.fundLasnaWei <= 0n || options.fundLasnaWei > parseEther('0.02')) throw new LiveError('FAUCET_AMOUNT_OUT_OF_RANGE');
    } else if (args[i] === '--help') options.help = true;
    else throw new LiveError('UNKNOWN_ARGUMENT');
  }
  if (options.fundLasnaWei && !options.broadcast) throw new LiveError('FAUCET_REQUIRES_EXPLICIT_BROADCAST');
  return options;
}

export function fundingStatus(balanceWei, manifest) {
  // Planning thresholds, not fee quotes. Exact gas is estimated immediately
  // before each signed transaction. A resume needs only the unfinished stages.
  const baseMinimum = manifest.contracts?.vault ? parseEther('0.0002') : parseEther('0.001');
  const lasnaMinimum = manifest.contracts?.coordinator ? parseEther('0.1') : parseEther('0.6');
  const networks = [
    { chainId: BASE_ID, symbol: 'ETH', minimum: baseMinimum },
    { chainId: LASNA_ID, symbol: 'lREACT', minimum: lasnaMinimum },
  ].map(({ chainId, symbol, minimum }) => ({
    chainId, symbol, balanceWei: balanceWei[chainId], balanceNative: formatNative(balanceWei[chainId]),
    planningThresholdWei: minimum.toString(), planningThresholdNative: formatNative(minimum),
    funded: BigInt(balanceWei[chainId]) >= minimum,
  }));
  return {
    ready: networks.every(network => network.funded), networks,
    note: 'Planning thresholds, not measured minimums or gas quotes. Includes deployment value deposits. Before signing or rebroadcast, the script checks value plus the maximum execution gas fee against the account balance. OP-stack L1 data fees are additional and this bound does not quote the total fee.',
  };
}

async function deploy(name, contractName, chainId, args, value, context) {
  const { manifest, chains, compiled } = context;
  const chain = chains[chainId];
  const artifact = getArtifact(compiled, contractName);
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, chain.wallet);
  const request = await factory.getDeployTransaction(...args, { value });
  const creationCodeHash = keccak256(request.data);
  const existing = manifest.contracts[name];
  if (existing) {
    await verifyContractRecord(existing, chain);
    if (existing.creationCodeHash !== creationCodeHash) throw new LiveError('DEPLOYED_BUILD_CHANGED', { contract: name });
    return new Contract(existing.address, artifact.abi, chain.provider);
  }
  const receipt = await transact({ chain, manifest, manifestPath: DEPLOYMENT_PATH, label: `deploy-${name}`, request, broadcast: true });
  if (!receipt.contractAddress) throw new LiveError('DEPLOYMENT_ADDRESS_MISSING', { contract: name });
  const code = await chain.provider.getCode(receipt.contractAddress);
  if (code === '0x') throw new LiveError('DEPLOYED_BYTECODE_ABSENT', { contract: name });
  manifest.contracts[name] = {
    address: getAddress(receipt.contractAddress), transactionHash: receipt.hash, blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash, chainId, codeHash: keccak256(code), creationCodeHash,
  };
  saveJson(DEPLOYMENT_PATH, manifest);
  return new Contract(receipt.contractAddress, artifact.abi, chain.provider);
}

async function runLocked(options) {
  const signer = identity({ requireKey: options.broadcast, address: options.address });
  const compiled = compileContracts();
  const manifest = loadJson(DEPLOYMENT_PATH) || {
    schemaVersion: 1, mode: 'public-testnet', owner: signer.address,
    createdAt: new Date().toISOString(), sdkCommit: SDK_COMMIT, compiler: compiled.compiler, evmVersion: 'shanghai',
    chainIds: { base: BASE_ID, reactive: LASNA_ID },
    scope: 'One Base Sepolia origin, Lasna coordinator, and Base Sepolia destination using a valueless demo token.',
    budgetCap: '100', demoRecipient: signer.address, contracts: {}, transactions: {},
    publicTestnetExecution: false, aiInference: false,
  };
  manifestIdentity(manifest, signer.address, compiled.compiler);
  let chains;
  try {
    chains = await connect(signer);
    await verifyDeployments(manifest, chains, compiled);
    manifest.checkedAt = new Date().toISOString();
    delete manifest.lastError;
    manifest.funding = fundingStatus(await balances(chains, signer.address), manifest);
    manifest.lastRunBroadcast = options.broadcast;
    manifest.status = manifest.status === 'deployed' ? 'deployed'
      : manifest.funding.ready ? 'ready-to-deploy' : 'awaiting-testnet-funding';
    saveJson(DEPLOYMENT_PATH, manifest);
    if (!options.broadcast) return manifest;

    if (options.fundLasnaWei) {
      const base = chains[BASE_ID];
      if (await base.provider.getCode(base.faucet) === '0x') throw new LiveError('OFFICIAL_FAUCET_BYTECODE_ABSENT');
      const faucet = new Contract(base.faucet, ['function request(address recipient) payable'], base.provider);
      const before = BigInt(manifest.funding.networks.find(network => network.chainId === LASNA_ID).balanceWei);
      await transact({ chain: base, manifest, manifestPath: DEPLOYMENT_PATH, label: 'fund-lasna',
        request: await faucet.request.populateTransaction(signer.address, { value: options.fundLasnaWei }), broadcast: true });
      if (before < parseEther('0.6')) await waitUntil(async () => (await chains[LASNA_ID].provider.getBalance(signer.address)) > before);
      manifest.funding = fundingStatus(await balances(chains, signer.address), manifest);
    }
    manifest.status = 'deploying';
    saveJson(DEPLOYMENT_PATH, manifest);
    const context = { manifest, chains, compiled };
    const inbox = await deploy('inbox', 'CommitmentInbox', BASE_ID, [signer.address], 0n, context);
    const coordinator = await deploy('coordinator', 'CommitBookReactive', LASNA_ID,
      [signer.address, signer.address, 100n, BASE_ID, await inbox.getAddress()], parseEther('0.1'), context);
    const token = await deploy('token', 'DemoToken', BASE_ID, [], 0n, context);
    const vault = await deploy('vault', 'CommitmentVault', BASE_ID,
      [await token.getAddress(), chains[BASE_ID].service, await coordinator.getAddress()], parseEther('0.0001'), context);
    const vaultAddress = await vault.getAddress();
    await transact({ chain: chains[BASE_ID], manifest, manifestPath: DEPLOYMENT_PATH, label: 'mint-demo-token',
      request: await token.mint.populateTransaction(vaultAddress, 1000n), broadcast: true });

    const route = await coordinator.vaults(BASE_ID);
    if (route === ZeroAddress || manifest.transactions['configure-vault']) {
      await transact({ chain: chains[LASNA_ID], manifest, manifestPath: DEPLOYMENT_PATH, label: 'configure-vault',
        request: await coordinator.configureVault.populateTransaction(BASE_ID, vaultAddress), broadcast: true });
    } else if (getAddress(route) !== getAddress(vaultAddress)) throw new LiveError('EXISTING_ROUTE_MISMATCH');
    if (!await inbox.suppliers(signer.address) || manifest.transactions['allow-demo-supplier']) {
      await transact({ chain: chains[BASE_ID], manifest, manifestPath: DEPLOYMENT_PATH, label: 'allow-demo-supplier',
        request: await inbox.setSupplier.populateTransaction(signer.address, true), broadcast: true });
    }
    await verifyDeployments(manifest, chains, compiled);
    if (getAddress(await coordinator.vaults(BASE_ID)) !== getAddress(vaultAddress) || !await inbox.suppliers(signer.address)) {
      throw new LiveError('DEPLOYMENT_CONFIGURATION_INCOMPLETE');
    }
    manifest.status = 'deployed';
    manifest.completedAt ||= new Date().toISOString();
    manifest.funding = fundingStatus(await balances(chains, signer.address), manifest);
    manifest.nextStep = 'Run scripts/live-loop.mjs read-only first, then with --broadcast to request a real Reactive callback.';
    saveJson(DEPLOYMENT_PATH, manifest);
    return manifest;
  } catch (error) {
    manifest.lastError = safeError(error);
    manifest.status = error instanceof LiveError && error.code === 'TRANSACTION_PENDING' ? 'transaction-pending'
      : error instanceof LiveError && error.code === 'INSUFFICIENT_TESTNET_BALANCE' ? 'awaiting-testnet-funding' : 'deployment-blocked';
    saveJson(DEPLOYMENT_PATH, manifest);
    if (manifest.status === 'awaiting-testnet-funding' || manifest.status === 'transaction-pending') return manifest;
    throw error;
  } finally { disconnect(chains); }
}

export async function run(options) {
  // Read-only preflight updates its public report, so it shares the same lock as
  // broadcast runs. Loop read-only snapshots never mutate either journal.
  const release = acquireWorkflowLock();
  try { return await runLocked(options); }
  finally { release(); }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/deploy-testnet.mjs [--address 0x...] [--broadcast] [--fund-lasna 0.006]\n' +
      'Default: read-only preflight, no signatures or transactions. Only Base Sepolia 84532 and Lasna 5318007.\n' +
      '--broadcast uses COMMITBOOK_TESTNET_PRIVATE_KEY or .secrets/testnet-wallet.json.\n' +
      '--fund-lasna additionally calls the official Base Sepolia faucet; requires --broadcast and 0 < amount <= 0.02 ETH.\n' +
      'Resume the faucet step with the SAME amount. Further top-ups use the external official faucet, not a changed saved transaction.\n' +
      'Resume with the same command. Keep evidence/testnet-deployment.json and private .secrets/broadcasts together.');
    return;
  }
  const report = await run(options);
  console.log(JSON.stringify(report, null, 2));
  if (!['deployed', 'ready-to-deploy'].includes(report.status)) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.log(JSON.stringify({ status: 'blocked', error: safeError(error) }, null, 2)); process.exitCode = 1; });
}
