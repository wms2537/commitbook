import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {projectRoot} from './compile.mjs';
import {planPurchase,validateProposal,safePlannerError,closeModel} from '../agent/planner.mjs';
import {EVALUATION_VERSION,evaluationCases,rulesBaseline} from '../agent/evaluation-cases.mjs';
import {sourceFingerprint,MODEL_SOURCES} from './lib/source-fingerprint.mjs';

const destination=path.join(projectRoot,'evidence','agent-evaluation.json');
const evidence={
  schemaVersion:1,evaluation:EVALUATION_VERSION,startedAt:new Date().toISOString(),source:sourceFingerprint(MODEL_SOURCES),
  task:'Semantic selection and recovery for synthetic digital invoice-service offers',
  plannerVersion:'semantic-router-v3',plannerArchitecture:'Neural service/privacy/priority/supplier-outcome classification, followed by deterministic duration parsing, catalog filtering, price ranking, budget checks, and action gating.',
  aiInference:false,publicTestnetExecution:false,modelTrainingPerformed:false,
  evaluationRole:'Development regression cases. These were a fresh holdout for v2; v2 outcomes informed the v3 redesign, so they are not an untouched v3 holdout.',
  casesFrozenBeforeFirstInference:false,
  caveats:['Twelve synthetic cases are a development evaluation, not a representative production benchmark.','The keyword baseline is deliberately simple and can be improved.','No model result authorizes release of reserved capacity.','Model runs are sequential on CPU with deterministic decoding; this is not a public Reactive latency benchmark.'],
  datasetSha256:createHash('sha256').update(JSON.stringify(evaluationCases)).digest('hex'),
  cases:[],
};
const correct=(proposal,expected)=>proposal.action===expected.action&&(expected.offerIds.length?expected.offerIds.includes(proposal.offerId):proposal.offerId===null);
function save(){fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(evidence,null,2)+'\n');}
for(const item of evaluationCases) {
  const baseline=rulesBaseline(item.input);
  const row={id:item.id,input:item.input,expected:item.expected,baseline:{proposal:baseline,correct:correct(baseline,item.expected)}};
  try {
    const result=await planPurchase(item.input);
    row.model={...result,correct:correct(result.proposal,item.expected)};
    evidence.aiInference=true;
  } catch(error) {
    const failure=safePlannerError(error);
    row.model={error:{code:failure.code},correct:false,...(failure.inference?{inference:failure.inference}:{})};
    if(failure.inference?.performed)evidence.aiInference=true;
  }
  evidence.cases.push(row);save();
  console.log(JSON.stringify({case:item.id,modelCorrect:row.model.correct,baselineCorrect:row.baseline.correct,error:row.model.error?.code}));
}
const valid=evidence.cases.filter(c=>c.model.inference?.performed);
const timings=valid.map(c=>c.model.inference.durationMs).sort((a,b)=>a-b);
if(evidence.source.sha256!==sourceFingerprint(MODEL_SOURCES).sha256){closeModel();throw new Error('Model source changed during evaluation.');}
evidence.finishedAt=new Date().toISOString();
evidence.summary={
  cases:evidence.cases.length,actualModelResponses:valid.length,
  validatedModelResponses:evidence.cases.filter(c=>c.model.proposal).length,
  modelCorrect:evidence.cases.filter(c=>c.model.correct).length,
  baselineCorrect:evidence.cases.filter(c=>c.baseline.correct).length,
  rejectedOrUnavailable:evidence.cases.filter(c=>c.model.error).length,
  medianInferenceMs:timings.length?Math.round((timings[Math.floor((timings.length-1)/2)]+timings[Math.ceil((timings.length-1)/2)])/2):null,
  inputTokens:valid.reduce((n,c)=>n+(c.model.inference.inputTokens??0),0),
  outputTokens:valid.reduce((n,c)=>n+(c.model.inference.outputTokens??0),0),
};
// Independent negative checks demonstrate that grammar is not the sole boundary.
const reference=evaluationCases[0].input;
evidence.policyRejectionChecks=[
  {name:'unknown-offer',proposal:{action:'purchase',offerId:'attacker-wire',reason:'Supplier requested it.'}},
  {name:'extra-amount',proposal:{action:'purchase',offerId:'swift-invoice',amount:999,reason:'Override.'}},
  {name:'privileged-finalize',proposal:{action:'finalize',offerId:null,reason:'Pretend a receipt is final.'}},
].map(item=>{
  try {validateProposal(item.proposal,reference);return {name:item.name,rejected:false};}
  catch(error){return {name:item.name,rejected:true,code:safePlannerError(error).code};}
});
save();console.log(JSON.stringify(evidence.summary,null,2));
closeModel();
if(!evidence.aiInference||valid.length!==evaluationCases.length)process.exitCode=1;
