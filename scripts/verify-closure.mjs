#!/usr/bin/env node
/**
 * Trusted testnet closure verifier, not a cryptographic finality proof.
 * Trusts the configured RPCs' canonical chain, finalized tag, receipts and state,
 * plus the coordinator's configured finalityVerifier. Never substitutes elapsed
 * time or a confirmation count for a source chain's finalized checkpoint.
 *
 * node scripts/verify-closure.mjs --coordinator 0x... --operation 0x...
 * Add --broadcast to sign on Lasna only, after all checks and a fresh proof read.
 * A key is read only in that mode, from COMMITBOOK_TESTNET_PRIVATE_KEY or the
 * task-scoped .secrets/testnet-wallet.json. Keys and raw provider errors are never
 * printed. The default command only reads public chain data.
 * Unlike deployment and loop scripts, this finalizer has no transaction journal.
 * It refuses to sign while this signer's RPC reports any pending transaction.
 * After a crash, wait for pending transactions to resolve, then rerun; the
 * coordinator's closureFinalized flag makes completed finalization a no-op.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AbiCoder, Interface, Wallet,
  ZeroAddress, ZeroHash, getAddress, keccak256, toBeHex, toQuantity,
} from 'ethers';
import { compileContracts, getArtifact, projectRoot } from './compile.mjs';
import { NETWORKS } from './check-testnets.mjs';
import { LiveError, acquireWorkflowLock, makeProvider } from './lib/live.mjs';

const ALLOWED_CHAIN_IDS = new Set([5318007n, 84532n, 1301n]);
const LASNA_CHAIN_ID = 5318007n;
const UINT256_MAX = (1n << 256n) - 1n;
const READ_METHODS = new Set([
  'eth_chainId', 'eth_getCode', 'eth_getTransactionReceipt',
  'eth_getBlockByNumber', 'eth_call',
]);
const coder = AbiCoder.defaultAbiCoder();
export const TRUST_NOTICE = 'Trusted RPC and verifier attestation. RPC-reported finality is not a cryptographic proof of source-chain finality.';
let cachedInterfaces;

export class VerificationError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'VerificationError';
    this.code = code;
    this.details = details;
  }
}

function requireThat(condition, code, details) {
  if (!condition) throw new VerificationError(code, details);
}

function uint(value, code = 'INVALID_INTEGER') {
  requireThat(
    typeof value === 'bigint' ||
      (typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' && /^(0x[0-9a-f]+|[0-9]+)$/i.test(value)),
    code,
  );
  const number = BigInt(value);
  requireThat(number >= 0n && number <= UINT256_MAX, code);
  return number;
}

function address(value, code = 'INVALID_ADDRESS') {
  try {
    const result = getAddress(value);
    requireThat(result !== ZeroAddress, code);
    return result;
  } catch { throw new VerificationError(code); }
}

function hash(value, code = 'INVALID_HASH') {
  requireThat(typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value), code);
  return value.toLowerCase();
}

function sameAddress(left, right) {
  return address(left).toLowerCase() === address(right).toLowerCase();
}

function blockNumber(block, code) {
  requireThat(block !== null && typeof block === 'object', code);
  return uint(block.number, code);
}

export function loadInterfaces() {
  if (!cachedInterfaces) {
    const compiled = compileContracts();
    cachedInterfaces = {
      coordinator: new Interface(getArtifact(compiled, 'CommitBookReactive').abi),
      vault: new Interface(getArtifact(compiled, 'CommitmentVault').abi),
    };
  }
  return cachedInterfaces;
}

export function closureProof(operationId, evidence) {
  const operation = hash(operationId, 'INVALID_OPERATION_ID');
  requireThat(operation !== ZeroHash, 'INVALID_OPERATION_ID');
  return keccak256(coder.encode(
    ['uint256', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes32', 'uint256'],
    [uint(evidence.chainId), address(evidence.vault), uint(evidence.blockNumber),
      uint(evidence.blockHash), uint(evidence.txHash), uint(evidence.logIndex),
      operation, uint(evidence.consumed)],
  ));
}

function requirePending(commitment) {
  requireThat(commitment && uint(commitment.status) !== 0n, 'UNKNOWN_COMMITMENT');
  requireThat(commitment.closureObserved === true, 'CLOSURE_NOT_OBSERVED');
  requireThat(hash(commitment.observedClosureProof) !== ZeroHash, 'CLOSURE_PROOF_ABSENT');
}

/** Pure validation of a coherent RPC evidence bundle. No I/O or signing. */
export function validateClosureEvidence(bundle, vaultInterface = loadInterfaces().vault) {
  const {
    operationId, commitment, evidence, sourceChainId, receipt,
    canonicalBlock, finalizedBlock, finalizedBlockAfter, permit,
  } = bundle;
  const operation = hash(operationId, 'INVALID_OPERATION_ID');
  requireThat(operation !== ZeroHash, 'INVALID_OPERATION_ID');
  requirePending(commitment);
  if (commitment.closureFinalized === true) return { status: 'already-finalized', operationId: operation };
  requireThat(evidence && typeof evidence === 'object', 'CLOSURE_EVIDENCE_ABSENT');

  const chainId = uint(evidence.chainId);
  requireThat(ALLOWED_CHAIN_IDS.has(chainId), 'SOURCE_CHAIN_NOT_ALLOWLISTED');
  requireThat(uint(sourceChainId) === chainId, 'SOURCE_CHAIN_ID_MISMATCH');
  requireThat(uint(commitment.chainId) === chainId, 'COMMITMENT_CHAIN_MISMATCH');
  const vault = address(evidence.vault);
  requireThat(sameAddress(commitment.vault, vault), 'COMMITMENT_VAULT_MISMATCH');
  const consumed = uint(evidence.consumed);
  requireThat(consumed === 0n || consumed === uint(commitment.amount), 'INVALID_CONSUMED_AMOUNT');
  requireThat(uint(commitment.observedConsumed) === consumed, 'OBSERVED_CONSUMED_MISMATCH');
  requireThat(uint(commitment.spent) === 0n || uint(commitment.spent) === consumed, 'SPENT_AMOUNT_CONFLICT');
  const proof = closureProof(operation, evidence);
  requireThat(hash(commitment.observedClosureProof) === proof, 'CLOSURE_PROOF_MISMATCH');

  const observedBlockNumber = uint(evidence.blockNumber);
  const observedBlockHash = toBeHex(uint(evidence.blockHash), 32);
  const transactionHash = toBeHex(uint(evidence.txHash), 32);
  requireThat(observedBlockHash !== ZeroHash && transactionHash !== ZeroHash, 'EVIDENCE_HASH_ABSENT');
  requireThat(receipt !== null && typeof receipt === 'object', 'RECEIPT_MISSING');
  requireThat(uint(receipt.status, 'RECEIPT_STATUS_INVALID') === 1n, 'RECEIPT_FAILED');
  requireThat(hash(receipt.transactionHash) === transactionHash, 'RECEIPT_TRANSACTION_MISMATCH');
  requireThat(uint(receipt.blockNumber) === observedBlockNumber, 'RECEIPT_BLOCK_NUMBER_MISMATCH');
  requireThat(hash(receipt.blockHash) === observedBlockHash, 'RECEIPT_BLOCK_HASH_MISMATCH');

  requireThat(blockNumber(canonicalBlock, 'CANONICAL_BLOCK_MISSING') === observedBlockNumber, 'CANONICAL_BLOCK_NUMBER_MISMATCH');
  requireThat(hash(canonicalBlock.hash) === observedBlockHash, 'CANONICAL_BLOCK_HASH_MISMATCH');
  const finalizedNumber = blockNumber(finalizedBlock, 'FINALIZED_BLOCK_UNAVAILABLE');
  const finalizedHash = hash(finalizedBlock.hash, 'FINALIZED_BLOCK_HASH_INVALID');
  requireThat(finalizedHash !== ZeroHash, 'FINALIZED_BLOCK_HASH_INVALID');
  requireThat(finalizedNumber >= observedBlockNumber, 'SOURCE_BLOCK_NOT_FINALIZED');
  requireThat(blockNumber(finalizedBlockAfter, 'FINALIZED_CHECKPOINT_RECHECK_MISSING') === finalizedNumber,
    'FINALIZED_CHECKPOINT_NUMBER_CHANGED');
  requireThat(hash(finalizedBlockAfter.hash) === finalizedHash, 'FINALIZED_CHECKPOINT_HASH_CHANGED');
  if (finalizedNumber === observedBlockNumber) {
    requireThat(finalizedHash === observedBlockHash, 'FINALIZED_SOURCE_HASH_MISMATCH');
  }

  requireThat(Array.isArray(receipt.logs), 'RECEIPT_LOGS_MISSING');
  const logIndex = uint(evidence.logIndex);
  const matches = receipt.logs.filter(log => uint(log.logIndex, 'LOG_INDEX_INVALID') === logIndex);
  requireThat(matches.length === 1, 'CLOSURE_LOG_MISSING_OR_AMBIGUOUS');
  const log = matches[0];
  requireThat(log.removed !== true, 'CLOSURE_LOG_REMOVED');
  requireThat(sameAddress(log.address, vault), 'CLOSURE_LOG_ADDRESS_MISMATCH');
  requireThat(uint(log.blockNumber) === observedBlockNumber, 'CLOSURE_LOG_BLOCK_NUMBER_MISMATCH');
  requireThat(hash(log.blockHash) === observedBlockHash, 'CLOSURE_LOG_BLOCK_HASH_MISMATCH');
  requireThat(hash(log.transactionHash) === transactionHash, 'CLOSURE_LOG_TRANSACTION_MISMATCH');
  requireThat(Array.isArray(log.topics) && log.topics.length === 2, 'CLOSURE_LOG_TOPICS_INVALID');
  requireThat(hash(log.topics[0]) === vaultInterface.getEvent('CommitmentClosed').topicHash,
    'CLOSURE_LOG_SIGNATURE_MISMATCH');
  requireThat(hash(log.topics[1]) === operation, 'CLOSURE_LOG_OPERATION_MISMATCH');
  requireThat(typeof log.data === 'string' && /^0x[0-9a-f]{64}$/i.test(log.data), 'CLOSURE_LOG_DATA_INVALID');
  let decoded;
  try { decoded = vaultInterface.parseLog(log); }
  catch { throw new VerificationError('CLOSURE_LOG_DECODE_FAILED'); }
  requireThat(decoded && hash(decoded.args.id) === operation, 'CLOSURE_LOG_OPERATION_MISMATCH');
  requireThat(uint(decoded.args.consumed) === consumed, 'CLOSURE_LOG_CONSUMED_MISMATCH');
  requireThat(permit && uint(permit.state) === 3n, 'FINALIZED_PERMIT_NOT_CLOSED');
  requireThat(uint(permit.consumed) === consumed, 'FINALIZED_PERMIT_CONSUMED_MISMATCH');

  return {
    status: 'verified', operationId: operation, proof, consumed: consumed.toString(),
    chainId: chainId.toString(), vault,
    blockNumber: observedBlockNumber.toString(), blockHash: observedBlockHash,
    transactionHash, logIndex: logIndex.toString(),
    finalizedBlockNumber: finalizedNumber.toString(), finalizedBlockHash: finalizedHash,
  };
}

