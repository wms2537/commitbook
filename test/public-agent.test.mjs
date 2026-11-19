import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Interface, getAddress} from 'ethers';
import {planPurchase} from '../agent/planner.mjs';
import {parseArgs} from '../scripts/live-agent.mjs';
import {
  PLAN_VALIDITY_MS, approvePublicPlan, createPublicPlan, loadCurrentPublicPlan, planDigest, publicOperationId,
  publicPlanningInput, validatePublicLoopBinding, validatePublicPlan, validatePublicPlanCapacity,
} from '../scripts/lib/public-plan.mjs';
import {acquireWorkflowLock, loadJson, saveJson} from '../scripts/lib/live.mjs';

// Boundary tests use a controlled provider response. They are not model-quality
// evidence, never use the task wallet, and never connect to a public RPC.
const owner = getAddress('0x1111111111111111111111111111111111111111');
const other = getAddress('0x2222222222222222222222222222222222222222');
const coordinator = getAddress('0x3333333333333333333333333333333333333333');
const source = {algorithm: 'sha256', sha256: 'a'.repeat(64), paths: ['test-fixture-only']};
const now = Date.parse('2026-11-19T09:00:00Z');
const goal = 'Extract invoice fields privately within 120 seconds.';
const intent = {service: 'invoice-extraction', privacy: 'private', priority: 'fastest', failureType: 'none', reason: 'The goal requests private invoice extraction.'};
const clone = value => structuredClone(value);
const resign = plan => {plan.sha256 = planDigest(plan); return plan;};

async function fixture(overrides = {}) {
  const input = publicPlanningInput(overrides.goal ?? goal, owner);
  const result = await planPurchase(input, {fetchImpl: async () => ({ok: true, text: async () => JSON.stringify({
    choices: [{finish_reason: 'stop', message: {content: JSON.stringify({...intent, ...overrides.intent})}}],
    usage: {prompt_tokens: 100, completion_tokens: 25},
  })})});
  const plan = createPublicPlan({goal: input.goal, owner, result, source, now});
  const approve = candidate => approvePublicPlan(candidate, {owner, source, now, approvedDigest: candidate.sha256});
  return {plan, approve, approved: result.authorization.executable ? approve(plan) : null};
}

function loopFor(approved) {
  return {
    owner, aiInference: true, publicPlan: clone(approved.plan),
    approval: {digest: approved.digest, method: 'explicit-cli-digest', reviewedAt: new Date(now).toISOString()},
    contracts: {coordinator}, chainIds: clone(approved.plan.chainIds),
    operationId: publicOperationId(approved.plan, coordinator), amount: approved.amount,
    recipient: approved.recipient, expiresAt: approved.expiresAt,
    transactions: {request: {state: 'confirmed', transactionHash: '0x' + 'a'.repeat(64)}},
  };
}

test('public model proposal binds the approved offer to concrete inbox parameters', async () => {
  const {plan, approved} = await fixture();
  assert.equal(plan.result.inference.performed, true);
  assert.equal(approved.offerId, 'aster-extract');
  assert.equal(approved.amount, '60');
  assert.equal(approved.recipient, owner);
  assert.deepEqual(plan.input.policy.allowedChainIds, [84532]);
  assert.ok(plan.input.offers.every(offer => offer.chainId === 84532 && offer.demonstrationOnly));
  const iface = new Interface(['function request(bytes32 id,uint256 destinationChainId,address recipient,uint256 amount,uint64 expiresAt)']);
  const operationId = publicOperationId(plan, coordinator);
  const calldata = iface.encodeFunctionData('request', [operationId, 84532, approved.recipient, approved.amount, approved.expiresAt]);
  const decoded = iface.decodeFunctionData('request', calldata);
  assert.equal(decoded.id, operationId);
  assert.equal(decoded.destinationChainId, 84532n);
  assert.equal(decoded.recipient, owner);
  assert.equal(decoded.amount, 60n);
  assert.equal(decoded.expiresAt, BigInt(Math.floor((now + PLAN_VALIDITY_MS) / 1000)));
});

