#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {getAddress} from 'ethers';
import {planPurchase, closeModel, safePlannerError} from '../agent/planner.mjs';
import {identity, loadJson, saveJson, LiveError, safeError, LOOP_PATH, acquireWorkflowLock} from './lib/live.mjs';
import {PUBLIC_PLAN_PATH, publicPlanningInput, createPublicPlan, validatePublicPlan, approvePublicPlan} from './lib/public-plan.mjs';
import {run as runLoop} from './live-loop.mjs';

export function parseArgs(args) {
  const options = {prepare: false, broadcast: false};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prepare') options.prepare = true;
    else if (args[i] === '--broadcast') options.broadcast = true;
    else if (args[i] === '--goal' && args[i + 1]) options.goal = args[++i];
    else if (args[i] === '--approve' && args[i + 1]) options.approvedDigest = args[++i];
    else if (args[i] === '--address' && args[i + 1]) options.address = getAddress(args[++i]);
    else if (args[i] === '--help') options.help = true;
    else throw new LiveError('UNKNOWN_ARGUMENT');
  }
  if (options.prepare && (options.broadcast || options.approvedDigest)) throw new LiveError('PREPARE_CANNOT_BROADCAST');
  if (options.prepare && !options.goal?.trim()) throw new LiveError('GOAL_REQUIRED');
  if (options.goal && !options.prepare) throw new LiveError('GOAL_REQUIRES_PREPARE');
  if (options.approvedDigest && !options.broadcast) throw new LiveError('APPROVAL_REQUIRES_EXPLICIT_BROADCAST');
  if (options.broadcast && !/^[a-f0-9]{64}$/.test(options.approvedDigest ?? '')) throw new LiveError('PUBLIC_PLAN_APPROVAL_REQUIRED');
  return options;
}

export async function run(options) {
  const owner = identity({address: options.address}).address;
  if (options.prepare) {
    const release = acquireWorkflowLock();
    try {
      if (loadJson(LOOP_PATH)) throw new LiveError('EXISTING_PUBLIC_LOOP_MUST_BE_PRESERVED');
      // The CLI has no mock-provider option. Tests exercise the pure builder
      // separately; actual plans require a completed neural provider response.
      const result = await planPurchase(publicPlanningInput(options.goal, owner));
      const plan = createPublicPlan({goal: options.goal, owner, result});
      saveJson(PUBLIC_PLAN_PATH, plan);
      return {status: result.authorization.executable ? 'awaiting-operator-review' : 'proposal-requires-revision',
        publicTestnetExecution: false, aiInference: true, planPath: PUBLIC_PLAN_PATH, plan,
        nextStep: 'Review the goal, interpretation, approved offer and amount. Pass this exact sha256 with --broadcast --approve only after review. Deployment and current capacity are checked again before a request.'};
    } finally {closeModel(); release();}
  }
  const plan = loadJson(PUBLIC_PLAN_PATH);
  if (!plan) return {status: 'awaiting-ai-plan', readOnly: true, publicTestnetExecution: false, aiInference: false};
  const loop = loadJson(LOOP_PATH);
  if (!options.broadcast) {
    const checked = validatePublicPlan(plan, {owner, allowExpired: !!loop});
    return {status: loop ? 'historical-ai-plan-not-reverified' : checked.result.authorization.executable ? 'awaiting-operator-review' : 'proposal-requires-revision',
      readOnly: true, publicTestnetExecution: false, aiInference: true, plan,
      historicalOperationId: loop?.operationId,
      note: 'This is a saved proposal review. It does not reverify any public chain receipt.'};
  }
  approvePublicPlan(plan, {owner, approvedDigest: options.approvedDigest, allowExpired: !!loop});
  return runLoop({...options, publicPlan: plan});
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/live-agent.mjs --prepare --goal "..." [--address 0x...]\n'
      + '       node scripts/live-agent.mjs [--address 0x...]\n'
      + '       node scripts/live-agent.mjs --broadcast --approve <reviewed-sha256>\n'
      + 'Prepare runs actual neural inference and writes a reviewable proposal. It cannot broadcast.\n'
      + 'Default mode reads the saved proposal. Broadcast requires its exact reviewed digest and a deployed Base Sepolia / Lasna demo.\n'
      + 'Only approved catalog terms and valueless demo tokens are used. Rerun the same approval command to resume the same operation.');
    return;
  }
  const report = await run(options);
  console.log(JSON.stringify(report, null, 2));
  if (!['awaiting-operator-review', 'public-testnet-loop-verified'].includes(report.status)) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {console.log(JSON.stringify({status: 'blocked', error: error?.name === 'PlannerError' ? safePlannerError(error) : safeError(error)}, null, 2)); process.exitCode = 1;});
}
