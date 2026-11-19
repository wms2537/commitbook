import test from 'node:test';
import assert from 'node:assert/strict';
import {planPurchase,validateProposal,buildMessages,safePlannerError} from '../agent/planner.mjs';
import {validateIntent,resolveIntent,seconds,explicitDuration} from '../agent/intent.mjs';

const offers=[
  {id:'fast',name:'Fast',description:'Private invoice extraction',service:'invoice',chain:'base',chainId:84532,amount:60,etaSeconds:20,privacy:'private',available:true},
  {id:'alternate',name:'Alternate',description:'Private invoice extraction',service:'invoice',chain:'unichain',chainId:1301,amount:50,etaSeconds:90,privacy:'private',available:true},
];
const policy={allowedOfferIds:['fast','alternate'],allowedChainIds:[84532,1301],maxPerPurchase:60,available:100,reserved:0};
const input={goal:'Extract invoices privately.',offers,policy,context:{phase:'initial'}};
const purchase={action:'purchase',offerId:'fast',reason:'Private extraction meets the goal.'};
const semantic={service:'invoice',privacy:'private',priority:'lowest-cost',failureType:'none',reason:'The goal requests private invoice extraction.'};
const fails=(fn,code)=>assert.throws(fn,e=>e.code===code);

test('planner permits only authoritative catalog terms and no generated signing fields',()=>{
  assert.equal(validateProposal(purchase,input).authorization.executable,true);
  fails(()=>validateProposal({...purchase,amount:1},input),'UNEXPECTED_PROPOSAL_FIELD');
  fails(()=>validateProposal({...purchase,recipient:'0xdead'},input),'UNEXPECTED_PROPOSAL_FIELD');
  fails(()=>validateProposal({...purchase,offerId:'outside'},input),'UNKNOWN_OFFER');
  fails(()=>validateProposal(purchase,{...input,policy:{...policy,allowedOfferIds:[]}}),'OFFER_NOT_AUTHORIZED');
  fails(()=>validateProposal(purchase,{...input,policy:{...policy,allowedChainIds:[1301]}}),'CHAIN_NOT_AUTHORIZED');
});

test('policy rejects unavailable offers, excess amount, wrong service, privacy and deadline',()=>{
  fails(()=>validateProposal(purchase,{...input,offers:offers.map(o=>({...o,available:false}))}),'OFFER_UNAVAILABLE');
  fails(()=>validateProposal(purchase,{...input,policy:{...policy,maxPerPurchase:50}}),'PER_PURCHASE_LIMIT');
  fails(()=>validateProposal(purchase,{...input,policy:{...policy,requiredService:'verification'}}),'SERVICE_NOT_AUTHORIZED');
  fails(()=>validateProposal(purchase,{...input,offers:offers.map(o=>({...o,privacy:'shared'})),policy:{...policy,requirePrivate:true}}),'PRIVATE_PROCESSING_REQUIRED');
  fails(()=>validateProposal(purchase,{...input,policy:{...policy,maxEtaSeconds:10}}),'DEADLINE_EXCEEDED');
});

test('insufficient capacity blocks recommendation without changing authoritative policy',()=>{
  const small={...input,policy:{...policy,available:40,reserved:60}};
  const before=JSON.stringify(small);
  const result=validateProposal(purchase,small);
  assert.deepEqual(result.authorization,{executable:false,requiresClosure:false,blockedReason:'insufficient-available-budget'});
  assert.equal(JSON.stringify(small),before);
});

test('replacement requires server-observed finalized closure and sufficient current budget',()=>{
  const proposal={action:'replace',offerId:'alternate',reason:'The original supplier cannot complete this batch.'};
  const recovery={...input,context:{phase:'supplier-failure',currentOperationId:'op-1',currentOfferId:'fast'},policy:{...policy,available:40,reserved:60}};
  assert.deepEqual(validateProposal(proposal,recovery).authorization,{executable:false,requiresClosure:true,blockedReason:'replacement-requires-finalized-closure'});
  const finalized={...recovery,context:{...recovery.context,priorClosureFinalized:true}};
  assert.equal(validateProposal(proposal,finalized).authorization.blockedReason,'insufficient-available-budget');
  assert.equal(validateProposal(proposal,{...finalized,policy}).authorization.executable,true);
  fails(()=>validateProposal({...proposal,offerId:'fast'},recovery),'REPLACEMENT_REUSES_FAILED_OFFER');
  fails(()=>validateProposal(purchase,recovery),'RECOVERY_MUST_USE_REPLACEMENT');
});