test('broadcast requires the exact reviewed digest and CLI separates planning from execution', async () => {
  const {plan} = await fixture();
  assert.throws(() => approvePublicPlan(plan, {owner, source, now}), {code: 'PUBLIC_PLAN_APPROVAL_REQUIRED'});
  assert.throws(() => approvePublicPlan(plan, {owner, source, now, approvedDigest: 'b'.repeat(64)}), {code: 'PUBLIC_PLAN_APPROVAL_REQUIRED'});
  assert.deepEqual(parseArgs([]), {prepare: false, broadcast: false});
  assert.throws(() => parseArgs(['--broadcast']), {code: 'PUBLIC_PLAN_APPROVAL_REQUIRED'});
  assert.throws(() => parseArgs(['--prepare', '--goal', goal, '--broadcast']), {code: 'PREPARE_CANNOT_BROADCAST'});
  assert.throws(() => parseArgs(['--approve', plan.sha256]), {code: 'APPROVAL_REQUIRES_EXPLICIT_BROADCAST'});
  assert.equal(parseArgs(['--broadcast', '--approve', plan.sha256]).approvedDigest, plan.sha256);
});

test('changed proposals, catalogs, arbitrary recipient or calldata cannot gain authority through a new digest', async () => {
  const {plan, approve} = await fixture();
  const changed = clone(plan);
  changed.input.offers[0].amount = 1;
  assert.throws(() => approve(changed), {code: 'PUBLIC_PLAN_DIGEST_MISMATCH'});
  assert.throws(() => approve(resign(changed)), {code: 'PUBLIC_PLAN_TERMS_CHANGED'});
  for (const mutate of [
    p => {p.input.offers[0].recipient = other;},
    p => {p.input.offers[0].chainId = 1;},
    p => {p.input.policy.maxPerPurchase = 1000;},
    p => {p.input.calldata = '0x1234';},
  ]) {
    const candidate = clone(plan); mutate(candidate);
    assert.throws(() => approve(resign(candidate)), {code: 'PUBLIC_PLAN_TERMS_CHANGED'});
  }
  const extra = clone(plan); extra.calldata = '0x1234';
  assert.throws(() => approve(resign(extra)), {code: 'PUBLIC_PLAN_SCHEMA_INVALID'});
  const proposal = clone(plan); proposal.result.proposal.recipient = other;
  assert.throws(() => approve(resign(proposal)), {code: 'PUBLIC_PLAN_DECISION_MISMATCH'});
});

test('new requests reject stale source, expired plans and another signer', async () => {
  const {plan} = await fixture();
  const options = {owner, source, now, approvedDigest: plan.sha256};
  assert.throws(() => approvePublicPlan(plan, {...options, source: {...source, sha256: 'b'.repeat(64)}}), {code: 'PUBLIC_PLAN_SOURCE_CHANGED'});
  assert.throws(() => approvePublicPlan(plan, {...options, now: now + PLAN_VALIDITY_MS}), {code: 'PUBLIC_PLAN_EXPIRED'});
  assert.throws(() => approvePublicPlan(plan, {...options, owner: other}), {code: 'PUBLIC_PLAN_OWNER_MISMATCH'});
  const recovered = approvePublicPlan(plan, {...options, now: now + PLAN_VALIDITY_MS, allowExpired: true});
  assert.equal(recovered.digest, plan.sha256);
});

test('fresh public accounting must agree with the capacity reviewed for this demo', async () => {
  const {approved} = await fixture();
  validatePublicPlanCapacity(approved, {cap: '100', spent: '0', reserved: '0', available: '100'});
  assert.throws(() => validatePublicPlanCapacity(approved, {cap: '100', spent: '0', reserved: '60', available: '40'}), {code: 'PUBLIC_PLAN_CAPACITY_CHANGED'});
  assert.throws(() => validatePublicPlanCapacity(approved, {cap: '100', spent: '20', reserved: '0', available: '80'}), {code: 'PUBLIC_PLAN_CAPACITY_CHANGED'});
});

