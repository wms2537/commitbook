import {randomUUID} from 'node:crypto';
import {id} from 'ethers';
import {planPurchase, validateProposal} from '../agent/planner.mjs';
import {validateIntent} from '../agent/intent.mjs';
import {
  createFixture, eventLogs, relayEvent, deliverCallback,
  finalize as finalizeFixture, receiptEvidence,
} from '../test/helpers.mjs';
import {OWNER_POLICY, createCatalog} from './catalog.mjs';

const clone=value=>JSON.parse(JSON.stringify(value));
const now=()=>new Date().toISOString();
const safeInteger=value=>Number.isSafeInteger(value)&&value>=0;

export class RuntimeError extends Error {
  constructor(code, message, status=422, details={}) {
    super(message); this.name='RuntimeError'; this.code=code;
    this.status=status; this.statusCode=status; this.details=details;
  }
}
function requireThat(condition, code, message, status=422, details={}) {
  if(!condition)throw new RuntimeError(code,message,status,details);
}
function publicError(error) {
  if(error instanceof RuntimeError)return error;
  if(error?.name==='PlannerError')return new RuntimeError(error.code,
    `The proposal was not authorized: ${error.code.toLowerCase().replaceAll('_',' ')}.`,422);
  return new RuntimeError('RUNTIME_ACTION_FAILED','The local contract action failed. No replacement authority was granted.',500);
}