test('wait and escalation have no spending authority or offer attached',()=>{
  assert.equal(validateProposal({action:'wait',offerId:null,reason:'Capacity remains reserved.'},input).authorization.executable,false);
  fails(()=>validateProposal({action:'escalate',offerId:'fast',reason:'Uncertain outcome.'},input),'NON_PURCHASE_HAS_OFFER');
});

test('malformed model content and context reject before authority is returned',()=>{
  fails(()=>validateProposal('not json',input),'INVALID_MODEL_JSON');
  fails(()=>validateProposal({...purchase,action:'finalize'},input),'INVALID_ACTION');
  fails(()=>validateProposal({...purchase,reason:''},input),'INVALID_REASON');
  fails(()=>buildMessages({...input,goal:''}),'INVALID_GOAL');
  fails(()=>validateProposal(purchase,{...input,context:{phase:'initial',pendingCancellation:true}}),'CANCELLATION_STILL_PENDING');
});

test('model prompt omits signing fields and identifies supplier prose as untrusted',()=>{
  const messages=buildMessages({...input,offers:offers.map(o=>({...o,recipient:'secret-recipient',privateKey:'do-not-send'})),policy:{...policy,privateKey:'do-not-send'},context:{...input.context,privateKey:'do-not-send'}});
  assert.match(messages[0].content,/untrusted data/);
  assert.doesNotMatch(JSON.stringify(messages),/secret-recipient|do-not-send/);
});

test('provider adapter records inference only after a completed validated response',async()=>{
  let sent;
  const result=await planPurchase(input,{env:{},fetchImpl:async(url,options)=>{
    sent=JSON.parse(options.body);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(semantic)},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:30}}));
  }});
  assert.equal(result.inference.performed,true);
  assert.equal(result.inference.inputTokens,100);
  assert.equal(sent.max_tokens,256);
  assert.equal(sent.response_format.schema.additionalProperties,false);
  assert.equal(result.proposal.offerId,'alternate');
  assert.equal(result.inference.plannerVersion,'semantic-router-v3');
});

test('provider errors, truncation and invalid output never silently fall back to a scripted plan',async()=>{
  await assert.rejects(()=>planPurchase(input,{env:{},fetchImpl:async()=>{throw new Error('secret URL token');}}),e=>e.code==='MODEL_UNAVAILABLE'&&!e.message.includes('secret'));
  await assert.rejects(()=>planPurchase(input,{env:{},fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(purchase)},finish_reason:'length'}]}))}),e=>e.code==='MODEL_OUTPUT_INCOMPLETE');
  await assert.rejects(()=>planPurchase(input,{env:{},fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({...semantic,service:'evil'})},finish_reason:'stop'}]}))}),e=>e.code==='INVALID_SEMANTIC_SERVICE');
  assert.deepEqual(safePlannerError(new Error('private-key=secret')),{code:'PLANNER_UNAVAILABLE'});
});

test('semantic parser cannot insert an offer, amount or privileged action',()=>{
  fails(()=>validateIntent({...semantic,amount:999},['invoice']),'UNEXPECTED_SEMANTIC_FIELD');
  fails(()=>validateIntent({...semantic,service:'bank-transfer'},['invoice']),'INVALID_SEMANTIC_SERVICE');
  fails(()=>validateIntent({...semantic,deadline:{value:-1,unit:'seconds'}},['invoice']),'UNEXPECTED_SEMANTIC_FIELD');
});

test('deterministic ranking computes price and deadline from interpreted units',()=>{
  assert.equal(seconds({value:0.5,unit:'minutes'}),30);
  assert.equal(seconds(explicitDuration('inside one minute')),60);
  assert.equal(seconds(explicitDuration('a three-minute turnaround')),180);
  assert.equal(seconds(explicitDuration('within twenty-five seconds')),25);
  assert.equal(seconds(explicitDuration('inside half a minute')),30);
  assert.equal(seconds(explicitDuration('inside a quarter of an hour')),900);
  assert.equal(explicitDuration('before lunch'),null);
  assert.equal(resolveIntent(semantic,input).offerId,'alternate');
  assert.equal(resolveIntent(semantic,{...input,goal:'Finish within half minutes.'}).offerId,'fast');
  assert.equal(resolveIntent({...semantic,priority:'fastest'},input).offerId,'fast');
  assert.equal(resolveIntent(semantic,{...input,goal:'Finish within one second.'}).action,'escalate');
  assert.equal(resolveIntent(semantic,{...input,goal:'Finish before lunch.'}).action,'escalate');
});

