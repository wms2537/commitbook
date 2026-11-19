#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {isIP} from 'node:net';
import {ContractFactory, getAddress, getCreateAddress, keccak256, parseEther, ZeroAddress} from 'ethers';
import {compileContracts, getArtifact, projectRoot} from './compile.mjs';
import {NETWORKS} from './check-testnets.mjs';
import {sourceFingerprint} from './lib/source-fingerprint.mjs';
import {approvePublicPlan, canonicalJson, publicPlanSource, validatePublicLoopBinding} from './lib/public-plan.mjs';
import {BASE_ID, LASNA_ID, SDK_COMMIT, LiveError, safeError, makeProvider, disconnect, verifyDeployments, saveJson} from './lib/live.mjs';

export const METADATA_PATH = 'evidence/submission-input.json';
export const REPORT_PATH = 'evidence/submission-readiness.json';
const TEST_SOURCES = ['contracts', 'scripts', 'test', 'app', 'agent', 'package.json', 'package-lock.json'];
const PUBLIC_SOURCES = [...TEST_SOURCES, 'docs', 'README.md', 'LICENSE', 'THIRD_PARTY.md', '.gitignore'];
const DEFINITIONS = {inbox: [BASE_ID, 'CommitmentInbox'], coordinator: [LASNA_ID, 'CommitBookReactive'], token: [BASE_ID, 'DemoToken'], vault: [BASE_ID, 'CommitmentVault']};
const RECEIPTS = {
  sourceRequest: [BASE_ID, 'inbox', 'CommitmentRequested'],
  reactiveReservation: [LASNA_ID, 'coordinator', 'CommitmentReserved'],
  destinationGrant: [BASE_ID, 'vault', 'CommitmentGranted'],
  payment: [BASE_ID, 'vault', 'CommitmentExecuted'],
  reactiveSpend: [LASNA_ID, 'coordinator', 'SpendRecorded'],
  repeatedExecution: [BASE_ID, 'vault', null],
};
const requireThat = (condition, code, detail = {}) => {if (!condition) throw new LiveError(code, detail);};
const hash32 = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && !/^0{64}$/.test(value);
const positiveBlock = value => Number.isSafeInteger(value) && value > 0;
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
function address(value) {
  try {const result = getAddress(value); requireThat(result !== ZeroAddress, 'ZERO_PUBLIC_ADDRESS'); return result;}
  catch (error) {if (error instanceof LiveError) throw error; throw new LiveError('INVALID_PUBLIC_ADDRESS');}
}
const sameAddress = (left, right) => address(left) === address(right);
const sameHash = (left, right) => hash32(left) && hash32(right) && left.toLowerCase() === right.toLowerCase();

export function parseArgs(args) {
  const options = {online: false, metadata: METADATA_PATH};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--online') options.online = true;
    else if (args[index] === '--metadata' && args[index + 1]) options.metadata = args[++index];
    else if (args[index] === '--help') options.help = true;
    else throw new LiveError('UNKNOWN_ARGUMENT');
  }
  return options;
}

function checkReceipt(record, chainId) {
  requireThat(record && record.chainId === chainId && record.status === 1 && hash32(record.transactionHash)
    && positiveBlock(record.blockNumber) && hash32(record.blockHash) && uint(record.gasUsed) && BigInt(record.gasUsed) > 0n, 'PUBLIC_RECEIPT_INVALID');
}

