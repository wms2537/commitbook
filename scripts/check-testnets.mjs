#!/usr/bin/env node
/** Read-only testnet preflight. No wallet, key, dependency, signing, or transactions. */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const NETWORKS = Object.freeze([
  {
    id: 'lasna', name: 'Reactive Lasna', chainId: 5318007,
    rpc: 'https://lasna-rpc.rnk.dev/', env: 'LASNA_RPC_URL', symbol: 'lREACT',
    service: '0x8888888888888888888888888888888888888888', role: 'system',
  },
  {
    id: 'base-sepolia', name: 'Base Sepolia', chainId: 84532,
    rpc: 'https://sepolia.base.org', env: 'BASE_SEPOLIA_RPC_URL', symbol: 'ETH',
    service: '0x476F44b11F5C942c58f4c8E3d0300E5710743585', role: 'callback-proxy',
    faucet: '0x2afaFD298b23b62760711756088F75B7409f5967',
  },
  {
    id: 'unichain-sepolia', name: 'Unichain Sepolia', chainId: 1301,
    rpc: 'https://sepolia.unichain.org', env: 'UNICHAIN_SEPOLIA_RPC_URL', symbol: 'ETH',
    service: '0x775c9B990ADe401060B78D0e98684eEf8d2466C1', role: 'callback-proxy',
  },
]);

// First four bytes of Ethereum keccak256 of each documented getter signature.
const FEE_GETTERS = Object.freeze({
  coefficientPer1000: '0x2c16b16f', // _gasPriceCoeffPer1000()
  extraGas: '0xe5563728', // _extraGas()
  maxChargeGas: '0xe166e4f6', // _maxChargeGas()
});
const READ_METHODS = new Set([
  'eth_chainId', 'eth_getCode', 'eth_getBlockByNumber',
  'eth_gasPrice', 'eth_getBalance', 'eth_call',
]);
const HEX = /^0x[0-9a-f]+$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;

class PreflightError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

function failure(error) {
  if (error instanceof PreflightError) return { code: error.code, ...error.detail };
  if (['TimeoutError', 'AbortError'].includes(error?.name)) return { code: 'RPC_TIMEOUT' };
  // Provider messages, URLs, headers, and arbitrary metadata may contain secrets.
  const transportCode = error?.cause?.code;
  return {
    code: 'RPC_NETWORK_ERROR',
    ...(typeof transportCode === 'string' && /^[A-Z0-9_]{1,48}$/.test(transportCode)
      ? { transportCode } : {}),
  };
}

async function rpc(endpoint, method, params = []) {
  if (!READ_METHODS.has(method)) throw new PreflightError('WRITE_METHOD_FORBIDDEN');
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(12000), redirect: 'error',
  });
  if (!response.ok) throw new PreflightError('RPC_HTTP_ERROR', { httpStatus: response.status });
  let body;
  try { body = await response.json(); }
  catch { throw new PreflightError('RPC_INVALID_JSON'); }
  if (body?.error) {
    throw new PreflightError('RPC_RESPONSE_ERROR', {
      ...(Number.isInteger(body.error.code) ? { rpcCode: body.error.code } : {}),
    });
  }
  if (body?.jsonrpc !== '2.0' || body.id !== 1 || !Object.hasOwn(body, 'result')) {
    throw new PreflightError('RPC_INVALID_ENVELOPE');
  }
  return body.result;
}

function quantity(value) {
  if (typeof value !== 'string' || !HEX.test(value)) throw new PreflightError('RPC_INVALID_QUANTITY');
  return BigInt(value);
}

export function formatNative(wei) {
  const value = BigInt(wei);
  const whole = value / 10n ** 18n;
  const fraction = (value % (10n ** 18n)).toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

function blockInfo(value) {
  if (!value || !HASH.test(value.hash ?? '')) throw new PreflightError('RPC_INVALID_BLOCK');
  const seconds = quantity(value.timestamp);
  if (seconds > 8640000000000n) throw new PreflightError('RPC_INVALID_TIMESTAMP');
  const timestamp = new Date(Number(seconds) * 1000);
  if (Number.isNaN(timestamp.getTime())) throw new PreflightError('RPC_INVALID_TIMESTAMP');
  return {
    number: quantity(value.number).toString(), hash: value.hash,
    timestamp: timestamp.toISOString(),
    ...(value.baseFeePerGas ? { baseFeePerGasWei: quantity(value.baseFeePerGas).toString() } : {}),
  };
}

function codeInfo(code) {
  if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(code)) {
    throw new PreflightError('RPC_INVALID_BYTECODE');
  }
  if (code === '0x') throw new PreflightError('SERVICE_BYTECODE_ABSENT');
  return {
    byteLength: (code.length - 2) / 2,
    sha256: createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex'),
    check: 'nonempty-bytecode-only',
  };
}

