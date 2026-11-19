import path from 'node:path';
import {createHash} from 'node:crypto';
import {getAddress, id, ZeroAddress} from 'ethers';
import {createCatalog, OWNER_POLICY} from '../../app/catalog.mjs';
import {buildMessages, DEFAULT_MODEL, validateProposal} from '../../agent/planner.mjs';
import {validateIntent, resolveIntent, PLANNER_VERSION} from '../../agent/intent.mjs';
import {projectRoot} from '../compile.mjs';
import {sourceFingerprint, MODEL_SOURCES} from './source-fingerprint.mjs';
import {BASE_ID, LASNA_ID, LiveError, loadJson} from './live.mjs';

export const PUBLIC_PLAN_PATH = path.join(projectRoot, 'evidence/testnet-ai-plan.json');
export const PLAN_VALIDITY_MS = 24 * 60 * 60 * 1000;
export const PUBLIC_PLAN_SOURCES = [...MODEL_SOURCES, 'app/catalog.mjs', 'contracts',
  'scripts/compile.mjs', 'scripts/deploy-testnet.mjs', 'scripts/live-loop.mjs',
  'scripts/live-agent.mjs', 'scripts/lib/live.mjs', 'scripts/lib/public-plan.mjs'];
const requireThat = (condition, code) => {if (!condition) throw new LiveError(code);};
const exactKeys = (value, keys, code) => requireThat(value && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), code);

// Stable JSON lets the operator approve exact content, independent of indentation
// and object key order. An approval digest is an integrity check, not a signature.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  requireThat(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), 'INVALID_PLAN_JSON');
  return JSON.stringify(value);
}