export function checkDeployment(deployment) {
  requireThat(deployment, 'MISSING_PUBLIC_DEPLOYMENT');
  requireThat(deployment.schemaVersion === 1 && deployment.mode === 'public-testnet' && deployment.status === 'deployed'
    && deployment.sdkCommit === SDK_COMMIT && deployment.evmVersion === 'shanghai'
    && /^0\.8\.29\+commit\./.test(deployment.compiler ?? '')
    && deployment.chainIds?.base === BASE_ID && deployment.chainIds?.reactive === LASNA_ID, 'PUBLIC_DEPLOYMENT_INCOMPLETE');
  address(deployment.owner);
  requireThat(Object.keys(deployment.contracts ?? {}).length === 4, 'PUBLIC_CONTRACTS_INCOMPLETE');
  for (const [name, [chainId]] of Object.entries(DEFINITIONS)) {
    const record = deployment.contracts[name];
    requireThat(record && record.chainId === chainId && hash32(record.transactionHash) && positiveBlock(record.blockNumber)
      && hash32(record.blockHash) && hash32(record.codeHash) && hash32(record.creationCodeHash), 'PUBLIC_CONTRACT_RECORD_INVALID', {contract: name});
    address(record.address);
    const journal = deployment.transactions?.[`deploy-${name}`];
    requireThat(journal?.state === 'confirmed' && journal.chainId === chainId && sameHash(journal.transactionHash, record.transactionHash), 'PUBLIC_DEPLOYMENT_JOURNAL_MISMATCH', {contract: name});
  }
  requireThat(new Set(Object.values(deployment.contracts).map(record => address(record.address))).size === 4, 'PUBLIC_CONTRACT_ADDRESSES_REUSED');
  return deployment;
}

function checkAccounting(snapshot, spent, reserved) {
  requireThat(snapshot && snapshot.cap === '100' && snapshot.spent === String(spent) && snapshot.reserved === String(reserved)
    && snapshot.available === String(100n - BigInt(spent) - BigInt(reserved))
    && positiveBlock(snapshot.blockNumber) && hash32(snapshot.blockHash), 'PUBLIC_ACCOUNTING_INVALID');
}

export function checkPublicLoop(loop, deployment, plan, {source = publicPlanSource(), now = Date.now()} = {}) {
  requireThat(plan, 'MISSING_PUBLIC_AI_PLAN');
  requireThat(loop, 'MISSING_PUBLIC_LOOP');
  requireThat(loop.schemaVersion === 1 && loop.mode === 'public-testnet' && loop.status === 'public-testnet-loop-verified'
    && loop.publicTestnetExecution === true && loop.aiInference === true && hash32(loop.operationId), 'PUBLIC_AI_LOOP_INCOMPLETE');
  requireThat(sameAddress(loop.owner, deployment.owner), 'PUBLIC_LOOP_OWNER_MISMATCH');
  for (const name of Object.keys(DEFINITIONS)) requireThat(sameAddress(loop.contracts?.[name], deployment.contracts[name].address), 'PUBLIC_LOOP_CONTRACT_MISMATCH');
  const approved = approvePublicPlan(plan, {owner: deployment.owner, approvedDigest: loop.approval?.digest, source, now, allowExpired: true});
  validatePublicLoopBinding(approved, loop);
  const reviewedAt = Date.parse(loop.approval.reviewedAt), completedAt = Date.parse(loop.completedAt);
  requireThat(Number.isFinite(reviewedAt) && reviewedAt >= Date.parse(plan.createdAt) && reviewedAt <= Date.parse(plan.validUntil)
    && Number.isFinite(completedAt) && completedAt >= reviewedAt && completedAt <= now + 60_000, 'PUBLIC_APPROVAL_TIME_INVALID');
  const hashes = [];
  for (const [label, [chainId, name, event]] of Object.entries(RECEIPTS)) {
    const record = loop.evidence?.[label];
    requireThat(record, 'MISSING_PUBLIC_LOOP_RECEIPT', {receipt: label});
    checkReceipt(record, chainId);
    if (['reactiveReservation', 'destinationGrant', 'reactiveSpend'].includes(label)) {
      requireThat(record.event === event && sameAddress(record.emitter, loop.contracts[name])
        && Number.isSafeInteger(record.logIndex) && record.logIndex >= 0, 'PUBLIC_EVENT_REFERENCE_INVALID', {receipt: label});
    }
    hashes.push(record.transactionHash.toLowerCase());
  }
  requireThat(new Set(hashes).size === hashes.length, 'PUBLIC_RECEIPTS_REUSED');
  for (const [journalName, receiptName] of [['request', 'sourceRequest'], ['execute', 'payment'], ['repeat-execute', 'repeatedExecution']]) {
    const journal = loop.transactions?.[journalName];
    requireThat(journal?.state === 'confirmed' && journal.chainId === BASE_ID
      && sameHash(journal.transactionHash, loop.evidence[receiptName].transactionHash), 'PUBLIC_LOOP_JOURNAL_MISMATCH');
  }
  requireThat(canonicalJson(loop.evidence.payment.paymentTransfers) === canonicalJson([approved.amount])
    && canonicalJson(loop.evidence.repeatedExecution.paymentTransfers) === '[]', 'PUBLIC_PAYMENT_RECORD_INVALID');
  checkAccounting(loop.initialAccounting, 0, 0);
  checkAccounting(loop.finalAccounting, approved.amount, 0);
  requireThat(loop.finalAccounting.blockNumber >= loop.evidence.reactiveSpend.blockNumber, 'PUBLIC_ACCOUNTING_PRECEDES_SPEND');
  return approved;
}

