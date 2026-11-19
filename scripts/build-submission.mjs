#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryUrl = 'https://github.com/wms2537/commitbook';
const requirementsUrl = 'https://blog.reactive.network/reactive-omni-buildathon-thirty-days-to-find-out-what-one-second-buys/';
const scopedWallet = '0x4C4543217e66Ac3124d795785C63fa160B181C25';
const evidenceNames = [
  'verification.json', 'agent-workflow.json', 'agent-evaluation.json',
  'testnet-ai-plan.json', 'submission-readiness.json', 'deployment-estimate.json',
  'submission-preflight.json', 'testnet-deployment.json', 'testnet-loop.json',
];
const requiredChecks = ['local-verification', 'public-deployment', 'model-public-loop',
  'public-source', 'submission-video', 'public-chain-receipts'];
const sensitiveKeys = /privatekeys?|mnemonic|seedphrase|password|passphrase|apikey|accesstoken|refreshtoken|bearertoken|^secret(?:s|key)?$|^credentials?$|^headers?$|^raw$|^rawtransactions?$|^signedtransactions?$|^signedpayloads?$|^rawpayloads?$|^keystore$/i;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const count = value => number(value) !== null && value >= 0 ? value : null;
const display = value => value === null || value === undefined ? 'Pending' : String(value);
const dateLabel = value => {
  const date = new Date(value ?? '');
  return Number.isNaN(date.valueOf()) ? 'Not recorded' : new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur',
  }).format(date) + ' MYT';
};

// These fixed evidence files contain public demonstration data. Strip accidental
// credentials and signed payloads recursively; never traverse private directories.
export function sanitizeEvidence(value, key = '') {
  if (typeof value === 'string' && /^authorization$/i.test(key)) return '[credential removed]';
  if (Array.isArray(value)) return value.map(item => sanitizeEvidence(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([name]) => !sensitiveKeys.test(name.replace(/[^a-z0-9]/gi, '')))
      .map(([name, item]) => [name, sanitizeEvidence(item, name)]));
  }
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      return /rpc|endpoint/i.test(key) ? url.origin : url.href;
    } catch { return '[invalid URL removed]'; }
  }
  return value;
}

export function strictReportReady(report) {
  return report?.ready === true && report.mode === 'online-read-only'
    && report.status === 'ready-to-submit' && Array.isArray(report.checks)
    && report.checks.length >= requiredChecks.length
    && report.checks.every(check => check.status === 'pass')
    && requiredChecks.every(id => report.checks.some(check => check.id === id && check.status === 'pass'));
}

function currentSourceHash(root) {
  const walk = relative => fs.readdirSync(path.join(root, relative), {withFileTypes: true})
    .flatMap(entry => entry.isDirectory() ? walk(path.join(relative, entry.name)) : [path.join(relative, entry.name)]);
  const files = ['contracts', 'scripts', 'test', 'app', 'agent'].flatMap(walk)
    .concat(['package.json', 'package-lock.json']).sort();
  const hash = createHash('sha256');
  for (const relative of files) hash.update(relative).update('\0').update(fs.readFileSync(path.join(root, relative))).update('\0');
  return hash.digest('hex');
}