export async function createRuntime({planner=planPurchase, modelStatus={}}={}) {
  requireThat(typeof planner==='function','INVALID_PLANNER','A planner function is required.');
  let fixture=await createFixture();
  let sessionId, offers, plans, operations, events, checkpoints, budget, model, payments, vaultBalances;
  let busy=false, busyAction=null, stopped=false, aiInference=false, agentCounter=0;
  const callbacks=new Map();

  async function initialize() {
    // Distinct request identities. The finality signer is used only by finalize().
    await (await fixture.inbox.setAgent(await fixture.chains.base.signers[2].getAddress(),true)).wait();
    sessionId=randomUUID(); offers=createCatalog(fixture); plans=[]; operations=[];
    events=[]; checkpoints=[]; callbacks.clear(); aiInference=false; agentCounter=0;
    model={provider:'local-llama.cpp',model:'not-configured',ready:false};
    for(const key of ['provider','model','ready','status','label']) {
      if(['string','boolean'].includes(typeof modelStatus?.[key]))model[key]=modelStatus[key];
    }
    await refresh();
    record('session','Local session ready','Three local EVMs share one 100-unit budget. Reactive transport and finality are simulated.');
  }
  function checkedSession(value) {
    requireThat(!stopped,'RUNTIME_CLOSED','This local runtime has stopped.',410);
    requireThat(value===sessionId,'STALE_SESSION','This session was reset. Refresh before taking another action.',409);
  }
  function operationFor(operationId) {
    const operation=operations.find(item=>item.id===operationId);
    requireThat(operation,'UNKNOWN_OPERATION','The operation does not belong to this session.',404);
    return operation;
  }
  function planFor(planId) {
    const plan=plans.find(item=>item.id===planId);
    requireThat(plan,'UNKNOWN_PLAN','The plan does not belong to this session.',404);
    return plan;
  }
  function chainFor(operation) {return fixture.chains[operation.chain];}
  function record(type,title,detail,{operation,transaction}={}) {
    const entry={id:randomUUID(),time:now(),type,title,detail,budget:clone(budget)};
    if(operation)entry.operationId=operation.id;
    if(transaction)entry.transaction=clone(transaction);
    events.push(entry);
    checkpoints.push({eventId:entry.id,title,budget:clone(budget),payments:clone(payments),
      operations:operations.map(o=>({operationId:o.id,consumed:o.consumed,status:o.status}))});
    return entry;
  }
  async function observed(type,title,detail,operation,receipt,chain) {
    const transaction=receipt?{...receiptEvidence(receipt,chain),from:receipt.from,to:receipt.to}:undefined;
    if(transaction&&operation)operation.transactions.push(transaction);
    await refresh();
    record(type,title,detail,{operation,transaction});
  }
  function policyFor(settings={}) {
    requireThat(settings&&typeof settings==='object'&&!Array.isArray(settings),'INVALID_POLICY','Policy must be an object.');
    const keys=['allowedOfferIds','allowedChainIds','maxPerPurchase','requiredService','maxEtaSeconds','requirePrivate'];
    requireThat(Object.keys(settings).every(key=>keys.includes(key)),'INVALID_POLICY','Budget and reservation amounts come from contract state.');
    const policy={...clone(OWNER_POLICY),...clone(settings),available:budget.available,reserved:budget.reserved};
    requireThat(safeInteger(policy.maxPerPurchase)&&policy.maxPerPurchase>0&&policy.maxPerPurchase<=OWNER_POLICY.maxPerPurchase,
      'INVALID_POLICY','A purchase limit must be between 1 and 60.');
    requireThat(safeInteger(policy.maxEtaSeconds)&&policy.maxEtaSeconds<=OWNER_POLICY.maxEtaSeconds,
      'INVALID_POLICY','The delivery limit must not exceed 120 seconds.');
    requireThat(policy.requirePrivate===true,'INVALID_POLICY','This owner policy requires private processing.');
    requireThat(['invoice-extraction','invoice-verification'].includes(policy.requiredService),'INVALID_POLICY','Choose a supported invoice service.');
    requireThat(Array.isArray(policy.allowedOfferIds)&&policy.allowedOfferIds.length>0
      &&policy.allowedOfferIds.every(value=>OWNER_POLICY.allowedOfferIds.includes(value)),
      'INVALID_POLICY','Offers must be a subset of the owner-approved catalog.');
    requireThat(Array.isArray(policy.allowedChainIds)&&policy.allowedChainIds.length>0
      &&policy.allowedChainIds.every(value=>OWNER_POLICY.allowedChainIds.includes(value)),
      'INVALID_POLICY','Chains must be a subset of the owner-approved destinations.');
    return policy;
  }
  function contextFor(plan) {
    const context={...plan.context};
    if(context.currentOperationId) {
      const operation=operationFor(context.currentOperationId);
      context.currentOfferId=operation.offerId;
      context.priorClosureFinalized=operation.closureFinalized&&operation.permitState===3&&operation.consumed===0;
      context.pendingCancellation=operation.coordinatorState===2&&!operation.closureFinalized;
    } else {
      context.pendingCancellation=operations.some(o=>o.coordinatorState===2&&!o.closureFinalized);
    }
    return context;
  }
  function validatePlan(plan) {
    requireThat(!plan.recoverySuperseded,'RECOVERY_PLAN_SUPERSEDED','Newer supplier information superseded this recovery proposal.',409);
    return validateProposal(plan.proposal,{offers,policy:policyFor(plan.policySettings),context:contextFor(plan)});
  }
  function refreshPlans() {
    for(const plan of plans) {
      plan.context=contextFor(plan);
      if(plan.operationId) {
        plan.authorization={executable:false,requiresClosure:false,blockedReason:'plan-already-executed'};
        continue;
      }
      try {plan.authorization=validatePlan(plan).authorization;}
      catch(error) {plan.authorization={executable:false,requiresClosure:false,
        blockedReason:String(error.code??'proposal-invalid').toLowerCase().replaceAll('_','-')};}
    }
  }
  async function refresh() {
    const block=await fixture.chains.reactive.provider.getBlock('latest');
    const tag={blockTag:block.number};
    const [cap,reserved,spent,available]=await Promise.all([
      fixture.coordinator.budgetCap(tag),fixture.coordinator.totalReserved(tag),
      fixture.coordinator.totalSpent(tag),fixture.coordinator.availableBudget(tag),
    ]);
    requireThat(spent+reserved<=cap&&spent+reserved+available===cap,'BUDGET_INVARIANT_FAILED','The budget invariant did not hold.',500);
    budget={cap:Number(cap),reserved:Number(reserved),spent:Number(spent),available:Number(available)};
    payments={}; vaultBalances={};
    for(const name of ['base','unichain']) {
      const chain=fixture.chains[name];
      const [paid,inventory]=await Promise.all([
        chain.token.balanceOf(fixture.recipient),chain.token.balanceOf(chain.vault.target),
      ]);
      payments[name]=Number(paid); vaultBalances[name]=Number(inventory);
    }
    for(const operation of operations??[]) {
      const [commitment,permit]=await Promise.all([
        fixture.coordinator.commitments(operation.id),chainFor(operation).vault.permits(operation.id),
      ]);
      operation.coordinatorState=Number(commitment.status); operation.permitState=Number(permit.state);
      operation.closureObserved=commitment.closureObserved; operation.closureFinalized=commitment.closureFinalized;
      operation.consumed=Number(permit.consumed); operation.spent=Number(commitment.spent);
      operation.grantDelayed=callbacks.has(operation.id);
      operation.retryRequiresReadinessConfirmation=operation.coordinatorState===1&&operation.consumed===0
        &&Boolean(operation.reportedFailure)&&operation.recoveryAction==='wait'
        &&operation.failureType==='temporary'&&!operation.readinessConfirmed;
      operation.receiptMissing=(operation.consumed>0&&operation.spent===0)
        ||(operation.permitState===3&&!operation.closureObserved&&!operation.closureFinalized);
      operation.status=operation.coordinatorState===0?(operation.requestRejected?'rejected':'request-pending')
        :operation.closureFinalized?'closed'
        :operation.closureObserved?'closure-observed'
        :operation.consumed>0&&operation.spent===0?'payment-receipt-missing'
        :operation.spent>0?'paid'
        :operation.coordinatorState===2?'cancellation-pending'
        :operation.permitState===1?'ready':'queued';
      const actions=[];
      if(operation.coordinatorState===1)actions.push('cancel');
      if(operation.coordinatorState===2||(operation.coordinatorState===1
        &&(operation.consumed>0||!operation.reportedFailure||operation.readinessConfirmed
          ||operation.retryRequiresReadinessConfirmation)))actions.push('retry');
      if(operation.grantDelayed)actions.push('late-grant');
      if(operation.closureObserved&&!operation.closureFinalized&&operation.permitState===3)actions.push('finalize');
      if(operation.coordinatorState!==0&&operation.consumed===0&&!operation.closureFinalized)actions.push('recover');
      operation.actions=actions;
    }
    if(plans)refreshPlans();
  }
  function snapshot() {
    return clone({sessionId,mode:'local-evm',publicTestnetExecution:false,aiInference,model,busy,busyAction,
      budget,payments,vaultBalances,offers,plans,operations,events,policy:{...OWNER_POLICY,available:budget.available,reserved:budget.reserved},
      finality:'Explicit trusted local finalizer. This session does not verify public-chain finality.',
      transport:'Actual Solidity on three independent local EVMs with simulated Reactive delivery.'});
  }
  async function mutation(input,action,work) {
    checkedSession(input?.sessionId);
    requireThat(!busy,'RUNTIME_BUSY','Another action is still running. Wait for its result.',409);
    busy=true; busyAction=action;
    try {
      await refresh();
      const result=await work();
      await refresh(); busy=false; busyAction=null;
      return {...snapshot(),result};
    } catch(original) {
      const error=publicError(original);
      try {await refresh();} catch { /* Preserve the original action error. */ }
      const operation=operations.find(o=>o.id===input.operationId||o.planId===input.planId);
      record('blocked','Action blocked',error.message,{operation});
      busy=false; busyAction=null;
      throw error;
    }
  }
  async function generatePlan({goal,settings={},context}) {
    requireThat(typeof goal==='string'&&goal.trim().length>0&&goal.length<=3000,'INVALID_GOAL','Enter a goal of at most 3,000 characters.');
    const policy=policyFor(settings);
    const result=await planner({goal:goal.trim(),offers:clone(offers),policy,context:clone(context)});
    // Model-supplied authorization is ignored. Recompute it from authoritative terms.
    const validated=validateProposal(result?.proposal,{offers,policy,context});
    let interpretation;
    if(result?.interpretation!==undefined) {
      try {interpretation=validateIntent(result.interpretation,offers.map(o=>o.service));}
      catch {throw new RuntimeError('INVALID_MODEL_INTERPRETATION','The model interpretation did not match the supported schema.');}
    }
    const inference={performed:result?.inference?.performed===true};
    for(const key of ['provider','model','plannerVersion','durationMs','inputTokens','outputTokens','promptSha256']) {
      const value=result?.inference?.[key];
      if((typeof value==='string'&&value.length<=200)||typeof value==='number'||value===null)inference[key]=value;
    }
    if(inference.performed) {
      aiInference=true; model={...model,provider:inference.provider??model.provider,model:inference.model??model.model,ready:true};
    }
    const plan={id:randomUUID(),createdAt:now(),goal:goal.trim(),policySettings:clone(settings),context:clone(context),
      ...validated,inference,...(interpretation?{interpretation}:{})};
    plans.push(plan);
    record('plan',validated.authorization.executable?'Plan ready':'Plan held',validated.proposal.reason);
    return plan;
  }
  async function deliverGrant(operation,callback) {
    const delivered=await deliverCallback(fixture,callback);
    await observed('grant','Destination permission delivered','The destination received the fixed payment permission.',operation,delivered.receipt,delivered.chain);
    const spend=eventLogs(delivered.chain.vault,delivered.receipt,'CommitmentExecuted');
    if(spend.length) {
      const relay=await relayEvent(fixture,delivered.chain,delivered.chain.vault,delivered.receipt,'CommitmentExecuted');
      await observed('receipt','Payment receipt recovered','An authenticated retry reported the existing payment without paying again.',operation,relay.receipt,fixture.chains.reactive);
    }
    return delivered;
  }
  async function pay(operation,{dropReceipt=false}={}) {
    const chain=chainFor(operation);
    const receipt=await (await chain.vault.execute(operation.id)).wait();
    await observed('payment','Supplier paid',`${operation.amount} demonstration token units transferred to the fixed recipient.`,operation,receipt,chain);
    if(dropReceipt) {
      record('fault','Payment receipt deliberately dropped','The destination paid. Reserved capacity remains until its result is recovered.',{operation});
    } else if(eventLogs(chain.vault,receipt,'CommitmentExecuted').length) {
      const relayed=await relayEvent(fixture,chain,chain.vault,receipt,'CommitmentExecuted');
      await observed('receipt','Payment reconciled','Reactive converted the existing reservation into recorded spending.',operation,relayed.receipt,fixture.chains.reactive);
    }
  }
  async function deliverClose(operation,callback,{dropReceipt=false}={}) {
    const delivered=await deliverCallback(fixture,callback);
    await observed('closure','Destination permanently closed','The operation ID cannot be reopened by a delayed permission.',operation,delivered.receipt,delivered.chain);
    if(dropReceipt)record('fault','Closure receipt deliberately dropped','Destination closure succeeded. The coordinator still holds the reservation.',{operation});
    else {
      const relayed=await relayEvent(fixture,delivered.chain,delivered.chain.vault,delivered.receipt,'CommitmentClosed');
      await observed('receipt','Closure observed','Observation records the outcome but does not release the reservation.',operation,relayed.receipt,fixture.chains.reactive);
    }
  }
  await initialize();

  return {
    snapshot,
    evidence:()=>clone({state:snapshot(),checkpoints}),
    plan:input=>mutation(input,'plan',async()=>{
      const plan=await generatePlan({goal:input.goal,settings:input.policy??{},context:{phase:'initial',
        pendingCancellation:operations.some(o=>o.coordinatorState===2&&!o.closureFinalized)}});
      return {planId:plan.id};
    }),
    execute:input=>mutation(input,'execute',async()=>{
      const plan=planFor(input.planId);
      if(plan.operationId) {
        const operation=operationFor(plan.operationId);
        record('replay','Repeated execution ignored','This plan already has an operation. No new request or payment was submitted.',{operation});
        return {planId:plan.id,operationId:operation.id,noop:true};
      }
      requireThat([undefined,null,'none','delay-grant','drop-spend-receipt'].includes(input.fault),'INVALID_FAULT','Choose a supported local fault scenario.');
      const validation=validatePlan(plan); plan.authorization=validation.authorization;
      requireThat(validation.authorization.executable,'PLAN_NOT_EXECUTABLE',
        `Execution is blocked: ${validation.authorization.blockedReason}.`,409,{blockedReason:validation.authorization.blockedReason});
      const offer=offers.find(o=>o.id===plan.proposal.offerId);
      const destination=fixture.chains[offer.chain];
      const blocks=await Promise.all([fixture.chains.base,fixture.chains.reactive,destination].map(c=>c.provider.getBlock('latest')));
      const expiresAt=Math.max(...blocks.map(b=>b.timestamp))+3600;
      const agentIndex=1+(agentCounter++%2); const agentSigner=fixture.chains.base.signers[agentIndex];
      const operation={id:id(`commitbook:${sessionId}:${plan.id}`),planId:plan.id,offerId:offer.id,offerName:offer.name,
        chain:offer.chain,chainId:offer.chainId,amount:offer.amount,recipient:offer.recipient,expiresAt,
        agent:await agentSigner.getAddress(),agentIndex,createdAt:now(),transactions:[],status:'queued',consumed:0,spent:0,
        grantDelayed:false,receiptMissing:false,closureObserved:false,closureFinalized:false,actions:[]};
      operations.push(operation); plan.operationId=operation.id;
      const receipt=await (await fixture.inbox.connect(agentSigner).request(operation.id,offer.chainId,offer.recipient,offer.amount,expiresAt)).wait();
      await observed('request','Agent request submitted','The authorized agent submitted immutable terms. Reservation still requires Reactive acceptance.',operation,receipt,fixture.chains.base);
      const reaction=await relayEvent(fixture,fixture.chains.base,fixture.inbox,receipt,'CommitmentRequested');
      operation.requestRejected=reaction.callbacks.length===0;
      await observed('reservation',reaction.callbacks.length?'Budget reserved':'Request rejected',
        reaction.callbacks.length?`${offer.amount} units are reserved before destination permission.`:'Reactive rejected this request without granting spending authority.',
        operation,reaction.receipt,fixture.chains.reactive);
      if(!reaction.callbacks.length)return {planId:plan.id,operationId:operation.id,rejected:true};
      if(input.fault==='delay-grant') {
        callbacks.set(operation.id,reaction.callbacks[0]);
        await refresh(); record('fault','Approval deliberately delayed','The destination permission is held while its budget remains reserved.',{operation});
      } else {
        await deliverGrant(operation,reaction.callbacks[0]);
        await pay(operation,{dropReceipt:input.fault==='drop-spend-receipt'});
      }
      return {planId:plan.id,operationId:operation.id};
    }),
    recover:input=>mutation(input,'recover',async()=>{
      const operation=operationFor(input.operationId);
      requireThat(operation.coordinatorState!==0,'REJECTED_OPERATION','A rejected request has no destination commitment to recover.',409);
      requireThat(operation.consumed===0&&operation.spent===0,'PAID_OPERATION_REQUIRES_REVIEW','Payment already occurred. Replacement requires human review, not automatic budget reuse.',409);
      requireThat(typeof input.failureMessage==='string'&&input.failureMessage.trim().length>0&&input.failureMessage.length<=3000,
        'INVALID_FAILURE_MESSAGE','Describe the reported supplier failure in at most 3,000 characters.');
      offers.find(o=>o.id===operation.offerId).available=false;
      operation.reportedFailure=input.failureMessage.trim();
      operation.recoveryAction=null; operation.failureType=null; operation.readinessConfirmed=false;
      for(const previous of plans) {
        if(previous.context.currentOperationId===operation.id&&!previous.operationId)previous.recoverySuperseded=true;
      }
      record('recovery','Supplier failure reported','The selected offer is unavailable for new plans. This report is not evidence of cancellation or refund.',{operation});
      const previous=planFor(operation.planId);
      const context={phase:'supplier-failure',failureMessage:input.failureMessage.trim(),currentOperationId:operation.id,
        currentOfferId:operation.offerId,pendingCancellation:operation.coordinatorState===2,
        priorClosureFinalized:operation.closureFinalized&&operation.permitState===3&&operation.consumed===0};
      const plan=await generatePlan({goal:previous.goal,settings:previous.policySettings,context});
      operation.recoveryAction=plan.proposal.action;
      operation.failureType=plan.interpretation?.failureType??null;
      operation.recoveryPlanId=plan.id;
      return {planId:plan.id,operationId:operation.id};
    }),
    cancel:input=>mutation(input,'cancel',async()=>{
      const operation=operationFor(input.operationId);
      if(operation.spent>0) {
        record('settled','Payment already occurred','Cancellation cannot return already spent budget.',{operation});
        return {operationId:operation.id,noop:true,reason:'payment-already-occurred'};
      }
      if(operation.coordinatorState===2||operation.closureFinalized)return {operationId:operation.id,noop:true};
      requireThat(operation.coordinatorState===1,'OPERATION_NOT_CANCELLABLE','This operation has no outstanding reservation.',409);
      requireThat(input.dropReceipt===undefined||typeof input.dropReceipt==='boolean','INVALID_FAULT','dropReceipt must be a boolean.');
      const receipt=await (await fixture.inbox.connect(fixture.chains.base.signers[operation.agentIndex]).cancel(operation.id)).wait();
      await observed('cancel','Cancellation requested','The agent requested closure. Capacity remains reserved.',operation,receipt,fixture.chains.base);
      const reaction=await relayEvent(fixture,fixture.chains.base,fixture.inbox,receipt,'CancellationRequested');
      await observed('cancel','Closure callback requested','Reactive asked the destination to close permanently.',operation,reaction.receipt,fixture.chains.reactive);
      requireThat(reaction.callbacks.length===1,'CLOSURE_CALLBACK_MISSING','No closure callback was produced.',500);
      await deliverClose(operation,reaction.callbacks[0],{dropReceipt:input.dropReceipt===true});
      return {operationId:operation.id};
    }),
    retry:input=>mutation(input,'retry',async()=>{
      const operation=operationFor(input.operationId);
      if(operation.closureFinalized||operation.status==='paid')return {operationId:operation.id,noop:true};
      if(operation.coordinatorState===2) {
        const receipt=await (await fixture.coordinator.retryCancellation(operation.id)).wait();
        await observed('retry','Closure delivery retried','The owner service retries the existing operation without creating new spending authority.',operation,receipt,fixture.chains.reactive);
        const callback=eventLogs(fixture.system,receipt,'CallbackRequested')[0]?.args;
        requireThat(callback,'CLOSURE_CALLBACK_MISSING','No retry callback was produced.',500);
        await deliverClose(operation,callback);
      } else {
        requireThat(operation.coordinatorState===1,'OPERATION_NOT_RETRYABLE','This operation has no retryable reservation.',409);
        const needsReadiness=operation.consumed===0&&operation.reportedFailure&&!operation.readinessConfirmed;
        if(needsReadiness) {
          requireThat(operation.recoveryAction==='wait'&&operation.failureType==='temporary','FAILED_SUPPLIER_REQUIRES_CLOSURE',
            'This supplier outcome does not authorize retrying payment. Close the permission or review the reported failure.',409);
          requireThat(input.confirmSupplierReady===true,'SUPPLIER_READINESS_REQUIRED',
            'Confirm that the supplier is ready before retrying this existing commitment.',409);
        }
        const block=await fixture.chains.reactive.provider.getBlock('latest');
        requireThat(block.timestamp<operation.expiresAt,'PERMIT_EXPIRED','The permit expired. Request cancellation to reconcile its outcome.',409);
        if(needsReadiness) {
          operation.readinessConfirmed=true;
          record('confirmation','Owner confirmed supplier readiness',
            'The operator explicitly confirmed readiness for this existing commitment. New purchases from the reported supplier remain unavailable.',{operation});
        }
        const receipt=await (await fixture.coordinator.retryGrant(operation.id)).wait();
        await observed('retry','Permission delivery retried','The owner service retries the same immutable permission.',operation,receipt,fixture.chains.reactive);
        const callback=eventLogs(fixture.system,receipt,'CallbackRequested')[0]?.args;
        requireThat(callback,'GRANT_CALLBACK_MISSING','No retry callback was produced.',500);
        await deliverGrant(operation,callback);
        if(operation.consumed===0)await pay(operation);
      }
      return {operationId:operation.id};
    }),
    lateGrant:input=>mutation(input,'late-grant',async()=>{
      const operation=operationFor(input.operationId); const callback=callbacks.get(operation.id);
      requireThat(callback,'NO_DELAYED_GRANT','There is no retained delayed permission for this operation.',409);
      const delivered=await deliverCallback(fixture,callback); callbacks.delete(operation.id);
      const rejected=eventLogs(delivered.chain.vault,delivered.receipt,'LateGrantRejected').length===1;
      await observed('delivery',rejected?'Delayed approval rejected':'Delayed approval delivered',
        rejected?'The closed destination did not reopen. No tokens were transferred.':'The original permission arrived. Delivery alone does not create another reservation.',
        operation,delivered.receipt,delivered.chain);
      if(eventLogs(delivered.chain.vault,delivered.receipt,'CommitmentExecuted').length) {
        const relayed=await relayEvent(fixture,delivered.chain,delivered.chain.vault,delivered.receipt,'CommitmentExecuted');
        await observed('receipt','Existing payment reported','Repeated delivery reported the already consumed payment.',operation,relayed.receipt,fixture.chains.reactive);
      }
      return {operationId:operation.id,rejected};
    }),
    finalize:input=>mutation(input,'finalize',async()=>{
      const operation=operationFor(input.operationId);
      if(operation.closureFinalized)return {operationId:operation.id,noop:true};
      requireThat(operation.permitState===3,'DESTINATION_NOT_CLOSED','The destination permit is not permanently closed.',409);
      requireThat(operation.closureObserved,'CLOSURE_NOT_OBSERVED','The closure receipt has not reached Reactive. Reserved budget cannot be released.',409);
      const commitment=await fixture.coordinator.commitments(operation.id);
      requireThat(Number(commitment.observedConsumed)===operation.consumed,'CLOSURE_OUTCOME_MISMATCH','The observed closure does not match the destination outcome.',409);
      const receipt=await finalizeFixture(fixture,operation.id,BigInt(operation.consumed));
      await observed('finalize','Local closure explicitly finalized','The trusted local finalizer checked closed state and matching observed consumption. This is simulated finality, not a public-network proof.',
        operation,receipt,fixture.chains.reactive);
      return {operationId:operation.id};
    }),
    reset:input=>mutation(input,'reset',async()=>{
      const replacement=await createFixture(); const previous=fixture; fixture=replacement;
      await initialize(); await previous.close(); return {reset:true};
    }),
    async close() {
      requireThat(!busy,'RUNTIME_BUSY','Wait for the current action before closing the runtime.',409);
      if(!stopped){
        stopped=true; await fixture.close();
        if(planner===planPurchase) {
          const module=await import('../agent/planner.mjs');
          if(typeof module.closeModel==='function')await module.closeModel();
        }
      }
    },
  };
}
