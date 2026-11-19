import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,RuntimeError} from '../app/runtime.mjs';

const model=async input=>({
  proposal:{action:input.context.phase==='supplier-failure'?'replace':'purchase',
    offerId:input.context.phase==='supplier-failure'?'quill-extract'
      :input.policy.requiredService==='invoice-verification'?'proofline-verify':'aster-extract',
    reason:input.context.phase==='supplier-failure'?'Use the available private alternative after closure.':'Use the approved private service.'},
  authorization:{executable:true,requiresClosure:false,blockedReason:null},
  inference:{performed:false,provider:'test-fixture',model:'scripted-proposal',durationMs:0},
});
const input=runtime=>({sessionId:runtime.snapshot().sessionId});
async function planned(runtime,policy) {
  return (await runtime.plan({...input(runtime),goal:'Process this invoice privately as quickly as possible.',policy})).result.planId;
}
function operation(runtime,id) {return runtime.snapshot().operations.find(o=>o.id===id);}

test('agent plan pays once on actual EVMs and repeated execution preserves the same operation',async()=>{
  const runtime=await createRuntime({planner:model});
  try {
    const planId=await planned(runtime);
    const first=await runtime.execute({...input(runtime),planId});
    assert.equal(first.budget.spent,60); assert.equal(first.budget.available,40);
    assert.equal(first.publicTestnetExecution,false); assert.equal(first.aiInference,false);
    const op=operation(runtime,first.result.operationId);
    assert.equal(op.status,'paid'); assert.equal(op.consumed,60);
    assert.equal(op.transactions[0].from.toLowerCase(),op.agent.toLowerCase());
    const count=op.transactions.length;
    const replay=await runtime.execute({...input(runtime),planId});
    assert.equal(replay.result.noop,true); assert.equal(replay.result.operationId,op.id);
    assert.equal(operation(runtime,op.id).transactions.length,count);
    assert.deepEqual(replay.budget,{cap:100,reserved:0,spent:60,available:40});
    assert.deepEqual(replay.payments,{base:60,unichain:0});
    const cancel=await runtime.cancel({...input(runtime),operationId:op.id});
    assert.equal(cancel.result.reason,'payment-already-occurred');
    await assert.rejects(runtime.recover({...input(runtime),operationId:op.id,failureMessage:'Please pay another supplier.'}),
      error=>error.code==='PAID_OPERATION_REQUIRES_REVIEW');
  } finally {await runtime.close();}
});

test('replacement waits for observed closure and explicit finalization; delayed grant remains closed',async()=>{
  const runtime=await createRuntime({planner:model});
  try {
    const firstPlan=await planned(runtime);
    const competingPlan=await planned(runtime,{requiredService:'invoice-verification'});
    const first=await runtime.execute({...input(runtime),planId:firstPlan,fault:'delay-grant'});
    const operationId=first.result.operationId;
    assert.equal(first.budget.reserved,60); assert.equal(operation(runtime,operationId).status,'queued');
    await assert.rejects(runtime.execute({...input(runtime),planId:competingPlan}),
      error=>error.code==='PLAN_NOT_EXECUTABLE'&&error.details.blockedReason==='insufficient-available-budget');
    assert.equal(runtime.snapshot().operations.length,1);
    const recovered=await runtime.recover({...input(runtime),operationId,failureMessage:'Supplier reports a permanent outage. Use another private provider.'});
    const replacementPlan=recovered.result.planId;
    assert.equal(recovered.plans.find(p=>p.id===replacementPlan).authorization.requiresClosure,true);
    await assert.rejects(runtime.execute({...input(runtime),planId:replacementPlan}),error=>error.code==='PLAN_NOT_EXECUTABLE');
    await assert.rejects(runtime.retry({...input(runtime),operationId}),error=>error.code==='FAILED_SUPPLIER_REQUIRES_CLOSURE');
    await assert.rejects(runtime.retry({...input(runtime),operationId,confirmSupplierReady:true}),error=>error.code==='FAILED_SUPPLIER_REQUIRES_CLOSURE');
    await runtime.cancel({...input(runtime),operationId,dropReceipt:true});
    assert.equal(operation(runtime,operationId).permitState,3);
    assert.equal(operation(runtime,operationId).closureObserved,false);
    assert.equal(runtime.snapshot().budget.reserved,60);
    const late=await runtime.lateGrant({...input(runtime),operationId});
    assert.equal(late.result.rejected,true); assert.equal(operation(runtime,operationId).consumed,0);
    await assert.rejects(runtime.finalize({...input(runtime),operationId}),error=>error.code==='CLOSURE_NOT_OBSERVED');
    assert.equal(runtime.snapshot().budget.reserved,60);
    await runtime.retry({...input(runtime),operationId});
    assert.equal(operation(runtime,operationId).closureObserved,true);
    assert.equal(runtime.snapshot().budget.reserved,60);
    await runtime.finalize({...input(runtime),operationId});
    assert.equal(runtime.snapshot().budget.available,100);
    assert.equal(runtime.snapshot().plans.find(p=>p.id===replacementPlan).authorization.executable,true);
    const replaced=await runtime.execute({...input(runtime),planId:replacementPlan});
    assert.deepEqual(replaced.budget,{cap:100,reserved:0,spent:55,available:45});
    assert.deepEqual(replaced.payments,{base:0,unichain:55});
    assert.equal(operation(runtime,replaced.result.operationId).consumed,55);
    assert.equal(operation(runtime,operationId).status,'closed');
    assert.notEqual(operation(runtime,replaced.result.operationId).agent,operation(runtime,operationId).agent);
    assert.ok(runtime.snapshot().events.filter(e=>e.type==='blocked').length>=3);
    assert.ok(runtime.evidence().checkpoints.every(c=>c.budget.reserved+c.budget.spent<=100));
  } finally {await runtime.close();}
});