test('compact durations constrain purchasing even when the structured owner ceiling is looser',()=>{
  const bounded={...input,policy:{...policy,maxEtaSeconds:120}};
  for(const goal of ['Return the result within 5s.','Return the result within5s.','Return the result within 5 sec.']) {
    assert.equal(seconds(explicitDuration(goal)),5,goal);
    assert.equal(resolveIntent(semantic,{...bounded,goal}).action,'escalate',goal);
  }
  for(const goal of ['Return the result within 1m.','Return the result within1min.','Return the result within 0.5min.']) {
    assert.equal(resolveIntent(semantic,{...bounded,goal}).offerId,'fast',goal);
  }
  assert.equal(seconds(explicitDuration('within 1m')),60);
  assert.equal(seconds(explicitDuration('within 0.5h')),1800);
  assert.equal(explicitDuration('Process the invoice as quickly as possible.'),null);
  assert.equal(explicitDuration('I am requesting invoice extraction.'),null);
  assert.equal(explicitDuration('Give us high fives.'),null);
  assert.equal(resolveIntent(semantic,{...bounded,goal:'Return within 5m.',policy:{...bounded.policy,maxEtaSeconds:30}}).offerId,'fast');
});

test('unparsed timing requirements cannot be relaxed by a structured owner ceiling',()=>{
  const bounded={...input,policy:{...policy,maxEtaSeconds:120}};
  for(const goal of [
    'Return the result within 500 milliseconds.',
    'Return the result within500milliseconds.',
    'Return the result within 500ms.',
    'Return before lunch.',
    'Return within .5s.',
    'Return within 2 minutes, but critical invoices need 500 milliseconds.',
  ])assert.equal(resolveIntent(semantic,{...bounded,goal}).action,'escalate',goal);
  assert.equal(explicitDuration('within 500 milliseconds'),null);
  assert.equal(resolveIntent(semantic,bounded).offerId,'alternate');
});

test('semantic preferences can restrict but cannot expand owner authorization',()=>{
  const restricted={...input,policy:{...policy,allowedOfferIds:['fast'],maxPerPurchase:50}};
  assert.equal(resolveIntent(semantic,restricted).action,'escalate');
  assert.equal(resolveIntent({...semantic,privacy:'any'},{...input,policy:{...policy,requirePrivate:true}}).offerId,'alternate');
  assert.equal(resolveIntent({...semantic,service:'unknown'},input).action,'escalate');
  assert.equal(resolveIntent({...semantic,service:'verification'},input).action,'escalate');
});

test('temporary supplier pauses use deterministic duration arithmetic',()=>{
  const recovery={...input,goal:'Finish within two minutes.',context:{phase:'supplier-failure',currentOperationId:'op',currentOfferId:'fast',failureMessage:'Maintenance ends in twelve seconds.'}};
  const pause={...semantic,failureType:'temporary'};
  assert.equal(resolveIntent(pause,recovery).action,'wait');
  assert.equal(resolveIntent(pause,{...recovery,context:{...recovery.context,failureMessage:'Unknown delay'}}).action,'escalate');
  assert.equal(resolveIntent(pause,{...recovery,context:{...recovery.context,failureMessage:'Maintenance ends in three minutes.'}}).action,'replace');
  assert.equal(resolveIntent({...pause,failureType:'uncertain'},recovery).action,'escalate');
  assert.equal(resolveIntent({...pause,failureType:'already-completed'},recovery).action,'escalate');
});

test('nonlocal plaintext model endpoints are rejected and credentials stay in headers',async()=>{
  await assert.rejects(()=>planPurchase(input,{env:{COMMITBOOK_LLM_URL:'http://example.com/v1/chat/completions'}}),e=>e.code==='INSECURE_MODEL_ENDPOINT');
  await assert.rejects(()=>planPurchase(input,{env:{COMMITBOOK_LLM_URL:'https://example.com/v1/chat/completions?key=secret'}}),e=>e.code==='INVALID_MODEL_ENDPOINT');
  await assert.rejects(()=>planPurchase(input,{env:{COMMITBOOK_LLM_MODEL:'a-different-unloaded-model'}}),e=>e.code==='LOCAL_MODEL_ALIAS_MISMATCH');
});
