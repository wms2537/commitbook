import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ContractFactory, Interface, getAddress, getCreateAddress, id, keccak256, parseEther} from 'ethers';
import {compileContracts, getArtifact} from '../scripts/compile.mjs';
import {NETWORKS} from '../scripts/check-testnets.mjs';
import {BASE_ID, LASNA_ID, SDK_COMMIT} from '../scripts/lib/live.mjs';
import {buildMessages, validateProposal, DEFAULT_MODEL} from '../agent/planner.mjs';
import {resolveIntent, PLANNER_VERSION} from '../agent/intent.mjs';
import {createPublicPlan, publicOperationId, publicPlanningInput, publicPlanSource} from '../scripts/lib/public-plan.mjs';
import {checkSubmission, collectSource, compileVerifiedSource, parseArgs, probeVideo, verifyPublicSource, verifyPublicVideo} from '../scripts/check-submission.mjs';

// Every public chain response, hosted response, inference record, and video probe
// in these fixtures is explicitly mocked. They are boundary tests, never public
// execution or neural-quality evidence, and are not written into evidence/.
const now = Date.parse('2026-11-19T12:00:00Z');
const owner = getAddress('0x1111111111111111111111111111111111111111');
const commit = 'a'.repeat(40), treeHash = 'b'.repeat(40);
const fakeVideo = Buffer.from('MOCK VIDEO BYTES FOR BOUNDARY TESTS ONLY');
const videoMeasurement = {durationSeconds: 92.5, bytes: fakeVideo.length, sha256: createHash('sha256').update(fakeVideo).digest('hex')};
const verificationSha = 'c'.repeat(64);
const clone = value => structuredClone(value);
let compiled;

