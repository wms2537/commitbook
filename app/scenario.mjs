/** Real inference plus actual local EVM execution. No fixture AI responses. */
export async function runRecoveryScenario(runtime,input,{onStep=()=>{},onCheckpoint=()=>{}}={}) {
  const checkpoints=[];
  const startedAt=new Date().toISOString();
  const check=(condition,message)=>{if(!condition)throw Object.assign(new Error(message),{code:'SCENARIO_ASSERTION_FAILED',status:500});};
  const current=()=>({sessionId:runtime.snapshot().sessionId});
  const capture=label=>{
    const state=runtime.snapshot();
    check(state.budget.spent+state.budget.reserved<=state.budget.cap,'Budget invariant failed.');
    const checkpoint={label,state};checkpoints.push(checkpoint);onCheckpoint(checkpoint);return state;
  };
  const step=async(label,work)=>{onStep(label);const result=await work();capture(label);return result;};
  const planFor=id=>runtime.snapshot().plans.find(p=>p.id===id);
  const operationFor=id=>runtime.snapshot().operations.find(o=>o.id===id);
  const actualPlan=id=>{
    const plan=planFor(id);check(plan?.inference.performed===true,'This scenario requires actual model inference.');return plan;
  };
  const blocked=async(action,code)=>{
    try {await action();} catch(error){check(error.code===code,`Expected ${code}, received ${error.code}.`);return;}
    check(false,`Expected ${code} to prevent the action.`);
  };
  check(input.sessionId===runtime.snapshot().sessionId,'The scenario belongs to an old session.');
  if(runtime.snapshot().plans.length||runtime.snapshot().operations.length)await runtime.reset(input);
  capture('Fresh local budget');
  const initial=await step('Agent chooses a private extraction supplier',()=>runtime.plan({...current(),
    goal:'Choose the fastest private invoice-extraction service for a batch of invoices. Delivery must be within 120 seconds.',
    policy:{requiredService:'invoice-extraction',requirePrivate:true,maxEtaSeconds:120}}));
  const firstPlanId=initial.result.planId;
  check(actualPlan(firstPlanId).proposal.offerId==='aster-extract','The speed-sensitive private request did not select Aster.');
  const competing=await step('Another agent plans independent verification',()=>runtime.plan({...current(),
    goal:'Buy an independent invoice-verification service for extracted invoice fields and arithmetic. Require private processing within 120 seconds.',
    policy:{requiredService:'invoice-verification',requirePrivate:true,maxEtaSeconds:120}}));
  const competingPlanId=competing.result.planId;
  check(actualPlan(competingPlanId).proposal.offerId==='proofline-verify','The verification request did not select the verification service.');
  const first=await step('Reserve 60 and delay its approval',()=>runtime.execute({...current(),planId:firstPlanId,fault:'delay-grant'}));
  const operationId=first.result.operationId;
  check(runtime.snapshot().budget.reserved===60,'The first commitment did not reserve 60.');
  await step('A stale competing plan cannot spend the same capacity',()=>blocked(
    ()=>runtime.execute({...current(),planId:competingPlanId}),'PLAN_NOT_EXECUTABLE'));
  let recovery=await step('Agent interprets the reported supplier outage',()=>runtime.recover({...current(),operationId,
    failureMessage:'Our isolated invoice workers cannot accept this batch. Their processing queue is offline until tomorrow, so retrying now will not start work. Please select another approved private supplier for this run.'}));
  if(actualPlan(recovery.result.planId).proposal.action==='escalate'){
    recovery=await step('Operator clarifies the outage duration and the agent replans',()=>runtime.recover({...current(),operationId,
      failureMessage:'The supplier confirms that no work has started and it cannot accept this invoice batch for the next 24 hours. The existing request will not run during that period. Select another approved private supplier for this batch.'}));
  }
  const replacementPlanId=recovery.result.planId;
  check(actualPlan(replacementPlanId).proposal.offerId==='quill-extract','The unavailable supplier did not produce the approved private replacement.');
  check(planFor(replacementPlanId).proposal.action==='replace','Recovery must be an explicit replacement proposal.');
  await step('The replacement waits for verified closure',()=>blocked(
    ()=>runtime.execute({...current(),planId:replacementPlanId}),'PLAN_NOT_EXECUTABLE'));
  await step('Cancel at the destination and drop its first receipt',()=>runtime.cancel({...current(),operationId,dropReceipt:true}));
  const late=await step('Deliver the old approval after cancellation',()=>runtime.lateGrant({...current(),operationId}));
  check(late.result.rejected===true,'The delayed approval was not rejected.');
  check(operationFor(operationId).consumed===0,'The cancelled operation paid unexpectedly.');
  await step('Missing closure evidence cannot release the reservation',()=>blocked(
    ()=>runtime.finalize({...current(),operationId}),'CLOSURE_NOT_OBSERVED'));
  await step('Recover the missed closure receipt',()=>runtime.retry({...current(),operationId}));
  check(runtime.snapshot().budget.reserved===60,'Observation released capacity before explicit finalization.');
  await step('The trusted local finalizer confirms closure',()=>runtime.finalize({...current(),operationId}));
  check(runtime.snapshot().budget.available===100,'Unused capacity was not returned after finalization.');
  const replacement=await step('Execute the approved 55-unit replacement',()=>runtime.execute({...current(),planId:replacementPlanId}));
  const count=operationFor(replacement.result.operationId).transactions.length;
  const repeated=await step('Repeat the request without another payment',()=>runtime.execute({...current(),planId:replacementPlanId}));
  check(repeated.result.noop===true,'Repeated execution created another operation.');
  check(operationFor(replacement.result.operationId).transactions.length===count,'Repeated execution submitted another transaction.');
  const state=runtime.snapshot();
  check(state.budget.cap===100&&state.budget.spent===55&&state.budget.reserved===0&&state.budget.available===45,'Final accounting does not match the completed replacement.');
  check(state.payments.base===0&&state.payments.unichain===55,'Actual token balances do not match the single replacement payment.');
  return {
    schemaVersion:1,recorded:true,title:'Recover an agent purchase without spending the budget twice',
    startedAt,finishedAt:new Date().toISOString(),mode:'local-evm',publicTestnetExecution:false,
    aiInference:true,transport:'Simulated Reactive delivery over three actual local EVMs.',
    finality:'Explicit trusted local finalizer; public-chain finality was not tested.',
    summary:{passed:true,inferenceCalls:state.plans.filter(p=>p.inference.performed).length,
      finalBudget:state.budget,actualSupplierPayments:state.payments,duplicatePayments:0,cancelledGrantReopened:false,
      checks:['stale-plan-blocked','replacement-waits-for-closure','missing-receipt-holds-reservation','late-grant-rejected','retry-recovers-receipt','single-payment']},
    state,checkpoints,
  };
}