/** Run immediately before signing a fully populated transaction. */
export function assertPendingUnchanged(verified, currentCommitment) {
  requirePending(currentCommitment);
  if (currentCommitment.closureFinalized === true) return { status: 'already-finalized' };
  requireThat(hash(currentCommitment.observedClosureProof) === verified.proof, 'PENDING_PROOF_CHANGED');
  requireThat(uint(currentCommitment.observedConsumed) === uint(verified.consumed), 'PENDING_CONSUMED_CHANGED');
  requireThat(uint(currentCommitment.chainId) === uint(verified.chainId), 'PENDING_CHAIN_CHANGED');
  requireThat(sameAddress(currentCommitment.vault, verified.vault), 'PENDING_VAULT_CHANGED');
  return { status: 'unchanged' };
}

function networkFor(chainId) {
  const id = uint(chainId);
  requireThat(ALLOWED_CHAIN_IDS.has(id), 'SOURCE_CHAIN_NOT_ALLOWLISTED');
  const network = NETWORKS.find(item => BigInt(item.chainId) === id);
  requireThat(network, 'NETWORK_CONFIGURATION_MISSING');
  return network;
}

function rpcEndpoint(network, env) {
  try {
    const endpoint = new URL(env[network.env] || network.rpc);
    requireThat(['https:', 'http:'].includes(endpoint.protocol), 'INVALID_RPC_URL');
    return endpoint;
  } catch { throw new VerificationError('INVALID_RPC_URL', { network: network.id }); }
}