test('a dropped spend receipt is recovered by authorized retry without another payment',async()=>{
  const runtime=await createRuntime({planner:model});
  try {
    const planId=await planned(runtime);
    const first=await runtime.execute({...input(runtime),planId,fault:'drop-spend-receipt'});
    const operationId=first.result.operationId;
    assert.deepEqual(first.budget,{cap:100,reserved:60,spent:0,available:40});
    assert.equal(operation(runtime,operationId).status,'payment-receipt-missing');
    assert.equal(operation(runtime,operationId).consumed,60);
    await runtime.retry({...input(runtime),operationId});
    assert.equal(operation(runtime,operationId).consumed,60);
    assert.equal(operation(runtime,operationId).status,'paid');
    assert.deepEqual(runtime.snapshot().budget,{cap:100,reserved:0,spent:60,available:40});
    assert.deepEqual(runtime.snapshot().payments,{base:60,unichain:0});
    const repeated=await runtime.retry({...input(runtime),operationId});
    assert.equal(repeated.result.noop,true);
  } finally {await runtime.close();}
});

test('reset invalidates old session IDs and an in-flight planner excludes concurrent mutations',async()=>{
  let release;
  const blocked=new Promise(resolve=>{release=resolve;});
  const runtime=await createRuntime({planner:async request=>{await blocked;return model(request);}});
  try {
    const sessionId=runtime.snapshot().sessionId;
    const pending=runtime.plan({sessionId,goal:'Extract a private invoice.'});
    await assert.rejects(runtime.plan({sessionId,goal:'Competing plan.'}),error=>error.code==='RUNTIME_BUSY'&&error.status===409);
    await assert.rejects(runtime.reset({sessionId}),error=>error.code==='RUNTIME_BUSY');
    assert.equal(runtime.snapshot().busy,true);
    release(); await pending;
    assert.equal(runtime.snapshot().busy,false);
    await runtime.reset({sessionId});
    assert.notEqual(runtime.snapshot().sessionId,sessionId);
    await assert.rejects(runtime.execute({sessionId,planId:'stale'}),error=>error.code==='STALE_SESSION');
    assert.deepEqual(runtime.snapshot().budget,{cap:100,reserved:0,spent:0,available:100});
  } finally {release();await runtime.close();}
});

test('closing a paid permit with a missing receipt reconciles spending without releasing it as unused',async()=>{
  const runtime=await createRuntime({planner:model});
  try {
    const planId=await planned(runtime);
    const first=await runtime.execute({...input(runtime),planId,fault:'drop-spend-receipt'});
    const operationId=first.result.operationId;
    await runtime.cancel({...input(runtime),operationId});
    assert.equal(operation(runtime,operationId).consumed,60);
    assert.equal(operation(runtime,operationId).closureObserved,true);
    assert.deepEqual(runtime.snapshot().budget,{cap:100,reserved:60,spent:0,available:40});
    await runtime.finalize({...input(runtime),operationId});
    assert.deepEqual(runtime.snapshot().budget,{cap:100,reserved:0,spent:60,available:40});
    assert.deepEqual(runtime.snapshot().payments,{base:60,unichain:0});
    assert.equal(operation(runtime,operationId).status,'closed');
  } finally {await runtime.close();}
});