export function summarizeEvidence(records, {generatedAt = new Date().toISOString(), sourceHash = null, assets = {}} = {}) {
  const verification = records['verification.json'];
  const workflow = records['agent-workflow.json'];
  const evaluation = records['agent-evaluation.json'];
  const plan = records['testnet-ai-plan.json'];
  const readiness = records['submission-readiness.json'];
  const deployment = records['testnet-deployment.json'];
  const loop = records['testnet-loop.json'];
  const preflight = records['submission-preflight.json'];
  const estimate = records['deployment-estimate.json'];
  const offer = plan?.input?.offers?.find(item => item.id === plan?.result?.proposal?.offerId);
  const budget = Object.fromEntries(['cap', 'spent', 'reserved', 'available']
    .map(key => [key, count(workflow?.summary?.finalBudget?.[key])]));
  const checks = Array.isArray(readiness?.checks) ? readiness.checks : [];
  const sourceCurrent = typeof sourceHash === 'string' && verification?.sourceSha256 === sourceHash;
  const ready = strictReportReady(readiness) && sourceCurrent;
  const trace = [
    ['sourceRequest', 'Source request', 'Base Sepolia', 84532],
    ['reactiveReservation', 'Reactive reservation', 'Reactive Lasna', 5318007],
    ['destinationGrant', 'Destination callback', 'Base Sepolia', 84532],
    ['payment', 'Token payment', 'Base Sepolia', 84532],
    ['reactiveSpend', 'Spend reconciliation', 'Reactive Lasna', 5318007],
    ['repeatedExecution', 'Replay without payment', 'Base Sepolia', 84532],
  ].map(([key, label, network, chainId]) => {
    const receipt = loop?.evidence?.[key];
    const valid = receipt?.chainId === chainId && receipt.status === 1
      && /^0x[0-9a-f]{64}$/i.test(receipt.transactionHash ?? '');
    return {key, label, network, chainId, transactionHash: valid ? receipt.transactionHash : null,
      status: valid ? ready ? 'Verified' : 'Recorded, not reverified' : 'Pending'};
  });
  return {
    schemaVersion: 1, generatedAt, title: 'CommitBook / Submission review',
    status: ready ? 'Submission evidence ready' : 'Public execution pending', ready,
    readiness: {checkedAt: readiness?.checkedAt ?? null, mode: readiness?.mode ?? null,
      status: readiness?.status ?? 'report-not-recorded', checks: checks.map(({id, status, code}) => ({id, status, code}))},
    verification: {success: verification?.success === true, sourceCurrent,
      testsPassed: count(verification?.testsPassed), testsFailed: count(verification?.testsFailed),
      finishedAt: verification?.finishedAt ?? null, sourceSha256: verification?.sourceSha256 ?? null},
    local: {passed: workflow?.summary?.passed === true && workflow?.aiInference === true,
      mode: workflow?.mode ?? null, publicTestnetExecution: workflow?.publicTestnetExecution === true,
      finishedAt: workflow?.finishedAt ?? null, budget, inferenceCalls: count(workflow?.summary?.inferenceCalls),
      checkpointCount: Array.isArray(workflow?.checkpoints) ? workflow.checkpoints.length : null,
      duplicatePayments: count(workflow?.summary?.duplicatePayments)},
    proposal: {recorded: plan?.result?.inference?.performed === true, createdAt: plan?.createdAt ?? null,
      validUntil: plan?.validUntil ?? null, goal: plan?.input?.goal ?? null, offer: offer?.name ?? null,
      amount: count(offer?.amount), model: plan?.result?.inference?.model ?? null,
      provider: plan?.result?.inference?.provider ?? null, durationMs: count(plan?.result?.inference?.durationMs),
      executable: plan?.result?.authorization?.executable === true, digest: plan?.sha256 ?? null},
    evaluation: {actualInference: evaluation?.aiInference === true, cases: count(evaluation?.summary?.cases),
      modelCorrect: count(evaluation?.summary?.modelCorrect), baselineCorrect: count(evaluation?.summary?.baselineCorrect),
      finishedAt: evaluation?.finishedAt ?? null},
    public: {recordedExecution: loop?.publicTestnetExecution === true,
      operationId: /^0x[0-9a-f]{64}$/i.test(loop?.operationId ?? '') ? loop.operationId : null, trace,
      contracts: ['inbox', 'coordinator', 'token', 'vault'].map(name => ({name,
        address: /^0x[0-9a-f]{40}$/i.test(deployment?.contracts?.[name]?.address ?? '') ? deployment.contracts[name].address : null}))},
    funding: {wallet: scopedWallet, requestedBaseTestEth: '0.01', conversionBaseTestEth: '0.006', resultingLasnaLreact: '0.6',
      checkedAt: preflight?.checkedAt ?? null,
      balances: ['base-sepolia', 'lasna'].map(id => {
        const network = preflight?.networks?.find(item => item.id === id);
        return {network: id === 'lasna' ? 'Reactive Lasna' : 'Base Sepolia', symbol: network?.symbol ?? (id === 'lasna' ? 'lREACT' : 'ETH'),
          balance: network?.signer?.address?.toLowerCase() === scopedWallet.toLowerCase() ? network.signer.balanceNative : null};
      }),
      estimateCheckedAt: estimate?.checkedAt ?? null,
      estimates: Array.isArray(estimate?.totals) ? estimate.totals.filter(total => [84532, 5318007].includes(total.chainId))
        .map(({chainId, gasEstimate, valuePlusExecutionFeeWith20PercentGasMarginNative, symbol}) => ({chainId, gasEstimate,
          amount: valuePlusExecutionFeeWith20PercentGasMarginNative, symbol})) : []},
    assets, links: {repository: repositoryUrl, requirements: requirementsUrl},
    evidence: evidenceNames.filter(name => records[name]).map(name => ({name, url: `./evidence/${name}`})),
    note: 'Static review of recorded evidence. This page does not run a model, connect a wallet, or submit transactions.',
  };
}