export async function checkNetwork(network, { address, env = process.env } = {}) {
  const report = {
    id: network.id, name: network.name, expectedChainId: network.chainId,
    symbol: network.symbol, ok: false, errors: [], warnings: [],
  };
  let endpoint;
  try {
    endpoint = new URL(env[network.env] || network.rpc);
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error();
    // URL origins omit provider API keys in paths, queries, and user credentials.
    report.rpcOrigin = endpoint.origin;
  } catch {
    report.errors.push({ code: 'INVALID_RPC_URL', setting: network.env });
    return report;
  }
  try {
    const chainId = quantity(await rpc(endpoint, 'eth_chainId'));
    report.chainId = chainId.toString();
    if (chainId !== BigInt(network.chainId)) {
      throw new PreflightError('CHAIN_ID_MISMATCH');
    }
  } catch (error) {
    report.errors.push({ check: 'chainId', ...failure(error) });
    return report;
  }

  const jobs = [
    ['service', true, async () => ({
      address: network.service, role: network.role,
      ...codeInfo(await rpc(endpoint, 'eth_getCode', [network.service, 'latest'])),
    })],
    ['latestBlock', true, async () => blockInfo(await rpc(endpoint, 'eth_getBlockByNumber', ['latest', false]))],
    ['finalizedBlock', false, async () => blockInfo(await rpc(endpoint, 'eth_getBlockByNumber', ['finalized', false]))],
    ['gasPriceWei', true, async () => quantity(await rpc(endpoint, 'eth_gasPrice')).toString()],
    ['feeConfiguration', false, async () => Object.fromEntries(await Promise.all(
      Object.entries(FEE_GETTERS).map(async ([name, data]) => [name,
        quantity(await rpc(endpoint, 'eth_call', [{ to: network.service, data }, 'latest'])).toString(),
      ]),
    ))],
  ];
  if (network.faucet) jobs.push(['lasnaFaucet', false, async () => ({
    address: network.faucet,
    ...codeInfo(await rpc(endpoint, 'eth_getCode', [network.faucet, 'latest'])),
  })]);
  if (address) jobs.push(['signer', true, async () => {
    if (!ADDRESS.test(address)) throw new PreflightError('INVALID_PUBLIC_ADDRESS');
    const balance = quantity(await rpc(endpoint, 'eth_getBalance', [address, 'latest']));
    return { address, balanceWei: balance.toString(), balanceNative: formatNative(balance), hasFunds: balance > 0n };
  }]);

  const outcomes = await Promise.allSettled(jobs.map(([, , run]) => run()));
  for (const [index, outcome] of outcomes.entries()) {
    const [check, required] = jobs[index];
    if (outcome.status === 'fulfilled') report[check] = outcome.value;
    else report[required ? 'errors' : 'warnings'].push({ check, ...failure(outcome.reason) });
  }
  if (report.gasPriceWei) {
    const gasPrice = BigInt(report.gasPriceWei);
    const baseFee = BigInt(report.latestBlock?.baseFeePerGasWei ?? '0');
    const referencePrice = gasPrice > baseFee ? gasPrice : baseFee;
    report.costReferences = {
      gasOnlyForOneMillionUnitsNative: formatNative(gasPrice * 1000000n),
      referenceGasPriceWei: referencePrice.toString(),
      note: 'Reference arithmetic, not an estimateGas quote. Excludes L1 data fees and deployment-specific gas.',
    };
    if (report.feeConfiguration) {
      const { coefficientPer1000, extraGas } = report.feeConfiguration;
      report.costReferences.serviceFeeFor100000ExecutionGasNative = formatNative(
        referencePrice * BigInt(coefficientPer1000) * (100000n + BigInt(extraGas)) / 1000n,
      );
    }
  }
  report.ok = report.errors.length === 0;
  return report;
}

export async function runChecks({ address, networkIds, env = process.env } = {}) {
  if (address && !ADDRESS.test(address)) throw new PreflightError('INVALID_PUBLIC_ADDRESS');
  const networks = NETWORKS.filter(network => !networkIds || networkIds.includes(network.id));
  if (!networks.length || networkIds?.some(id => !NETWORKS.some(network => network.id === id))) {
    throw new PreflightError('UNKNOWN_NETWORK');
  }
  const checks = await Promise.all(networks.map(network => checkNetwork(network, { address, env })));
  return {
    schemaVersion: 1, checkedAt: new Date().toISOString(), readOnly: true,
    ok: checks.every(check => check.ok),
    funding: address ? {
      publicAddress: address,
      allSelectedNetworksHaveFunds: checks.every(check => check.signer?.hasFunds === true),
      note: 'A positive balance is not proof that the planned deployment is affordable.',
    } : { checked: false, note: 'Pass --address to inspect a public address. No private key is read.' },
    networks: checks,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  let requireFunded = false;
  for (let index = 0; index < args.length; index++) {
    switch (args[index]) {
      case '--address':
        options.address = args[++index];
        if (!options.address) throw new PreflightError('MISSING_PUBLIC_ADDRESS');
        break;
      case '--networks':
        options.networkIds = args[++index]?.split(',');
        if (!options.networkIds) throw new PreflightError('MISSING_NETWORKS');
        break;
      case '--require-funded': requireFunded = true; break;
      case '--help':
        console.log('Read-only preflight for Lasna, Base Sepolia, and Unichain Sepolia.\n' +
          'Usage: node scripts/check-testnets.mjs [--address 0x...] [--networks lasna,base-sepolia] [--require-funded]\n' +
          'RPC overrides: LASNA_RPC_URL, BASE_SEPOLIA_RPC_URL, UNICHAIN_SEPOLIA_RPC_URL.\n' +
          'Exit 0: connectivity checks pass; 1: check/configuration failure; 2: --require-funded is unmet.\n' +
          'Output is JSON. No .env or private key files are loaded.');
        return;
      default: throw new PreflightError('UNKNOWN_ARGUMENT');
    }
  }
  if (requireFunded && !options.address) throw new PreflightError('ADDRESS_REQUIRED_FOR_FUNDING_CHECK');
  const report = await runChecks(options);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = !report.ok ? 1
    : requireFunded && !report.funding.allSelectedNetworksHaveFunds ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.log(JSON.stringify({ schemaVersion: 1, readOnly: true, ok: false, error: failure(error) }, null, 2));
    process.exitCode = 1;
  });
}