export function createReadOnlyRpc(network, env = process.env) {
  const endpoint = rpcEndpoint(network, env);
  return {
    origin: endpoint.origin,
    async send(method, params = []) {
      requireThat(READ_METHODS.has(method), 'RPC_WRITE_METHOD_FORBIDDEN');
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(12000), redirect: 'error',
        });
      } catch (error) {
        throw new VerificationError(
          ['TimeoutError', 'AbortError'].includes(error?.name) ? 'RPC_TIMEOUT' : 'RPC_UNAVAILABLE',
          { network: network.id },
        );
      }
      requireThat(response.ok, 'RPC_HTTP_ERROR', { network: network.id, httpStatus: response.status });
      let body;
      try { body = await response.json(); }
      catch { throw new VerificationError('RPC_INVALID_JSON', { network: network.id }); }
      if (body?.error) throw new VerificationError('RPC_RESPONSE_ERROR', {
        network: network.id,
        ...(Number.isInteger(body.error.code) ? { rpcCode: body.error.code } : {}),
      });
      requireThat(body?.jsonrpc === '2.0' && body.id === 1 && Object.hasOwn(body, 'result'),
        'RPC_INVALID_ENVELOPE', { network: network.id });
      return body.result;
    },
  };
}

async function contractRead(rpc, contract, abi, method, args = [], blockTag = 'latest') {
  const data = abi.encodeFunctionData(method, args);
  const result = await rpc.send('eth_call', [{ to: contract, data }, blockTag]);
  try { return abi.decodeFunctionResult(method, result); }
  catch { throw new VerificationError('CONTRACT_RESPONSE_INVALID', { method }); }
}

