export const PLANNER_VERSION='semantic-router-v3';
export function intentSchema(services) {
  return {type:'object',additionalProperties:false,properties:{
    service:{type:'string',enum:[...new Set([...services,'unknown'])]},
    privacy:{type:'string',enum:['private','any']},
    priority:{type:'string',enum:['lowest-cost','fastest']},
    failureType:{type:'string',enum:['none','temporary','permanent','uncertain','already-completed']},
    reason:{type:'string',minLength:1,maxLength:200},
  },required:['service','privacy','priority','failureType','reason']};
}
const fail=(condition,code)=>{if(!condition)throw Object.assign(new Error(code),{code});};
const numberWords={zero:0,a:1,an:1,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90,half:0.5,quarter:0.25};
const wordPattern=Object.keys(numberWords).sort((a,b)=>b.length-a.length).join('|');
const numberPattern=`\\d+(?:\\.\\d+)?|(?:half|quarter)(?:[ -]+(?:an?|of[ -]+an?))?|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|(?:${wordPattern})`;
// Only digits may touch the unit; written numbers need a separator so "as" is not "a s".
const durationPattern=new RegExp(`(?<![-\\d.])\\b(${numberPattern})(?:(?<=\\d)[ -]*|[ -]+)(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\\b`,'gi');
const unsupportedTimingUnit=/(?<![a-z])(?:milliseconds?|msecs?|microseconds?|usecs?|nanoseconds?|nsecs?|days?|weeks?|months?|years?)\b|\d\s*(?:ms|us|ns)\b/i;
const timingRequirement=/\b(?:deadline|within|inside|before|turnaround|tomorrow|tonight|noon|midnight)|(?<![a-z])(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)\b|\d\s*(?:s|m|h)\b|\bby\s+\d/i;
export function explicitDuration(text='') {
  const normalized=text.replace(/\b(within|inside|before|after|in)(?=\d)/gi,'$1 ');
  const values=[...normalized.matchAll(durationPattern)].map(match=>{
    const token=match[1].toLowerCase();
    const parts=token.split(/[ -]/);
    const value=/^\d/.test(token)?Number(token):parts.filter(part=>parts.length===1||!['a','an','of'].includes(part)).reduce((n,part)=>n+numberWords[part],0);
    const unit=/^s/i.test(match[2])?'seconds':/^m/i.test(match[2])?'minutes':'hours';
    return {value,unit,source:match[0]};
  }).filter(value=>Number.isFinite(value.value)&&value.value>=0&&seconds(value)<=86400);
  values.sort((a,b)=>seconds(a)-seconds(b));
  return values[0]??null;
}
export function seconds(value) {
  if(value===null)return Infinity;
  return value.value*({seconds:1,minutes:60,hours:3600}[value.unit]);
}
export function validateIntent(raw,services) {
  if(typeof raw==='string') {
    fail(raw.length<=4000,'SEMANTIC_RESPONSE_TOO_LARGE');
    try {raw=JSON.parse(raw);} catch {throw Object.assign(new Error('INVALID_MODEL_JSON'),{code:'INVALID_MODEL_JSON'});}
  }
  fail(raw&&typeof raw==='object'&&!Array.isArray(raw),'INVALID_SEMANTIC_INTENT');
  const fields=['service','privacy','priority','failureType','reason'];
  fail(Object.keys(raw).length===fields.length&&fields.every(k=>Object.hasOwn(raw,k)),'UNEXPECTED_SEMANTIC_FIELD');
  fail([...services,'unknown'].includes(raw.service),'INVALID_SEMANTIC_SERVICE');
  fail(['private','any'].includes(raw.privacy),'INVALID_SEMANTIC_PRIVACY');
  fail(['lowest-cost','fastest'].includes(raw.priority),'INVALID_SEMANTIC_PRIORITY');
  fail(['none','temporary','permanent','uncertain','already-completed'].includes(raw.failureType),'INVALID_SEMANTIC_FAILURE');
  fail(typeof raw.reason==='string'&&raw.reason.trim().length>0&&raw.reason.length<=200,'INVALID_REASON');
  return {service:raw.service,privacy:raw.privacy,priority:raw.priority,failureType:raw.failureType,reason:raw.reason.trim()};
}

export function resolveIntent(intent,{goal='',offers,policy,context={}}) {
  const defer=(action,reason)=>({action,offerId:null,reason});
  if(intent.service==='unknown')return defer('escalate','The requested service is not in the approved catalog.');
  if(policy.requiredService&&policy.requiredService!==intent.service)return defer('escalate','The interpreted service conflicts with the owner policy.');
  const deadline=explicitDuration(goal);
  const delay=explicitDuration(context.failureMessage??'');
  if(unsupportedTimingUnit.test(goal)||(!deadline&&timingRequirement.test(goal)))return defer('escalate','The timing requirement needs a supported explicit duration; an owner ceiling cannot resolve an unparsed prose deadline.');
  const maxEta=Math.min(policy.maxEtaSeconds??Infinity,seconds(deadline));
  const privateOnly=policy.requirePrivate||intent.privacy==='private';
  const recovery=context.phase==='supplier-failure';
  if(recovery) {
    if(['uncertain','already-completed','none'].includes(intent.failureType))return defer('escalate','The supplier outcome needs verification before any replacement purchase.');
    if(intent.failureType==='temporary') {
      const current=offers.find(o=>o.id===context.currentOfferId);
      if(maxEta===Infinity||(delay&&current&&current.etaSeconds+seconds(delay)<=maxEta))return defer('wait','The stated temporary delay fits the deadline; retain the existing commitment.');
      if(!delay)return defer('escalate','A temporary interruption has no reliable duration for the requested deadline.');
    }
  }
  const candidates=offers.filter(o=>o.available&&(!recovery||o.id!==context.currentOfferId)&&policy.allowedOfferIds.includes(o.id)&&policy.allowedChainIds.includes(o.chainId)&&o.amount<=policy.maxPerPurchase&&o.service===intent.service&&(!privateOnly||o.privacy==='private')&&o.etaSeconds<=maxEta);
  candidates.sort(intent.priority==='fastest'?(a,b)=>a.etaSeconds-b.etaSeconds||a.amount-b.amount||a.id.localeCompare(b.id):(a,b)=>a.amount-b.amount||a.etaSeconds-b.etaSeconds||a.id.localeCompare(b.id));
  const selected=candidates[0];
  if(!selected)return defer('escalate','No approved available offer meets the interpreted service, privacy, and deadline requirements.');
  if(!recovery&&selected.amount>policy.available)return defer('wait','The suitable offer exceeds current available capacity; outstanding reservations remain locked.');
  return {action:recovery?'replace':'purchase',offerId:selected.id,reason:`${selected.name??selected.id} meets the interpreted requirements at ${selected.amount} units. ${intent.reason}`.slice(0,400)};
}