test('model-invented payment terms and client budget overrides are rejected before any transaction',async()=>{
  const runtime=await createRuntime({planner:async()=>({
    proposal:{action:'purchase',offerId:'aster-extract',reason:'Pay the supplier.',amount:1},
    authorization:{executable:true},inference:{performed:false},
  })});
  try {
    await assert.rejects(runtime.plan({...input(runtime),goal:'Extract invoice.'}),error=>error instanceof RuntimeError&&error.code==='UNEXPECTED_PROPOSAL_FIELD');
    await assert.rejects(runtime.plan({...input(runtime),goal:'Extract invoice.',policy:{available:1000000}}),error=>error.code==='INVALID_POLICY');
    await assert.rejects(runtime.plan({...input(runtime),goal:'Extract invoice.',policy:{maxPerPurchase:1000}}),error=>error.code==='INVALID_POLICY');
    assert.equal(runtime.snapshot().operations.length,0); assert.equal(runtime.snapshot().plans.length,0);
    assert.deepEqual(runtime.snapshot().budget,{cap:100,reserved:0,spent:0,available:100});
  } finally {await runtime.close();}
});

test('a temporary wait requires explicit owner readiness before retrying only the existing operation',async()=>{
  const runtime=await createRuntime({planner:async request=>request.context.phase==='initial'?model(request):{
    proposal:{action:'wait',offerId:null,reason:'The short pause fits the deadline.'},
    interpretation:{service:'invoice-extraction',privacy:'private',priority:'fastest',failureType:'temporary',reason:'The supplier reports a three-second pause.'},
    inference:{performed:false,provider:'test-fixture',model:'scripted-proposal',plannerVersion:'semantic-router-v3'},
  }});
  try {
    const planId=await planned(runtime);
    const first=await runtime.execute({...input(runtime),planId,fault:'delay-grant'});
    const operationId=first.result.operationId;
    const recovery=await runtime.recover({...input(runtime),operationId,failureMessage:'The queue resumes in three seconds.'});
    assert.equal(recovery.plans.at(-1).interpretation.failureType,'temporary');
    assert.equal(recovery.plans.at(-1).inference.plannerVersion,'semantic-router-v3');
    assert.equal(operation(runtime,operationId).retryRequiresReadinessConfirmation,true);
    assert.ok(operation(runtime,operationId).actions.includes('retry'));
    await assert.rejects(runtime.retry({...input(runtime),operationId}),error=>error.code==='SUPPLIER_READINESS_REQUIRED');
    assert.equal(operation(runtime,operationId).consumed,0);
    await runtime.retry({...input(runtime),operationId,confirmSupplierReady:true});
    assert.deepEqual(runtime.snapshot().budget,{cap:100,reserved:0,spent:60,available:40});
    assert.deepEqual(runtime.snapshot().payments,{base:60,unichain:0});
    assert.equal(runtime.snapshot().offers.find(o=>o.id==='aster-extract').available,false);
    assert.equal(runtime.snapshot().operations.length,1);
    assert.ok(runtime.snapshot().events.some(e=>e.title==='Owner confirmed supplier readiness'));
    const again=await runtime.retry({...input(runtime),operationId,confirmSupplierReady:true});
    assert.equal(again.result.noop,true);assert.equal(operation(runtime,operationId).consumed,60);
  } finally {await runtime.close();}
});

test('an uncertain clarification supersedes older replacement proposals and cannot authorize retry payment',async()=>{
  let recoveryCalls=0;
  const runtime=await createRuntime({planner:async request=>{
    if(request.context.phase==='initial')return model(request);
    recoveryCalls++;
    return recoveryCalls===1?{...await model(request),interpretation:{
      service:'invoice-extraction',privacy:'private',priority:'fastest',failureType:'permanent',reason:'The supplier reports a permanent outage.',
    }}:{proposal:{action:'escalate',offerId:null,reason:'Completion is uncertain.'},interpretation:{
      service:'invoice-extraction',privacy:'private',priority:'fastest',failureType:'uncertain',reason:'The supplier cannot confirm completion.',
    },inference:{performed:false}};
  }});
  try {
    const first=await runtime.execute({...input(runtime),planId:await planned(runtime),fault:'delay-grant'});
    const operationId=first.result.operationId;
    const old=await runtime.recover({...input(runtime),operationId,failureMessage:'Permanent outage.'});
    await runtime.recover({...input(runtime),operationId,failureMessage:'Correction: completion is uncertain.'});
    await assert.rejects(runtime.retry({...input(runtime),operationId,confirmSupplierReady:true}),error=>error.code==='FAILED_SUPPLIER_REQUIRES_CLOSURE');
    await runtime.cancel({...input(runtime),operationId});await runtime.finalize({...input(runtime),operationId});
    const previous=runtime.snapshot().plans.find(p=>p.id===old.result.planId);
    assert.equal(previous.authorization.executable,false);
    assert.equal(previous.authorization.blockedReason,'recovery-plan-superseded');
    await assert.rejects(runtime.execute({...input(runtime),planId:old.result.planId}),error=>error.code==='RECOVERY_PLAN_SUPERSEDED');
    assert.deepEqual(runtime.snapshot().payments,{base:0,unichain:0});
  } finally {await runtime.close();}
});