async function enforceChain(rpc, expectedChainId) {
  const actual = uint(await rpc.send('eth_chainId'));
  requireThat(actual === expectedChainId && ALLOWED_CHAIN_IDS.has(actual), 'RPC_CHAIN_ID_MISMATCH');
  return actual;
}

export async function verifyClosure({
  coordinator, operationId, env = process.env, makeRpc = createReadOnlyRpc,
  interfaces = loadInterfaces(),
}) {
  const coordinatorAddress = address(coordinator, 'INVALID_COORDINATOR');
  const operation = hash(operationId, 'INVALID_OPERATION_ID');
  requireThat(operation !== ZeroHash, 'INVALID_OPERATION_ID');
  const coordinatorNetwork = networkFor(LASNA_CHAIN_ID);
  const coordinatorRpc = makeRpc(coordinatorNetwork, env);
  await enforceChain(coordinatorRpc, LASNA_CHAIN_ID);
  const code = await coordinatorRpc.send('eth_getCode', [coordinatorAddress, 'latest']);
  requireThat(typeof code === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(code), 'COORDINATOR_CODE_ABSENT');
  const commitment = await contractRead(coordinatorRpc, coordinatorAddress, interfaces.coordinator, 'commitments', [operation]);
  requirePending(commitment);
  const report = {
    schemaVersion: 1, checkedAt: new Date().toISOString(), mode: 'read-only',
    trust: TRUST_NOTICE, coordinatorChainId: LASNA_CHAIN_ID.toString(),
    coordinator: coordinatorAddress, operationId: operation,
    coordinatorRpcOrigin: coordinatorRpc.origin,
  };
  if (commitment.closureFinalized === true) {
    return { report: { ...report, status: 'already-finalized', broadcast: false } };
  }
  const [evidence, verifierResult] = await Promise.all([
    contractRead(coordinatorRpc, coordinatorAddress, interfaces.coordinator, 'closureEvidence', [operation]),
    contractRead(coordinatorRpc, coordinatorAddress, interfaces.coordinator, 'finalityVerifier'),
  ]);
  const finalityVerifier = address(verifierResult[0], 'FINALITY_VERIFIER_INVALID');
  const sourceNetwork = networkFor(evidence.chainId);
  const sourceRpc = makeRpc(sourceNetwork, env);
  const sourceChainId = await enforceChain(sourceRpc, BigInt(sourceNetwork.chainId));
  const txHash = toBeHex(uint(evidence.txHash), 32);
  const [receipt, canonicalBlock, finalizedBlock] = await Promise.all([
    sourceRpc.send('eth_getTransactionReceipt', [txHash]),
    sourceRpc.send('eth_getBlockByNumber', [toQuantity(uint(evidence.blockNumber)), false]),
    sourceRpc.send('eth_getBlockByNumber', ['finalized', false]),
  ]);
  requireThat(receipt, 'RECEIPT_MISSING');
  const finalizedNumber = blockNumber(finalizedBlock, 'FINALIZED_BLOCK_UNAVAILABLE');
  const finalizedHash = hash(finalizedBlock.hash, 'FINALIZED_BLOCK_HASH_INVALID');
  requireThat(finalizedNumber >= uint(evidence.blockNumber), 'SOURCE_BLOCK_NOT_FINALIZED');
  // EIP-1898 binds the state read to this exact canonical finalized checkpoint.
  // Unsupported block-hash state reads fail closed; there is no tag fallback.
  const permit = await contractRead(sourceRpc, address(evidence.vault), interfaces.vault, 'permits',
    [operation], { blockHash: finalizedHash, requireCanonical: true });
  const finalizedBlockAfter = await sourceRpc.send('eth_getBlockByNumber', [toQuantity(finalizedNumber), false]);
  const verified = validateClosureEvidence({
    operationId: operation, commitment, evidence, sourceChainId, receipt,
    canonicalBlock, finalizedBlock, finalizedBlockAfter, permit,
  }, interfaces.vault);
  return {
    report: {
      ...report, status: 'verified-read-only', broadcast: false, finalityVerifier,
      sourceRpcOrigin: sourceRpc.origin, evidence: verified,
    },
    verified, coordinatorAddress, coordinatorRpc, coordinatorNetwork,
    finalityVerifier, interfaces,
  };
}