async function fixture() {
  compiled ??= compileContracts();
  const source = publicPlanSource(), sourceFiles = collectSource();
  const input = publicPlanningInput('Extract invoice fields privately within 120 seconds.', owner);
  const interpretation = {service: 'invoice-extraction', privacy: 'private', priority: 'fastest', failureType: 'none', reason: 'Controlled fixture response.'};
  const result = {...validateProposal(resolveIntent(interpretation, input), input), interpretation,
    inference: {performed: true, provider: 'local-llama.cpp-stdio', model: DEFAULT_MODEL, plannerVersion: PLANNER_VERSION,
      durationMs: 100, inputTokens: 120, outputTokens: 40, promptSha256: createHash('sha256').update(JSON.stringify(buildMessages(input))).digest('hex')}};
  const plan = createPublicPlan({goal: input.goal, owner, result, source, now: now - 60_000});
  const addresses = {
    inbox: getCreateAddress({from: owner, nonce: 1}), coordinator: getCreateAddress({from: owner, nonce: 0}),
    token: getCreateAddress({from: owner, nonce: 2}), vault: getCreateAddress({from: owner, nonce: 3}),
  };
  const blockHash = (chain, number) => id(`MOCK BLOCK ${chain} ${number}`);
  const interfaces = Object.fromEntries(Object.entries({inbox: 'CommitmentInbox', coordinator: 'CommitBookReactive', token: 'DemoToken', vault: 'CommitmentVault'})
    .map(([name, contract]) => [name, new Interface(getArtifact(compiled, contract).abi)]));
  const backends = Object.fromEntries([BASE_ID, LASNA_ID].map(chainId => [chainId, {receipts: new Map(), transactions: new Map(), code: new Map(), calls: [], blockHash}]));
  const chainIds = {inbox: BASE_ID, coordinator: LASNA_ID, token: BASE_ID, vault: BASE_ID};
  const deployment = {schemaVersion: 1, mode: 'public-testnet', status: 'deployed', owner, sdkCommit: SDK_COMMIT,
    compiler: compiled.compiler, evmVersion: 'shanghai', chainIds: {base: BASE_ID, reactive: LASNA_ID}, contracts: {}, transactions: {}};
  const callback = NETWORKS.find(network => network.chainId === BASE_ID).service;
  const constructorArgs = {inbox: [owner], coordinator: [owner, owner, 100n, BASE_ID, addresses.inbox], token: [], vault: [addresses.token, callback, addresses.coordinator]};
  const values = {inbox: 0n, coordinator: parseEther('0.1'), token: 0n, vault: parseEther('0.0001')};
  const nonces = {inbox: 1, coordinator: 0, token: 2, vault: 3};
  for (const [name, contractName] of Object.entries({inbox: 'CommitmentInbox', coordinator: 'CommitBookReactive', token: 'DemoToken', vault: 'CommitmentVault'})) {
    const chainId = chainIds[name], artifact = getArtifact(compiled, contractName);
    const expected = await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(...constructorArgs[name], {value: values[name]});
    const hash = id(`MOCK DEPLOY ${name}`), blockNumber = 90 + nonces[name], code = `0x600${nonces[name]}00`;
    backends[chainId].code.set(addresses[name], code);
    backends[chainId].receipts.set(hash, {hash, status: 1, blockNumber, blockHash: blockHash(chainId, blockNumber), contractAddress: addresses[name], logs: [], gasUsed: 100n});
    backends[chainId].transactions.set(hash, {hash, to: null, from: owner, nonce: nonces[name], data: expected.data, value: values[name], chainId: BigInt(chainId)});
    deployment.contracts[name] = {address: addresses[name], transactionHash: hash, blockNumber, blockHash: blockHash(chainId, blockNumber), chainId,
      codeHash: keccak256(code), creationCodeHash: keccak256(expected.data)};
    deployment.transactions[`deploy-${name}`] = {state: 'confirmed', chainId, transactionHash: hash};
  }
  const operationId = publicOperationId(plan, addresses.coordinator), expiresAt = Math.floor(Date.parse(plan.validUntil) / 1000);
  const accounting = (blockNumber, spent) => ({cap: '100', reserved: '0', spent: String(spent), available: String(100 - spent), blockNumber, blockHash: blockHash(LASNA_ID, blockNumber)});
  const loop = {schemaVersion: 1, mode: 'public-testnet', status: 'public-testnet-loop-verified', publicTestnetExecution: true, aiInference: true,
    owner, contracts: addresses, chainIds: {origin: BASE_ID, reactive: LASNA_ID, destination: BASE_ID}, operationId, amount: '60', recipient: owner, expiresAt,
    publicPlan: clone(plan), approval: {digest: plan.sha256, method: 'explicit-cli-digest', reviewedAt: new Date(now - 50_000).toISOString()},
    completedAt: new Date(now - 10_000).toISOString(), initialAccounting: accounting(99, 0), finalAccounting: accounting(120, 60), evidence: {}, transactions: {}};
  function log(name, event, args, receipt, index = 0) {
    const encoded = interfaces[name].encodeEventLog(interfaces[name].getEvent(event), args);
    return {...encoded, address: addresses[name], index, transactionHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash};
  }
  const specs = {
    sourceRequest: [BASE_ID, 110, 'inbox', 'CommitmentRequested', [operationId, BASE_ID, owner, 60n, expiresAt]],
    reactiveReservation: [LASNA_ID, 110, 'coordinator', 'CommitmentReserved', [operationId, BASE_ID, addresses.vault, owner, 60n, expiresAt]],
    destinationGrant: [BASE_ID, 115, 'vault', 'CommitmentGranted', [operationId, owner, 60n, expiresAt]],
    payment: [BASE_ID, 120, 'vault', 'CommitmentExecuted', [operationId, 60n]],
    reactiveSpend: [LASNA_ID, 115, 'coordinator', 'SpendRecorded', [operationId, 60n]],
    repeatedExecution: [BASE_ID, 125, 'vault', null, []],
  };
  for (const [label, [chainId, blockNumber, name, event, args]] of Object.entries(specs)) {
    const hash = id(`MOCK PUBLIC RECEIPT ${label}`);
    const receipt = {hash, status: 1, blockNumber, blockHash: blockHash(chainId, blockNumber), gasUsed: 45_000n, logs: []};
    if (event) receipt.logs.push(log(name, event, args, receipt));
    if (label === 'payment') receipt.logs.push(log('token', 'Transfer', [addresses.vault, owner, 60n], receipt, 1));
    backends[chainId].receipts.set(hash, receipt);
    loop.evidence[label] = {transactionHash: hash, blockNumber, blockHash: receipt.blockHash, chainId, status: 1, gasUsed: '45000',
      ...(['reactiveReservation', 'destinationGrant', 'reactiveSpend'].includes(label) ? {event, emitter: addresses[name], logIndex: 0} : {}),
      ...(label === 'payment' ? {paymentTransfers: ['60']} : label === 'repeatedExecution' ? {paymentTransfers: []} : {})};
  }
  for (const [journal, label, name, method, args] of [
    ['request', 'sourceRequest', 'inbox', 'request', [operationId, BASE_ID, owner, 60n, expiresAt]],
    ['execute', 'payment', 'vault', 'execute', [operationId]], ['repeat-execute', 'repeatedExecution', 'vault', 'execute', [operationId]],
  ]) {
    const hash = loop.evidence[label].transactionHash;
    loop.transactions[journal] = {state: 'confirmed', chainId: BASE_ID, transactionHash: hash};
    backends[BASE_ID].transactions.set(hash, {hash, from: owner, to: addresses[name], chainId: BigInt(BASE_ID), value: 0n, data: interfaces[name].encodeFunctionData(method, args)});
  }
  const createChains = () => Object.fromEntries([BASE_ID, LASNA_ID].map(chainId => {
    const backend = backends[chainId];
    const provider = {
      async send(method) {backend.calls.push(method); assert.equal(method, 'eth_chainId'); return `0x${chainId.toString(16)}`;},
      async getCode(target) {return backend.code.get(getAddress(target)) ?? '0x';},
      async getTransactionReceipt(hash) {return backend.receipts.get(hash) ?? null;},
      async getTransaction(hash) {return backend.transactions.get(hash) ?? null;},
      async getBlock(number) {return {number, hash: backend.blockHash(chainId, number)};},
      async call(transaction) {
        const name = Object.keys(addresses).find(key => addresses[key] === getAddress(transaction.to));
        const decoded = interfaces[name].parseTransaction({data: transaction.data});
        const spent = transaction.blockTag === 99 ? 0n : 60n;
        const answers = {owner, finalityVerifier: owner, originChainId: BigInt(BASE_ID), originInbox: addresses.inbox, budgetCap: 100n,
          token: addresses.token, _CALLBACK_SENDER: addresses.coordinator, _SERVICE_PROVIDER: callback, vaults: addresses.vault, suppliers: true,
          totalSpent: spent, totalReserved: 0n, availableBudget: 100n - spent};
        assert.ok(Object.hasOwn(answers, decoded.name), `Unexpected mocked call ${decoded.name}`);
        return interfaces[name].encodeFunctionResult(decoded.name, [answers[decoded.name]]);
      },
      destroy() {},
    };
    return [chainId, {...NETWORKS.find(network => network.chainId === chainId), provider}];
  }));
  const metadata = {schemaVersion: 1, repository: {url: 'https://github.com/test-owner/commitbook', commit},
    video: {scope: 'submission', path: 'mocked-video.mp4', url: `https://raw.githubusercontent.com/test-owner/commitbook/${commit}/demo/mock.mp4`}};
  const inputs = {metadata, deployment, loop, plan, verification: {success: true, mode: 'local-evm-and-mocked-finality', publicTestnetExecution: false,
    testProcessExitCode: 0, demoExitCode: 0, testsFailed: 0, testsPassed: 10, reactiveSdkRevision: SDK_COMMIT, sourceSha256: verificationSha}};
  const publicTree = {sha: treeHash, truncated: false, tree: sourceFiles.map(file => ({...file, type: 'blob', mode: '100644'}))};
  const fetchImpl = async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit'); assert.equal(init.headers.authorization, undefined);
    if (url === metadata.video.url) return new Response(fakeVideo, {headers: {'content-type': 'video/mp4', 'content-length': String(fakeVideo.length)}});
    let value;
    if (url === 'https://api.github.com/repos/test-owner/commitbook') value = {private: false, full_name: 'test-owner/commitbook'};
    else if (url.endsWith(`/git/commits/${commit}`)) value = {sha: commit, tree: {sha: treeHash}};
    else if (url.endsWith(`/git/trees/${treeHash}?recursive=1`)) value = publicTree;
    else throw new Error(`Unexpected mocked URL ${url}`);
    return Response.json(value);
  };
  const options = {online: true, now, source, sourceFiles, verificationSha, probe: () => clone(videoMeasurement), compile: () => compiled, createChains, fetchImpl};
  return {inputs, options, backends, publicTree, log, interfaces};
}