export function collectSource(root = projectRoot) {
  const walk = relative => {
    const absolute = path.join(root, relative), stat = fs.lstatSync(absolute);
    requireThat(!stat.isSymbolicLink(), 'SOURCE_SYMLINK_UNSUPPORTED');
    return stat.isDirectory() ? fs.readdirSync(absolute).flatMap(name => walk(`${relative}/${name}`)) : [relative];
  };
  return [...new Set(PUBLIC_SOURCES.flatMap(walk))].sort().map(relative => {
    const bytes = fs.readFileSync(path.join(root, relative));
    return {path: relative, sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};
  });
}

function publicUrl(value) {
  let url;
  try {url = new URL(value);} catch {throw new LiveError('PUBLIC_HTTPS_URL_REQUIRED');}
  requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443')
    && !isIP(url.hostname.replace(/^\[|\]$/g, '')) && url.hostname.includes('.')
    && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname), 'PUBLIC_HTTPS_URL_REQUIRED');
  return url;
}

function repositoryLocation(repository) {
  requireThat(repository?.url && repository?.commit, 'MISSING_PUBLIC_SOURCE');
  const url = publicUrl(repository.url);
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
  requireThat(url.hostname === 'github.com' && !url.search && match && /^[a-f0-9]{40}$/.test(repository.commit)
    && !/^0{40}$/.test(repository.commit), 'PUBLIC_GITHUB_COMMIT_REQUIRED');
  return {owner: match[1], name: match[2], commit: repository.commit};
}

async function anonymousGet(url, fetchImpl, {accept = 'application/json', timeoutMs = 20_000} = {}) {
  let current = publicUrl(url);
  for (let count = 0; count <= 3; count++) {
    const response = await fetchImpl(current.href, {method: 'GET', redirect: 'manual', credentials: 'omit',
      headers: {accept, 'user-agent': 'CommitBook-read-only-submission-check'}, signal: AbortSignal.timeout(timeoutMs)});
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      requireThat(location && count < 3, 'PUBLIC_URL_REDIRECT_INVALID');
      await response.body?.cancel();
      current = publicUrl(new URL(location, current).href);
      continue;
    }
    requireThat(response.ok && response.status === 200, 'PUBLIC_URL_UNAVAILABLE', {httpStatus: response.status});
    return response;
  }
  throw new LiveError('PUBLIC_URL_REDIRECT_INVALID');
}