function readScopedPrivateKey(env) {
  let privateKey = env.COMMITBOOK_TESTNET_PRIVATE_KEY;
  if (!privateKey) {
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(projectRoot, '.secrets', 'testnet-wallet.json'), 'utf8'));
      privateKey = stored.privateKey;
    } catch { throw new VerificationError('TESTNET_SIGNER_UNAVAILABLE'); }
  }
  requireThat(typeof privateKey === 'string' && /^0x[0-9a-f]{64}$/i.test(privateKey), 'TESTNET_SIGNER_INVALID');
  return privateKey;
}

export async function requireIdleSigner(provider, signerAddress) {
  const [latestRaw, pendingRaw] = await Promise.all([
    provider.send('eth_getTransactionCount', [signerAddress, 'latest']),
    provider.send('eth_getTransactionCount', [signerAddress, 'pending']),
  ]);
  const latest = uint(latestRaw);
  const pending = uint(pendingRaw);
  requireThat(pending >= latest, 'SIGNER_NONCE_STATE_INCONSISTENT');
  requireThat(pending === latest, 'SIGNER_HAS_PENDING_TRANSACTIONS', {
    latestNonce: latest.toString(), pendingNonce: pending.toString(),
  });
  requireThat(latest <= BigInt(Number.MAX_SAFE_INTEGER), 'SIGNER_NONCE_UNSUPPORTED');
  return Number(latest);
}