export function planDigest(plan) {
  const {sha256, ...content} = plan;
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

export function publicPlanSource() {return sourceFingerprint(PUBLIC_PLAN_SOURCES);}

// Call inside the shared workflow lock. A preparer may have replaced the file
// after the CLI read it but before execution acquired that lock. Never start an
// operation whose approved proposal is no longer the saved resume proposal.
export function loadCurrentPublicPlan(supplied, file = PUBLIC_PLAN_PATH) {
  const current = loadJson(file);
  requireThat(current && current.sha256 === supplied?.sha256
    && canonicalJson(current) === canonicalJson(supplied), 'PUBLIC_PLAN_CHANGED_BEFORE_EXECUTION');
  return current;
}

export function publicPlanningInput(goal, owner) {
  const recipient = getAddress(owner);
  // Reuse approved application terms. The one-network public demo has no
  // deployed Unichain offer. Addresses never enter the neural prompt.
  const fixture = {recipient, chains: {base: {vault: {target: ZeroAddress}}, unichain: {vault: {target: ZeroAddress}}}};
  const offers = createCatalog(fixture).filter(offer => offer.chainId === BASE_ID)
    .map(({vault, ...offer}) => offer);
  return {
    goal, offers,
    policy: {...OWNER_POLICY, allowedOfferIds: offers.map(offer => offer.id), allowedChainIds: [BASE_ID], available: 100, reserved: 0},
    context: {phase: 'initial'},
  };
}

export function createPublicPlan({goal, owner, result, source = publicPlanSource(), now = Date.now()}) {
  owner = getAddress(owner);
  const input = publicPlanningInput(goal, owner);
  const plan = {
    schemaVersion: 1, mode: 'public-testnet-ai', owner,
    createdAt: new Date(now).toISOString(), validUntil: new Date(now + PLAN_VALIDITY_MS).toISOString(),
    chainIds: {origin: BASE_ID, reactive: LASNA_ID, destination: BASE_ID},
    input, result, source,
    scope: 'Operator-reviewed semantic routing for a valueless demo-token purchase. No invoice processing service is supplied.',
  };
  plan.sha256 = planDigest(plan);
  validatePublicPlan(plan, {owner, source, now});
  return plan;
}

export function validatePublicPlan(plan, {owner, source = publicPlanSource(), now = Date.now(), allowExpired = false} = {}) {
  exactKeys(plan, ['schemaVersion', 'mode', 'owner', 'createdAt', 'validUntil', 'chainIds', 'input', 'result', 'source', 'scope', 'sha256'], 'PUBLIC_PLAN_SCHEMA_INVALID');
  requireThat(plan.schemaVersion === 1 && plan.mode === 'public-testnet-ai', 'PUBLIC_PLAN_SCHEMA_INVALID');
  requireThat(/^[a-f0-9]{64}$/.test(plan.sha256) && plan.sha256 === planDigest(plan), 'PUBLIC_PLAN_DIGEST_MISMATCH');
  requireThat(getAddress(plan.owner) === getAddress(owner ?? plan.owner), 'PUBLIC_PLAN_OWNER_MISMATCH');
  requireThat(canonicalJson(plan.chainIds) === canonicalJson({origin: BASE_ID, reactive: LASNA_ID, destination: BASE_ID}), 'PUBLIC_PLAN_NETWORK_MISMATCH');
  const created = Date.parse(plan.createdAt), until = Date.parse(plan.validUntil);
  requireThat(Number.isFinite(created) && Number.isFinite(until) && until - created === PLAN_VALIDITY_MS && created <= now + 60_000, 'PUBLIC_PLAN_TIME_INVALID');
  requireThat(allowExpired || now < until, 'PUBLIC_PLAN_EXPIRED');
  requireThat(canonicalJson(plan.source) === canonicalJson(source), 'PUBLIC_PLAN_SOURCE_CHANGED');
  const input = publicPlanningInput(plan.input?.goal, plan.owner);
  requireThat(canonicalJson(plan.input) === canonicalJson(input), 'PUBLIC_PLAN_TERMS_CHANGED');
  exactKeys(plan.result, ['proposal', 'authorization', 'interpretation', 'inference'], 'PUBLIC_PLAN_RESULT_INVALID');
  const inference = plan.result.inference;
  exactKeys(inference, ['performed', 'provider', 'model', 'plannerVersion', 'durationMs', 'inputTokens', 'outputTokens', 'promptSha256'], 'PUBLIC_PLAN_INFERENCE_INVALID');
  requireThat(inference.performed === true && ['local-llama.cpp-stdio', 'local-llama.cpp-http', 'configured-compatible-provider'].includes(inference.provider)
    && typeof inference.model === 'string' && inference.model.length > 0 && inference.model.length <= 160
    && (inference.provider !== 'local-llama.cpp-stdio' || inference.model === DEFAULT_MODEL)
    && inference.plannerVersion === PLANNER_VERSION
    && Number.isSafeInteger(inference.durationMs) && inference.durationMs >= 0
    && ['inputTokens', 'outputTokens'].every(key => inference[key] === null || Number.isSafeInteger(inference[key]) && inference[key] >= 0), 'PUBLIC_PLAN_INFERENCE_INVALID');
  const promptHash = createHash('sha256').update(JSON.stringify(buildMessages(input))).digest('hex');
  requireThat(inference.promptSha256 === promptHash, 'PUBLIC_PLAN_PROMPT_MISMATCH');
  const interpretation = validateIntent(plan.result.interpretation, input.offers.map(offer => offer.service));
  const expected = validateProposal(resolveIntent(interpretation, input), input);
  requireThat(canonicalJson(plan.result.proposal) === canonicalJson(expected.proposal)
    && canonicalJson(plan.result.authorization) === canonicalJson(expected.authorization), 'PUBLIC_PLAN_DECISION_MISMATCH');
  return {input, result: expected, offer: input.offers.find(offer => offer.id === expected.proposal.offerId)};
}

export function approvePublicPlan(plan, {owner, approvedDigest, source, now, allowExpired = false} = {}) {
  requireThat(typeof approvedDigest === 'string' && approvedDigest === plan?.sha256, 'PUBLIC_PLAN_APPROVAL_REQUIRED');
  const checked = validatePublicPlan(plan, {owner, source, now, allowExpired});
  requireThat(checked.result.authorization.executable && checked.result.proposal.action === 'purchase' && checked.offer, 'PUBLIC_PLAN_NOT_EXECUTABLE');
  return {plan, digest: plan.sha256, amount: String(checked.offer.amount), recipient: getAddress(plan.owner),
    offerId: checked.offer.id, expiresAt: Math.floor(Date.parse(plan.validUntil) / 1000)};
}

export function publicOperationId(plan, coordinator) {
  return id(`commitbook:public-ai:${getAddress(coordinator)}:${plan.sha256}`);
}

export function validatePublicLoopBinding(approved, loop) {
  requireThat(loop.aiInference === true && loop.publicPlan?.sha256 === approved.digest
    && canonicalJson(loop.publicPlan) === canonicalJson(approved.plan)
    && loop.approval?.digest === approved.digest && loop.approval?.method === 'explicit-cli-digest'
    && loop.operationId === publicOperationId(approved.plan, loop.contracts.coordinator)
    && loop.amount === approved.amount && getAddress(loop.recipient) === approved.recipient
    && loop.expiresAt === approved.expiresAt
    && getAddress(loop.owner) === approved.recipient
    && canonicalJson(loop.chainIds) === canonicalJson(approved.plan.chainIds), 'PUBLIC_PLAN_LOOP_BINDING_MISMATCH');
}

export function validatePublicPlanCapacity(approved, snapshot) {
  // This demonstration starts from an unused 100-unit coordinator. Its planning
  // capacity is provisional until a fresh, block-bound chain snapshot agrees.
  requireThat(snapshot.cap === '100' && snapshot.spent === '0' && snapshot.reserved === '0'
    && snapshot.available === '100' && BigInt(approved.amount) <= BigInt(snapshot.available), 'PUBLIC_PLAN_CAPACITY_CHANGED');
}