export async function verifyPublicSource(repository, files, {fetchImpl = fetch} = {}) {
  const location = repositoryLocation(repository), prefix = `https://api.github.com/repos/${location.owner}/${location.name}`;
  const json = async url => {
    const response = await anonymousGet(url, fetchImpl);
    const text = await response.text();
    requireThat(text.length <= 8_000_000, 'PUBLIC_REPOSITORY_RESPONSE_TOO_LARGE');
    try {return JSON.parse(text);} catch {throw new LiveError('PUBLIC_REPOSITORY_RESPONSE_INVALID');}
  };
  const info = await json(prefix);
  requireThat(info.private === false && info.full_name?.toLowerCase() === `${location.owner}/${location.name}`.toLowerCase(), 'REPOSITORY_NOT_PUBLIC');
  const commit = await json(`${prefix}/git/commits/${location.commit}`);
  requireThat(commit.sha === location.commit && /^[a-f0-9]{40}$/.test(commit.tree?.sha ?? ''), 'PUBLIC_COMMIT_NOT_FOUND');
  const tree = await json(`${prefix}/git/trees/${commit.tree.sha}?recursive=1`);
  requireThat(tree.sha === commit.tree.sha && tree.truncated === false && Array.isArray(tree.tree), 'PUBLIC_SOURCE_TREE_INCOMPLETE');
  const inScope = relative => PUBLIC_SOURCES.some(entry => relative === entry || relative.startsWith(`${entry}/`));
  const publicFiles = tree.tree.filter(entry => entry.type !== 'tree' && inScope(entry.path));
  requireThat(publicFiles.length === files.length && new Set(publicFiles.map(entry => entry.path)).size === files.length, 'PUBLIC_SOURCE_FILE_SET_MISMATCH');
  for (const file of files) {
    const entry = publicFiles.find(item => item.path === file.path);
    requireThat(entry?.type === 'blob' && ['100644', '100755'].includes(entry.mode) && entry.sha === file.sha,
      'PUBLIC_SOURCE_CONTENT_MISMATCH', {file: file.path});
  }
  return {url: `https://github.com/${location.owner}/${location.name}/tree/${location.commit}`, commit: location.commit, filesVerified: files.length};
}

export function probeVideo(file, {root = projectRoot, runProbe = spawnSync} = {}) {
  requireThat(typeof file === 'string' && file.length > 0, 'MISSING_VIDEO_FILE');
  const absolute = path.resolve(root, file);
  requireThat(fs.existsSync(absolute) && fs.statSync(absolute).isFile() && fs.statSync(absolute).size > 0, 'MISSING_VIDEO_FILE');
  const result = runProbe('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', absolute],
    {encoding: 'utf8', timeout: 20_000, maxBuffer: 1_000_000, shell: false});
  requireThat(!result.error && result.status === 0, 'VIDEO_PROBE_FAILED');
  let measured;
  try {measured = JSON.parse(result.stdout);} catch {throw new LiveError('VIDEO_METADATA_INVALID');}
  const durationSeconds = Number(measured.format?.duration);
  requireThat(Number.isFinite(durationSeconds) && durationSeconds > 0 && durationSeconds < 180
    && measured.streams?.some(stream => stream.codec_type === 'video'), 'VIDEO_MUST_BE_UNDER_180_SECONDS');
  const bytes = fs.readFileSync(absolute);
  return {durationSeconds, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
}

export async function verifyPublicVideo(url, local, {fetchImpl = fetch} = {}) {
  const response = await anonymousGet(url, fetchImpl, {accept: 'video/*, application/octet-stream', timeoutMs: 30_000});
  requireThat(/^(video\/|application\/octet-stream(?:;|$))/.test(response.headers.get('content-type') ?? ''), 'DIRECT_PUBLIC_VIDEO_REQUIRED');
  const length = response.headers.get('content-length');
  requireThat(length === null || Number(length) === local.bytes, 'PUBLIC_VIDEO_BYTES_MISMATCH');
  requireThat(response.body, 'PUBLIC_VIDEO_BODY_MISSING');
  let bytes = 0;
  const hash = createHash('sha256'), reader = response.body.getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      requireThat(bytes <= local.bytes, 'PUBLIC_VIDEO_BYTES_MISMATCH');
      hash.update(part.value);
    }
  } finally {await reader.cancel();}
  requireThat(bytes === local.bytes && hash.digest('hex') === local.sha256, 'PUBLIC_VIDEO_BYTES_MISMATCH');
  return {...local, url};
}

