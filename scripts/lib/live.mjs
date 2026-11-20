import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Contract, FetchRequest, JsonRpcProvider, Transaction, Wallet, getAddress, keccak256 } from 'ethers';
import { NETWORKS } from '../check-testnets.mjs';
import { projectRoot, getArtifact } from '../compile.mjs';

export const SDK_COMMIT = '3ade0dcf1d27e67e5783ef807e73a1b9e0c0cce8';
export const BASE_ID = 84532;
export const LASNA_ID = 5318007;
export const DEPLOYMENT_PATH = path.join(projectRoot, 'evidence/testnet-deployment.json');
export const LOOP_PATH = path.join(projectRoot, 'evidence/testnet-loop.json');
const ALLOWED_IDS = new Set([BASE_ID, LASNA_ID]);

export class LiveError extends Error {
  constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail; }
}

export function safeError(error) {
  if (error instanceof LiveError) return { code: error.code, ...error.detail };
  if (error?.name === 'TimeoutError') return { code: 'RPC_TIMEOUT' };
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(error.code)
    ? error.code : 'LIVE_SCRIPT_ERROR';
  // Never include provider messages, request URLs, wallet objects, or raw transactions.
  return { code };
}

export function loadJson(file, fallback = null) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

export function identity({ requireKey = false, address } = {}) {
  if (!requireKey) {
    const publicAddress = address || loadJson(DEPLOYMENT_PATH)?.owner
      || loadJson(path.join(projectRoot, '.secrets/testnet-wallet.json'))?.address;
    if (!publicAddress) throw new LiveError('PUBLIC_ADDRESS_REQUIRED');
    return { address: getAddress(publicAddress), wallet: null };
  }
  let key = process.env.COMMITBOOK_TESTNET_PRIVATE_KEY;
  let saved;
  if (!key) {
    saved = loadJson(path.join(projectRoot, '.secrets/testnet-wallet.json'));
    key = saved?.privateKey;
  }
  if (key) {
    if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new LiveError('INVALID_TESTNET_KEY');
    const wallet = new Wallet(key);
    if (saved?.address && getAddress(saved.address) !== wallet.address) throw new LiveError('WALLET_ADDRESS_MISMATCH');
    if (address && getAddress(address) !== wallet.address) throw new LiveError('SIGNER_ADDRESS_MISMATCH');
    return { address: wallet.address, wallet };
  }
  if (requireKey) throw new LiveError('TESTNET_KEY_REQUIRED');
  const publicAddress = address || loadJson(DEPLOYMENT_PATH)?.owner;
  if (!publicAddress) throw new LiveError('PUBLIC_ADDRESS_REQUIRED');
  return { address: getAddress(publicAddress), wallet: null };
}

export function acquireWorkflowLock({ file = path.join(projectRoot, '.secrets/live-workflow.lock') } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  let descriptor;
  try { descriptor = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existing;
    try { existing = loadJson(file); } catch { /* An initializing lock still owns the workflow. */ }
    throw new LiveError('WORKFLOW_LOCK_HELD', {
      ...(Number.isSafeInteger(existing?.pid) ? { pid: existing.pid } : {}),
      recovery: 'If the previous process crashed, first confirm no deployment, loop, or verifier is running; then remove .secrets/live-workflow.lock and resume. Never run these mutations concurrently.',
    });
  }
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
  fs.closeSync(descriptor);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (loadJson(file)?.token === token) fs.unlinkSync(file);
  };
}

export function makeProvider(endpoint, chainId) {
  const request = new FetchRequest(endpoint);
  request.timeout = 12000;
  request.setThrottleParams({ maxAttempts: 1 });
  // Native fetch honors this runtime's proxy configuration. Ethers' default
  // Node http transport does not; both routes otherwise send the same RPC data.
  request.getUrlFunc = async (req, signal) => {
    const controller = new AbortController();
    if (signal?.cancelled) controller.abort();
    signal?.addListener(() => controller.abort());
    const response = await fetch(req.url, {
      method: req.method, headers: req.headers, body: req.body,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]), redirect: 'error',
    });
    return {
      statusCode: response.status, statusMessage: response.statusText,
      headers: Object.fromEntries(response.headers.entries()), body: new Uint8Array(await response.arrayBuffer()),
    };
  };
  // Chain IDs are explicitly read in connect and again immediately before each
  // signing/broadcast operation. Static metadata prevents background retries.
  const provider = new JsonRpcProvider(request, chainId, { batchMaxCount: 1, cacheTimeout: -1, staticNetwork: true });
  provider.pollingInterval = 1500;
  return provider;
}