test('missing public materials remain actionable and never inherit local success flags', async () => {
  const {inputs, options} = await fixture();
  const report = await checkSubmission({verification: inputs.verification, loop: {mode: 'local-evm', publicTestnetExecution: true, aiInference: true}}, {...options, online: false});
  assert.equal(report.ready, false); assert.equal(report.status, 'blocked');
  assert.ok(report.pendingFacts.some(item => item.code === 'MISSING_PUBLIC_DEPLOYMENT'));
  assert.ok(report.pendingFacts.some(item => item.code === 'MISSING_SUBMISSION_METADATA'));
  assert.ok(report.pendingFacts.every(item => item.action.length > 20));
});

test('complete offline fixtures still require online verification', async () => {
  const {inputs, options} = await fixture();
  const report = await checkSubmission(inputs, {...options, online: false, fetchImpl: () => assert.fail('Offline mode used HTTP'), createChains: () => assert.fail('Offline mode used an RPC')});
  assert.equal(report.status, 'pending-online-verification'); assert.equal(report.ready, false);
  assert.deepEqual(report.pendingFacts.map(item => item.code).sort(), ['ONLINE_CHAIN_CHECK_REQUIRED', 'ONLINE_SOURCE_CHECK_REQUIRED', 'ONLINE_VIDEO_CHECK_REQUIRED']);
});