function officialChains() {
  return Object.fromEntries([BASE_ID, LASNA_ID].map(chainId => {
    const config = NETWORKS.find(network => network.chainId === chainId);
    return [chainId, {...config, provider: makeProvider(config.rpc, chainId)}];
  }));
}

export function compileVerifiedSource({runGit = spawnSync} = {}) {
  // The public source retrieves this dependency by its pinned commit. Recheck
  // the installed checkout now; the original-source fingerprint excludes lib/.
  const directory = path.join(projectRoot, 'lib/reactive-lib-omni');
  const readGit = args => {
    const result = runGit('git', ['-C', directory, ...args], {encoding: 'utf8', timeout: 10_000, maxBuffer: 1_000_000,
      shell: false, env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}});
    requireThat(!result.error && result.status === 0, 'PINNED_REACTIVE_SDK_UNAVAILABLE');
    return result.stdout.trim();
  };
  requireThat(readGit(['rev-parse', 'HEAD']) === SDK_COMMIT && readGit(['status', '--porcelain', '--untracked-files=all']) === '', 'PINNED_REACTIVE_SDK_CHANGED');
  return compileContracts();
}

async function canonicalReceipt(provider, record) {
  const receipt = await provider.getTransactionReceipt(record.transactionHash);
  requireThat(receipt && receipt.status === 1 && sameHash(receipt.hash, record.transactionHash)
    && receipt.blockNumber === record.blockNumber && sameHash(receipt.blockHash, record.blockHash), 'PUBLIC_RECEIPT_NOT_FOUND_OR_CHANGED');
  const block = await provider.getBlock(receipt.blockNumber);
  requireThat(block && sameHash(block.hash, receipt.blockHash), 'PUBLIC_RECEIPT_NOT_CANONICAL');
  return receipt;
}

function decodedEvents(receipt, contract, name) {
  return receipt.logs.filter(log => sameAddress(log.address, contract.target)).flatMap(log => {
    let event;
    try {event = contract.interface.parseLog(log);} catch {return [];}
    return event?.name === name ? [{log, args: event.args}] : [];
  });
}