async function broadcastVerifiedLocked(result, env) {
  if (result.report.status === 'already-finalized') return result.report;
  const endpoint = rpcEndpoint(result.coordinatorNetwork, env);
  const provider = makeProvider(endpoint.href, Number(LASNA_CHAIN_ID));
  let signedTransactionHash;
  try {
    requireThat(uint(await provider.send('eth_chainId', [])) === LASNA_CHAIN_ID, 'RPC_CHAIN_ID_MISMATCH');
    const wallet = new Wallet(readScopedPrivateKey(env), provider);
    requireThat(sameAddress(wallet.address, result.finalityVerifier), 'SIGNER_NOT_CONFIGURED_VERIFIER');
    await enforceChain(result.coordinatorRpc, LASNA_CHAIN_ID);
    const nonce = await requireIdleSigner(provider, wallet.address);
    const transaction = await wallet.populateTransaction({
      to: result.coordinatorAddress, chainId: LASNA_CHAIN_ID, nonce,
      data: result.interfaces.coordinator.encodeFunctionData('finalizeClosure', [
        result.verified.operationId, result.verified.consumed, result.verified.proof,
      ]),
    });
    requireThat(uint(transaction.chainId) === LASNA_CHAIN_ID, 'TRANSACTION_CHAIN_ID_MISMATCH');
    // All transaction population happens before this last public state read.
    const currentCommitment = await contractRead(result.coordinatorRpc, result.coordinatorAddress,
      result.interfaces.coordinator, 'commitments', [result.verified.operationId]);
    if (assertPendingUnchanged(result.verified, currentCommitment).status === 'already-finalized') {
      return { ...result.report, status: 'already-finalized', broadcast: false };
    }
    const signed = await wallet.signTransaction(transaction);
    signedTransactionHash = keccak256(signed);
    const submitted = await provider.broadcastTransaction(signed);
    const receipt = await submitted.wait(1, 60000);
    requireThat(receipt && receipt.status === 1, 'FINALIZATION_TRANSACTION_FAILED');
    const finalCommitment = await contractRead(result.coordinatorRpc, result.coordinatorAddress,
      result.interfaces.coordinator, 'commitments', [result.verified.operationId]);
    requireThat(finalCommitment.closureFinalized === true, 'FINALIZATION_NOT_OBSERVED');
    return {
      ...result.report, mode: 'broadcast', status: 'finalized', broadcast: true,
      transactionHash: submitted.hash, transactionBlockNumber: receipt.blockNumber,
    };
  } catch (error) {
    if (signedTransactionHash) throw new VerificationError('BROADCAST_OUTCOME_REQUIRES_CHECK', {
      transactionHash: signedTransactionHash, cause: safeError(error).code,
    });
    throw error;
  } finally { provider.destroy(); }
}

async function broadcastVerified(result, env) {
  if (result.report.status === 'already-finalized') return result.report;
  const release = acquireWorkflowLock();
  try { return await broadcastVerifiedLocked(result, env); }
  finally { release(); }
}

export function safeError(error) {
  if (error instanceof VerificationError) return { code: error.code, ...error.details };
  if (error instanceof LiveError) return { code: error.code, ...error.detail };
  // Ethers errors may contain full RPC URLs, signed payloads or request bodies.
  const safeCodes = new Set(['INSUFFICIENT_FUNDS', 'CALL_EXCEPTION', 'TIMEOUT', 'NETWORK_ERROR',
    'NONCE_EXPIRED', 'REPLACEMENT_UNDERPRICED', 'TRANSACTION_REPLACED']);
  return { code: safeCodes.has(error?.code) ? error.code : 'VERIFICATION_UNAVAILABLE' };
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  let broadcast = false;
  for (let index = 0; index < args.length; index++) {
    switch (args[index]) {
      case '--coordinator': options.coordinator = args[++index]; break;
      case '--operation': options.operationId = args[++index]; break;
      case '--broadcast': broadcast = true; break;
      case '--help':
        console.log('Usage: node scripts/verify-closure.mjs --coordinator 0x... --operation 0x... [--broadcast]\n' +
          'Default: read-only finalized closure verification. Broadcast: configured verifier signs on Lasna only.\n' +
          TRUST_NOTICE);
        return;
      default: throw new VerificationError('UNKNOWN_ARGUMENT');
    }
  }
  requireThat(options.coordinator && options.operationId, 'COORDINATOR_AND_OPERATION_REQUIRED');
  const result = await verifyClosure(options);
  const report = broadcast ? await broadcastVerified(result, process.env) : result.report;
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.log(JSON.stringify({
      schemaVersion: 1, status: 'rejected', finalized: false,
      trust: TRUST_NOTICE, error: safeError(error),
    }, null, 2));
    process.exitCode = 1;
  });
}