test('a resumed operation preserves the same plan, payment terms, expiry and operation ID', async () => {
  const {approved} = await fixture();
  const original = loopFor(approved);
  validatePublicLoopBinding(approved, JSON.parse(JSON.stringify(original)));
  assert.equal(publicOperationId(approved.plan, coordinator), original.operationId);
  assert.notEqual(publicOperationId(approved.plan, other), original.operationId);
  for (const mutate of [
    loop => {loop.amount = '55';},
    loop => {loop.recipient = other;},
    loop => {loop.expiresAt++;},
    loop => {loop.operationId = '0x' + 'b'.repeat(64);},
    loop => {loop.publicPlan.input.goal = 'A different purchase';},
    loop => {loop.approval.digest = 'b'.repeat(64);},
    loop => {loop.aiInference = false;},
  ]) {
    const changed = clone(original); mutate(changed);
    assert.throws(() => validatePublicLoopBinding(approved, changed), {code: 'PUBLIC_PLAN_LOOP_BINDING_MISMATCH'});
  }
});

test('unsupported neural interpretation remains reviewable and cannot be approved for spending', async () => {
  const {plan, approve} = await fixture({goal: 'Translate this invoice.', intent: {service: 'unknown'}});
  assert.equal(plan.result.proposal.action, 'escalate');
  validatePublicPlan(plan, {owner, source, now});
  assert.throws(() => approve(plan), {code: 'PUBLIC_PLAN_NOT_EXECUTABLE'});
});

test('inference metadata and the exact prompt remain bound to the approved proposal', async () => {
  const {plan, approve} = await fixture();
  const mockFlag = clone(plan); mockFlag.result.inference.performed = false;
  assert.throws(() => approve(resign(mockFlag)), {code: 'PUBLIC_PLAN_INFERENCE_INVALID'});
  const otherPrompt = clone(plan); otherPrompt.input.goal = 'A different goal';
  assert.throws(() => approve(resign(otherPrompt)), {code: 'PUBLIC_PLAN_PROMPT_MISMATCH'});
  const otherDecision = clone(plan); otherDecision.result.proposal.offerId = 'quill-extract';
  assert.throws(() => approve(resign(otherDecision)), {code: 'PUBLIC_PLAN_DECISION_MISMATCH'});
});

test('a plan replaced before broadcast acquires the lock cannot start an unresumable operation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'commitbook-plan-race-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const planFile = path.join(directory, 'plan.json');
  const lockOptions = {file: path.join(directory, 'workflow.lock')};
  const {plan: first} = await fixture();
  const {plan: second} = await fixture({goal: 'Extract private invoice fields within 90 seconds.'});
  saveJson(planFile, first);
  const suppliedBeforeLock = loadJson(planFile);

  // The real CLI has already read and approved P. An independent preparation
  // acquires the shared lock and saves Q before broadcast acquires its lock.
  const prepareRelease = acquireWorkflowLock(lockOptions);
  saveJson(planFile, second);
  prepareRelease();
  const broadcastRelease = acquireWorkflowLock(lockOptions);
  try {
    assert.throws(() => loadCurrentPublicPlan(suppliedBeforeLock, planFile), {code: 'PUBLIC_PLAN_CHANGED_BEFORE_EXECUTION'});
    assert.deepEqual(loadCurrentPublicPlan(second, planFile), second);
    assert.throws(() => acquireWorkflowLock(lockOptions), {code: 'WORKFLOW_LOCK_HELD'});
    const sameDigestChangedContent = clone(second); sameDigestChangedContent.input.goal = 'Changed without updating digest';
    assert.throws(() => loadCurrentPublicPlan(sameDigestChangedContent, planFile), {code: 'PUBLIC_PLAN_CHANGED_BEFORE_EXECUTION'});
  } finally {broadcastRelease();}
  fs.unlinkSync(planFile);
  assert.throws(() => loadCurrentPublicPlan(second, planFile), {code: 'PUBLIC_PLAN_CHANGED_BEFORE_EXECUTION'});
});