export async function verifyPublicChains({deployment, loop}, {createChains = officialChains, compile = compileVerifiedSource} = {}) {
  const chains = createChains();
  try {
    for (const chainId of [BASE_ID, LASNA_ID]) requireThat(BigInt(await chains[chainId].provider.send('eth_chainId', [])) === BigInt(chainId), 'PUBLIC_CHAIN_ID_MISMATCH');
    const compiled = compile();
    requireThat(compiled.compiler === deployment.compiler, 'PUBLIC_DEPLOYMENT_COMPILER_MISMATCH');
    const contracts = await verifyDeployments(deployment, chains, compiled);
    const values = {inbox: 0n, coordinator: parseEther('0.1'), token: 0n, vault: parseEther('0.0001')};
    const args = {inbox: [deployment.owner], coordinator: [deployment.owner, deployment.owner, 100n, BASE_ID, loop.contracts.inbox],
      token: [], vault: [loop.contracts.token, chains[BASE_ID].service, loop.contracts.coordinator]};
    for (const [name, [chainId, contractName]] of Object.entries(DEFINITIONS)) {
      const record = deployment.contracts[name], provider = chains[chainId].provider;
      await canonicalReceipt(provider, record);
      const transaction = await provider.getTransaction(record.transactionHash);
      const artifact = getArtifact(compiled, contractName);
      const expected = await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(...args[name], {value: values[name]});
      requireThat(transaction && sameHash(transaction.hash, record.transactionHash) && transaction.to === null
        && sameAddress(transaction.from, deployment.owner) && BigInt(transaction.chainId) === BigInt(chainId)
        && transaction.data === expected.data && transaction.value === values[name]
        && sameHash(keccak256(transaction.data), record.creationCodeHash)
        && sameAddress(getCreateAddress({from: transaction.from, nonce: transaction.nonce}), record.address), 'PUBLIC_DEPLOYED_SOURCE_MISMATCH', {contract: name});
    }
    requireThat(sameAddress(await contracts.coordinator.vaults(BASE_ID), loop.contracts.vault)
      && await contracts.inbox.suppliers(loop.recipient), 'PUBLIC_ROUTE_NOT_CONFIGURED');
    const receipts = {};
    for (const [label, [chainId, contractName, eventName]] of Object.entries(RECEIPTS)) {
      const record = loop.evidence[label], receipt = await canonicalReceipt(chains[chainId].provider, record);
      requireThat(receipt.gasUsed.toString() === record.gasUsed, 'PUBLIC_RECEIPT_GAS_MISMATCH');
      receipts[label] = receipt;
      if (!eventName) continue;
      const matches = decodedEvents(receipt, contracts[contractName], eventName).filter(event => sameHash(event.args.id, loop.operationId));
      requireThat(matches.length === 1, 'PUBLIC_EXPECTED_EVENT_MISSING', {receipt: label});
      const {args: event, log} = matches[0];
      if (record.logIndex !== undefined) requireThat(log.index === record.logIndex, 'PUBLIC_EVENT_INDEX_MISMATCH');
      requireThat(event.amount === BigInt(loop.amount), 'PUBLIC_EVENT_AMOUNT_MISMATCH');
      if (['sourceRequest', 'reactiveReservation', 'destinationGrant'].includes(label)) requireThat(sameAddress(event.recipient, loop.recipient)
        && event.expiresAt === BigInt(loop.expiresAt), 'PUBLIC_EVENT_TERMS_MISMATCH');
      if (label === 'sourceRequest') requireThat(event.destinationChainId === BigInt(BASE_ID), 'PUBLIC_EVENT_CHAIN_MISMATCH');
      if (label === 'reactiveReservation') requireThat(event.chainId === BigInt(BASE_ID) && sameAddress(event.vault, loop.contracts.vault), 'PUBLIC_EVENT_ROUTE_MISMATCH');
    }
    for (const [label, contract, method, parameters] of [
      ['sourceRequest', contracts.inbox, 'request', [loop.operationId, BASE_ID, loop.recipient, BigInt(loop.amount), loop.expiresAt]],
      ['payment', contracts.vault, 'execute', [loop.operationId]], ['repeatedExecution', contracts.vault, 'execute', [loop.operationId]],
    ]) {
      const transaction = await chains[BASE_ID].provider.getTransaction(loop.evidence[label].transactionHash);
      requireThat(transaction && sameAddress(transaction.from, loop.owner) && sameAddress(transaction.to, contract.target)
        && BigInt(transaction.chainId) === BigInt(BASE_ID) && transaction.value === 0n
        && transaction.data === contract.interface.encodeFunctionData(method, parameters), 'PUBLIC_OPERATION_CALL_MISMATCH', {receipt: label});
    }
    const transfers = decodedEvents(receipts.payment, contracts.token, 'Transfer');
    requireThat(transfers.length === 1 && sameAddress(transfers[0].args.from, loop.contracts.vault)
      && sameAddress(transfers[0].args.to, loop.recipient) && transfers[0].args.amount === BigInt(loop.amount), 'PUBLIC_PAYMENT_TRANSFER_MISMATCH');
    requireThat(decodedEvents(receipts.repeatedExecution, contracts.token, 'Transfer').length === 0
      && decodedEvents(receipts.repeatedExecution, contracts.vault, 'CommitmentExecuted').length === 0, 'PUBLIC_REPLAY_PAID_AGAIN');
    for (const snapshot of [loop.initialAccounting, loop.finalAccounting]) {
      const provider = chains[LASNA_ID].provider;
      requireThat(sameHash((await provider.getBlock(snapshot.blockNumber))?.hash, snapshot.blockHash), 'PUBLIC_ACCOUNTING_NOT_CANONICAL');
      const actual = await Promise.all(['budgetCap', 'totalSpent', 'totalReserved', 'availableBudget'].map(method => contracts.coordinator[method]({blockTag: snapshot.blockNumber})));
      requireThat(canonicalJson(actual.map(String)) === canonicalJson([snapshot.cap, snapshot.spent, snapshot.reserved, snapshot.available]), 'PUBLIC_ACCOUNTING_STATE_MISMATCH');
      requireThat(sameHash((await provider.getBlock(snapshot.blockNumber))?.hash, snapshot.blockHash), 'PUBLIC_ACCOUNTING_NOT_CANONICAL');
    }
    return {chainIds: [BASE_ID, LASNA_ID], deploymentReceiptsVerified: 4, loopReceiptsVerified: 6, operationId: loop.operationId};
  } finally {disconnect(chains);}
}

