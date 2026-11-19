import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {projectRoot} from './compile.mjs';
import {sourceFingerprint,MODEL_SOURCES,WORKFLOW_SOURCES} from './lib/source-fingerprint.mjs';

const output=path.resolve(process.argv[2]??path.join(projectRoot,'dist-review'));
const read=name=>JSON.parse(fs.readFileSync(path.join(projectRoot,'evidence',name),'utf8'));
const workflow=read('agent-workflow.json');
const evaluation=read('agent-evaluation.json');
const verification=read('verification.json');
if(!workflow.summary?.passed||workflow.aiInference!==true||workflow.publicTestnetExecution!==false
  ||!evaluation.aiInference||!verification.success)throw new Error('A successful local workflow, actual model evaluation, and passing source verification are required.');
if(!evaluation.finishedAt||!evaluation.summary||evaluation.summary.cases!==evaluation.cases?.length
  ||evaluation.summary.actualModelResponses!==evaluation.summary.cases||evaluation.summary.cases===0)
  throw new Error('The model evaluation must be complete and include an actual response for every case.');
if(workflow.source?.sha256!==sourceFingerprint(WORKFLOW_SOURCES).sha256
  ||evaluation.source?.sha256!==sourceFingerprint(MODEL_SOURCES).sha256)
  throw new Error('Model or workflow evidence is stale relative to its source. Regenerate it before packaging.');
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);}
const inputs=['contracts','scripts','test','app','agent'].flatMap(d=>files(path.join(projectRoot,d)))
  .concat(['package.json','package-lock.json'].map(n=>path.join(projectRoot,n))).sort();
const digest=createHash('sha256');
for(const file of inputs)digest.update(path.relative(projectRoot,file)).update('\0').update(fs.readFileSync(file)).update('\0');
if(digest.digest('hex')!==verification.sourceSha256)throw new Error('Source changed after verification. Run npm run verify before packaging the review.');
if(output===projectRoot||output===path.join(projectRoot,'app/public'))throw new Error('Choose a separate generated output directory.');
fs.mkdirSync(output,{recursive:true});
for(const name of ['app.css','app.js'])fs.copyFileSync(path.join(projectRoot,'app/public',name),path.join(output,name));
const html=fs.readFileSync(path.join(projectRoot,'app/public/index.html'),'utf8').replace('<html lang="en">','<html lang="en" data-mode="recorded">');
fs.writeFileSync(path.join(output,'index.html'),html);
const zip=path.join(output,'commitbook-source.zip');
const packaged=spawnSync('python3',[path.join(projectRoot,'scripts/package-source.py'),zip],{cwd:projectRoot,encoding:'utf8'});
if(packaged.status!==0)throw new Error(`Source packaging failed: ${packaged.stderr||packaged.stdout}`);
const sourceArchive=JSON.parse(packaged.stdout);
const report={...workflow,sourceUrl:'./commitbook-source.zip',sourceArchive,verification,
  evaluation:{...evaluation,note:`The final development regression recorded ${evaluation.summary.modelCorrect}/${evaluation.summary.cases} correct pipeline choices and ${evaluation.summary.baselineCorrect}/${evaluation.summary.cases} for the rules baseline. These cases were reused after revision. They do not establish production reliability. Model explanations are unverified text; proposals require review. Earlier failed experiments are preserved in the source archive.`}};
delete report.sourceArchive.file;
fs.writeFileSync(path.join(output,'review.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,files:['index.html','app.css','app.js','review.json','commitbook-source.zip'],recorded:true,aiInference:workflow.aiInference,publicTestnetExecution:false,sourceSha256:verification.sourceSha256,archiveSha256:sourceArchive.sha256},null,2));