export async function connect({ address, wallet = null }) {
  const chains = {};
  try {
    for (const chainId of [BASE_ID, LASNA_ID]) {
      const config = NETWORKS.find(network => network.chainId === chainId);
      let endpoint;
      try { endpoint = new URL(process.env[config.env] || config.rpc); }
      catch { throw new LiveError('INVALID_RPC_URL', { setting: config.env }); }
      if (!['http:', 'https:'].includes(endpoint.protocol)) throw new LiveError('INVALID_RPC_URL', { setting: config.env });
      const provider = makeProvider(endpoint.href, chainId);
      chains[chainId] = { ...config, provider, wallet: wallet?.connect(provider), address };
      const actual = BigInt(await provider.send('eth_chainId', []));
      if (actual !== BigInt(chainId)) throw new LiveError('CHAIN_ID_MISMATCH', { expected: chainId });
      if (await provider.getCode(config.service) === '0x') {
        throw new LiveError('OFFICIAL_SERVICE_BYTECODE_ABSENT', { chainId });
      }
    }
    return chains;
  } catch (error) { disconnect(chains); throw error; }
}

export function disconnect(chains) {
  for (const chain of Object.values(chains || {})) chain.provider.destroy();
}

export async function balances(chains, address) {
  return Object.fromEntries(await Promise.all(Object.values(chains).map(async chain => [
    chain.chainId, (await chain.provider.getBalance(address)).toString(),
  ])));
}

export function manifestIdentity(manifest, address, compiler) {
  if (manifest.schemaVersion !== 1 || manifest.mode !== 'public-testnet' || getAddress(manifest.owner) !== getAddress(address)) {
    throw new LiveError('DEPLOYMENT_MANIFEST_IDENTITY_MISMATCH');
  }
  if (manifest.sdkCommit !== SDK_COMMIT || manifest.compiler !== compiler || manifest.chainIds?.base !== BASE_ID || manifest.chainIds?.reactive !== LASNA_ID) {
    throw new LiveError('DEPLOYMENT_MANIFEST_BUILD_MISMATCH');
  }
}

export async function verifyContractRecord(record, chain) {
  if (!record || record.chainId !== chain.chainId || !record.address) throw new LiveError('CONTRACT_RECORD_INVALID');
  const [code, receipt] = await Promise.all([
    chain.provider.getCode(record.address), chain.provider.getTransactionReceipt(record.transactionHash),
  ]);
  if (code === '0x' || keccak256(code) !== record.codeHash) throw new LiveError('DEPLOYED_BYTECODE_MISMATCH', { chainId: chain.chainId, address: record.address });
  if (!receipt || receipt.status !== 1 || !receipt.contractAddress || getAddress(receipt.contractAddress) !== getAddress(record.address) || receipt.blockNumber !== record.blockNumber) {
    throw new LiveError('DEPLOYMENT_RECEIPT_MISMATCH', { chainId: chain.chainId, address: record.address });
  }
  const block = await chain.provider.getBlock(receipt.blockNumber);
  if (block?.hash !== receipt.blockHash) throw new LiveError('NONCANONICAL_DEPLOYMENT_RECEIPT');
}