export async function checkSubmission(inputs, options = {}) {
  const {online = false, now = Date.now(), fetchImpl = fetch, probe = probeVideo, createChains = officialChains,
    compile = compileVerifiedSource, source = publicPlanSource(), sourceFiles = collectSource(),
    verificationSha = sourceFingerprint(TEST_SOURCES).sha256} = options;
  const checks = [];
  async function gate(id, action, check) {
    try {const result = await check(); checks.push({id, status: result.pending ? 'pending' : 'pass', ...result, ...(result.pending ? {action} : {})}); return !result.pending;}
    catch (error) {const detail = safeError(error); checks.push({id, status: detail.code.startsWith('MISSING_') ? 'pending' : 'fail', ...detail, action}); return false;}
  }
  await gate('local-verification', 'Run npm run verify against the current source.', () => {
    const value = inputs.verification;
    requireThat(value, 'MISSING_LOCAL_VERIFICATION');
    requireThat(value.success === true && value.mode === 'local-evm-and-mocked-finality' && value.publicTestnetExecution === false
      && value.testProcessExitCode === 0 && value.demoExitCode === 0 && value.testsFailed === 0
      && value.reactiveSdkRevision === SDK_COMMIT
      && Number.isSafeInteger(value.testsPassed) && value.testsPassed > 0, 'LOCAL_VERIFICATION_FAILED');
    requireThat(digest(value.sourceSha256) && value.sourceSha256 === verificationSha, 'LOCAL_VERIFICATION_STALE');
    return {code: 'CURRENT_LOCAL_TESTS_PASSED', testsPassed: value.testsPassed};
  });
  const deploymentOkay = await gate('public-deployment', 'Fund the scoped Base Sepolia and Lasna wallet, then complete scripts/deploy-testnet.mjs.', () => {
    checkDeployment(inputs.deployment); return {code: 'PUBLIC_DEPLOYMENT_STRUCTURE_VALID'};
  });
  const loopOkay = await gate('model-public-loop', 'Run scripts/live-agent.mjs --prepare, review its digest, then complete the approved public loop and preserve all six receipts.', () => {
    requireThat(deploymentOkay, 'MISSING_VERIFIABLE_PUBLIC_DEPLOYMENT');
    checkPublicLoop(inputs.loop, inputs.deployment, inputs.plan, {source, now});
    return {code: 'MODEL_APPROVAL_AND_PUBLIC_LOOP_BOUND', operationId: inputs.loop.operationId};
  });
  await gate('public-source', 'Publish the current original source in a public GitHub repository. Record its immutable commit in evidence/submission-input.json, then rerun with --online.', async () => {
    requireThat(inputs.metadata?.schemaVersion === 1, 'MISSING_SUBMISSION_METADATA');
    repositoryLocation(inputs.metadata.repository);
    if (!online) return {pending: true, code: 'ONLINE_SOURCE_CHECK_REQUIRED'};
    return {code: 'PUBLIC_COMMIT_CONTENTS_VERIFIED', ...await verifyPublicSource(inputs.metadata.repository, sourceFiles, {fetchImpl})};
  });
  await gate('submission-video', 'Record the completed public loop in a final video under 180 seconds. Set video.scope to submission, provide its local path and a direct public HTTPS file URL, then rerun with --online.', async () => {
    const video = inputs.metadata?.video;
    requireThat(video?.scope === 'submission', video?.scope === 'local-preview' ? 'FINAL_PUBLIC_PROOF_VIDEO_REQUIRED' : 'MISSING_SUBMISSION_VIDEO');
    const measured = probe(video.path);
    requireThat(video.url, 'MISSING_PUBLIC_VIDEO_URL');
    publicUrl(video.url);
    if (!online) return {pending: true, code: 'ONLINE_VIDEO_CHECK_REQUIRED', ...measured};
    return {code: 'PUBLIC_VIDEO_BYTES_AND_DURATION_VERIFIED', ...await verifyPublicVideo(video.url, measured, {fetchImpl})};
  });
  await gate('public-chain-receipts', 'Complete the model-linked public loop and rerun with --online. Local demos, preflights, historical flags, and deployment-only evidence cannot satisfy this gate.', async () => {
    requireThat(deploymentOkay && loopOkay, 'MISSING_VERIFIABLE_PUBLIC_LOOP');
    if (!online) return {pending: true, code: 'ONLINE_CHAIN_CHECK_REQUIRED'};
    return {code: 'CANONICAL_PUBLIC_EXECUTION_VERIFIED', ...await verifyPublicChains(inputs, {createChains, compile})};
  });
  const ready = online && checks.every(check => check.status === 'pass');
  const onlyOnlinePending = checks.every(check => check.status === 'pass' || ['ONLINE_SOURCE_CHECK_REQUIRED', 'ONLINE_VIDEO_CHECK_REQUIRED', 'ONLINE_CHAIN_CHECK_REQUIRED'].includes(check.code));
  return {
    schemaVersion: 1, checkedAt: new Date(now).toISOString(), mode: online ? 'online-read-only' : 'offline',
    status: ready ? 'ready-to-submit' : onlyOnlinePending ? 'pending-online-verification' : 'blocked', ready,
    scope: 'Reactive Meets AI; Base Sepolia origin and destination, Lasna coordinator.', checks,
    pendingFacts: checks.filter(check => check.status !== 'pass').map(({id, code, action}) => ({id, code, action})),
    limits: ['Ready means the recorded materials passed these checks, not that a DoraHacks entry was submitted.',
      'RPC-reported canonical receipts are trusted observations, not cryptographic finality proofs.',
      'Model metadata and approval digests establish recorded source and operation binding, not cryptographic proof of inference or a human signature.'],
  };
}