export function renderSubmission(s) {
  const e = escapeHtml;
  const metric = value => e(display(value));
  const budget = s.local.budget;
  const hasBudget = Object.values(budget).every(value => value !== null) && budget.cap > 0;
  const invariant = hasBudget && budget.spent + budget.reserved <= budget.cap
    && budget.available === budget.cap - budget.spent - budget.reserved;
  const width = value => hasBudget ? Math.max(0, Math.min(100, value / budget.cap * 100)) : 0;
  const checkStatus = id => s.readiness.checks.find(check => check.id === id)?.status ?? 'pending';
  const link = (href, label, className = '') => `<a class="${className}" href="${e(href)}"${/^https:/.test(href) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${e(label)}</a>`;
  const score = (correct, cases) => correct !== null && cases !== null ? `${correct}<span> / ${cases}</span>` : 'Pending';
  const modelDuration = s.proposal.durationMs === null ? 'Not recorded' : `${(s.proposal.durationMs / 1000).toFixed(3).replace(/\.?0+$/, '')} seconds`;
  const localLabel = s.local.passed ? 'Local recovery recorded' : 'Local recovery pending';
  const testLabel = s.verification.success && s.verification.sourceCurrent ? 'Current source verified' : s.verification.success ? 'Historical test result' : 'Verification pending';
  const traceRows = s.public.trace.map(row => `<tr><th scope="row">${e(row.label)}</th><td data-label="Network">${e(row.network)}</td><td data-label="Transaction">${row.transactionHash ? `<code>${e(row.transactionHash)}</code><span class="record-label">${e(row.status)}</span>` : '<span class="pending">Pending</span><span class="record-label">No public hash recorded</span>'}</td></tr>`).join('');
  const gates = [['public-deployment', 'Public contracts'], ['model-public-loop', 'Model-linked operation'], ['public-chain-receipts', 'Public callback trace'], ['public-source', 'Public source'], ['submission-video', 'Submission video']]
    .map(([id, label]) => `<li><span>${e(label)}</span><span class="gate ${checkStatus(id) === 'pass' ? 'passed' : 'pending'}">${checkStatus(id) === 'pass' ? 'Passed' : checkStatus(id) === 'fail' ? 'Needs work' : 'Pending'}</span></li>`).join('');
  const readyMessage = s.ready
    ? 'The online readiness report passed its required checks. Review the source, public receipts, and video before completing the DoraHacks entry.'
    : s.public.recordedExecution
      ? 'A public loop is recorded. Final online checks must pass before this packet can report submission readiness.'
      : 'The local model and recovery workflow are recorded. The Base Sepolia and Lasna callback loop still needs public transaction evidence.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#172c34"><meta name="description" content="CommitBook submission evidence, recorded recovery results, and remaining public execution requirements."><title>CommitBook / Submission review</title>
<style>
:root{color-scheme:light;--paper:#f5f5ef;--white:#fff;--ink:#172c34;--soft:#4d646a;--line:#d8e1da;--teal:#13766b;--mint:#a9d5bd;--mint-light:#eaf4ee;--amber:#f5e5c8;--amber-ink:#79500f;--radius:18px;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:16px}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;color:var(--ink);background:var(--paper);font-size:16px;line-height:1.55}a{color:var(--teal);text-underline-offset:4px;overflow-wrap:anywhere}a:focus-visible,summary:focus-visible{outline:3px solid var(--teal);outline-offset:5px}h1,h2,h3,p{margin:0}h1{font-size:clamp(32px,4.4vw,54px);line-height:1.08;letter-spacing:-1.8px;font-weight:660}h2{font-size:clamp(24px,2.8vw,32px);line-height:1.2;letter-spacing:-.8px}h3{font-size:20px;line-height:1.3}p+p{margin-top:12px}code{font-family:"SFMono-Regular",Consolas,monospace;font-size:16px;overflow-wrap:anywhere;word-break:break-word}small{font-size:16px}.shell{max-width:1240px;margin:auto;padding:0 32px}.skip{position:absolute;left:20px;top:-100px;padding:12px;background:#fff;z-index:5}.skip:focus{top:12px}.masthead{display:flex;align-items:center;justify-content:space-between;gap:24px;padding-top:28px;padding-bottom:24px;border-bottom:1px solid var(--line)}.brand{display:flex;align-items:center;gap:12px;color:var(--ink);text-decoration:none}.brand strong{font-size:24px;letter-spacing:-.8px}.brand span{display:block;color:var(--soft);font-size:16px}.brand-mark{width:39px;height:43px;border:2px solid var(--ink);border-radius:8px;display:flex;align-items:flex-end;gap:3px;padding:9px 7px;background:white;flex-shrink:0}.brand-mark i{display:block;width:6px;background:var(--teal);border-radius:1px}.brand-mark i:nth-child(1){height:11px}.brand-mark i:nth-child(2){height:21px}.brand-mark i:nth-child(3){height:16px}nav{display:flex;gap:22px;flex-wrap:wrap}nav a{color:var(--soft);text-decoration:none;font-size:16px}.hero{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:40px;padding:48px 0 32px;align-items:start}.hero-copy{padding:12px 0}.eyebrow{font-size:16px;font-weight:650;color:var(--teal);letter-spacing:.07em;text-transform:uppercase;margin-bottom:20px}.status{display:inline-flex;align-items:center;gap:9px;color:var(--amber-ink);background:var(--amber);font-size:16px;border-radius:99px;padding:7px 13px;margin-bottom:18px}.status::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}.status.ready{color:#fff;background:var(--teal)}.intro{font-size:18px;color:var(--soft);margin-top:20px;max-width:610px}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:26px}.button{min-height:46px;display:inline-flex;align-items:center;justify-content:center;padding:10px 16px;border-radius:8px;border:1px solid var(--line);background:#fff;color:var(--ink);text-decoration:none;font-size:16px;font-weight:600;max-width:100%;text-align:center}.button.primary{background:var(--teal);border-color:var(--teal);color:white}.stamp{font-size:16px;color:var(--soft);margin-top:20px}.ledger{background:var(--ink);color:white;border-radius:var(--radius);padding:28px;min-width:0;box-shadow:0 12px 32px #172c3414}.ledger-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.ledger-top p{color:#c5d6d3;font-size:16px}.cap{border:1px solid #52676b;border-radius:7px;padding:7px 10px;text-align:center;flex-shrink:0;font-size:16px}.cap strong{display:block;font-size:24px}.available-label{color:#c5d6d3;margin-top:27px;font-size:16px}.available{font-size:80px;line-height:1.06;letter-spacing:-3px;margin-top:5px;font-variant-numeric:tabular-nums}.available span{font-size:18px;color:#c5d6d3;letter-spacing:0;margin-left:10px}.budget-track{display:flex;height:13px;border-radius:5px;overflow:hidden;background:#324d55;margin-top:24px}.spent-segment{background:#688d88}.reserved-segment{background:#e8bc75}.available-segment{background:var(--mint)}.ledger-pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:20px 0;border-bottom:1px solid #40575c}.ledger-pair span{display:block;font-size:16px;color:#c5d6d3}.ledger-pair strong{display:block;font-size:28px;font-variant-numeric:tabular-nums;margin-top:2px}.invariant{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:18px;color:#cde5d8;font-size:16px}.ledger-footnote{margin-top:14px;color:#c5d6d3;font-size:16px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}.panel{min-width:0;padding:26px;background:white;border:1px solid var(--line);border-radius:var(--radius)}.panel p{color:var(--soft);font-size:16px}.panel h3+p{margin-top:12px}.metric{font-size:42px;line-height:1.15;letter-spacing:-1px;font-weight:650;font-variant-numeric:tabular-nums;margin:18px 0 10px}.metric span{font-size:18px;font-weight:450;color:var(--soft);letter-spacing:0}.tag{display:inline-block;font-size:16px;padding:4px 9px;border-radius:5px;background:var(--mint-light);color:#0e5e55;margin-bottom:14px}.tag.warn{background:var(--amber);color:var(--amber-ink)}.evidence-link{display:inline-block;font-size:16px;margin-top:18px}.section{margin-top:38px}.section-head{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:18px}.section-head p{color:var(--soft);max-width:570px;font-size:16px}.split{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:28px}.scores{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:20px 0}.scores>div{background:var(--paper);padding:18px;border-radius:10px;min-width:0}.scores strong{display:block;font-size:36px;letter-spacing:-1px;line-height:1.3}.scores strong span{font-size:20px;color:var(--soft);font-weight:400}.scores p{font-size:16px}.goal{margin-top:16px;padding:16px 18px;border-left:3px solid var(--teal);background:var(--paper);font-size:18px;overflow-wrap:anywhere}.facts{margin:18px 0 0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}.facts dt{color:var(--soft);font-size:16px}.facts dd{margin:3px 0 0;font-size:18px;font-weight:600;overflow-wrap:anywhere}.trace-panel{padding:0;overflow:hidden}.trace-intro{padding:24px 26px;border-bottom:1px solid var(--line);color:var(--soft)}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{font-size:16px;text-align:left;padding:17px 24px;vertical-align:top;overflow-wrap:anywhere;border-bottom:1px solid var(--line)}thead th{font-weight:600;background:#edf2ed;color:var(--soft)}thead th:nth-child(1){width:30%}thead th:nth-child(2){width:25%}tbody th{font-weight:600}tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}.pending{color:var(--amber-ink)}.record-label{display:block;font-size:16px;color:var(--soft);margin-top:4px}.gate-list{list-style:none;margin:20px 0 0;padding:0}.gate-list li{display:flex;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--line);font-size:16px}.gate-list li:last-child{border-bottom:0}.gate{font-size:16px;white-space:nowrap}.passed{color:var(--teal)}.funding{background:#eaf1ec;border-color:#c9d9ce}.funding-amount{font-size:36px;font-weight:650;line-height:1.2;margin:20px 0 5px;letter-spacing:-1px}.wallet{display:block;padding:14px 16px;background:#fff;border:1px solid #c5d8cb;border-radius:8px;user-select:all;margin-top:16px;line-height:1.7;word-break:break-all}.balance-list{display:flex;gap:18px;flex-wrap:wrap;margin-top:15px;font-size:16px;color:var(--soft)}.estimate{margin-top:20px;padding-top:18px;border-top:1px solid #c5d8cb}.estimate p+p{margin-top:8px}.note{font-size:16px;color:var(--soft);margin-top:14px}.downloads{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 24px;list-style:none;margin:18px 0 0;padding:0}.downloads li{min-width:0;padding:9px 0;border-bottom:1px solid var(--line);font-size:16px}.downloads a{overflow-wrap:anywhere}details{margin-top:22px;border-top:1px solid var(--line);padding-top:18px}summary{font-size:16px;font-weight:600;cursor:pointer}.contracts{margin-top:16px;display:grid;gap:12px}.contracts p{font-size:16px}.contracts code{display:block;margin-top:3px}footer{padding:34px 0 38px;color:var(--soft);font-size:16px;border-top:1px solid var(--line);margin-top:38px}footer p+p{margin-top:8px}.footer-links{display:flex;gap:20px;flex-wrap:wrap;margin-top:16px}.wrap{overflow-wrap:anywhere}
@media(max-width:960px){.hero{gap:24px;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.grid{grid-template-columns:1fr 1fr}.grid .panel:last-child{grid-column:1/-1}.split{grid-template-columns:1fr}.section-head{display:block}.section-head p{margin-top:12px}.ledger{padding:24px}.hero-copy{padding:0}}
@media(max-width:680px){.shell{padding-left:18px;padding-right:18px}.masthead{align-items:flex-start;flex-direction:column;gap:20px;padding-top:22px;padding-bottom:22px}nav{gap:20px}.hero{grid-template-columns:1fr;padding-top:30px;gap:24px}.hero-copy{min-width:0}.eyebrow{margin-bottom:15px}h1{letter-spacing:-1px}.intro{font-size:18px}.actions{gap:9px}.button{flex:1 1 140px}.ledger{padding:24px}.grid{grid-template-columns:1fr}.grid .panel:last-child{grid-column:auto}.panel{padding:22px}.trace-panel{padding:0}.section{margin-top:30px}.facts{grid-template-columns:1fr}.scores{gap:12px}.scores>div{padding:15px}.trace-intro{padding:20px 22px}table,tbody{display:block;width:100%}thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}tr{display:grid;padding:18px 22px;gap:8px;border-bottom:1px solid var(--line)}tbody tr:last-child{border-bottom:0}th,td{display:block;width:100%;padding:0;border:0}td[data-label]::before{content:attr(data-label);display:block;font-size:16px;font-weight:600;color:var(--soft);margin-bottom:3px}tbody th{font-size:18px;margin-bottom:3px}.downloads{grid-template-columns:1fr}.funding-amount{font-size:32px}.gate-list li{gap:12px}.wallet{padding:13px;font-size:16px}.invariant{gap:8px}footer{padding-bottom:28px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}@media print{body{background:#fff}.shell{max-width:none}.hero{padding-top:24px}.panel,.ledger{break-inside:avoid;box-shadow:none}nav,.skip{display:none}.button{border-color:#999}a{color:inherit}}
</style></head><body><a class="skip" href="#main">Skip to review</a>
<header class="shell masthead"><a class="brand" href="./submission.html"><div class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></div><div><strong>CommitBook</strong><span>Submission review</span></div></a><nav aria-label="Review navigation"><a href="#evidence">Evidence</a><a href="#public-trace">Public trace</a><a href="#next-step">Next step</a></nav></header>
<main id="main" class="shell"><section class="hero" aria-labelledby="status-title"><div class="hero-copy"><p class="eyebrow">Reactive Meets AI</p><span class="status ${s.ready ? 'ready' : ''}">${s.ready ? 'Online checks passed' : 'Submission gate open'}</span><h1 id="status-title">${e(s.status)}</h1><p class="intro">${e(readyMessage)}</p><div class="actions">${s.assets.review ? link('./index.html', 'Open recorded recovery', 'button primary') : ''}${link(repositoryUrl, 'View source on GitHub', 'button')}${s.assets.video ? link('./commitbook-walkthrough.mp4', s.ready ? 'Watch submission video' : 'Watch demo draft', 'button') : ''}${s.assets.source ? link('./commitbook-source.zip', 'Download source ZIP', 'button') : ''}</div><p class="stamp">Packet generated ${e(dateLabel(s.generatedAt))}</p></div>
<aside class="ledger" aria-label="Recorded local recovery budget"><div class="ledger-top"><div><p>Recorded local recovery</p><h3>Spending authority</h3></div><div class="cap">Budget cap<strong>${metric(budget.cap)}</strong></div></div><p class="available-label">Available after recovery</p><div class="available">${metric(budget.available)}<span>units</span></div><div class="budget-track" role="img" aria-label="${e(`Recorded local budget: ${display(budget.spent)} spent, ${display(budget.reserved)} reserved, ${display(budget.available)} available out of ${display(budget.cap)}.`)}"><span class="spent-segment" style="width:${width(budget.spent)}%"></span><span class="reserved-segment" style="width:${width(budget.reserved)}%"></span><span class="available-segment" style="width:${width(budget.available)}%"></span></div><div class="ledger-pair"><div><span>Spent</span><strong>${metric(budget.spent)}</strong></div><div><span>Still reserved</span><strong>${metric(budget.reserved)}</strong></div></div><div class="invariant"><span>Spent + reserved ≤ cap</span><strong>${invariant ? 'Held in this run' : 'Not verified'}</strong></div><p class="ledger-footnote">Local EVM results. Test token units, not a wallet balance.</p></aside></section>
<section id="evidence" class="grid" aria-label="Recorded evidence"><article class="panel"><span class="tag ${s.verification.success && s.verification.sourceCurrent ? '' : 'warn'}">${e(testLabel)}</span><h3>Contract and runtime tests</h3><div class="metric">${metric(s.verification.testsPassed)} <span>passed</span></div><p>${metric(s.verification.testsFailed)} failed. Model-boundary tests use controlled responses.</p><p class="note">${e(dateLabel(s.verification.finishedAt))}${s.verification.success && !s.verification.sourceCurrent ? '. Source changed after this verification.' : ''}</p>${link('./evidence/verification.json', 'Read verification', 'evidence-link')}</article>
<article class="panel"><span class="tag ${s.local.passed ? '' : 'warn'}">${e(localLabel)}</span><h3>A failed supplier, one payment</h3><div class="metric">${metric(s.local.inferenceCalls)} <span>actual model calls</span></div><p>${metric(s.local.checkpointCount)} recorded checkpoints. ${metric(s.local.duplicatePayments)} duplicate payments in the recovery run.</p><p class="note">Three local EVMs. Reactive delivery and finality are simulated.</p>${link('./evidence/agent-workflow.json', 'Inspect the recovery evidence', 'evidence-link')}</article>
<article class="panel"><span class="tag ${s.proposal.recorded ? '' : 'warn'}">${s.proposal.recorded ? 'Public proposal prepared' : 'Public proposal pending'}</span><h3>Ready for operator review</h3><div class="metric">${metric(s.proposal.amount)} <span>proposed units</span></div><p>${e(s.proposal.offer ?? 'No offer recorded')}. ${e(modelDuration)} for the recorded inference call.</p><p class="note">A saved proposal is not public execution.</p>${s.proposal.recorded ? link('./evidence/testnet-ai-plan.json', 'Read the exact proposal', 'evidence-link') : ''}</article></section>
<section class="section split" aria-label="Model evidence"><article class="panel"><h2>The model still needs review</h2><div class="scores"><div><p>Model decisions correct</p><strong>${score(s.evaluation.modelCorrect, s.evaluation.cases)}</strong></div><div><p>Rules baseline correct</p><strong>${score(s.evaluation.baselineCorrect, s.evaluation.cases)}</strong></div></div><p>These are development cases reused during iteration. They do not establish general accuracy or superiority over rules.</p><p>Code fixes the approved terms and spending authority. The operator reviews the proposal before execution.</p>${link('./evidence/agent-evaluation.json', 'Inspect all evaluation cases', 'evidence-link')}</article><article class="panel"><h2>The public purchase proposal</h2><p class="goal">${e(s.proposal.goal ?? 'No actual public purchase proposal is recorded yet.')}</p><dl class="facts"><div><dt>Model</dt><dd>${e(s.proposal.model ?? 'Not recorded')}</dd></div><div><dt>Execution route</dt><dd>Base Sepolia + Reactive Lasna</dd></div><div><dt>Recorded inference</dt><dd>${e(modelDuration)}</dd></div><div><dt>Proposal valid until</dt><dd>${e(dateLabel(s.proposal.validUntil))}</dd></div></dl><p class="note">Approval binds the exact proposal digest. The public request and callback must preserve the same operation ID.</p></article></section>
<section id="public-trace" class="section" aria-labelledby="trace-title"><div class="section-head"><h2 id="trace-title">The public trace judges need</h2><p>Local receipt hashes are not public network proof. Each step below needs an observed public transaction.</p></div><div class="panel trace-panel"><p class="trace-intro">${s.public.operationId ? `Operation ID <code>${e(s.public.operationId)}</code>` : 'No public operation ID is recorded in this packet.'}</p><table><thead><tr><th scope="col">Step</th><th scope="col">Network</th><th scope="col">Transaction evidence</th></tr></thead><tbody>${traceRows}</tbody></table></div><details><summary>Deployed contract addresses</summary><div class="contracts">${s.public.contracts.map(contract => `<p>${e(contract.name)}<code>${e(contract.address ?? 'Pending deployment')}</code></p>`).join('')}</div><p class="note">Predicted addresses in a gas estimate are not deployed addresses.</p></details></section>
<section id="next-step" class="section split" aria-label="Remaining submission work"><article class="panel funding"><span class="tag">${s.public.recordedExecution ? 'Funding record' : 'Next external step'}</span><h2>${s.public.recordedExecution ? 'Testnet funding plan' : 'Fund the scoped test wallet'}</h2><div class="funding-amount">0.01 Base Sepolia test ETH</div><p>Chain 84532. Use a normal free faucet or an existing testnet balance.</p><code class="wallet">${e(s.funding.wallet)}</code><div class="balance-list">${s.funding.balances.map(balance => `<span>${e(balance.network)}: <strong>${e(display(balance.balance))} ${e(balance.symbol)}</strong></span>`).join('')}</div><p class="note">Balances observed ${e(dateLabel(s.funding.checkedAt))}. This page does not read live balances.</p><div class="estimate"><h3>Initial allocation</h3><p>Convert 0.006 Base test ETH into 0.6 Lasna lREACT. Keep the remaining Base test ETH for deployment and callbacks.</p>${s.funding.estimates.map(estimate => `<p>${estimate.chainId === 84532 ? 'Base deployment, setup, and conversion' : 'Lasna deployment and setup'}: <strong>${e(estimate.amount)} ${e(estimate.symbol)}</strong> in the saved estimate.</p>`).join('')}<p class="note">Read-only estimates use hypothetical balances and dependency code, with a 20 percent gas margin. They exclude Base L1 data fees, subsequent requests, callbacks, cancellation, retries, and debt settlement. The allocation is not a guaranteed total.</p>${link('./evidence/deployment-estimate.json', 'Inspect the deployment estimate', 'evidence-link')}</div></article><article class="panel"><h2>Submission gates</h2><p class="note">Only the strict online readiness report can mark these checks complete.</p><ul class="gate-list">${gates}</ul><p class="note">Readiness check: ${e(dateLabel(s.readiness.checkedAt))}. ${s.readiness.mode ? e(s.readiness.mode) + '.' : 'No readiness report is recorded yet.'}</p><p class="note">An under-three-minute video, public source, deployed addresses, and a complete public Reactive callback trace are required.</p>${link(requirementsUrl, 'Read the official requirements', 'evidence-link')}<details><summary>Prototype boundaries</summary><p class="note">The suppliers are synthetic. The prototype does not process invoices or prove service delivery. Vaults are prefunded. Closure verification trusts the configured verifier and RPC. Source reorganization handling and production security are outside this demonstration.</p></details></article></section>
<section class="section panel" aria-labelledby="packet-title"><h2 id="packet-title">Inspect the evidence packet</h2><p class="note">These JSON files contain the recorded measurements behind this page. Active private keys and signed transaction payloads are excluded.</p><ul class="downloads">${s.evidence.map(file => `<li>${link(file.url, file.name)}</li>`).join('')}<li>${link('./submission.json', 'submission.json')}</li></ul></section></main>
<footer class="shell"><p>CommitBook coordinates spending authority across prefunded vaults. It does not bridge assets.</p><p>${e(s.note)}</p><div class="footer-links">${link(repositoryUrl, 'Source repository')}${link(requirementsUrl, 'Buildathon requirements')}${link('https://dev.reactive.network/origins-and-destinations', 'Supported networks')}${s.assets.review ? link('./index.html', 'Recorded recovery console') : ''}</div></footer></body></html>`;
}

export function buildSubmission(outputDirectory = path.join(projectRoot, 'dist-review')) {
  const output = path.resolve(outputDirectory);
  const protectedDirectories = ['', 'app', 'agent', 'contracts', 'scripts', 'test', 'evidence', '.secrets', '.models', '.runtime', 'node_modules', 'lib'];
  if (protectedDirectories.some(relative => {
    const protectedPath = path.join(projectRoot, relative);
    return output === protectedPath || relative && output.startsWith(protectedPath + path.sep);
  })) throw new Error('Choose a separate generated output directory.');
  const records = {};
  for (const name of evidenceNames) {
    const file = path.join(projectRoot, 'evidence', name);
    if (fs.existsSync(file)) records[name] = sanitizeEvidence(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  const assets = {review: fs.existsSync(path.join(output, 'index.html')), source: fs.existsSync(path.join(output, 'commitbook-source.zip')),
    video: fs.existsSync(path.join(output, 'commitbook-walkthrough.mp4'))};
  const summary = summarizeEvidence(records, {sourceHash: currentSourceHash(projectRoot), assets});
  const evidenceOutput = path.join(output, 'evidence');
  for (const target of [output, evidenceOutput, path.join(output, 'submission.html'), path.join(output, 'submission.json')]) {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Generated output cannot replace a symbolic link.');
  }
  fs.mkdirSync(evidenceOutput, {recursive: true});
  for (const [name, record] of Object.entries(records)) {
    const target = path.join(evidenceOutput, name);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Generated evidence cannot replace a symbolic link.');
    fs.writeFileSync(target, JSON.stringify(record, null, 2) + '\n');
  }
  fs.writeFileSync(path.join(output, 'submission.json'), JSON.stringify(summary, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'submission.html'), renderSubmission(summary));
  return {output, files: ['submission.html', 'submission.json'], evidenceFiles: Object.keys(records), status: summary.status,
    ready: summary.ready, sourceCurrent: summary.verification.sourceCurrent, assets};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/build-submission.mjs [output-directory]\nBuilds submission.html, submission.json, and sanitized evidence beside an existing recorded review.\nDefault output: dist-review. This command does not deploy, publish, or submit.');
  } else {
    try {
      if (process.argv.length > 3) throw new Error('Pass one output directory.');
      console.log(JSON.stringify(buildSubmission(process.argv[2]), null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