test('a full explicitly mocked public fixture passes every real validation path', async () => {
  const {inputs, options, backends} = await fixture();
  const report = await checkSubmission(inputs, options);
  assert.equal(report.ready, true, JSON.stringify(report.pendingFacts));
  assert.equal(report.mode, 'online-read-only'); assert.equal(report.status, 'ready-to-submit');
  assert.ok(report.checks.every(check => check.status === 'pass'));
  assert.ok(Object.values(backends).every(backend => backend.calls.every(method => method === 'eth_chainId')));
});

test('zero hashes, a missing callback, mismatched approval, and local evidence cannot pass the public loop gate', async t => {
  const mutations = {
    'zero public transaction hash': value => {value.loop.evidence.sourceRequest.transactionHash = `0x${'0'.repeat(64)}`;},
    'missing destination callback': value => {delete value.loop.evidence.destinationGrant;},
    'mismatched approval digest': value => {value.loop.approval.digest = 'f'.repeat(64);},
    'local receipt mode relabeled with success flags': value => {value.loop.mode = 'local-evm-and-mocked-finality';},
    'local-only model plan': value => {value.plan.mode = 'local-evm';},
    'different request amount': value => {value.loop.amount = '55';},
    'reused success receipt': value => {value.loop.evidence.repeatedExecution = clone(value.loop.evidence.payment);},
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const {inputs, options} = await fixture(); mutate(inputs);
    const report = await checkSubmission(inputs, {...options, online: false});
    assert.equal(report.ready, false); assert.notEqual(report.checks.find(item => item.id === 'model-public-loop').status, 'pass');
  });
});

test('plausible nonzero receipt hashes and success flags fail when RPC has no transaction', async () => {
  const {inputs, options, backends} = await fixture();
  backends[BASE_ID].receipts.delete(inputs.loop.evidence.destinationGrant.transactionHash);
  const report = await checkSubmission(inputs, options);
  assert.equal(report.ready, false);
  assert.equal(report.checks.find(item => item.id === 'public-chain-receipts').code, 'PUBLIC_RECEIPT_NOT_FOUND_OR_CHANGED');
});

test('canonical receipts still require authentic callback events, compiled deployments, and a zero-payment replay', async t => {
  await t.test('callback event is absent', async () => {
    const {inputs, options, backends} = await fixture();
    backends[BASE_ID].receipts.get(inputs.loop.evidence.destinationGrant.transactionHash).logs = [];
    const report = await checkSubmission(inputs, options);
    assert.equal(report.ready, false);
    assert.equal(report.checks.find(item => item.id === 'public-chain-receipts').code, 'PUBLIC_EXPECTED_EVENT_MISSING');
  });
  await t.test('deployment calldata belongs to different code', async () => {
    const {inputs, options, backends} = await fixture();
    backends[LASNA_ID].transactions.get(inputs.deployment.contracts.coordinator.transactionHash).data = '0x6000';
    const report = await checkSubmission(inputs, options);
    assert.equal(report.ready, false);
    assert.equal(report.checks.find(item => item.id === 'public-chain-receipts').code, 'PUBLIC_DEPLOYED_SOURCE_MISMATCH');
  });
  await t.test('replay secretly pays again', async () => {
    const {inputs, options, backends, log} = await fixture();
    const receipt = backends[BASE_ID].receipts.get(inputs.loop.evidence.repeatedExecution.transactionHash);
    receipt.logs.push(log('token', 'Transfer', [inputs.loop.contracts.vault, owner, 60n], receipt));
    const report = await checkSubmission(inputs, options);
    assert.equal(report.ready, false);
    assert.equal(report.checks.find(item => item.id === 'public-chain-receipts').code, 'PUBLIC_REPLAY_PAID_AGAIN');
  });
  await t.test('public block has reorganized', async () => {
    const {inputs, options, backends} = await fixture();
    backends[BASE_ID].blockHash = (chain, number) => id(`DIFFERENT CANONICAL BLOCK ${chain} ${number}`);
    const report = await checkSubmission(inputs, options);
    assert.equal(report.ready, false);
    assert.equal(report.checks.find(item => item.id === 'public-chain-receipts').code, 'NONCANONICAL_DEPLOYMENT_RECEIPT');
  });
});