export async function run(options = {}) {
  const read = file => {
    if (!fs.existsSync(file)) return null;
    try {return JSON.parse(fs.readFileSync(file, 'utf8'));} catch {return {invalidJson: true};}
  };
  const report = await checkSubmission({
    metadata: read(path.resolve(projectRoot, options.metadata ?? METADATA_PATH)),
    verification: read(path.join(projectRoot, 'evidence/verification.json')),
    deployment: read(path.join(projectRoot, 'evidence/testnet-deployment.json')),
    loop: read(path.join(projectRoot, 'evidence/testnet-loop.json')),
    plan: read(path.join(projectRoot, 'evidence/testnet-ai-plan.json')),
  }, {online: options.online === true});
  saveJson(path.join(projectRoot, REPORT_PATH), report);
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/check-submission.mjs [--online] [--metadata evidence/submission-input.json]\n'
      + 'Writes evidence/submission-readiness.json. Default is offline and can never declare ready.\n'
      + 'Metadata: {schemaVersion:1,repository:{url:"https://github.com/OWNER/REPO",commit:"40-char-sha"},video:{scope:"submission",path:"demo.mp4",url:"https://public-host/demo.mp4"}}\n'
      + '--online anonymously verifies immutable GitHub source, exact public video bytes, deployment transactions, canonical public events, payment, replay, and accounting.\n'
      + 'No wallet files, signing, broadcasts, logins, or mutations of public services. Exit 0 means ready, 2 means pending/blocked, 1 means checker error.');
    return;
  }
  const report = await run(options);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {console.log(JSON.stringify({status: 'checker-error', ready: false, error: safeError(error)})); process.exitCode = 1;});
}