export async function verifyDeployments(manifest, chains, compiled) {
  const definitions = {
    inbox: [BASE_ID, 'CommitmentInbox'], coordinator: [LASNA_ID, 'CommitBookReactive'],
    token: [BASE_ID, 'DemoToken'], vault: [BASE_ID, 'CommitmentVault'],
  };
  const contracts = {};
  for (const [name, record] of Object.entries(manifest.contracts || {})) {
    const definition = definitions[name];
    if (!definition) throw new LiveError('UNKNOWN_CONTRACT_RECORD');
    const [chainId, artifactName] = definition;
    await verifyContractRecord(record, chains[chainId]);
    contracts[name] = new Contract(record.address, getArtifact(compiled, artifactName).abi, chains[chainId].provider);
  }
  if (contracts.inbox && getAddress(await contracts.inbox.owner()) !== getAddress(manifest.owner)) throw new LiveError('INBOX_OWNER_MISMATCH');
  if (contracts.coordinator) {
    if (!contracts.inbox) throw new LiveError('INCOMPLETE_DEPLOYMENT_DEPENDENCIES');
    const c = contracts.coordinator;
    if (getAddress(await c.owner()) !== getAddress(manifest.owner) || getAddress(await c.finalityVerifier()) !== getAddress(manifest.owner)
      || await c.originChainId() !== BigInt(BASE_ID) || getAddress(await c.originInbox()) !== getAddress(manifest.contracts.inbox.address)
      || await c.budgetCap() !== 100n) throw new LiveError('COORDINATOR_CONFIGURATION_MISMATCH');
  }
  if (contracts.vault) {
    if (!contracts.token || !contracts.coordinator) throw new LiveError('INCOMPLETE_DEPLOYMENT_DEPENDENCIES');
    const v = contracts.vault;
    if (getAddress(await v.token()) !== getAddress(manifest.contracts.token.address)
      || getAddress(await v._CALLBACK_SENDER()) !== getAddress(manifest.contracts.coordinator.address)
      || getAddress(await v._SERVICE_PROVIDER()) !== getAddress(chains[BASE_ID].service)) throw new LiveError('VAULT_CONFIGURATION_MISMATCH');
  }
  return contracts;
}