test('public repository HTTP success is insufficient without exact immutable source contents', async () => {
  const {inputs, options, publicTree} = await fixture();
  publicTree.tree.find(entry => entry.path === 'contracts/CommitBookReactive.sol').sha = 'd'.repeat(40);
  await assert.rejects(verifyPublicSource(inputs.metadata.repository, options.sourceFiles, {fetchImpl: options.fetchImpl}), {code: 'PUBLIC_SOURCE_CONTENT_MISMATCH'});
  await assert.rejects(verifyPublicSource({...inputs.metadata.repository, commit: '0'.repeat(40)}, options.sourceFiles, {fetchImpl: options.fetchImpl}), {code: 'PUBLIC_GITHUB_COMMIT_REQUIRED'});
});

test('local-preview video and stale source verification block an otherwise complete fixture', async () => {
  const {inputs, options} = await fixture();
  inputs.metadata.video.scope = 'local-preview';
  inputs.verification.sourceSha256 = 'e'.repeat(64);
  const report = await checkSubmission(inputs, options);
  assert.equal(report.ready, false);
  assert.ok(report.pendingFacts.some(item => item.code === 'FINAL_PUBLIC_PROOF_VIDEO_REQUIRED'));
  assert.ok(report.pendingFacts.some(item => item.code === 'LOCAL_VERIFICATION_STALE'));
});

test('video duration comes from a local probe with literal arguments and excludes 180 seconds and audio-only files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'commitbook-video-boundary-'));
  const file = path.join(directory, 'literal;$(not-executed).mp4'); fs.writeFileSync(file, fakeVideo);
  try {
    const probe = (duration, video = true) => probeVideo(file, {runProbe: (command, args, options) => {
      assert.equal(command, 'ffprobe'); assert.equal(args.at(-1), file); assert.equal(options.shell, false);
      assert.ok(args.includes('file,pipe'));
      return {status: 0, stdout: JSON.stringify({format: {duration}, streams: [{codec_type: video ? 'video' : 'audio'}]})};
    }});
    assert.equal(probe('179.999').durationSeconds, 179.999);
    for (const value of ['0', '180', '181', 'NaN']) assert.throws(() => probe(value), {code: 'VIDEO_MUST_BE_UNDER_180_SECONDS'});
    assert.throws(() => probe('60', false), {code: 'VIDEO_MUST_BE_UNDER_180_SECONDS'});
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
});

test('public video must be directly downloadable, byte-identical, and anonymous', async () => {
  await assert.rejects(verifyPublicVideo('https://video.example.org/watch/123', videoMeasurement,
    {fetchImpl: async () => new Response('<html>Sign in</html>', {headers: {'content-type': 'text/html'}})}), {code: 'DIRECT_PUBLIC_VIDEO_REQUIRED'});
  await assert.rejects(verifyPublicVideo('https://video.example.org/demo.mp4', videoMeasurement,
    {fetchImpl: async () => new Response(Buffer.alloc(fakeVideo.length), {headers: {'content-type': 'video/mp4'}})}), {code: 'PUBLIC_VIDEO_BYTES_MISMATCH'});
  await assert.rejects(verifyPublicVideo('https://127.0.0.1/demo.mp4', videoMeasurement,
    {fetchImpl: () => assert.fail('Private endpoint must be rejected')}), {code: 'PUBLIC_HTTPS_URL_REQUIRED'});
});

test('CLI has no broadcast, approval, wallet, or mock-evidence mode', () => {
  assert.deepEqual(parseArgs([]), {online: false, metadata: 'evidence/submission-input.json'});
  assert.equal(parseArgs(['--online']).online, true);
  for (const flag of ['--broadcast', '--approve', '--private-key', '--mock']) assert.throws(() => parseArgs([flag]), {code: 'UNKNOWN_ARGUMENT'});
});

test('online source compilation rejects a changed or dirty SDK despite a matching original-source hash', () => {
  const runGit = (revision, changes) => (command, args, options) => {
    assert.equal(command, 'git'); assert.equal(options.shell, false); assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
    return {status: 0, stdout: args.includes('rev-parse') ? revision : changes};
  };
  assert.throws(() => compileVerifiedSource({runGit: runGit('e'.repeat(40), '')}), {code: 'PINNED_REACTIVE_SDK_CHANGED'});
  assert.throws(() => compileVerifiedSource({runGit: runGit(SDK_COMMIT, ' M src/base/AbstractCallback.sol\n')}), {code: 'PINNED_REACTIVE_SDK_CHANGED'});
});