export async function waitUntil(check, { timeoutMs = 45000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + Math.min(timeoutMs, 45000);
  do {
    const result = await check();
    if (result) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  } while (Date.now() < deadline);
  return null;
}

export function publicReceipt(receipt, chainId) {
  return {
    transactionHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
    chainId, status: receipt.status, gasUsed: receipt.gasUsed.toString(),
  };
}

// Persist a signed transaction privately before broadcast. Its public hash and
// immutable intent make a crash between broadcast and receipt safe to resume.
export async function transact({ chain, manifest, manifestPath, label, request, broadcast,
  privateDirectory = path.join(projectRoot, '.secrets/broadcasts') }) {
  if (!broadcast || !chain.wallet) throw new LiveError('BROADCAST_NOT_ENABLED');
  if (!ALLOWED_IDS.has(chain.chainId) || BigInt(await chain.provider.send('eth_chainId', [])) !== BigInt(chain.chainId)) throw new LiveError('CHAIN_ID_MISMATCH');
  const intent = { to: request.to ? getAddress(request.to) : null, dataHash: keccak256(request.data || '0x'), valueWei: BigInt(request.value || 0).toString() };
  manifest.transactions ||= {};
  let entry = manifest.transactions[label];
  if (entry && (entry.chainId !== chain.chainId || entry.to !== intent.to || entry.dataHash !== intent.dataHash || entry.valueWei !== intent.valueWei)) {
    throw new LiveError('TRANSACTION_INTENT_CHANGED', { label });
  }
  const checkBalance = async transaction => {
    const maximumGasPrice = transaction.maxFeePerGas ?? transaction.gasPrice;
    if (transaction.gasLimit == null || maximumGasPrice == null) throw new LiveError('TRANSACTION_FEE_FIELDS_MISSING');
    const required = BigInt(transaction.value || 0) + BigInt(transaction.gasLimit) * BigInt(maximumGasPrice);
    const balance = await chain.provider.getBalance(chain.wallet.address);
    if (balance < required) throw new LiveError('INSUFFICIENT_TESTNET_BALANCE', {
      chainId: chain.chainId, balanceWei: balance.toString(), requiredValueAndMaxExecutionFeeWei: required.toString(),
    });
    // OP-stack L1 data fees are separate; this check is a necessary funding
    // bound, not an exact total-fee quote. The deployment planning margin covers
    // ordinary variation but cannot guarantee a future transaction's price.
  };
  if (!entry) {
    if (await chain.provider.getBalance(chain.wallet.address) === 0n) throw new LiveError('INSUFFICIENT_TESTNET_BALANCE', { chainId: chain.chainId, balanceWei: '0' });
    const nonce = Number(BigInt(await chain.provider.send('eth_getTransactionCount', [chain.wallet.address, 'pending'])));
    // COMMITBOOK_LASNA_TIP_FIX: Lasna rejects EIP-1559 tip cap zero.
    const populated = await chain.wallet.populateTransaction({
      ...request,
      ...(chain.chainId === LASNA_ID ? {maxPriorityFeePerGas: 1_000_000_000n} : {}),
      chainId: chain.chainId, nonce,
    });
    await checkBalance(populated);
    const raw = await chain.wallet.signTransaction(populated);
    const hash = keccak256(raw);
    fs.mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(privateDirectory, `${hash}.raw`), raw, { mode: 0o600 });
    entry = manifest.transactions[label] = { state: 'prepared', transactionHash: hash, chainId: chain.chainId, nonce, ...intent, preparedAt: new Date().toISOString() };
    saveJson(manifestPath, manifest);
  }
  let receipt = await chain.provider.getTransactionReceipt(entry.transactionHash);
  if (!receipt) {
    const pending = await chain.provider.getTransaction(entry.transactionHash);
    if (!pending) {
      const rawPath = path.join(privateDirectory, `${entry.transactionHash}.raw`);
      if (!fs.existsSync(rawPath)) throw new LiveError('PENDING_TRANSACTION_BYTES_MISSING', { label, transactionHash: entry.transactionHash });
      const raw = fs.readFileSync(rawPath, 'utf8');
      const decoded = Transaction.from(raw);
      if (decoded.hash !== entry.transactionHash || decoded.chainId !== BigInt(chain.chainId) || getAddress(decoded.from) !== chain.wallet.address
        || decoded.nonce !== entry.nonce || keccak256(decoded.data) !== intent.dataHash || decoded.value.toString() !== intent.valueWei
        || (decoded.to ? getAddress(decoded.to) : null) !== intent.to) throw new LiveError('PREPARED_TRANSACTION_MISMATCH', { label });
      await checkBalance(decoded);
      try { await chain.provider.broadcastTransaction(raw); }
      catch (error) {
        if (!await chain.provider.getTransaction(entry.transactionHash)) throw error;
      }
    }
    entry.state = 'broadcast';
    saveJson(manifestPath, manifest);
    receipt = await waitUntil(() => chain.provider.getTransactionReceipt(entry.transactionHash));
  }
  if (!receipt) throw new LiveError('TRANSACTION_PENDING', { label, transactionHash: entry.transactionHash });
  const block = await chain.provider.getBlock(receipt.blockNumber);
  if (block?.hash !== receipt.blockHash) throw new LiveError('NONCANONICAL_TRANSACTION_RECEIPT', { label });
  entry.receipt = publicReceipt(receipt, chain.chainId);
  entry.state = receipt.status === 1 ? 'confirmed' : 'reverted';
  saveJson(manifestPath, manifest);
  if (receipt.status !== 1) throw new LiveError('TRANSACTION_REVERTED', { label, transactionHash: entry.transactionHash });
  return receipt;
}

export async function findEvent(contract, eventName, operationId, chain, fromBlock) {
  const latest = await chain.provider.getBlockNumber();
  // Leave room for the final log query and canonical receipt/block checks,
  // each bounded by the 12-second transport timeout.
  const deadline = Date.now() + 20000;
  for (let high = latest; high >= fromBlock && Date.now() < deadline; high -= 1000) {
    const low = Math.max(fromBlock, high - 999);
    const logs = await contract.queryFilter(contract.filters[eventName](operationId), low, high);
    const log = logs.at(-1);
    if (!log) continue;
    const [receipt, block] = await Promise.all([
      chain.provider.getTransactionReceipt(log.transactionHash), chain.provider.getBlock(log.blockNumber),
    ]);
    if (!receipt || receipt.status !== 1 || block?.hash !== receipt.blockHash || log.blockHash !== receipt.blockHash) throw new LiveError('NONCANONICAL_EVENT_RECEIPT');
    return { ...publicReceipt(receipt, chain.chainId), logIndex: log.index, emitter: log.address, event: eventName };
  }
  return null;
}
